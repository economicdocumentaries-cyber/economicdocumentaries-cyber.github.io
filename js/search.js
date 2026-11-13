// Search (SPEC 11.14, the owner's request, 2026-11-07). One box, in the header of the homepage and the Saved questions
// page, searches both classes at once: the sets' titles, descriptions, and topics; every shown question's text, choices,
// and explanation; and the study guides' titles, descriptions, and (for uploaded guides) the words inside them, from
// /guideText. Results come grouped by class, with Practice these for the matching questions (a practice exam that can
// mix sets: each copied question keeps its set and id in `src`, so Save, Report, and the question stats still go to
// the original). Each search is saved without a name in /searches, for the host console's Searches page (the owner
// asked for what students search; nothing else about the student is saved).
import { SITE_NAME } from './config.js';
import { h, fill, modal, toast, store, fmtDate, heartbeat } from './util.js';
import { groupStudyOn, connectStudent, problemText } from './firebase.js';
import { loadSets } from './sets.js';
import { withChanges, cachedChanges } from './set-changes.js';
import { thisBrowserCounts } from './analytics.js';
import { watchUploadedGuides } from './study-guides.js';
import { DEFAULT_SETTINGS, PRESETS } from './exam.js';
import { openFeedback } from './feedback.js';
import { sample } from './vary.js';

const SEARCHED = 'pe.searches'; // when this browser saved searches (times), for the daily limit
const PER_DAY = 40;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOP = new Set('a an and are as at be by for from how in into is it of on or the to what when which who why with'.split(' '));
// Words that mean the same thing, found either way: abbreviations and their spelled-out forms ("hipaa" finds "health
// insurance portability"), and everyday words for the terms the sets use ("heart attack" finds "myocardial infarction",
// "water pill" finds "diuretic"; the owner's request, 2026-11-13). A term of several words is found when a question
// has those words in a row. To add more, look at the host console's Searches page, under "Searched, but nothing found".
const SAME = [
  // Abbreviations
  ['hipaa', 'health insurance portability'], ['phi', 'protected health information'], ['ebp', 'evidence based'],
  ['qi', 'quality improvement'], ['pdsa', 'plan do study act'], ['sdoh', 'social determinants'],
  ['ada', 'americans with disabilities'], ['emtala', 'emergency medical treatment'], ['psda', 'patient self determination'],
  ['dnr', 'do not resuscitate'], ['ama', 'against medical advice'], ['sbar', 'situation background'],
  ['copd', 'chronic obstructive pulmonary'], ['chf', 'heart failure'], ['mi', 'myocardial infarction', 'heart attack'],
  ['dka', 'diabetic ketoacidosis'], ['bp', 'blood pressure'], ['hr', 'heart rate'], ['ecg', 'ekg', 'electrocardiogram'],
  ['abg', 'arterial blood gas', 'blood gas'], ['adh', 'antidiuretic hormone', 'vasopressin'],
  ['tsh', 'thyroid stimulating'], ['uti', 'urinary tract infection'], ['icp', 'intracranial pressure'],
  ['loc', 'level of consciousness'], ['gcs', 'glasgow coma'], ['rom', 'range of motion'], ['bmi', 'body mass index'],
  ['cpr', 'cardiopulmonary resuscitation'], ['iv', 'intravenous'], ['npo', 'nothing by mouth'], ['prn', 'as needed'],
  ['cns', 'central nervous system'], ['pns', 'peripheral nervous system'], ['csf', 'cerebrospinal fluid'],
  ['cva', 'cerebrovascular accident', 'stroke'], ['ppaca', 'affordable care act'], ['npa', 'nurse practice act'],
  ['tsp', 'teaspoon'], ['tbsp', 'tablespoon'], ['oz', 'ounce'], ['kg', 'kilogram'], ['lb', 'pound'], ['ml', 'milliliter'],
  ['mg', 'milligram'], ['mcg', 'microgram'], ['ldl', 'bad cholesterol'], ['hdl', 'good cholesterol'],
  ['spo2', 'oxygen saturation', 'pulse oximetry'],
  // Everyday words
  ['high blood pressure', 'high bp', 'hypertension'], ['low blood pressure', 'low bp', 'hypotension'], ['blood sugar', 'sugar', 'glucose'],
  ['low blood sugar', 'hypoglycemia'], ['high blood sugar', 'hyperglycemia'], ['blood clot', 'clot', 'thrombus', 'embolism'],
  ['water pill', 'diuretic'], ['blood thinner', 'anticoagulant'], ['kidney', 'renal'], ['swelling', 'edema'],
  ['short of breath', 'shortness of breath', 'dyspnea'], ['fast heart rate', 'tachycardia'], ['slow heart rate', 'bradycardia'],
  ['fast breathing', 'tachypnea'], ['sweating', 'sweaty', 'diaphoresis', 'diaphoretic'], ['fainting', 'passing out', 'syncope'],
  ['bruise', 'ecchymosis'], ['itching', 'itchy', 'pruritus'], ['yellow skin', 'jaundice'], ['blue lips', 'bluish', 'cyanosis'],
  ['bed sore', 'bedsore', 'pressure injury', 'pressure ulcer'], ['white blood cell', 'leukocyte'],
  ['red blood cell', 'erythrocyte'], ['platelet', 'thrombocyte'], ['adrenaline', 'epinephrine'],
  ['noradrenaline', 'norepinephrine'], ['windpipe', 'trachea'], ['voice box', 'larynx'], ['throat', 'pharynx'],
  ['armpit', 'axilla', 'axillary'], ['groin', 'inguinal'], ['belly', 'abdomen', 'abdominal'], ['nosebleed', 'epistaxis'],
  ['pink eye', 'conjunctivitis'], ['ear infection', 'otitis media'], ['ringing in the ears', 'tinnitus'],
  ['nearsighted', 'myopia'], ['farsighted', 'hyperopia'], ['hives', 'urticaria'], ['bleeding', 'hemorrhage'],
  ['throwing up', 'throw up', 'vomiting'], ['fever', 'febrile'], ['high cholesterol', 'hyperlipidemia'], ['flu', 'influenza'],
  ['tired', 'tiredness', 'fatigue'], ['sleep hormone', 'melatonin'], ['stress hormone', 'cortisol'], ['heart', 'cardiac'],
  ['lung', 'pulmonary'], ['brain', 'cerebral'], ['tylenol', 'acetaminophen'],
];
// A term's words as the query has them: without the small words ("short of breath" is "short breath").
const keyOf = term => term.split(' ').filter(w => !STOP.has(w));

