import { createHash } from 'node:crypto';

/**
 * Deterministic column index for (key, row):
 * SHA-256 over seed(uint32 BE) || row(uint32 BE) || utf8(key),
 * take the first 8 bytes as an unsigned big-endian integer, mod width.
 */
export function columnIndex(key: string, row: number, seed: number, width: number): number {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(seed >>> 0, 0);
  prefix.writeUInt32BE(row >>> 0, 4);
  const digest = createHash('sha256').update(prefix).update(key, 'utf8').digest();
  const value = digest.readBigUInt64BE(0);
  return Number(value % BigInt(width));
}
