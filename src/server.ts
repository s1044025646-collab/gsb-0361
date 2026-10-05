import http from 'node:http';
import path from 'node:path';
import { Store, MAX_BODY_BYTES, MAX_BATCH_ITEMS } from './store.js';
import { CmsError } from './sketch.js';

const DATA_DIR = process.env.CMS_DATA_DIR ?? path.join(process.cwd(), 'data');

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof CmsError) {
    const status =
      err.code === 'NOT_FOUND' ? 404 : err.code === 'LIMIT_EXCEEDED' ? 413 : 400;
    send(res, status, { error: { code: err.code, message: err.message } });
  } else {
    send(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new CmsError('LIMIT_EXCEEDED', `request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new CmsError('INVALID_JSON', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await readBody(req) : {};
      const b = body as Record<string, unknown>;

      if (method === 'GET' && parts.length === 0) {
        return send(res, 200, {
          service: 'count-min-sketch',
          limits: { maxBodyBytes: MAX_BODY_BYTES, maxBatchItems: MAX_BATCH_ITEMS },
        });
      }
      if (parts[0] === 'sketches' && parts.length === 1 && method === 'GET') {
        return send(res, 200, { sketches: store.list() });
      }
      if (parts[0] === 'sketches' && parts.length === 1 && method === 'POST') {
        return send(res, 201, store.create({
          width: Number(b.width),
          depth: Number(b.depth),
          seed: b.seed === undefined ? 0 : Number(b.seed),
        }));
      }
      if (parts[0] === 'import' && method === 'POST') {
        return send(res, 201, store.importState(b));
      }
      if (parts[0] === 'sketches' && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new CmsError('INVALID_PARAM', 'invalid sketch id');
        const action = parts[2];
        if (!action && method === 'GET') return send(res, 200, store.getMeta(id));
        if (action === 'add' && method === 'POST') {
          const items = Array.isArray(b.items) ? b.items : [{ key: b.key, weight: b.weight }];
          return send(res, 200, store.addBatch(id, items as { key: unknown; weight: unknown }[]));
        }
        if (action === 'query' && method === 'GET') {
          return send(res, 200, store.query(id, url.searchParams.get('key') ?? ''));
        }
        if (action === 'query' && method === 'POST') {
          const keys = b.keys;
          if (!Array.isArray(keys) || keys.length > MAX_BATCH_ITEMS) {
            throw new CmsError('INVALID_PARAM', `keys must be an array of at most ${MAX_BATCH_ITEMS}`);
          }
          return send(res, 200, { results: keys.map((k) => store.query(id, k)) });
        }
        if (action === 'explain' && method === 'GET') {
          return send(res, 200, store.explain(id, url.searchParams.get('key') ?? ''));
        }
        if (action === 'cells' && method === 'GET') {
          return send(res, 200, store.cells(
            id,
            Number(url.searchParams.get('row') ?? 0),
            Number(url.searchParams.get('offset') ?? 0),
            Number(url.searchParams.get('limit') ?? 64),
          ));
        }
        if (action === 'merge' && method === 'POST') {
          return send(res, 201, store.merge(id, Number(b.otherId)));
        }
        if (action === 'export' && method === 'GET') {
          return send(res, 200, store.exportState(id));
        }
        if (action === 'history' && method === 'GET') {
          return send(res, 200, { ops: store.history(id, Number(url.searchParams.get('limit') ?? 50)) });
        }
      }
      throw new CmsError('NOT_FOUND', `no route for ${method} ${url.pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const store = new Store(DATA_DIR);
  const portArg = process.argv.indexOf('--port');
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 0);
  const server = createServer(store);
  server.listen(port, () => {
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`Count-Min Sketch API listening on http://127.0.0.1:${actual} (data dir: ${DATA_DIR})`);
  });
}