// ---------- matching ----------

const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const words = s => fold(s).replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
const textOf = (...parts) => ` ${words(parts.flat(Infinity).filter(x => typeof x === 'string').join(' ')).join(' ')} `;

// What a question says, for searching: its text, choices, and explanation, whatever its type, and its topic when that's
// one topic ("Advance directives"). A combined topic ("HIPAA, PHI, FDA, and health literacy") doesn't say which part
// the question is about, so it counts only for the set.
const oneTopic = t => (typeof t === 'string' && !t.includes(',') ? t : null);
function questionText(q) {
  return textOf(q.stem, oneTopic(q.topic), q.options, q.rationale, q.text, q.tokens, q.rows, q.columns, q.items, q.passage,
    (q.blanks ?? []).map(b => b.options), q.condition?.options, q.actions?.options, q.parameters?.options);
}

// The query as groups of alternatives: every group must be found. A short word must be a whole word; a longer one can
// start a word ("consent" finds "consents"); a term in SAME finds the others in its group. Terms of several words come
// first, the longest first ("high blood pressure" before "blood pressure"), matched to the query's words in a row.
const PHRASES = SAME.flatMap(group => group.map(term => [keyOf(term), group]).filter(([key]) => key.length > 1))
  .sort((a, b) => b[0].length - a[0].length);

