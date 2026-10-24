'use strict';
// 與執行環境無關的 API 路由：Node 本機伺服器與 Cloudflare Worker 共用。
// handleApi(db, {method, pathname, query, bodyText, dbLabel}) → { status, headers, body }
const importer = require('./importer');
const analysis = require('./analysis');
const prompts = require('./prompts');
const review = require('./review');
const variants = require('./variants');
const exporter = require('./exporter');
const stats = require('./stats');
const { loadVocab } = require('./vocab');
const { parseCsv, rowsToObjects } = require('./csv');
const { nowIso } = require('./util');

function json(status, obj) { return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(obj) }; }

function vocabSummary() {
  const v = loadVocab();
  return { rubricVersion: v.rubricVersion, curriculumCodes: v.curriculum.count, approvedSkills: v.skills.approved.length, draftSkills: v.skills.draft.length, skillsStatus: v.skills.status, units: v.unitCodes.size, unitsStatus: v.units.status };
}

function sourceFromBody(body) {
  if (body.csv) return rowsToObjects(parseCsv(body.csv));
  if (Array.isArray(body.records)) return importer.sourceFromRecords(body.records);
  throw new Error('請提供 csv 文字或 records 陣列');
}

function parseBody(bodyText) { return bodyText ? JSON.parse(bodyText) : {}; }

