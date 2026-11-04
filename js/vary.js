// Questions whose numbers change on each attempt (SPEC 5.5; the owner's
// request, 2026-11-03), so students can't memorize a math answer. A question
// with "vars" lists the values each number can take:
//   "vars": { "oz": [4, 6, 8], "part": [{ "value": 0.75, "text": "3/4" }, { "value": 0.5, "text": "1/2" }] }
// and its text uses them: {oz} shows a value (or its "text"), and {=oz * 30}
// works a number out (+ - * / and parentheses; round(x, places), floor, ceil,
// min, max). A fill in the blank question's "answer" is a formula like
// "=oz * 30 * part", rounded to "decimals" places, and its rationale can show
// {answer}. A multiple choice question works out each choice the same way;
// its "answer" is still the right choice's number. Only fill in the blank and
// multiple choice questions can have them.
//
// An attempt picks the numbers when it starts (exam.js), so the attempt, its
// review, and its history keep the same ones. Group study seeds them by the
// session, so everyone sees the same numbers; saved questions and the host's
// pages show one fixed sample (sample()).
import { seededRandom } from './util.js';

const NAME = /^[A-Za-z_]\w*$/;
const PLACE = /\{(=[^{}]+|[A-Za-z_]\w*)\}/g; // {name} or {=formula}; {{0}} blanks never match
const FIELDS = ['stem', 'rationale', 'instruction', 'unit'];
const MAX_CHECKED = 4000; // combinations checked one by one; beyond that, a sample

// Half up, the way the class rounds (Rounding Rules: 5 or more rounds up), done
// on the number's decimal form so 1.005 becomes 1.01.
export function roundTo(x, places = 0) {
  let n = Number(`${Math.round(Number(`${x}e${places}`))}e-${places}`);
  if (!Number.isFinite(n)) n = Math.round(x * 10 ** places) / 10 ** places;
  return Object.is(n, -0) ? 0 : n;
}

const FUNCS = { round: (x, places = 0) => roundTo(x, places), floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max };
const RESERVED = new Set(['answer', ...Object.keys(FUNCS)]);

// A number as students read it: 1,500 · 0.75 · 31.25 (no trailing zeros, always a leading zero).
export const fmt = (x, places = 4) => roundTo(x, places).toLocaleString('en-US', { maximumFractionDigits: places });

export const isVaried = q => !!q && typeof q === 'object' && !Array.isArray(q) && q.vars != null;

// ---------- formulas ----------

function tokens(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|([A-Za-z_]\w*)|([-+*/(),]))/y;
  let i = 0;
  while (i < src.length && !/^\s*$/.test(src.slice(i))) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`"${src.slice(i).trim()[0]}" isn't allowed`);
    out.push(m[1] != null ? { num: Number(m[1]) } : m[2] != null ? { name: m[2] } : { op: m[3] });
    i = re.lastIndex;
  }
  return out;
}

// A formula as a small tree, or an error in plain words.
function compile(src) {
  const t = tokens(String(src));
  let p = 0;
  const take = op => (t[p]?.op === op ? (p++, true) : false);
  const shown = tok => tok.op ?? tok.name ?? tok.num;
  function sum() {
    let node = product();
    for (;;) {
      if (take('+')) node = ['+', node, product()];
      else if (take('-')) node = ['-', node, product()];
      else return node;
    }
  }
  function product() {
    let node = unary();
    for (;;) {
      if (take('*')) node = ['*', node, unary()];
      else if (take('/')) node = ['/', node, unary()];
      else return node;
    }
  }
  function unary() {
    if (take('-')) return ['neg', unary()];
    if (take('+')) return unary();
    return primary();
  }
  function primary() {
    const tok = t[p++];
    if (!tok) throw new Error('it ends too soon');
    if ('num' in tok) return ['num', tok.num];
    if ('name' in tok) {
      if (!take('(')) return ['var', tok.name];
      if (!(tok.name in FUNCS)) throw new Error(`there's no ${tok.name}()`);
      const args = [];
      if (!take(')')) {
        do args.push(sum()); while (take(','));
        if (!take(')')) throw new Error('a ")" is missing');
      }
      return ['call', tok.name, args];
    }
    if (tok.op === '(') {
      const inner = sum();
      if (!take(')')) throw new Error('a ")" is missing');
      return inner;
    }
    throw new Error(`"${shown(tok)}" is out of place`);
  }
  const tree = sum();
  if (p < t.length) throw new Error(`"${shown(t[p])}" is out of place`);
  return tree;
}

