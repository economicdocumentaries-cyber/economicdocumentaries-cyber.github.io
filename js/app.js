// Hash router and the pages around the exam (SPEC 2, 4.1–4.5, 11): homepage
// with its class tabs, setup, and results. Group study's pages are in
// group.js. Routes use #/ links because GitHub Pages has no server-side routing.
import { SITE_NAME } from './config.js';
import { h, fill, modal, toast, store, siteHeader, siteFooter, fmtClock, fmtDate } from './util.js';
import { typeLabel, QUESTION_TYPES } from './items.js';
import { loadSets } from './sets.js';
import {
  examView, reviewView, startExam, resumeExam, activeExam, discardExam, lastAttempt, setHistory,
  DEFAULT_SETTINGS, PRESETS, presetMatches, chooseQuestions, timeLimitMs, fullscreenAvailable,
} from './exam.js';
import { groupView, hostView, liveBanner } from './group.js';
import { watchUploadedGuides, downloadButton, guideFileName, formatSize, byExam } from './study-guides.js';

const app = document.getElementById('app');

// ---------- shared ----------

function page(main) {
  return h('div.page', siteHeader(), main, siteFooter());
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const minutesText = ms => plural(Math.round(ms / 60000), 'minute');

// Starts an exam from a click. Starting a new exam ends the one in progress,
// so ask first. Without that question, full screen is requested right away,
// while the click still counts.
function begin(set, settings) {
  const active = activeExam();
  if (!active) return startExam(set, settings);
  modal({
    title: 'Start a New Exam?',
    message: `You have an exam in progress (${active.title}). Starting a new one ends it, and its answers will not be scored.`,
    buttons: [{ label: 'Cancel', value: 'cancel', accent: true }, { label: 'Start new exam', value: 'start' }],
  }).then(choice => {
    if (choice === 'start') startExam(set, settings);
  });
}

// "Retake missed questions": only the questions without full points, with the
// same settings as before.
function retakeMissed(set, ids, settings) {
  const known = new Set(set.questions.map(q => q.id));
  const only = ids.filter(id => known.has(id));
  if (only.length) begin(set, { ...DEFAULT_SETTINGS, ...settings, only, count: null, topics: null, types: null });
}

// Time left on a saved exam, counting a pause that may have run out while away.
function timeLeft(st, now = Date.now()) {
  if (!st.deadline) return null;
  if (!st.pausedAt) return st.deadline - now;
  return st.deadline + Math.min(now - st.pausedAt, st.pauseLeftMs) - now;
}

// ---------- homepage (SPEC 4.1, 4.4, 4.5, 11) ----------

// #/ and #/class/<code>: the class tabs, or one list when there's no class list.
async function homeView(root, { args, isCurrent }) {
  document.title = SITE_NAME;
  const main = h('main.wrap.home', h('p.lead', 'Loading question sets…'));
  root.replaceChildren(page(main));
  const { sets, courses, guides, problems } = await loadSets();
  if (!isCurrent()) return;
  const visible = sets.filter(s => !s.hidden);
  const groups = classGroups(courses, visible, guides);
  const single = groups ? null : { course: null, sets: visible, guides, allClasses: true }; // the one list without a class list
  const live = liveBanner(); // "Group study is live" (SPEC 6.4), when Firebase is set up
  fill(main,
    h('h1.page-title', 'Practice exams and study guides'),
    h('p.lead', `Choose ${groups ? 'your class, then ' : ''}a question set or study guide. Exam simulation works like test day; practice mode shows the answer after each question.`),
    live.el,
    resumeBanner(),
    groups ? classTabs(groups, args[0])
      : homeLists(single, problems.length ? 'No question sets can be shown right now.' : 'There are no question sets yet.'),
    problems.length ? problemsPanel(problems) : null);
  // Guides the host uploads (SPEC 11.2) come from Firebase, and appear as soon as they're added.
  const stopGuides = watchUploadedGuides(courses, uploaded => (groups ?? [single]).forEach(g => g.paintGuides(uploaded)));
  return () => {
    live.stop();
    stopGuides();
  };
}

const CLASS_KEY = 'pe.class'; // the class tab chosen last on this browser
const classLink = key => `#/class/${encodeURIComponent(key)}`;

// The homepage tabs: one per class in sets/courses.json, in that order, then
// "Other" for sets without a class. null when there's no class list.
function classGroups(courses, sets, guides) {
  if (!courses.length) return null;
  const groups = courses.map(course => ({
    key: course.code, course, sets: sets.filter(s => s.course === course.code), guides: guides.filter(g => g.course === course.code),
  }));
  const other = sets.filter(s => !s.course);
  if (other.length) groups.push({ key: 'other', course: null, sets: other, guides: [] });
  return groups;
}

// A class's practice exams, then its study guides (SPEC 11), sorted by exam:
// the published ones, and the ones the host uploaded (SPEC 11.2), which
// group.paintGuides(uploaded) adds when they arrive. Other never has study
// guides; the no-classes list shows them only when there are some.
function homeLists(group, noSets) {
  const exams = h('section.home-section',
    h('h2.section-title', 'Practice exams'),
    group.sets.length ? h('ul.set-list', group.sets.map(setRow)) : h('p.empty-note', noSets));
  group.paintGuides = () => {};
  if (!group.course && !group.allClasses) return exams;
  const list = h('ul.set-list');
  const empty = h('p.empty-note', 'No study guides for this class yet.');
  const guides = h('section.home-section', h('h2.section-title', 'Study guides'), list, empty);
  group.paintGuides = (uploaded = []) => {
    const all = byExam([...group.guides, ...uploaded.filter(g => !group.course || g.course === group.course.code)]);
    fill(list, all.map(guideRow));
    list.hidden = !all.length;
    empty.hidden = !!all.length;
    guides.hidden = !group.course && !all.length;
  };
  group.paintGuides();
  return [exams, guides];
}

// The tab shown first is the one in the link (#/class/NU1120), else the one
// chosen last on this browser, else the first with sets or study guides.
// Choosing a tab changes the link without reloading the page, so it can be shared.
function classTabs(groups, wanted) {
  const find = key => (typeof key === 'string' ? groups.findIndex(g => g.key.toLowerCase() === key.toLowerCase()) : -1);
  const linked = find(wanted);
  let current = linked >= 0 ? linked : find(store.get(CLASS_KEY));
  if (current < 0) current = Math.max(0, groups.findIndex(g => g.sets.length || g.guides.length));
  if (linked >= 0) store.set(CLASS_KEY, groups[linked].key);
  else if (wanted) history.replaceState(history.state, '', classLink(groups[current].key));

  const tabs = groups.map((g, i) => h('button.tab.class-tab', {
    type: 'button', role: 'tab', id: `class-tab-${i}`, 'aria-controls': `class-panel-${i}`, onclick: () => choose(i),
  }, g.course
    ? [h('span.class-code', g.course.code, g.course.term ? h('span.class-term', g.course.term) : null), h('span.class-name', g.course.name)]
    : [h('span.class-code', 'Other'), h('span.class-name', 'More practice')]));
  const panels = groups.map((g, i) => h('div.class-panel', { role: 'tabpanel', id: `class-panel-${i}`, 'aria-labelledby': `class-tab-${i}` },
    homeLists(g, 'No practice exams for this class yet.')));
  const tablist = h('div.tabs.class-tabs', { role: 'tablist', 'aria-label': 'Classes' }, tabs);
  tablist.addEventListener('keydown', e => {
    const last = tabs.length - 1;
    const next = { ArrowRight: current === last ? 0 : current + 1, ArrowLeft: current === 0 ? last : current - 1, Home: 0, End: last }[e.key];
    if (next == null) return;
    e.preventDefault();
    choose(next);
    tabs[next].focus();
  });

  function show(i) {
    current = i;
    tabs.forEach((tab, j) => {
      tab.setAttribute('aria-selected', String(j === i));
      tab.tabIndex = j === i ? 0 : -1;
    });
    panels.forEach((panel, j) => (panel.hidden = j !== i));
  }

  function choose(i) {
    show(i);
    store.set(CLASS_KEY, groups[i].key);
    history.replaceState(history.state, '', classLink(groups[i].key));
  }

  show(current);
  return h('div.classes', tablist, panels);
}

function resumeBanner() {
  const st = activeExam();
  if (!st) return null;
  const left = timeLeft(st);
  const over = left != null && left <= 0;
  const paused = st.pausedAt && Date.now() - st.pausedAt < st.pauseLeftMs;
  const where = st.onGrid ? 'Reviewing your answers' : `Question ${st.index + 1} of ${st.questions.length}`;
  const banner = h('section.banner', { 'aria-label': 'Exam in progress' },
    h('div',
      h('p.banner-title', h('b', 'Exam in progress: '), st.title),
      h('p.banner-detail', over
        ? 'Time is up. Open the exam to see your score.'
        : `${where}${left != null ? ` · ${fmtClock(left)} left${paused ? ' (paused)' : ''}` : ''}`)),
    h('div.banner-actions',
      h('button.btn.btn-accent', { type: 'button', onclick: resumeExam }, over ? 'See my score' : 'Resume exam'),
      h('button.btn', { type: 'button', onclick: () => discard() }, 'Discard exam')));

  // Deletes the unfinished exam after asking. Scores from finished exams stay.
  async function discard() {
    const choice = await modal({
      title: 'Discard This Exam?',
      message: `Your progress in ${st.title} will be deleted, and its answers won't be scored. This can't be undone. Your scores from finished exams stay.`,
      buttons: [{ label: 'Keep it', value: 'keep', accent: true }, { label: 'Discard exam', value: 'discard' }],
    });
    if (choice !== 'discard') return;
    discardExam();
    banner.remove();
    (document.querySelector('.class-tab[aria-selected="true"]') ?? document.querySelector('.set-row a'))?.focus();
    toast('The exam was discarded.');
  }

  return banner;
}

function setRow(set) {
  const count = set.questions.length;
  const minutes = Math.round(set.timeMinutes ?? count * 1.5);
  const past = setHistory(set.id);
  const last = past.at(-1);
  const fullRuns = past.filter(a => a.scope === 'full');
  const best = fullRuns.length ? Math.max(...fullRuns.map(a => a.percent)) : null;
  const known = new Set(set.questions.map(q => q.id));
  const missed = (last?.missed ?? []).filter(id => known.has(id));
  const lastScope = last?.scope === 'missed' ? `, ${plural(last.count, 'missed question')}`
    : last?.scope === 'part' ? `, ${plural(last.count, 'question')}` : '';
  return h('li.set-row',
    h('div.set-info',
      set.exam ? h('p.set-exam', h('span.tag', set.exam)) : null,
      h('h3', set.title),
      set.description ? h('p.set-desc', set.description) : null,
      h('p.set-meta', `${plural(count, 'question')} · ${minutes} minutes`),
      last ? h('p.set-history',
        'Last score: ', h('b', `${last.percent}%`), ` (${fmtDate(last.at, true)}${lastScope})`,
        best != null ? [' · Best: ', h('b', `${best}%`)] : null) : null),
    h('div.set-actions',
      h('a.btn.btn-accent', { href: `#/setup/${encodeURIComponent(set.id)}` }, 'Start'),
      missed.length ? h('button.btn', { type: 'button', onclick: () => retakeMissed(set, missed, last.settings) }, `Retake missed (${missed.length})`) : null));
}

// A study guide (SPEC 11): its exam, title, and a Download button. The saved
// file is named after the class and title, like "NU1110 Exam 2 Study Guide.pdf".
// Uploaded guides (SPEC 11.2) show their size and the day they were added.
function guideRow(guide) {
  const [year, month, day] = guide.updated?.split('-').map(Number) ?? [];
  const facts = guide.uploaded
    ? ['PDF', formatSize(guide.size), guide.added ? `Added ${fmtDate(guide.added, true)}` : null]
    : ['PDF', guide.pages ? plural(guide.pages, 'page') : null,
        guide.updated ? `Updated ${fmtDate(new Date(year, month - 1, day).getTime(), true)}` : null];
  return h('li.set-row.guide-row',
    h('div.set-info',
      h('p.set-exam', h('span.tag', guide.exam)),
      h('h3', guide.title),
      guide.description ? h('p.set-desc', guide.description) : null,
      h('p.set-meta', facts.filter(Boolean).join(' · '))),
    h('div.set-actions', guide.uploaded
      ? downloadButton(guide)
      : h('a.btn.btn-accent', {
          href: `guides/${encodeURIComponent(guide.file)}`,
          download: guideFileName(guide),
          'aria-label': `Download ${guide.title} (PDF)`,
        }, 'Download')));
}

// SPEC 5.3: names the file, the question, and the problem in plain words.
function problemsPanel(problems) {
  const byFile = new Map();
  for (const p of problems) {
    if (!byFile.has(p.file)) byFile.set(p.file, { title: p.title, items: [] });
    byFile.get(p.file).items.push(p);
  }
  return h('section.problems', { 'aria-labelledby': 'problems-title' },
    h('h2#problems-title', 'Some files could not be loaded'),
    h('p.problems-lead', 'The files below have mistakes. Until they are fixed, the question sets and study guides they hold are left off the site. Everything else on the site works normally.'),
    [...byFile].map(([file, { title, items }]) => h('div.problem-file',
      h('h3', h('code', file), title ? ` · ${title}` : ''),
      h('ul', items.map(p => h('li',
        p.where ? h('b', `${p.where}: `)
          : p.question ? h('b', `Question ${p.question}${p.qid ? ` ("${p.qid}")` : ''}: `) : null,
        p.problem,
        p.code ? h('pre.problem-code', p.code) : null))))));
}

// ---------- setup (SPEC 4.1–4.3) ----------

async function setupView(root, { args, isCurrent }) {
  const main = h('main.wrap.setup', h('p.lead', 'Loading…'));
  root.replaceChildren(page(main));
  const { sets, courses } = await loadSets();
  if (!isCurrent()) return;
  const set = sets.find(x => x.id === args[0]);
  if (!set) {
    document.title = SITE_NAME;
    fill(main, h('h1.page-title', 'Question set not found'),
      h('p', "This question set isn't on the site. ", h('a', { href: '#/' }, 'Go to the homepage')));
    return;
  }
  document.title = `${set.title} · ${SITE_NAME}`;
  // Back to the set's class tab (SPEC 11).
  const course = courses.find(c => c.code === set.course);
  const back = course ? classLink(course.code) : courses.length ? classLink('other') : '#/';

  const s = { ...DEFAULT_SETTINGS };
  const topics = [...new Set(set.questions.map(q => q.topic))];
  const types = QUESTION_TYPES.filter(t => set.questions.some(q => q.type === t));
  const matching = () => chooseQuestions(set, { ...s, count: null, shuffleQuestions: false }).length;
  const syncs = []; // functions that copy s into the form

  // A group of radio buttons that sets s[key].
  function radios(key, legend, options) {
    const inputs = options.map(([value, label]) => {
      const input = h('input.ctl', { type: 'radio', name: `set-${key}`, value });
      input.addEventListener('change', () => {
        s[key] = value;
        changed();
      });
      return [input, h('label.choice-line', input, typeof label === 'string' ? h('span', label) : label)];
    });
    syncs.push(() => inputs.forEach(([input]) => (input.checked = s[key] === input.value)));
    return h('fieldset.setting', h('legend', legend), inputs.map(([, line]) => line));
  }

  // A checkbox that turns s[key] on or off.
  function toggle(key, label) {
    const input = h('input.ctl', { type: 'checkbox' });
    input.addEventListener('change', () => {
      s[key] = input.checked;
      changed();
    });
    syncs.push(() => (input.checked = !!s[key]));
    return h('label.choice-line', input, h('span', label));
  }

  // Checkboxes for topics or question types; s[key] is null while every box is on.
  function filterBoxes(key, legend, values, labelOf) {
    const inputs = values.map(value => {
      const input = h('input.ctl', { type: 'checkbox', value });
      input.addEventListener('change', () => {
        const on = inputs.filter(i => i.checked).map(i => i.value);
        s[key] = on.length === values.length ? null : on;
        changed();
      });
      return input;
    });
    syncs.push(() => inputs.forEach(i => (i.checked = !s[key] || s[key].includes(i.value))));
    return h('fieldset.setting', h('legend', legend),
      inputs.map((input, n) => h('label.choice-line', input, h('span', labelOf(values[n])))));
  }

  // --- the instruction box (SPEC 4.1) ---
  const summary = h('div.setup-box');

  // --- the two presets (SPEC 4.2) ---
  const presetInputs = {};
  const presetCard = (name, title, points) => {
    const input = h('input.ctl', { type: 'radio', name: 'preset', value: name });
    input.addEventListener('change', () => {
      Object.assign(s, PRESETS[name]);
      changed();
    });
    presetInputs[name] = input;
    return h('label.preset', input,
      h('span.preset-body', h('span.preset-title', title), h('ul.preset-points', points.map(p => h('li', p)))));
  };
  const customNote = h('p.custom-note', { hidden: true }, 'You changed some settings, so neither mode is selected. Your custom settings will be used.');

  // --- Customize settings (SPEC 4.3) ---
  const countInput = h('input.num-input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', 'aria-label': 'Number of questions' });
  const countOf = h('span');
  countInput.addEventListener('input', () => {
    const n = parseInt(countInput.value, 10);
    const most = matching();
    s.count = !n || n >= most ? null : Math.max(1, n);
    changed();
  });
  syncs.push(() => {
    const most = matching();
    countInput.max = String(most);
    if (document.activeElement !== countInput) countInput.value = String(s.count ?? most);
    countOf.textContent = ` of ${most}`;
  });

  const minutesInput = h('input.num-input', { type: 'number', min: '1', max: '600', step: '1', inputmode: 'numeric', 'aria-label': 'Custom time in minutes' });
  minutesInput.addEventListener('input', () => {
    const m = parseInt(minutesInput.value, 10);
    s.minutes = m >= 1 ? Math.min(m, 600) : null;
    s.timer = 'custom';
    changed();
  });
  syncs.push(() => {
    if (document.activeElement !== minutesInput) minutesInput.value = s.minutes ?? '';
  });
  const standardLabel = h('span');

  const settings = h('div.settings',
    radios('reveal', 'Show answers', [['each', 'After each question'], ['end', 'At the end']]),
    radios('navigation', 'Navigation', [['continue', 'Continue only (no going back)'], ['back', 'Allow going back and flagging']]),
    radios('timer', 'Timer', [
      ['standard', standardLabel],
      ['custom', h('span', 'Custom: ', minutesInput, ' minutes')],
      ['off', 'Off'],
    ]),
    h('fieldset.setting',
      h('legend', 'Number of questions'),
      h('div.choice-line', countInput, countOf),
      h('p.setting-note', 'Case-study questions stay together and in order.')),
    filterBoxes('topics', 'Topics to include', topics, t => `${t} (${set.questions.filter(q => q.topic === t).length})`),
    filterBoxes('types', 'Question types to include', types, t => `${typeLabel(t)} (${set.questions.filter(q => q.type === t).length})`),
    h('fieldset.setting',
      h('legend', 'Options'),
      toggle('shuffleQuestions', 'Shuffle question order'),
      toggle('shuffleChoices', 'Shuffle answer choices'),
      fullscreenAvailable() ? toggle('fullscreen', 'Full screen') : null,
      toggle('calculator', 'Calculator available')),
    radios('textSize', 'Text size', [['standard', 'Standard'], ['large', 'Large'], ['larger', 'Larger']]));

  const problem = h('p.setup-problem', { role: 'alert' });
  const beginBtn = h('button.btn.btn-accent.btn-big', { type: 'button', onclick: () => begin(set, { ...s }) }, 'Begin');

  // After any change: work out which preset still matches, then redraw.
  // (Boxes being typed in are left alone; see the sync functions above.)
  function changed() {
    if (s.timer === 'custom' && s.minutes == null && document.activeElement !== minutesInput) {
      // Start a custom timer from the standard time.
      s.minutes = Math.max(1, Math.round(timeLimitMs(set, chooseQuestions(set, { ...s, shuffleQuestions: false }).length, { ...s, timer: 'standard' }) / 60000));
    }
    s.preset = presetMatches(s, 'exam') ? 'exam' : presetMatches(s, 'practice') ? 'practice' : 'custom';
    syncs.forEach(fn => fn());
    refresh();
  }

  function refresh() {
    for (const [name, input] of Object.entries(presetInputs)) input.checked = s.preset === name;
    customNote.hidden = s.preset !== 'custom';
    const n = chooseQuestions(set, { ...s, shuffleQuestions: false }).length;
    const ms = timeLimitMs(set, n, s);
    standardLabel.textContent = `Standard (${minutesText(timeLimitMs(set, n, { ...s, timer: 'standard' }))})`;
    fill(summary,
      h('p.setup-lead', h('b', `This assessment has ${plural(n, 'item')}. `),
        s.timer === 'off' ? 'It is untimed.' : ms ? `You have ${minutesText(ms)} to complete it.` : ''),
      h('ul',
        h('li', s.reveal === 'each' ? 'You will see the answer and rationale after each question.' : 'You will see your score, answers, and rationales at the end.'),
        h('li', s.navigation === 'back' ? 'You can go back to earlier questions and flag questions to review.' : 'Select Continue to move to the next question. You cannot go back.'),
        ms ? h('li', 'You can pause the timer for up to 5 minutes in total.') : null,
        s.fullscreen && fullscreenAvailable() ? h('li', 'The exam opens in full screen. Press Esc to leave full screen.') : null));
    const needMinutes = s.timer === 'custom' && !(s.minutes >= 1);
    problem.textContent = !n ? 'No questions match these settings. Turn on more topics or question types.'
      : needMinutes ? 'Enter how many minutes the custom timer should run.' : '';
    beginBtn.disabled = !n || needMinutes;
  }

  fill(main,
    h('p.crumb', h('a', { href: back }, course ? `← ${course.code} ${course.name}` : '← All question sets')),
    set.exam ? h('p.set-exam', h('span.tag', set.exam)) : null,
    h('h1.page-title', set.title),
    set.description ? h('p.lead', set.description) : null,
    summary,
    h('fieldset.presets',
      h('legend.section-title', 'Choose a mode'),
      h('div.preset-cards',
        presetCard('exam', 'Exam simulation', ['Timed, with up to 5 minutes of pause', 'Continue only: no going back', 'Answers and rationales at the end', 'Full screen, shuffled questions and choices']),
        presetCard('practice', 'Practice mode', ['Untimed', 'Answer and rationale after each question', 'Go back and flag questions'])),
      customNote),
    h('details.customize', h('summary', 'Customize settings'), settings),
    problem,
    h('div.setup-actions', beginBtn, h('a.btn', { href: back }, 'Back')));
  changed();
}

