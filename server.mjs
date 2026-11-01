import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const { openDb } = await import('./lib/db.mjs');
const { createHandler } = await import('./lib/app.mjs');

const PORT = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_FILE || path.join(root, 'data', 'saksmappen.db'));
db.purgeOrphans();
setInterval(() => db.purgeOrphans(), 3600_000).unref();

const handle = createHandler(db);

// The same handler runs on Netlify. Here it is wrapped for Node's http module.
http
  .createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://x');
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(root, 'public/index.html')));
      }
      if (req.method === 'GET' && pathname === '/eval.json') {
        try { const b = fs.readFileSync(path.join(root, 'public/eval.json')); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(b); } catch { res.writeHead(404); return res.end(); }
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const r = await handle(new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
      }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (!r.body) return res.end();
      Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
    } catch (e) {
      console.error(e.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Noe gikk galt.' }));
    }
  })
  .listen(PORT, () => console.log(`Saksmappen kjører på http://localhost:${PORT}`));
