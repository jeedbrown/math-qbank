'use strict';
const { loadVocab, curriculumCodesForGrades, gradeWindowForSourceGrade } = require('./vocab');
const { getQuestion } = require('./importer');
const { nowIso } = require('./util');
const { normalize } = require('./ids');

const DEFAULT_MAX_CHARS = 6000;   // 每批題目文字上限（依文字長度，不只依題數）
const DEFAULT_MAX_ITEMS = 8;

function makeBatches(questions, { maxChars = DEFAULT_MAX_CHARS, maxItems = DEFAULT_MAX_ITEMS } = {}) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const q of questions) {
    const len = normalize(q.raw['題目']).length + 80;
    if (cur.length && (cur.length >= maxItems || curChars + len > maxChars)) { batches.push(cur); cur = []; curChars = 0; }
    cur.push(q); curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function codeListText(items) { return items.map(i => `${i.code}（${i.grade}年級・${i.theme}）${i.title}`).join('\n'); }

const ANALYSIS_SCHEMA_EXAMPLE = {
  question_id: 'Q000000000000',
  question_version: 1,
  suggested_grades: ['G3', 'G4'],
  grade_reason: '為什麼適合這些年級（必填，不能只給數字）',
  curriculum_codes: [{ code: 'N-3-3', reason: '對應理由' }, { code: '待確認', reason: '不確定時用「待確認」，不可捏造代碼' }],
  units: ['U-N-04'],
  skills: ['（只能填共用詞庫中的詞；沒有合適的就提出新詞，會被記為建議）'],
  core_concept: '一句話說明題目核心數學概念',
  conditions: { known: ['已知條件…'], unknown: ['要求的未知量…'], constraints: ['限制條件…'] },
  reasoning_process: ['找出哪些已知條件', '哪些條件需要轉換', '是否需要建立數量關係', '是否需要尋找規律或排除不可能情況', '如何驗證答案'],
  strategies: [{ name: '策略名稱', reason: '為什麼適用' }],
  misconceptions: [{ description: '迷思概念描述', wrong_path: '可能出現的錯誤思路', correct_concept: '正確的數學概念', teacher_probe: '教師可使用的追問', evidence: 'predicted' }],
  teacher_probes: ['促進學生思考的提問…'],
  answer_status: 'has | missing | needs_check（不得填 verified）',
  completeness: 'complete | missing_figure | missing_condition | doubtful',
  rationale: '整體分類依據與理由',
};

function analysisPrompt(questions, { includeAllCodes = false } = {}) {
  const v = loadVocab();
  const gradeNums = new Set();
  if (includeAllCodes) [1, 2, 3, 4, 5, 6].forEach(g => gradeNums.add(g));
  else for (const q of questions) gradeWindowForSourceGrade(q.source_grade, v).forEach(g => gradeNums.add(g));
  const codes = curriculumCodesForGrades([...gradeNums].sort(), v);
  const skillList = v.skills.approved.length ? v.skills.approved : v.skills.draft;
  const skillNote = v.skills.approved.length ? '（共用正式詞庫）' : '（目前只有草案詞彙，尚未核准；使用時會被記為建議）';
  const unitList = [...v.unitCodes.values()].map(u => `${u.code} ${u.label}${u.draft ? '（草案）' : ''}`).join('\n');
  const lines = [];
  lines.push('你是國小數學教師與課程專家。請依下列規準，分析每一道題目，只輸出一個 JSON 物件，不要輸出其他文字。');
  lines.push('');
  lines.push('【硬性規則】');
  lines.push('1. 每一題輸出一筆結果，question_id 與 question_version 必須原樣照抄，不得更動。');
  lines.push('2. 課綱代碼只能從下面的代碼表選用（台灣十二年國教數學領域學習內容代碼，國小）。不確定就填「待確認」，絕對不可捏造或改寫代碼。學習內容代碼、學習表現代碼與出版社單元名稱是不同層次，不要混用。');
  lines.push('3. 建議年級用 G1～G6（可多選），並說明理由；不得因為原始資料寫「中年級」就直接填 G3、G4。');
  lines.push('4. 數學技能只能從技能詞庫選；沒有合適詞時可以提出新詞，但要放在 skills 陣列中讓系統記為建議。活動類型（繪本、講義、桌遊、遊戲、活動、學習單、挑戰題、簡報、影片、討論）不是數學技能，不得填入。');
  lines.push('5. 迷思概念是「題目可能誘發的迷思」預測，不是觀察到的學生錯誤；evidence 一律填 predicted。每一項都要有描述、錯誤思路、正確概念、教師追問四個欄位。');
  lines.push('6. 推理歷程請寫成步驟陣列，不要只分「推理題／非推理題」。');
  lines.push('7. answer_status 不得填 verified；答案是否正確由驗算與教師另行確認。題目若需要看圖才能解，completeness 填 missing_figure。');
  lines.push('');
  lines.push('【輸出格式】 {"results": [ 每題一個物件 ]}，每個物件欄位如下（範例值請替換）：');
  lines.push(JSON.stringify(ANALYSIS_SCHEMA_EXAMPLE, null, 1));
  lines.push('');
  lines.push(`【課綱學習內容代碼表】（${codes.length} 條，依題目年級範圍節錄）`);
  lines.push(codeListText(codes));
  lines.push('');
  lines.push('【單元分類】');
  lines.push(unitList);
  lines.push('');
  lines.push(`【數學技能詞庫】${skillNote}`);
  lines.push(skillList.join('、'));
  lines.push('');
  lines.push(`【題目】共 ${questions.length} 題`);
  questions.forEach((q, i) => {
    lines.push(`--- 第 ${i + 1} 題 ---`);
    lines.push(`question_id: ${q.id}`);
    lines.push(`question_version: ${q.current_version}`);
    lines.push(`原始年級標示: ${q.source_grade || '（無）'}`);
    lines.push(`主題: ${q.raw['主題'] || ''}`);
    lines.push(`對應課程（出版社單元，僅供參考）: ${q.raw['對應課程'] || ''}`);
    if (q.flags.some(f => f.flag === 'figure_dependent')) lines.push('提醒: 此題含圖或表，文字可能不完整');
    lines.push('題目:');
    lines.push(q.raw['題目']);
    if (q.raw['類題一答案']) lines.push(`既有類題一答案（供判斷題型，不是本題答案）: ${q.raw['類題一答案']}`);
  });
  return lines.join('\n');
}

const VARIANT_OPTIONS = {
  keep_concept: '保留原題核心概念（必選）',
  change_numbers: '更換數字',
  change_context: '更換生活情境',
  more_complex: '增加條件複雜度',
  less_complex: '降低條件複雜度',
  alt_method: '產生可用不同解法的題目',
};

const VARIANT_SCHEMA_EXAMPLE = {
  question_id: 'Q000000000000',
  question_version: 1,
  variants: [{
    text: '類題題目全文',
    answer: '最終答案（含單位）',
    solution_steps: ['完整解題步驟…'],
    alt_solutions: ['其他可能解法…'],
    verification: '驗算方式說明',
    teaching_tips: '教師教學提示',
    check: { type: 'arithmetic', expression: '(6+9-1)', expected: '14', note: '可由程式獨立計算的算式；圖形題、開放題填 type: none' },
  }],
};

function variantPrompt(questions, options = ['keep_concept', 'change_numbers'], count = 2) {
  const lines = [];
  lines.push('你是國小數學出題教師。請依原題產生類題，只輸出一個 JSON 物件，不要輸出其他文字。');
  lines.push('');
  lines.push('【操作要求】');
  for (const o of options) if (VARIANT_OPTIONS[o]) lines.push('- ' + VARIANT_OPTIONS[o]);
  lines.push(`- 每題產生 ${count} 個類題。`);
  lines.push('');
  lines.push('【硬性規則】');
  lines.push('1. question_id、question_version 原樣照抄。');
  lines.push('2. 類題必須保留原題的數學概念與解題結構，不能只是改人名；也不能因改數字造成無解、矛盾、不合理（例如人數不是整數、負數長度）。');
  lines.push('3. 答案必須與題目一致；請附完整解題步驟、其他解法、驗算方式與教師教學提示。');
  lines.push('4. 可用算式獨立驗算的題目，請在 check 填 type: arithmetic，expression 只用數字與 + - * / ( ) ^，expected 填算式結果；圖形題、情境判斷題、開放題填 type: none。');
  lines.push('5. 不得宣稱答案「已驗證」；驗證由程式與教師另行完成。');
  lines.push('');
  lines.push('【輸出格式】 {"results": [ 每題一個物件 ]}，物件欄位如下：');
  lines.push(JSON.stringify(VARIANT_SCHEMA_EXAMPLE, null, 1));
  lines.push('');
  lines.push(`【原題】共 ${questions.length} 題`);
  questions.forEach((q, i) => {
    lines.push(`--- 第 ${i + 1} 題 ---`);
    lines.push(`question_id: ${q.id}`);
    lines.push(`question_version: ${q.current_version}`);
    lines.push(`原始年級標示: ${q.source_grade || ''}　主題: ${q.raw['主題'] || ''}`);
    lines.push('原題:');
    lines.push(q.raw['題目']);
    if (q.raw['類題一']) { lines.push('既有類題一（請勿重複，另出新題）:'); lines.push(q.raw['類題一']); }
    if (q.raw['類題二']) { lines.push('既有類題二（請勿重複，另出新題）:'); lines.push(q.raw['類題二']); }
  });
  return lines.join('\n');
}

// 建立 AI 工作（記錄指令與題目清單，供之後匯入時對應）
async function createJobs(db, kind, questionIds, opts = {}) {
  const qs = [];
  const missing = [];
  for (const id of questionIds) { const q = await getQuestion(db, id); if (q) qs.push(q); else missing.push(id); }
  const batches = makeBatches(qs, opts);
  const v = loadVocab();
  const jobs = [];
  for (const b of batches) {
    const prompt = kind === 'variant' ? variantPrompt(b, opts.options, opts.count) : analysisPrompt(b, opts);
    const r = await db.run('INSERT INTO ai_jobs (kind, question_ids_json, prompt_text, rubric_version, created_at) VALUES (?, ?, ?, ?, ?)', kind, JSON.stringify(b.map(q => q.id)), prompt, v.rubricVersion, nowIso());
    jobs.push({ jobId: r.lastInsertRowid, questionIds: b.map(q => q.id), chars: prompt.length, prompt });
  }
  return { jobs, missing };
}

// 「只分析尚未完成的題目」：沒有對應目前版本的待審核／已確認分析
async function questionsNeedingAnalysis(db) {
  const rows = await db.all(`SELECT q.id FROM questions q
    WHERE NOT EXISTS (SELECT 1 FROM analyses a WHERE a.question_id = q.id AND a.review_status IN ('pending','confirmed') AND a.question_version = q.current_version)
    ORDER BY q.source_bank, q.set_name, CAST(q.item_no AS INTEGER), q.item_no`);
  return rows.map(r => r.id);
}

module.exports = { makeBatches, analysisPrompt, variantPrompt, createJobs, questionsNeedingAnalysis, VARIANT_OPTIONS, ANALYSIS_SCHEMA_EXAMPLE, VARIANT_SCHEMA_EXAMPLE, DEFAULT_MAX_CHARS, DEFAULT_MAX_ITEMS };
