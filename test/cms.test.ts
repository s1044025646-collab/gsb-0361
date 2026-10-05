import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CountMinSketch,
  CmsError,
  columnIndex,
  isValidUnicodeString,
  RULE_VERSION,
  ENCODING,
} from "../src/sketch.js";

test("固定哈希输入核对列下标（SHA-256 前 8 字节大端取余）", () => {
  assert.equal(columnIndex("", 0, 0, 8), 2);
  assert.equal(columnIndex("foo", 0, 0, 16), 8);
  assert.equal(columnIndex("foo", 1, 0, 16), 13);
  assert.equal(columnIndex("foo", 0, 1, 16), 6);
  assert.equal(columnIndex("bar", 42, 3, 4096), 2546);
  assert.equal(columnIndex("中文", 7, 2, 100), 71);
});

test("宽度为 1 时所有键、所有行的列下标都是 0", () => {
  for (const key of ["", "a", "anything"]) {
    for (let row = 0; row < 8; row++) {
      assert.equal(columnIndex(key, 99, row, 1), 0);
    }
  }
});

test("种子和行号变化会改变结果（输入不同）", () => {
  assert.notEqual(columnIndex("k", 0, 0, 4096), columnIndex("k", 1, 0, 4096));
  assert.notEqual(columnIndex("k", 0, 0, 4096), columnIndex("k", 0, 1, 4096));
});

test("空字符串是合法键且参与计算；未配对代理项被拒绝", () => {
  assert.equal(isValidUnicodeString(""), true);
  assert.equal(isValidUnicodeString("a\uD83D\uDE00b"), true); // 配对的 emoji
  assert.equal(isValidUnicodeString("lone-\uD800"), false);
  assert.equal(isValidUnicodeString("\uDC00-start"), false);
  const sketch = new CountMinSketch({ width: 4, depth: 2, seed: 0 });
  sketch.add("", 10n);
  assert.equal(sketch.query("").estimate, "10");
  assert.throws(() => sketch.add("bad\uD800", 1n), (err: CmsError) => err instanceof CmsError && err.code === "INVALID_KEY");
});

test("权重叠加与查询取最小值（标准更新，非 conservative）", () => {
  const sketch = new CountMinSketch({ width: 8, depth: 4, seed: 5 });
  sketch.add("alpha", 3n);
  sketch.add("alpha", 7n);
  sketch.add("beta", 2n);
  const result = sketch.query("alpha");
  assert.equal(result.estimate, "10");
  assert.ok(result.rows.every((r) => BigInt(r.count) >= 10n));
  assert.ok(result.rows.some((r) => r.minimum));
  assert.equal(result.rows.filter((r) => r.minimum).length >= 1, true);
});

test("大整数精确累加，超过 Number 安全整数范围不丢精度", () => {
  const sketch = new CountMinSketch({ width: 2, depth: 2, seed: 0 });
  sketch.add("x", 9007199254740993n);
  sketch.add("x", 9007199254740999n);
  assert.equal(sketch.query("x").estimate, "18014398509481992");
  assert.equal(sketch.total, 18014398509481992n);
});

test("拒绝非正、非整数权重", () => {
  const sketch = new CountMinSketch({ width: 2, depth: 2, seed: 0 });
  assert.throws(() => sketch.add("a", 0n), (e: Error) => e instanceof CmsError && e.code === "INVALID_WEIGHT");
  assert.throws(() => sketch.add("a", -1n), (e: Error) => e instanceof CmsError && e.code === "INVALID_WEIGHT");
});

test("参数边界校验：w 1..4096，d 1..8", () => {
  assert.doesNotThrow(() => new CountMinSketch({ width: 1, depth: 1, seed: 0 }));
  assert.doesNotThrow(() => new CountMinSketch({ width: 4096, depth: 8, seed: 4294967295 }));
  assert.throws(() => new CountMinSketch({ width: 0, depth: 2, seed: 0 }), (e: CmsError) => e.code === "INVALID_WIDTH");
  assert.throws(() => new CountMinSketch({ width: 4097, depth: 2, seed: 0 }), (e: CmsError) => e.code === "INVALID_WIDTH");
  assert.throws(() => new CountMinSketch({ width: 4, depth: 9, seed: 0 }), (e: CmsError) => e.code === "INVALID_DEPTH");
});

