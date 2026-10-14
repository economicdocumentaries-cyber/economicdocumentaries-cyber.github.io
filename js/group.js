// Group study (SPEC 6): the "Group study is live" banner on the homepage, the
// student view (#/group), and the host console (#/host). Firebase holds the
// session (SPEC 6.2); every browser draws the questions from its own copy of
// the set file.
//
// Sessions are usually remote: everyone is on a video call from home, often
// with the call and this site on the same phone. So group pages never use
// full screen, show "Reconnecting…" when the internet drops, and the host can
// add a countdown that everyone sees.
import { SITE_NAME, HOST_UID } from './config.js';
import { h, fill, store, modal, toast, siteHeader, siteFooter, seededRandom, icon, fmtDate, fmtClock } from './util.js';
import { prepareItem, isAnswered, scoreItem, keyResponse, unansweredMessage } from './items.js';
import { questionParts, questionArea, feedbackPanel, chooseQuestions } from './exam.js';
import { createCalculator } from './calc.js';
import { loadSets } from './sets.js';
import { groupStudyOn, connectStudent, hostAccount, problemText, HOST_HINT } from './firebase.js';
import { guidesConsole } from './study-guides.js';
import { withChanges, currentChanges } from './set-changes.js';
import { setsConsole, questionsPage } from './set-editor.js';

const NAME = 'pe.groupName'; // the display name, entered once (SPEC 6.4 item 1)
const DRAFT = 'pe.groupDraft'; // { sid, index, r }: an answer not locked in yet, kept through a reload
const CHOICE_TYPES = new Set(['mc', 'sata', 'emr']);
const SEEDED_TYPES = new Set(['order', 'dragdrop', 'bowtie']);
const COUNTDOWNS = [[0, 'Off'], [30, '30 seconds'], [60, '60 seconds'], [90, '90 seconds'], [120, '2 minutes']];

// ---------- shared ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const percentOf = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// Group study never uses full screen, so the video call stays in view.
function leaveFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Firebase's estimate of the server's clock, so a countdown ends at the same
// moment on every device even when their clocks differ.
function serverClock(db) {
  let offset = 0;
  const stop = db.watch('.info/serverTimeOffset', value => (offset = Number(value) || 0));
  return { now: () => Date.now() + offset, stop };
}

// Milliseconds left on the current question's countdown (0 once time is up),
// or null when there is no countdown. live.timer = { startedAt, seconds }.
function timeLeftMs(live, now) {
  const t = live?.timer;
  if (live?.phase !== 'answering' || !t || !Number.isFinite(t.startedAt) || !(t.seconds > 0)) return null;
  return Math.max(0, t.startedAt + t.seconds * 1000 - now);
}

// "Time Remaining: 00:00:42" in the same spot as the exam timer; hidden without a countdown.
function countdownDisplay() {
  const val = h('span.val');
  const el = h('div.timer.countdown', { hidden: true }, h('b', 'Time Remaining:'), ' ', val);
  return {
    el,
    paint(ms) {
      el.hidden = ms == null;
      if (ms == null) return;
      const text = fmtClock(ms);
      if (val.textContent !== text) val.textContent = text;
      val.classList.toggle('low', ms <= 10000);
    },
  };
}

// A small "Reconnecting…" notice while the internet is down. Firebase
// reconnects by itself and the page then catches up with the host. After a
// while, a Reload button helps if a phone kept a dead connection.
// Returns a function that removes it.
function connectionNotice(db) {
  const text = h('span', 'Reconnecting…');
  const reload = h('button.link-btn', { type: 'button', hidden: true, onclick: () => location.reload() }, 'Reload page');
  const el = h('div.reconnecting', { role: 'status', hidden: true },
    h('span.reconnecting-dot', { 'aria-hidden': 'true' }), text, reload);
  document.body.append(el);
  let wasOnline = false;
  let slow = 0;
  const stop = db.watch('.info/connected', value => {
    clearTimeout(slow);
    if (value === true) {
      if (!el.hidden) toast('Back online.', 2500);
      wasOnline = true;
      el.hidden = true;
      reload.hidden = true;
      text.textContent = 'Reconnecting…';
    } else if (wasOnline && el.hidden) {
      el.hidden = false;
      slow = setTimeout(() => {
        text.textContent = 'Still reconnecting…';
        reload.hidden = false;
      }, 15000);
    }
  });
  return () => {
    stop();
    clearTimeout(slow);
    el.remove();
  };
}

function plainPage(main, title = '') {
  return h('div.page', siteHeader(title ? { title } : {}), main, siteFooter());
}

function problemBox(title, err, ...extra) {
  return [
    h('h1.page-title', title),
    h('p.notice', problemText(err)),
    h('div.form-actions',
      h('button.btn', { type: 'button', onclick: () => location.reload() }, 'Reload'),
      h('a.btn', { href: '#/' }, 'Home')),
    extra,
  ];
}

// Everyone in a session sees the same layout (SPEC 6.4 item 7): choices in
// file order, and a shuffle seeded by the question id for ordered response,
// drag and drop, and bow tie.
const groupLayout = q => prepareItem(q, { shuffle: SEEDED_TYPES.has(q.type), random: seededRandom(q.id) });

// The session's questions from this browser's copy of the set, or null when
// the set or one of its questions is missing (a file changed after the host
// started, or this page was opened before the file was added).
function sessionQuestions(sets, live) {
  const set = sets.find(s => s.id === live.setId);
  if (!set || !Array.isArray(live.order) || !live.order.length) return null;
  const byId = new Map(set.questions.map(q => [q.id, q]));
  const questions = live.order.map(id => byId.get(id));
  if (!questions.every(Boolean)) return null;
  return { set, questions, layouts: questions.map(groupLayout) };
}

// One question's answers from Firebase as [{ uid, r }], skipping any that can't be read.
function readAnswers(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).flatMap(([uid, a]) => {
    try {
      return [{ uid, r: JSON.parse(a.r) }];
    } catch {
      return [];
    }
  });
}

// Scores an answer from another browser without trusting it to be well formed.
function safeScore(q, r) {
  const { max } = scoreItem(q, null);
  try {
    const s = scoreItem(q, r);
    return { earned: Number.isFinite(s.earned) ? Math.min(Math.max(s.earned, 0), max) : 0, max };
  } catch {
    return { earned: 0, max };
  }
}

const isFull = (q, r) => {
  const s = safeScore(q, r);
  return s.earned >= s.max;
};