// ---------- results (SPEC 4.5) ----------

async function resultsView(root, { isCurrent }) {
  document.title = `Results · ${SITE_NAME}`;
  const r = lastAttempt();
  const main = h('main.wrap.results');
  root.replaceChildren(page(main));
  if (!r) {
    fill(main, h('h1.page-title', 'No results yet'),
      h('p', 'Finish an exam to see your results here. ', h('a', { href: '#/' }, 'Go to the homepage')));
    return;
  }
  const { sets } = await loadSets();
  if (!isCurrent()) return;
  const set = sets.find(x => x.id === r.setId);
  const fullyCorrect = r.items.length - r.missed.length;
  const mode = { exam: 'Exam simulation', practice: 'Practice mode' }[r.settings?.preset] ?? 'Custom settings';
  const scope = r.scope === 'missed' ? ' · Missed questions only'
    : r.scope === 'part' && set ? ` · ${r.items.length} of ${set.questions.length} questions` : '';
  const byType = groupBy(r.items, i => i.type)
    .sort((a, b) => QUESTION_TYPES.indexOf(a[0]) - QUESTION_TYPES.indexOf(b[0]))
    .map(([type, g]) => [typeLabel(type), g]);

  fill(main,
    h('h1.page-title', 'Exam Results'),
    h('p.lead', `${r.title} · ${fmtDate(r.finishedAt)} · ${mode}${scope}`),
    r.reason === 'time' ? h('p.notice', 'Time ran out, so your exam was submitted automatically.') : null,
    h('div.score-card',
      h('p.score-big', `${r.percent}%`),
      h('div.score-facts',
        h('p', h('b', `${r.earned} of ${r.possible} points`)),
        h('p', `${fullyCorrect} of ${plural(r.items.length, 'question')} fully correct`),
        h('p', `Time used: ${fmtClock(r.timeUsedMs)}`))),
    h('p.note', 'Next-generation (NGN) questions, such as matrix, drop-down, highlight, and bow tie, can earn partial credit, so your score is the points you earned out of the points possible.'),
    h('div.result-actions',
      h('a.btn.btn-accent', { href: '#/review' }, 'Review all answers'),
      r.missed.length
        ? h('a.btn', { href: '#/review/incorrect' }, `Review incorrect only (${r.missed.length})`)
        : h('button.btn', { type: 'button', disabled: true }, 'No incorrect answers'),
      set && r.missed.length
        ? h('button.btn', { type: 'button', onclick: () => retakeMissed(set, r.missed, r.settings) }, `Retake missed questions (${r.missed.length})`)
        : null,
      set ? h('a.btn', { href: `#/setup/${encodeURIComponent(set.id)}` }, 'Retake full set') : null,
      h('a.btn', { href: '#/' }, 'Home')),
    perfTable('Performance by topic', 'Topic', groupBy(r.items, i => i.topic).sort((a, b) => a[0].localeCompare(b[0]))),
    perfTable('Performance by question type', 'Question type', byType));
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const g = groups.get(key) ?? { questions: 0, earned: 0, max: 0 };
    g.questions++;
    g.earned += item.earned;
    g.max += item.max;
    groups.set(key, g);
  }
  return [...groups];
}

