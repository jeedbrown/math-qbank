'use strict';
const { toCsv } = require('./csv');
const { ORIGINAL_COLUMNS } = require('./ids');
const { loadVocab } = require('./vocab');
const { FIELD_LABELS, ANSWER_STATUS_LABEL, COMPLETENESS_LABEL, getAnalysis } = require('./analysis');

function joinList(arr, f) { return (arr || []).map(f || (x => x)).join('；'); }

function flattenAnalysisRow(q, a) {
  const p = a.payload;
  const v = loadVocab();
  const gl = c => (v.grades.teaching_grades.find(g => g.code === c) || {}).label || c;
  const ul = c => (v.unitCodes.get(c) || {}).label ? `${c} ${v.unitCodes.get(c).label}` : c;
  return {
    '題目 ID': q.id, '題目版本': a.question_version, '分析序號': a.analysis_no, '分析來源': a.source, '分析版本': a.rubric_version, '審核狀態': a.review_status,
    '題庫來源': q.source_bank, '套別': q.set_name, '題號': q.item_no, '原始年級': q.source_grade, '主題': q.topic,
    '建議年級': joinList(p.suggested_grades, gl), '年級判斷理由': p.grade_reason,
    '課綱代碼': joinList(p.curriculum_codes, c => c.code + (c.title ? ' ' + c.title : '')), '課綱對應理由': joinList(p.curriculum_codes, c => `${c.code}：${c.reason || ''}`),
    '對應單元': joinList(p.units, ul),
    '數學技能（正式）': joinList((p.skills || []).filter(s => s.status === 'approved'), s => s.term),
    '數學技能（建議，未核准）': joinList((p.skills || []).filter(s => s.status !== 'approved'), s => s.term),
    '題目核心概念': p.core_concept,
    '已知條件': joinList(p.conditions && p.conditions.known), '未知': joinList(p.conditions && p.conditions.unknown), '限制條件': joinList(p.conditions && p.conditions.constraints),
    '推理歷程': joinList(p.reasoning_process), '解題策略': joinList(p.strategies, s => s.reason ? `${s.name}（${s.reason}）` : s.name),
    '迷思概念': joinList(p.misconceptions, m => `${m.evidence === 'observed' ? '[已觀察]' : '[預測性]'}${m.description}｜錯誤思路：${m.wrong_path}｜正確概念：${m.correct_concept}｜追問：${m.teacher_probe}`),
    '教師追問': joinList(p.teacher_probes),
    '答案與詳解狀態': ANSWER_STATUS_LABEL[p.answer_status] || p.answer_status, '題目完整性': COMPLETENESS_LABEL[p.completeness] || p.completeness,
    '分類依據': p.rationale, '建立時間': a.created_at,
  };
}

async function exportAnalyses(db, status = 'confirmed') {
  const rows = await db.all('SELECT a.id, a.question_id FROM analyses a WHERE a.review_status = ? ORDER BY a.question_id, a.analysis_no', status);
  const out = [];
  for (const r of rows) {
    const q = await db.get('SELECT * FROM questions WHERE id = ?', r.question_id);
    out.push(flattenAnalysisRow(q, await getAnalysis(db, r.id)));
  }
  return out;
}

async function exportAnomalies(db) {
  const flags = await db.all(`SELECT f.question_id, f.version, f.flag, f.detail, q.source_bank, q.set_name, q.item_no, q.topic
    FROM question_flags f JOIN questions q ON q.id = f.question_id AND q.current_version = f.version ORDER BY f.question_id`);
  const stale = await db.all(`SELECT a.id AS analysis_id, a.question_id, a.question_version, q.current_version, a.review_status FROM analyses a JOIN questions q ON q.id = a.question_id
    WHERE a.question_version <> q.current_version AND a.review_status IN ('pending','confirmed')`);
  const sugg = await db.all("SELECT kind, term, context, status, created_at FROM vocab_suggestions WHERE status = 'suggested' ORDER BY kind, term");
  const failed = await db.all("SELECT id AS variant_id, question_id, kind, variant_no, verify_status FROM variants WHERE verify_status = 'auto_failed'");
  const rows = [];
  for (const f of flags) rows.push({ 類型: '題目品質', 題目ID: f.question_id, 說明: `${f.flag}：${f.detail || ''}`, 補充: `${f.source_bank}／${f.set_name}／${f.item_no}／${f.topic}` });
  for (const s of stale) rows.push({ 類型: '分析可能失效', 題目ID: s.question_id, 說明: `分析 #${s.analysis_id} 對應版本 ${s.question_version}，題目已是版本 ${s.current_version}`, 補充: s.review_status });
  for (const s of sugg) rows.push({ 類型: '詞彙建議（未核准）', 題目ID: '', 說明: `${s.kind}：${s.term}`, 補充: s.context || '' });
  for (const f of failed) rows.push({ 類型: '類題驗算失敗', 題目ID: f.question_id, 說明: `類題 #${f.variant_id}（${f.kind} ${f.variant_no}）`, 補充: f.verify_status });
  return rows;
}