// The stem as plain text, shortened, for the host's summary table.
function stemText(q, length = 90) {
  const t = document.createElement('template');
  t.innerHTML = q.stem;
  const text = t.content.textContent.replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd().replace(/[.,;:]+$/, '')}…` : text;
}

// Everyone's points in a finished session (SPEC 6.4 item 8 and 6.5 item 3).
function sessionStats(questions, allAnswers, roster) {
  const possible = questions.reduce((sum, q) => sum + scoreItem(q, null).max, 0);
  const people = new Map(Object.entries(roster ?? {}).map(([uid, p]) => [uid, { name: String(p?.name ?? ''), earned: 0, answered: 0 }]));
  const perQuestion = questions.map((q, index) => {
    const responses = new Map();
    let full = 0;
    for (const { uid, r } of readAnswers(allAnswers?.[`q${index}`])) {
      const s = safeScore(q, r);
      if (s.earned >= s.max) full++;
      if (!people.has(uid)) people.set(uid, { name: '', earned: 0, answered: 0 });
      const person = people.get(uid);
      person.earned += s.earned;
      person.answered++;
      responses.set(uid, r);
    }
    return { q, index, answered: responses.size, full, responses };
  });
  const scored = [...people.values()].filter(p => p.answered);
  const average = scored.length && possible
    ? Math.round((scored.reduce((sum, p) => sum + p.earned / possible, 0) / scored.length) * 1000) / 10
    : null;
  return { possible, people, scored: scored.length, perQuestion, average };
}

// "How the group answered" (SPEC 6.4 item 4): the percent who chose each
// choice for mc, sata, and emr; fully correct, partially correct, and
// incorrect counts for the other types.
function groupResults(q, layout, answers, { showKey = true } = {}) {
  const n = answers.length;
  const rows = [];
  if (CHOICE_TYPES.has(q.type)) {
    const key = new Set([].concat(q.answer));
    const counts = new Map();
    for (const { r } of answers) {
      for (const i of new Set([].concat(r))) {
        if (Number.isInteger(i)) counts.set(i, (counts.get(i) ?? 0) + 1);
      }
    }
    for (const i of layout?.options ?? q.options.map((_, i) => i)) {
      rows.push(resultRow(h('span.dist-text', { html: q.options[i] }), counts.get(i) ?? 0, n, showKey && key.has(i) ? 'key' : null));
    }
  } else {
    let full = 0, part = 0, none = 0;
    for (const { r } of answers) {
      const s = safeScore(q, r);
      if (s.earned >= s.max) full++;
      else if (s.earned > 0) part++;
      else none++;
    }
    rows.push(resultRow('Fully correct', full, n, 'full'));
    if (scoreItem(q, null).max > 1) rows.push(resultRow('Partially correct', part, n, 'part'));
    rows.push(resultRow('Incorrect', none, n, 'none'));
  }
  return h('section.dist', { 'aria-label': 'How the group answered' },
    h('h2.dist-title', 'How the group answered'),
    h('p.dist-count', n ? plural(n, 'answer') : 'No answers yet.'),
    n ? h('ul.dist-rows', rows) : null);
}

function resultRow(label, count, total, kind) {
  const p = percentOf(count, total);
  return h('li.dist-row', { class: kind ? `kind-${kind}` : null },
    h('span.dist-label', label, kind === 'key' ? h('span.mark.ok', h('span', { 'aria-hidden': 'true' }, '✓'), ' Correct') : null),
    h('span.bar',
      h('span.bar-track', { 'aria-hidden': 'true' }, h('span.bar-fill', { style: `width: ${p}%` })),
      h('span.bar-pct', `${p}%`)),
    h('span.dist-n', { title: plural(count, 'answer') }, h('span.sr-only', 'Answers: '), String(count)));
}

// ---------- the homepage banner ----------

// Shows "Group study is live" while a session runs (SPEC 6.4 item 1).
// Returns { el, stop }. Firebase problems are ignored here: the homepage
// works the same without group study.
export function liveBanner() {
  const el = h('div.live-slot', { 'aria-live': 'polite' });
  let stop = () => {};
  let stopped = false;
  if (groupStudyOn()) {
    connectStudent().then(db => {
      if (stopped) return;
      stop = db.watch('live', live => {
        const on = live?.active && live.phase !== 'ended';
        fill(el, on ? h('section.banner.banner-live', { 'aria-label': 'Group study' },
          h('div',
            h('p.banner-title', h('span.live-dot', { 'aria-hidden': 'true' }), h('b', 'Group study is live: '), String(live.title ?? '')),
            h('p.banner-detail', 'Everyone answers the same question together, then sees the answer and how the group did.')),
          h('a.btn.btn-accent', { href: '#/group' }, 'Join session')) : null);
      }, () => fill(el));
    }, () => {});
  }
  return {
    el,
    stop: () => {
      stopped = true;
      stop();
    },
  };
}

// ---------- the student view (SPEC 6.4) ----------

export async function groupView(root, { isCurrent }) {
  document.title = `Group study · ${SITE_NAME}`;
  leaveFullscreen();
  const main = h('main.wrap.group-page', h('p.lead', 'Connecting to group study…'));
  root.replaceChildren(plainPage(main));
  if (!groupStudyOn()) {
    fill(main,
      h('h1.page-title', 'Group study is not set up'),
      h('p.lead', "This site isn't connected to Firebase, so group sessions aren't available. Solo practice works normally."),
      h('p', h('a.btn', { href: '#/' }, 'Home')));
    return;
  }
  let db, loaded, changes;
  try {
    // The sets with the host's latest changes (SPEC 11.3), so everyone has the same questions.
    [db, loaded, changes] = await Promise.all([connectStudent(), loadSets(), currentChanges()]);
  } catch (err) {
    if (isCurrent()) fill(main, problemBox('Group study could not connect', err));
    return;
  }
  if (!isCurrent()) return;
  return followSession(root, db, withChanges(loaded.sets, changes, loaded.courses));
}

// Follows /live: waits for a session, joins it, shows each question as the
// host moves on, and shows the results at the end.
function followSession(root, db, sets) {
  let live = null;
  let s = null; // the session followed: { sid, set, questions, layouts }, or { sid } when it can't be shown
  let people = null; // its participants; null until loaded
  let answers = { index: -1, data: null, stop: null }; // answers to the current question; data null until loaded
  let stops = [];
  let screen = null; // the question screen
  let view = null; // what a plain page is showing, so updates don't redraw it
  let plainMain = null;
  let joining = false;
  let joinProblem = false;
  let changingName = false;
  let results = null; // { sid, note } while a session's results are on screen
  let draft = store.get(DRAFT); // { sid, index, r }: the answer being worked on
  let heard = false; // /live has answered at least once

  const stopNotice = connectionNotice(db);
  const clock = serverClock(db);
  const stopLive = db.watch('live', value => {
    heard = true;
    live = value;
    onLive();
  }, err => showPlain('problem', problemBox('Group study could not read the session', err)));
  // No answer yet from Firebase: probably no internet. It keeps trying.
  const slowStart = setTimeout(() => {
    if (!heard) {
      showPlain('slow',
        h('h1.page-title', 'Group study'),
        h('p.lead', 'Still connecting… Check your internet connection. This page keeps trying by itself.'));
    }
  }, 8000);

  function showPlain(key, ...kids) {
    if (view === key) return plainMain;
    view = key;
    screen?.destroy();
    screen = null;
    plainMain = h('main.wrap.group-page', kids);
    root.replaceChildren(plainPage(plainMain));
    window.scrollTo(0, 0);
    return plainMain;
  }

  function onLive() {
    const active = !!live?.active;
    // Results stay on screen; a note says what changed.
    if (results) {
      if (!active) results.note('closed');
      else if (live.sessionId !== results.sid) results.note('new');
      return;
    }
    if (!active) {
      leave();
      showPlain('idle',
        h('h1.page-title', 'Group study'),
        h('p.lead', 'No group session is running right now. Keep this page open: it updates by itself when the host starts one.'),
        h('p', h('a.btn', { href: '#/' }, 'Home')));
      return;
    }
    if (live.sessionId !== s?.sid) enter();
    else sync();
  }

  function enter() {
    leave();
    const found = sessionQuestions(sets, live);
    s = { sid: live.sessionId, ...found };
    if (!found) {
      showPlain(`missing:${s.sid}`,
        h('h1.page-title', "This session can't be shown"),
        h('p.lead', `The host is using “${live.title}”, but this browser doesn't have the same version of that question set. Reload the page to get the newest version.`),
        h('div.form-actions', h('button.btn.btn-accent', { type: 'button', onclick: () => location.reload() }, 'Reload'), h('a.btn', { href: '#/' }, 'Home')));
      return;
    }
    stops.push(db.watch(`sessions/${s.sid}/participants`, value => {
      people = value ?? {};
      sync();
    }, err => showPlain('problem', problemBox('Group study could not read the session', err))));
    sync();
  }

  function leave() {
    stops.forEach(stop => stop());
    stops = [];
    answers.stop?.();
    answers = { index: -1, data: null, stop: null };
    s = null;
    people = null;
    joinProblem = false;
    changingName = false;
  }

  function watchAnswers(index) {
    if (answers.index === index) return;
    answers.stop?.();
    const box = { index, data: null, stop: null };
    answers = box;
    box.stop = db.watch(`sessions/${s.sid}/answers/q${index}`, value => {
      if (answers !== box) return;
      box.data = value ?? {};
      sync();
    }, err => showPlain('problem', problemBox('Group study could not read the answers', err)));
  }

  function sync() {
    if (!s?.questions || people == null) return;
    const me = people[db.uid];
    if (live.phase === 'ended') {
      if (me) showResults();
      else {
        showPlain(`ended:${s.sid}`,
          h('h1.page-title', 'This session has ended'),
          h('p.lead', 'Results are shown to the students who took part.'),
          h('p', h('a.btn', { href: '#/' }, 'Home')));
      }
      return;
    }
    if (joinProblem) return; // the problem stays on screen until "Try again"
    if (!me || changingName) {
      const name = store.get(NAME);
      if (name && !me && !changingName) join(name);
      else showNameForm();
      return;
    }
    watchAnswers(live.index);
    if (answers.data == null) return; // wait, so a locked answer shows right away after a reload
    screen ??= questionScreen();
    screen.update();
  }

  async function join(name) {
    if (joining) return;
    joining = true;
    const sid = s.sid;
    const path = `sessions/${sid}/participants/${db.uid}`;
    try {
      if (people[db.uid]) await db.update(path, { name });
      else await db.write(path, { name, joinedAt: db.serverTime() });
    } catch (err) {
      if (s?.sid !== sid) return;
      joinProblem = true;
      showPlain('join-problem',
        h('h1.page-title', 'Could not join the session'),
        h('p.notice', problemText(err)),
        h('div.form-actions',
          h('button.btn.btn-accent', {
            type: 'button',
            onclick: () => {
              joinProblem = false;
              view = null;
              sync();
            },
          }, 'Try again'),
          h('a.btn', { href: '#/' }, 'Home')));
    } finally {
      joining = false;
    }
  }

  function showNameForm() {
    const changing = changingName;
    const fresh = view !== `name:${s.sid}:${changing}`;
    const main = showPlain(`name:${s.sid}:${changing}`);
    if (!fresh) return;
    const input = h('input.text-input#group-name', {
      type: 'text', maxlength: '40', autocomplete: 'nickname', 'aria-describedby': 'group-name-help', value: store.get(NAME) ?? '',
    });
    const problem = h('p.form-problem', { role: 'alert' });
    const form = h('form.join-card', {
      onsubmit: e => {
        e.preventDefault();
        const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name) {
          problem.textContent = 'Enter your name to join.';
          input.focus();
          return;
        }
        store.set(NAME, name);
        changingName = false;
        if (!people[db.uid] || people[db.uid].name !== name) join(name);
        else sync();
      },
    },
      h('label.field-label', { for: 'group-name' }, 'Your name'),
      h('p.field-help#group-name-help', 'The host and the group see this name.'),
      input,
      problem,
      h('div.form-actions',
        h('button.btn.btn-accent.btn-big', { type: 'submit' }, changing ? 'Save name' : 'Join session'),
        changing
          ? h('button.btn', {
              type: 'button',
              onclick: () => {
                changingName = false;
                sync();
              },
            }, 'Cancel')
          : h('a.btn', { href: '#/' }, 'Back')));
    fill(main,
      h('h1.page-title', changing ? 'Change your name' : 'Join group study'),
      h('p.lead', h('b', String(live.title ?? '')), ' is live. Everyone answers the same question at the same time, then sees the answer and how the group did.'),
      form);
    input.focus();
  }

  // The answer being worked on, kept in memory and in the browser so a
  // reload or a name change doesn't lose it.
  function draftFor(index) {
    return draft && draft.sid === s?.sid && draft.index === index ? draft.r : undefined;
  }

  function saveDraft(sid, index, r) {
    draft = { sid, index, r };
    store.set(DRAFT, draft);
  }

  // The exam screen, driven by the host (SPEC 6.4 item 2): no pause and no
  // full screen. A countdown shows when the host turns one on.
  function questionScreen() {
    view = 'screen';
    const { sid, set, questions, layouts } = s;
    const caseTabs = {};
    let shown = null; // "index|phase|locked|timeUp" on screen; only a change redraws the question (SPEC 6.4 item 5)
    let shownIndex = -1; // the question on screen (live.index can change a moment before the screen does)
    let groupBox = null;
    let ticker = 0;
    let autoLocking = false;
    let warned = null; // the countdown that already announced "10 seconds left"

    const counter = h('h1.q-counter', { tabindex: '-1' });
    const countdown = countdownDisplay();
    const nameText = h('b');
    const nameBtn = h('button.link-btn', {
      type: 'button',
      onclick: () => {
        changingName = true;
        sync();
      },
    }, 'Change name');
    const calcBtn = h('button.calc-toggle', { type: 'button', 'aria-label': 'Calculator', 'aria-pressed': 'false', title: 'Calculator' }, icon('calc'));
    const question = h('section.question');
    const status = h('p.group-status', { role: 'status' });
    const timeNote = h('span.group-time', { 'aria-hidden': 'true' }); // the time left, near the button
    const announcer = h('div.sr-only', { 'aria-live': 'polite' });
    const lockBtn = h('button.btn-continue', { type: 'button', onclick: () => lockIn(false) }, 'Lock in answer');
    const actions = h('div.exam-actions.group-actions', status, timeNote, lockBtn);
    const page = h('div.page.exam.group',
      siteHeader({ title: set.title, onClose: () => confirmLeave(), link: false }),
      h('main.wrap',
        h('div.info-row',
          h('div.counter-wrap', counter, h('span.mode-tag', 'Group study')),
          h('div.info-tools', countdown.el, calcBtn)),
        h('p.group-who', 'You: ', nameText, ' · ', nameBtn),
        question),
      siteFooter(),
      announcer);
    root.replaceChildren(page);

    const calc = createCalculator({
      onClose: () => {
        calcBtn.setAttribute('aria-pressed', 'false');
        calcBtn.focus({ preventScroll: true });
      },
    });
    page.append(calc.el);
    calcBtn.addEventListener('click', () => calcBtn.setAttribute('aria-pressed', String(calc.toggle(calcBtn))));
    const area = questionArea(question, set.cases ?? {}, {
      get: key => caseTabs[key] ?? 0,
      set: (key, i) => (caseTabs[key] = i),
    });

    // My locked answer to the question on screen, or undefined.
    function myAnswer() {
      const a = answers.data?.[db.uid];
      if (!a) return undefined;
      try {
        return JSON.parse(a.r);
      } catch {
        return undefined;
      }
    }

    function update() {
      const { index, phase } = live;
      const mine = myAnswer();
      const locked = mine !== undefined;
      const left = timeLeftMs(live, clock.now());
      const timeUp = left === 0;
      nameText.textContent = people[db.uid]?.name ?? '';
      const key = `${index}|${phase}|${locked}|${timeUp}`;
      if (key !== shown) {
        const before = shown;
        shown = key;
        draw(index, phase, mine, locked, timeUp, before);
      }
      const count = Object.keys(answers.data ?? {}).length;
      const total = Math.max(Object.keys(people).length, count);
      const last = index === questions.length - 1;
      const waiting = `Waiting for the host… ${count} of ${total} answered`;
      const text = phase === 'revealed'
        ? `Answer shown. Waiting for the host to ${last ? 'finish the session' : 'go to the next question'}…`
        : locked ? `Answer locked in. ${waiting}`
        : timeUp ? `Time's up. ${waiting}`
        : '';
      if (status.textContent !== text) status.textContent = text;
      if (groupBox) fill(groupBox, groupResults(questions[index], layouts[index], readAnswers(answers.data)));
      paintTime(left);
      // Time's up: a complete answer that wasn't locked in yet is locked in now, like a timed exam.
      if (timeUp && !locked && !autoLocking && isAnswered(questions[index], draftFor(index))) lockIn(true);
      if (left > 0 && !ticker) ticker = setInterval(tick, 250);
      else if (!(left > 0) && ticker) {
        clearInterval(ticker);
        ticker = 0;
      }
    }

    function tick() {
      const left = timeLeftMs(live, clock.now());
      if (left > 0) paintTime(left);
      else update(); // time is up: lock the question
    }

    function paintTime(left) {
      countdown.paint(left);
      const text = left > 0 ? `${Math.floor(Math.ceil(left / 1000) / 60)}:${String(Math.ceil(left / 1000) % 60).padStart(2, '0')} left` : '';
      if (timeNote.textContent !== text) timeNote.textContent = text;
      const id = live.timer ? `${live.index}|${live.timer.startedAt}|${live.timer.seconds}` : null;
      if (left > 0 && left <= 10000 && warned !== id) {
        warned = id;
        announcer.textContent = '10 seconds left.';
      }
    }

    function draw(index, phase, mine, locked, timeUp, before) {
      const q = questions[index];
      const revealed = phase === 'revealed';
      const frozen = locked || revealed || timeUp; // nothing can change any more
      const sameQuestion = before?.split('|')[0] === String(index);
      const justRevealed = revealed && sameQuestion && before.split('|')[1] !== 'revealed';
      const y = window.scrollY;
      shownIndex = index;
      counter.textContent = `Question: ${index + 1} of ${questions.length}`;
      document.title = `Group study · Question ${index + 1}`;
      groupBox = revealed ? h('div.dist-slot') : null;
      area.show(q, [
        ...questionParts(q, {
          response: locked || revealed ? mine : draftFor(index),
          layout: layouts[index],
          locked: frozen,
          review: revealed,
          onChange: r => saveDraft(sid, index, r),
        }),
        revealed ? feedbackPanel(q, mine, { answered: locked }) : null,
        groupBox,
        actions,
      ]);
      lockBtn.hidden = frozen;
      question.classList.toggle('is-locked', frozen && !revealed);
      if (!sameQuestion) {
        window.scrollTo(0, 0);
        counter.focus({ preventScroll: true });
      } else {
        window.scrollTo(0, y);
        // The host revealed the answer. Focus stays where the student left it
        // (the status line announces it); scroll only if the rationale is out of sight.
        const feedback = justRevealed ? question.querySelector('.feedback') : null;
        if (feedback && feedback.getBoundingClientRect().top > window.innerHeight - 40) {
          feedback.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        }
      }
    }

    // auto: locked in by the countdown, so an unfinished answer is skipped quietly.
    async function lockIn(auto) {
      const index = shownIndex;
      const q = questions[index];
      const r = draftFor(index);
      if (!isAnswered(q, r)) {
        if (!auto) modal({ title: 'Question Unanswered', message: unansweredMessage(q) });
        return;
      }
      const { earned, max } = scoreItem(q, r);
      const path = `sessions/${sid}/answers/q${index}/${db.uid}`;
      autoLocking = auto;
      lockBtn.disabled = true;
      try {
        // Without internet, Firebase keeps the answer and sends it when the connection is back.
        await db.write(path, { r: JSON.stringify(r), earned, max, at: db.serverTime() });
        draft = null;
        store.del(DRAFT);
      } catch (err) {
        // It may be saved already (from another tab, or before a dropped connection).
        const saved = await db.read(path).catch(() => null);
        if (!saved) toast(`Your answer was not saved. ${problemText(err)}`, 9000);
      } finally {
        lockBtn.disabled = false;
        autoLocking = false;
      }
    }

    async function confirmLeave() {
      const choice = await modal({
        title: 'Leave Group Study?',
        message: 'You can rejoin from the homepage while the session is live. Answers you locked in are kept.',
        buttons: [{ label: 'Stay', value: 'stay', accent: true }, { label: 'Leave', value: 'leave' }],
      });
      if (choice === 'leave') location.hash = '#/';
    }

    return {
      update,
      destroy() {
        clearInterval(ticker);
        calc.destroy();
      },
    };
  }

  // The end of the session (SPEC 6.4 item 8): score, group average, and a
  // review of every question with the group's percent fully correct.
  async function showResults() {
    if (results?.sid === s.sid) return;
    const { sid, set, questions, layouts } = s;
    const shownCount = Math.min((Number(live.index) || 0) + 1, questions.length);
    const noteSlot = h('div.results-note', { 'aria-live': 'polite' });
    let pending = null;
    results = { sid, note: kind => (pending = kind) };
    const main = showPlain(`results:${sid}`, noteSlot, h('p.lead', 'Loading your results…'));
    leave(); // the results are read once; nothing else needs watching
    let all, roster;
    try {
      [all, roster] = await Promise.all([db.read(`sessions/${sid}/answers`), db.read(`sessions/${sid}/participants`)]);
    } catch (err) {
      if (results?.sid === sid) fill(main, problemBox('Your results could not be loaded', err));
      return;
    }
    if (results?.sid !== sid) return;
    const myUid = db.uid;
    const stats = sessionStats(questions.slice(0, shownCount), all, roster);
    const me = stats.people.get(myUid) ?? { earned: 0, answered: 0 };
    const percent = stats.possible ? Math.round((me.earned / stats.possible) * 1000) / 10 : 0;
    const fully = stats.perQuestion.filter(p => p.responses.has(myUid) && isFull(p.q, p.responses.get(myUid))).length;
    const seenCases = new Set();

    results.note = kind => fill(noteSlot, kind === 'closed'
      ? h('p.notice', 'The host has closed this session.')
      : h('section.banner.banner-live', { 'aria-label': 'Group study' },
          h('p.banner-title', h('span.live-dot', { 'aria-hidden': 'true' }), h('b', 'A new group session has started: '), String(live.title ?? '')),
          h('button.btn.btn-accent', {
            type: 'button',
            onclick: () => {
              results = null;
              view = null;
              enter();
            },
          }, 'Join session')));

    fill(main,
      noteSlot,
      h('h1.page-title', 'Session Results'),
      h('p.lead', `${set.title} · Group study · ${fmtDate(Date.now())}`),
      h('div.score-card',
        h('p.score-big', `${percent}%`),
        h('div.score-facts',
          h('p', h('b', `${me.earned} of ${stats.possible} points`)),
          h('p', `${fully} of ${plural(shownCount, 'question')} fully correct`),
          me.answered < shownCount ? h('p', `You locked in ${me.answered} of ${shownCount} answers.`) : null,
          h('p', stats.average == null ? 'Group average: no answers yet' : `Group average: ${stats.average}% (${plural(stats.scored, 'student')})`))),
      h('p.note', 'Questions without a locked-in answer count as 0 points. Some question types, such as matrix, drop-down, highlight, and bow tie, can earn partial credit.'),
      h('div.result-actions', h('a.btn.btn-accent', { href: '#/' }, 'Home')),
      h('h2.section-title', 'Review'),
      h('ol.group-review', stats.perQuestion.map(p => {
        const { q, index } = p;
        const r = p.responses.get(myUid);
        const firstOfCase = q.case && set.cases?.[q.case] && !seenCases.has(q.case);
        if (firstOfCase) seenCases.add(q.case);
        return h('li.group-review-item',
          h('div.review-head',
            h('h3.review-q', `Question ${index + 1} of ${questions.length}`),
            h('span.mode-tag', p.answered ? `Group: ${percentOf(p.full, p.answered)}% fully correct (${plural(p.answered, 'answer')})` : 'Group: no answers')),
          firstOfCase ? caseDetails(set.cases[q.case]) : null,
          h('div.question', questionParts(q, { response: r, layout: layouts[index], review: true, idPrefix: `r${index}-` })),
          feedbackPanel(q, r, { answered: r !== undefined }));
      })));
    if (pending) results.note(pending);
  }

  return () => {
    stopLive();
    stopNotice();
    clock.stop();
    clearTimeout(slowStart);
    leave();
    screen?.destroy();
    screen = null;
  };
}

