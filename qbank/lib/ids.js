'use strict';
const crypto = require('node:crypto');

// 原始題庫 21 欄（正式欄名，順序即匯出順序）
const ORIGINAL_COLUMNS = [
  '題庫來源', '年級', '套別', '週次', '題號', '對應課程', '主題', '題目',
  '類題一', '類題一答案', '類題二', '類題二答案',
  '影片來源', '影片1', '影片2', '影片3', '影片4', '影片5',
  '題目PDF', 'PDF頁碼', '備註',
];

// 題目身分鍵：來源題庫 + 套別 + 題號。
// 盤點結果：437 題中此三欄組合唯一；列號、週次不參與身分，避免排序或插列造成 ID 變動。
function normalize(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[　\s]+/g, ' ').trim();
}

function identityKey(rec) {
  return [normalize(rec['題庫來源']), normalize(rec['套別']), normalize(rec['題號'])].join('|');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function questionId(rec) {
  return 'Q' + sha256('qbank-identity|' + identityKey(rec)).slice(0, 12).toUpperCase();
}

// 內容指紋：題目正文及類題與答案。影片／PDF 連結等不影響題目內容，不納入。
const CONTENT_COLUMNS = ['題目', '類題一', '類題一答案', '類題二', '類題二答案', '主題', '對應課程', '年級', '週次', '備註'];
function contentFingerprint(rec) {
  return sha256(CONTENT_COLUMNS.map(c => normalize(rec[c])).join('\u001f'));
}

module.exports = { ORIGINAL_COLUMNS, CONTENT_COLUMNS, identityKey, questionId, contentFingerprint, normalize, sha256 };