function evaluate(node, env) {
  switch (node[0]) {
    case 'num': return node[1];
    case 'var':
      if (!(node[1] in env)) throw new Error(`there's no number called ${node[1]}`);
      return env[node[1]];
    case 'neg': return -evaluate(node[1], env);
    case 'call': return FUNCS[node[1]](...node[2].map(a => evaluate(a, env)));
    default: {
      const a = evaluate(node[1], env);
      const b = evaluate(node[2], env);
      return node[0] === '+' ? a + b : node[0] === '-' ? a - b : node[0] === '*' ? a * b : a / b;
    }
  }
}

// The names a formula uses.
function namesIn(node, out = new Set()) {
  if (node[0] === 'var') out.add(node[1]);
  else if (node[0] === 'call') node[2].forEach(a => namesIn(a, out));
  else if (node[0] !== 'num') node.slice(1).forEach(n => namesIn(n, out));
  return out;
}

function work(src, env) {
  const x = evaluate(compile(src), env);
  if (!Number.isFinite(x)) throw new Error(`"${src}" doesn't give a number`);
  return x;
}

// ---------- making a question with its numbers ----------

const valueOf = v => (typeof v === 'number' ? v : v.value);

function concrete(q, picks) {
  const env = {};
  const shown = {};
  for (const [name, list] of Object.entries(q.vars)) {
    const v = list[picks[name]];
    env[name] = valueOf(v);
    shown[name] = typeof v === 'number' ? fmt(v) : String(v.text);
  }
  const out = { ...q };
  delete out.vars;
  delete out.decimals;
  out.varied = { ...picks }; // which values this copy got, by their place in each list
  if (q.type === 'fill') {
    const places = q.decimals ?? 0;
    env.answer = roundTo(work(String(q.answer).replace(/^\s*=/, ''), env), places);
    shown.answer = fmt(env.answer, places);
    out.answer = env.answer;
  }
  const put = text => text.replace(PLACE, (whole, inner) =>
    inner[0] === '=' ? fmt(work(inner.slice(1), env)) : inner in shown ? shown[inner] : whole);
  for (const key of FIELDS) if (typeof q[key] === 'string') out[key] = put(q[key]);
  if (Array.isArray(q.options)) out.options = q.options.map(o => put(String(o)));
  return out;
}

// The question with numbers picked by random(): a plain question any part of
// the site can show and score. A question without "vars" comes back as it is.
export function vary(q, random = Math.random) {
  if (!isVaried(q)) return q;
  const picks = Object.fromEntries(Object.entries(q.vars).map(([name, list]) => [name, Math.min(list.length - 1, Math.floor(random() * list.length))]));
  return concrete(q, picks);
}

// The same numbers every time, for pages that show a question outside an
// attempt (saved questions, the host's pages).
export const sample = q => (isVaried(q) ? vary(q, seededRandom(`sample|${q.id}`)) : q);

// ---------- checks (items.js validateQuestion) ----------

function* combinations(vars) {
  const names = Object.keys(vars);
  const sizes = names.map(n => vars[n].length);
  const total = sizes.reduce((a, b) => a * b, 1);
  if (total <= MAX_CHECKED) {
    for (let k = 0; k < total; k++) {
      let rest = k;
      yield Object.fromEntries(names.map((n, i) => {
        const pick = rest % sizes[i];
        rest = Math.floor(rest / sizes[i]);
        return [n, pick];
      }));
    }
  } else {
    const random = seededRandom('combinations');
    for (let k = 0; k < MAX_CHECKED; k++) yield Object.fromEntries(names.map((n, i) => [n, Math.floor(random() * sizes[i])]));
  }
}

