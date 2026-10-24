'use strict';
const { loadVocab } = require('./vocab');
const { nowIso } = require('./util');

// 分析欄位中英對照（中文名稱固定，英文 key 為儲存格式）
const FIELD_LABELS = {
  question_id: '題目 ID', question_version: '題目版本', suggested_grades: '建議年級', grade_reason: '年級判斷理由',
  curriculum_codes: '課綱代碼', units: '對應單元', skills: '數學技能', core_concept: '題目核心概念', conditions: '題目條件分析',
  reasoning_process: '推理歷程', strategies: '解題策略', misconceptions: '迷思概念', teacher_probes: '教師追問',
  answer_status: '答案與詳解狀態', completeness: '題目完整性', rationale: '分類依據',
};
const ANSWER_STATUS = ['has', 'missing', 'needs_check', 'verified'];
const ANSWER_STATUS_LABEL = { has: '已有', missing: '缺少', needs_check: '待驗算', verified: '已驗證' };
const COMPLETENESS = ['complete', 'missing_figure', 'missing_condition', 'doubtful'];
const COMPLETENESS_LABEL = { complete: '完整', missing_figure: '缺圖', missing_condition: '缺條件', doubtful: '疑義' };
const PENDING_CODE = '待確認';

function isNonEmptyString(s) { return typeof s === 'string' && s.trim().length > 0; }
function asArray(x) { return Array.isArray(x) ? x : (x === undefined || x === null || x === '' ? [] : [x]); }

