'use strict';
// 安全的算術驗算：只接受數字、+ - * / ^ ( ) 與空白，不用 eval。

function tokenize(expr) {
  const tokens = [];
  const s = expr.replace(/[×]/g, '*').replace(/[÷]/g, '/').replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[－−]/g, '-').replace(/[＋]/g, '+');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = s.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(num)) throw new Error('數字格式錯誤：' + num);
      tokens.push({ t: 'num', v: Number(num) }); i = j; continue;
    }
    if ('+-*/^()'.includes(ch)) { tokens.push({ t: ch }); i++; continue; }
    throw new Error('不允許的字元：' + ch);
  }
  return tokens;
}

// 遞迴下降：expr = term (('+'|'-') term)*; term = factor (('*'|'/') factor)*; factor = unary ('^' factor)?; unary = '-' unary | primary
function evaluate(expr) {
  if (typeof expr !== 'string' || !expr.trim()) throw new Error('算式為空');
  if (expr.length > 500) throw new Error('算式過長');
  const tk = tokenize(expr);
  let p = 0;
  const peek = () => tk[p];
  const next = () => tk[p++];
  function primary() {
    const t = next();
    if (!t) throw new Error('算式不完整');
    if (t.t === 'num') return t.v;
    if (t.t === '(') { const v = sum(); const c = next(); if (!c || c.t !== ')') throw new Error('括號未關閉'); return v; }
    throw new Error('語法錯誤');
  }
  function unary() { if (peek() && peek().t === '-') { next(); return -unary(); } if (peek() && peek().t === '+') { next(); return unary(); } return primary(); }
  function factor() { const b = unary(); if (peek() && peek().t === '^') { next(); const e = factor(); if (Math.abs(e) > 64) throw new Error('指數過大'); return Math.pow(b, e); } return b; }
  function term() { let v = factor(); while (peek() && (peek().t === '*' || peek().t === '/')) { const op = next().t; const r = factor(); if (op === '/' && r === 0) throw new Error('除以零'); v = op === '*' ? v * r : v / r; } return v; }
  function sum() { let v = term(); while (peek() && (peek().t === '+' || peek().t === '-')) { const op = next().t; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  const v = sum();
  if (p !== tk.length) throw new Error('算式多出無法解析的部分');
  if (!Number.isFinite(v)) throw new Error('結果不是有限數');
  return v;
}

// 從答案文字抽第一個數（支援整數、小數、簡單分數 a/b、百分比）
function firstNumber(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).replace(/[，,]/g, '');
  const frac = s.match(/(\d+)\s*\/\s*(\d+)/);
  const m = s.match(/-?\d+(\.\d+)?/);
  if (frac && (!m || s.indexOf(frac[0]) <= s.indexOf(m[0]))) return Number(frac[1]) / Number(frac[2]);
  if (!m) return null;
  const n = Number(m[0]);
  return /%/.test(s.slice(m.index, m.index + m[0].length + 2)) ? n / 100 : n;
}

function nearlyEqual(a, b) { return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)); }

// 對類題做獨立驗算。回傳 { status, detail }：
// auto_passed：算式結果＝expected＝答案中的數；auto_failed：任一不符；unverified：沒有可用算式（圖形題、開放題等）
function verifyVariant(variant) {
  const check = variant.check || {};
  if (!check || check.type !== 'arithmetic' || !check.expression) {
    return { status: 'unverified', detail: '沒有可由程式獨立計算的算式（type 非 arithmetic）；需教師人工驗證' };
  }
  let value;
  try { value = evaluate(String(check.expression)); }
  catch (e) { return { status: 'auto_failed', detail: '算式無法計算：' + e.message }; }
  const expected = firstNumber(check.expected);
  const answerNum = firstNumber(variant.answer);
  const problems = [];
  if (expected === null) problems.push('expected 沒有數值');
  else if (!nearlyEqual(value, expected)) problems.push(`算式結果 ${value} ≠ expected ${expected}`);
  if (answerNum === null) problems.push('答案文字中沒有數值可比對');
  else if (!nearlyEqual(value, answerNum)) problems.push(`算式結果 ${value} ≠ 答案中的數 ${answerNum}`);
  if (problems.length) return { status: 'auto_failed', detail: problems.join('；'), computed: value };
  return { status: 'auto_passed', detail: `算式 ${check.expression} = ${value}，與答案一致（僅驗算數值，題意合理性仍需教師確認）`, computed: value };
}

module.exports = { evaluate, firstNumber, verifyVariant };
