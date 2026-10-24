'use strict';
// 總覽數字一律由實際資料計算
async function overview(db) {
  const one = async sql => Object.values(await db.get(sql))[0];
  return {
    總題數: await one('SELECT COUNT(*) AS c FROM questions'),
    已分析數: await one("SELECT COUNT(DISTINCT question_id) AS c FROM analyses WHERE review_status IN ('pending','confirmed')"),
    已審核數: await one("SELECT COUNT(DISTINCT question_id) AS c FROM analyses WHERE review_status = 'confirmed'"),
    待審核數: await one("SELECT COUNT(*) AS c FROM analyses WHERE review_status = 'pending'"),
    退回數: await one("SELECT COUNT(*) AS c FROM analyses WHERE review_status = 'returned'"),
    缺少答案數: await one("SELECT COUNT(DISTINCT f.question_id) AS c FROM question_flags f JOIN questions q ON q.id = f.question_id AND q.current_version = f.version WHERE f.flag IN ('missing_answer_1','missing_answer_2')"),
    含圖需看PDF數: await one("SELECT COUNT(DISTINCT f.question_id) AS c FROM question_flags f JOIN questions q ON q.id = f.question_id AND q.current_version = f.version WHERE f.flag = 'figure_dependent'"),
    分類異常數: await one("SELECT COUNT(*) AS c FROM (SELECT a.question_id FROM analyses a JOIN questions q ON q.id = a.question_id WHERE a.question_version <> q.current_version AND a.review_status IN ('pending','confirmed') UNION ALL SELECT NULL FROM vocab_suggestions WHERE status='suggested' UNION ALL SELECT NULL FROM variants WHERE verify_status='auto_failed')"),
    詞彙建議數: await one("SELECT COUNT(*) AS c FROM vocab_suggestions WHERE status = 'suggested'"),
    AI類題數: await one("SELECT COUNT(*) AS c FROM variants WHERE kind = 'ai'"),
    教師核准類題數: await one("SELECT COUNT(*) AS c FROM variants WHERE verify_status = 'teacher_confirmed'"),
    尚未分析題數: await one("SELECT COUNT(*) AS c FROM questions q WHERE NOT EXISTS (SELECT 1 FROM analyses a WHERE a.question_id = q.id AND a.review_status IN ('pending','confirmed') AND a.question_version = q.current_version)"),
  };
}

async function searchQuestions(db, f = {}) {
  const where = [];
  const args = [];
  if (f.source_bank) { where.push('q.source_bank = ?'); args.push(f.source_bank); }
  if (f.set_name) { where.push('q.set_name = ?'); args.push(f.set_name); }
  if (f.source_grade) { where.push('q.source_grade = ?'); args.push(f.source_grade); }
  if (f.q) { where.push('(q.topic LIKE ? OR q.item_no = ? OR q.id = ? OR EXISTS (SELECT 1 FROM question_versions v WHERE v.question_id = q.id AND v.version = q.current_version AND v.raw_json LIKE ?))'); args.push(`%${f.q}%`, f.q, f.q, `%${f.q}%`); }
  if (f.review_status) {
    if (f.review_status === 'none') where.push("NOT EXISTS (SELECT 1 FROM analyses a WHERE a.question_id = q.id AND a.review_status IN ('pending','confirmed'))");
    else { where.push('EXISTS (SELECT 1 FROM analyses a WHERE a.question_id = q.id AND a.review_status = ?)'); args.push(f.review_status); }
  }
  const jsonLike = (frag) => { where.push("EXISTS (SELECT 1 FROM analyses a WHERE a.question_id = q.id AND a.review_status IN ('pending','confirmed') AND a.payload_json LIKE ?)"); args.push(`%${frag}%`); };
  if (f.grade) jsonLike(`"${f.grade}"`);
  if (f.code) jsonLike(`"code":"${f.code}"`);
  if (f.unit) jsonLike(`"${f.unit}"`);
  if (f.skill) jsonLike(`"term":"${f.skill}"`);
  if (f.misconception) jsonLike(f.misconception);
  if (f.project) { where.push('EXISTS (SELECT 1 FROM course_links c WHERE c.question_id = q.id AND c.project = ?)'); args.push(f.project); }
  if (f.flag) { where.push('EXISTS (SELECT 1 FROM question_flags fl WHERE fl.question_id = q.id AND fl.version = q.current_version AND fl.flag = ?)'); args.push(f.flag); }
  const limit = Math.min(Number(f.limit) || 200, 1000);
  const sql = `SELECT q.id, q.source_bank, q.set_name, q.week, q.item_no, q.source_grade, q.topic, q.course_ref, q.current_version,
      (SELECT review_status FROM analyses a WHERE a.question_id = q.id AND a.review_status IN ('confirmed','pending','returned') ORDER BY CASE a.review_status WHEN 'confirmed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END LIMIT 1) AS analysis_status,
      (SELECT COUNT(*) FROM question_flags fl WHERE fl.question_id = q.id AND fl.version = q.current_version) AS flag_count,
      (SELECT COUNT(*) FROM variants v WHERE v.question_id = q.id AND v.kind = 'ai') AS ai_variants
    FROM questions q ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY q.source_bank, q.set_name, CAST(q.item_no AS INTEGER), q.item_no LIMIT ${limit}`;
  return db.all(sql, ...args);
}

async function facets(db) {
  const col = c => db.all(`SELECT ${c} AS v, COUNT(*) AS c FROM questions GROUP BY ${c} ORDER BY ${c}`);
  return { source_bank: await col('source_bank'), set_name: await col('set_name'), source_grade: await col('source_grade'), projects: await db.all('SELECT project AS v, COUNT(*) AS c FROM course_links GROUP BY project') };
}

module.exports = { overview, searchQuestions, facets };
