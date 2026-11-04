// Debriefs after a real exam (SPEC 11.10; the owner's ideas 3 and 4,
// 2026-11-04). After a real exam, the host opens a short debrief for that class
// and exam. Students who took it see it on the class tab and answer
// anonymously: how the real exam compared with the practice sets, which topics
// came up more, the kinds of questions, what made it hard, and, if they want,
// their real score and their practice scores from this browser. Patterns only:
// the form asks students not to copy or retell real questions. The host's
// Debriefs page sums the answers up, so the next sets match the real exam, and
// shows practice scores next to real ones (the goal: practice a little below).
//   /debriefs/<id>              { course, exam, title, open, createdAt, topics: [names], sets: [set ids] }
//                               the host writes it; anyone signed in reads it
//   /debriefAnswers/<id>/<uid>  { compare, more: { topic number: true }, kinds, hard, real, practice, note, at }
//                               a student writes their own while the debrief is open; only the host reads them all
import { SITE_NAME } from './config.js';
import { h, fill, modal, toast, store, fmtDate, seededShuffle } from './util.js';
import { groupStudyOn, connectStudent, problemText } from './firebase.js';
import { setHistory, countsForBest } from './exam.js';
import { toKey, fromKey } from './reports.js';
import { loadSets } from './sets.js';
import { withChanges, readChanges, cachedChanges } from './set-changes.js';

// The choices, with the keys database.rules.json accepts.
export const COMPARE = [
  ['easier', 'Easier than the practice sets'],
  ['same', 'About the same'],
  ['harder', 'Harder'],
  ['much-harder', 'Much harder'],
];
export const KINDS = [
  ['scenario', 'Scenarios: what should the nurse do?'],
  ['priority', 'What comes first, or which choice is best'],
  ['sata', 'Select all that apply'],
  ['math', 'Math, with the answer typed in'],
  ['long', 'Long questions to read'],
  ['facts', 'Facts and definitions'],
];
export const HARD = [
  ['choices', 'Choices that all sounded right'],
  ['wording', 'Tricky wording'],
  ['math', 'Math with several steps'],
  ['unfamiliar', "Topics we hadn't practiced"],
  ['time', 'Not enough time'],
  ['long', 'Long questions'],
];
const NOTE_MAX = 500;
const TOPICS_MAX = 30;
const ANSWERED = 'pe.debriefs'; // debriefs answered on this browser: { id: true } (the class tab's card says thanks)

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);
const round1 = x => Math.round(x * 10) / 10;
const labelOf = (list, key) => list.find(([k]) => k === key)?.[1] ?? key;

// A list Firebase may give back as an array or as { "0": …, "1": … }.
const listOf = v => (Array.isArray(v) ? v : Object.keys(v ?? {}).sort((a, b) => a - b).map(k => v[k])).filter(x => typeof x === 'string');
// Keys marked true, from { key: true } (or an array of trues, which Firebase makes of { "0": true, "1": true }).
const flagsOf = v => (Array.isArray(v) ? v.map((x, i) => (x === true ? String(i) : null)).filter(Boolean) : Object.keys(v ?? {}).filter(k => v[k] === true));