async function exportCourseLinks(db) {
  return db.all('SELECT c.question_id AS "題目 ID", c.project AS "課程企劃", c.lesson AS "堂次／單元", c.position AS "順序", c.note AS "備註", q.source_bank AS "題庫來源", q.set_name AS "套別", q.item_no AS "題號", q.topic AS "主題" FROM course_links c JOIN questions q ON q.id = c.question_id ORDER BY c.project, c.lesson, c.position');
}

async function exportQuestionsOriginal(db) {
  const rows = await db.all('SELECT q.id, q.current_version, v.raw_json FROM questions q JOIN question_versions v ON v.question_id = q.id AND v.version = q.current_version ORDER BY q.source_bank, q.set_name, CAST(q.item_no AS INTEGER), q.item_no');
  return rows.map(r => ({ '題目 ID': r.id, '題目版本': r.current_version, ...JSON.parse(r.raw_json) }));
}

async function fullBackup(db) {
  const tables = ['meta', 'import_batches', 'questions', 'question_versions', 'question_flags', 'analyses', 'review_log', 'vocab_suggestions', 'course_links', 'variants', 'ai_jobs'];
  const out = { exported_at: new Date().toISOString(), rubric_version: loadVocab().rubricVersion, tables: {} };
  for (const t of tables) out.tables[t] = await db.all(`SELECT * FROM ${t}`);
  return out;
}

async function consistencyCheck(db) {
  const problems = [];
  for (const r of await db.all('SELECT q.id FROM questions q LEFT JOIN question_versions v ON v.question_id = q.id AND v.version = q.current_version WHERE v.question_id IS NULL')) problems.push(`題目 ${r.id} 缺少目前版本的原始資料`);
  for (const r of await db.all("SELECT question_id, COUNT(*) c FROM analyses WHERE review_status = 'confirmed' GROUP BY question_id HAVING c > 1")) problems.push(`題目 ${r.question_id} 有 ${r.c} 筆同時為已確認的分析`);
  for (const r of await db.all('SELECT a.id FROM analyses a LEFT JOIN questions q ON q.id = a.question_id WHERE q.id IS NULL')) problems.push(`分析 #${r.id} 指向不存在的題目`);
  for (const r of await db.all('SELECT v.id FROM variants v LEFT JOIN questions q ON q.id = v.question_id WHERE q.id IS NULL')) problems.push(`類題 #${r.id} 指向不存在的題目`);
  for (const r of await db.all('SELECT identity_key, COUNT(*) c FROM questions GROUP BY identity_key HAVING c > 1')) problems.push(`身分鍵重複：${r.identity_key}`);
  return { ok: problems.length === 0, problems };
}

function toCsvText(rows) {
  if (!rows.length) return '﻿';
  const header = Object.keys(rows[0]);
  return toCsv(header, rows);
}

async function exportByName(db, what) {
  if (what === 'confirmed') return exportAnalyses(db, 'confirmed');
  if (what === 'pending') return exportAnalyses(db, 'pending');
  if (what === 'anomalies') return exportAnomalies(db);
  if (what === 'links') return exportCourseLinks(db);
  if (what === 'questions') return exportQuestionsOriginal(db);
  if (what === 'backup') return fullBackup(db);
  throw new Error('未知的匯出類型');
}

module.exports = { exportAnalyses, exportAnomalies, exportCourseLinks, exportQuestionsOriginal, fullBackup, consistencyCheck, toCsvText, flattenAnalysisRow, exportByName, ORIGINAL_COLUMNS, FIELD_LABELS };
