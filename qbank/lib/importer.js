'use strict';
const { parseCsv, rowsToObjects } = require('./csv');
const { ORIGINAL_COLUMNS, identityKey, questionId, contentFingerprint, normalize } = require('./ids');
const { nowIso } = require('./util');

const REQUIRED = ['題庫來源', '套別', '題號', '題目'];

// 讀取 CSV 或 JSON（陣列物件）為原始列（只在 Node 端使用）
function readSourceFile(filePath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') return sourceFromRecords(JSON.parse(text));
  return rowsToObjects(parseCsv(text));
}

function sourceFromRecords(data) {
  if (!Array.isArray(data)) throw new Error('JSON 來源必須是物件陣列');
  const header = Object.keys(data[0] || {});
  return { header, records: data.map((v, i) => ({ rowNumber: i + 1, cellCount: Object.keys(v).length, values: v })) };
}

// 欄位偵測：比對 21 欄正式欄名，回報缺少／多出／順序差異
function detectColumns(header) {
  const missing = ORIGINAL_COLUMNS.filter(c => !header.includes(c));
  const extra = header.filter(c => !ORIGINAL_COLUMNS.includes(c));
  const sameOrder = header.length === ORIGINAL_COLUMNS.length && header.every((h, i) => h === ORIGINAL_COLUMNS[i]);
  return { header, missing, extra, sameOrder, requiredMissing: REQUIRED.filter(c => !header.includes(c)) };
}

// 單列品質旗標（不是分類，只是提醒）
function rowFlags(v) {
  const flags = [];
  if (!normalize(v['類題一答案'])) flags.push({ flag: 'missing_answer_1', detail: '類題一答案為空' });
  if (!normalize(v['類題二答案'])) flags.push({ flag: 'missing_answer_2', detail: '類題二答案為空' });
  if (!normalize(v['類題一'])) flags.push({ flag: 'missing_variant_1', detail: '類題一為空' });
  if (!normalize(v['類題二'])) flags.push({ flag: 'missing_variant_2', detail: '類題二為空' });
  const note = normalize(v['備註']);
  if (/含圖|看 ?PDF|圖或表|上劃線|線段符號/.test(note)) flags.push({ flag: 'figure_dependent', detail: '備註指出題目含圖表或符號需看 PDF：' + note });
  if (/如圖|下圖|右圖|左圖|圖中|附圖/.test(normalize(v['題目'])) && !flags.some(f => f.flag === 'figure_dependent')) flags.push({ flag: 'figure_dependent', detail: '題目文字提到圖，但無備註說明' });
  if (!normalize(v['題目PDF'])) flags.push({ flag: 'missing_pdf', detail: '題目PDF 欄為空' });
  if (!normalize(v['影片1'])) flags.push({ flag: 'missing_video', detail: '影片1 欄為空' });
  if (!normalize(v['年級'])) flags.push({ flag: 'missing_grade', detail: '年級欄為空' });
  return flags;
}

// 預覽：不寫入，回報每列會發生什麼（新增／新版本／不變／拒絕）
async function previewImport(db, source) {
  const { header, records } = source;
  const cols = detectColumns(header);
  const items = [];
  const seenKeys = new Map();
  for (const rec of records) {
    const v = rec.values;
    const problems = [];
    if (rec.cellCount !== header.length) problems.push(`欄數 ${rec.cellCount} 與標題列 ${header.length} 不符`);
    for (const c of REQUIRED) if (!normalize(v[c])) problems.push(`必填欄位「${c}」為空`);
    const key = identityKey(v);
    if (seenKeys.has(key)) problems.push(`與第 ${seenKeys.get(key)} 列身分鍵重複（來源+套別+題號）`);
    else seenKeys.set(key, rec.rowNumber);
    let action = 'insert';
    let existing = null;
    if (problems.length) action = 'reject';
    else {
      existing = await db.get('SELECT id, current_version, fingerprint FROM questions WHERE identity_key = ?', key);
      if (existing) action = existing.fingerprint === contentFingerprint(v) ? 'unchanged' : 'new_version';
    }
    items.push({
      rowNumber: rec.rowNumber, action, problems,
      questionId: problems.length ? null : questionId(v),
      identityKey: key,
      existingVersion: existing ? existing.current_version : null,
      flags: rowFlags(v),
      preview: { 題庫來源: v['題庫來源'], 套別: v['套別'], 題號: v['題號'], 主題: v['主題'], 題目摘要: normalize(v['題目']).slice(0, 40) },
    });
  }
  const summary = { total: items.length };
  for (const a of ['insert', 'new_version', 'unchanged', 'reject']) summary[a] = items.filter(i => i.action === a).length;
  return { columns: cols, summary, items };
}