// A case study's exhibits, all open on one page, for the end-of-session review.
function caseDetails({ intro, tabs = [] }) {
  const body = h('div.exhibits',
    intro ? h('p.case-intro', { html: intro }) : null,
    tabs.map((tab, i) => h('section.exhibit',
      h('h4.exhibit-title', tab.title || `Exhibit ${i + 1}`),
      h('div.exhibit-body', { html: tab.html }))));
  for (const table of body.querySelectorAll('table')) {
    const wrap = h('div.table-wrap');
    table.replaceWith(wrap);
    wrap.append(table);
  }
  return h('details.case-details', h('summary', 'Case study exhibits'), body);
}

// ---------- the host console (SPEC 6.5) ----------

// #/host is group study, #/host/sets the question sets (SPEC 11.3), and
// #/host/guides the study guides (SPEC 11.2), with a menu at the top to
// switch between them.
export async function hostView(root, { args = [], isCurrent }) {
  document.title = `Host console · ${SITE_NAME}`;
  leaveFullscreen();
  const main = h('main.wrap.host', h('p.lead', 'Connecting…'));
  root.replaceChildren(h('div.page.host-page', siteHeader({ title: 'Host console' }), main, siteFooter()));
  if (!groupStudyOn()) {
    fill(main,
      h('h1.page-title', 'Host console'),
      h('p.lead', 'Group study is switched off because js/config.js has no Firebase settings yet.'),
      h('p', 'README.md, under “Turn on group study”, explains how to set it up. Solo practice works without it.'));
    return;
  }
  let account, loaded;
  try {
    [account, loaded] = await Promise.all([hostAccount(), loadSets()]);
  } catch (err) {
    if (isCurrent()) fill(main, problemBox('The host console could not connect', err));
    return;
  }
  if (!isCurrent()) return;
  return hostConsole(main, account, loaded, ['sets', 'guides'].includes(args[0]) ? args[0] : 'group', args[0] === 'sets' ? args[1] : null);
}

