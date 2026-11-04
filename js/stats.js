// Question stats (SPEC 11.9; the owner's request, 2026-11-03). When a student
// finishes an attempt, the site adds 1 to anonymous counts for each question
// they answered, in /itemStats/<set>/<question>:
//   n       answered             ok    fully right
//   n1      answered on a first try (this browser hadn't seen the question before)
//   ok1     fully right on a first try
//   p1/<i>  first tries that picked choice i (multiple choice, select all, and
//           select N; i counts the set file's choices from 0)
// Only counts: no names, no ids, no times, nothing about who answered. The
// rules let anyone signed in add 1 and nothing else; only the host reads or
// resets them. The host console's Question stats page shows them, with the
// questions most first tries get right, and wrong choices that hardly anyone
// picks. Browsers that don't count in the usage stats (the host's, or after
// #/stats-off) send nothing, so the owner's own testing doesn't skew them.
import { h, fill, modal, toast } from './util.js';
import { groupStudyOn, connectStudent, problemText } from './firebase.js';
import { thisBrowserCounts } from './analytics.js';
import { isAnswered, typeLabel } from './items.js';
import { toKey, fromKey } from './reports.js';
import { withChanges, readChanges } from './set-changes.js';
import { sample } from './vary.js';

const CHOICES = ['mc', 'sata', 'emr']; // types whose picks are counted
const ENOUGH = 10; // first tries before a question is called too easy or very hard
const ENOUGH_PICKS = 20; // first tries before a choice is called one hardly anyone picks
const TOO_EASY = 0.85;
const VERY_HARD = 0.3;
const RARE_PICK = 0.05;
const LETTERS = 'ABCDEFGHIJ';

// ---------- students ----------

// After an attempt (exam.js): one database update for all its answered
// questions, all saved together or not at all. Never throws: an attempt never
// fails over its stats.
export function recordStats(result) {
  if (!groupStudyOn() || !thisBrowserCounts() || !result?.items?.length) return;
  const byId = new Map((result.questions ?? []).map(q => [q.id, q]));
  connectStudent().then(db => {
    const one = db.increment(1);
    const changes = {};
    for (const item of result.items) {
      const q = byId.get(item.id);
      const r = result.responses?.[item.id];
      if (!q || !isAnswered(q, r)) continue;
      const at = `itemStats/${toKey(result.setId)}/${toKey(item.id)}`;
      const right = item.earned === item.max;
      changes[`${at}/n`] = one;
      if (right) changes[`${at}/ok`] = one;
      if (!item.first) continue;
      changes[`${at}/n1`] = one;
      if (right) changes[`${at}/ok1`] = one;
      if (CHOICES.includes(q.type)) {
        for (const i of [r].flat()) if (Number.isInteger(i) && i >= 0 && i < 100) changes[`${at}/p1/${i}`] = one;
      }
    }
    return Object.keys(changes).length ? db.update('', changes) : null;
  }).catch(() => {});
}

// ---------- the host ----------

const count = v => (Number.isFinite(v) && v > 0 ? v : 0);
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);
const plainText = html => {
  const t = document.createElement('template');
  t.innerHTML = String(html ?? '');
  return t.content.textContent.replace(/\s+/g, ' ').trim();
};

// /itemStats as { set id: [{ qKey, qid, n, ok, n1, ok1, picks: { choice: count } }] }.
function readStats(value) {
  const out = {};
  for (const [setKey, questions] of Object.entries(value ?? {})) {
    const rows = [];
    for (const [qKey, s] of Object.entries(questions ?? {})) {
      if (!s || typeof s !== 'object') continue;
      const picks = {};
      for (const [i, c] of Object.entries(s.p1 ?? {})) if (/^\d+$/.test(i)) picks[i] = count(c);
      rows.push({ setKey, qKey, qid: fromKey(qKey), n: count(s.n), ok: count(s.ok), n1: count(s.n1), ok1: count(s.ok1), picks });
    }
    if (rows.length) out[fromKey(setKey)] = rows;
  }
  return out;
}

