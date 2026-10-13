// The exam screen (SPEC 3.2–3.5, 4.2–4.5): header, question counter, timer,
// pause, calculator, Continue, alerts, full screen, saved progress, the
// case-study layout, practice feedback, going back and flagging, and review mode.
import { h, fill, shuffle, store, fmtClock, modal, closeModals, toast, siteHeader, siteFooter, icon } from './util.js';
import { renderItem, prepareItem, isAnswered, scoreItem, instructionFor, helpFor, unansweredMessage } from './items.js';
import { createCalculator } from './calc.js';

const ACTIVE = 'pe.active'; // the exam in progress
const LAST = 'pe.last'; // the most recently finished attempt, for results and review
const HISTORY = 'pe.history'; // { setId: [last 20 attempts] }
const HISTORY_LIMIT = 20;
const PAUSE_MS = 5 * 60 * 1000;
const LOW_TIME_MS = 5 * 60 * 1000;

// SPEC 4.2. Choosing a preset on the setup screen fills these settings in.
export const PRESETS = {
  exam: { reveal: 'end', navigation: 'continue', timer: 'standard', fullscreen: true, shuffleQuestions: true, shuffleChoices: true },
  practice: { reveal: 'each', navigation: 'back', timer: 'off' },
};

// SPEC 4.3. "Exam simulation" is the default.
export const DEFAULT_SETTINGS = {
  preset: 'exam',
  ...PRESETS.exam,
  minutes: null, // for timer: 'custom'
  count: null, // null = every question
  topics: null, // null = every topic
  types: null, // null = every question type
  only: null, // question ids, for "Retake missed questions"
  calculator: true,
  textSize: 'standard',
};

export const presetMatches = (s, name) => Object.entries(PRESETS[name]).every(([k, v]) => s[k] === v);

export const activeExam = () => store.get(ACTIVE);
export const lastAttempt = () => store.get(LAST);
export const setHistory = setId => store.get(HISTORY, {})[setId] ?? [];

// ---------- full screen ----------

let fsRequest = null; // a request still waiting for the browser's answer
let fsRefused = false; // the browser said no; stop asking until the page reloads

export const fullscreenAvailable = () => !!document.fullscreenEnabled; // false on iPhone

// Must be called while handling a click: browsers only allow full screen then.
export function enterFullscreen() {
  if (!fullscreenAvailable() || fsRefused || document.fullscreenElement) return Promise.resolve(!!document.fullscreenElement);
  const request = document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(
    () => true,
    () => {
      fsRefused = true;
      return false;
    });
  fsRequest = request;
  request.then(() => {
    if (fsRequest === request) fsRequest = null;
  });
  return request;
}

function leaveFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---------- starting and resuming ----------

// SPEC 4.3: filters, then order (questions in a case study stay together and
// in order; whole blocks move), then the number of questions.
export function chooseQuestions(set, s, random = Math.random) {
  const keep = q => (!s.only || s.only.includes(q.id))
    && (!s.topics || s.topics.includes(q.topic))
    && (!s.types || s.types.includes(q.type));
  const blocks = [];
  const caseBlocks = new Map();
  for (const q of set.questions.filter(keep)) {
    if (!q.case) blocks.push([q]);
    else if (caseBlocks.has(q.case)) caseBlocks.get(q.case).push(q);
    else {
      caseBlocks.set(q.case, [q]);
      blocks.push(caseBlocks.get(q.case));
    }
  }
  const ordered = s.shuffleQuestions ? shuffle(blocks, random) : blocks;
  const limit = s.count ?? Infinity;
  const picked = [];
  for (const block of ordered) {
    if (picked.length >= limit) break;
    picked.push(...block.slice(0, limit - picked.length));
  }
  return picked;
}

// Standard time is the set's timeMinutes scaled to the number of questions,
// or 1.5 minutes per question when the set has no timeMinutes.
export function timeLimitMs(set, count, s) {
  if (s.timer === 'off') return 0;
  const minutes = s.timer === 'custom'
    ? s.minutes
    : set.timeMinutes ? (set.timeMinutes * count) / set.questions.length : 1.5 * count;
  return Math.round(minutes * 60) * 1000;
}

