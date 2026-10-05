import { createHash } from "node:crypto";

/**
 * 标准 Count–Min Sketch 核心实现（无任何现成 Sketch 库依赖）。
 *
 * 哈希规则（ruleVersion = cms-sha256-be-v1）：
 *   32 位种子（大端 4 字节） || 32 位行号（大端 4 字节，从 0 开始） || 键的 UTF-8 字节
 *   => SHA-256，取前 8 字节按大端解释为无符号整数 => 对宽度 w 取余。
 */

export const RULE_VERSION = "cms-sha256-be-v1";
export const ENCODING = "utf8";
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 4096;
export const MIN_DEPTH = 1;
export const MAX_DEPTH = 8;
/** 单笔权重上限（含），取 2^64 - 1；矩阵计数与总权重使用 bigint，不受 Number 安全整数限制。 */
export const MAX_WEIGHT = (1n << 64n) - 1n;

export interface SketchParams {
  width: number;
  depth: number;
  seed: number;
}

export interface RowExplanation {
  row: number;
  column: number;
  count: string;
  minimum: boolean;
}

export interface QueryResult {
  key: string;
  estimate: string;
  ruleVersion: string;
  encoding: string;
  width: number;
  depth: number;
  seed: number;
  rows: RowExplanation[];
}

/** 判断字符串是否为“合法 Unicode”：拒绝未配对的代理项（lone surrogate）。 */
export function isValidUnicodeString(key: unknown): key is string {
  if (typeof key !== "string") return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = key.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validateParams(params: { width: unknown; depth: unknown; seed: unknown }): SketchParams {
  const { width, depth, seed } = params;
  if (!Number.isInteger(width) || (width as number) < MIN_WIDTH || (width as number) > MAX_WIDTH) {
    throw new CmsError("INVALID_WIDTH", `width 必须是 ${MIN_WIDTH}..${MAX_WIDTH} 的整数`);
  }
  if (!Number.isInteger(depth) || (depth as number) < MIN_DEPTH || (depth as number) > MAX_DEPTH) {
    throw new CmsError("INVALID_DEPTH", `depth 必须是 ${MIN_DEPTH}..${MAX_DEPTH} 的整数`);
  }
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffffffff) {
    throw new CmsError("INVALID_SEED", "seed 必须是 0..4294967295 的整数");
  }
  return { width: width as number, depth: depth as number, seed: seed as number };
}

/** 把任意输入归一为正整数 bigint；接受 number 或十进制字符串。 */
export function parsePositiveWeight(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CmsError("INVALID_WEIGHT", "权重必须是正整数");
    }
    return BigInt(value);
  }
  if (typeof value === "bigint") {
    if (value <= 0n) throw new CmsError("INVALID_WEIGHT", "权重必须是正整数");
    return validateWeightBound(value);
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new CmsError("INVALID_WEIGHT", "权重必须是十进制正整数字符串");
  }
  let weight: bigint;
  try {
    weight = BigInt(value);
  } catch {
    throw new CmsError("INVALID_WEIGHT", "权重无法解析为整数");
  }
  if (weight <= 0n) throw new CmsError("INVALID_WEIGHT", "权重必须是正整数");
  return validateWeightBound(weight);
}

function validateWeightBound(weight: bigint): bigint {
  if (weight > MAX_WEIGHT) {
    throw new CmsError("INVALID_WEIGHT", "单笔权重超过 2^64-1 上限");
  }
  return weight;
}

/** 计算某一行的列下标（确定性哈希）。 */
export function columnIndex(key: string, seed: number, row: number, width: number): number {
  if (!isValidUnicodeString(key)) {
    throw new CmsError("INVALID_KEY", "键包含未配对的代理项，不是合法 Unicode 字符串");
  }
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(seed >>> 0, 0);
  prefix.writeUInt32BE(row >>> 0, 4);
  const digest = createHash("sha256").update(Buffer.concat([prefix, Buffer.from(key, "utf8")])).digest();
  const hashValue = digest.subarray(0, 8).readBigUInt64BE();
  return Number(hashValue % BigInt(width));
}