export function parseQuery(query) {
  let all = words(query);
  const kept = all.filter(w => !STOP.has(w));
  if (kept.length) all = kept;
  const groups = [];
  const used = all.map(() => false);
  for (const [key, group] of PHRASES) {
    for (let i = 0; i + key.length <= all.length; i++) {
      if (key.every((w, k) => all[i + k] === w && !used[i + k])) {
        key.forEach((_, k) => { used[i + k] = true; });
        groups.push([...group]);
      }
    }
  }
  all.forEach((w, i) => {
    if (used[i]) return;
    const alts = new Set([w]);
    if (w.length > 3 && w.endsWith('s')) alts.add(w.slice(0, -1));
    for (const group of SAME) if (group.some(term => alts.has(term))) group.forEach(term => alts.add(term));
    groups.push([...alts]);
  });
  return groups;
}

// A word of 2 letters or fewer must be a whole word; anything longer can start a word.
const found = (text, alt) => text.includes(alt.length <= 2 ? ` ${alt} ` : ` ${alt}`);
export const matches = (text, groups) => groups.length > 0 && groups.every(alts => alts.some(a => found(text, a)));

// Everything searchable, built once per page: sets (with the host's changes, hidden ones left out) and guides.
function buildIndex(sets, courses, guides) {
  const visible = withChanges(sets, cachedChanges(), courses).filter(s => !s.hidden);
  return {
    sets: visible.map(set => ({
      set,
      text: textOf(set.title, set.description, set.exam, [...new Set(set.questions.map(q => q.topic))]),
      questions: set.questions.filter(q => !q.hidden).map(q => ({ q, text: questionText(q) })),
    })),
    guides: guides.map(g => ({ g, text: textOf(g.title, g.description, g.exam) })),
  };
}

// The results, by class (in the class list's order, then Other): each set with its matching questions, and guides.
export function search(index, courses, query, guideWords = {}) {
  const groups = parseQuery(query);
  const classes = [...courses.map(c => ({ key: c.code, course: c })), { key: 'other', course: null }]
    .map(c => ({ ...c, sets: [], guides: [], count: 0 }));
  const forCourse = code => classes.find(c => c.course && code && c.course.code.toLowerCase() === code.toLowerCase()) ?? classes.at(-1);
  if (!groups.length) return { groups, classes: [] };
  for (const { set, text, questions } of index.sets) {
    const hits = questions.filter(x => matches(x.text, groups)).map(x => x.q);
    const setHit = matches(text, groups);
    if (!hits.length && !setHit) continue;
    forCourse(set.course).sets.push({ set, hits });
  }
  // A guide matches by its title and description, or by the distinct words inside it (/guideText), where a phrase
  // counts when each of its words is there.
  for (const { g, text } of index.guides) {
    const inside = g.id && guideWords[g.id] ? ` ${guideWords[g.id]} ` : '';
    const has = alt => found(text, alt) || (inside && alt.split(' ').every(w => found(inside, w)));
    if (groups.every(alts => alts.some(has))) forCourse(g.course).guides.push(g);
  }
  // A practice exam or mock exam copies questions from the topic sets, keeping their ids: the class's count and its
  // Practice these give each question once, from its topic set.
  const combined = set => (/practice-exam|mock-exam/.test(set.id) ? 1 : 0);
  for (const c of classes) {
    c.sets.sort((a, b) => b.hits.length - a.hits.length);
    const seen = new Set();
    c.unique = [...c.sets].sort((a, b) => combined(a.set) - combined(b.set))
      .map(({ set, hits }) => ({ set, hits: hits.filter(q => !seen.has(`${q.id}|${q.stem}`) && seen.add(`${q.id}|${q.stem}`)) }))
      .filter(x => x.hits.length);
    c.count = c.unique.reduce((n, x) => n + x.hits.length, 0);
  }
  return { groups, classes: classes.filter(c => c.sets.length || c.guides.length) };
}

// ---------- "Did you mean …?" (the owner's request, 2026-11-13) ----------

// Every word the index has, with how often it appears, for suggesting a spelling.
export function vocabulary(index, guideWords = {}) {
  const counts = new Map();
  const add = text => {
    for (const w of String(text).split(' ')) if (w.length > 1) counts.set(w, (counts.get(w) ?? 0) + 1);
  };
  for (const s of index.sets) {
    add(s.text);
    for (const x of s.questions) add(x.text);
  }
  for (const g of index.guides) add(g.text);
  Object.values(guideWords).forEach(add);
  SAME.flat().forEach(add);
  return counts;
}

