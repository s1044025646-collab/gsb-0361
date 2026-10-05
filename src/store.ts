import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CountMinSketch,
  CmsError,
  ENCODING,
  RULE_VERSION,
  Snapshot,
  SketchParams,
  isValidUnicodeString,
  parsePositiveWeight,
} from "./sketch.js";

export const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface BatchEntry {
  key: string;
  weight: bigint;
}

export interface HistoryRecord {
  seq: number;
  op: string;
  detail: unknown;
  totalWeightAfter: string;
  createdAt: string;
}

/**
 * 每个摘要对应 data 目录下的一个独立 SQLite 文件（<id>.db）。
 * 不同摘要天然物理隔离，不可能混用状态。
 */
export class Store {
  private readonly db: DatabaseSync;
  readonly id: string;
  readonly params: SketchParams;

  private constructor(id: string, db: DatabaseSync, params: SketchParams) {
    this.id = id;
    this.db = db;
    this.params = params;
  }

  static dbPath(dataDir: string, id: string): string {
    if (!ID_PATTERN.test(id)) {
      throw new CmsError("INVALID_ID", `摘要 id 必须匹配 ${ID_PATTERN}`);
    }
    return join(dataDir, `${id}.db`);
  }

  static exists(dataDir: string, id: string): boolean {
    return existsSync(Store.dbPath(dataDir, id));
  }