export class CmsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CmsError";
    this.code = code;
  }
}

export class CountMinSketch {
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  /** matrix[row][column]，bigint 精确整数。 */
 private readonly matrix: bigint[][];
  private totalWeight: bigint;

  constructor(params: SketchParams, matrix?: bigint[][], totalWeight?: bigint) {
    const p = validateParams(params);
    this.width = p.width;
    this.depth = p.depth;
    this.seed = p.seed;
    if (matrix) {
      if (matrix.length !== this.depth || matrix.some((r) => r.length !== this.width)) {
        throw new CmsError("INVALID_SNAPSHOT", "矩阵维度与参数不一致");
      }
      this.matrix = matrix.map((row) => row.slice());
    } else {
      this.matrix = Array.from({ length: this.depth }, () => new Array<bigint>(this.width).fill(0n));
    }
    this.totalWeight = totalWeight ?? 0n;
    if (this.totalWeight < 0n) {
      throw new CmsError("INVALID_SNAPSHOT", "总权重不能为负");
    }
  }

  get params(): SketchParams {
    return { width: this.width, depth: this.depth, seed: this.seed };
  }

  get total(): bigint {
    return this.totalWeight;
  }

  columns(key: string): number[] {
    if (!isValidUnicodeString(key)) {
      throw new CmsError("INVALID_KEY", "键包含未配对的代理项，不是合法 Unicode 字符串");
    }
    const result: number[] = [];
    for (let row = 0; row < this.depth; row++) {
      result.push(columnIndex(key, this.seed, row, this.width));
    }
    return result;
  }

  /** 标准更新：每一行的对应单元都加上同一正权重（非 conservative update）。 */
  add(key: string, weight: bigint): void {
    if (weight <= 0n) throw new CmsError("INVALID_WEIGHT", "权重必须是正整数");
    const cols = this.columns(key);
    for (let row = 0; row < this.depth; row++) {
      this.matrix[row][cols[row]] += weight;
    }
    this.totalWeight += weight;
  }

  /** 点查询：取各行单元计数的最小值。 */
  query(key: string): QueryResult {
    const cols = this.columns(key);
    const counts = cols.map((col, row) => this.matrix[row][col]);
    const min = counts.reduce((a, b) => (a < b ? a : b));
    return {
      key,
      estimate: min.toString(),
      ruleVersion: RULE_VERSION,
      encoding: ENCODING,
      width: this.width,
      depth: this.depth,
      seed: this.seed,
      rows: counts.map((count, row) => ({
        row,
        column: cols[row],
        count: count.toString(),
        minimum: count === min,
      })),
    };
  }

  cell(row: number, column: number): bigint {
    if (row < 0 || row >= this.depth || column < 0 || column >= this.width) {
      throw new CmsError("INVALID_CELL", "单元坐标超出矩阵范围");
    }
    return this.matrix[row][column];
  }

  /** 从持久化层装载单个单元（仅限构建/装载路径使用）。 */
  loadCell(row: number, column: number, value: bigint): void {
    if (row < 0 || row >= this.depth || column < 0 || column >= this.width) {
      throw new CmsError("INVALID_CELL", "单元坐标超出矩阵范围");
    }
    if (value < 0n) throw new CmsError("CORRUPT_STATE", "矩阵单元不能为负");
    this.matrix[row][column] = value;
  }

  rowSum(row: number): bigint {
    return this.matrix[row].reduce((a, b) => a + b, 0n);
  }

