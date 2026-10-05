#!/usr/bin/env node
import { resolve } from "node:path";
import { Service } from "./service.js";
import { CmsError, validateParams } from "./sketch.js";

const DATA_DIR = process.env.CMS_DATA_DIR ? resolve(process.env.CMS_DATA_DIR) : resolve(process.cwd(), "data");

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(token.slice(2), next);
          i++;
        } else {
          flags.set(token.slice(2), "true");
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new CmsError("MISSING_PARAM", `缺少必填参数 --${name}`);
  return value;
}

function numberFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new CmsError("MISSING_PARAM", `--${name} 必须是整数`);
  return n;
}

const HELP = `cms — Count–Min Sketch 频次估计 CLI（数据目录可用 CMS_DATA_DIR 覆盖，默认 ./data）

用法:
  cms create  <id> --width <1..4096> --depth <1..8> --seed <0..4294967295>
  cms list
  cms info    <id>
  cms add     <id> --key <字符串> [--weight <正整数>]
  cms batch   <id> --file <entries.json>
  cms query   <id> --key <字符串>
  cms cells   <id> [--limit N] [--offset N]
  cms history <id> [--limit N] [--offset N]
  cms merge   <leftId> <rightId> --target <newId>
  cms export  <id> [--file <out.json>]
  cms import  <id> --file <snapshot.json> [--replace]

批量文件格式: { "entries": [ { "key": "a", "weight": 3 }, ... ] }
权重可用十进制字符串以表达超过 Number 安全整数范围的值。
空字符串是合法键: cms query <id> --key ""
`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const service = new Service(DATA_DIR);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }

  let result: unknown;
  switch (command) {
    case "create": {
      const id = positional[1];
      if (!id) throw new CmsError("MISSING_PARAM", "缺少摘要 id");
      const params = validateParams({
        width: numberFlag(flags, "width", NaN),
        depth: numberFlag(flags, "depth", NaN),
        seed: numberFlag(flags, "seed", NaN),
      });
      result = service.create(id, params);
      break;
    }
    case "list":
      result = { sketches: service.list() };
      break;
    case "info":
      result = service.info(positional[1] ?? failId());
      break;
    case "add": {
      const id = positional[1] ?? failId();
      const key = requireFlag(flags, "key");
      result = service.add(id, key, flags.get("weight") ?? 1);
      break;
    }
    case "batch": {
      const id = positional[1] ?? failId();
      const file = resolve(requireFlag(flags, "file"));
      const parsed = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")));
      if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as any).entries)) {
        throw new CmsError("INVALID_BATCH", "批量文件必须包含 entries 数组");
      }
      result = service.addBatch(id, (parsed as { entries: unknown }).entries);
      break;
    }
    case "query":
      result = service.query(positional[1] ?? failId(), requireFlag(flags, "key"));
      break;
    case "cells":
      result = service.cells(positional[1] ?? failId(), numberFlag(flags, "limit", 100), numberFlag(flags, "offset", 0));
      break;
    case "history":
      result = service.history(
        positional[1] ?? failId(),
        numberFlag(flags, "limit", 50),
        numberFlag(flags, "offset", 0),
      );
      break;
    case "merge": {
      const left = positional[1] ?? failId();
      const right = positional[2];
      if (!right) throw new CmsError("MISSING_PARAM", "缺少右侧摘要 id");
      result = service.merge(left, right, requireFlag(flags, "target"));
      break;
    }
    case "export": {
      const id = positional[1] ?? failId();
      const file = flags.get("file");
      result = file ? service.exportFile(id, resolve(file)) : service.export(id);
      break;
    }
    case "import": {
      const id = positional[1] ?? failId();
      const file = resolve(requireFlag(flags, "file"));
      result = service.importFile(id, file, flags.has("replace"));
      break;
    }
    default:
      throw new CmsError("UNKNOWN_COMMAND", `未知命令：${command}（运行 cms help 查看用法）`);
  }

  process.stdout.write(
    JSON.stringify(
      result,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) + "\n",
  );
}

function failId(): string {
  throw new CmsError("MISSING_PARAM", "缺少摘要 id");
}

main().catch((err: unknown) => {
  const code = err instanceof CmsError ? err.code : "INTERNAL";
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`错误 [${code}]: ${message}\n`);
  process.exit(1);
});