// Returns false when no questions match the settings.
export function startExam(set, settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const questions = chooseQuestions(set, s);
  if (!questions.length) return false;
  if (s.fullscreen) enterFullscreen();
  const limitMs = timeLimitMs(set, questions.length, s);
  const now = Date.now();
  store.set(ACTIVE, {
    v: 2,
    setId: set.id,
    title: set.title,
    settings: s,
    scope: s.only ? 'missed' : questions.length < set.questions.length ? 'part' : 'full',
    cases: set.cases ?? {},
    questions, // a copy, so later edits to the set file can't break this attempt
    layout: Object.fromEntries(questions.map(q => [q.id, prepareItem(q, { shuffle: s.shuffleChoices })])),
    index: 0,
    responses: {},
    caseTabs: {}, // the exhibit tab last shown for each case study
    revealed: {}, // practice mode: questions whose answer has been shown
    flags: {},
    onGrid: false, // on the review grid before submitting
    startedAt: now,
    limitMs,
    deadline: limitMs ? now + limitMs : null,
    pauseLeftMs: limitMs ? PAUSE_MS : 0,
    pausedAt: null,
    pausedMs: 0,
    fullscreenDeclined: false,
  });
  location.hash = '#/exam';
  return true;
}

export function resumeExam() {
  const st = activeExam();
  if (st?.settings.fullscreen && !st.fullscreenDeclined) enterFullscreen();
  location.hash = '#/exam';
}

function grade(st, reason) {
  const items = st.questions.map(q => ({ id: q.id, type: q.type, topic: q.topic, ...scoreItem(q, st.responses[q.id]) }));
  const earned = items.reduce((sum, i) => sum + i.earned, 0);
  const possible = items.reduce((sum, i) => sum + i.max, 0);
  const finishedAt = Date.now();
  const pausedMs = st.pausedMs + (st.pausedAt ? Math.min(finishedAt - st.pausedAt, st.pauseLeftMs) : 0);
  const usedMs = finishedAt - st.startedAt - pausedMs;
  return {
    setId: st.setId,
    title: st.title,
    reason,
    scope: st.scope ?? 'full',
    startedAt: st.startedAt,
    finishedAt,
    timeUsedMs: st.limitMs ? Math.min(usedMs, st.limitMs) : usedMs,
    earned,
    possible,
    percent: possible ? Math.round((earned / possible) * 1000) / 10 : 0,
    items,
    missed: items.filter(i => i.earned < i.max).map(i => i.id), // "missed" = less than full points (SPEC 5.4)
    settings: st.settings,
    questions: st.questions,
    layout: st.layout,
    responses: st.responses,
    cases: st.cases,
  };
}

// The finished attempt goes to the results page, and a summary to the history.
function saveResult(result) {
  store.set(LAST, result);
  const all = store.get(HISTORY, {});
  const list = all[result.setId] ?? [];
  list.push({
    at: result.finishedAt,
    percent: result.percent,
    earned: result.earned,
    possible: result.possible,
    count: result.items.length,
    scope: result.scope,
    timeUsedMs: result.timeUsedMs,
    missed: result.missed,
    settings: result.settings,
  });
  all[result.setId] = list.slice(-HISTORY_LIMIT);
  store.set(HISTORY, all);
}

// ---------- pieces shared by the exam and review screens ----------

// Stem, instruction, help line, dotted divider, and the answer controls.
// ctx.idPrefix keeps ids unique when several questions share a page.
export function questionParts(q, ctx) {
  const p = ctx.idPrefix ?? '';
  const instruction = instructionFor(q);
  const help = helpFor(q);
  return [
    h('div.stem', { id: `${p}q-stem`, html: q.stem }),
    instruction ? h('p.instruction', { id: `${p}q-instr` }, instruction) : null,
    help && !ctx.review && !ctx.locked ? h('p.help', help) : null,
    h('div.dots', { 'aria-hidden': 'true' }),
    renderItem(q, { ...ctx, labelledBy: instruction ? `${p}q-stem ${p}q-instr` : `${p}q-stem` }),
  ];
}