function perfTable(title, firstHeader, rows) {
  return h('section.perf-section',
    h('h2.section-title', title),
    h('div.table-scroll', h('table.perf',
      h('thead', h('tr',
        h('th', { scope: 'col' }, firstHeader),
        h('th.num.q-col', { scope: 'col' }, 'Questions'),
        h('th.num', { scope: 'col' }, 'Points'),
        h('th', { scope: 'col' }, 'Score'))),
      h('tbody', rows.map(([name, g]) => {
        const pct = g.max ? Math.round((g.earned / g.max) * 100) : 0;
        return h('tr',
          h('th', { scope: 'row' }, name),
          h('td.num.q-col', g.questions),
          h('td.num', `${g.earned} / ${g.max}`),
          h('td.bar-cell', h('div.bar',
            h('span.bar-track', { 'aria-hidden': 'true' }, h('span.bar-fill', { style: `width: ${pct}%` })),
            h('span.bar-pct', `${pct}%`))));
      })))));
}

// ---------- router ----------

const routes = {
  '': homeView, class: homeView, setup: setupView, exam: examView, results: resultsView, review: reviewView, group: groupView, host: hostView,
};
let cleanup = null;
let routeCount = 0;

async function route() {
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  const id = ++routeCount;
  const [name = '', ...args] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const view = routes[name] ?? homeView;
  window.scrollTo(0, 0);
  const done = await view(app, { args, isCurrent: () => id === routeCount });
  if (id === routeCount && typeof done === 'function') cleanup = done;
  else if (typeof done === 'function') done();
}

addEventListener('hashchange', route);
route();
