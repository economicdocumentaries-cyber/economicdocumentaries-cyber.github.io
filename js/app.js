// Hash router and the pages around the exam (SPEC 2, 4.1–4.5, 11): homepage
// with its class tabs, setup, results, and saved questions. Group study's pages are in
// group.js. Routes use #/ links because GitHub Pages has no server-side routing.
import { SITE_NAME } from './config.js';
import { h, fill, modal, toast, store, siteHeader, siteFooter, fmtClock, fmtDate, icon, onSwipe } from './util.js';
import { typeLabel, QUESTION_TYPES, keyResponse } from './items.js';
import { loadSets } from './sets.js';
import {
  examView, reviewView, startExam, resumeExam, activeExam, discardExam, lastAttempt, setHistory,
  DEFAULT_SETTINGS, PRESETS, presetMatches, chooseQuestions, timeLimitMs, fullscreenAvailable, defaultCount, countsForBest,
  questionArea, questionParts, feedbackPanel,
} from './exam.js';
import { savedSets, savedCount, setSaved, forgetSet, saveButton } from './saved.js';
import { groupView, hostView, liveBanner } from './group.js';
import { watchUploadedGuides, downloadButton, guideFileName, formatSize } from './study-guides.js';
import { withChanges, cachedChanges, watchChanges, currentChanges } from './set-changes.js';
import { arrange, newestSet, newestGuide, guideKey, cachedOrder, watchOrder } from './order.js';
import { hostSignedIn, HOST_HINT } from './firebase.js';
import { trackPage, track, countThisBrowser, thisBrowserCounts } from './analytics.js';

const app = document.getElementById('app');

// ---------- shared ----------

