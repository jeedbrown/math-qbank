'use strict';
// RFC 4180 風格 CSV 解析／輸出：支援引號內換行、雙引號跳脫、UTF-8 BOM。
// 不使用任何外部套件。

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (inQuotes) throw new Error('CSV 格式錯誤：引號未關閉');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  // 去掉完全空白的尾列
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function rowsToObjects(rows) {
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map(h => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    const o = {};
    header.forEach((h, j) => { o[h] = r[j] === undefined ? '' : r[j]; });
    return { rowNumber: idx + 2, cellCount: r.length, values: o };
  });
  return { header, records };
}

module.exports = { parseCsv, toCsv, csvEscape, rowsToObjects };
