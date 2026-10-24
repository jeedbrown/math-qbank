#!/usr/bin/env node
'use strict';
// 題庫分析模組 命令列工具（不需任何外部套件，不呼叫任何付費 API）
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./lib/db');
const importer = require('./lib/importer');
const analysis = require('./lib/analysis');
const prompts = require('./lib/prompts');
const review = require('./lib/review');
const variants = require('./lib/variants');
const exporter = require('./lib/exporter');
const stats = require('./lib/stats');
const { loadVocab } = require('./lib/vocab');

const DEFAULT_DB = process.env.QBANK_DB || path.join(__dirname, 'data', 'qbank.sqlite');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

function out(x) { process.stdout.write(typeof x === 'string' ? x + '\n' : JSON.stringify(x, null, 2) + '\n'); }

const HELP = `用法：node qbank/cli.js <指令> [選項]   （資料庫預設 qbank/data/qbank.sqlite，可用 --db 或 QBANK_DB 指定）

匯入
  import <檔案.csv|.json> [--preview]       匯入原始題庫（--preview 只預覽不寫入）
  question <題目ID>                          顯示單題（原始 21 欄、旗標、版本、分析、類題）
  search [--q 關鍵字] [--grade G3] [--code N-3-3] [--status pending|confirmed|returned|none] ...
AI 分析交換（不使用 API）
  prompt [--ids Q1,Q2] [--pending] [--all-codes] [--max-chars 6000] [--max-items 8] [--out 目錄]
  import-ai <結果.json> [--job 編號]          匯入 AI 分析結果（逐筆驗證，局部失敗不影響其他）
  review <分析ID> <confirm|modify|return|reopen> [--reason 原因] [--payload 修改.json] [--reviewer 名稱]
  queue [--status pending]                   列出待審核清單
類題
  variant-prompt --ids Q1,Q2 [--options keep_concept,change_numbers] [--count 2] [--out 目錄]
  import-variants <結果.json> [--job 編號]
  variant-review <類題ID> <confirm|reject|reopen> [--reason 原因]
課程關聯
  link <題目ID> --project 專案 --lesson 堂次 [--position 1] [--note 備註]
  unlink <題目ID> --project 專案 --lesson 堂次
匯出
  export <confirmed|pending|anomalies|links|questions|backup> [--format csv|json] [--out 檔案]
  check / stats / vocab / suggestions [--status suggested]
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help') { out(HELP); return; }
  const db = openDb(args.db || DEFAULT_DB);
  switch (cmd) {
    case 'import': {
      const file = args._[1]; if (!file) throw new Error('請指定檔案');
      const src = importer.readSourceFile(file);
      if (args.preview) { out(await importer.previewImport(db, src)); break; }
      const r = await importer.commitImport(db, src, path.basename(file));
      const mirrored = await variants.mirrorAll(db);
      out({ columns: r.preview.columns, summary: r.preview.summary, result: r.result, mirroredExistingVariants: mirrored });
      break;
    }
    case 'question': {
      const q = await importer.getQuestion(db, args._[1]); if (!q) throw new Error('找不到題目');
      out({ ...q, analyses: await analysis.listAnalyses(db, q.id), variants: await variants.listVariants(db, q.id), links: await db.all('SELECT * FROM course_links WHERE question_id = ?', q.id) });
      break;
    }
    case 'search': out(await stats.searchQuestions(db, { q: args.q, grade: args.grade, code: args.code, unit: args.unit, skill: args.skill, misconception: args.misconception, project: args.project, review_status: args.status, source_bank: args.bank, set_name: args.set, source_grade: args['source-grade'], flag: args.flag, limit: args.limit })); break;
    case 'prompt': case 'variant-prompt': {
      let ids = args.ids ? String(args.ids).split(',').map(s => s.trim()).filter(Boolean) : [];
      if (cmd === 'prompt' && (args.pending || !ids.length)) ids = ids.length ? ids : await prompts.questionsNeedingAnalysis(db);
      if (!ids.length) { out('沒有需要分析的題目'); break; }
      const kind = cmd === 'prompt' ? 'analysis' : 'variant';
      const opts = { maxChars: Number(args['max-chars']) || undefined, maxItems: Number(args['max-items']) || undefined, includeAllCodes: !!args['all-codes'], options: args.options ? String(args.options).split(',') : undefined, count: Number(args.count) || 2 };
      const { jobs, missing } = await prompts.createJobs(db, kind, ids, opts);
      const dir = args.out || path.join(path.dirname(args.db || DEFAULT_DB), 'prompts');
      fs.mkdirSync(dir, { recursive: true });
      for (const j of jobs) fs.writeFileSync(path.join(dir, `${kind}-job-${j.jobId}.txt`), j.prompt, 'utf8');
      out({ jobs: jobs.map(j => ({ jobId: j.jobId, questions: j.questionIds.length, chars: j.chars, file: path.join(dir, `${kind}-job-${j.jobId}.txt`) })), missing });
      break;
    }
    case 'import-ai': out(await analysis.importAiResults(db, fs.readFileSync(args._[1], 'utf8'), { jobId: args.job ? Number(args.job) : null })); break;
    case 'import-variants': out(await variants.importVariantResults(db, fs.readFileSync(args._[1], 'utf8'), { jobId: args.job ? Number(args.job) : null, options: args.options ? String(args.options).split(',') : [] })); break;
    case 'review': {
      const payload = args.payload ? JSON.parse(fs.readFileSync(args.payload, 'utf8')) : null;
      out(await review.reviewAnalysis(db, Number(args._[1]), args._[2], { reviewer: args.reviewer, reason: args.reason, payload }));
      break;
    }
    case 'queue': out(await review.reviewQueue(db, args.status || 'pending')); break;
    case 'variant-review': out(await variants.reviewVariant(db, Number(args._[1]), args._[2], { reviewer: args.reviewer, reason: args.reason })); break;
    case 'link':
      await db.run('INSERT OR REPLACE INTO course_links (question_id, project, lesson, position, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', args._[1], args.project, args.lesson, args.position ? Number(args.position) : null, args.note || '', new Date().toISOString());
      out('已建立關聯'); break;
    case 'unlink': await db.run('DELETE FROM course_links WHERE question_id = ? AND project = ? AND lesson = ?', args._[1], args.project, args.lesson); out('已移除關聯'); break;
    case 'export': {
      const what = args._[1];
      const fmt = args.format || (what === 'backup' ? 'json' : 'csv');
      const rows = await exporter.exportByName(db, what);
      const text = fmt === 'csv' && Array.isArray(rows) ? exporter.toCsvText(rows) : JSON.stringify(rows, null, 1);
      if (args.out) { fs.writeFileSync(args.out, text, 'utf8'); out(`已寫入 ${args.out}（${Array.isArray(rows) ? rows.length + ' 列' : '備份'}）`); }
      else process.stdout.write(text);
      break;
    }
    case 'check': out(await exporter.consistencyCheck(db)); break;
    case 'stats': out(await stats.overview(db)); break;
    case 'vocab': { const v = loadVocab(); out({ rubricVersion: v.rubricVersion, curriculumCodes: v.curriculum.count, approvedSkills: v.skills.approved.length, draftSkills: v.skills.draft.length, units: v.unitCodes.size, activityTypes: v.activity.items.length }); break; }
    case 'suggestions': out(await db.all('SELECT * FROM vocab_suggestions WHERE status = ? ORDER BY kind, term', args.status || 'suggested')); break;
    default: throw new Error('未知指令：' + cmd + '\n' + HELP);
  }
}

main().catch(e => { process.stderr.write('錯誤：' + e.message + '\n'); process.exit(1); });