function page(main) {
  const el = h('div.page', siteHeader(), main, siteFooter());
  // The host's "Student view" (SPEC 11.4): the host sees the pages exactly as
  // students do, plus a button back to the host console. Students never see it.
  if (store.get(HOST_HINT)) {
    hostSignedIn().then(yes => {
      if (yes && el.isConnected) el.append(h('a.host-pill', { href: '#/host' }, '← Back to host view'));
    });
  }
  return el;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const minutesText = ms => plural(Math.round(ms / 60000), 'minute');

// Starts an exam from a click. Starting a new exam ends the one in progress,
// so ask first. Without that question, full screen is requested right away,
// while the click still counts. onStart() runs once the exam has started.
// scope: see startExam().
function begin(set, settings, onStart, scope = null) {
  const go = () => startExam(set, settings, scope) && onStart?.();
  const active = activeExam();
  if (!active) return go();
  modal({
    title: 'Start a New Exam?',
    message: `You have an exam in progress (${active.title}). Starting a new one ends it, and its answers will not be scored.`,
    buttons: [{ label: 'Cancel', value: 'cancel', accent: true }, { label: 'Start new exam', value: 'start' }],
  }).then(choice => {
    if (choice === 'start') go();
  });
}

// The usage stats for an exam started on the setup page: "exam-start", and
// "settings-changed" with each setting that differs from the mode the student
// chose (README "Usage stats").
function trackStart(set, s, chosen, topicCount, typeCount) {
  const base = { ...DEFAULT_SETTINGS, count: defaultCount(set), ...PRESETS[chosen] };
  const on = v => (v ? 'on' : 'off');
  const changes = [];
  const differs = key => JSON.stringify(s[key] ?? null) !== JSON.stringify(base[key] ?? null);
  if (differs('reveal')) changes.push(['answers', s.reveal === 'each' ? 'after each question' : 'at the end']);
  if (differs('navigation')) changes.push(['navigation', s.navigation === 'back' ? 'going back' : 'continue only']);
  if (differs('timer') || (s.timer === 'custom' && differs('minutes'))) changes.push(['timer', s.timer === 'custom' ? `${s.minutes} minutes` : s.timer]);
  if (differs('count')) changes.push(['questions', s.count ?? 'all']);
  if (s.topics) changes.push(['topics', `${s.topics.length} of ${topicCount}`]);
  if (s.types) changes.push(['types', `${s.types.length} of ${typeCount}`]);
  for (const [key, name] of [['shuffleQuestions', 'shuffle-questions'], ['shuffleChoices', 'shuffle-choices'], ['fullscreen', 'full-screen'], ['calculator', 'calculator']]) {
    if (differs(key)) changes.push([name, on(s[key])]);
  }
  if (differs('textSize')) changes.push(['text-size', s.textSize]);
  const where = { set: set.id, class: set.course ?? 'other' };
  track('exam-start', { ...where, mode: s.preset, customized: changes.length ? 'yes' : 'no', questions: chooseQuestions(set, { ...s, shuffleQuestions: false }).length });
  if (changes.length) track('settings-changed', { ...where, ...Object.fromEntries(changes) });
}

// "Retake missed questions": only the questions without full points, with the
// same settings as before.
function retakeMissed(set, ids, settings) {
  const known = new Set(set.questions.map(q => q.id));
  const only = ids.filter(id => known.has(id));
  if (only.length) {
    begin(set, { ...DEFAULT_SETTINGS, ...settings, only, count: null, topics: null, types: null },
      () => track('retake-missed', { set: set.id, class: set.course ?? 'other', questions: only.length }));
  }
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
  onSwipe(main, way => main.querySelector('.classes')?.swipe(way)); // phones: change class (SPEC 11.8)
  root.replaceChildren(page(main));
  const { sets, courses, guides, problems } = await loadSets();
  if (!isCurrent()) return;
  const live = liveBanner(); // "Group study is live" (SPEC 6.4), when Firebase is set up
  const lists = h('div.home-lists');
  let groups = null, single = null, uploaded = [], painted = null;
  let changes = cachedChanges();
  let order = cachedOrder();

  // The sets with the host's changes (SPEC 11.3), in the host's order (SPEC
  // 11.4): the ones last seen on this browser at first, then Firebase's, and
  // again after every change.
  function paint() {
    const key = JSON.stringify([changes, order]);
    if (key === painted) return;
    painted = key;
    const visible = withChanges(sets, changes, courses).filter(s => !s.hidden);
    groups = classGroups(courses, visible, guides);
    single = groups ? null : { key: 'other', course: null, sets: visible, guides, allClasses: true }; // the one list without a class list
    for (const g of groups ?? [single]) g.order = order[g.key] ?? {};
    const tab = /^#\/class\/([^/]+)/.exec(location.hash)?.[1]; // the tab showing now, after a repaint too
    fill(lists, groups ? classTabs(groups, tab ? decodeURIComponent(tab) : args[0])
      : homeLists(single, problems.length ? 'No question sets can be shown right now.' : 'There are no question sets yet.'));
    (groups ?? [single]).forEach(g => g.paintGuides(uploaded));
  }

  const saved = savedLink();
  fill(main,
    h('h1.page-title', 'Practice exams and study guides'),
    h('p.lead', `Choose ${courses.length ? 'your class, then ' : ''}a question set or study guide. Exam simulation works like test day; practice mode shows the answer after each question.`),
    live.el,
    resumeBanner(),
    saved ? h('p.home-saved', saved) : null,
    lists,
    problems.length ? problemsPanel(problems) : null);
  paint();
  const stopChanges = watchChanges(c => {
    changes = c;
    paint();
  });
  const stopOrder = watchOrder(o => {
    order = o;
    paint();
  });
  // Guides the host uploads (SPEC 11.2) come from Firebase, and appear as soon as they're added.
  const stopGuides = watchUploadedGuides(courses, list => {
    uploaded = list;
    (groups ?? [single]).forEach(g => g.paintGuides(list));
  });
  return () => {
    live.stop();
    stopChanges();
    stopOrder();
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

// A class's practice exams, then its study guides (SPEC 11), each in the
// host's order, newest first otherwise (SPEC 11.4): the published guides, and
// the ones the host uploaded (SPEC 11.2), which group.paintGuides(uploaded)
// adds when they arrive. Other never has study guides; the no-classes list
// shows them only when there are some.
function homeLists(group, noSets) {
  const sets = arrange(group.sets, s => s.id, group.order?.sets, newestSet); // the host's order (SPEC 11.4)
  const saved = savedCount();
  const exams = h('section.home-section',
    h('div.section-head',
      h('h2.section-title', 'Practice exams'),
      // Phones (SPEC 11.8): the Saved questions link, small, beside the heading.
      saved ? h('a.saved-chip', { href: '#/saved' }, icon('bookmark'), `Saved (${saved})`) : null),
    sets.length ? h('ul.set-list', sets.map(setRow)) : h('p.empty-note', noSets));
  group.paintGuides = () => {};
  if (!group.course && !group.allClasses) return exams;
  const list = h('ul.set-list');
  const empty = h('p.empty-note', 'No study guides for this class yet.');
  const guides = h('section.home-section', h('h2.section-title', 'Study guides'), list, empty);
  group.paintGuides = (uploaded = []) => {
    const all = arrange([...group.guides, ...uploaded.filter(g => !group.course || g.course === group.course.code)], guideKey, group.order?.guides, newestGuide);
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
  // Phones (SPEC 11.8): a swipe left or right anywhere on the page (homeView
  // listens) shows the next or previous class; the dots show which one.
  const dots = groups.map(() => h('span.dot'));
  const hint = groups.length > 1 ? h('p.swipe-hint', { 'aria-hidden': 'true' }, h('span.dots-row', dots), 'Swipe for other classes') : null;
  const box = h('div.classes', tablist, hint, panels);
  box.swipe = way => {
    const next = current + (way === 'left' ? 1 : way === 'right' ? -1 : 0);
    if (next === current || !groups[next]) return;
    choose(next);
    panels[next].dataset.slide = way;
    panels[next].addEventListener('animationend', () => delete panels[next].dataset.slide, { once: true });
    if (tablist.getBoundingClientRect().top < 0) tablist.scrollIntoView({ block: 'start' });
  };
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
    dots.forEach((dot, j) => dot.classList.toggle('on', j === i));
  }

  function choose(i) {
    show(i);
    store.set(CLASS_KEY, groups[i].key);
    history.replaceState(history.state, '', classLink(groups[i].key));
  }

  show(current);
  return box;
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
  const total = set.questions.length;
  const count = defaultCount(set) ?? total; // what Start and Begin give (SPEC 11.3)
  const minutes = Math.round(timeLimitMs(set, count, { timer: 'standard' }) / 60000);
  const past = setHistory(set.id);
  const last = past.at(-1);
  const counted = past.filter(a => countsForBest(a, set));
  const best = counted.length ? Math.max(...counted.map(a => a.percent)) : null;
  const known = new Set(set.questions.map(q => q.id));
  const missed = (last?.missed ?? []).filter(id => known.has(id));
  const lastScope = last?.scope === 'missed' ? `, ${plural(last.count, 'missed question')}`
    : last?.scope === 'saved' ? `, ${plural(last.count, 'saved question')}`
    : last?.scope === 'part' ? `, ${plural(last.count, 'question')}` : '';
  // Phones (SPEC 11.8): the description, and the size of the whole set, open under More details.
  const desc = set.description ? h('p.set-desc', set.description) : null;
  const more = desc || count < total ? h('button.more-details', { type: 'button', 'aria-expanded': 'false' }, 'More details') : null;
  more?.addEventListener('click', () => {
    const open = row.classList.toggle('show-details');
    more.setAttribute('aria-expanded', String(open));
    more.textContent = open ? 'Fewer details' : 'More details';
  });
  const row = h('li.set-row',
    h('div.set-info',
      set.exam ? h('p.set-exam', h('span.tag', set.exam)) : null,
      h('h3', set.title),
      desc,
      h('p.set-meta', count < total
        ? [h('span.meta-wide', `${plural(count, 'question')} per exam, from a set of ${total} · ${minutes} minutes`),
            h('span.meta-phone', `${plural(count, 'question')} · ${minutes} min`)] // phones: the whole line is under More details
        : `${plural(total, 'question')} · ${minutes} minutes`),
      last ? h('p.set-history',
        'Last score: ', h('b', `${last.percent}%`), ` (${fmtDate(last.at, true)}${lastScope})`,
        best != null ? [' · Best: ', h('b', `${best}%`)] : null) : null),
    h('div.set-actions',
      h('a.btn.btn-accent', { href: `#/setup/${encodeURIComponent(set.id)}` }, 'Start'),
      missed.length ? h('button.btn', { type: 'button', onclick: () => retakeMissed(set, missed, last.settings) }, `Retake missed (${missed.length})`) : null,
      more));
  return row;
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
          onclick: () => track('guide-download', { class: guide.course, guide: guide.title, kind: 'published' }),
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
  const [loaded, changes] = await Promise.all([loadSets(), currentChanges()]);
  if (!isCurrent()) return;
  const { courses } = loaded;
  const set = withChanges(loaded.sets, changes, courses).find(x => x.id === args[0]); // with the host's changes (SPEC 11.3)
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

  // Practice mode first (the owner's choice, 2026-10-15).
  const s = { ...DEFAULT_SETTINGS, ...PRESETS.practice, preset: 'practice', count: defaultCount(set) };
  let chosen = 'practice'; // the mode the student picked last, for the usage stats
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
      chosen = name;
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
    if (document.activeElement !== countInput) countInput.value = String(Math.min(s.count ?? most, most));
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
      h('p.setting-note', 'Questions are spread across the topics, and ones you haven\'t seen yet come first. Case-study questions stay together and in order.')),
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
  const beginBtn = h('button.btn.btn-accent.btn-big', {
    type: 'button',
    onclick: () => {
      const settings = { ...s };
      begin(set, settings, () => trackStart(set, settings, chosen, topics.length, types.length));
    },
  }, 'Begin');

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
        h('li', s.navigation === 'back' ? 'You can go back to earlier questions. Flag a question to skip it for now and come back to it later.' : 'Select Continue to move to the next question. You cannot go back.'),
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
        presetCard('practice', 'Practice mode', ['Untimed', 'Answer and rationale after each question', 'Go back and flag questions', 'No full screen']),
        presetCard('exam', 'Exam simulation', ['Timed, with up to 5 minutes of pause', 'Continue only: no going back', 'Answers and rationales at the end', 'Full screen, shuffled questions and choices'])),
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
  const { sets, courses } = await loadSets();
  if (!isCurrent()) return;
  const set = withChanges(sets, cachedChanges(), courses).find(x => x.id === r.setId);
  const fullyCorrect = r.items.length - r.missed.length;
  const mode = { exam: 'Exam simulation', practice: 'Practice mode' }[r.settings?.preset] ?? 'Custom settings';
  const early = r.reason === 'early';
  const scope = r.scope === 'missed' ? ' · Missed questions only'
    : r.scope === 'saved' ? ' · Saved questions only'
    : early ? ` · Finished early: ${r.items.length} of ${r.total} answered`
    : r.scope === 'part' && set ? ` · ${r.items.length} of ${set.questions.length} questions` : '';
  const byType = groupBy(r.items, i => i.type)
    .sort((a, b) => QUESTION_TYPES.indexOf(a[0]) - QUESTION_TYPES.indexOf(b[0]))
    .map(([type, g]) => [typeLabel(type), g]);

  fill(main,
    h('h1.page-title', 'Exam Results'),
    h('p.lead', `${r.title} · ${fmtDate(r.finishedAt)} · ${mode}${scope}`),
    r.reason === 'time' ? h('p.notice', 'Time ran out, so your exam was submitted automatically.') : null,
    early ? h('p.notice', `You finished early, so this score is for the ${r.items.length === 1 ? 'question' : `${r.items.length} questions`} you answered`
      + `${r.total > r.items.length ? `, out of ${r.total}` : ''}. Questions you didn't answer aren't counted, and this attempt doesn't count toward your best score.`) : null,
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
      set ? h('a.btn', { href: `#/setup/${encodeURIComponent(set.id)}` }, 'Retake this set') : null,
      savedLink(),
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

// ---------- saved questions (SPEC 11.7) ----------

// "Saved questions (3)" on the homepage and the results page, once there are some.
function savedLink() {
  const n = savedCount();
  return n ? h('a.btn.saved-link', { href: '#/saved' }, icon('bookmark'), `Saved questions (${n})`) : null;
}

// A set's saved questions as [question id, when saved], newest first.
const newestSaved = entry => Object.entries(entry?.questions ?? {}).sort((a, b) => b[1] - a[1]);

// The stem as plain text, shortened, for the list.
function stemStart(q, length = 160) {
  const t = document.createElement('template');
  t.innerHTML = q.stem;
  const text = t.content.textContent.replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd().replace(/[.,;:]+$/, '')}…` : text;
}

// #/saved: the saved questions by class and set (in the homepage's order),
// newest first, each with View answer and Remove, and Practice these for each
// set. Questions and sets taken off the site since are listed with a note.
// #/saved/<set id>/<question id> is savedQuestionView.
async function savedView(root, ctx) {
  if (ctx.args[0]) return savedQuestionView(root, ctx);
  document.title = `Saved questions · ${SITE_NAME}`;
  const main = h('main.wrap.saved-page', h('p.lead', 'Loading…'));
  root.replaceChildren(page(main));
  const [loaded, changes] = await Promise.all([loadSets(), currentChanges()]);
  if (!ctx.isCurrent()) return;
  const { courses } = loaded;
  const sets = new Map(withChanges(loaded.sets, changes, courses).filter(s => !s.hidden).map(s => [s.id, s]));
  const order = cachedOrder();
  let rowCount = 0; // for the ids that tell the buttons apart

  function paint() {
    const all = savedSets();
    const here = Object.keys(all).filter(id => sets.has(id)).map(id => sets.get(id));
    const gone = Object.keys(all).filter(id => !sets.has(id));
    const groups = courses.length
      ? [...courses.map(c => ({ key: c.code, title: `${c.code} ${c.name}`, sets: here.filter(s => s.course === c.code) })),
          { key: 'other', title: 'Other', sets: here.filter(s => !s.course) }]
      : [{ key: 'other', title: null, sets: here }];
    fill(main,
      h('p.crumb', h('a', { href: '#/' }, '← Home')),
      h('h1.page-title', { tabindex: '-1' }, 'Saved questions'),
      h('p.lead', 'Questions you saved in practice mode or while reviewing an exam. They\'re kept on this browser only.'),
      Object.keys(all).length ? null : [
        h('p.empty-note', 'You haven\'t saved any questions yet. In practice mode, or when you review your answers after an exam, select Save on a question to keep it here.'),
        h('div.form-actions', h('a.btn.btn-accent', { href: '#/' }, 'Home'))],
      groups.filter(g => g.sets.length).map(g => h('section.saved-class',
        g.title ? h('h2.section-title', g.title) : null,
        arrange(g.sets, s => s.id, order[g.key]?.sets, newestSet).map(s => setBlock(s, all[s.id])))),
      gone.length ? h('section.saved-class',
        h('h2.section-title', 'Not on the site right now'),
        gone.map(id => goneBlock(id, all[id]))) : null);
  }

  function setBlock(set, entry) {
    const byId = new Map(set.questions.map(q => [q.id, q]));
    const saved = newestSaved(entry);
    const shown = saved.map(([id]) => id).filter(id => byId.has(id));
    return h('section.saved-set',
      h('div.saved-set-head',
        h('div.set-info',
          set.exam ? h('p.set-exam', h('span.tag', set.exam)) : null,
          h('h3', set.title),
          h('p.set-meta', plural(saved.length, 'saved question'))),
        shown.length ? h('div.set-actions', h('button.btn.btn-accent', {
          type: 'button',
          onclick: () => begin(set, { ...DEFAULT_SETTINGS, ...PRESETS.practice, preset: 'practice', only: shown }, null, 'saved'),
        }, shown.length === 1 ? 'Practice this one' : `Practice these (${shown.length})`)) : null),
      h('ul.saved-list', saved.map(([id, at]) => savedRow(set, byId.get(id), id, at))));
  }

  // One saved question: the start of its text, its type, topic, and the day
  // it was saved. A question no longer in the set just says so.
  function savedRow(set, q, id, at) {
    const textId = `saved-text-${++rowCount}`;
    const remove = h('button.btn', { type: 'button', 'aria-describedby': textId, onclick: e => removeRow(e.currentTarget, set, id) }, 'Remove');
    const when = `Saved ${fmtDate(at, true)}`;
    if (!q) {
      return h('li.saved-item.is-gone',
        h('div.saved-info', h('p.saved-text', { id: textId }, 'This question is no longer in the set.'), h('p.set-meta', when)),
        h('div.set-actions', remove));
    }
    return h('li.saved-item',
      h('div.saved-info',
        h('p.saved-text', { id: textId }, stemStart(q)),
        h('p.set-meta', `${typeLabel(q.type)} · ${q.topic} · ${when}`)),
      h('div.set-actions',
        h('a.btn', { href: `#/saved/${encodeURIComponent(set.id)}/${encodeURIComponent(id)}`, 'aria-describedby': textId }, 'View answer'),
        remove));
  }

  // The keyboard focus goes on to the next saved question (or the one before), or to the title.
  function removeRow(button, set, id) {
    const at = [...main.querySelectorAll('.saved-item')].indexOf(button.closest('.saved-item'));
    setSaved(set.id, set.title, id, false);
    paint();
    const rows = [...main.querySelectorAll('.saved-item')];
    (rows[Math.min(at, rows.length - 1)]?.querySelector('.btn') ?? main.querySelector('.page-title')).focus();
    toast('Removed from your saved questions.');
  }

  // A set that's been taken off the site (or hidden by the host) since.
  function goneBlock(setId, entry) {
    return h('section.saved-set.is-gone',
      h('div.saved-set-head',
        h('div.set-info',
          h('h3', entry.title || setId),
          h('p.set-meta', `${plural(newestSaved(entry).length, 'saved question')} · This set isn't on the site right now.`)),
        h('div.set-actions', h('button.btn', {
          type: 'button',
          onclick: () => {
            forgetSet(setId);
            paint();
            main.querySelector('.page-title').focus();
            toast('Removed from your saved questions.');
          },
        }, 'Remove'))));
  }

  paint();
}

