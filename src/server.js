import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { Router } from './http.js';
import { userFromRequest } from './auth.js';
import { HttpError } from './util.js';
import { seedTemplates } from './templates.js';
import { seedDemoIcdIfEmpty } from './icd.js';
import { seedExampleCheckRules } from './check_rules.js';
import { parseMultipart } from './upload.js';
import { coreRoutes } from './routes/core.js';
import { patientRoutes } from './routes/patients.js';
import { aiRoutes } from './routes/ai.js';
import { chatRoutes } from './routes/chat.js';

export function buildRouter() {
  const r = new Router();
  coreRoutes(r);
  patientRoutes(r);
  aiRoutes(r);
  chatRoutes(r);
  return r;
}

const UPLOAD_PATH = /\/(intake|transcribe|census\/intake)(\/|$)/;

async function readBody(req, { maxBytes } = {}) {
  const limit = maxBytes || config.limits.maxBodyBytes;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'Body must be valid JSON'); }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendRaw(res, status, raw, contentType) {
  const data = typeof raw === 'string' ? raw : String(raw ?? '');
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

export function createApp() {
  openDb(config.dbPath);
  seedTemplates();
  seedDemoIcdIfEmpty();
  seedExampleCheckRules();
  const router = buildRouter();

  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, Last-Event-ID');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store'); // clinical responses must never be cached by intermediaries
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://localhost');
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'not_found', 'Route not found');
      const ctx = { req, res, params: m.params, query: Object.fromEntries(url.searchParams), body: {}, upload: null, user: null };
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const ct = String(req.headers['content-type'] || '');
        if (ct.includes('multipart/form-data')) {
          // Never log multipart fields or file bytes (PHI).
          ctx.upload = await parseMultipart(req);
          ctx.body = { ...(ctx.upload.fields || {}) };
        } else {
          const maxBytes = UPLOAD_PATH.test(url.pathname) ? config.limits.maxUploadBodyBytes : config.limits.maxBodyBytes;
          ctx.body = await readBody(req, { maxBytes });
        }
      }
      if (m.route.opts.auth) ctx.user = userFromRequest(req);
      const out = await m.route.handler(ctx);
      if (out && out.__stream) return; // handler owns the response (SSE)
      if (out && out.__reply) {
        if (out.raw !== undefined) return sendRaw(res, out.status, out.raw, out.contentType);
        return send(res, out.status, out.body);
      }
      return send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra ? { details: e.extra } : {}) } });
      console.error('Unhandled error:', e?.message); // never log request bodies (may contain clinical text)
      return send(res, 500, { error: { code: 'internal', message: 'Something went wrong. Your data was not changed by this request.' } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(config.port, () => console.log(`RoundsAI backend on :${config.port} (AI provider: ${config.provider})`));
}