  /** 枚举非零单元（用于有限查看），按行优先顺序。 */
  nonzeroCells(limit: number, offset = 0): { row: number; column: number; count: string }[] {
    const out: { row: number; column: number; count: string }[] = [];
    let skipped = 0;
    for (let row = 0; row < this.depth; row++) {
      for (let column = 0; column < this.width; column++) {
        const value = this.matrix[row][column];
        if (value === 0n) continue;
        if (skipped < offset) {
          skipped++;
          continue;
        }
        out.push({ row, column, count: value.toString() });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  get nonzeroCount(): number {
    let n = 0;
    for (const row of this.matrix) for (const value of row) if (value !== 0n) n++;
    return n;
  }

  /** 兼容校验：宽度、深度、种子必须完全一致（规则版本/编码由类型体系保证一致）。 */
  compatible(other: CountMinSketch): boolean {
    return this.width === other.width && this.depth === other.depth && this.seed === other.seed;
  }

  /**
   * 按单元相加生成全新摘要，不修改两个来源。
   * 合并是逐单元求和，不是集合并集；自合并会使计数翻倍。
   */
  merge(other: CountMinSketch): CountMinSketch {
    if (!this.compatible(other)) {
      throw new CmsError("INCOMPATIBLE_SKETCH", "两个摘要的 width/depth/seed 不一致，无法合并");
    }
    const merged = this.matrix.map((row, r) => row.map((value, c) => value + other.matrix[r][c]));
    return new CountMinSketch(this.params, merged, this.totalWeight + other.totalWeight);
  }

  /** 导出为可 JSON 序列化的纯对象（计数与总权重使用十进制字符串）。 */
  toJSON(): Snapshot {
    return {
      format: SNAPSHOT_FORMAT,
      ruleVersion: RULE_VERSION,
      encoding: ENCODING,
      width: this.width,
      depth: this.depth,
      seed: this.seed,
      totalWeight: this.totalWeight.toString(),
      matrix: this.matrix.map((row) => row.map((value) => value.toString())),
    };
  }

  /** 从快照导入并做完整校验；不通过则抛 INVALID_SNAPSHOT，不产生部分状态。 */
  static fromSnapshot(input: unknown): CountMinSketch {
    const snap = asObject(input);
    if (snap.format !== SNAPSHOT_FORMAT || snap.ruleVersion !== RULE_VERSION || snap.encoding !== ENCODING) {
      throw new CmsError("INVALID_SNAPSHOT", "快照 format/ruleVersion/encoding 不受支持");
    }
    const params = validateParams({ width: snap.width, depth: snap.depth, seed: snap.seed });
    if (typeof snap.totalWeight !== "string" || !/^[0-9]+$/.test(snap.totalWeight)) {
      throw new CmsError("INVALID_SNAPSHOT", "totalWeight 必须是十进制非负整数字符串");
    }
    const total = BigInt(snap.totalWeight);
    if (!Array.isArray(snap.matrix) || snap.matrix.length !== params.depth) {
      throw new CmsError("INVALID_SNAPSHOT", "矩阵行数与 depth 不一致");
    }
    const matrix: bigint[][] = [];
    for (let r = 0; r < params.depth; r++) {
      const rawRow = snap.matrix[r];
      if (!Array.isArray(rawRow) || rawRow.length !== params.width) {
        throw new CmsError("INVALID_SNAPSHOT", `第 ${r} 行列数与 width 不一致`);
      }
      const row: bigint[] = [];
      let rowSum = 0n;
      for (let c = 0; c < params.width; c++) {
        const cellValue = rawRow[c];
        if (typeof cellValue !== "string" || !/^[0-9]+$/.test(cellValue)) {
          throw new CmsError("INVALID_SNAPSHOT", `单元 (${r},${c}) 不是十进制非负整数字符串`);
        }
        const n = BigInt(cellValue);
        row.push(n);
        rowSum += n;
      }
      if (rowSum !== total) {
        throw new CmsError("INVALID_SNAPSHOT", `第 ${r} 行单元和（${rowSum}）不等于总权重（${total}）`);
      }
      matrix.push(row);
    }
    return new CountMinSketch(params, matrix, total);
  }
}

export const SNAPSHOT_FORMAT = "cms-snapshot-v1";

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  ruleVersion: typeof RULE_VERSION;
  encoding: typeof ENCODING;
  width: number;
  depth: number;
  seed: number;
  totalWeight: string;
  matrix: string[][];
}

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CmsError("INVALID_SNAPSHOT", "快照必须是 JSON 对象");
  }
  return input as Record<string, unknown>;
}