// #/saved/<set id>/<question id>: a set's saved questions one at a time,
// newest first, starting at that question. Like review mode: the question with
// its answer key and rationale, Save (to remove it from the list), and free
// Previous and Next. The link follows the question shown, so a reload stays on it.
async function savedQuestionView(root, { args, isCurrent }) {
  const [setId, startId] = args;
  root.replaceChildren(page(h('main.wrap.plain-page', h('p.lead', 'Loading…'))));
  const [loaded, changes] = await Promise.all([loadSets(), currentChanges()]);
  if (!isCurrent()) return;
  const set = withChanges(loaded.sets, changes, loaded.courses).find(s => s.id === setId && !s.hidden);
  const byId = new Map((set?.questions ?? []).map(q => [q.id, q]));
  const list = newestSaved(savedSets()[setId]).map(([id]) => byId.get(id)).filter(Boolean);
  if (!list.length) {
    document.title = `Saved questions · ${SITE_NAME}`;
    fill(root, page(h('main.wrap.plain-page',
      h('h1.page-title', 'Nothing to show'),
      h('p.lead', 'This question isn\'t in your saved questions, or it\'s no longer on the site.'),
      h('div.form-actions', h('a.btn.btn-accent', { href: '#/saved' }, 'Saved questions')))));
    return;
  }
  let index = Math.max(0, list.findIndex(q => q.id === startId));
  const tabs = new Map();
  const counter = h('h1.q-counter', { tabindex: '-1' });
  const question = h('section.question');
  const prevBtn = h('button.btn.btn-nav', { type: 'button', onclick: () => go(index - 1) }, 'Previous');
  const saver = saveButton();
  const nextBtn = h('button.btn-continue', {
    type: 'button',
    onclick: () => {
      if (index < list.length - 1) go(index + 1);
      else location.hash = '#/saved';
    },
  }, 'Next');
  const actions = h('div.exam-actions', h('div.nav-left', prevBtn, saver.el), nextBtn);
  const area = questionArea(question, set.cases ?? {}, { get: key => tabs.get(key) ?? 0, set: (key, i) => tabs.set(key, i) });

  root.replaceChildren(h('div.page.exam.review',
    siteHeader({ title: set.title, onClose: () => (location.hash = '#/saved'), link: false }),
    h('main.wrap',
      h('div.info-row',
        h('div.counter-wrap', counter, h('span.mode-tag', 'Saved questions')),
        h('div.info-tools', h('a.btn', { href: '#/saved' }, 'Back to saved questions'))),
      question),
    siteFooter()));

  function go(i) {
    index = i;
    show(true);
  }

  function show(moveFocus) {
    const q = list[index];
    const key = keyResponse(q);
    counter.textContent = `Question: ${index + 1} of ${list.length}`;
    document.title = `Saved questions · ${set.title}`;
    prevBtn.hidden = index === 0;
    nextBtn.textContent = index === list.length - 1 ? 'Finish' : 'Next';
    saver.show(set.id, set.title, q.id);
    history.replaceState(history.state, '', `#/saved/${encodeURIComponent(set.id)}/${encodeURIComponent(q.id)}`);
    area.show(q, [
      ...questionParts(q, { response: key, review: true, answerKey: true }),
      feedbackPanel(q, key, { answerKey: true, report: set.id }),
      actions,
    ]);
    if (moveFocus) {
      window.scrollTo(0, 0);
      counter.focus({ preventScroll: true });
    }
  }

  show(false);
}