const describe = (vars, picks) => Object.entries(picks).map(([n, i]) => {
  const v = vars[n][i];
  return `${n} ${typeof v === 'number' ? fmt(v) : v.text}`;
}).join(', ');

const isText = v => typeof v === 'string' && v.trim().length > 0;
const goodValue = v => (typeof v === 'number' && Number.isFinite(v)) || (!!v && typeof v === 'object' && typeof v.value === 'number' && Number.isFinite(v.value) && isText(v.text));

// Problems with a question's changing numbers, in plain words.
export function varyProblems(q) {
  const problems = [];
  const add = p => {
    if (!problems.includes(p) && problems.length < 6) problems.push(p);
  };
  if (!['fill', 'mc'].includes(q.type)) return ['Changing numbers ("vars") work only in fill in the blank and multiple choice questions.'];
  const vars = q.vars;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars) || !Object.keys(vars).length) {
    return ['"vars" must list each changing number and the values it can take, like { "oz": [4, 6, 8] }.'];
  }
  if (Object.keys(vars).length > 8) add('"vars" can have 8 changing numbers at most.');
  for (const [name, list] of Object.entries(vars)) {
    if (!NAME.test(name) || RESERVED.has(name)) add(`"vars": "${name}" can't be the name of a number. Use letters, like "oz" (not answer, round, floor, ceil, min, or max).`);
    if (!Array.isArray(list) || !list.length || list.length > 20) add(`"vars": "${name}" needs a list of 1 to 20 values, like [4, 6, 8].`);
    else if (!list.every(goodValue)) add(`"vars": each value of "${name}" must be a number, or a number with the words to show, like { "value": 0.75, "text": "3/4" }.`);
  }
  if (q.type === 'fill') {
    if (typeof q.answer !== 'string' || !/^\s*=/.test(q.answer)) add('With "vars", "answer" is a formula in quotes that starts with =, like "=oz * 30".');
    if (!Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 4) add('With "vars", "decimals" is how many decimal places the answer is rounded to: 0 for a whole number, 1 for tenths, 2 for hundredths.');
  }
  if (problems.length) return problems;
  // Every {name} and formula reads, and uses only the question's numbers.
  const where = [...FIELDS.filter(k => typeof q[k] === 'string').map(k => [k[0].toUpperCase() + k.slice(1), q[k]]),
    ...(Array.isArray(q.options) ? q.options.map((o, i) => [`Choice ${i + 1}`, String(o)]) : [])];
  const formulas = q.type === 'fill' ? [['"answer"', q.answer.replace(/^\s*=/, ''), false]] : [];
  for (const [label, text] of where) {
    for (const m of text.matchAll(PLACE)) {
      if (m[1][0] === '=') formulas.push([label, m[1].slice(1), true]);
      else if (!(m[1] in vars) && !(m[1] === 'answer' && q.type === 'fill')) add(`${label} has {${m[1]}}, but "vars" has no number called ${m[1]}.`);
    }
  }
  for (const [label, src, answerOk] of formulas) {
    try {
      for (const n of namesIn(compile(src))) {
        if (!(n in vars) && !(answerOk && n === 'answer' && q.type === 'fill')) add(`${label}: the formula "${src}" uses ${n}, which isn't in "vars".`);
      }
    } catch (err) {
      add(`${label}: the formula "${src}" can't be read (${err.message}).`);
    }
  }
  if (problems.length) return problems;
  // Every combination of values gives a good question.
  for (const picks of combinations(vars)) {
    let c;
    try {
      c = concrete(q, picks);
    } catch (err) {
      add(`With ${describe(vars, picks)}, ${err.message}.`);
      break;
    }
    if (q.type === 'fill' && !(c.answer > 0)) add(`With ${describe(vars, picks)}, the answer comes out as ${c.answer}. It must be more than 0.`);
    if (q.type === 'mc' && new Set(c.options).size < c.options.length) add(`With ${describe(vars, picks)}, two choices come out the same: ${c.options.join(' · ')}.`);
    if (problems.length) break;
  }
  return problems;
}