// What stands out about a question: too easy, very hard, and wrong choices hardly anyone picks.
function flagsFor(row, q) {
  const flags = [];
  if (row.n1 >= ENOUGH && row.ok1 / row.n1 >= TOO_EASY) flags.push(['easy', 'Too easy']);
  if (row.n1 >= ENOUGH && row.ok1 / row.n1 < VERY_HARD) flags.push(['hard', 'Very hard: check it']);
  if (q && CHOICES.includes(q.type) && row.n1 >= ENOUGH_PICKS) {
    const right = [q.answer].flat();
    const rare = q.options.map((_, i) => i).filter(i => !right.includes(i) && (row.picks[i] ?? 0) / row.n1 < RARE_PICK);
    if (rare.length) flags.push(['rare', `Hardly picked: ${rare.map(i => LETTERS[i]).join(', ')}`]);
  }
  return flags;
}

// The host console's Question stats page (#/host/stats). Returns a function that stops it.
export function statsConsole(section, db, { sets, courses }, accountLine) {
  document.title = 'Question stats · Host console';
  let changes = {};
  let stats = {};
  let loaded = 0; // 1: /setInfo, 2: /itemStats
  let problem = null;
  let chosen = null;
  let order = 'easy';
  const picker = h('select.text-input.stats-set#stats-set');
  const sorter = h('select.text-input.stats-order#stats-order',
    h('option', { value: 'easy' }, 'Most right on the first try'),
    h('option', { value: 'hard' }, 'Fewest right on the first try'),
    h('option', { value: 'most' }, 'Most first tries'),
    h('option', { value: 'set' }, 'Set order'));
  picker.addEventListener('change', () => {
    chosen = picker.value;
    paint();
  });
  sorter.addEventListener('change', () => {
    order = sorter.value;
    paint();
  });
  const controls = h('div.stats-controls', { hidden: true },
    h('label.field-label', { for: 'stats-set' }, 'Question set'), picker,
    h('label.field-label', { for: 'stats-order' }, 'Order'), sorter);
  const summary = h('p.stats-summary');
  const list = h('div.stats-list', h('p.lead', 'Loading the stats…'));

  function paint() {
    if (problem) return fill(list, h('p.notice', problemText(problem)));
    if (loaded !== 3) return;
    const all = withChanges(sets, changes, courses, { keepHidden: true });
    const ids = Object.keys(stats);
    if (!ids.length) {
      controls.hidden = true;
      fill(summary);
      return fill(list, h('p.empty-note', 'No results yet. They come in as students finish practice exams and exam simulations.'));
    }
    const titleOf = id => all.find(s => s.id === id)?.title ?? id;
    ids.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
    if (!ids.includes(chosen)) chosen = ids.reduce((best, id) => (stats[id].length > stats[best].length ? id : best), ids[0]);
    fill(picker, ids.map(id => {
      const set = all.find(s => s.id === id);
      return h('option', { value: id, selected: id === chosen }, `${titleOf(id)}${set?.exam ? ` (${set.exam})` : ''}${set?.course ? ` · ${set.course}` : ''}`);
    }));
    controls.hidden = false;
    const set = all.find(s => s.id === chosen);
    const place = q => (set ? set.questions.findIndex(x => x.id === q) : -1);
    const rate = r => (r.n1 ? r.ok1 / r.n1 : -1);
    const rows = stats[chosen].slice().sort(
      order === 'hard' ? (a, b) => (rate(a) < 0) - (rate(b) < 0) || rate(a) - rate(b)
        : order === 'most' ? (a, b) => b.n1 - a.n1
          : order === 'set' ? (a, b) => place(a.qid) - place(b.qid)
            : (a, b) => rate(b) - rate(a));
    const firsts = rows.reduce((sum, r) => sum + r.n1, 0);
    const answered = rows.reduce((sum, r) => sum + r.n, 0);
    fill(summary, `${rows.length === 1 ? '1 question' : `${rows.length} questions`} with results: ${answered} answers in all, `
      + `${firsts} of them first tries.`);
    fill(list, rows.map(row => {
      const n = place(row.qid);
      const q = n >= 0 ? sample(set.questions[n]) : null; // changing numbers: one fixed sample (vary.js)
      const flags = flagsFor(row, q);
      const right = q ? [q.answer].flat() : [];
      return h('section.stats-item',
        h('p.q-row-head',
          q ? [h('b', `Question ${n + 1}`), ` (${row.qid}) · ${typeLabel(q.type)} · ${q.topic}`] : [h('b', row.qid), ' · no longer in the set']),
        q ? h('p.report-stem', plainText(q.stem).slice(0, 260)) : null,
        h('p.stats-numbers',
          h('span', h('b', row.n1 ? `${pct(row.ok1, row.n1)}%` : '–'), ` right on the first try (${row.ok1} of ${row.n1})`),
          h('span', h('b', row.n ? `${pct(row.ok, row.n)}%` : '–'), ` right in all tries (${row.ok} of ${row.n})`)),
        flags.length ? h('p.stats-flags', flags.map(([kind, text]) => h(`span.stats-flag.flag-${kind}`, text))) : null,
        q && CHOICES.includes(q.type) && row.n1 ? h('ol.stats-choices', q.options.map((o, i) => h('li', { class: right.includes(i) ? 'is-right' : null },
          h('span.stats-letter', LETTERS[i]),
          h('span.stats-choice', plainText(o)),
          h('span.stats-share', `${pct(row.picks[i] ?? 0, row.n1)}%`),
          right.includes(i) ? h('span.sr-only', ' (a right answer)') : null))) : null,
        h('div.set-actions',
          q ? h('a.btn', { href: `#/host/sets/${encodeURIComponent(chosen)}/${encodeURIComponent(row.qid)}`, 'aria-label': `Edit question ${n + 1}` }, 'Edit question') : null,
          h('button.btn', { type: 'button', 'aria-label': `Reset the stats of ${q ? `question ${n + 1}` : row.qid}`, onclick: () => reset(row, q ? `question ${n + 1}` : row.qid) }, 'Reset stats')));
    }));
  }

  async function reset(row, name) {
    const choice = await modal({
      title: 'Reset Stats?',
      message: `The results for ${name} are deleted, and counting starts again from zero. Do this after you rewrite a question, so its old results don't mix with its new ones.`,
      buttons: [{ label: 'Reset stats', value: 'reset', accent: true }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'reset') return;
    try {
      await db.write(`itemStats/${row.setKey}/${row.qKey}`, null);
      toast('Stats reset.');
    } catch (err) {
      toast(`It didn't change. ${problemText(err)}`, 9000);
    }
  }

  const fail = err => {
    problem = err;
    paint();
  };
  const stopInfo = db.watch('setInfo', value => {
    changes = readChanges(value);
    loaded |= 1;
    paint();
  }, fail);
  const stopStats = db.watch('itemStats', value => {
    stats = readStats(value);
    loaded |= 2;
    paint();
  }, fail);
  fill(section,
    h('h1.page-title', 'Question stats'),
    h('p.lead', 'How students do on each question, counted when they finish an attempt. A first try is a question that student hadn\'t seen before: it shows how hard a question really is, since a question is easier the second time. Results are anonymous: no names, only counts. Your own attempts on this browser aren\'t counted.'),
    h('p.note', `A question that ${Math.round(TOO_EASY * 100)}% or more get right on the first try (after ${ENOUGH} first tries) is marked Too easy, and one under ${Math.round(VERY_HARD * 100)}% Very hard: check that its answer and rationale are right. A wrong choice that fewer than ${Math.round(RARE_PICK * 100)}% of first tries pick (after ${ENOUGH_PICKS}) is Hardly picked: nobody falls for it, so it's worth replacing.`),
    controls,
    summary,
    list,
    accountLine());
  return () => {
    stopInfo();
    stopStats();
  };
}
