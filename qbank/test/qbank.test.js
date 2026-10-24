'use strict';
// 執行：node --test qbank/test/   （只用 Node 內建 node:test，不需安裝套件）
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { openDb } = require('../lib/db');
const { parseCsv, toCsv, rowsToObjects } = require('../lib/csv');
const ids = require('../lib/ids');
const importer = require('../lib/importer');
const analysis = require('../lib/analysis');
const prompts = require('../lib/prompts');
const review = require('../lib/review');
const variants = require('../lib/variants');
const verify = require('../lib/verify');
const exporter = require('../lib/exporter');
const stats = require('../lib/stats');
const { loadVocab } = require('../lib/vocab');

const SAMPLE = path.join(__dirname, '..', 'samples', 'sample_questions.csv');

function freshDb() { return openDb(':memory:'); }
async function importSample(db) {
  const src = importer.readSourceFile(SAMPLE);
  const r = await importer.commitImport(db, src, 'sample_questions.csv');
  await variants.mirrorAll(db);
  return r;
}
async function firstQuestion(db) { return await importer.getQuestion(db, (await db.get('SELECT id FROM questions ORDER BY id LIMIT 1')).id); }
function goodAnalysis(q, extra = {}) {
  return {
    question_id: q.id, question_version: q.current_version,
    suggested_grades: ['G3', 'G4'], grade_reason: '兩位數加減與「從前面數、從後面數」的排隊情境，三年級可解，四年級可延伸',
    curriculum_codes: [{ code: 'N-2-3', reason: '加減法應用' }, { code: '待確認', reason: '是否另對應解題條目待教師確認' }],
    units: ['U-N-02'],
    skills: ['加減法應用'],
    core_concept: '位置從兩端數時，被數的人會被重複計算一次',
    conditions: { known: ['從前面數第 6', '從後面數第 9'], unknown: ['總人數'], constraints: ['同一人只算一次'] },
    reasoning_process: ['找出兩個位置', '發現重複計算', '6+9-1'],
    strategies: [{ name: '畫圖', reason: '排成一列直接數' }],
    misconceptions: [{ description: '直接把兩個數相加', wrong_path: '6+9=15', correct_concept: '小安被數了兩次要扣掉', teacher_probe: '小安在前面數時算到了嗎？後面數時又算到了嗎？', evidence: 'predicted' }],
    teacher_probes: ['如果從前面數是第 1 個，答案會變成什麼？'],
    answer_status: 'has', completeness: 'complete', rationale: '依題目條件與課綱 N-2-3 判斷',
    ...extra,
  };
}

// ---------- CSV ----------
test('CSV：引號內換行、雙引號、BOM 都正確還原', async () => {
  const text = '﻿a,b\r\n"x\ny","he said ""hi"""\r\n1,2\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [['a', 'b'], ['x\ny', 'he said "hi"'], ['1', '2']]);
  const back = toCsv(['a', 'b'], [{ a: 'x\ny', b: 'he said "hi"' }]);
  assert.deepEqual(parseCsv(back), [['a', 'b'], ['x\ny', 'he said "hi"']]);
});

test('CSV：引號未關閉要報錯而不是吞掉', async () => {
  assert.throws(() => parseCsv('a,b\n"open,1\n'), /引號未關閉/);
});

// ---------- 題目 ID ----------
test('ID：同一題不同列號／不同週次得到相同 ID；題號不同則不同', async () => {
  const a = { 題庫來源: 'X', 套別: 'A', 題號: '3', 週次: '1', 題目: 't' };
  const b = { ...a, 週次: '9' };
  assert.equal(ids.questionId(a), ids.questionId(b));
  assert.notEqual(ids.questionId(a), ids.questionId({ ...a, 題號: '4' }));
  assert.match(ids.questionId(a), /^Q[0-9A-F]{12}$/);
});

test('指紋：題目內容變動會改變指紋，影片連結變動不會', async () => {
  const a = { 題目: '甲', 類題一: '', 類題一答案: '', 類題二: '', 類題二答案: '', 主題: '', 對應課程: '', 年級: '', 週次: '', 備註: '', 影片1: '▶ 影片' };
  assert.equal(ids.contentFingerprint(a), ids.contentFingerprint({ ...a, 影片1: '▶ A' }));
  assert.notEqual(ids.contentFingerprint(a), ids.contentFingerprint({ ...a, 題目: '乙' }));
});