// The host console's menu. Each page has its own link, so it can be bookmarked.
// Student view (SPEC 11.4) opens the homepage exactly as students see it; a
// "Back to host view" button there (app.js) comes back here.
function hostMenu(area) {
  const item = (key, href, label) => h('a.host-menu-link', { href, 'aria-current': area === key ? 'page' : null }, label);
  return h('nav.host-menu', { 'aria-label': 'Host console' },
    item('group', '#/host', 'Group study'),
    item('sets', '#/host/sets', 'Question sets'),
    item('guides', '#/host/guides', 'Study guides'),
    h('a.btn.btn-small.student-view', { href: '#/' }, 'Student view'));
}

// The start form's list of sets, grouped by class when the sets have classes (SPEC 11).
function setOptions(sets, courses) {
  const option = set => h('option', { value: set.id },
    `${set.title}${set.exam ? ` (${set.exam})` : ''}${set.hidden ? ' (hidden)' : ''} · ${plural(set.questions.length, 'question')}`);
  if (!sets.some(s => s.course)) return sets.map(option);
  const groups = courses.map(c => [`${c.code} ${c.name}`, sets.filter(s => s.course === c.code)]);
  groups.push(['Other', sets.filter(s => !groups.some(([, list]) => list.includes(s)))]);
  return groups.filter(([, list]) => list.length).map(([label, list]) => h('optgroup', { label }, list.map(option)));
}