// The number of one-letter changes (add, drop, replace, or swap two side by side) between two words, up to max + 1.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      row[j] = d;
      least = Math.min(least, d);
    }
    if (least > max) return max + 1;
    before = prev;
    prev = row;
  }
  return prev[b.length];
}

// Spellings that sound alike, the usual way medical words get misspelled: "diafram" for diaphragm, "hipoglycemia",
// "oedema", "trakea".
const sound = w => w.replace(/ph/g, 'f').replace(/ae|oe/g, 'e').replace(/y/g, 'i').replace(/ck|ch/g, 'k');

// The query with each word that nothing on the site starts with replaced by the closest word the site has: one change
// away for a word of 4 or 5 letters, two for a longer one, counting a sound-alike spelling as no change. A tie goes to
// the word that sounds alike, then the one with the same first letter, then the more common one. Null when no word
// needed it, or none was close enough. Short words and numbers are left alone.
export function suggestQuery(query, vocab) {
  const keys = [...vocab.keys()];
  let changed = false;
  const out = words(query).map(w => {
    if (STOP.has(w) || w.length < 4 || /\d/.test(w) || keys.some(v => v.startsWith(w))) return w;
    const max = w.length <= 5 ? 1 : 2;
    const ws = sound(w);
    let best = null;
    let rank = null;
    for (const [v, n] of vocab) {
      if (v.length < 3 || Math.abs(v.length - w.length) > max + 1) continue;
      const plain = distance(w, v, max);
      const alike = distance(ws, sound(v), max);
      const d = Math.min(plain, alike);
      if (d > max) continue;
      const r = [d, alike < plain ? 0 : 1, v[0] === w[0] ? 0 : 1, -n];
      const k = r.findIndex((x, i) => x !== rank?.[i]);
      if (!rank || (k >= 0 && r[k] < rank[k])) {
        best = v;
        rank = r;
      }
    }
    if (best) changed = true;
    return best ?? w;
  });
  return changed ? out.join(' ') : null;
}

// ---------- previews (the owner's request, 2026-11-13) ----------

