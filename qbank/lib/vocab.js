'use strict';
// 分類規準讀取。以 require 載入 JSON，Node 與 Workers（wrangler 打包）皆可用。
const curriculumJson = require('../vocab/curriculum_108_elementary.json');
const gradesJson = require('../vocab/grades.json');
const skillsJson = require('../vocab/skills.json');
const unitsJson = require('../vocab/units.json');
const activityJson = require('../vocab/activity_types.json');

let cache = null;
function loadVocab(force) {
  if (cache && !force) return cache;
  const curriculum = curriculumJson;
  const grades = gradesJson;
  const skills = skillsJson;
  const units = unitsJson;
  const activity = activityJson;
  const codeMap = new Map(curriculum.items.map(i => [i.code, i]));
  const gradeCodes = new Set(grades.teaching_grades.map(g => g.code));
  const gradeLabelToCode = new Map(grades.teaching_grades.map(g => [g.label, g.code]));
  const approvedSkills = new Set(skills.approved);
  const draftSkills = new Set(skills.draft);
  const unitCodes = new Map();
  for (const u of units.level1) unitCodes.set(u.code, { ...u, level: 1, draft: false });
  for (const u of units.level2_draft) unitCodes.set(u.code, { ...u, level: 2, draft: true });
  const unitLabelToCode = new Map([...unitCodes.values()].map(u => [u.label, u.code]));
  const activityTypes = new Set(activity.items);
  cache = {
    curriculum, grades, skills, units, activity,
    codeMap, gradeCodes, gradeLabelToCode, approvedSkills, draftSkills, unitCodes, unitLabelToCode, activityTypes,
    rubricVersion: [
      'curriculum=' + curriculum.version,
      'skills=' + skills.version,
      'units=' + units.version,
      'grades=' + grades.version,
    ].join(';'),
  };
  return cache;
}

function curriculumCodesForGrades(gradeNums, v = loadVocab()) {
  const set = new Set(gradeNums);
  return v.curriculum.items.filter(i => set.has(i.grade));
}

// 由原始「年級」欄推得可能的課綱年級範圍（只用來縮小給 AI 的代碼清單，不當成建議年級）
function gradeWindowForSourceGrade(sourceGrade, v = loadVocab()) {
  const band = v.grades.source_grade_bands.find(b => sourceGrade && sourceGrade.includes(b.label));
  if (!band) return [1, 2, 3, 4, 5, 6];
  const nums = band.covers.map(c => Number(c.slice(1)));
  const lo = Math.max(1, Math.min(...nums) - 1);
  const hi = Math.min(6, Math.max(...nums) + 1);
  const out = [];
  for (let g = lo; g <= hi; g++) out.push(g);
  return out;
}

module.exports = { loadVocab, curriculumCodesForGrades, gradeWindowForSourceGrade };