// setId: on the Question sets page, the set whose questions are open (#/host/sets/<set id>).
function hostConsole(main, account, { sets, courses, guides }, area, setId) {
  let stopConsole = () => {};
  let closed = false;

  function signedIn(user) {
    if (!HOST_UID) showUid(user);
    else if (user.uid !== HOST_UID) showWrongAccount(user);
    else {
      store.set(HOST_HINT, true); // so the pages students see offer "Back to host view" on this browser
      const section = h('div.host-section');
      fill(main, hostMenu(area), section);
      const db = account.database();
      const line = () => accountLine(user);
      if (area === 'guides' || area === 'sets') {
        const stopNotice = connectionNotice(db);
        const stopPage = area === 'guides' ? guidesConsole(section, db, { courses, sets, published: guides }, line)
          : setId ? questionsPage(section, db, { sets, courses }, line, setId)
            : setsConsole(section, db, { sets, courses }, line);
        stopConsole = () => {
          stopPage();
          stopNotice();
        };
      } else {
        // The start form shows the sets with the host's latest changes (SPEC 11.3).
        fill(section, h('p.lead', 'Loading…'));
        let stopped = false;
        stopConsole = () => (stopped = true);
        currentChanges().then(changes => {
          if (!stopped && !closed) stopConsole = runConsole(section, db, withChanges(sets, changes, courses), courses, line);
        });
      }
    }
  }

  function accountLine(user) {
    return h('p.host-account', 'Signed in as ', h('b', user.email ?? 'the host'), ' · ',
      h('button.link-btn', {
        type: 'button',
        onclick: async () => {
          stopConsole();
          stopConsole = () => {};
          store.del(HOST_HINT);
          await account.signOut().catch(() => {});
          if (!closed) showSignIn();
        },
      }, 'Sign out'));
  }

  function showSignIn() {
    document.title = `Host console · ${SITE_NAME}`;
    const email = h('input.text-input#host-email', { type: 'email', autocomplete: 'username', required: true });
    const password = h('input.text-input#host-password', { type: 'password', autocomplete: 'current-password', required: true });
    const problem = h('p.form-problem', { role: 'alert' });
    const button = h('button.btn.btn-accent.btn-big', { type: 'submit' }, 'Sign in');
    const form = h('form.join-card', {
      onsubmit: async e => {
        e.preventDefault();
        problem.textContent = '';
        button.disabled = true;
        try {
          const user = await account.signIn(email.value.trim(), password.value);
          if (!closed) signedIn(user);
        } catch (err) {
          problem.textContent = problemText(err);
          button.disabled = false;
        }
      },
    },
      h('label.field-label', { for: 'host-email' }, 'Email'), email,
      h('label.field-label', { for: 'host-password' }, 'Password'), password,
      problem,
      h('div.form-actions', button));
    fill(main,
      h('h1.page-title', 'Host sign-in'),
      h('p.lead', 'Sign in with the host account you created in the Firebase console (Authentication > Users). Students never sign in.'),
      form);
    email.focus();
  }

  // First-time setup (SPEC 6.1): show the UID to paste into config.js and the rules.
  function showUid(user) {
    const box = h('input.text-input.uid-box', { type: 'text', readonly: true, value: user.uid, 'aria-label': 'Your User UID' });
    box.addEventListener('focus', () => box.select());
    fill(main,
      h('h1.page-title', 'One more setup step'),
      h('p.lead', "You're signed in, but the site doesn't know yet that this is the host account. Copy your User UID and paste it into two files."),
      h('div.setup-box.uid-panel',
        h('p', h('b', 'Your User UID')),
        h('div.uid-row', box, h('button.btn.btn-accent', { type: 'button', onclick: () => copyText(box) }, 'Copy UID'))),
      h('ol.steps',
        h('li', 'In ', h('code', 'js/config.js'), ', paste it between the quotes on the line ', h('code', 'export const HOST_UID = "";')),
        h('li', 'In ', h('code', 'database.rules.json'), ', replace every copy of ', h('code', 'PASTE_HOST_UID'), ' with it. Keep the quote marks around it.'),
        h('li', 'In the Firebase console, open Realtime Database, then the Rules tab. Replace everything there with the whole of ', h('code', 'database.rules.json'), ' and click Publish.'),
        h('li', 'Save both files (on the live site, upload them to GitHub), then reload this page.')),
      accountLine(user));
  }

  function showWrongAccount(user) {
    fill(main,
      h('h1.page-title', 'Not the host account'),
      h('p.lead', `You're signed in as ${user.email ?? 'another account'}, but js/config.js names a different host account (HOST_UID). Sign out, then sign in with the host account.`),
      accountLine(user));
  }

  if (account.user) signedIn(account.user);
  else showSignIn();
  return () => {
    closed = true;
    stopConsole();
  };
}