// ---------- 匯入 ----------
test('匯入：範例 8 題全部匯入、21 欄原樣保留、重複匯入不建新題', async () => {
  const db = freshDb();
  const r = await importSample(db);
  assert.equal(r.result.inserted, 8);
  assert.deepEqual(r.preview.columns.missing, []);
  assert.equal(r.preview.columns.sameOrder, true);
  const q = await firstQuestion(db);
  assert.deepEqual(Object.keys(q.raw), ids.ORIGINAL_COLUMNS);
  // 原始值逐字比對
  const src = rowsToObjects(parseCsv(fs.readFileSync(SAMPLE, 'utf8')));
  const srcRow = src.records.find(rec => ids.questionId(rec.values) === q.id).values;
  for (const c of ids.ORIGINAL_COLUMNS) assert.equal(q.raw[c], srcRow[c], '欄位 ' + c);
  const again = await importer.commitImport(db, importer.readSourceFile(SAMPLE), 'sample_questions.csv');
  assert.equal(again.result.inserted, 0);
  assert.equal(again.result.unchanged, 8);
  assert.equal((await db.get('SELECT COUNT(*) c FROM questions')).c, 8);
});

test('匯入：缺必填欄位、欄數不符、身分鍵重複的列被拒絕，其餘仍匯入', async () => {
  const db = freshDb();
  const header = ids.ORIGINAL_COLUMNS.join(',');
  const good = '甲庫,中年級,套A,1,1,課,主題,題目一,,,,,,,,,,,,,';
  const dupKey = '甲庫,中年級,套A,2,1,課,主題,題目二（題號重複）,,,,,,,,,,,,,';
  const noText = '甲庫,中年級,套A,1,2,課,主題,,,,,,,,,,,,,,';
  const short = '甲庫,中年級,套A,1,3,課,主題,題目三';
  const src = rowsToObjects(parseCsv([header, good, dupKey, noText, short].join('\n')));
  const r = await importer.commitImport(db, src, 'bad.csv');
  assert.equal(r.result.inserted, 1);
  assert.equal(r.result.rejected, 3);
  assert.match(JSON.stringify(r.result.rejectedRows), /身分鍵重複/);
  assert.match(JSON.stringify(r.result.rejectedRows), /必填欄位「題目」為空/);
  assert.match(JSON.stringify(r.result.rejectedRows), /欄數/);
});

test('匯入：缺少「題目」欄位整檔拒絕', async () => {
  const db = freshDb();
  const src = rowsToObjects(parseCsv('題庫來源,套別,題號\n甲,乙,1\n'));
  await assert.rejects(() => importer.commitImport(db, src, 'x.csv'), /缺少必填欄位：題目/);
});

test('匯入：內容變動產生新版本，舊版本保留；列號變動不影響 ID', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const rows = parseCsv(text);
  // 把該題移到最後一列並修改題目文字
  const hdr = rows[0];
  const idx = rows.findIndex((r, i) => i > 0 && ids.questionId(Object.fromEntries(hdr.map((h, j) => [h, r[j]]))) === q.id);
  const row = rows.splice(idx, 1)[0];
  row[hdr.indexOf('題目')] = row[hdr.indexOf('題目')] + '（修訂版）';
  rows.push(row);
  const r = await importer.commitImport(db, rowsToObjects(rows), 'v2.csv');
  assert.equal(r.result.newVersions, 1);
  assert.equal(r.result.inserted, 0);
  const q2 = await importer.getQuestion(db, q.id);
  assert.equal(q2.current_version, 2);
  assert.equal(q2.versions.length, 2);
  assert.equal(q2.source_row, rows.length); // 新列號被記錄
  const v1 = JSON.parse((await db.get('SELECT raw_json FROM question_versions WHERE question_id = ? AND version = 1', q.id)).raw_json);
  assert.equal(v1['題目'], q.raw['題目']);
});

test('匯入：含圖提示與缺答案會被標示旗標', async () => {
  const db = freshDb();
  await importSample(db);
  const flagged = (await db.all("SELECT question_id FROM question_flags WHERE flag = 'figure_dependent'"));
  assert.equal(flagged.length, 1);
  const src = rowsToObjects(parseCsv(ids.ORIGINAL_COLUMNS.join(',') + '\n甲庫,中年級,套A,1,1,課,主題,如圖所示有幾個三角形,,,,,,,,,,,,,\n'));
  await importer.commitImport(db, src, 'f.csv');
  const q = await importer.getQuestion(db, ids.questionId({ 題庫來源: '甲庫', 套別: '套A', 題號: '1' }));
  const flags = q.flags.map(f => f.flag);
  assert.ok(flags.includes('figure_dependent'));
  assert.ok(flags.includes('missing_answer_1'));
  assert.ok(flags.includes('missing_answer_2'));
});

