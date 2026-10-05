import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { columnIndex } from '../src/hash.js';
import { CountMinSketch, CmsError } from '../src/sketch.js';
import { Store } from '../src/store.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cms-test-'));
}

// Independent re-implementation of the spec for cross-checking.
function specIndex(key: string, row: number, seed: number, width: number): number {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(seed >>> 0, 0);
  prefix.writeUInt32BE(row >>> 0, 4);
  const digest = createHash('sha256').update(prefix).update(Buffer.from(key, 'utf8')).digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(width));
}

test('hash: fixed inputs produce spec-compliant column indices', () => {
  for (const [key, seed, width] of [['hello', 0, 1000], ['', 42, 4096], ['键', 7, 16]] as const) {
    for (let row = 0; row < 8; row++) {
      assert.equal(columnIndex(key, row, seed, width), specIndex(key, row, seed, width));
      assert.ok(columnIndex(key, row, seed, width) < width);
    }
  }
  // Golden value pinned so accidental spec changes fail loudly.
  assert.equal(columnIndex('hello', 0, 0, 1000), 231);
});

test('sketch: exact BigInt weights beyond Number.MAX_SAFE_INTEGER', () => {
  const s = new CountMinSketch({ width: 64, depth: 4, seed: 1 });
  const big = BigInt(Number.MAX_SAFE_INTEGER) * 2n + 12345n;
  s.add('k', big);
  s.add('k', 1n);
  assert.equal(s.query('k'), big + 1n);
  assert.equal(s.totalWeight, big + 1n);
  const json = s.toJSON();
  assert.equal(json.totalWeight, (big + 1n).toString());
});

test('sketch: empty key, case sensitivity, no trimming', () => {
  const s = new CountMinSketch({ width: 128, depth: 3, seed: 0 });
  s.add('', 5n);
  assert.equal(s.query(''), 5n);
  s.add('Key', 1n);
  s.add('key', 2n);
  s.add(' key', 4n);
  assert.equal(s.query('Key'), 1n);
  assert.equal(s.query('key'), 2n);
  assert.equal(s.query(' key'), 4n);
});

test('sketch: rejects ill-formed Unicode keys', () => {
  const s = new CountMinSketch({ width: 8, depth: 2, seed: 0 });
  assert.throws(() => s.add('\uD800', 1n), CmsError);
  assert.throws(() => s.query('\uDFFFx'), CmsError);
});

test('sketch: weight accumulation and standard min query', () => {
  const s = new CountMinSketch({ width: 256, depth: 5, seed: 9 });
  s.add('a', 3n);
  s.add('a', 4n);
  s.add('b', 10n);
  assert.equal(s.query('a'), 7n);
  assert.equal(s.query('b'), 10n);
  assert.equal(s.totalWeight, 17n);
  const exp = s.explain('a');
  assert.equal(exp.rows.length, 5);
  assert.ok(exp.rows.some((r) => r.isMin));
  assert.equal(exp.estimate, '7');
});

test('sketch: empty sketch queries zero; unseen key may be positive', () => {
  const s = new CountMinSketch({ width: 1, depth: 2, seed: 0 });
  assert.equal(s.query('never-added'), 0n);
  s.add('x', 5n);
  assert.equal(s.query('never-added'), 5n); // width=1: total collision
});

test('import: rejects invalid states', () => {
  const s = new CountMinSketch({ width: 4, depth: 2, seed: 0 });
  s.add('a', 3n);
  const good = s.toJSON();
  assert.doesNotThrow(() => CountMinSketch.fromJSON(good));

  const badDims = { ...good, matrix: good.matrix.slice(0, 1) };
  assert.throws(() => CountMinSketch.fromJSON(badDims), /matrix row count/);

  const neg = structuredClone(good);
  neg.matrix[0][0] = '-1';
  assert.throws(() => CountMinSketch.fromJSON(neg), /non-negative/);

  const badSum = structuredClone(good);
  badSum.matrix[1][0] = (BigInt(badSum.matrix[1][0]) + 1n).toString();
  assert.throws(() => CountMinSketch.fromJSON(badSum), /row 1 sum/);

  const badVersion = { ...good, version: 'cms9:w4:d2:s0:utf8' };
  assert.throws(() => CountMinSketch.fromJSON(badVersion), /version mismatch/);

  const badWidth = { ...good, width: 5000 };
  assert.throws(() => CountMinSketch.fromJSON(badWidth), /width/);
});

test('overestimation: estimates never below exact counts on random small sample', () => {
  const s = new CountMinSketch({ width: 32, depth: 4, seed: 3 });
  const exact = new Map<string, bigint>();
  let rng = 12345;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 500; i++) {
    const key = `key-${Math.floor(rand() * 80)}`;
    const w = BigInt(1 + Math.floor(rand() * 5));
    s.add(key, w);
    exact.set(key, (exact.get(key) ?? 0n) + w);
  }
  for (const [key, truth] of exact) {
    assert.ok(s.query(key) >= truth, `${key}: estimate below truth`);
  }
});