function copyText(input) {
  const fallback = () => {
    input.focus();
    input.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    toast(ok ? 'Copied.' : 'Press Ctrl+C (or ⌘+C on a Mac) to copy it.');
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(input.value).then(() => toast('Copied.'), fallback);
  else fallback();
}

// The signed-in host's console: the start form, the running session, and the
// summary afterwards, following /live. Returns a function that stops it.
function runConsole(main, db, sets, courses, accountLine) {
  let live = null;
  let view = null; // 'start' | 'run:<sid>' | 'summary:<sid>' | 'problem'
  let run = null;
  let startProblem = '';

  const stopNotice = connectionNotice(db);
  const clock = serverClock(db);
  const stopLive = db.watch('live', value => {
    live = value;
    route();
  }, err => {
    view = 'problem';
    run?.destroy();
    run = null;
    fill(main, h('h1.page-title', 'Host console'), h('p.notice', problemText(err)), accountLine());
  });

  function route() {
    if (view === 'problem') return;
    if (live?.active && live.phase !== 'ended') showRun();
    else if (live?.active) showSummary();
    else showStart();
  }

  function showStart() {
    if (view === 'start') return;
    view = 'start';
    run?.destroy();
    run = null;
    document.title = `Host console · ${SITE_NAME}`;
    if (!sets.length) {
      fill(main, h('h1.page-title', 'Start a group session'), h('p.lead', 'There are no question sets to use yet. Add one to the sets folder first.'), accountLine());
      return;
    }
    const select = h('select.text-input#host-set', setOptions(sets, courses));
    const revealInputs = [['each', 'After each question'], ['end', 'At the end']].map(([value, label]) => {
      const input = h('input.ctl', { type: 'radio', name: 'host-reveal', value, checked: value === 'each' });
      return [input, h('label.choice-line', input, h('span', label))];
    });
    const shuffleBox = h('input.ctl', { type: 'checkbox' });
    const countdownSelect = h('select.text-input.short-select#host-countdown',
      COUNTDOWNS.map(([seconds, label]) => h('option', { value: String(seconds) }, label)));
    const problem = h('p.form-problem', { role: 'alert' }, startProblem);
    const startBtn = h('button.btn.btn-accent.btn-big', { type: 'submit' }, 'Start session');
    const form = h('form.host-start', {
      onsubmit: async e => {
        e.preventDefault();
        const set = sets.find(x => x.id === select.value);
        const reveal = revealInputs.find(([input]) => input.checked)?.[0].value ?? 'each';
        const order = chooseQuestions(set, { shuffleQuestions: shuffleBox.checked }).map(q => q.id);
        const changes = {
          live: {
            active: true,
            sessionId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            setId: set.id,
            title: set.title,
            order,
            index: 0,
            phase: 'answering',
            reveal,
            // Seconds per question (0 = off). The first question's countdown
            // waits for the host's Start button, while students are still joining.
            countdown: Number(countdownSelect.value),
            startedAt: db.serverTime(),
          },
        };
        // Starting a new session replaces /live (SPEC 6.5 item 3); the last
        // session's answers aren't needed any more.
        if (live?.sessionId) changes[`sessions/${live.sessionId}`] = null;
        startProblem = '';
        startBtn.disabled = true;
        try {
          await db.update('', changes);
        } catch (err) {
          startProblem = `The session didn't start. ${problemText(err)}`;
          view = null;
          route();
        }
      },
    },
      h('div.field', h('label.field-label', { for: 'host-set' }, 'Question set'), select,
        h('p.field-help', 'Hidden sets are listed too. Students join from the homepage.')),
      h('fieldset.setting', h('legend', 'Show answers'), revealInputs.map(([, line]) => line)),
      h('div.field', h('label.field-label', { for: 'host-countdown' }, 'Countdown for each question'), countdownSelect,
        h('p.field-help', 'Everyone sees the time left, and finished answers are locked in when it runs out. Each question starts its own countdown; on question 1, click Start countdown once everyone has joined. You can change it during the session.')),
      h('fieldset.setting', h('legend', 'Options'),
        h('label.choice-line', shuffleBox, h('span', 'Shuffle question order')),
        h('p.setting-note', 'Case-study questions stay together and in order.')),
      problem,
      h('div.form-actions', startBtn));
    fill(main,
      h('h1.page-title', 'Start a group session'),
      h('p.lead', 'Everyone sees the same question at the same time and answers privately. Then you show the answer, the rationale, and how the group answered.'),
      form,
      accountLine());
  }

  function showRun() {
    const key = `run:${live.sessionId}`;
    if (view !== key) {
      view = key;
      run?.destroy();
      run = null;
      const found = sessionQuestions(sets, live);
      if (!found) {
        fill(main,
          h('h1.page-title', "This session can't be shown"),
          h('p.notice', `This browser doesn't have every question of “${live.title}” in its copy of the set. Reload the page, or close the session.`),
          h('div.form-actions', closeButton()),
          accountLine());
        return;
      }
      run = hostRun(main, db, clock, live, found, accountLine);
    }
    run?.update(live);
  }

  function closeButton() {
    const btn = h('button.btn.btn-accent', {
      type: 'button',
      onclick: async () => {
        btn.disabled = true;
        try {
          await db.update('live', { active: false });
        } catch (err) {
          toast(problemText(err), 9000);
          btn.disabled = false;
        }
      },
    }, 'Close session');
    return btn;
  }

  // After the session (SPEC 6.5 item 3): percent fully correct per question,
  // hardest first, and Close session.
  async function showSummary() {
    const key = `summary:${live.sessionId}`;
    if (view === key) return;
    view = key;
    run?.destroy();
    run = null;
    document.title = `Session summary · ${SITE_NAME}`;
    const ended = live;
    const found = sessionQuestions(sets, ended);
    if (!found) {
      fill(main, h('h1.page-title', 'Session summary'),
        h('p.notice', `This browser doesn't have every question of “${ended.title}”, so the summary can't be shown.`),
        h('div.form-actions', closeButton()), accountLine());
      return;
    }
    fill(main, h('p.lead', 'Loading the summary…'));
    let all, roster;
    try {
      [all, roster] = await Promise.all([db.read(`sessions/${ended.sessionId}/answers`), db.read(`sessions/${ended.sessionId}/participants`)]);
    } catch (err) {
      if (view === key) fill(main, h('h1.page-title', 'Session summary'), h('p.notice', problemText(err)), h('div.form-actions', closeButton()), accountLine());
      return;
    }
    if (view !== key) return;
    const { questions } = found;
    const count = Math.min((Number(ended.index) || 0) + 1, questions.length);
    const stats = sessionStats(questions.slice(0, count), all, roster);
    const rows = stats.perQuestion
      .map(p => ({ ...p, share: p.answered ? p.full / p.answered : null }))
      .sort((a, b) => (a.share ?? 2) - (b.share ?? 2) || a.index - b.index);
    fill(main,
      h('h1.page-title', 'Session summary'),
      h('p.lead', `${ended.title} · ${plural(stats.people.size, 'participant')}`
        + (count < questions.length ? ` · ended after ${count} of ${questions.length} questions` : '')),
      h('div.score-card',
        h('p.score-big', stats.average == null ? '–' : `${stats.average}%`),
        h('div.score-facts',
          h('p', h('b', 'Group average')),
          h('p', `${plural(stats.scored, 'student')} answered at least one question`))),
      h('p.note', 'Hardest first: the questions with the lowest percent of fully correct answers are at the top.'),
      h('section.perf-section',
        h('div.table-scroll.summary-scroll', h('table.perf.summary',
          h('thead', h('tr',
            h('th', { scope: 'col' }, 'Question'),
            h('th.q-col', { scope: 'col' }, 'Topic'),
            h('th.num', { scope: 'col' }, 'Answers'),
            h('th', { scope: 'col' }, 'Fully correct'))),
          h('tbody', rows.map(p => {
            const pct = p.answered ? percentOf(p.full, p.answered) : null;
            return h('tr',
              h('th', { scope: 'row' }, h('span.summary-num', `Q${p.index + 1}`), ' ', h('span.summary-stem', stemText(p.q))),
              h('td.q-col', p.q.topic),
              h('td.num', String(p.answered)),
              h('td.bar-cell', pct == null ? h('span.muted', 'No answers') : h('div.bar',
                h('span.bar-track', { 'aria-hidden': 'true' }, h('span.bar-fill', { style: `width: ${pct}%` })),
                h('span.bar-pct', `${pct}%`))));
          }))))),
      h('div.result-actions', closeButton()),
      h('p.note', 'Close session ends group study for everyone. Students keep their results on screen.'),
      accountLine());
  }

  return () => {
    stopLive();
    stopNotice();
    clock.stop();
    run?.destroy();
    run = null;
  };
}

// The running session (SPEC 6.5 item 2): the question with a "Show answer
// key" toggle, an optional countdown, participants and the group's answers on
// the side, and the buttons that move everyone along.
function hostRun(main, db, clock, firstLive, { set, questions, layouts }, accountLine) {
  const sid = firstLive.sessionId;
  let live = firstLive;
  let people = {};
  let answers = { index: -1, data: {}, stop: null };
  let showKey = false; // off by default: the host may be sharing the screen
  let drawn = null;
  let busy = false;
  let ticker = 0;
  const caseTabs = {};

  const counter = h('h1.q-counter', { tabindex: '-1' });
  const phaseTag = h('span.mode-tag');
  const countdown = countdownDisplay();
  const keyBox = h('input.ctl', { type: 'checkbox' });
  keyBox.addEventListener('change', () => {
    showKey = keyBox.checked;
    paint();
  });
  const button = (label, onclick, cls = 'button.btn') => h(cls, { type: 'button', onclick }, label);
  // live.timer is the current question's countdown. Moving to the next
  // question starts a new one when live.countdown is on.
  const timerFor = seconds => (seconds > 0 ? { startedAt: db.serverTime(), seconds } : null);
  const revealBtn = button('Reveal answer', () => change({ phase: 'revealed', timer: null }));
  const nextBtn = button('Next question', () => change({ index: live.index + 1, phase: 'answering', timer: timerFor(live.countdown) }));
  const finishBtn = button('Finish session', () => change({ phase: 'ended', timer: null }));
  const endBtn = button('End session', () => confirmEnd());
  const countSelect = h('select.text-input.short-select#host-run-countdown',
    COUNTDOWNS.map(([seconds, label]) => h('option', { value: String(seconds) }, label)));
  countSelect.addEventListener('change', () => {
    const seconds = Number(countSelect.value);
    change({ countdown: seconds, timer: live.phase === 'answering' ? timerFor(seconds) : null });
  });
  const startBtn = button('Start countdown', () => change({ timer: timerFor(live.countdown) }), 'button.btn.btn-small');
  const addBtn = button('Add 30 seconds', () => change({ timer: timerFor(Math.ceil((timeLeftMs(live, clock.now()) ?? 0) / 1000) + 30) }), 'button.btn.btn-small');
  const controls = [revealBtn, nextBtn, finishBtn, endBtn, countSelect, startBtn, addBtn];
  const question = h('section.question.host-question');
  const answeredText = h('p.side-count', { role: 'status' });
  const chips = h('ul.chips', { 'aria-label': 'Participants' });
  const distSlot = h('div.dist-slot');

  fill(main,
    h('div.host-bar',
      h('div.counter-wrap', counter, phaseTag),
      h('div.host-bar-tools', countdown.el, h('div.host-controls', revealBtn, nextBtn, finishBtn, endBtn))),
    h('div.host-layout',
      h('div.host-main',
        h('div.host-tools',
          h('label.choice-line.key-toggle', keyBox, h('span', 'Show answer key')),
          h('div.host-countdown', h('label', { for: 'host-run-countdown' }, 'Countdown'), countSelect, startBtn, addBtn),
          h('span.host-set', set.title)),
        question),
      h('aside.host-side', { 'aria-label': 'Participants and answers' },
        h('section.side-box', h('h2.side-title', 'Participants'), answeredText, chips),
        distSlot)),
    accountLine());
  const area = questionArea(question, set.cases ?? {}, {
    get: key => caseTabs[key] ?? 0,
    set: (key, i) => (caseTabs[key] = i),
  });

  const onError = err => toast(problemText(err), 9000);
  const stopPeople = db.watch(`sessions/${sid}/participants`, value => {
    people = value ?? {};
    paintSide();
  }, onError);

  function watchAnswers() {
    if (answers.index === live.index) return;
    answers.stop?.();
    const box = { index: live.index, data: {}, stop: null };
    answers = box;
    box.stop = db.watch(`sessions/${sid}/answers/q${box.index}`, value => {
      if (answers !== box) return;
      box.data = value ?? {};
      paintSide();
    }, onError);
  }

  function update(next) {
    live = next;
    watchAnswers();
    paint();
  }

  function paint() {
    const index = live.index;
    const q = questions[index];
    const answering = live.phase === 'answering';
    const revealed = live.phase === 'revealed';
    const each = live.reveal !== 'end';
    const last = index === questions.length - 1;
    const left = timeLeftMs(live, clock.now());
    counter.textContent = `Question: ${index + 1} of ${questions.length}`;
    document.title = `Host · Question ${index + 1} · ${SITE_NAME}`;
    phaseTag.textContent = revealed ? 'Answer shown to students'
      : left === 0 ? "Time's up"
      : each ? 'Students answering' : 'Students answering · answers shown at the end';
    const keyOn = revealed || showKey;
    keyBox.checked = keyOn;
    keyBox.disabled = revealed;
    const key = `${index}|${keyOn}|${revealed}`;
    if (key !== drawn) {
      const sameQuestion = drawn?.split('|')[0] === String(index);
      drawn = key;
      area.show(q, [
        keyOn ? h('p.key-banner', revealed ? 'Answer key. Students can see the answer now.'
          : each ? 'Answer key. Students can’t see it until you reveal the answer.'
          : 'Answer key. Students see the answers when the session ends.') : null,
        ...questionParts(q, { response: keyOn ? keyResponse(q) : undefined, layout: layouts[index], locked: true }),
        keyOn ? h('section.feedback.host-rationale', h('h2.feedback-title', 'Rationale'), h('div.rationale', { html: q.rationale })) : null,
      ]);
      if (!sameQuestion) {
        window.scrollTo(0, 0);
        counter.focus({ preventScroll: true });
      }
    }
    revealBtn.hidden = !each || revealed;
    nextBtn.hidden = last;
    finishBtn.hidden = !last;
    const moveOn = !each || revealed;
    nextBtn.classList.toggle('btn-accent', moveOn);
    finishBtn.classList.toggle('btn-accent', moveOn);
    revealBtn.classList.add('btn-accent');
    // The countdown: a length for every question, Start for the first one, and Add 30 s.
    countdown.paint(left);
    if (document.activeElement !== countSelect) countSelect.value = String(live.countdown || 0);
    startBtn.hidden = !(answering && live.countdown > 0 && !live.timer);
    addBtn.hidden = !(answering && live.timer);
    if (left > 0 && !ticker) ticker = setInterval(tick, 250);
    else if (!(left > 0) && ticker) {
      clearInterval(ticker);
      ticker = 0;
    }
    paintSide();
  }

  function tick() {
    const left = timeLeftMs(live, clock.now());
    if (left > 0) countdown.paint(left);
    else paint(); // time's up
  }

  function paintSide() {
    const list = Object.entries(people)
      .map(([uid, p]) => ({ uid, name: String(p?.name ?? '').trim() || 'Student' }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.uid.localeCompare(b.uid));
    const done = new Set(Object.keys(answers.data ?? {}));
    const doneCount = list.filter(p => done.has(p.uid)).length;
    answeredText.textContent = list.length ? `${doneCount} of ${list.length} answered` : 'Waiting for students to join…';
    fill(chips, list.map(p => h('li.chip', { class: done.has(p.uid) ? 'answered' : null },
      done.has(p.uid) ? h('span.chip-check', { 'aria-hidden': 'true' }, '✓') : null,
      p.name,
      done.has(p.uid) ? h('span.sr-only', ' (answered)') : null)));
    const index = live.index;
    fill(distSlot, groupResults(questions[index], layouts[index], readAnswers(answers.data), { showKey: showKey || live.phase === 'revealed' }));
  }

  // Without internet, Firebase keeps the change and sends it when the
  // connection is back; the buttons wait until then.
  async function change(changes) {
    if (busy) return;
    busy = true;
    controls.forEach(b => (b.disabled = true));
    try {
      await db.update('live', changes);
    } catch (err) {
      toast(problemText(err), 9000);
    } finally {
      busy = false;
      controls.forEach(b => (b.disabled = false));
    }
  }

  async function confirmEnd() {
    const choice = await modal({
      title: 'End Session?',
      message: `This ends the session for everyone now. Students see their results for the ${plural(live.index + 1, 'question')} so far.`,
      buttons: [{ label: 'Keep going', value: 'stay', accent: true }, { label: 'End session', value: 'end' }],
    });
    if (choice === 'end') change({ phase: 'ended', timer: null });
  }

  return {
    update,
    destroy() {
      clearInterval(ticker);
      stopPeople();
      answers.stop?.();
    },
  };
}