// ---------- 分類規準 ----------
test('規準：課綱代碼表有 131 條國小代碼，且含已知代碼；技能正式詞庫目前為空', async () => {
  const v = loadVocab();
  assert.equal(v.curriculum.count, 131);
  assert.ok(v.codeMap.has('N-3-3'));
  assert.ok(v.codeMap.has('D-6-2'));
  assert.ok(!v.codeMap.has('N-7-1'));
  assert.equal(v.skills.approved.length, 0);
});

// ---------- AI 結果驗證 ----------
test('AI 結果：正確結果可匯入為待審核，草案技能進詞彙建議', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const r = await analysis.importAiResults(db, JSON.stringify({ results: [goodAnalysis(q)] }));
  assert.equal(r.ok, true);
  assert.equal(r.accepted.length, 1);
  const a = await analysis.getAnalysis(db, r.accepted[0].analysisId);
  assert.equal(a.review_status, 'pending');
  assert.equal(a.source, 'ai');
  assert.equal(a.payload.skills[0].status, 'draft');
  assert.equal((await db.get("SELECT COUNT(*) c FROM vocab_suggestions WHERE kind='skill' AND term='加減法應用'")).c, 1);
  // 正式詞庫沒有被改動
  assert.equal(loadVocab().skills.approved.length, 0);
});

test('AI 結果：不存在的課綱代碼被拒絕，不寫入資料', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const r = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q, { curriculum_codes: [{ code: 'N-3-99', reason: 'x' }] })]));
  assert.equal(r.ok, false);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].errors.join(), /N-3-99/);
  assert.equal((await db.get('SELECT COUNT(*) c FROM analyses')).c, 0);
});

test('AI 結果：ID 不存在、版本不符、錯誤 JSON、活動類型當技能、verified 皆拒絕；批次局部失敗保留正確結果', async () => {
  const db = freshDb();
  await importSample(db);
  const [q1, q2] = await Promise.all((await db.all('SELECT id FROM questions ORDER BY id LIMIT 2')).map(r => importer.getQuestion(db, r.id)));
  const bad = await analysis.importAiResults(db, '{"results": [ {broken');
  assert.equal(bad.ok, false); assert.match(bad.fatal, /JSON/);
  const r = await analysis.importAiResults(db, JSON.stringify({ results: [
    goodAnalysis(q1),
    goodAnalysis(q2, { question_id: 'Q000000000000' }),
    goodAnalysis(q2, { question_version: 99 }),
    goodAnalysis(q2, { skills: ['學習單'] }),
    goodAnalysis(q2, { answer_status: 'verified' }),
    goodAnalysis(q2, { suggested_grades: ['國三'] }),
    goodAnalysis(q2, { misconceptions: [{ description: '只有描述' }] }),
  ] }));
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 6);
  const errs = r.rejected.map(x => x.errors.join(' '));
  assert.match(errs[0], /不存在/);
  assert.match(errs[1], /版本/);
  assert.match(errs[2], /活動類型/);
  assert.match(errs[3], /verified/);
  assert.match(errs[4], /G1–G6/);
  assert.match(errs[5], /迷思概念/);
  assert.equal((await db.get('SELECT COUNT(*) c FROM analyses')).c, 1);
});

test('AI 結果：迷思概念與數學技能分開儲存；evidence 預設為預測性', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const r = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q, { misconceptions: [{ description: 'd', wrong_path: 'w', correct_concept: 'c', teacher_probe: 'p' }] })]));
  const a = await analysis.getAnalysis(db, r.accepted[0].analysisId);
  assert.equal(a.payload.misconceptions[0].evidence, 'predicted');
  assert.ok(!a.payload.skills.some(s => s.term === 'd'));
});

