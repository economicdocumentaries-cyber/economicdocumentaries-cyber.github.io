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

const SEARCHED = 'pe.searches'; // when this browser saved searches (times), for the daily limit
const PER_DAY = 40;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOP = new Set('a an and are as at be by for from how in into is it of on or the to what when which who why with'.split(' '));
// Abbreviations and their spelled-out forms, found either way ("hipaa" finds "health insurance portability").
const SYNONYMS = [
  ['hipaa', 'health insurance portability'], ['phi', 'protected health information'], ['ebp', 'evidence based'],
  ['qi', 'quality improvement'], ['pdsa', 'plan do study act'], ['sdoh', 'social determinants'],
  ['ada', 'americans with disabilities'], ['emtala', 'emergency medical treatment'], ['psda', 'patient self determination'],
  ['dnr', 'do not resuscitate'], ['ama', 'against medical advice'], ['sbar', 'situation background'],
  ['copd', 'chronic obstructive pulmonary'], ['chf', 'heart failure'], ['mi', 'myocardial infarction'],
  ['dka', 'diabetic ketoacidosis'], ['bp', 'blood pressure'], ['hr', 'heart rate'], ['ecg', 'electrocardiogram'],
  ['ekg', 'electrocardiogram'], ['ecg', 'ekg'], ['abg', 'arterial blood gas'], ['adh', 'antidiuretic hormone'],
  ['tsh', 'thyroid stimulating'], ['uti', 'urinary tract infection'], ['icp', 'intracranial pressure'],
  ['loc', 'level of consciousness'], ['gcs', 'glasgow coma'], ['rom', 'range of motion'], ['bmi', 'body mass index'],
  ['cpr', 'cardiopulmonary resuscitation'], ['iv', 'intravenous'], ['npo', 'nothing by mouth'], ['prn', 'as needed'],
  ['cns', 'central nervous system'], ['pns', 'peripheral nervous system'], ['csf', 'cerebrospinal fluid'],
];

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
// start a word ("consent" finds "consents"); an abbreviation or its spelled-out form finds either.
export function parseQuery(query) {
  let all = words(query);
  const kept = all.filter(w => !STOP.has(w));
  if (kept.length) all = kept;
  const joined = ` ${all.join(' ')} `;
  const groups = [];
  const used = new Set();
  for (const [abbr, phrase] of SYNONYMS) {
    if (joined.includes(` ${phrase} `)) {
      groups.push([phrase, abbr]);
      phrase.split(' ').forEach(w => used.add(w));
    }
  }
  for (const w of all) {
    if (used.has(w)) continue;
    const alts = new Set([w]);
    if (w.length > 3 && w.endsWith('s')) alts.add(w.slice(0, -1));
    for (const [abbr, phrase] of SYNONYMS) if (abbr === w) alts.add(phrase);
    groups.push([...alts]);
  }
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
      fill(results,
        h('p.lead', `Nothing matched “${query}”. Check the spelling, or try fewer or shorter words.`),
        groupStudyOn() ? h('p', h('button.link-button', { type: 'button', onclick: () => openFeedback(`Could you add questions about ${query}?`) },
          'Ask for questions on this topic')) : null);
      return;
    }
    fill(results, last.classes.map(c => {
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
            h('p.set-meta', hits.length ? `${hits.length} of ${set.questions.length} questions match` : 'The title or topics match')),
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
    paint();
  });
  loadGuideWords().then(w => {
    guideWords = w;
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
