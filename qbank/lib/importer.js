'use strict';
const { parseCsv, rowsToObjects } = require('./csv');
const { ORIGINAL_COLUMNS, identityKey, questionId, contentFingerprint, normalize } = require('./ids');
const { nowIso } = require('./util');

const REQUIRED = ['題庫來源', '套別', '題號', '題目'];

// 解答／詳解已在第一次匯入時以附加欄寫入；後續若只補其他附加欄，不得改這兩欄。
const PROTECTED_EXTRAS = new Set(['解答', '詳解']);

function incomingExtras(v) {
  const out = {};
  for (const c of Object.keys(v)) {
    if (!ORIGINAL_COLUMNS.includes(c)) out[c] = v[c] == null ? '' : v[c];
  }
  return out;
}

function normalizeExtra(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n');
}

// 比對既有 raw_json 與本次附加欄。只報告「新增值或改到非保護欄」；保護欄若不同則列入衝突。
// 既有 raw 裡有、本次沒帶的附加欄一律保留。
function diffExtras(existingRaw, incoming) {
  const updates = [];
  const conflicts = [];
  for (const [name, neu] of Object.entries(incoming)) {
    const old = existingRaw['_extra:' + name] ?? existingRaw[name] ?? '';
    if (normalizeExtra(old) === normalizeExtra(neu)) continue;
    if (PROTECTED_EXTRAS.has(name)) {
      // 本次沒帶值：維持既有，不當衝突。既有為空才允許第一次寫入解答／詳解；已有內容不得改。
      if (!normalizeExtra(neu)) continue;
      if (!normalizeExtra(old)) updates.push(name);
      else conflicts.push(name);
    } else updates.push(name);
  }
  return { updates, conflicts };
}

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

// 預覽：不寫入，回報每列會發生什麼（新增／新版本／附加欄更新／不變／拒絕）
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
    let extraUpdates = [];
    if (problems.length) action = 'reject';
    else {
      existing = await db.get('SELECT id, current_version, fingerprint FROM questions WHERE identity_key = ?', key);
      if (existing) {
        if (existing.fingerprint !== contentFingerprint(v)) {
          action = 'new_version';
        } else {
          const ver = await db.get('SELECT raw_json FROM question_versions WHERE question_id = ? AND version = ?', existing.id, existing.current_version);
          const raw = ver && ver.raw_json ? JSON.parse(ver.raw_json) : {};
          const { updates, conflicts } = diffExtras(raw, incomingExtras(v));
          if (conflicts.length) {
            action = 'reject';
            problems.push('附加欄將更動既有「' + conflicts.join('、') + '」，已拒絕（題幹未變時不得改解答／詳解）');
          } else if (updates.length) {
            action = 'extra_update';
            extraUpdates = updates;
          } else {
            action = 'unchanged';
          }
        }
      }
    }
    items.push({
      rowNumber: rec.rowNumber, action, problems,
      questionId: problems.length ? null : questionId(v),
      identityKey: key,
      existingVersion: existing ? existing.current_version : null,
      extraFields: extraUpdates,
      flags: rowFlags(v),
      preview: { 題庫來源: v['題庫來源'], 套別: v['套別'], 題號: v['題號'], 主題: v['主題'], 題目摘要: normalize(v['題目']).slice(0, 40) },
    });
  }
  const summary = { total: items.length };
  for (const a of ['insert', 'new_version', 'extra_update', 'unchanged', 'reject']) summary[a] = items.filter(i => i.action === a).length;
  return { columns: cols, summary, items };
}

// 正式匯入：原始欄位全部保留在 raw_json；同題重複匯入不建新題；內容變動才建新版本。
// 題幹指紋不變、只多了附加欄時，更新目前版本的 raw_json，不升版本。
async function commitImport(db, source, sourceFile, opts = {}) {
  const preview = await previewImport(db, source);
  if (preview.columns.requiredMissing.length && !opts.force) {
    throw new Error('缺少必填欄位：' + preview.columns.requiredMissing.join('、'));
  }
  const ts = nowIso();
  const batch = await db.run('INSERT INTO import_batches (source_file, started_at, total_rows) VALUES (?, ?, ?)', sourceFile, ts, source.records.length);
  const batchId = batch.lastInsertRowid;
  const byRow = new Map(source.records.map(r => [r.rowNumber, r.values]));
  const result = { batchId, inserted: 0, newVersions: 0, extraUpdated: 0, unchanged: 0, rejected: 0, rejectedRows: [], newVersionIds: [], extraUpdatedIds: [] };
  await db.tx(async () => {
    for (const it of preview.items) {
      const v = byRow.get(it.rowNumber);
      if (it.action === 'reject') { result.rejected++; result.rejectedRows.push({ rowNumber: it.rowNumber, problems: it.problems }); continue; }
      if (it.action === 'unchanged') { result.unchanged++; continue; }
      if (it.action === 'extra_update') {
        const ver = await db.get('SELECT raw_json FROM question_versions WHERE question_id = ? AND version = ?', it.questionId, it.existingVersion);
        const raw = ver && ver.raw_json ? JSON.parse(ver.raw_json) : {};
        const incoming = incomingExtras(v);
        const { updates, conflicts } = diffExtras(raw, incoming);
        if (conflicts.length) {
          result.rejected++;
          result.rejectedRows.push({ rowNumber: it.rowNumber, problems: ['附加欄將更動既有「' + conflicts.join('、') + '」'] });
          continue;
        }
        for (const name of updates) raw['_extra:' + name] = incoming[name];
        await db.run('UPDATE question_versions SET raw_json = ? WHERE question_id = ? AND version = ?', JSON.stringify(raw), it.questionId, it.existingVersion);
        await db.run('UPDATE questions SET updated_at = ? WHERE id = ?', ts, it.questionId);
        result.extraUpdated++;
        result.extraUpdatedIds.push(it.questionId);
        continue;
      }
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
      nowIso(), result.inserted, result.newVersions, result.unchanged, result.rejected, JSON.stringify({ columns: preview.columns, rejectedRows: result.rejectedRows, extraUpdated: result.extraUpdated, extraUpdatedIds: result.extraUpdatedIds }), batchId);
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

module.exports = { readSourceFile, sourceFromRecords, detectColumns, previewImport, commitImport, rowFlags, getQuestion, REQUIRED, incomingExtras, diffExtras, PROTECTED_EXTRAS };