test("合并按单元相加：交换律、结合律、与连续增加一致、自合并翻倍", () => {
  const params = { width: 32, depth: 5, seed: 11 };
  const a = new CountMinSketch(params);
  const b = new CountMinSketch(params);
  a.add("k1", 4n);
  a.add("shared", 3n);
  b.add("k2", 6n);
  b.add("shared", 5n);

  const ab = a.merge(b);
  const ba = b.merge(a);
  assert.deepEqual(ab.toJSON().matrix, ba.toJSON().matrix); // 交换律
  assert.equal(ab.total, ba.total);

  const c = new CountMinSketch(params);
  c.add("k3", 2n);
  const abc1 = ab.merge(c);
  const bc = b.merge(c);
  const abc2 = a.merge(bc);
  assert.deepEqual(abc1.toJSON().matrix, abc2.toJSON().matrix); // 结合律

  // 与同顺序连续增加一致（无碰撞情形下逐单元相等）
  const sequential = new CountMinSketch(params);
  sequential.add("k1", 4n);
  sequential.add("shared", 3n);
  sequential.add("k2", 6n);
  sequential.add("shared", 5n);
  assert.deepEqual(ab.toJSON().matrix, sequential.toJSON().matrix);
  assert.equal(ab.query("shared").estimate, "8");

  // 自合并翻倍
  const self = a.merge(a);
  assert.equal(self.total, a.total * 2n);
  assert.equal(self.query("shared").estimate, "6");

  // 来源不被修改
  assert.equal(a.total, 7n);
  assert.equal(b.total, 11n);
});

test("参数不兼容拒绝合并", () => {
  const a = new CountMinSketch({ width: 8, depth: 2, seed: 0 });
  const diffWidth = new CountMinSketch({ width: 9, depth: 2, seed: 0 });
  const diffSeed = new CountMinSketch({ width: 8, depth: 2, seed: 1 });
  assert.throws(() => a.merge(diffWidth), (e: CmsError) => e.code === "INCOMPATIBLE_SKETCH");
  assert.throws(() => a.merge(diffSeed), (e: CmsError) => e.code === "INCOMPATIBLE_SKETCH");
});

test("空摘要查询为零；查询解释含规则版本、编码与每行信息", () => {
  const sketch = new CountMinSketch({ width: 4, depth: 3, seed: 1 });
  const result = sketch.query("anything");
  assert.equal(result.estimate, "0");
  assert.equal(result.ruleVersion, "cms-sha256-be-v1");
  assert.equal(result.encoding, "utf8");
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every((r) => r.minimum && r.count === "0"));
});

test("快照导出/导入往返保持一致", () => {
  const sketch = new CountMinSketch({ width: 6, depth: 3, seed: 3 });
  sketch.add("a", 5n);
  sketch.add("b", 7n);
  const json = JSON.parse(JSON.stringify(sketch.toJSON()));
  const restored = CountMinSketch.fromSnapshot(json);
  assert.deepEqual(restored.toJSON(), sketch.toJSON());
  assert.equal(restored.query("a").estimate, "5");
});

test("导入拒绝：维度不符、负计数、行和不等于总权重、坏格式", () => {
  const sketch = new CountMinSketch({ width: 3, depth: 2, seed: 0 });
  sketch.add("a", 4n);
  const base = sketch.toJSON();

  const wrongDim = JSON.parse(JSON.stringify(base));
  wrongDim.width = 4;
  assert.throws(() => CountMinSketch.fromSnapshot(wrongDim), (e: CmsError) => e.code === "INVALID_SNAPSHOT");

  const negative = JSON.parse(JSON.stringify(base));
  negative.matrix[0][0] = "-1";
  negative.matrix[0][1] = String(BigInt(negative.matrix[0][1]) + 1n);
  assert.throws(() => CountMinSketch.fromSnapshot(negative), (e: CmsError) => e.code === "INVALID_SNAPSHOT");

  const badRowSum = JSON.parse(JSON.stringify(base));
  badRowSum.matrix[0][0] = String(BigInt(badRowSum.matrix[0][0]) + 1n);
  assert.throws(() => CountMinSketch.fromSnapshot(badRowSum), (e: CmsError) => e.code === "INVALID_SNAPSHOT");

  const badTotal = JSON.parse(JSON.stringify(base));
  badTotal.totalWeight = "999";
  assert.throws(() => CountMinSketch.fromSnapshot(badTotal), (e: CmsError) => e.code === "INVALID_SNAPSHOT");

  assert.throws(() => CountMinSketch.fromSnapshot({}), (e: CmsError) => e.code === "INVALID_SNAPSHOT");
  assert.throws(() => CountMinSketch.fromSnapshot("nope"), (e: CmsError) => e.code === "INVALID_SNAPSHOT");
});

test("规则版本与编码为固定值", () => {
  assert.equal(RULE_VERSION, "cms-sha256-be-v1");
  assert.equal(ENCODING, "utf8");
});