// ---------- 審核 ----------
test('審核：確認、退回（需原因）、修改後確認；歷史版本保留；重複分析不覆蓋已確認', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const r1 = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q)]));
  const id1 = r1.accepted[0].analysisId;
  await assert.rejects(() => review.reviewAnalysis(db, id1, 'return', { reason: '' }), /原因/);
  const confirmed = await review.reviewAnalysis(db, id1, 'confirm', { reviewer: '測試教師' });
  assert.equal(confirmed.review_status, 'confirmed');
  // 第二次 AI 分析 → 新版本待審核，已確認的不被覆蓋
  const r2 = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q, { core_concept: '第二版' })]));
  const id2 = r2.accepted[0].analysisId;
  assert.equal((await analysis.getAnalysis(db, id1)).review_status, 'confirmed');
  assert.equal((await analysis.getAnalysis(db, id2)).review_status, 'pending');
  assert.equal((await analysis.listAnalyses(db, q.id)).length, 2);
  // 修改後確認：帶錯誤代碼要被擋
  await assert.rejects(() => review.reviewAnalysis(db, id2, 'modify', { payload: { curriculum_codes: [{ code: 'Z-9-9', reason: '' }] } }), /規準檢查/);
  const mod = await review.reviewAnalysis(db, id2, 'modify', { payload: { core_concept: '教師修正版', curriculum_codes: [{ code: 'N-3-3', reason: '教師判定' }] } });
  assert.equal(mod.review_status, 'confirmed');
  assert.equal(mod.payload.core_concept, '教師修正版');
  assert.equal((await analysis.getAnalysis(db, id1)).review_status, 'superseded'); // 舊確認改為 superseded，仍保留
  const log = (await db.all('SELECT action FROM review_log WHERE analysis_id = ? ORDER BY id', id2)).map(x => x.action);
  assert.deepEqual(log, ['modify']);
  // 退回
  const r3 = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q, { core_concept: '第三版' })]));
  const ret = await review.reviewAnalysis(db, r3.accepted[0].analysisId, 'return', { reason: '年級理由不足' });
  assert.equal(ret.review_status, 'returned');
  assert.equal((await db.get("SELECT COUNT(*) c FROM analyses WHERE review_status='confirmed'")).c, 1);
});

test('審核：題目更新後，舊分析標示可能失效且不能直接確認', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const r = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q)]));
  // 修改題目文字後再匯入
  const rows = parseCsv(fs.readFileSync(SAMPLE, 'utf8'));
  const hdr = rows[0];
  for (let i = 1; i < rows.length; i++) if (ids.questionId(Object.fromEntries(hdr.map((h, j) => [h, rows[i][j]]))) === q.id) rows[i][hdr.indexOf('題目')] += '（改）';
  await importer.commitImport(db, rowsToObjects(rows), 'v2.csv');
  const a = await analysis.getAnalysis(db, r.accepted[0].analysisId);
  assert.equal(a.stale, true);
  await assert.rejects(() => review.reviewAnalysis(db, a.id, 'confirm'), /版本已更新/);
  assert.ok((await prompts.questionsNeedingAnalysis(db)).includes(q.id));
  assert.ok((await exporter.exportAnomalies(db)).some(x => x.類型 === '分析可能失效'));
});

// ---------- 指令產生 ----------
test('指令：依文字長度與題數切批；只對尚未分析的題目；指令含代碼表與題目 ID', async () => {
  const db = freshDb();
  await importSample(db);
  const need = await prompts.questionsNeedingAnalysis(db);
  assert.equal(need.length, 8);
  const { jobs } = await prompts.createJobs(db, 'analysis', need, { maxItems: 3 });
  assert.equal(jobs.length, 3);
  assert.match(jobs[0].prompt, /N-3-\d+/);
  assert.match(jobs[0].prompt, new RegExp(need[0]));
  assert.match(jobs[0].prompt, /待確認/);
  const tiny = (await prompts.createJobs(db, 'analysis', need, { maxChars: 200 })).jobs;
  assert.equal(tiny.length, 8); // 每批塞不下第二題
  // 分析完一題後，需要分析的題目少一題
  const q = await importer.getQuestion(db, need[0]);
  await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q)]));
  assert.equal((await prompts.questionsNeedingAnalysis(db)).length, 7);
});

