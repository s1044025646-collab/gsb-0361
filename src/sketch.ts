import { columnIndex } from './hash.js';

export const MIN_DEPTH = 1;
export const MAX_DEPTH = 8;
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 4096;
export const MAX_KEY_BYTES = 4096;

export class CmsError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CmsError';
  }
}

export interface SketchParams {
  width: number;
  depth: number;
  seed: number;
}

export function validateParams(p: SketchParams): void {
  if (!Number.isInteger(p.width) || p.width < MIN_WIDTH || p.width > MAX_WIDTH) {
    throw new CmsError('INVALID_PARAM', `width must be an integer in [${MIN_WIDTH}, ${MAX_WIDTH}]`);
  }
  if (!Number.isInteger(p.depth) || p.depth < MIN_DEPTH || p.depth > MAX_DEPTH) {
    throw new CmsError('INVALID_PARAM', `depth must be an integer in [${MIN_DEPTH}, ${MAX_DEPTH}]`);
  }
  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff) {
    throw new CmsError('INVALID_PARAM', 'seed must be an integer in [0, 2^32-1]');
  }
}

export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string') {
    throw new CmsError('INVALID_KEY', 'key must be a string');
  }
  if (!key.isWellFormed()) {
    throw new CmsError('INVALID_KEY', 'key contains ill-formed Unicode (lone surrogates)');
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
    throw new CmsError('INVALID_KEY', `key exceeds ${MAX_KEY_BYTES} UTF-8 bytes`);
  }
}

export function parseWeight(weight: unknown): bigint {
  let w: bigint;
  if (typeof weight === 'bigint') {
    w = weight;
  } else if (typeof weight === 'number') {
    if (!Number.isSafeInteger(weight)) {
      throw new CmsError('INVALID_WEIGHT', 'numeric weight must be a safe integer; use a decimal string for larger values');
    }
    w = BigInt(weight);
  } else if (typeof weight === 'string') {
    if (!/^[0-9]+$/.test(weight)) {
      throw new CmsError('INVALID_WEIGHT', 'weight string must be a non-negative decimal integer');
    }
    w = BigInt(weight);
  } else {
    throw new CmsError('INVALID_WEIGHT', 'weight must be a positive integer (number or decimal string)');
  }
  if (w <= 0n) {
    throw new CmsError('INVALID_WEIGHT', 'weight must be a positive integer');
  }
  return w;
}

export function versionString(p: SketchParams): string {
  return `cms1:w${p.width}:d${p.depth}:s${p.seed}:utf8`;
}

export interface RowExplanation {
  row: number;
  index: number;
  count: string;
  isMin: boolean;
}

export interface Explanation {
  key: string;
  estimate: string;
  rows: RowExplanation[];
}

/** In-memory Count-Min Sketch with exact BigInt counters. Standard updates only. */
export class CountMinSketch {
  readonly width: number;
  readonly depth: number;
  readonly seed: number;
  private matrix: bigint[][];
  private total: bigint;

  constructor(params: SketchParams, matrix?: bigint[][], total?: bigint) {
    validateParams(params);
    this.width = params.width;
    this.depth = params.depth;
    this.seed = params.seed;
    this.matrix =
      matrix ?? Array.from({ length: this.depth }, () => new Array<bigint>(this.width).fill(0n));
    this.total = total ?? 0n;
  }

  get version(): string {
    return versionString(this);
  }

  get totalWeight(): bigint {
    return this.total;
  }

  indicesFor(key: string): number[] {
    const out = new Array<number>(this.depth);
    for (let r = 0; r < this.depth; r++) out[r] = columnIndex(key, r, this.seed, this.width);
    return out;
  }

  add(key: string, weight: bigint): void {
    validateKey(key);
    if (weight <= 0n) throw new CmsError('INVALID_WEIGHT', 'weight must be positive');
    const idx = this.indicesFor(key);
    for (let r = 0; r < this.depth; r++) this.matrix[r][idx[r]] += weight;
    this.total += weight;
  }

