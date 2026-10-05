import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  CountMinSketch,
  CmsError,
  ExportedState,
  SketchParams,
  validateKey,
  parseWeight,
} from './sketch.js';

export const MAX_BATCH_ITEMS = 1000;
export const MAX_BODY_BYTES = 1024 * 1024;

export interface SketchMeta extends SketchParams {
  id: number;
  version: string;
  totalWeight: string;
  createdAt: string;
}

export interface AddItem {
  key: string;
  weight: bigint;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'cms.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sketches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        width INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        seed INTEGER NOT NULL,
        version TEXT NOT NULL,
        total_weight TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cells (
        sketch_id INTEGER NOT NULL,
        row INTEGER NOT NULL,
        col INTEGER NOT NULL,
        count TEXT NOT NULL,
        PRIMARY KEY (sketch_id, row, col)
      );
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sketch_id INTEGER NOT NULL,
        op TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private recordOp(sketchId: number, op: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO ops (sketch_id, op, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(sketchId, op, JSON.stringify(detail), this.now());
  }

  /** Persist a full sketch (meta + all cells) inside the current transaction. */
  private persistSketch(sketch: CountMinSketch): number {
    const res = this.db
      .prepare(
        'INSERT INTO sketches (width, depth, seed, version, total_weight, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(sketch.width, sketch.depth, sketch.seed, sketch.version, sketch.totalWeight.toString(), this.now());
    const id = Number(res.lastInsertRowid);
    const ins = this.db.prepare('INSERT INTO cells (sketch_id, row, col, count) VALUES (?, ?, ?, ?)');
    for (let r = 0; r < sketch.depth; r++) {
      for (let c = 0; c < sketch.width; c++) {
        ins.run(id, r, c, sketch.cell(r, c).toString());
      }
    }
    return id;
  }

  create(params: SketchParams): SketchMeta {
    const sketch = new CountMinSketch(params);
    this.db.exec('BEGIN');
    try {
      const id = this.persistSketch(sketch);
      this.recordOp(id, 'create', params);
      this.db.exec('COMMIT');
      return this.getMeta(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  importState(state: unknown): SketchMeta {
    const sketch = CountMinSketch.fromJSON(state); // validates dims, non-negative cells, row sums
    this.db.exec('BEGIN');
    try {
      const id = this.persistSketch(sketch);
      this.recordOp(id, 'import', { version: sketch.version, totalWeight: sketch.totalWeight.toString() });
      this.db.exec('COMMIT');
      return this.getMeta(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(id: number): SketchMeta {
    const row = this.db
      .prepare('SELECT id, width, depth, seed, version, total_weight AS totalWeight, created_at AS createdAt FROM sketches WHERE id = ?')
      .get(id) as unknown as SketchMeta | undefined;
    if (!row) throw new CmsError('NOT_FOUND', `sketch ${id} not found`);
    return row;
  }

  list(): SketchMeta[] {
    return this.db
      .prepare('SELECT id, width, depth, seed, version, total_weight AS totalWeight, created_at AS createdAt FROM sketches ORDER BY id')
      .all() as unknown as SketchMeta[];
  }

  load(id: number): CountMinSketch {
    const meta = this.getMeta(id);
    const rows = this.db
      .prepare('SELECT row, col, count FROM cells WHERE sketch_id = ?')
      .all(id) as unknown as { row: number; col: number; count: string }[];
    const matrix = Array.from({ length: meta.depth }, () => new Array<bigint>(meta.width).fill(0n));
    for (const cell of rows) matrix[cell.row][cell.col] = BigInt(cell.count);
    return new CountMinSketch(meta, matrix, BigInt(meta.totalWeight));
  }

  /** Atomically apply a validated batch; nothing is written if any item is invalid. */
  addBatch(id: number, rawItems: { key: unknown; weight: unknown }[]): SketchMeta {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new CmsError('INVALID_PARAM', 'items must be a non-empty array');
    }
    if (rawItems.length > MAX_BATCH_ITEMS) {
      throw new CmsError('LIMIT_EXCEEDED', `batch size exceeds ${MAX_BATCH_ITEMS}`);
    }
    const items: AddItem[] = rawItems.map((it) => {
      validateKey(it?.key);
      return { key: it.key, weight: parseWeight(it.weight) };
    });
    const sketch = this.load(id);
    for (const it of items) sketch.add(it.key, it.weight);
    this.db.exec('BEGIN');
    try {
      const upd = this.db.prepare('UPDATE cells SET count = ? WHERE sketch_id = ? AND row = ? AND col = ?');
      for (let r = 0; r < sketch.depth; r++) {
        for (let c = 0; c < sketch.width; c++) {
          upd.run(sketch.cell(r, c).toString(), id, r, c);
        }
      }
      this.db
        .prepare('UPDATE sketches SET total_weight = ? WHERE id = ?')
        .run(sketch.totalWeight.toString(), id);
      this.recordOp(id, 'add', { items: items.map((i) => ({ key: i.key, weight: i.weight.toString() })) });
      this.db.exec('COMMIT');
      return this.getMeta(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  query(id: number, key: unknown): { key: string; estimate: string } {
    validateKey(key);
    const sketch = this.load(id);
    return { key, estimate: sketch.query(key).toString() };
  }

  explain(id: number, key: unknown) {
    const sketch = this.load(id);
    return sketch.explain(key as string);
  }

  cells(id: number, row: number, offset: number, limit: number) {
    const sketch = this.load(id);
    if (!Number.isInteger(row) || row < 0 || row >= sketch.depth) {
      throw new CmsError('INVALID_PARAM', `row must be in [0, ${sketch.depth - 1}]`);
    }
    const start = Math.max(0, offset | 0);
    const size = Math.min(Math.max(1, limit | 0), 512);
    const out = [];
    for (let c = start; c < Math.min(start + size, sketch.width); c++) {
      out.push({ row, col: c, count: sketch.cell(row, c).toString() });
    }
    return { row, offset: start, limit: size, width: sketch.width, cells: out };
  }

  /** Merge two sketches into a NEW persisted snapshot; sources are not modified. */
  merge(idA: number, idB: number): SketchMeta {
    const a = this.load(idA);
    const b = this.load(idB);
    const merged = CountMinSketch.merge(a, b);
    this.db.exec('BEGIN');
    try {
      const id = this.persistSketch(merged);
      this.recordOp(id, 'merge', { sources: [idA, idB], totalWeight: merged.totalWeight.toString() });
      this.db.exec('COMMIT');
      return this.getMeta(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  exportState(id: number): ExportedState {
    return this.load(id).toJSON();
  }

  history(id: number, limit: number) {
    this.getMeta(id);
    const size = Math.min(Math.max(1, limit | 0), 200);
    return this.db
      .prepare('SELECT id, op, detail, created_at AS createdAt FROM ops WHERE sketch_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, size);
  }
}