// ---------- router ----------

// #/stats-off and #/stats-on (README "Usage stats"): whether this browser's
// visits count. Not linked anywhere; the host's sign-in turns it off too.
function statsView(root, on) {
  countThisBrowser(on);
  document.title = `Usage stats · ${SITE_NAME}`;
  fill(root, page(h('main.wrap.plain-page',
    h('h1.page-title', 'Usage stats'),
    h('p.lead', thisBrowserCounts()
      ? 'Visits on this browser count in the site\'s anonymous usage stats again.'
      : 'Visits on this browser don\'t count in the site\'s anonymous usage stats.'),
    h('div.form-actions',
      h('a.btn.btn-accent', { href: '#/' }, 'Home'),
      h('a.btn', { href: thisBrowserCounts() ? '#/stats-off' : '#/stats-on' }, thisBrowserCounts() ? 'Don\'t count them' : 'Count them again')))));
}

const routes = {
  '': homeView, class: homeView, setup: setupView, exam: examView, results: resultsView, review: reviewView, saved: savedView, group: groupView, host: hostView,
  'stats-off': root => statsView(root, false), 'stats-on': root => statsView(root, true),
};
const UNCOUNTED = new Set(['host', 'stats-off', 'stats-on']); // the host's pages, and the stats switch
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
  // One page view per page change, counted as a path: "/", "/class/NU1120", "/exam".
  // A saved question's page counts as its set's: "/saved/<set id>".
  const counted = name === 'saved' ? args.slice(0, 1) : args;
  if (id === routeCount && !UNCOUNTED.has(name)) trackPage(`/${[name, ...counted].filter(Boolean).map(encodeURIComponent).join('/')}`);
}

addEventListener('hashchange', route);
route();
