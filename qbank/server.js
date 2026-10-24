#!/usr/bin/env node
'use strict';
// 本機測試介面伺服器：只綁 127.0.0.1，不對外、不部署、不連任何 API。
// 若設定環境變數 QBANK_AUTH=帳號:密碼，則本機也要求登入（與雲端版相同行為）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./lib/db');
const { handleApi, checkBasicAuth } = require('./lib/api');

const PORT = Number(process.env.QBANK_PORT || 8787);
const HOST = '127.0.0.1';
const DB_PATH = process.env.QBANK_DB || path.join(__dirname, 'data', 'qbank.sqlite');
const UI_DIR = path.join(__dirname, 'ui');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 50 * 1024 * 1024) { reject(new Error('請求過大')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createHandler(db, { auth = process.env.QBANK_AUTH || '' } = {}) {
  return async function handler(req, res) {
    if (auth) {
      const denied = checkBasicAuth(req.headers.authorization, auth);
      if (denied) { res.writeHead(denied.status, denied.headers); return res.end(denied.body); }
    }
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
      const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
      const full = path.normalize(path.join(UI_DIR, file));
      if (!full.startsWith(UI_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到'); }
      const type = full.endsWith('.html') ? 'text/html; charset=utf-8' : full.endsWith('.js') ? 'text/javascript; charset=utf-8' : full.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(full));
    }
    let bodyText = '';
    try { bodyText = await readBody(req); } catch (e) { res.writeHead(413); return res.end(e.message); }
    const r = await handleApi(db, { method: req.method, pathname: p, query: Object.fromEntries(url.searchParams.entries()), bodyText, dbLabel: DB_PATH });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  };
}

function start(dbPath = DB_PATH, port = PORT, opts = {}) {
  const db = openDb(dbPath);
  const server = http.createServer(createHandler(db, opts));
  return new Promise(resolve => server.listen(port, HOST, () => resolve({ server, db, url: `http://${HOST}:${server.address().port}/` })));
}

if (require.main === module) {
  start().then(({ url }) => {
    process.stdout.write(`題庫分析模組 測試介面已啟動：${url}\n資料庫：${DB_PATH}\n${process.env.QBANK_AUTH ? '已啟用登入保護（QBANK_AUTH）\n' : ''}（只在本機 127.0.0.1 提供，Ctrl+C 結束）\n`);
  });
}

module.exports = { start, createHandler };