const plainOf = html => new DOMParser().parseFromString(String(html ?? ''), 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The query's words, found the way search finds them: a short word whole, a longer one at the start of a word, and a
// phrase's words in a row, with anything but letters and digits between them.
export function wordPattern(groups) {
  const alts = [...new Set(groups.flat())].sort((a, b) => b.length - a.length)
    .map(a => a.split(' ').map(escapeRe).join('[^a-z0-9]+') + (a.length <= 2 ? '(?![a-z0-9])' : ''));
  return alts.length ? new RegExp(`(^|[^a-z0-9])(${alts.join('|')})`, 'gi') : null;
}

// Text with the pattern's matches in <mark>.
function marked(text, pattern) {
  const out = [];
  let last = 0;
  pattern.lastIndex = 0; // matchAll starts where the pattern's last search stopped
  for (const m of text.matchAll(pattern)) {
    const at = m.index + m[1].length;
    if (at > last) out.push(text.slice(last, at));
    out.push(h('mark', m[2]));
    last = at + m[2].length;
  }
  out.push(text.slice(last));
  return out;
}

// A short piece of a question, around the first place the query matches it (the stem first, then its sentence, choices,
// rows, steps, passage, and rationale), with the query's words marked. Numbers that change show their sample.
export function preview(q, pattern) {
  const shown = sample(q);
  const parts = [shown.stem, String(shown.text ?? '').replace(/\{\{\d+\}\}/g, '___'), shown.options, shown.rows, shown.items,
    String(shown.passage ?? '').replace(/\[\[|\]\]/g, ''), shown.rationale];
  for (const part of parts) {
    const text = Array.isArray(part) ? part.map(plainOf).join(' · ') : plainOf(part);
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    if (!m) continue;
    const at = m.index + m[1].length;
    let start = Math.max(0, at - 60);
    if (start > 0) start = text.indexOf(' ', start) + 1 || start;
    let end = Math.min(text.length, start + 170);
    if (end < text.length) end = Math.max(text.lastIndexOf(' ', end), at + m[2].length);
    return [start > 0 ? '…' : '', ...marked(text.slice(start, end), pattern), end < text.length ? '…' : ''];
  }
  return null;
}

// ---------- practice from the results ----------

// A practice exam of matching questions from one or more sets. Ids get their set's id in front, so two sets' "q1"
// can't collide; `src` remembers where each came from.
export function practiceSet(course, parts, query) {
  const questions = [];
  const cases = {};
  for (const { set, hits } of parts) {
    for (const q of hits) {
      const copy = { ...q, id: `${set.id}--${q.id}`, src: { set: set.id, title: set.title, id: q.id } };
      if (q.case) {
        copy.case = `${set.id}--${q.case}`;
        if (set.cases?.[q.case]) cases[copy.case] = set.cases[q.case];
      }
      questions.push(copy);
    }
  }
  return {
    id: `search--${course?.code ?? 'other'}`,
    title: `Practice: “${query}”`,
    course: course?.code ?? null,
    exam: null,
    timeMinutes: Math.max(1, Math.round(questions.length * 1.5)),
    questions,
    cases,
  };
}

const practiceSettings = ids => ({ ...DEFAULT_SETTINGS, ...PRESETS.practice, preset: 'practice', only: ids });

// ---------- saving searches (for the host's Searches page) ----------

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function recordSearch(query, questions, guides) {
  const q = words(query).join(' ').slice(0, 60);
  if (!q || !groupStudyOn() || !thisBrowserCounts()) return; // the host's own browser doesn't count
  const today = (store.get(SEARCHED, []) ?? []).filter(t => typeof t === 'number' && Date.now() - t < DAY_MS);
  if (today.length >= PER_DAY) return;
  store.set(SEARCHED, [...today, Date.now()]);
  connectStudent()
    .then(db => db.write(`searches/${newId()}`, { q, n: Math.min(questions, 100000), g: Math.min(guides, 10000), at: db.serverTime() }))
    .catch(() => {});
}

// The words inside uploaded guides (/guideText/<id>/words), read once per page.
let guideWordsLoading = null;
function loadGuideWords() {
  if (!groupStudyOn()) return Promise.resolve({});
  guideWordsLoading ??= connectStudent()
    .then(db => db.read('guideText'))
    .then(value => Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => typeof v?.words === 'string').map(([id, v]) => [id, v.words])))
    .catch(() => ({}));
  return guideWordsLoading;
}

// ---------- the box ----------

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';

// The search box for a page's header. On the results page, typing updates the results as you go.
export function searchBox(value = '', onType = null) {
  const input = h('input.search-input', {
    type: 'search', name: 'q', value, autocomplete: 'off', enterkeyhint: 'search', maxlength: '80',
    placeholder: 'Search: HIPAA, heart sounds, consent…', 'aria-label': 'Search question sets, questions, and study guides',
  });
  const form = h('form.search-form', { role: 'search' }, h('span.search-icon', { 'aria-hidden': 'true', html: ICON }), input,
    h('button.search-go', { type: 'submit' }, 'Search'));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return input.focus();
    if (onType) onType(q, true);
    else location.hash = `#/search/${encodeURIComponent(q)}`;
  });
  if (onType) input.addEventListener('input', () => onType(input.value.trim(), false));
  return { form, input };
}

// ---------- the results page ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Up to 3 previews of a set's matching questions, each a short piece with the search words marked.
function previewList(questions, pattern) {
  const items = pattern ? questions.slice(0, 3).map(q => preview(q, pattern)).filter(Boolean) : [];
  return items.length ? h('ul.search-previews', items.map(p => h('li.search-preview', p))) : null;
}