// 驗證單筆 AI／人工分析結果。回傳 { ok, errors, warnings, normalized, suggestions }
// errors → 拒絕匯入；warnings → 接受但標示。
async function validateAnalysis(db, item, v = loadVocab()) {
  const errors = [];
  const warnings = [];
  const suggestions = [];
  if (!item || typeof item !== 'object') return { ok: false, errors: ['項目不是 JSON 物件'], warnings, suggestions };

  const qid = String(item.question_id || '').trim();
  if (!qid) errors.push('缺少 question_id');
  const q = qid ? await db.get('SELECT id, current_version, source_grade FROM questions WHERE id = ?', qid) : null;
  if (qid && !q) errors.push(`question_id ${qid} 不存在於工作資料庫`);
  const qv = Number(item.question_version);
  if (q) {
    if (!Number.isInteger(qv)) errors.push('缺少或非整數的 question_version');
    else if (qv !== q.current_version) errors.push(`question_version ${qv} 與目前版本 ${q.current_version} 不符（題目可能已更新，請重新產生指令）`);
  }

  const grades = asArray(item.suggested_grades).map(g => { const s = String(g).trim(); return v.gradeCodes.has(s) ? s : (v.gradeLabelToCode.get(s) || s); });
  const badGrades = grades.filter(g => !v.gradeCodes.has(g));
  if (badGrades.length) errors.push('建議年級只能是 G1–G6 或一年級～六年級：' + badGrades.join('、'));
  if (!grades.length) warnings.push('沒有建議年級');
  if (grades.length && !isNonEmptyString(item.grade_reason)) errors.push('有建議年級就必須填年級判斷理由');

  const codes = [];
  for (const c of asArray(item.curriculum_codes)) {
    const obj = typeof c === 'string' ? { code: c } : (c || {});
    const code = String(obj.code || '').trim();
    if (code === PENDING_CODE) { codes.push({ code: PENDING_CODE, reason: obj.reason || '' }); continue; }
    if (!v.codeMap.has(code)) { errors.push(`課綱代碼「${code}」不在教育部國小學習內容代碼表，不可捏造；不確定請填「${PENDING_CODE}」`); continue; }
    if (!isNonEmptyString(obj.reason)) warnings.push(`課綱代碼 ${code} 沒有對應理由`);
    codes.push({ code, reason: obj.reason || '', title: v.codeMap.get(code).title });
  }
  if (!codes.length) warnings.push('沒有課綱代碼');

  const units = [];
  for (const u of asArray(item.units)) {
    const s = String(u).trim();
    const code = v.unitCodes.has(s) ? s : v.unitLabelToCode.get(s);
    if (!code) { warnings.push(`單元「${s}」不在單元草案，記入詞彙建議`); suggestions.push({ kind: 'unit', term: s }); continue; }
    if (v.unitCodes.get(code).draft) warnings.push(`單元 ${code} 為草案單元（待裁定）`);
    units.push(code);
  }

  const skills = [];
  for (const s0 of asArray(item.skills)) {
    const s = String(s0).trim();
    if (!s) continue;
    if (v.activityTypes.has(s)) { errors.push(`「${s}」是活動類型，不是數學技能，不得放入數學技能欄`); continue; }
    if (v.approvedSkills.has(s)) { skills.push({ term: s, status: 'approved' }); continue; }
    const st = v.draftSkills.has(s) ? 'draft' : 'new';
    skills.push({ term: s, status: st });
    suggestions.push({ kind: 'skill', term: s });
    warnings.push(`數學技能「${s}」${st === 'draft' ? '為草案詞彙' : '不在共用詞庫'}，已記入詞彙建議，不視為正式標籤`);
  }

  const misconceptions = [];
  asArray(item.misconceptions).forEach((m, i) => {
    if (!m || typeof m !== 'object') { errors.push(`迷思概念第 ${i + 1} 項不是物件`); return; }
    const need = ['description', 'wrong_path', 'correct_concept', 'teacher_probe'];
    const miss = need.filter(k => !isNonEmptyString(m[k]));
    if (miss.length) errors.push(`迷思概念第 ${i + 1} 項缺少：${miss.join('、')}（需含描述、錯誤思路、正確概念、教師追問）`);
    misconceptions.push({ description: m.description, wrong_path: m.wrong_path, correct_concept: m.correct_concept, teacher_probe: m.teacher_probe, evidence: m.evidence === 'observed' ? 'observed' : 'predicted' });
  });
  if (misconceptions.some(m => m.evidence === 'observed')) warnings.push('有迷思概念標示為「已觀察」，請教師確認確有學生作答證據');

  const answer_status = item.answer_status ? String(item.answer_status) : 'needs_check';
  if (!ANSWER_STATUS.includes(answer_status)) errors.push(`answer_status 必須是 ${ANSWER_STATUS.join('/')}`);
  if (answer_status === 'verified') errors.push('AI 不得自行把答案標成「已驗證」（verified）；請用 has 或 needs_check，由驗算與教師確認改為已驗證');
  const completeness = item.completeness ? String(item.completeness) : 'complete';
  if (!COMPLETENESS.includes(completeness)) errors.push(`completeness 必須是 ${COMPLETENESS.join('/')}`);

  const cond = item.conditions && typeof item.conditions === 'object' ? item.conditions : {};
  const conditions = { known: asArray(cond.known).map(String), unknown: asArray(cond.unknown).map(String), constraints: asArray(cond.constraints).map(String) };
  if (!conditions.known.length) warnings.push('條件分析沒有已知條件');

  const strategies = asArray(item.strategies).map(s => typeof s === 'string' ? { name: s, reason: '' } : { name: String(s.name || ''), reason: String(s.reason || '') }).filter(s => s.name);
  const normalized = {
    question_id: qid, question_version: qv,
    suggested_grades: grades, grade_reason: String(item.grade_reason || ''),
    curriculum_codes: codes, units, skills,
    core_concept: String(item.core_concept || ''),
    conditions,
    reasoning_process: asArray(item.reasoning_process).map(String),
    strategies, misconceptions,
    teacher_probes: asArray(item.teacher_probes).map(String),
    answer_status, completeness,
    rationale: String(item.rationale || ''),
  };
  if (!isNonEmptyString(normalized.core_concept)) warnings.push('沒有題目核心概念');
  return { ok: errors.length === 0, errors, warnings, suggestions, normalized };
}

async function recordSuggestions(db, suggestions, context) {
  for (const s of suggestions) await db.run("INSERT OR IGNORE INTO vocab_suggestions (kind, term, context, status, created_at) VALUES (?, ?, ?, 'suggested', ?)", s.kind, s.term, context, nowIso());
}