async function handleApi(db, { method, pathname: p, query: q = {}, bodyText = '', dbLabel = '' }) {
  const m = method;
  try {
    if (m === 'GET' && p === '/api/overview') return json(200, { stats: await stats.overview(db), facets: await stats.facets(db), vocab: vocabSummary(), dbPath: dbLabel });
    if (m === 'GET' && p === '/api/questions') return json(200, await stats.searchQuestions(db, q));
    if (m === 'GET' && p.startsWith('/api/questions/')) {
      const id = decodeURIComponent(p.split('/')[3]);
      const qq = await importer.getQuestion(db, id);
      if (!qq) return json(404, { error: '找不到題目' });
      return json(200, { ...qq, analyses: await analysis.listAnalyses(db, id), variants: await variants.listVariants(db, id), links: await db.all('SELECT * FROM course_links WHERE question_id = ?', id) });
    }
    if (m === 'POST' && p === '/api/import/preview') return json(200, await importer.previewImport(db, sourceFromBody(parseBody(bodyText))));
    if (m === 'POST' && p === '/api/import/commit') {
      const body = parseBody(bodyText);
      const r = await importer.commitImport(db, sourceFromBody(body), body.filename || 'upload');
      const mirrored = await variants.mirrorAll(db);
      return json(200, { ...r, mirroredExistingVariants: mirrored });
    }
    if (m === 'GET' && p === '/api/needing-analysis') return json(200, await prompts.questionsNeedingAnalysis(db));
    if (m === 'POST' && p === '/api/jobs') {
      const body = parseBody(bodyText);
      const ids = body.pendingOnly ? await prompts.questionsNeedingAnalysis(db) : (body.ids || []);
      if (!ids.length) return json(400, { error: '沒有可產生指令的題目' });
      return json(200, await prompts.createJobs(db, body.kind === 'variant' ? 'variant' : 'analysis', ids, { maxChars: body.maxChars, maxItems: body.maxItems, includeAllCodes: !!body.includeAllCodes, options: body.options, count: body.count }));
    }
    if (m === 'GET' && p === '/api/jobs') return json(200, await db.all('SELECT id, kind, question_ids_json, rubric_version, created_at, status, result_json, LENGTH(prompt_text) AS chars FROM ai_jobs ORDER BY id DESC LIMIT 100'));
    if (m === 'GET' && p.startsWith('/api/jobs/')) { const j = await db.get('SELECT * FROM ai_jobs WHERE id = ?', Number(p.split('/')[3])); return j ? json(200, j) : json(404, { error: '找不到工作' }); }
    if (m === 'POST' && p === '/api/ai-results') {
      const body = parseBody(bodyText);
      const r = body.kind === 'variant' ? await variants.importVariantResults(db, body.text, { jobId: body.jobId || null, options: body.options || [] }) : await analysis.importAiResults(db, body.text, { jobId: body.jobId || null });
      return json(r.fatal ? 400 : 200, r.fatal ? { error: r.fatal, ...r } : r);
    }
    if (m === 'GET' && p === '/api/review-queue') return json(200, await review.reviewQueue(db, q.status || 'pending'));
    if (m === 'GET' && p.startsWith('/api/analyses/')) { const a = await analysis.getAnalysis(db, Number(p.split('/')[3])); return a ? json(200, a) : json(404, { error: '找不到分析' }); }
    if (m === 'POST' && p.startsWith('/api/analyses/') && p.endsWith('/review')) {
      const body = parseBody(bodyText);
      return json(200, await review.reviewAnalysis(db, Number(p.split('/')[3]), body.action, { reviewer: body.reviewer, reason: body.reason, payload: body.payload }));
    }
    if (m === 'POST' && p.startsWith('/api/variants/') && p.endsWith('/review')) {
      const body = parseBody(bodyText);
      return json(200, await variants.reviewVariant(db, Number(p.split('/')[3]), body.action, { reviewer: body.reviewer, reason: body.reason }));
    }
    if (m === 'GET' && p === '/api/variants') return json(200, await variants.listAllVariants(db, q.status));
    if (m === 'POST' && p === '/api/links') {
      const b = parseBody(bodyText);
      if (!b.question_id || !b.project || !b.lesson) return json(400, { error: '需要 question_id、project、lesson' });
      await db.run('INSERT OR REPLACE INTO course_links (question_id, project, lesson, position, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', b.question_id, b.project, b.lesson, b.position ?? null, b.note || '', nowIso());
      return json(200, { ok: true });
    }
    if (m === 'DELETE' && p === '/api/links') { await db.run('DELETE FROM course_links WHERE question_id = ? AND project = ? AND lesson = ?', q.question_id, q.project, q.lesson); return json(200, { ok: true }); }
    if (m === 'GET' && p === '/api/vocab') { const v = loadVocab(); return json(200, { curriculum: v.curriculum, grades: v.grades, skills: v.skills, units: v.units, activity: v.activity, rubricVersion: v.rubricVersion }); }
    if (m === 'GET' && p === '/api/suggestions') return json(200, await db.all('SELECT * FROM vocab_suggestions ORDER BY status, kind, term'));
    if (m === 'POST' && p === '/api/suggestions') {
      const b = parseBody(bodyText);
      if (!b.kind || !b.term) return json(400, { error: '需要 kind 與 term' });
      await analysis.recordSuggestions(db, [{ kind: b.kind, term: String(b.term).trim() }], b.context || '教師建議');
      return json(200, { ok: true, note: '已記為建議；正式共用詞庫不由此頁修改' });
    }
    if (m === 'GET' && p === '/api/export') {
      const what = q.what; const fmt = q.format || 'csv';
      let rows;
      try { rows = await exporter.exportByName(db, what); } catch (e) { return json(400, { error: e.message }); }
      const isCsv = fmt === 'csv' && Array.isArray(rows);
      const name = `qbank-${what}-${new Date().toISOString().slice(0, 10)}.${isCsv ? 'csv' : 'json'}`;
      return { status: 200, headers: { 'Content-Type': isCsv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }, body: isCsv ? exporter.toCsvText(rows) : JSON.stringify(rows, null, 1) };
    }
    if (m === 'GET' && p === '/api/check') return json(200, await exporter.consistencyCheck(db));
    return json(404, { error: '未知的 API 路徑' });
  } catch (e) {
    return json(400, { error: e.message });
  }
}

// HTTP Basic 驗證（共用）。expected 格式「帳號:密碼」。回傳 null 表示通過，否則回傳應回的 response 描述。
function checkBasicAuth(authorizationHeader, expected) {
  if (!expected) return { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '尚未設定存取密碼（QBANK_AUTH），服務拒絕提供。' };
  const header = authorizationHeader || '';
  let ok = false;
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = typeof atob === 'function' ? atob(header.slice(6)) : Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (e) { decoded = ''; }
    // 固定長度比較，避免時間差洩漏
    const a = new TextEncoder().encode(decoded); const b = new TextEncoder().encode(expected);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
    ok = diff === 0;
  }
  if (ok) return null;
  return { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="qbank", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: '需要登入' };
}

module.exports = { handleApi, checkBasicAuth, vocabSummary };
