import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../src/service.js";
import { CountMinSketch, CmsError } from "../src/sketch.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cms-test-"));
}

test("非法批次整体回滚，不留下部分更新", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const service = new Service(dir); services.push(service);
    service.create("s", { width: 8, depth: 3, seed: 0 });
    service.add("s", "keep", 10);
    const before = service.info("s").totalWeight;
    assert.throws(() =>
      service.addBatch("s", [
        { key: "partial", weight: 5 },
        { key: "bad", weight: -2 },
      ]),
    );
    const after = service.info("s").totalWeight;
    assert.equal(after, before);
    assert.equal(service.query("s", "keep").estimate, "10");
    assert.equal(service.query("s", "partial").estimate, "0");
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重启（重新打开数据目录）后继续加入/查询与不中断运行一致", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const first = new Service(dir); services.push(first);
    first.create("s", { width: 16, depth: 4, seed: 9 });
    first.addBatch("s", [
      { key: "a", weight: 3 },
      { key: "b", weight: 8 },
    ]);

    const expected = new CountMinSketch({ width: 16, depth: 4, seed: 9 });
    expected.add("a", 3n);
    expected.add("b", 8n);
    expected.add("a", 2n);

    // 模拟进程重启：新 Service、未缓存的 Store 句柄
    const second = new Service(dir); services.push(second);
    second.add("s", "a", 2);
    for (const key of ["a", "b", "ghost"]) {
      assert.deepEqual(second.query("s", key), expected.query(key));
    }
    assert.equal(second.info("s").totalWeight, expected.total.toString());
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不同摘要物理隔离，写入与查询互不混用", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const service = new Service(dir); services.push(service);
    service.create("x", { width: 8, depth: 2, seed: 0 });
    service.create("y", { width: 8, depth: 2, seed: 0 });
    service.add("x", "only-x", 5);
    assert.equal(service.query("x", "only-x").estimate, "5");
    assert.equal(service.query("y", "only-x").estimate, "0");
    assert.deepEqual(service.list().sort(), ["x", "y"]);
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("合并落库：来源不变、目标为单元相加、可再次合并", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const service = new Service(dir); services.push(service);
    service.create("a", { width: 32, depth: 4, seed: 3 });
    service.create("b", { width: 32, depth: 4, seed: 3 });
    service.addBatch("a", [{ key: "shared", weight: 4 }, { key: "a-only", weight: 11 }]);
    service.addBatch("b", [{ key: "shared", weight: 6 }, { key: "b-only", weight: 1 }]);

    const result = service.merge("a", "b", "c");
    assert.equal(result.totalWeight, "22");
    assert.equal(service.query("c", "shared").estimate, "10");
    assert.equal(service.info("a").totalWeight, "15");
    assert.equal(service.info("b").totalWeight, "7");

    // 合并产物可继续参与合并（重启后也可）
    const restarted = new Service(dir); services.push(restarted);
    const again = restarted.merge("c", "a", "d");
    assert.equal(again.totalWeight, "37"); // 22 + 15
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("参数不兼容的持久化摘要拒绝合并", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const service = new Service(dir); services.push(service);
    service.create("a", { width: 8, depth: 2, seed: 0 });
    service.create("b", { width: 8, depth: 2, seed: 1 });
    assert.throws(() => service.merge("a", "b", "c"), (e: CmsError) => e.code === "INCOMPATIBLE_SKETCH");
    assert.equal(service.list().includes("c"), false);
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("导出/导入往返 + 导入校验失败不覆盖目标", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const service = new Service(dir); services.push(service);
    service.create("s", { width: 5, depth: 2, seed: 0 });
    service.addBatch("s", [
      { key: "a", weight: 4 },
      { key: "b", weight: 6 },
    ]);
    const snapshot = service.export("s");
    const importResult = service.import("copy", snapshot, false);
    assert.equal(importResult.replaced, false);
    assert.deepEqual(service.export("copy"), snapshot);

    // 行和不等于总权重 => 拒绝
    const bad = JSON.parse(JSON.stringify(snapshot));
    bad.matrix[0][0] = String(BigInt(bad.matrix[0][0]) + 1n);
    assert.throws(() => service.import("copy", bad, true), (e: CmsError) => e.code === "INVALID_SNAPSHOT");
    // 失败后目标仍是旧的正确状态
    assert.deepEqual(service.export("copy"), snapshot);

    // 目标已存在且未指定 replace => 拒绝
    assert.throws(() => service.import("copy", snapshot, false), (e: CmsError) => e.code === "SKETCH_EXISTS");
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("操作历史按顺序记录", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const service = new Service(dir); services.push(service);
    service.create("s", { width: 4, depth: 2, seed: 0 });
    service.add("s", "a", 2);
    service.addBatch("s", [
      { key: "b", weight: 3 },
      { key: "c", weight: 3 },
    ]);
    const { total, records } = service.history("s", 10, 0);
    assert.equal(total, 3);
    assert.deepEqual(records.map((r) => r.op), ["create", "add", "add-batch"]);
    assert.deepEqual(records.map((r) => r.totalWeightAfter), ["0", "2", "8"]);
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("小样本高估性质：独立精确字典 <= CMS 估计", () => {
  const dir = tempDir();
  const services: Service[] = [];
  try {
    const service = new Service(dir); services.push(service);
    service.create("s", { width: 4, depth: 4, seed: 2 });
    const exact = new Map<string, bigint>();
    const keys = ["alpha", "beta", "gamma", "delta", "alpha", "beta", "", "Alpha"];
    for (const key of keys) {
      service.add("s", key, 1);
      exact.set(key, (exact.get(key) ?? 0n) + 1n);
    }
    for (const [key, truth] of exact) {
      assert.ok(BigInt(service.query("s", key).estimate) >= truth, `${key} 估计不应低于精确值`);
    }
    // 精确值核对（大小写敏感、空键）
    assert.equal(exact.get("alpha"), 2n);
    assert.equal(exact.get("Alpha"), 1n);
    assert.equal(exact.get(""), 1n);
  } finally {
    for (const s of services) s.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});