// ---------- 類題與驗算 ----------
test('驗算：安全算式求值；拒絕非法字元；數值比對', async () => {
  assert.equal(verify.evaluate('(6+9-1)'), 14);
  assert.equal(verify.evaluate('2^3*2'), 16);
  assert.equal(verify.evaluate('10/4'), 2.5);
  assert.throws(() => verify.evaluate('process.exit()'), /不允許的字元/);
  assert.throws(() => verify.evaluate('1/0'), /除以零/);
  assert.equal(verify.firstNumber('每人 6 顆，剩 2 顆'), 6);
  assert.equal(verify.firstNumber('3/4 公升'), 0.75);
  assert.equal(verify.verifyVariant({ answer: '14 人', check: { type: 'arithmetic', expression: '6+9-1', expected: '14' } }).status, 'auto_passed');
  assert.equal(verify.verifyVariant({ answer: '15 人', check: { type: 'arithmetic', expression: '6+9-1', expected: '14' } }).status, 'auto_failed');
  assert.equal(verify.verifyVariant({ answer: '紅球', check: { type: 'none' } }).status, 'unverified');
});

test('類題：匯入另存為 ai 類題，原題與既有類題不被覆蓋；與原題相同的文字被拒；教師核准才算確認', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const before = JSON.stringify((await importer.getQuestion(db, q.id)).raw);
  const r = await variants.importVariantResults(db, JSON.stringify({ results: [
    { question_id: q.id, question_version: q.current_version, variants: [
      { text: '新的類題：從左數第 4、從右數第 8，共幾人？', answer: '11 人', solution_steps: ['4+8-1=11'], check: { type: 'arithmetic', expression: '4+8-1', expected: '11' } },
      { text: '算錯的類題', answer: '20 人', solution_steps: ['x'], check: { type: 'arithmetic', expression: '4+8-1', expected: '11' } },
      { text: q.raw['題目'], answer: '14', solution_steps: ['x'] },
    ] },
    { question_id: q.id, question_version: q.current_version, variants: [{ text: '圖形題類題', answer: '5 個', solution_steps: ['數一數'], check: { type: 'none' } }] },
  ] }));
  // 第一筆含與原題相同文字 → 整筆拒絕（局部失敗）；第二筆接受
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].errors.join(), /與原題文字相同/);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].verify.status, 'unverified');
  assert.equal(JSON.stringify((await importer.getQuestion(db, q.id)).raw), before);
  const r2 = await variants.importVariantResults(db, JSON.stringify([{ question_id: q.id, question_version: q.current_version, variants: [
    { text: '新的類題：從左數第 4、從右數第 8，共幾人？', answer: '11 人', solution_steps: ['4+8-1=11'], check: { type: 'arithmetic', expression: '4+8-1', expected: '11' } },
    { text: '算錯的類題', answer: '20 人', solution_steps: ['x'], check: { type: 'arithmetic', expression: '4+8-1', expected: '11' } },
  ] }]));
  assert.equal(r2.accepted.length, 2);
  assert.equal(r2.accepted[0].verify.status, 'auto_passed');
  assert.equal(r2.accepted[1].verify.status, 'auto_failed');
  const all = await variants.listVariants(db, q.id);
  assert.equal(all.filter(v => v.kind.startsWith('existing')).length, 2);
  assert.equal(all.filter(v => v.kind === 'ai').length, 3);
  assert.equal(all.find(v => v.kind === 'existing_1').text, q.raw['類題一']);
  // 教師核准
  const ok = await variants.reviewVariant(db, r2.accepted[0].variantId, 'confirm', { reviewer: '測試教師' });
  assert.equal(ok.verify_status, 'teacher_confirmed');
  await assert.rejects(() => variants.reviewVariant(db, r2.accepted[1].variantId, 'reject', { reason: '' }), /原因/);
  await assert.rejects(() => variants.reviewVariant(db, all.find(v => v.kind === 'existing_1').id, 'confirm'), /原始資料鏡像/);
});

