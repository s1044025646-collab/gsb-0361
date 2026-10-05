import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CountMinSketch } from "./sketch.js";
import { Service } from "./service.js";

interface Event {
  key: string;
  weight: number;
}

const EVENTS: Event[] = [
  { key: "apple", weight: 3 },
  { key: "banana", weight: 5 },
  { key: "cherry", weight: 2 },
  { key: "apple", weight: 4 },
  { key: "dragonfruit", weight: 7 },
  { key: "banana", weight: 1 },
  { key: "", weight: 6 }, // 空字符串是合法键
  { key: "Elderberry", weight: 2 }, // 区分大小写：elderberry 与之不同
];

function exactFrequencies(events: Event[]): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const { key, weight } of events) {
    map.set(key, (map.get(key) ?? 0n) + BigInt(weight));
  }
  return map;
}

function buildSketch(width: number, depth: number, seed: number, events: Event[]): CountMinSketch {
  const sketch = new CountMinSketch({ width, depth, seed });
  for (const { key, weight } of events) sketch.add(key, BigInt(weight));
  return sketch;
}

function line(title: string): void {
  console.log("");
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function main(): void {
  const exact = exactFrequencies(EVENTS);
  const total = EVENTS.reduce((sum, e) => sum + e.weight, 0);
  console.log("Count–Min Sketch 碰撞解释演示");
  console.log(`事件 ${EVENTS.length} 条，总输入权重 ${total}，独立精确字典仅用于演示对照（不参与摘要计算）`);

  line("演示 1：宽度 w=1 —— 所有键必然碰撞到唯一单元");
  const tiny = buildSketch(1, 4, 123, EVENTS);
  const queriedKeys = ["apple", "banana", "never-seen"];
  for (const key of queriedKeys) {
    const result = tiny.query(key);
    const truth = exact.get(key) ?? 0n;
    console.log(
      `键 ${JSON.stringify(key)}: 估计=${result.estimate} 精确=${truth} ` +
        `各行列下标=[${result.rows.map((r) => r.column).join(",")}]（w=1 时全部为 0）`,
    );
  }
  console.log("结论：从未加入的键 \"never-seen\" 估计也为总权重 30，不能据此宣称它出现过。");

  line("演示 2：同一批数据在不同宽度下的估计变化（d=4, seed=123）");
  console.log("键".padEnd(14) + "精确".padStart(8) + "w=1".padStart(10) + "w=4".padStart(10) + "w=16".padStart(10) + "w=64".padStart(10));
  const widths = [1, 4, 16, 64];
  const sketches = widths.map((w) => buildSketch(w, 4, 123, EVENTS));
  const allKeys = [...exact.keys(), "ghost-key", "elderberry"];
  for (const key of allKeys) {
    const truth = exact.get(key) ?? 0n;
    const estimates = sketches.map((s) => s.query(key).estimate);
    console.log(
      JSON.stringify(key).padEnd(14) +
        truth.toString().padStart(8) +
        estimates.map((e) => e.padStart(10)).join(""),
    );
  }
  console.log("");
  console.log("说明：估计始终不低于精确值（无负更新）。增大宽度通常缓解碰撞，但并不保证");
  console.log("每个键、每一次都单调下降——某些宽度下哈希落点可能恰好产生同样的碰撞。");

  line("演示 3：逐行解释（w=4, d=4, 键 \"apple\"）");
  const explain = sketches[1].query("apple");
  for (const row of explain.rows) {
    console.log(
      `行 ${row.row}: 列=${row.column} 计数=${row.count}${row.minimum ? "  <- 取最小值 => 估计" : ""}`,
    );
  }
  console.log(`规则版本=${explain.ruleVersion}，编码=${explain.encoding}，seed=${explain.seed}`);

  line("演示 4：大整数（超过 Number.MAX_SAFE_INTEGER）精确累加");
  const big = new CountMinSketch({ width: 2, depth: 2, seed: 0 });
  const huge1 = "9007199254740993"; // 2^53 + 1，超出安全整数
  const huge2 = "9007199254740999"; // 2^53 + 7
  big.add("bignum", BigInt(huge1));
  big.add("bignum", BigInt(huge2));
  const bigResult = big.query("bignum");
  console.log(`${huge1} + ${huge2} = 18014398509481992`);
  console.log(`查询估计 = ${bigResult.estimate}（bigint 精确，无浮点丢失）`);

  line("演示 5：SQLite 持久化、合并与自合并翻倍");
  const dir = mkdtempSync(join(tmpdir(), "cms-demo-"));
  const service = new Service(dir);
  service.create("s1", { width: 8, depth: 3, seed: 7 });
  service.create("s2", { width: 8, depth: 3, seed: 7 });
  service.addBatch("s1", [
    { key: "shared", weight: 4 },
    { key: "only-s1", weight: 9 },
  ]);
  service.addBatch("s2", [
    { key: "shared", weight: 5 },
    { key: "only-s2", weight: 2 },
  ]);
  const merged = service.merge("s1", "s2", "s1-plus-s2");
  console.log("合并 totalWeight =", merged.totalWeight, "（来源 4+9 与 5+2 之和 = 20）");
  console.log("shared 估计 =", service.query("s1-plus-s2", "shared").estimate, "（同一键权重相加 4+5=9）");
  const selfMerged = service.merge("s1", "s1", "s1-self");
  console.log("自合并 totalWeight =", selfMerged.totalWeight, "（不是并集，全部翻倍）");
  console.log("来源 s1 的 totalWeight 仍为", service.info("s1").totalWeight, "（来源未被修改）");

  line("演示 6：非法批次整体拒绝（不留下部分更新）");
  const before = service.info("s1").totalWeight;
  try {
    service.addBatch("s1", [
      { key: "ok", weight: 1 },
      { key: "bad", weight: -3 },
    ]);
  } catch (err) {
    console.log("被拒绝：", (err as Error).message);
  }
  const after = service.info("s1").totalWeight;
  console.log(`批次前后 totalWeight: ${before} -> ${after}（一致，无部分更新）`);
  console.log("");
}

main();
