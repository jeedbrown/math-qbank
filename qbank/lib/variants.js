'use strict';
const { nowIso } = require('./util');
const { verifyVariant } = require('./verify');
const { normalize } = require('./ids');
const { parseResults } = require('./analysis');

// 把原始資料中的類題一、類題二登錄成 existing 類題（唯讀鏡像，不覆蓋原題欄位）
async function mirrorExistingVariants(db, question) {
  const ts = nowIso();
  let n = 0;
  const sql = `INSERT OR IGNORE INTO variants (question_id, question_version, kind, variant_no, text, answer, solution_json, verify_status, verify_json, options_json, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, NULL, 'unverified', NULL, NULL, ?, ?)`;
  if (normalize(question.raw['類題一'])) n += (await db.run(sql, question.id, question.current_version, 'existing_1', question.raw['類題一'], question.raw['類題一答案'] || '', ts, ts)).changes;
  if (normalize(question.raw['類題二'])) n += (await db.run(sql, question.id, question.current_version, 'existing_2', question.raw['類題二'], question.raw['類題二答案'] || '', ts, ts)).changes;
  return n;
}

async function mirrorAll(db) {
  const { getQuestion } = require('./importer');
  let n = 0;
  for (const row of await db.all("SELECT q.id FROM questions q WHERE NOT EXISTS (SELECT 1 FROM variants v WHERE v.question_id = q.id AND v.kind IN ('existing_1','existing_2'))")) {
    n += await mirrorExistingVariants(db, await getQuestion(db, row.id));
  }
  return n;
}

async function validateVariantItem(db, item) {
  const errors = [];
  const qid = String(item.question_id || '').trim();
  const q = qid ? await db.get('SELECT id, current_version FROM questions WHERE id = ?', qid) : null;
  if (!qid) errors.push('缺少 question_id');
  else if (!q) errors.push(`question_id ${qid} 不存在`);
  const qv = Number(item.question_version);
  if (q && qv !== q.current_version) errors.push(`question_version ${qv} 與目前版本 ${q.current_version} 不符`);
  const variants = Array.isArray(item.variants) ? item.variants : [];
  if (!variants.length) errors.push('variants 為空');
  let raw = null;
  if (q) raw = JSON.parse((await db.get('SELECT raw_json FROM question_versions WHERE question_id = ? AND version = ?', q.id, q.current_version)).raw_json);
  variants.forEach((vv, i) => {
    if (!vv || typeof vv !== 'object') { errors.push(`類題第 ${i + 1} 筆不是物件`); return; }
    if (!normalize(vv.text)) errors.push(`類題第 ${i + 1} 筆缺少題目文字`);
    if (!normalize(vv.answer)) errors.push(`類題第 ${i + 1} 筆缺少答案`);
    if (!Array.isArray(vv.solution_steps) || !vv.solution_steps.length) errors.push(`類題第 ${i + 1} 筆缺少解題步驟`);
    if (raw) {
      if (normalize(vv.text) === normalize(raw['題目'])) errors.push(`類題第 ${i + 1} 筆與原題文字相同，不是類題`);
      if (normalize(vv.text) === normalize(raw['類題一']) || normalize(vv.text) === normalize(raw['類題二'])) errors.push(`類題第 ${i + 1} 筆與既有類題相同`);
    }
  });
  return { ok: errors.length === 0, errors, q, variants };
}

// 匯入 AI 類題結果：另存為 kind='ai' 新版本，絕不寫回原題或既有類題欄位
async function importVariantResults(db, text, { jobId = null, options = [] } = {}) {
  const parsed = parseResults(text);
  if (parsed.fatal) return { ok: false, fatal: parsed.fatal, accepted: [], rejected: [] };
  const accepted = [];
  const rejected = [];
  for (let idx = 0; idx < parsed.items.length; idx++) {
    const item = parsed.items[idx] || {};
    const r = await validateVariantItem(db, item);
    if (!r.ok) { rejected.push({ index: idx, question_id: item && item.question_id, errors: r.errors }); continue; }
    await db.tx(async () => {
      const nextNo = (await db.get("SELECT COALESCE(MAX(variant_no), 0) AS n FROM variants WHERE question_id = ? AND kind = 'ai'", r.q.id)).n;
      for (let i = 0; i < r.variants.length; i++) {
        const vv = r.variants[i];
        const ver = verifyVariant(vv);
        const ts = nowIso();
        const res = await db.run(`INSERT INTO variants (question_id, question_version, kind, variant_no, text, answer, solution_json, verify_status, verify_json, options_json, created_at, updated_at)
          VALUES (?, ?, 'ai', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r.q.id, r.q.current_version, nextNo + i + 1, vv.text, vv.answer, JSON.stringify({ solution_steps: vv.solution_steps, alt_solutions: vv.alt_solutions || [], verification: vv.verification || '', teaching_tips: vv.teaching_tips || '', check: vv.check || null }), ver.status, JSON.stringify(ver), JSON.stringify(options), ts, ts);
        accepted.push({ index: idx, question_id: r.q.id, variantId: res.lastInsertRowid, verify: ver });
      }
    });
  }
  if (jobId) await db.run('UPDATE ai_jobs SET status = ?, result_json = ? WHERE id = ?', rejected.length ? (accepted.length ? 'partial' : 'open') : 'imported', JSON.stringify({ accepted: accepted.length, rejected: rejected.length, at: nowIso() }), jobId);
  return { ok: rejected.length === 0, accepted, rejected };
}

// 教師核准／退回類題。只有教師可以把狀態改成 teacher_confirmed。
async function reviewVariant(db, variantId, action, { reviewer = '教師', reason = '' } = {}) {
  const v = await db.get('SELECT * FROM variants WHERE id = ?', variantId);
  if (!v) throw new Error('類題不存在：' + variantId);
  if (v.kind.startsWith('existing')) throw new Error('既有類題為原始資料鏡像，不在此處修改');
  let status;
  if (action === 'confirm') status = 'teacher_confirmed';
  else if (action === 'reject') { if (!reason) throw new Error('退回必須填寫原因'); status = 'rejected'; }
  else if (action === 'reopen') status = v.verify_json ? (JSON.parse(v.verify_json).status || 'unverified') : 'unverified';
  else throw new Error('未知動作：' + action);
  const vj = v.verify_json ? JSON.parse(v.verify_json) : {};
  vj.teacher = { action, reviewer, reason, at: nowIso() };
  await db.run('UPDATE variants SET verify_status = ?, verify_json = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(vj), nowIso(), variantId);
  return db.get('SELECT * FROM variants WHERE id = ?', variantId);
}

function decorate(v) { return { ...v, solution: v.solution_json ? JSON.parse(v.solution_json) : null, verify: v.verify_json ? JSON.parse(v.verify_json) : null }; }

async function listVariants(db, qid) {
  return (await db.all('SELECT * FROM variants WHERE question_id = ? ORDER BY kind, variant_no', qid)).map(decorate);
}

async function listAllVariants(db, status) {
  const rows = status
    ? await db.all('SELECT v.*, q.topic, q.set_name, q.item_no FROM variants v JOIN questions q ON q.id = v.question_id WHERE v.verify_status = ? ORDER BY v.id DESC LIMIT 500', status)
    : await db.all("SELECT v.*, q.topic, q.set_name, q.item_no FROM variants v JOIN questions q ON q.id = v.question_id WHERE v.kind = 'ai' ORDER BY v.id DESC LIMIT 500");
  return rows.map(decorate);
}

module.exports = { mirrorExistingVariants, mirrorAll, importVariantResults, reviewVariant, listVariants, listAllVariants, validateVariantItem };
