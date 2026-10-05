import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { CountMinSketch, CmsError, SketchParams, Snapshot, SNAPSHOT_FORMAT } from "./sketch.js";

/** 公开的单次请求与操作数量上限。 */
export const LIMITS = {
  maxJsonBodyBytes: 1_048_576,
  maxBatchEntries: 1000,
  maxKeyBytes: 65536,
  maxHistoryLimit: 500,
  maxCellsLimit: 4096 * 8,
  maxSingleWeight: "18446744073709551615",
  maxWidth: 4096,
  maxDepth: 8,
} as const;

export class Service {
  private readonly openStores = new Map<string, Store>();

  constructor(private readonly dataDir: string) {}

  /** 关闭所有已打开的数据库句柄（测试与进程退出时使用）。 */
  closeAll(): void {
    for (const store of this.openStores.values()) store.close();
    this.openStores.clear();
  }

  private getStore(id: string): Store {
    let store = this.openStores.get(id);
    if (!store) {
      store = Store.open(this.dataDir, id);
      this.openStores.set(id, store);
    }
    return store;
  }

  create(id: string, params: SketchParams): ReturnType<Store["info"]> {
    if (Store.exists(this.dataDir, id)) {
      throw new CmsError("SKETCH_EXISTS", `摘要 ${id} 已存在`);
    }
    const store = Store.create(this.dataDir, id, params);
    this.openStores.set(id, store);
    return store.info();
  }

  list(): string[] {
    if (!existsSync(this.dataDir)) return [];
    return readdirSync(this.dataDir)
      .filter((name) => name.endsWith(".db"))
      .map((name) => name.slice(0, -3));
  }

  info(id: string) {
    return this.getStore(id).info();
  }

  add(id: string, key: unknown, weight: unknown) {
    this.validateKeySize(key);
    const store = this.getStore(id);
    return store.addBatch([{ key, weight }]);
  }

  addBatch(id: string, entries: unknown) {
    if (!Array.isArray(entries)) {
      throw new CmsError("INVALID_BATCH", "entries 必须是数组");
    }
    if (entries.length > LIMITS.maxBatchEntries) {
      throw new CmsError("BATCH_TOO_LARGE", `批量条目最多 ${LIMITS.maxBatchEntries} 条`);
    }
    for (const [index, entry] of entries.entries()) {
      this.validateKeySize((entry as { key?: unknown })?.key, index);
    }
    return this.getStore(id).addBatch(entries as { key: unknown; weight: unknown }[]);
  }

  query(id: string, key: unknown) {
    this.validateKeySize(key);
    return this.getStore(id).query(key as string);
  }

  cells(id: string, limit: number, offset: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxCellsLimit) {
      throw new CmsError("INVALID_LIMIT", `limit 必须是 1..${LIMITS.maxCellsLimit}`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new CmsError("INVALID_OFFSET", "offset 必须是非负整数");
    }
    return { cells: this.getStore(id).cells(limit, offset) };
  }

  history(id: string, limit: number, offset: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxHistoryLimit) {
      throw new CmsError("INVALID_LIMIT", `limit 必须是 1..${LIMITS.maxHistoryLimit}`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new CmsError("INVALID_OFFSET", "offset 必须是非负整数");
    }
    return this.getStore(id).history(limit, offset);
  }

  export(id: string): Snapshot {
    return this.getStore(id).snapshot();
  }

  /**
   * 导入快照到新摘要（原子）：先在临时库中完整校验+写入，再原子重命名。
   * replace=false 时目标必须不存在。
   */
  import(id: string, input: unknown, replace: boolean): { id: string; replaced: boolean } {
    const existed = Store.exists(this.dataDir, id);
    if (existed && !replace) {
      throw new CmsError("SKETCH_EXISTS", `摘要 ${id} 已存在；如需替换请显式 replace=true`);
    }
    // 先做纯内存校验（维度、非负、每行和=总权重），不合格直接抛错。
    const snapshot = normalizeSnapshotInput(input);
    CountMinSketch.fromSnapshot(snapshot);

    const tmp = mkdtempSync(join(tmpdir(), "cms-import-"));
    const tempStore = Store.importNew(tmp, id, snapshot);
    tempStore.close();

    if (existed) {
      this.openStores.get(id)?.close();
      this.openStores.delete(id);
      for (const suffix of [".db", ".db-wal", ".db-shm"]) {
        const oldPath = join(this.dataDir, `${id}${suffix}`);
        if (existsSync(oldPath)) rmSync(oldPath, { force: true });
      }
    }
    mkdirSync(this.dataDir, { recursive: true });
    for (const suffix of [".db", ".db-wal", ".db-shm"]) {
      const src = join(tmp, `${id}${suffix}`);
      if (existsSync(src)) copyFileSync(src, join(this.dataDir, `${id}${suffix}`));
    }
    return { id, replaced: existed };
  }

  importFile(id: string, filePath: string, replace: boolean) {
    const text = readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CmsError("INVALID_SNAPSHOT", "导入文件不是合法 JSON");
    }
    return this.import(id, parsed, replace);
  }

  exportFile(id: string, filePath: string): { path: string } {
    writeFileSync(filePath, JSON.stringify(this.export(id), null, 2), "utf8");
    return { path: filePath };
  }

  /**
   * 合并两个参数兼容的摘要：按单元相加生成全新摘要快照，
   * 两个来源不被修改（来源库以只读快照装载）。
   */
  merge(leftId: string, rightId: string, targetId: string): {
    targetId: string;
    totalWeight: string;
    sources: string[];
  } {
    if (Store.exists(this.dataDir, targetId)) {
      throw new CmsError("SKETCH_EXISTS", `目标摘要 ${targetId} 已存在`);
    }
    const left = this.getStore(leftId);
    const right = this.getStore(rightId);
    const leftSketch = left.loadSketch();
    const rightSketch = right.loadSketch();
    if (!leftSketch.compatible(rightSketch)) {
      throw new CmsError("INCOMPATIBLE_SKETCH", "两个摘要的 width/depth/seed 不一致，无法合并");
    }
    const merged = leftSketch.merge(rightSketch);
    const target = Store.create(this.dataDir, targetId, merged.params);
    target.replaceSketch(merged, "merge", { sources: [leftId, rightId] });
    this.openStores.set(targetId, target);
    return { targetId, totalWeight: merged.total.toString(), sources: [leftId, rightId] };
  }

  private validateKeySize(key: unknown, index?: number): void {
    if (typeof key !== "string") return; // 具体类型错误由 sketch 层报出
    const byteLength = Buffer.byteLength(key, "utf8");
    if (byteLength > LIMITS.maxKeyBytes) {
      throw new CmsError(
        "KEY_TOO_LARGE",
        `${index === undefined ? "" : `第 ${index} 条的`}键超过 ${LIMITS.maxKeyBytes} 字节上限`,
      );
    }
  }
}

/** 接受快照对象本身，或包一层 { snapshot } 的请求体。 */
function normalizeSnapshotInput(input: unknown): Snapshot {
  if (typeof input !== "object" || input === null) {
    throw new CmsError("INVALID_SNAPSHOT", "快照必须是 JSON 对象");
  }
  const candidate =
    "format" in input || "matrix" in input
      ? input
      : (input as { snapshot?: unknown }).snapshot;
  if (typeof candidate !== "object" || candidate === null) {
    throw new CmsError("INVALID_SNAPSHOT", "缺少快照内容（snapshot 字段或顶层快照对象）");
  }
  return candidate as Snapshot;
}

export { SNAPSHOT_FORMAT };