// #/search/<words>. helpers: { page, begin, guideRow } from app.js.
export async function searchView(root, { args, isCurrent }, { page, begin, guideRow }) {
  let query = (args[0] ?? '').trim();
  document.title = `Search · ${SITE_NAME}`;
  const main = h('main.wrap.search-page', heartbeat('Searching…'));
  root.replaceChildren(page(main));
  const { sets, courses, guides } = await loadSets();
  if (!isCurrent()) return;
  let uploaded = [];
  let guideWords = {};
  let index = buildIndex(sets, courses, guides);
  const results = h('div.search-results', { 'aria-live': 'polite' });
  const title = h('h1.page-title');
  // A search is saved when the student presses Enter, stops typing for a moment, or leaves the page; a search from
  // another page's box waits that moment too, so the uploaded guides it finds are counted.
  const later = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1500);
  };
  const box = searchBox(query, (q, submitted) => {
    query = q;
    history.replaceState(history.state, '', `#/search/${encodeURIComponent(q)}`);
    paint();
    if (submitted) save();
    else later();
  });
  root.querySelector('.topbar-inner')?.append(box.form);
  const note = groupStudyOn() ? h('p.search-note', 'Searches are saved without names, so the site can add more of what students look for.') : null;
  fill(main, title, results, note);
  let last = null;
  let saved = '';
  let saveTimer = null;
  let vocab = null; // the site's words, for "Did you mean", made the first time a search finds nothing

  // Runs a suggested search as if the student had typed it and pressed Enter.
  function useQuery(q) {
    query = q;
    box.input.value = q;
    history.replaceState(history.state, '', `#/search/${encodeURIComponent(q)}`);
    paint();
    save();
    box.input.focus();
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!last || words(query).join(' ') === saved) return;
    saved = words(query).join(' ');
    recordSearch(query, last.classes.reduce((n, c) => n + c.count, 0), last.classes.reduce((n, c) => n + c.guides.length, 0));
  }

  function paint() {
    title.textContent = query ? `Results for “${query}”` : 'Search';
    if (!query) {
      fill(results, h('p.lead', 'Type a word or two, like HIPAA, consent, or heart sounds. Both classes are searched.'));
      last = null;
      return;
    }
    last = search(index, courses, query, guideWords);
    if (!last.classes.length) {
      // A misspelled word gets a suggestion, offered only when the suggestion finds something.
      vocab ??= vocabulary(index, guideWords);
      const better = suggestQuery(query, vocab);
      const helps = better && search(index, courses, better, guideWords).classes.length > 0;
      fill(results,
        h('p.lead', `Nothing matched “${query}”.`, helps
          ? [' Did you mean ', h('button.link-button.search-suggest', { type: 'button', onclick: () => useQuery(better) }, better), '?']
          : ' Check the spelling, or try fewer or shorter words.'),
        groupStudyOn() ? h('p', h('button.link-button', { type: 'button', onclick: () => openFeedback(`Could you add questions about ${query}?`) },
          'Ask for questions on this topic')) : null);
      return;
    }
    const pattern = wordPattern(last.groups);
    fill(results, last.classes.map(c => {
      // Previews come from the questions a set adds to the class's count, so a practice exam doesn't repeat its topic
      // sets' questions.
      const fresh = new Map(c.unique.map(x => [x.set, x.hits]));
      const name = c.course ? c.course.name : 'More practice';
      const inSets = c.unique;
      const summary = [c.count ? `${plural(c.count, 'question')} in ${plural(inSets.length, 'set')}` : null,
        c.guides.length ? plural(c.guides.length, 'study guide') : null].filter(Boolean).join(' · ');
      const all = practiceSet(c.course, inSets, query);
      return h('section.search-class', { 'aria-label': name },
        h('div.search-class-head',
          h('div', h('h2.section-title', name), c.course ? h('p.set-meta', `${c.course.code} · ${summary}`) : h('p.set-meta', summary)),
          c.count ? h('button.btn.btn-accent', { type: 'button', onclick: () => begin(all, practiceSettings(all.questions.map(q => q.id)), null, 'search') },
            `Practice these ${c.count}`) : null),
        c.sets.length ? h('ul.set-list', c.sets.map(({ set, hits }) => h('li.set-row.search-row',
          h('div.set-info',
            set.exam ? h('p.set-exam', h('span.tag', set.exam)) : null,
            h('h3', set.title),
            h('p.set-meta', hits.length ? `${hits.length} of ${set.questions.length} questions match` : 'The title or topics match'),
            previewList(fresh.get(set) ?? [], pattern)),
          // A set with all the class's matches leaves Practice these to the class's button above.
          h('div.set-actions',
            hits.length && hits.length !== c.count ? h('button.btn.btn-accent', { type: 'button', onclick: () => begin(set, practiceSettings(hits.map(q => q.id)), null, 'search') },
              `Practice these ${hits.length}`) : null,
            h('a.btn', { href: `#/setup/${encodeURIComponent(set.id)}` }, 'Start the set'))))) : null,
        c.guides.length ? [h('h3.search-sub', 'Study guides'), h('ul.set-list', c.guides.map(guideRow))] : null);
    }));
  }

  paint();
  if (query) later();
  // Uploaded guides, and the words inside them, arrive from Firebase a moment later.
  const stopGuides = watchUploadedGuides(courses, list => {
    uploaded = list;
    index = buildIndex(sets, courses, [...guides, ...uploaded]);
    vocab = null;
    paint();
  });
  loadGuideWords().then(w => {
    guideWords = w;
    vocab = null;
    if (isCurrent()) paint();
  });
  box.input.focus();
  return () => {
    if (saveTimer) save();
    stopGuides();
  };
}

