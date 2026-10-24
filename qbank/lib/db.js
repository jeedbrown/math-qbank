'use strict';
// 本機（Node）資料庫開啟：node:sqlite + 轉接層。Worker 端不載入此檔。
const path = require('node:path');
const fs = require('node:fs');
// node:sqlite 在 Node 22 仍標示實驗性；此處只把該則警告靜音，不影響其他警告。
const origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (String(warning && warning.message || warning).includes('SQLite is an experimental feature')) return;
  return origEmitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
const { SqliteAdapter, SCHEMA } = require('./dbx');

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = new SqliteAdapter(raw);
  for (const s of SCHEMA.split(';').map(x => x.trim()).filter(Boolean)) raw.exec(s);
  const v = raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!v) raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  return db;
}

module.exports = { openDb, SCHEMA };
