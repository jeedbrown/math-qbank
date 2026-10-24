'use strict';
const { nowIso } = require('./util');
const { validateAnalysis, getAnalysis, recordSuggestions } = require('./analysis');

// 教師審核：confirm（接受）、modify（修改後接受）、return（退回）、reopen（重新審核）
async function reviewAnalysis(db, analysisId, action, { reviewer = '教師', reason = '', payload = null } = {}) {
  const a = await getAnalysis(db, analysisId);
  if (!a) throw new Error('分析不存在：' + analysisId);
  if (!['confirm', 'modify', 'return', 'reopen'].includes(action)) throw new Error('未知的審核動作：' + action);
  if (action === 'confirm' && a.stale) throw new Error('此分析對應的題目版本已更新，不能直接確認；請重新分析或改用 modify 並確認內容仍適用');
  let after = a.payload;
  let status;
  if (action === 'confirm') status = 'confirmed';
  else if (action === 'return') { status = 'returned'; if (!reason) throw new Error('退回必須填寫原因'); }
  else if (action === 'reopen') status = 'pending';
  else {
    if (!payload) throw new Error('modify 需要提供修改後的內容');
    const merged = { ...a.payload, ...payload, question_id: a.question_id, question_version: a.q_current_version };
    const r = await validateAnalysis(db, merged);
    if (!r.ok) throw new Error('修改後內容未通過規準檢查：' + r.errors.join('；'));
    after = r.normalized;
    status = 'confirmed';
    await recordSuggestions(db, r.suggestions, `modify analysis#${analysisId}`);
  }
  return db.tx(async () => {
    if (status === 'confirmed') {
      await db.run("UPDATE analyses SET review_status = 'superseded' WHERE question_id = ? AND review_status = 'confirmed' AND id <> ?", a.question_id, analysisId);
    }
    await db.run('UPDATE analyses SET review_status = ?, payload_json = ?, question_version = ? WHERE id = ?',
      status, JSON.stringify(after), action === 'modify' ? a.q_current_version : a.question_version, analysisId);
    await db.run('INSERT INTO review_log (analysis_id, action, reviewer, reason, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      analysisId, action, reviewer, reason, JSON.stringify(a.payload), JSON.stringify(after), nowIso());
    return getAnalysis(db, analysisId);
  });
}

async function reviewQueue(db, status = 'pending') {
  const rows = await db.all(`SELECT a.id, a.question_id, a.question_version, a.analysis_no, a.source, a.review_status, a.created_at, q.current_version, q.source_bank, q.set_name, q.item_no, q.topic, q.source_grade
    FROM analyses a JOIN questions q ON q.id = a.question_id WHERE a.review_status = ? ORDER BY a.created_at DESC`, status);
  return rows.map(r => ({ ...r, stale: r.question_version !== r.current_version }));
}

module.exports = { reviewAnalysis, reviewQueue };