  static create(dataDir: string, id: string, params: SketchParams): Store {
    mkdirSync(dataDir, { recursive: true });
    const path = Store.dbPath(dataDir, id);
    if (existsSync(path)) {
      throw new CmsError("SKETCH_EXISTS", `摘要 ${id} 已存在`);
    }
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    db.exec(SCHEMA_SQL);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO meta (key, value) VALUES
       ('id', ?), ('width', ?), ('depth', ?), ('seed', ?),
       ('rule_version', ?), ('encoding', ?), ('total_weight', '0'),
       ('created_at', ?), ('updated_at', ?)`,
    ).run(id, String(params.width), String(params.depth), String(params.seed), RULE_VERSION, ENCODING, now, now);
    const insertHistory = db.prepare(
      "INSERT INTO history (op, detail, total_weight_after, created_at) VALUES (?, ?, '0', ?)",
    );
    insertHistory.run("create", JSON.stringify({ width: params.width, depth: params.depth, seed: params.seed }), now);
    return new Store(id, db, params);
  }

  static open(dataDir: string, id: string): Store {
    const path = Store.dbPath(dataDir, id);
    if (!existsSync(path)) {
      throw new CmsError("SKETCH_NOT_FOUND", `摘要 ${id} 不存在`);
    }
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    if (
      meta.get("id") !== id ||
      meta.get("rule_version") !== RULE_VERSION ||
      meta.get("encoding") !== ENCODING
    ) {
      db.close();
      throw new CmsError("CORRUPT_STATE", `摘要 ${id} 的元数据不完整或版本不受支持`);
    }
    const params: SketchParams = {
      width: Number(meta.get("width")),
      depth: Number(meta.get("depth")),
      seed: Number(meta.get("seed")),
    };
    return new Store(id, db, params);
  }

  /** 从已校验的快照创建新摘要（导入）；调用方负责确保目标 id 不存在或显式允许替换。 */
  static importNew(dataDir: string, id: string, snapshot: Snapshot): Store {
    const sketch = CountMinSketch.fromSnapshot(snapshot);
    const store = Store.create(dataDir, id, sketch.params);
    store.replaceSketch(sketch, "import", { source: "snapshot" });
    return store;
  }

  close(): void {
    this.db.close();
  }

  info(): {
    id: string;
    width: number;
    depth: number;
    seed: number;
    ruleVersion: string;
    encoding: string;
    totalWeight: string;
    createdAt: string;
    updatedAt: string;
  } {
    const get = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    const value = (key: string) => (get.get(key) as { value: string }).value;
    return {
      id: this.id,
      width: this.params.width,
      depth: this.params.depth,
      seed: this.params.seed,
      ruleVersion: RULE_VERSION,
      encoding: ENCODING,
      totalWeight: value("total_weight"),
      createdAt: value("created_at"),
      updatedAt: value("updated_at"),
    };
  }

  /** 从 SQLite 重建内存矩阵（精确 bigint）。 */
  loadSketch(): CountMinSketch {
    const total = BigInt((this.db.prepare("SELECT value FROM meta WHERE key='total_weight'").get() as { value: string }).value);
    const sketch = new CountMinSketch(this.params, undefined, total);
    const rows = this.db.prepare("SELECT row, col, count FROM cells").all() as {
      row: number;
      col: number;
      count: string;
    }[];
    for (const r of rows) {
      sketch.loadCell(r.row, r.col, BigInt(r.count));
    }
    return sketch;
  }

  /**
   * 原子批量增加：
   * 1) 先在事务外完成全部键/权重校验，非法批次直接拒绝；
   * 2) 事务内逐单元 UPSERT 并更新总权重，任何失败整体回滚。
   */
  addBatch(rawEntries: { key: unknown; weight: unknown }[]): { accepted: number; totalWeight: string } {
    if (rawEntries.length === 0) {
      throw new CmsError("EMPTY_BATCH", "批量条目不能为空");
    }
    const entries: BatchEntry[] = rawEntries.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new CmsError("INVALID_ENTRY", `第 ${index} 条不是对象`);
      }
      const { key, weight } = entry as { key: unknown; weight: unknown };
      if (!isValidUnicodeString(key)) {
        throw new CmsError("INVALID_KEY", `第 ${index} 条的键非法（必须是合法 Unicode 字符串，空串允许）`);
      }
      return { key, weight: parsePositiveWeight(weight) };
    });

    const sketch = this.loadSketch();
    for (const entry of entries) sketch.add(entry.key, entry.weight);
    this.replaceSketch(sketch, entries.length === 1 ? "add" : "add-batch", {
      entries: entries.map((e) => ({ key: e.key, weight: e.weight.toString() })),
    });
    return { accepted: entries.length, totalWeight: sketch.total.toString() };
  }

  /** 用给定摘要整体替换矩阵（事务内），并写入一条历史。 */
  replaceSketch(sketch: CountMinSketch, op: string, detail: unknown): void {
    if (
      sketch.width !== this.params.width ||
      sketch.depth !== this.params.depth ||
      sketch.seed !== this.params.seed
    ) {
      throw new CmsError("INCOMPATIBLE_SKETCH", "替换摘要与现有参数不一致");
    }
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO cells (row, col, count) VALUES (?, ?, ?)
       ON CONFLICT(row, col) DO UPDATE SET count = excluded.count`,
    );
    const setMeta = this.db.prepare("UPDATE meta SET value = ? WHERE key = ?");
    const insertHistory = this.db.prepare(
      "INSERT INTO history (op, detail, total_weight_after, created_at) VALUES (?, ?, ?, ?)",
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM cells");
      for (let row = 0; row < sketch.depth; row++) {
        for (let col = 0; col < sketch.width; col++) {
          const value = sketch.cell(row, col);
          if (value !== 0n) upsert.run(row, col, value.toString());
        }
      }
      setMeta.run(sketch.total.toString(), "total_weight");
      setMeta.run(now, "updated_at");
      insertHistory.run(op, JSON.stringify(detail), sketch.total.toString(), now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  query(key: string) {
    return this.loadSketch().query(key);
  }

  cells(limit: number, offset: number) {
    return this.loadSketch().nonzeroCells(limit, offset);
  }

  snapshot(): Snapshot {
    return this.loadSketch().toJSON();
  }

  history(limit: number, offset: number): { total: number; records: HistoryRecord[] } {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM history").get() as { n: number }).n;
    const rows = this.db
      .prepare("SELECT seq, op, detail, total_weight_after, created_at FROM history ORDER BY seq LIMIT ? OFFSET ?")
      .all(limit, offset) as {
      seq: number;
      op: string;
      detail: string;
      total_weight_after: string;
      created_at: string;
    }[];
    return {
      total,
      records: rows.map((r) => ({
        seq: r.seq,
        op: r.op,
        detail: safeParseJSON(r.detail),
        totalWeightAfter: r.total_weight_after,
        createdAt: r.created_at,
      })),
    };
  }
}

function safeParseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE cells (
  row INTEGER NOT NULL CHECK (row >= 0),
  col INTEGER NOT NULL CHECK (col >= 0),
  count TEXT NOT NULL,
  PRIMARY KEY (row, col)
);
CREATE TABLE history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  detail TEXT NOT NULL,
  total_weight_after TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