function sketchFrom(store: Store, id: number): CountMinSketch {
  return store.load(id);
}

test('merge: commutative, associative, self-merge doubles, equals continuous adds', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const params = { width: 64, depth: 4, seed: 11 };
  const a = store.create(params);
  const b = store.create(params);
  const c = store.create(params);
  store.addBatch(a.id, [{ key: 'x', weight: 2 }, { key: 'y', weight: 3 }]);
  store.addBatch(b.id, [{ key: 'x', weight: 5 }, { key: 'z', weight: 1 }]);
  store.addBatch(c.id, [{ key: 'y', weight: 7 }]);

  const ab = sketchFrom(store, store.merge(a.id, b.id).id);
  const ba = sketchFrom(store, store.merge(b.id, a.id).id);
  assert.deepEqual(ab.toJSON().matrix, ba.toJSON().matrix); // commutative

  const abc1 = CountMinSketch.merge(ab, sketchFrom(store, c.id));
  const bc = sketchFrom(store, store.merge(b.id, c.id).id);
  const abc2 = CountMinSketch.merge(sketchFrom(store, a.id), bc);
  assert.deepEqual(abc1.toJSON().matrix, abc2.toJSON().matrix); // associative

  const aa = CountMinSketch.merge(sketchFrom(store, a.id), sketchFrom(store, a.id));
  assert.equal(aa.query('x'), 4n); // self-merge doubles, not idempotent
  assert.equal(aa.totalWeight, 10n);

  // merge == continuous adds in one sketch
  const direct = new CountMinSketch(params);
  direct.add('x', 2n); direct.add('y', 3n);
  direct.add('x', 5n); direct.add('z', 1n);
  direct.add('y', 7n);
  assert.deepEqual(abc1.toJSON().matrix, direct.toJSON().matrix);
  assert.equal(abc1.totalWeight, direct.totalWeight);
  assert.equal(abc1.query('x'), 7n); // same key in two sources adds up
  store.close();
});

test('merge: rejects incompatible params and keeps sources unmodified (snapshot isolation)', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const a = store.create({ width: 16, depth: 2, seed: 0 });
  const b = store.create({ width: 32, depth: 2, seed: 0 });
  assert.throws(
    () => store.merge(a.id, b.id),
    (e: unknown) => e instanceof CmsError && e.code === 'INCOMPATIBLE_MERGE',
  );

  const c = store.create({ width: 16, depth: 2, seed: 0 });
  store.addBatch(a.id, [{ key: 'k', weight: 5 }]);
  const m = store.merge(a.id, c.id);
  store.addBatch(a.id, [{ key: 'k', weight: 100 }]); // mutate source after merge
  assert.equal(store.query(m.id, 'k').estimate, '5'); // snapshot unaffected
  assert.equal(store.query(a.id, 'k').estimate, '105');
  store.close();
});

test('persistence: restart continues identically to uninterrupted run', () => {
  const dir = tmpDir();
  let store = new Store(dir);
  const meta = store.create({ width: 32, depth: 3, seed: 5 });
  store.addBatch(meta.id, [{ key: 'a', weight: 2 }, { key: 'b', weight: 9 }]);
  store.close();

  store = new Store(dir); // "restart"
  store.addBatch(meta.id, [{ key: 'a', weight: 3 }]);
  const after = store.query(meta.id, 'a').estimate;
  const totalB = store.query(meta.id, 'b').estimate;
  store.close();

  const dir2 = tmpDir();
  const store2 = new Store(dir2);
  const meta2 = store2.create({ width: 32, depth: 3, seed: 5 });
  store2.addBatch(meta2.id, [{ key: 'a', weight: 2 }, { key: 'b', weight: 9 }]);
  store2.addBatch(meta2.id, [{ key: 'a', weight: 3 }]);
  assert.equal(after, store2.query(meta2.id, 'a').estimate);
  assert.equal(totalB, store2.query(meta2.id, 'b').estimate);
  store2.close();
});

test('batch: invalid batch leaves no partial updates', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const meta = store.create({ width: 16, depth: 2, seed: 0 });
  store.addBatch(meta.id, [{ key: 'ok', weight: 1 }]);
  assert.throws(
    () => store.addBatch(meta.id, [{ key: 'good', weight: 5 }, { key: 'bad', weight: -2 }]),
    (e: unknown) => e instanceof CmsError && e.code === 'INVALID_WEIGHT',
  );
  assert.equal(store.query(meta.id, 'good').estimate, '0');
  assert.equal(store.getMeta(meta.id).totalWeight, '1');
  store.close();
});

test('store: export/import round-trip and history', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const meta = store.create({ width: 8, depth: 2, seed: 1 });
  store.addBatch(meta.id, [{ key: 'k', weight: '9007199254740993' }]);
  const state = store.exportState(meta.id);
  const imported = store.importState(state);
  assert.equal(store.query(imported.id, 'k').estimate, '9007199254740993');
  const ops = store.history(meta.id, 10) as { op: string }[];
  assert.deepEqual(ops.map((o) => o.op).sort(), ['add', 'create']);
  store.close();
});