  query(key: string): bigint {
    validateKey(key);
    const idx = this.indicesFor(key);
    let min = this.matrix[0][idx[0]];
    for (let r = 1; r < this.depth; r++) {
      const c = this.matrix[r][idx[r]];
      if (c < min) min = c;
    }
    return min;
  }

  explain(key: string): Explanation {
    validateKey(key);
    const idx = this.indicesFor(key);
    let min = this.matrix[0][idx[0]];
    for (let r = 1; r < this.depth; r++) {
      const c = this.matrix[r][idx[r]];
      if (c < min) min = c;
    }
    const rows: RowExplanation[] = idx.map((index, r) => ({
      row: r,
      index,
      count: this.matrix[r][index].toString(),
      isMin: this.matrix[r][index] === min,
    }));
    return { key, estimate: min.toString(), rows };
  }

  cell(row: number, col: number): bigint {
    return this.matrix[row][col];
  }

  rowSums(): bigint[] {
    return this.matrix.map((row) => row.reduce((a, b) => a + b, 0n));
  }

  /** Merge two parameter-compatible sketches into a NEW sketch; sources untouched. */
  static merge(a: CountMinSketch, b: CountMinSketch): CountMinSketch {
    if (a.width !== b.width || a.depth !== b.depth || a.seed !== b.seed) {
      throw new CmsError(
        'INCOMPATIBLE_MERGE',
        `parameter mismatch: ${a.version} vs ${b.version}`,
      );
    }
    const matrix = Array.from({ length: a.depth }, (_, r) =>
      Array.from({ length: a.width }, (_, c) => a.matrix[r][c] + b.matrix[r][c]),
    );
    return new CountMinSketch(a, matrix, a.total + b.total);
  }

  toJSON(): ExportedState {
    return {
      version: this.version,
      width: this.width,
      depth: this.depth,
      seed: this.seed,
      encoding: 'utf8',
      totalWeight: this.total.toString(),
      matrix: this.matrix.map((row) => row.map((c) => c.toString())),
    };
  }

  /** Validate and rebuild a sketch from an exported state. */
  static fromJSON(state: unknown): CountMinSketch {
    if (typeof state !== 'object' || state === null) {
      throw new CmsError('INVALID_STATE', 'state must be an object');
    }
    const s = state as Record<string, unknown>;
    const params: SketchParams = {
      width: s.width as number,
      depth: s.depth as number,
      seed: s.seed as number,
    };
    validateParams(params);
    if (s.encoding !== 'utf8') {
      throw new CmsError('INVALID_STATE', 'encoding must be "utf8"');
    }
    if (s.version !== versionString(params)) {
      throw new CmsError('INVALID_STATE', `version mismatch: expected ${versionString(params)}, got ${String(s.version)}`);
    }
    if (typeof s.totalWeight !== 'string' || !/^[0-9]+$/.test(s.totalWeight)) {
      throw new CmsError('INVALID_STATE', 'totalWeight must be a non-negative decimal string');
    }
    const total = BigInt(s.totalWeight);
    if (!Array.isArray(s.matrix) || s.matrix.length !== params.depth) {
      throw new CmsError('INVALID_STATE', 'matrix row count must equal depth');
    }
    const matrix: bigint[][] = [];
    for (const row of s.matrix as unknown[]) {
      if (!Array.isArray(row) || row.length !== params.width) {
        throw new CmsError('INVALID_STATE', 'each matrix row must have exactly width cells');
      }
      const outRow: bigint[] = [];
      for (const cell of row) {
        if (typeof cell !== 'string' || !/^[0-9]+$/.test(cell)) {
          throw new CmsError('INVALID_STATE', 'matrix cells must be non-negative decimal strings');
        }
        outRow.push(BigInt(cell));
      }
      matrix.push(outRow);
    }
    const sketch = new CountMinSketch(params, matrix, total);
    for (let r = 0; r < params.depth; r++) {
      if (sketch.rowSums()[r] !== total) {
        throw new CmsError('INVALID_STATE', `row ${r} sum does not equal totalWeight`);
      }
    }
    return sketch;
  }
}

export interface ExportedState {
  version: string;
  width: number;
  depth: number;
  seed: number;
  encoding: 'utf8';
  totalWeight: string;
  matrix: string[][];
}