// 儲存分析（待審核）。既有已確認結果不會被覆蓋：新分析只是另一個版本。
async function saveAnalysis(db, normalized, { source = 'ai', createdBy = null, validation = null, rubricVersion } = {}) {
  const v = loadVocab();
  return db.tx(async () => {
    const no = (await db.get('SELECT COALESCE(MAX(analysis_no), 0) + 1 AS n FROM analyses WHERE question_id = ?', normalized.question_id)).n;
    await db.run("UPDATE analyses SET review_status = 'superseded' WHERE question_id = ? AND review_status = 'pending'", normalized.question_id);
    const r = await db.run(`INSERT INTO analyses (question_id, question_version, analysis_no, source, rubric_version, payload_json, validation_json, review_status, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      normalized.question_id, normalized.question_version, no, source, rubricVersion || v.rubricVersion, JSON.stringify(normalized), validation ? JSON.stringify(validation) : null, nowIso(), createdBy);
    return { analysisId: r.lastInsertRowid, analysisNo: no };
  });
}

function parseResults(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (e) { return { fatal: 'JSON 無法解析：' + e.message }; }
  if (Array.isArray(data)) return { items: data };
  if (data && Array.isArray(data.results)) return { items: data.results };
  if (data && Array.isArray(data.items)) return { items: data.items };
  if (data && data.question_id) return { items: [data] };
  return { fatal: 'JSON 結構錯誤：需要陣列或含 results 陣列的物件' };
}

// 批次匯入 AI 結果：局部失敗保留正確結果
async function importAiResults(db, text, { jobId = null, createdBy = 'ai' } = {}) {
  const parsed = parseResults(text);
  if (parsed.fatal) return { ok: false, fatal: parsed.fatal, accepted: [], rejected: [] };
  const accepted = [];
  const rejected = [];
  const v = loadVocab();
  for (let idx = 0; idx < parsed.items.length; idx++) {
    const item = parsed.items[idx];
    const r = await validateAnalysis(db, item, v);
    if (!r.ok) { rejected.push({ index: idx, question_id: item && item.question_id, errors: r.errors, warnings: r.warnings }); continue; }
    const saved = await saveAnalysis(db, r.normalized, { source: 'ai', createdBy, validation: { warnings: r.warnings }, rubricVersion: v.rubricVersion });
    await recordSuggestions(db, r.suggestions, `analysis#${saved.analysisId} ${r.normalized.question_id}`);
    accepted.push({ index: idx, question_id: r.normalized.question_id, analysisId: saved.analysisId, warnings: r.warnings });
  }
  if (jobId) {
    const status = rejected.length === 0 ? 'imported' : (accepted.length ? 'partial' : 'open');
    await db.run('UPDATE ai_jobs SET status = ?, result_json = ? WHERE id = ?', status, JSON.stringify({ accepted: accepted.length, rejected: rejected.length, at: nowIso() }), jobId);
  }
  return { ok: rejected.length === 0, accepted, rejected };
}

function decorateAnalysis(a) {
  const payload = JSON.parse(a.payload_json);
  const validation = a.validation_json ? JSON.parse(a.validation_json) : null;
  const v = loadVocab();
  return { ...a, payload, validation, stale: a.question_version !== a.q_current_version, rubric_outdated: a.rubric_version !== v.rubricVersion };
}

async function listAnalyses(db, qid) {
  const rows = await db.all('SELECT a.*, q.current_version AS q_current_version FROM analyses a JOIN questions q ON q.id = a.question_id WHERE a.question_id = ? ORDER BY a.analysis_no DESC', qid);
  return rows.map(decorateAnalysis);
}

async function getAnalysis(db, id) {
  const a = await db.get('SELECT a.*, q.current_version AS q_current_version FROM analyses a JOIN questions q ON q.id = a.question_id WHERE a.id = ?', id);
  return a ? decorateAnalysis(a) : null;
}

module.exports = { FIELD_LABELS, ANSWER_STATUS, ANSWER_STATUS_LABEL, COMPLETENESS, COMPLETENESS_LABEL, PENDING_CODE, validateAnalysis, saveAnalysis, importAiResults, listAnalyses, getAnalysis, recordSuggestions, parseResults };