// Result and rationale under a question (practice mode, review mode, and
// group study). Group study passes answered: false when no answer was locked in.
export function feedbackPanel(q, response, { answered = true } = {}) {
  const { earned, max } = scoreItem(q, response);
  const result = !answered ? 'wrong' : earned === max ? 'correct' : earned > 0 ? 'partial' : 'wrong';
  return h(`section.feedback.is-${result}`, { tabindex: '-1', 'aria-label': 'Answer and rationale' },
    h('p.feedback-result', answered
      ? [h('b', { correct: '✓ Correct', partial: 'Partially correct', wrong: '✗ Incorrect' }[result]),
          ` · ${earned} of ${max} point${max === 1 ? '' : 's'}`]
      : [h('b', 'No answer locked in'), ` · 0 of ${max} point${max === 1 ? '' : 's'}`]),
    h('h2.feedback-title', 'Rationale'),
    h('div.rationale', { html: q.rationale }));
}

// The question part of the screen. Case questions get the two-column layout
// (SPEC 3.3); the case column stays in place while moving through one case,
// so its tab and scroll position don't jump.
export function questionArea(container, cases, tabs) {
  let shown = null; // { key, right }
  return {
    show(q, parts) {
      if (q.case && cases[q.case]) {
        if (shown?.key !== q.case) {
          shown = { key: q.case, right: h('div.case-question') };
          fill(container, h('div.case-layout', casePanel(cases[q.case], tabs.get(q.case), i => tabs.set(q.case, i)), shown.right));
        }
        fill(shown.right, parts);
      } else {
        shown = null;
        fill(container, parts);
      }
    },
    clear(...nodes) {
      shown = null;
      fill(container, nodes);
    },
  };
}