// ---------- 匯出與一致性 ----------
test('匯出：已確認、待審核、異常、關聯、原始題目、備份；一致性檢查通過', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const r = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q)]));
  await review.reviewAnalysis(db, r.accepted[0].analysisId, 'confirm');
  await db.run("INSERT INTO course_links (question_id, project, lesson, position, note, created_at) VALUES (?, '示範課程', '第1堂', 1, '', ?)", q.id, new Date().toISOString());
  const conf = await exporter.exportAnalyses(db, 'confirmed');
  assert.equal(conf.length, 1);
  assert.equal(conf[0]['題目 ID'], q.id);
  assert.match(conf[0]['迷思概念'], /\[預測性\]/);
  assert.equal(conf[0]['數學技能（正式）'], '');
  assert.match(conf[0]['數學技能（建議，未核准）'], /加減法應用/);
  const csv = exporter.toCsvText(conf);
  assert.equal(parseCsv(csv).length, 2);
  assert.equal((await exporter.exportAnalyses(db, 'pending')).length, 0);
  assert.ok((await exporter.exportAnomalies(db)).length >= 1);
  assert.equal((await exporter.exportCourseLinks(db)).length, 1);
  const orig = await exporter.exportQuestionsOriginal(db);
  assert.equal(orig.length, 8);
  for (const c of ids.ORIGINAL_COLUMNS) assert.ok(c in orig[0]);
  const bk = await exporter.fullBackup(db);
  assert.equal(bk.tables.questions.length, 8);
  assert.equal((await exporter.consistencyCheck(db)).ok, true);
  const s = await stats.overview(db);
  assert.equal(s.總題數, 8); assert.equal(s.已審核數, 1); assert.equal(s.尚未分析題數, 7);
});

test('搜尋：依課綱代碼、年級、審核狀態、旗標搜尋', async () => {
  const db = freshDb();
  await importSample(db);
  const q = await firstQuestion(db);
  const r = await analysis.importAiResults(db, JSON.stringify([goodAnalysis(q)]));
  assert.equal((await stats.searchQuestions(db, { code: 'N-2-3' })).length, 1);
  assert.equal((await stats.searchQuestions(db, { grade: 'G3' })).length, 1);
  assert.equal((await stats.searchQuestions(db, { review_status: 'pending' })).length, 1);
  assert.equal((await stats.searchQuestions(db, { review_status: 'none' })).length, 7);
  assert.equal((await stats.searchQuestions(db, { flag: 'figure_dependent' })).length, 1);
  await review.reviewAnalysis(db, r.accepted[0].analysisId, 'confirm');
  assert.equal((await stats.searchQuestions(db, { review_status: 'confirmed' })).length, 1);
});

// ---------- 伺服器 ----------
test('伺服器：API 可匯入、產生指令、匯入結果、審核、匯出；錯誤 JSON 回 400', async () => {
  const { start } = require('../server');
  const tmp = path.join(os.tmpdir(), `qbank-test-${process.pid}-${Date.now()}.sqlite`);
  const { server, url } = await start(tmp, 0);
  try {
    const call = async (p, opts) => { const r = await fetch(url.replace(/\/$/, '') + p, opts); return { status: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }; };
    const csv = fs.readFileSync(SAMPLE, 'utf8');
    let r = await call('/api/import/preview', { method: 'POST', body: JSON.stringify({ csv }) });
    assert.equal(r.body.summary.insert, 8);
    r = await call('/api/import/commit', { method: 'POST', body: JSON.stringify({ csv, filename: 'sample.csv' }) });
    assert.equal(r.body.result.inserted, 8);
    r = await call('/api/overview'); assert.equal(r.body.stats.總題數, 8);
    r = await call('/api/jobs', { method: 'POST', body: JSON.stringify({ pendingOnly: true, maxItems: 4 }) });
    assert.equal(r.body.jobs.length, 2);
    const qid = r.body.jobs[0].questionIds[0];
    r = await call('/api/questions/' + qid); assert.equal(r.body.id, qid);
    r = await call('/api/ai-results', { method: 'POST', body: JSON.stringify({ text: 'not json' }) });
    assert.equal(r.status, 400);
    r = await call('/api/ai-results', { method: 'POST', body: JSON.stringify({ text: JSON.stringify([goodAnalysis({ id: qid, current_version: 1 })]) }) });
    assert.equal(r.body.accepted.length, 1);
    const aid = r.body.accepted[0].analysisId;
    r = await call(`/api/analyses/${aid}/review`, { method: 'POST', body: JSON.stringify({ action: 'confirm', reviewer: 'T' }) });
    assert.equal(r.body.review_status, 'confirmed');
    r = await call('/api/export?what=confirmed&format=csv');
    assert.equal(parseCsv(r.body).length, 2);
    r = await call('/api/check'); assert.equal(r.body.ok, true);
    r = await call('/api/nothing'); assert.equal(r.status, 404);
    r = await call('/'); assert.match(r.body, /<html/i);
  } finally {
    server.close();
    try { fs.unlinkSync(tmp); fs.unlinkSync(tmp + '-wal'); fs.unlinkSync(tmp + '-shm'); } catch (e) { /* ignore */ }
  }
});
