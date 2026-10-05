import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { Service, LIMITS } from "./service.js";
import { CmsError, validateParams } from "./sketch.js";

const DATA_DIR = process.env.CMS_DATA_DIR
  ? process.env.CMS_DATA_DIR
  : join(process.cwd(), "data");

interface RouteContext {
  service: Service;
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
}

type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const patternText = path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${patternText}$`), paramNames, handler };
}

const ROUTES: Route[] = [
  route("GET", "/health", () => ({ status: "ok" })),
  route("GET", "/limits", () => ({ limits: LIMITS })),
  route("GET", "/v1/sketches", (ctx) => ({ sketches: ctx.service.list() })),
  route("POST", "/v1/sketches", (ctx) => {
    const body = asBody(ctx.body);
    return ctx.service.create(asId(body.id), validateParams({ width: body.width, depth: body.depth, seed: body.seed }));
  }),
  route("GET", "/v1/sketches/:id", (ctx) => ctx.service.info(ctx.params.id)),
  route("POST", "/v1/sketches/:id/add", (ctx) => {
    const body = asBody(ctx.body);
    return ctx.service.add(ctx.params.id, body.key, body.weight ?? 1);
  }),
  route("POST", "/v1/sketches/:id/batch", (ctx) => {
    const body = asBody(ctx.body);
    return ctx.service.addBatch(ctx.params.id, body.entries);
  }),
  route("GET", "/v1/sketches/:id/query", (ctx) => {
    const key = ctx.query.get("key");
    return ctx.service.query(ctx.params.id, key);
  }),
  route("POST", "/v1/sketches/:id/query", (ctx) => {
    const body = asBody(ctx.body);
    return ctx.service.query(ctx.params.id, body.key);
  }),
  route("GET", "/v1/sketches/:id/cells", (ctx) =>
    ctx.service.cells(ctx.params.id, numberParam(ctx.query, "limit", 100), numberParam(ctx.query, "offset", 0)),
  ),
  route("GET", "/v1/sketches/:id/history", (ctx) =>
    ctx.service.history(ctx.params.id, numberParam(ctx.query, "limit", 50), numberParam(ctx.query, "offset", 0)),
  ),
  route("POST", "/v1/sketches/:id/merge", (ctx) => {
    const body = asBody(ctx.body);
    return ctx.service.merge(ctx.params.id, asId(body.with), asId(body.target));
  }),
  route("GET", "/v1/sketches/:id/export", (ctx) => ctx.service.export(ctx.params.id)),
  route("POST", "/v1/imports/:id", (ctx) => {
    const body = asBody(ctx.body);
    return ctx.service.import(ctx.params.id, body.snapshot ?? body, body.replace === true);
  }),
  route("POST", "/v1/merge", (ctx) => {
    const body = asBody(ctx.body);
    return ctx.service.merge(asId(body.left), asId(body.right), asId(body.target));
  }),
];

function asBody(body: unknown): Record<string, any> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CmsError("INVALID_REQUEST", "请求体必须是 JSON 对象");
  }
  return body;
}

function asId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new CmsError("INVALID_ID", "摘要 id 必须是 1..64 位的字母、数字、下划线或连字符");
  }
  return value;
}

function numberParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new CmsError("INVALID_QUERY_PARAM", `查询参数 ${name} 必须是整数`);
  return n;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

export function createApp(service: Service): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, service);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, service: Service): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    let body: unknown = undefined;
    if (req.method === "POST" || req.method === "PUT") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > LIMITS.maxJsonBodyBytes) {
          throw new CmsError("BODY_TOO_LARGE", `请求体超过 ${LIMITS.maxJsonBodyBytes} 字节上限`);
        }
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new CmsError("INVALID_JSON", "请求体不是合法 JSON");
        }
      }
    }

    for (const routeEntry of ROUTES) {
      if (routeEntry.method !== req.method) continue;
      const match = routeEntry.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      routeEntry.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      const result = await routeEntry.handler({ service, body, params, query: url.searchParams });
      send(res, 200, { ok: true, data: result });
      return;
    }
    throw new CmsError("NOT_FOUND", `未找到路由：${req.method} ${url.pathname}`);
  } catch (err) {
    if (err instanceof CmsError) {
      send(res, statusForCode(err.code), { ok: false, error: { code: err.code, message: err.message } });
      return;
    }
    send(res, 500, {
      ok: false,
      error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function statusForCode(code: string): number {
  switch (code) {
    case "NOT_FOUND":
    case "SKETCH_NOT_FOUND":
      return 404;
    case "SKETCH_EXISTS":
      return 409;
    case "BODY_TOO_LARGE":
      return 413;
    default:
      return 400;
  }
}

/** 请求一个空闲端口：先由操作系统分配 0 端口，拿到端口后立即关闭并复用。 */
export function findIdlePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
  });
}

async function main(): Promise<void> {
  const requested = process.env.CMS_PORT ?? process.argv[2];
  const port = requested ? Number(requested) : await findIdlePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CMS_PORT 必须是 1..65535 的整数");
  }
  const service = new Service(DATA_DIR);
  const app = createApp(service);
  app.listen(port, "127.0.0.1", () => {
    console.log(`Count–Min Sketch 后端已启动`);
    console.log(`  监听:   http://127.0.0.1:${port}`);
    console.log(`  数据目录: ${DATA_DIR}`);
    console.log(`  请求上限: ${LIMITS.maxJsonBodyBytes} 字节 / 批次 ${LIMITS.maxBatchEntries} 条`);
  });
}

const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invokedPath.endsWith("/dist/server.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