// /debriefs as a list, newest first.
export function readDebriefs(value) {
  return Object.entries(value ?? {})
    .filter(([, d]) => d && typeof d === 'object' && typeof d.title === 'string')
    .map(([key, d]) => ({
      id: fromKey(key), key, course: String(d.course ?? ''), exam: String(d.exam ?? ''), title: d.title, open: d.open === true,
      createdAt: Number(d.createdAt) || 0, topics: listOf(d.topics), sets: listOf(d.sets),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// One debrief's answers, as plain lists.
function readAnswers(value) {
  return Object.values(value ?? {})
    .filter(a => a && typeof a === 'object' && COMPARE.some(([k]) => k === a.compare))
    .map(a => ({
      compare: a.compare,
      more: flagsOf(a.more).map(Number).filter(Number.isInteger),
      kinds: flagsOf(a.kinds),
      hard: flagsOf(a.hard),
      real: Number.isFinite(a.real) ? a.real : null,
      practice: Object.fromEntries(Object.entries(a.practice ?? {})
        .filter(([, p]) => p && Number.isFinite(p.avg))
        .map(([k, p]) => [fromKey(k), { avg: p.avg, best: Number.isFinite(p.best) ? p.best : null, n: Number(p.n) || 0 }])),
      note: typeof a.note === 'string' ? a.note.trim() : '',
      at: Number(a.at) || 0,
    }));
}

// ---------- students ----------

// The open debriefs, as they change (the homepage's class tabs). Returns a function that stops it.
export function watchOpenDebriefs(onChange) {
  let stop = () => {};
  let stopped = false;
  if (groupStudyOn()) {
    connectStudent().then(db => {
      if (!stopped) stop = db.watch('debriefs', value => onChange(readDebriefs(value).filter(d => d.open)), () => {});
    }, () => {});
  }
  return () => {
    stopped = true;
    stop();
  };
}

// The card at the top of a class tab while one of its debriefs is open.
export function debriefCards(list) {
  const answered = store.get(ANSWERED, {});
  return list.map(d => {
    const done = !!answered[d.id];
    return h('section.banner.debrief-card', { 'aria-label': d.title },
      h('div',
        h('p.banner-title', done ? [h('b', 'Thanks for answering: '), d.title] : [h('b', `Took the real ${d.exam || 'exam'}? `), 'Tell us how it compared.']),
        h('p.banner-detail', done
          ? 'You can change your answers until the debrief closes.'
          : 'About 2 minutes, and anonymous: no names. Your answers shape the next practice sets.')),
      h('div.banner-actions',
        h(done ? 'a.btn' : 'a.btn.btn-accent', { href: `#/debrief/${encodeURIComponent(d.id)}` }, done ? 'Change my answers' : 'Answer the debrief')));
  });
}

// This browser's practice scores on the debrief's sets: the average of finished
// attempts of the whole set or part of it (not retakes of missed or saved
// questions, not finished early), the best that counts for Best, and how many.
function practiceScores(d, sets) {
  const out = [];
  for (const id of d.sets) {
    const set = sets.find(s => s.id === id);
    const done = setHistory(id).filter(a => !a.early && (a.scope === 'full' || a.scope === 'part') && Number.isFinite(a.percent));
    if (!done.length) continue;
    const best = set ? done.filter(a => countsForBest(a, set)).map(a => a.percent) : [];
    out.push({
      id, title: set?.title ?? id, n: Math.min(done.length, 1000),
      avg: Math.round(done.reduce((sum, a) => sum + a.percent, 0) / done.length),
      best: best.length ? Math.round(Math.max(...best)) : null,
    });
  }
  return out;
}

const homeLink = () => h('div.form-actions', h('a.btn.btn-accent', { href: '#/' }, 'Home'));

// #/debrief/<id>: the form (app.js gives it the page).
export async function debriefPage(main, id, { isCurrent }) {
  const title = text => {
    document.title = `${text} · ${SITE_NAME}`;
    return h('h1.page-title', text);
  };
  if (!groupStudyOn() || !id) return fill(main, title('Exam debrief'), h('p.lead', "This debrief isn't available here."), homeLink());
  let db, value, mine, loaded;
  try {
    db = await connectStudent();
    [value, loaded] = await Promise.all([db.read(`debriefs/${toKey(id)}`), loadSets()]);
    mine = value ? await db.read(`debriefAnswers/${toKey(id)}/${db.uid}`).catch(() => null) : null;
  } catch (err) {
    if (isCurrent()) fill(main, title('Exam debrief'), h('p.notice', problemText(err)), homeLink());
    return;
  }
  if (!isCurrent()) return;
  const d = value ? readDebriefs({ [toKey(id)]: value })[0] : null;
  if (!d) return fill(main, title('Exam debrief'), h('p.lead', "This debrief isn't on the site any more."), homeLink());
  if (!d.open) return fill(main, title(d.title), h('p.lead', 'This debrief is closed. Thanks to everyone who answered!'), homeLink());

  const sets = withChanges(loaded.sets, cachedChanges(), loaded.courses, { keepHidden: true });
  const scores = practiceScores(d, sets);
  const before = mine ? readAnswers({ mine })[0] : null;
  const choices = (name, type, list) => list.map(([value, label]) => h('label.choice-line.debrief-choice',
    h('input.ctl', { type, name: `debrief-${name}`, value }), h('span', label)));
  const group = (name, legend, help, kids) => h('fieldset.debrief-group',
    h('legend.field-label', legend), help ? h('p.field-help', help) : null, kids);
  const real = h('input.text-input.debrief-real#debrief-real', { type: 'number', min: '0', max: '100', step: 'any', inputmode: 'decimal' });
  const share = scores.length ? h('input.ctl#debrief-share', { type: 'checkbox', checked: before ? Object.keys(before.practice).length > 0 : true }) : null;
  const note = h('textarea.text-input.debrief-note#debrief-note', { rows: '4', maxlength: String(NOTE_MAX) });
  const problem = h('p.form-problem', { role: 'alert' });
  const send = h('button.btn.btn-accent', { type: 'submit' }, before ? 'Send my new answers' : 'Send my answers');
  const form = h('form.debrief-form', { novalidate: true }, // the site's own messages, in plain words
    group('compare', 'Compared with the practice sets on this site, the real exam was:', null, choices('compare', 'radio', COMPARE)),
    d.topics.length ? group('more', 'Which topics came up more than the practice sets suggested?', 'Pick any, or none.',
      choices('more', 'checkbox', d.topics.map((t, i) => [String(i), t]))) : null,
    group('kinds', 'What kinds of questions were on it?', 'Pick any that came up often.', choices('kinds', 'checkbox', KINDS)),
    group('hard', 'What made it hard?', 'Pick any, or none.', choices('hard', 'checkbox', HARD)),
    h('label.field-label', { for: 'debrief-real' }, 'Your score on the real exam ', h('span.optional', '(optional)')),
    h('div.debrief-score-row', real, h('span', '%')),
    h('p.field-help', 'Only if you want: it\'s shown next to practice scores, never with your name.'),
    scores.length
      ? h('div.debrief-share',
        h('label.choice-line.own-work', share, h('span', 'Include my practice scores from this site, anonymously:')),
        h('ul.debrief-scores', scores.map(s => h('li', `${s.title}: average ${s.avg}%${s.best != null ? `, best full exam ${s.best}%` : ''} (${plural(s.n, 'attempt')})`))))
      : h('p.field-help', 'This browser has no finished practice attempts on these sets, so there are no practice scores to include.'),
    h('label.field-label', { for: 'debrief-note' }, 'Anything else? ', h('span.optional', '(optional)')),
    note,
    h('p.field-help', `Patterns only, like “more priority questions on QI than we practiced.” Please don't copy or retell real exam questions, and don't include your name. Up to ${NOTE_MAX} characters.`),
    problem,
    h('div.form-actions', send, h('a.btn', { href: '#/' }, 'Cancel')));

  if (before) {
    const tick = (name, values) => values.forEach(v => {
      const box = form.querySelector(`input[name=debrief-${name}][value="${CSS.escape(String(v))}"]`);
      if (box) box.checked = true;
    });
    tick('compare', [before.compare]);
    tick('more', before.more);
    tick('kinds', before.kinds);
    tick('hard', before.hard);
    if (before.real != null) real.value = String(before.real);
    note.value = before.note;
  }
  // On input, not change: change fires when a field loses focus, which is the mouse-down of a click on Send,
  // and the line disappearing then would move the button out from under the click.
  form.addEventListener('input', () => (problem.textContent = ''));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const picked = name => [...form.querySelectorAll(`input[name=debrief-${name}]:checked`)].map(i => i.value);
    const compare = picked('compare')[0];
    if (!compare) {
      problem.textContent = 'Choose how the real exam compared with the practice sets.';
      form.querySelector('input[name=debrief-compare]')?.focus();
      return;
    }
    const raw = real.value.trim();
    const score = raw === '' ? null : Number(raw);
    if (raw !== '' && !(Number.isFinite(score) && score >= 0 && score <= 100)) {
      problem.textContent = 'Enter your real score as a number from 0 to 100, or leave it empty.';
      real.focus();
      return;
    }
    const answer = { compare, at: db.serverTime() };
    const flags = keys => Object.fromEntries(keys.map(k => [k, true]));
    const more = picked('more').filter(i => /^\d{1,2}$/.test(i));
    if (more.length) answer.more = flags(more);
    if (picked('kinds').length) answer.kinds = flags(picked('kinds'));
    if (picked('hard').length) answer.hard = flags(picked('hard'));
    if (score != null) answer.real = round1(score);
    if (share?.checked) {
      answer.practice = Object.fromEntries(scores.map(s => [toKey(s.id), { avg: s.avg, n: s.n, ...(s.best != null ? { best: s.best } : {}) }]));
    }
    const text = note.value.trim().slice(0, NOTE_MAX);
    if (text) answer.note = text;
    send.disabled = true;
    problem.textContent = 'Sending…';
    try {
      await db.write(`debriefAnswers/${toKey(d.id)}/${db.uid}`, answer);
    } catch (err) {
      send.disabled = false;
      const stillOpen = await db.read(`debriefs/${toKey(d.id)}/open`).catch(() => null);
      problem.textContent = stillOpen === false ? 'This debrief closed before your answers were sent.' : `Your answers weren't sent. ${problemText(err)}`;
      return;
    }
    store.set(ANSWERED, { ...store.get(ANSWERED, {}), [d.id]: true });
    if (!isCurrent()) return;
    fill(main,
      title('Thanks!'),
      h('p.lead', 'Your answers were sent. They help make the next practice sets match the real exam.'),
      h('p', 'You can change them until the debrief closes: come back to this page from the class tab.'),
      homeLink());
  });

  fill(main,
    title(d.title),
    h('p.lead', `Took the real ${d.exam || 'exam'}? Tell us how it compared with the practice sets on this site. It takes about 2 minutes, and it's anonymous: no names, and your answers can't be linked to you.`),
    before ? h('p.notice', 'You already answered this debrief. Sending again replaces your answers.') : null,
    h('p.note', 'Describe patterns only. Please don\'t copy or retell the real exam\'s questions: that isn\'t allowed, and the practice sets are written from the class materials, never from real exams.'),
    form);
}

// ---------- the host ----------

// The topics a debrief offers, for the exam's sets: the blueprint's topics when
// one of them has topic weights (like the mock exam), else the topics of their
// questions, or their titles when those are too many to pick from.
function suggestedTopics(list) {
  const weighted = list.find(s => s.topicWeights && Object.values(s.topicWeights).some(n => n > 0));
  if (weighted) return Object.entries(weighted.topicWeights).filter(([, n]) => n > 0).map(([t]) => t);
  const topics = [...new Set(list.flatMap(s => s.questions.filter(q => !q.hidden).map(q => q.topic)).filter(Boolean))];
  return topics.length && topics.length <= 15 ? topics : list.map(s => s.title);
}

// One row of a summary: a label, a bar, and how many picked it.
function barRow(label, count, total) {
  return h('tr',
    h('th', { scope: 'row' }, label),
    h('td.bar-cell', h('div.bar',
      h('span.bar-track', { 'aria-hidden': 'true' }, h('span.bar-fill', { style: `width:${pct(count, total)}%` })),
      h('span.bar-pct', `${count}`, h('span.sr-only', ` of ${total}`)))));
}

function barTable(caption, rows, total, empty) {
  const shown = rows.filter(([, c]) => c > 0);
  return h('section.debrief-part',
    h('h3.debrief-part-title', caption),
    shown.length ? h('div.table-scroll', h('table.perf.debrief-bars', h('tbody', shown.map(([label, c]) => barRow(label, c, total))))) : h('p.field-help', empty));
}

const byCount = rows => rows.slice().sort((a, b) => b[1] - a[1]);

// A debrief's answers, summed up for the host.
function summaryOf(d, answers, titleOf) {
  const n = answers.length;
  if (!n) return [h('p.empty-note', 'No answers yet. Students see the debrief on the class tab while it\'s open.')];
  const count = test => answers.filter(test).length;
  const parts = [
    h('p.stats-summary', `${plural(n, 'answer')}.`),
    barTable('Compared with the practice sets, the real exam was:', COMPARE.map(([k, label]) => [label, count(a => a.compare === k)]), n, ''),
    barTable('Topics that came up more than practice suggested', byCount(d.topics.map((t, i) => [t, count(a => a.more.includes(i))])), n, 'No topics picked.'),
    barTable('Kinds of questions on the exam', byCount(KINDS.map(([k, label]) => [label, count(a => a.kinds.includes(k))])), n, 'None picked.'),
    barTable('What made it hard', byCount(HARD.map(([k, label]) => [label, count(a => a.hard.includes(k))])), n, 'None picked.'),
  ];

  // Practice scores next to real ones: one row per student who shared either, never with their note.
  const scored = answers.filter(a => a.real != null || Object.keys(a.practice).length)
    .sort((a, b) => (b.real ?? -1) - (a.real ?? -1));
  const columns = d.sets.filter(id => scored.some(a => a.practice[id]));
  const extra = [...new Set(scored.flatMap(a => Object.keys(a.practice)).filter(id => !columns.includes(id)))];
  columns.push(...extra);
  const cell = p => (p ? `${p.avg}%${p.best != null ? ` (best ${p.best}%)` : ''}` : '–');
  const gaps = columns.map(id => {
    const both = scored.filter(a => a.real != null && a.practice[id]);
    if (!both.length) return null;
    const gap = round1(both.reduce((sum, a) => sum + a.practice[id].avg - a.real, 0) / both.length);
    return h('li', `${titleOf(id)}: practice averaged `, h('b', gap === 0 ? 'the same as' : `${plural(Math.abs(gap), 'point')} ${gap > 0 ? 'above' : 'below'}`),
      ` the real score (${plural(both.length, 'student')} with both).`);
  }).filter(Boolean);
  const reals = scored.filter(a => a.real != null);
  parts.push(h('section.debrief-part',
    h('h3.debrief-part-title', 'Practice scores next to real ones'),
    scored.length
      ? [
        h('p.field-help', 'One row per student who shared a score, highest real score first. Practice: the average of finished attempts on this site, and the best full exam. The goal: practice scores at or a little below real ones.'),
        h('div.table-scroll', h('table.perf.debrief-scores-table',
          h('thead', h('tr', h('th', { scope: 'col' }, 'Real exam'), columns.map(id => h('th', { scope: 'col' }, `${titleOf(id)}: practice`)))),
          h('tbody', scored.map(a => h('tr', h('td.num', a.real != null ? `${a.real}%` : '–'), columns.map(id => h('td.num', cell(a.practice[id])))))))),
        reals.length ? h('p.debrief-average', `Average real score: ${round1(reals.reduce((s, a) => s + a.real, 0) / reals.length)}% (${plural(reals.length, 'student')}).`) : null,
        gaps.length ? h('ul.debrief-gaps', gaps) : h('p.field-help', 'No one has shared both a real and a practice score yet.'),
      ]
      : h('p.field-help', 'No one has shared a score yet.')));

  const notes = seededShuffle(answers.map(a => a.note).filter(Boolean), d.id);
  parts.push(h('section.debrief-part',
    h('h3.debrief-part-title', 'Notes'),
    notes.length
      ? [h('p.field-help', 'In a random order, apart from the scores, so a note can\'t be matched to someone\'s scores.'),
        h('ul.report-notes.debrief-notes', notes.map(t => h('li', `“${t}”`)))]
      : h('p.field-help', 'No notes yet.')));
  return parts;
}

// The host console's Debriefs page (#/host/debriefs). Returns a function that stops it.
export function debriefsConsole(section, db, { sets, courses }, accountLine) {
  document.title = 'Debriefs · Host console';
  let changes = {};
  let debriefs = [];
  let answers = {};
  let loaded = 0; // 1: /setInfo, 2: /debriefs, 4: /debriefAnswers
  let problem = null;
  let chosen = null;
  const all = () => withChanges(sets, changes, courses, { keepHidden: true }).filter(s => !s.hidden);
  const titleOf = id => all().find(s => s.id === id)?.title ?? id;

  // ----- the form to open a new debrief -----
  const course = h('select.text-input#debrief-course');
  const exam = h('select.text-input#debrief-exam');
  const name = h('input.text-input#debrief-title', { maxlength: '120' });
  const topics = h('textarea.text-input.debrief-topics#debrief-topics', { rows: '8' });
  const setBoxes = h('div.debrief-set-boxes');
  const formProblem = h('p.form-problem', { role: 'alert' });
  let named = false; // the host typed a title, so changing the class or exam doesn't replace it
  name.addEventListener('input', () => (named = true));
  const examsOf = code => [...new Set(all().filter(s => s.course === code && s.exam).map(s => s.exam))];
  const setsOf = () => all().filter(s => s.course === course.value && s.exam === exam.value);
  function fillExams() {
    const list = examsOf(course.value);
    const keep = list.includes(exam.value) ? exam.value : list[0] ?? ''; // the first is the newest (sets/index.json)
    fill(exam, list.length ? list.map(x => h('option', { value: x, selected: x === keep }, x)) : h('option', { value: '' }, 'No exams with sets'));
    fillForExam();
  }
  function fillForExam() {
    const list = setsOf();
    if (!named) name.value = exam.value ? `${course.value} ${exam.value} debrief` : '';
    topics.value = suggestedTopics(list).join('\n');
    fill(setBoxes, list.length
      ? list.map(s => h('label.choice-line', h('input.ctl', { type: 'checkbox', value: s.id, checked: true }), h('span', s.title)))
      : h('p.field-help', 'This class has no sets for that exam.'));
  }
  course.addEventListener('change', fillExams);
  exam.addEventListener('change', fillForExam);
  const form = h('form.host-card.guide-form.debrief-open',
    h('h2.section-title', 'Open a debrief'),
    h('p.field-help', 'Open it once the class has taken the real exam. Students see it on the class tab until you close it.'),
    h('label.field-label', { for: 'debrief-course' }, 'Class'), course,
    h('label.field-label', { for: 'debrief-exam' }, 'Exam'), exam,
    h('label.field-label', { for: 'debrief-title' }, 'Title'), name,
    h('label.field-label', { for: 'debrief-topics' }, 'Topics students can pick'), topics,
    h('p.field-help', `One per line, ${TOPICS_MAX} at most. Students mark the ones that came up more than the practice sets suggested. They start as the exam's blueprint, or its sets' topics.`),
    h('fieldset.debrief-group', h('legend.field-label', 'Practice scores to ask for'),
      h('p.field-help', 'Students can include their scores on these sets from their own browser, anonymously.'), setBoxes),
    formProblem,
    h('div.form-actions', h('button.btn.btn-accent', { type: 'submit' }, 'Open the debrief')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const list = topics.value.split('\n').map(t => t.trim()).filter(Boolean);
    const title = name.value.trim();
    formProblem.textContent = !course.value || !exam.value ? 'Choose a class and an exam.'
      : !title ? 'Give the debrief a title.'
        : list.length > TOPICS_MAX ? `List ${TOPICS_MAX} topics at most.`
          : list.some(t => t.length > 120) ? 'Keep each topic to 120 characters.' : '';
    if (formProblem.textContent) return;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const picked = [...setBoxes.querySelectorAll('input:checked')].map(i => i.value);
    try {
      await db.write(`debriefs/${id}`, { course: course.value, exam: exam.value, title, open: true, createdAt: db.serverTime(), topics: list, sets: picked });
      chosen = id;
      named = false;
      fillForExam();
      toast('The debrief is open. Students see it on the class tab.');
    } catch (err) {
      formProblem.textContent = `It wasn't opened. ${problemText(err)}`;
    }
  });

  // ----- the list, and the chosen debrief's summary -----
  const list = h('div.debrief-list', h('p.lead', 'Loading the debriefs…'));
  const summary = h('section.debrief-summary');

  function paint() {
    if (problem) return fill(list, h('p.notice', problemText(problem)));
    if (loaded !== 7) return;
    if (!course.options.length) {
      fill(course, courses.map(c => h('option', { value: c.code }, `${c.code} ${c.name}`)));
      fillExams();
    }
    if (!debriefs.length) {
      fill(summary);
      return fill(list, h('p.empty-note', 'No debriefs yet.'));
    }
    if (!debriefs.some(d => d.id === chosen)) chosen = debriefs[0].id;
    fill(list, debriefs.map(d => {
      const n = Object.keys(answers[d.key] ?? {}).length;
      return h('section.debrief-item', { class: d.id === chosen ? 'is-chosen' : null },
        h('p.q-row-head', h('b', d.title), ` · ${d.course}${d.exam ? ` · ${d.exam}` : ''} · `,
          h(d.open ? 'span.debrief-state.is-open' : 'span.debrief-state', d.open ? 'Open' : 'Closed')),
        h('p.report-meta', `${plural(n, 'answer')}, opened ${d.createdAt ? fmtDate(d.createdAt) : 'just now'}.`),
        h('div.set-actions',
          h('button.btn', { type: 'button', 'aria-pressed': String(d.id === chosen), onclick: () => { chosen = d.id; paint(); } }, 'Show answers'),
          h('button.btn', { type: 'button', onclick: () => setOpen(d, !d.open) }, d.open ? 'Close' : 'Reopen'),
          h('button.btn', { type: 'button', 'aria-label': `Delete ${d.title}`, onclick: () => remove(d) }, 'Delete')));
    }));
    const d = debriefs.find(x => x.id === chosen);
    fill(summary, h('h2.section-title', `Answers: ${d.title}`), summaryOf(d, readAnswers(answers[d.key]), titleOf));
  }

  async function setOpen(d, open) {
    try {
      await db.write(`debriefs/${d.key}/open`, open);
      toast(open ? 'The debrief is open again.' : 'The debrief is closed. Students no longer see it.');
    } catch (err) {
      toast(`It didn't change. ${problemText(err)}`, 9000);
    }
  }

  async function remove(d) {
    const n = Object.keys(answers[d.key] ?? {}).length;
    const choice = await modal({
      title: 'Delete This Debrief?',
      message: `${d.title} and its ${plural(n, 'answer')} are deleted. This can't be undone.`,
      buttons: [{ label: 'Cancel', value: 'cancel', accent: true }, { label: 'Delete', value: 'delete' }],
    });
    if (choice !== 'delete') return;
    try {
      await db.update('', { [`debriefs/${d.key}`]: null, [`debriefAnswers/${d.key}`]: null });
      toast('The debrief was deleted.');
    } catch (err) {
      toast(`It wasn't deleted. ${problemText(err)}`, 9000);
    }
  }

  const fail = err => {
    problem = err;
    paint();
  };
  const stops = [
    db.watch('setInfo', value => {
      changes = readChanges(value);
      loaded |= 1;
      if (course.options.length) fillExams();
      paint();
    }, fail),
    db.watch('debriefs', value => {
      debriefs = readDebriefs(value);
      loaded |= 2;
      paint();
    }, fail),
    db.watch('debriefAnswers', value => {
      answers = value ?? {};
      loaded |= 4;
      paint();
    }, fail),
  ];
  fill(section,
    h('h1.page-title', 'Debriefs'),
    h('p.lead', 'After a real exam, open a short debrief for that class and exam. Students who took it answer anonymously: how the exam compared with the practice sets, which topics came up more, the kinds of questions, what made it hard, and, if they want, their real score and their practice scores. They describe patterns only; the form asks them not to copy real questions.'),
    form,
    h('h2.section-title', 'Debriefs'),
    list,
    summary,
    accountLine());
  return () => stops.forEach(stop => stop());
}