// Intro sentence, exhibit tabs, and the selected exhibit, which scrolls on its own.
function casePanel({ intro, tabs = [] }, start, onSelect) {
  let current = Math.min(start, Math.max(tabs.length - 1, 0));
  const panel = h('div.tabpanel', { role: 'tabpanel', tabindex: '0' });
  const buttons = tabs.map((tab, i) =>
    h('button.tab', { type: 'button', role: 'tab', id: `case-tab-${i}`, onclick: () => select(i) }, tab.title || `Exhibit ${i + 1}`));
  const tablist = h('div.tabs', { role: 'tablist', 'aria-label': 'Exhibits' }, buttons);
  tablist.addEventListener('keydown', e => {
    const last = tabs.length - 1;
    const next = { ArrowRight: current === last ? 0 : current + 1, ArrowLeft: current === 0 ? last : current - 1, Home: 0, End: last }[e.key];
    if (next == null) return;
    e.preventDefault();
    select(next);
    buttons[next].focus();
  });

  function show(i) {
    current = i;
    buttons.forEach((b, j) => {
      b.setAttribute('aria-selected', String(j === i));
      b.tabIndex = j === i ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `case-tab-${i}`);
    panel.innerHTML = tabs[i]?.html ?? '';
    // Wide tables scroll inside their own box on small screens.
    for (const table of panel.querySelectorAll('table')) {
      const wrap = h('div.table-wrap');
      table.replaceWith(wrap);
      wrap.append(table);
    }
    panel.scrollTop = 0;
  }

  // Tab memory: the chosen tab stays chosen for the rest of this case.
  function select(i) {
    show(i);
    onSelect(i);
  }

  show(current);
  return h('aside.case-panel', { 'aria-label': 'Case study' },
    intro ? h('p.case-intro', { html: intro }) : null,
    tabs.length ? tablist : null,
    panel);
}

// ---------- the exam screen ----------

export function examView(root) {
  const st = activeExam();
  if (!st) {
    location.replace('#/');
    return;
  }
  const s = st.settings;
  st.caseTabs ??= {};
  st.revealed ??= {};
  st.flags ??= {};
  const timed = !!st.deadline;
  const canGoBack = s.navigation === 'back';
  const showsAnswers = s.reveal === 'each';
  let finished = false;
  let leaving = false;
  let ticker = 0;
  let pauseBox = null;
  let fsBox = null;
  let lowMark = 0;

  const save = () => {
    if (!finished) store.set(ACTIVE, st);
  };

  // --- build the page ---
  const counter = h('h1.q-counter', { tabindex: '-1' });
  const timeVal = h('span.val');
  const pauseVal = h('span.val');
  const timer = h('div.timer',
    h('div', h('b', 'Time Remaining:'), ' ', timeVal),
    h('div', h('b', 'Pause Remaining:'), ' ', pauseVal));
  const pauseBtn = h('button.btn.btn-pause', { type: 'button', onclick: () => pause() }, 'Pause');
  const calcBtn = h('button.calc-toggle', { type: 'button', 'aria-label': 'Calculator', 'aria-pressed': 'false', title: 'Calculator' }, icon('calc'));
  const question = h('section.question');
  // Previous and Flag only appear when going back is allowed (SPEC 4.3).
  const prevBtn = h('button.btn.btn-nav', { type: 'button', onclick: () => goTo(st.index - 1) }, 'Previous');
  const flagLabel = h('span', 'Flag');
  const flagBtn = h('button.btn.btn-flag', { type: 'button', 'aria-pressed': 'false', onclick: () => toggleFlag() }, icon('flag'), flagLabel);
  const actions = h('div.exam-actions',
    canGoBack ? h('div.nav-left', prevBtn, flagBtn) : null,
    h('button.btn-continue', { type: 'button', onclick: () => onContinue() }, 'Continue'));
  const footer = siteFooter();
  const fsNotice = footer.querySelector('.fs-notice');
  const announcer = h('div.sr-only', { 'aria-live': 'polite' });

  const page = h('div.page.exam', { 'data-text-size': s.textSize ?? 'standard' },
    siteHeader({ title: st.title, onClose: () => confirmLeave(), link: false }),
    h('main.wrap',
      h('div.info-row',
        h('div.counter-wrap', counter, s.preset === 'practice' ? h('span.mode-tag', 'Practice mode') : null),
        h('div.info-tools', timed ? [timer, pauseBtn] : null, s.calculator ? calcBtn : null)),
      question),
    footer,
    announcer);
  root.replaceChildren(page);

  const calc = s.calculator
    ? createCalculator({
        onClose: () => {
          calcBtn.setAttribute('aria-pressed', 'false');
          calcBtn.focus({ preventScroll: true });
        },
      })
    : null;
  if (calc) {
    page.append(calc.el);
    calcBtn.addEventListener('click', () => calcBtn.setAttribute('aria-pressed', String(calc.toggle(calcBtn))));
  }

  const area = questionArea(question, st.cases, {
    get: key => st.caseTabs[key] ?? 0,
    set: (key, i) => {
      st.caseTabs = { ...st.caseTabs, [key]: i };
      save();
    },
  });

  // --- questions ---
  function showQuestion(moveFocus) {
    st.onGrid = false;
    const q = st.questions[st.index];
    const revealed = showsAnswers && !!st.revealed[q.id];
    counter.textContent = `Question: ${st.index + 1} of ${st.questions.length}`;
    document.title = `${st.title} · Question ${st.index + 1}`;
    prevBtn.hidden = st.index === 0;
    paintFlag();
    area.show(q, [
      ...questionParts(q, {
        response: st.responses[q.id],
        layout: st.layout[q.id],
        review: revealed,
        onChange: r => {
          st.responses[q.id] = r;
          save();
        },
      }),
      revealed ? feedbackPanel(q, st.responses[q.id]) : null,
      actions,
    ]);
    if (moveFocus) {
      window.scrollTo(0, 0);
      counter.focus({ preventScroll: true });
    }
  }

  function goTo(i) {
    st.index = i;
    save();
    showQuestion(true);
  }

  function onContinue() {
    const q = st.questions[st.index];
    if (!isAnswered(q, st.responses[q.id])) {
      modal({ title: 'Question Unanswered', message: unansweredMessage(q) });
      return;
    }
    if (showsAnswers && !st.revealed[q.id]) {
      // Practice mode: show the answer and rationale before moving on.
      st.revealed[q.id] = true;
      save();
      showQuestion(false);
      const feedback = question.querySelector('.feedback');
      feedback?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      feedback?.focus({ preventScroll: true });
      return;
    }
    if (st.index < st.questions.length - 1) goTo(st.index + 1);
    else if (canGoBack) showGrid(true);
    else confirmSubmit();
  }

  function paintFlag() {
    const flagged = !!st.flags[st.questions[st.index].id];
    flagBtn.setAttribute('aria-pressed', String(flagged));
    flagLabel.textContent = flagged ? 'Flagged' : 'Flag';
  }

  function toggleFlag() {
    const id = st.questions[st.index].id;
    if (st.flags[id]) delete st.flags[id];
    else st.flags[id] = true;
    save();
    paintFlag();
  }

  // With going back allowed, a grid of every question comes before submitting.
  function showGrid(moveFocus) {
    st.onGrid = true;
    save();
    counter.textContent = 'Review Your Answers';
    document.title = `${st.title} · Review your answers`;
    const done = q => isAnswered(q, st.responses[q.id]);
    const answeredCount = st.questions.filter(done).length;
    const flaggedCount = st.questions.filter(q => st.flags[q.id]).length;
    area.clear(
      h('p.grid-intro',
        `You answered ${answeredCount} of ${st.questions.length} questions${flaggedCount ? ` and flagged ${flaggedCount}` : ''}. `,
        'Select a question to go back to it, or submit your exam.'),
      h('ol.qgrid', st.questions.map((q, i) => {
        const answered = done(q), flagged = !!st.flags[q.id];
        return h('li', h('button.qtile', {
          type: 'button',
          class: `${answered ? 'answered' : 'unanswered'}${flagged ? ' flagged' : ''}`,
          'aria-label': `Question ${i + 1}: ${answered ? 'answered' : 'not answered'}${flagged ? ', flagged' : ''}`,
          onclick: () => goTo(i),
        }, String(i + 1), flagged ? icon('flag') : null));
      })),
      h('p.grid-legend',
        h('span.qtile.answered.sample', { 'aria-hidden': 'true' }), ' Answered ',
        h('span.qtile.unanswered.sample', { 'aria-hidden': 'true' }), ' Not answered ',
        icon('flag'), ' Flagged'),
      h('div.exam-actions',
        h('button.btn', { type: 'button', onclick: () => goTo(st.questions.length - 1) }, 'Back to questions'),
        h('button.btn.btn-accent', { type: 'button', onclick: () => confirmSubmit() }, 'Submit exam')));
    if (moveFocus) {
      window.scrollTo(0, 0);
      counter.focus({ preventScroll: true });
    }
  }

  async function confirmSubmit() {
    const left = st.questions.filter(q => !isAnswered(q, st.responses[q.id])).length;
    const choice = await modal({
      title: 'Submit Exam',
      message: canGoBack
        ? `After you submit, you can't change your answers.${left ? ` ${left} question${left > 1 ? 's are' : ' is'} not answered.` : ''}`
        : 'That was the last question. Submit your exam to see your score.',
      buttons: [{ label: 'Submit exam', value: 'submit', accent: true }, { label: 'Not yet', value: 'stay' }],
    });
    if (choice === 'submit') finish('submitted');
  }

  async function confirmLeave() {
    const choice = await modal({
      title: 'Leave this exam?',
      message: `Your progress is saved and you can resume from the homepage.${timed ? ' The timer keeps running while you are away.' : ''}`,
      buttons: [{ label: 'Stay', value: 'stay', accent: true }, { label: 'Leave exam', value: 'leave' }],
    });
    if (choice !== 'leave' || finished) return;
    leaving = true;
    leaveFullscreen();
    location.hash = '#/';
  }

  function finish(reason) {
    if (finished) return;
    saveResult(grade(st, reason));
    store.del(ACTIVE);
    finished = true;
    clearInterval(ticker);
    removeEventListener('beforeunload', onBeforeUnload);
    leaveFullscreen();
    if (reason !== 'time') location.hash = '#/results';
  }

  // --- timer and pause (SPEC 3.5) ---
  function pause() {
    if (!timed || st.pausedAt || st.pauseLeftMs <= 0 || finished) return;
    st.pausedAt = Date.now();
    save();
    showPaused();
  }

  function showPaused() {
    page.classList.add('is-paused');
    const left = h('span.val');
    pauseBox = modal({
      title: 'Exam Paused',
      message: h('div',
        h('p', 'The question is hidden and the exam timer is stopped.'),
        h('p', h('b', 'Pause Remaining: '), left)),
      buttons: [{ label: 'Resume', value: 'resume', accent: true }],
      closable: false,
    });
    pauseBox.left = left;
    pauseBox.then(choice => {
      if (choice === 'resume') resume(false);
    });
    paint();
  }

  function resume(auto) {
    if (!st.pausedAt) return;
    const used = Math.min(Date.now() - st.pausedAt, st.pauseLeftMs);
    st.pauseLeftMs -= used;
    st.deadline += used;
    st.pausedMs += used;
    st.pausedAt = null;
    save();
    page.classList.remove('is-paused');
    pauseBox?.close('auto');
    pauseBox = null;
    pauseBtn.disabled = st.pauseLeftMs <= 0;
    if (auto) toast('Your pause time is used up, so the exam has resumed.');
    paint();
  }

  function timeUp() {
    paint(); // show 00:00:00 behind the alert
    closeModals();
    finish('time');
    modal({
      title: 'Time Is Up',
      message: 'Your time has run out, so your exam was submitted.',
      buttons: [{ label: 'See my score', value: 'ok', accent: true }],
    }).then(() => {
      location.hash = '#/results';
    });
  }

  function tick() {
    if (finished) return;
    const now = Date.now();
    if (st.pausedAt) {
      if (now - st.pausedAt >= st.pauseLeftMs) return resume(true);
    } else if (timed && now >= st.deadline) {
      return timeUp();
    }
    paint(now);
  }

  function paint(now = Date.now()) {
    if (!timed) return;
    const remaining = st.deadline - (st.pausedAt ?? now);
    const pauseLeft = st.pauseLeftMs - (st.pausedAt ? now - st.pausedAt : 0);
    const setText = (el, text) => {
      if (el && el.textContent !== text) el.textContent = text;
    };
    setText(timeVal, fmtClock(remaining));
    setText(pauseVal, fmtClock(pauseLeft));
    setText(pauseBox?.left, fmtClock(pauseLeft));
    timeVal.classList.toggle('low', remaining <= LOW_TIME_MS);
    pauseVal.classList.toggle('low', !!st.pausedAt);
    // Tell screen reader users once at 5 minutes and once at 1 minute left.
    const mark = remaining <= 60000 ? 1 : remaining <= LOW_TIME_MS ? 5 : 0;
    if (mark && mark !== lowMark) announcer.textContent = `Less than ${mark} minute${mark > 1 ? 's' : ''} remaining.`;
    lowMark = mark;
  }

  // --- full screen (SPEC 4.4) ---
  const wantsFullscreen = () =>
    fullscreenAvailable() && !fsRefused && s.fullscreen && !st.fullscreenDeclined && !finished && !leaving;

  async function askFullscreen(title) {
    if (fsBox) return;
    fsBox = modal({
      title,
      message: 'This practice exam runs in full screen, like test day. You can go back to full screen or keep going without it.',
      buttons: [
        { label: 'Return to full screen', value: 'return', accent: true },
        { label: 'Continue without full screen', value: 'continue' },
      ],
      closable: false,
    });
    const choice = await fsBox;
    fsBox = null;
    if (choice === 'return') {
      if (!(await enterFullscreen())) toast("Full screen isn't available in this browser window.");
    } else if (choice === 'continue') {
      st.fullscreenDeclined = true;
      save();
    }
  }

  function onFullscreenChange() {
    fsNotice.hidden = !document.fullscreenElement;
    if (document.fullscreenElement) fsBox?.close(undefined);
    else if (wantsFullscreen()) askFullscreen('Full Screen Mode Ended');
  }

  // Clicking or tapping anywhere outside the answer just picked removes its
  // outline box; the choice stays selected. Phones can keep focus after a
  // tap on empty space, so let go of it here.
  const onPointerDown = e => {
    const active = document.activeElement;
    if (active?.matches('.opt input') && !active.closest('.opt').contains(e.target)) active.blur();
  };

  // Every change is already saved; this only asks "Leave site?" first.
  const onBeforeUnload = e => {
    if (finished) return;
    e.preventDefault();
    e.returnValue = '';
  };

  // --- start up ---
  if (st.onGrid && canGoBack) showGrid(false);
  else showQuestion(false);
  pauseBtn.disabled = st.pauseLeftMs <= 0;
  fsNotice.hidden = !document.fullscreenElement;
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', tick);
  document.addEventListener('pointerdown', onPointerDown);
  addEventListener('beforeunload', onBeforeUnload);

  // Catch up on time that passed while the student was away.
  if (timed) {
    const away = st.deadline - (st.pausedAt ?? Date.now());
    lowMark = away <= 60000 ? 1 : away <= LOW_TIME_MS ? 5 : 0;
  }
  if (st.pausedAt && Date.now() - st.pausedAt >= st.pauseLeftMs) resume(true);
  else if (st.pausedAt) showPaused();
  tick();
  if (!finished) ticker = setInterval(tick, 250);

  // A reload drops full screen, and browsers only allow it after a click,
  // so offer a button to turn it back on.
  Promise.resolve(fsRequest).then(() => {
    if (!document.fullscreenElement && wantsFullscreen()) askFullscreen('Full Screen Mode Is Off');
  });

  // Runs when the student goes to another page.
  return () => {
    clearInterval(ticker);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', tick);
    document.removeEventListener('pointerdown', onPointerDown);
    removeEventListener('beforeunload', onBeforeUnload);
    leaving = true;
    closeModals();
    calc?.destroy();
    leaveFullscreen();
  };
}

// ---------- review mode (SPEC 4.5) ----------

// The exam screen with answers locked, ✓ and ✗ marks, and the rationale,
// with free Previous and Next. #/review shows every question;
// #/review/incorrect shows only the ones without full points.
export function reviewView(root, { args = [] } = {}) {
  const r = lastAttempt();
  if (!r) {
    location.replace('#/results');
    return;
  }
  const onlyMissed = args[0] === 'incorrect';
  const missed = new Set(r.missed);
  const list = r.questions.filter(q => !onlyMissed || missed.has(q.id));
  let index = 0;
  const tabs = new Map();

  const counter = h('h1.q-counter', { tabindex: '-1' });
  const tag = h('span.mode-tag');
  const question = h('section.question');
  const prevBtn = h('button.btn.btn-nav', { type: 'button', onclick: () => go(index - 1) }, 'Previous');
  const nextBtn = h('button.btn-continue', {
    type: 'button',
    onclick: () => {
      if (index < list.length - 1) go(index + 1);
      else location.hash = '#/results';
    },
  }, 'Next');
  const actions = h('div.exam-actions', h('div.nav-left', prevBtn), nextBtn);
  const area = questionArea(question, r.cases ?? {}, { get: key => tabs.get(key) ?? 0, set: (key, i) => tabs.set(key, i) });

  root.replaceChildren(h('div.page.exam.review', { 'data-text-size': r.settings?.textSize ?? 'standard' },
    siteHeader({ title: r.title, onClose: () => (location.hash = '#/results'), link: false }),
    h('main.wrap',
      h('div.info-row',
        h('div.counter-wrap', counter, tag),
        h('div.info-tools', h('a.btn', { href: '#/results' }, 'Back to results'))),
      question),
    siteFooter()));

  if (!list.length) {
    counter.textContent = 'Nothing to review';
    tag.textContent = 'Review';
    area.clear(h('p', 'Every question earned full points, so there are no incorrect answers to review.'),
      h('p', h('a.btn', { href: '#/results' }, 'Back to results')));
    return;
  }

  function go(i) {
    index = i;
    show(true);
  }

  function show(moveFocus) {
    const q = list[index];
    counter.textContent = `Question: ${r.questions.indexOf(q) + 1} of ${r.questions.length}`;
    tag.textContent = onlyMissed ? `Incorrect answers · ${index + 1} of ${list.length}` : 'Review';
    document.title = `Review · ${r.title}`;
    prevBtn.hidden = index === 0;
    nextBtn.textContent = index === list.length - 1 ? 'Finish' : 'Next';
    area.show(q, [
      ...questionParts(q, { response: r.responses[q.id], layout: r.layout?.[q.id], review: true }),
      feedbackPanel(q, r.responses[q.id]),
      actions,
    ]);
    if (moveFocus) {
      window.scrollTo(0, 0);
      counter.focus({ preventScroll: true });
    }
  }

  show(false);
}
