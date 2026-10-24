// Cloudflare Worker 入口（雲端測試版）。
// 綁定：DB（D1）、ASSETS（ui/ 靜態檔）；密鑰：QBANK_AUTH＝「帳號:密碼」。
// 未設定 QBANK_AUTH 時整站回 503（fail closed），避免原題外洩。
import { D1Adapter } from './lib/dbx.js';
import { handleApi, checkBasicAuth } from './lib/api.js';

const adapters = new WeakMap();
function dbFor(env) {
  let a = adapters.get(env.DB);
  if (!a) { a = new D1Adapter(env.DB); adapters.set(env.DB, a); }
  return a;
}

const SECURITY_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

export default {
  async fetch(request, env) {
    const denied = checkBasicAuth(request.headers.get('Authorization'), env.QBANK_AUTH || '');
    if (denied) return new Response(denied.body, { status: denied.status, headers: { ...denied.headers, ...SECURITY_HEADERS } });
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
      if (!env.ASSETS) return new Response('缺少 ASSETS 綁定', { status: 500 });
      const res = await env.ASSETS.fetch(request);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }
    if (!env.DB) return new Response(JSON.stringify({ error: '缺少 D1 綁定 DB' }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    const db = dbFor(env);
    await db.ensureSchema();
    let bodyText = '';
    if (request.method === 'POST' || request.method === 'PUT') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > 50 * 1024 * 1024) return new Response('請求過大', { status: 413 });
      bodyText = await request.text();
    }
    const r = await handleApi(db, { method: request.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams.entries()), bodyText, dbLabel: 'Cloudflare D1：' + (env.QBANK_DB_LABEL || 'qbank') });
    return new Response(r.body, { status: r.status, headers: { ...r.headers, ...SECURITY_HEADERS } });
  },
};