// ---------- the host ----------

// The host console's Searches page (#/host/searches): the top searches of the last 30 days, the ones that found
// nothing, and the latest, with Clear all. Returns a function that stops it.
export function searchesConsole(section, db, accountLine) {
  const body = h('div.searches-body', h('p.lead', 'Loading…'));
  fill(section,
    h('h1.page-title', 'Searches'),
    h('p.lead', 'What students searched for on the site, without names, so you can see what they look for and what\'s missing. Your own searches aren\'t counted.'),
    body, accountLine());
  const stop = db.watch('searches', value => {
    const all = Object.entries(value && typeof value === 'object' ? value : {})
      .map(([id, s]) => ({ id, ...s })).filter(s => typeof s.q === 'string')
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const recent = all.filter(s => (s.at ?? 0) > Date.now() - 30 * DAY_MS);
    const tally = list => [...list.reduce((m, s) => m.set(s.q, (m.get(s.q) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
    const top = tally(recent).slice(0, 30);
    const none = tally(recent.filter(s => !s.n && !s.g)).slice(0, 30);
    const table = rows => h('table.searches-table', h('thead', h('tr', h('th', 'Search'), h('th', 'Times'))),
      h('tbody', rows.map(([q, n]) => h('tr', h('td', q), h('td', String(n))))));
    fill(body, !all.length ? h('p.empty-note', 'No searches yet. They appear here as soon as a student searches.') : [
      h('h2.section-title', 'Top searches (last 30 days)'), top.length ? table(top) : h('p.empty-note', 'None in the last 30 days.'),
      h('h2.section-title', 'Searched, but nothing found'), none.length ? table(none)
        : h('p.empty-note', 'Every search in the last 30 days found something.'),
      h('h2.section-title', 'Latest searches'),
      h('ul.searches-latest', all.slice(0, 40).map(s => h('li', h('b', s.q), ` · ${plural(s.n ?? 0, 'question')}, ${plural(s.g ?? 0, 'guide')}`,
        s.at ? ` · ${fmtDate(s.at)}` : ''))),
      h('div.form-actions', h('button.btn', { type: 'button', onclick: clearAll }, 'Clear all searches'))]);
  }, err => fill(body, h('p', `The searches couldn't be loaded. ${problemText(err)}`)));

  async function clearAll() {
    const choice = await modal({
      title: 'Clear All Searches?',
      message: 'Every saved search will be deleted for good. New searches will still be saved.',
      buttons: [{ label: 'Keep them', value: 'keep', accent: true }, { label: 'Clear all', value: 'clear' }],
    });
    if (choice !== 'clear') return;
    try {
      await db.write('searches', null);
      toast('The searches were cleared.');
    } catch (err) {
      toast(`They weren't cleared. ${problemText(err)}`, 9000);
    }
  }
  return stop;
}