// 正式匯入：原始欄位全部保留在 raw_json；同題重複匯入不建新題；內容變動才建新版本。
async function commitImport(db, source, sourceFile, opts = {}) {
  const preview = await previewImport(db, source);
  if (preview.columns.requiredMissing.length && !opts.force) {
    throw new Error('缺少必填欄位：' + preview.columns.requiredMissing.join('、'));
  }
  const ts = nowIso();
  const batch = await db.run('INSERT INTO import_batches (source_file, started_at, total_rows) VALUES (?, ?, ?)', sourceFile, ts, source.records.length);
  const batchId = batch.lastInsertRowid;
  const byRow = new Map(source.records.map(r => [r.rowNumber, r.values]));
  const result = { batchId, inserted: 0, newVersions: 0, unchanged: 0, rejected: 0, rejectedRows: [], newVersionIds: [] };
  await db.tx(async () => {
    for (const it of preview.items) {
      const v = byRow.get(it.rowNumber);
      if (it.action === 'reject') { result.rejected++; result.rejectedRows.push({ rowNumber: it.rowNumber, problems: it.problems }); continue; }
      if (it.action === 'unchanged') { result.unchanged++; continue; }
      const raw = {};
      for (const c of ORIGINAL_COLUMNS) raw[c] = v[c] === undefined ? '' : v[c];
      for (const c of Object.keys(v)) if (!(c in raw)) raw['_extra:' + c] = v[c];
      const fp = contentFingerprint(v);
      let version = 1;
      if (it.action === 'insert') {
        await db.run(`INSERT INTO questions (id, identity_key, source_bank, set_name, item_no, week, source_grade, topic, course_ref, current_version, fingerprint, source_file, source_row, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          it.questionId, it.identityKey, v['題庫來源'], v['套別'], v['題號'], v['週次'] ?? '', v['年級'] ?? '', v['主題'] ?? '', v['對應課程'] ?? '', fp, sourceFile, it.rowNumber, ts, ts);
        result.inserted++;
      } else {
        version = it.existingVersion + 1;
        await db.run(`UPDATE questions SET current_version = ?, fingerprint = ?, week = ?, source_grade = ?, topic = ?, course_ref = ?, source_file = ?, source_row = ?, updated_at = ? WHERE id = ?`,
          version, fp, v['週次'] ?? '', v['年級'] ?? '', v['主題'] ?? '', v['對應課程'] ?? '', sourceFile, it.rowNumber, ts, it.questionId);
        result.newVersions++; result.newVersionIds.push(it.questionId);
      }
      await db.run('INSERT INTO question_versions (question_id, version, fingerprint, raw_json, source_file, source_row, batch_id, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        it.questionId, version, fp, JSON.stringify(raw), sourceFile, it.rowNumber, batchId, ts);
      await db.run('DELETE FROM question_flags WHERE question_id = ? AND version = ?', it.questionId, version);
      for (const f of it.flags) await db.run('INSERT OR REPLACE INTO question_flags (question_id, version, flag, detail) VALUES (?, ?, ?, ?)', it.questionId, version, f.flag, f.detail);
    }
    await db.run('UPDATE import_batches SET finished_at = ?, inserted = ?, new_versions = ?, unchanged = ?, rejected = ?, report_json = ? WHERE id = ?',
      nowIso(), result.inserted, result.newVersions, result.unchanged, result.rejected, JSON.stringify({ columns: preview.columns, rejectedRows: result.rejectedRows }), batchId);
  });
  return { preview, result };
}

async function getQuestion(db, id) {
  const q = await db.get('SELECT * FROM questions WHERE id = ?', id);
  if (!q) return null;
  const ver = await db.get('SELECT * FROM question_versions WHERE question_id = ? AND version = ?', id, q.current_version);
  const flags = await db.all('SELECT flag, detail FROM question_flags WHERE question_id = ? AND version = ?', id, q.current_version);
  const versions = await db.all('SELECT version, fingerprint, imported_at, source_file, source_row FROM question_versions WHERE question_id = ? ORDER BY version', id);
  return { ...q, raw: JSON.parse(ver.raw_json), flags, versions };
}

module.exports = { readSourceFile, sourceFromRecords, detectColumns, previewImport, commitImport, rowFlags, getQuestion, REQUIRED };
