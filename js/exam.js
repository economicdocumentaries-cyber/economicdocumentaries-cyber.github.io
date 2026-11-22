// The exam screen (SPEC 3.2–3.5, 4.2–4.5): header, question counter, timer,
// pause, calculator, Continue, alerts, full screen, saved progress, the
// case-study layout, practice feedback, going back and flagging, saving
// questions (SPEC 11.7), and review mode.
import { h, fill, shuffle, store, fmtClock, modal, closeModals, toast, siteHeader, siteFooter, icon, phone, onSwipe, setKeeper } from './util.js';
import { renderItem, prepareItem, isAnswered, scoreItem, instructionFor, helpFor, unansweredMessage } from './items.js';
import { createCalculator } from './calc.js';
import { track } from './analytics.js';
import { reportLine } from './reports.js';
import { saveButton } from './saved.js';
import { recordStats } from './stats.js';
import { vary } from './vary.js';

const ACTIVE = 'pe.active'; // the exam in progress
const LAST = 'pe.last'; // the most recently finished attempt, for results and review
const HISTORY = 'pe.history'; // { setId: [last 20 attempts] }
const HISTORY_LIMIT = 20;
const PAUSE_MS = 5 * 60 * 1000;
const LOW_TIME_MS = 5 * 60 * 1000;

// SPEC 4.2. Choosing a preset on the setup screen fills these settings in.
export const PRESETS = {
  exam: { reveal: 'end', navigation: 'continue', timer: 'standard', fullscreen: true, shuffleQuestions: true, shuffleChoices: true },
  practice: { reveal: 'each', navigation: 'back', timer: 'off', fullscreen: false },
};

// SPEC 4.3: every setting, with Exam simulation's values. The setup page
// starts on Practice mode instead (SPEC 4.2).
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
// The homepage's "Discard exam".
export function discardExam() {
  const st = activeExam();
  if (st) track('exam-discard', { set: st.setId, class: st.course ?? undefined });
  store.del(ACTIVE);
}
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

// SPEC 4.3: filters, then which questions, then their order. A case study's
// questions come a few at a time (caseRunLength), together and in their order:
// an exam has one run of each case study it uses, and its other questions wait
// for later exams, unless the exam needs them to have enough questions (then
// the runs are spread out, with other questions between them). With fewer
// questions than match, they're picked by pickBlocks (SPEC 11.3).
// seen: from lastSeen(), so questions seen longest ago (or never) come first.
// missed: from lastMissed(), so some of the questions missed before come back.
// device: 'phone' or 'laptop', for how long a run is; null keeps every case
// study whole (group study, where the host leads).
export function chooseQuestions(set, s, random = Math.random, seen = new Map(), missed = new Set(), device = phone.matches ? 'phone' : 'laptop') {
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
  const position = new Map(set.questions.map((q, i) => [q, i]));
  const at = b => position.get(b[0]) ?? -1;
  // Practice (answers after each question) takes new questions first (see below), and a case study's new questions
  // come before its missed ones, so a case study with questions left isn't passed over for one already done.
  const practice = s.reveal === 'each';
  const units = [];
  const later = []; // the case studies' other runs, for an exam that needs more questions
  const partSeen = new Set(); // runs of a case study some of whose other questions were seen before
  for (const b of blocks) {
    if (!device || b.length < 2) {
      units.push(b);
      continue;
    }
    const [first, ...rest] = caseRuns(b, device, random, seen, missed, practice);
    if (b.some(q => seen.has(q.id)) && !first.some(q => seen.has(q.id))) partSeen.add(first);
    units.push(first);
    later.push(...rest);
  }
  const limit = s.count ?? Infinity;
  // Each topic's share comes from all the questions that match, the case studies' other runs included, or from the
  // set's blueprint (topicWeights, topicMinimums), in practice and exam simulation alike (the owner's choice,
  // 2026-11-20; from 2026-11-17 practice drew from the whole bank instead). Practice (answers after each question)
  // paces case studies with the rest (pacedCases) and fills each topic's share with new questions; a topic with none
  // left gives its places to new questions of the others (pickBlocks, newFirst), so a student still meets every
  // question before one answered right comes back. Exam simulation (answers at the end) has its case studies per exam
  // (caseStudies), and repeats a topic's questions seen longest ago to keep the blueprint (SPEC 11.3).
  const every = blocks.flat();
  // In practice, the shares and the pace count only the questions that come at the bank's pace: a type held at a share
  // of every exam (typeShares) comes a few at a time, so counting it would hurry along the topics that have the most.
  const held = set.typeShares ?? {};
  const atPace = every.filter(q => !(q.type in held));
  const shareFrom = practice && atPace.length && new Set(atPace.map(q => q.topic)).size === new Set(every.map(q => q.topic)).size
    ? atPace : every;
  // A practice brings the set's earlyTopics early: one of their questions every time until the student has met one
  // (the owner's request, 2026-11-18: ice chips early), as a minimum of 1 on top of any the topic has.
  const early = practice && Array.isArray(set.earlyTopics)
    ? set.earlyTopics.filter(t => every.some(q => q.topic === t) && !every.some(q => q.topic === t && seen.has(q.id))) : [];
  const minimums = early.length
    ? { ...set.topicMinimums, ...Object.fromEntries(early.map(t => [t, [[1, 1], ...(set.topicMinimums?.[t] ?? [])]])) }
    : set.topicMinimums;
  // The study guide's facts (the set's "facts"; the owner's choice of 2026-11-21: every fact early): among questions
  // equally new, the ones on facts the student hasn't met yet come first.
  const facts = factsFor(set, seen);
  let picked = limit < units.flat().length
    ? pickBlocks(units, limit, random, seen, set.topicWeights, missed,
      practice ? pacedCases(shareFrom, limit, seen, device, random) : set.caseStudies,
      minimums, partSeen, shareFrom, practice, facts) : units.slice();
  // The question types (balanceTypes), unless the student asked for these questions (Retake missed, saved, search).
  if (limit < units.flat().length && !s.only) picked = balanceTypes(picked, units, seen, missed, random, heldShares(set, s.types), practice, facts);
  // Too few questions without them: more runs of the case studies (part of one to finish).
  let count = picked.flat().length;
  let more = false;
  for (const run of later) {
    if (count >= limit) break;
    const part = run.slice(0, limit - count);
    part.whole = run.whole;
    picked.push(part);
    count += part.length;
    more = true;
  }
  let ordered = s.shuffleQuestions ? shuffle(picked, random) : picked.slice().sort((a, b) => at(a) - at(b));
  ordered = inCaseOrder(ordered, q => position.get(q) ?? -1);
  if (more) ordered = spreadRuns(ordered);
  return apart(ordered).flat();
}

// ---------- the study guide's facts first (the owner's choice, 2026-11-21) ----------

// A set's "facts" names each item of the instructor's study guide by a code, with the questions that test it, like
// { "EL01": ["el-02", "el-08"] } (SPEC 11.3; tools/fact_codes.py writes it from the coverage map kept next to the class
// materials, so the guide's wording stays out of the site). Returns of (question id -> its codes) and met (the codes
// of every question this student has seen), or null for a set without facts.
export function factsFor(set, seen = new Map()) {
  if (!set.facts || typeof set.facts !== 'object' || Array.isArray(set.facts)) return null;
  const of = new Map();
  for (const [code, ids] of Object.entries(set.facts)) {
    if (Array.isArray(ids)) for (const id of ids) of.set(id, [...(of.get(id) ?? []), code]);
  }
  const met = new Set();
  for (const [id, codes] of of) if (seen.has(id)) for (const code of codes) met.add(code);
  return { of, met };
}

// ---------- case studies a few questions at a time (the owner's request, 2026-11-13) ----------

// How many of a case study's questions come in a row: on a phone 1, or 2 about
// 4 times in 10; on a laptop 2 or 3, and 4 about 1 time in 10. A case study
// with fewer questions gives what it has.
export function caseRunLength(device, random = Math.random) {
  const r = random();
  if (device === 'phone') return r < 0.4 ? 2 : 1;
  return r < 0.1 ? 4 : r < 0.55 ? 3 : 2;
}

// A case study's questions as runs, the one for this exam first: questions
// missed before, then ones never seen, then the ones seen longest ago. The
// first run doesn't add a question answered right while new ones are left, so
// students see new questions first; each run keeps the case study's order.
// Every run remembers its whole case study (run.whole), for topic weights.
// newFirst (practice, 2026-11-17): ones never seen come before the missed ones.
function caseRuns(block, device, random, seen, missed, newFirst = false) {
  const tier = newFirst
    ? q => (!seen.has(q.id) ? 0 : missed.has(q.id) ? 1 : 2)
    : q => (missed.has(q.id) ? 0 : seen.has(q.id) ? 2 : 1);
  const ranked = shuffle(block, random).sort((a, b) => tier(a) - tier(b) || (seen.get(a.id) ?? -1) - (seen.get(b.id) ?? -1));
  const fresh = ranked.filter(q => tier(q) < 2).length;
  const runs = [];
  for (let i = 0; i < ranked.length;) {
    let n = caseRunLength(device, random);
    if (i === 0 && fresh) n = Math.min(n, fresh);
    runs.push(ranked.slice(i, i + n));
    i += n;
  }
  const order = new Map(block.map((q, i) => [q, i]));
  for (const run of runs) {
    run.sort((a, b) => order.get(a) - order.get(b));
    run.whole = block;
  }
  return runs;
}

const isCase = b => !!b?.[0]?.case;

// How many case studies a practice takes, so case-study questions are used up at the same pace as the rest of the
// bank (the owner's choice, 2026-11-17): the questions not seen yet hold some share of case-study questions, and the
// practice takes that share of its places, in runs of the usual length on this device (caseRunLength: 1.4 on a phone,
// 2.65 on a laptop), rounded up or down at random by the fraction. Once every question has been seen, the whole bank's
// share. null for a set without case studies, or without a device (group study keeps case studies whole).
export function pacedCases(questions, limit, seen, device, random = Math.random) {
  const cases = questions.filter(q => q.case).length;
  if (!cases || !device || !Number.isFinite(limit)) return null;
  const fresh = questions.filter(q => !seen.has(q.id));
  const [part, whole] = fresh.length ? [fresh.filter(q => q.case).length, fresh.length] : [cases, questions.length];
  const runs = (limit * part) / whole / (device === 'phone' ? 1.4 : 2.65);
  return Math.floor(runs) + (random() < runs - Math.floor(runs) ? 1 : 0);
}

// An exam with more than one run of a case study: its questions in the case
// study's order across them, each run keeping its place and length.
function inCaseOrder(order, pos) {
  const places = new Map();
  order.forEach((b, i) => {
    if (isCase(b)) places.set(b[0].case, [...(places.get(b[0].case) ?? []), i]);
  });
  const out = order.slice();
  for (const idx of places.values()) {
    if (idx.length < 2) continue;
    const questions = idx.flatMap(i => order[i]).sort((a, b) => pos(a) - pos(b));
    let k = 0;
    for (const i of idx) {
      const run = questions.slice(k, k + order[i].length);
      run.whole = order[i].whole;
      out[i] = run;
      k += run.length;
    }
  }
  return out;
}

// An exam with more than one run of a case study: the single questions in
// order, and the runs at even intervals among them.
function spreadRuns(order) {
  const singles = order.filter(b => !isCase(b));
  const runs = order.filter(isCase);
  const out = [];
  let s = 0;
  runs.forEach((run, j) => {
    const upto = Math.round(((j + 1) * singles.length) / (runs.length + 1));
    while (s < upto) out.push(singles[s++]);
    out.push(run);
  });
  while (s < singles.length) out.push(singles[s++]);
  return out;
}

// No two runs of case studies back to back while a single question can go
// between them: the next single question moves up, or else one from earlier
// that isn't keeping two runs apart.
function apart(order) {
  const out = [];
  const rest = order.slice();
  while (rest.length) {
    const b = rest.shift();
    if (isCase(b) && isCase(out.at(-1))) {
      const k = rest.findIndex(x => !isCase(x));
      if (k >= 0) out.push(...rest.splice(k, 1));
      else {
        const j = out.findLastIndex((x, i) => i < out.length - 1 && !isCase(x) && !(isCase(out[i - 1]) && isCase(out[i + 1])));
        if (j >= 0) out.push(...out.splice(j, 1));
      }
    }
    out.push(b);
  }
  return out;
}

// ---------- the question types (the owner's rule, 2026-11-13) ----------

// Multiple choice is at least 65% of an exam (60% up to 10 questions: 6 of 10) and at most 80%, as on the real
// exams (about 70% multiple choice).
export const MC_FLOOR = 0.65;
export const MC_FLOOR_SMALL = 0.6;
export const MC_CEILING = 0.8;
export function mcRange(n) {
  return [Math.ceil(n * (n <= 10 ? MC_FLOOR_SMALL : MC_FLOOR) - 1e-9), Math.floor(n * MC_CEILING + 1e-9)];
}

// A set's "typeShares" holds a question type at a share of every exam, like { "sata": 0.075 }, so that extra
// questions of that type, there for practicing it on its own, don't change the mix of an ordinary exam (the owner's
// rule, 2026-11-14). With some types turned off in Customize, the share is of the types left, in the set's usual mix
// (each type that isn't held keeps its share of the rest). types: the types the exam uses, or null for every type.
// Returns [type, share] pairs: none when every type left is held, as in a practice of select-all questions alone.
export function heldShares(set, types = null) {
  const held = set.typeShares ?? {};
  const counts = new Map();
  for (const q of set.questions) counts.set(q.type, (counts.get(q.type) ?? 0) + 1);
  const used = [...counts.keys()].filter(t => !types || types.includes(t));
  if (used.every(t => t in held)) return [];
  const others = [...counts].reduce((n, [t, c]) => (t in held ? n : n + c), 0);
  const free = 1 - Object.values(held).reduce((a, b) => a + b, 0);
  const share = t => (t in held ? held[t] : (counts.get(t) / others) * free);
  const total = used.reduce((sum, t) => sum + share(t), 0);
  return used.filter(t => t in held).map(t => [t, share(t) / total]);
}

// Keeps an exam's question types in line, as far as the questions allow, by swapping a single question for one
// of the same topic, so each topic keeps its share. First each held type (heldShares) goes to its share of the
// exam, rounded up or down at random by the fraction (3.75 of 50: 4 in three exams of four, 3 in the other),
// leaning toward mcRange as it goes; then multiple choice goes into mcRange, trading types that aren't held (a
// held type only when nothing else is left: select-all and multiple choice alone, say). Out goes the one seen most
// recently; in comes the one seen longest ago (or never). For multiple choice, never one seen more recently than
// the one it replaces, so new questions still come first; a held type's share comes before that, so a student
// with many new questions of that type sees them a few at a time. Questions missed before stay where the review
// put them (and count toward the shares), and so do a case study's questions.
// keepFresh (practice, 2026-11-17): a held type's swaps also never bring in a question seen more recently than the
// one they replace, so a practice holds a few more (or fewer) of that type rather than bring back a question the
// student answered right while new ones are left.
// facts (factsFor, 2026-11-21): among questions seen equally long ago, out goes the one on the fewest facts the student
// hasn't met, and in comes the one on the most.
function balanceTypes(picked, units, seen, missed, random, held = [], keepFresh = false, facts = null) {
  const n = picked.flat().length;
  if (n < 5) return picked;
  const type = b => b[0].type;
  const isHeld = b => held.some(([t]) => t === type(b));
  const isMc = b => type(b) === 'mc';
  const other = b => !isMc(b) && !isHeld(b); // neither multiple choice nor held
  const age = b => seen.get(b[0].id) ?? -1;
  const worth = b => (facts ? b.flatMap(q => facts.of.get(q.id) ?? []).filter(c => !facts.met.has(c)).length : 0);
  const out = picked.slice();
  const taken = new Set(out);
  const spare = shuffle(units.filter(b => !taken.has(b) && !isCase(b) && !missed.has(b[0].id)), random);
  const count = test => out.flat().filter(q => test([q])).length;
  const [floor, ceiling] = mcRange(n);
  // One swap: out goes a question of the exam for which goes() is true, in comes a spare one of the same topic for
  // which comes() is true. fresh: never one seen more recently than the one it replaces. False when none is left.
  const swap = (goes, comes, fresh) => {
    const outs = out.map((b, i) => [b, i])
      .filter(([b]) => !isCase(b) && !missed.has(b[0].id) && goes(b))
      .sort((x, y) => age(y[0]) - age(x[0]) || worth(x[0]) - worth(y[0]));
    for (const [b, i] of outs) {
      const k = spare.reduce((best, c, j) => (comes(c) && c[0].topic === b[0].topic && (!fresh || age(c) <= age(b))
        && (best < 0 || age(c) < age(spare[best]) || (age(c) === age(spare[best]) && worth(c) > worth(spare[best]))) ? j : best), -1);
      if (k < 0) continue;
      out[i] = spare[k];
      spare[k] = b;
      return true;
    }
    return false;
  };
  // Each held type to its share. These swaps put the share before freshness, and lean toward the multiple-choice
  // range: what comes in (or goes) is multiple choice while there's too little of it, and another type while
  // there's too much, when the topic has one.
  for (const [t, share] of held) {
    const exact = n * share;
    const want = Math.floor(exact) + (random() < exact - Math.floor(exact) ? 1 : 0);
    const isT = b => type(b) === t;
    const notHeld = b => !isHeld(b);
    let have = count(isT);
    while (have > want) {
      const mc = count(isMc);
      const lean = mc < floor ? isMc : mc >= ceiling ? other : null;
      if (!(lean && swap(isT, lean, keepFresh)) && !swap(isT, notHeld, keepFresh)) break;
      have--;
    }
    while (have < want) {
      const mc = count(isMc);
      const lean = mc > ceiling ? isMc : mc <= floor ? other : null;
      if (!(lean && swap(lean, isT, keepFresh)) && !swap(notHeld, isT, keepFresh)) break;
      have++;
    }
  }
  // Then multiple choice into its range, never trading away freshness.
  let mc = count(isMc);
  while (mc < floor && (swap(other, isMc, true) || swap(b => !isMc(b), isMc, true))) mc++;
  while (mc > ceiling && (swap(isMc, other, true) || swap(isMc, c => !isMc(c), true))) mc--;
  return out;
}

// ---------- an exam of any size follows the blueprint (the owner's request, 2026-11-13) ----------

// Whole shares that add up to the limit: each topic gets its exact share
// rounded down, and the places left go to topics in turn, each about as often
// as its fraction (systematic sampling, from a random start and in a random
// order). So an exam of 10 from a 60-question blueprint is one of a few
// blueprints, each topic one place over or under at most, and over several
// exams each topic gets its exact share on average.
export function roundShares(exact, limit, random = Math.random) {
  const share = exact.map(Math.floor);
  let extra = limit - share.reduce((a, b) => a + b, 0);
  const start = random();
  let at = 0;
  for (const i of shuffle(exact.map((_, i) => i), random)) {
    const to = at + exact[i] - share[i];
    if (extra > 0 && Math.ceil(to - start) > Math.ceil(at - start)) {
      share[i]++;
      extra--;
    }
    at = to;
  }
  // Rounding in the sums can leave a place: it goes to the biggest fraction still rounded down.
  while (extra > 0) {
    let best = 0;
    exact.forEach((x, i) => {
      if (x - share[i] > exact[best] - share[best]) best = i;
    });
    share[best]++;
    extra--;
  }
  return share;
}

// How much more each topic weighs for this student: up to half again, by the
// part of the topic's questions they've seen whose latest result was a miss
// (once they've seen 3 or more of them). An exam leans toward the topics they
// struggle with (the owner's request, 2026-11-13). Since 2026-11-20, only in a
// set without a blueprint: a blueprint's counts hold in every exam (pickBlocks).
export const LEAN = 0.5;
export function leanToward(questions, seen, missed) {
  const tally = new Map();
  for (const q of questions) {
    if (!seen.has(q.id)) continue;
    const t = tally.get(q.topic) ?? { seen: 0, missed: 0 };
    t.seen++;
    if (missed.has(q.id)) t.missed++;
    tally.set(q.topic, t);
  }
  const lean = new Map();
  for (const [topic, t] of tally) if (t.seen >= 3) lean.set(topic, 1 + LEAN * (t.missed / t.seen));
  return lean;
}

// Whole blocks (single questions, and case studies' runs) adding up to `limit`
// questions: the ones seen longest ago (or never) first, and each topic getting
// its share in the same proportions as all the questions, so a set written to a
// blueprint keeps its balance. A case study's questions count toward their own topics.
// weights: the set's topicWeights, when its exams must follow a blueprint
// whatever the size of each topic's pool (SPEC 11.3). Then each topic's share
// comes first, with its questions seen longest ago, and a case study may go
// past its topics' shares by 2 questions at most. A topic weighted 0 is left
// out, with any case study that has a question in it, unless the other topics
// run out of questions.
// missed: questions whose latest result was a miss. About one place in five
// goes to them (the owner's request, 2026-11-02), so a missed question comes
// back soon; questions answered right wait until the others have been seen.
// caseStudies: the set's "caseStudies", how many case studies every exam has
// (SPEC 11.3; the owner's request for the NU1120 Exam 4 Mock Exam, 2026-11-12,
// since the real exam may have one): exactly that many, the ones whose turn
// comes first, as long as they take at most half the exam. Without it, case
// studies come up when their turn comes, so an exam may have none or several.
// minimums: the set's "topicMinimums", { topic: [[from, atLeast], ...] }: in an
// exam of `from` questions or more, the topic gets at least `atLeast` places,
// taken from the topics with the most (the owner's request, 2026-11-13: ice chip
// questions in the NU1110 Exam 4 exams).
// partSeen: runs of case studies whose other questions were seen before; they
// come after case studies never seen, so the case studies take turns.
// everyQuestion: all the questions that match, for each topic's share when there
// are no weights (the blocks hold only one run of each case study).
// newFirst (practice, the owner's choice of 2026-11-20): each topic's share takes
// only questions the student hasn't met (and missed ones coming back); a topic
// with none left gives its places to the new questions of the topics weighted
// above 0, so a question answered right comes back only once none are left
// anywhere (then the blueprint's shares, with the questions seen longest ago).
// facts (factsFor, the owner's choice of 2026-11-21): among questions equally new,
// and after a topic's share, the ones on the most facts this student hasn't met
// come first, counting the facts this exam has already brought, so the first
// practices reach every line of the study guide before more versions come.
function pickBlocks(blocks, limit, random, seen, weights = null, missed = new Set(), caseStudies = null, minimums = null, partSeen = new Set(), everyQuestion = null, newFirst = false, facts = null) {
  const age = b => Math.max(...b.map(q => seen.get(q.id) ?? -1)) + (partSeen.has(b) ? 0.5 : 0); // -1: never seen
  const wasMissed = b => b.some(q => missed.has(q.id));
  const wanted = Number.isInteger(caseStudies) && caseStudies >= 0 ? caseStudies : null;
  // Each topic's share of the limit: its weight (or its number of questions), leaning toward the
  // topics this student keeps missing (leanToward), rounded so the shares add up to the limit.
  const pool = blocks.flat(); // what this exam can take
  const all = everyQuestion ?? pool;
  const topics = [...new Set(all.map(q => q.topic))];
  const blueprint = !!weights && topics.every(t => weights[t] >= 0) && topics.some(t => weights[t] > 0);
  // A blueprint's counts hold in every exam (the owner's request, 2026-11-20: the professor's 17 ethics,
  // 3 abbreviation, and 5 or 6 math questions of 58), so the lean is for sets without one.
  const lean = blueprint ? new Map() : leanToward(all, seen, missed);
  const weightOf = t => (blueprint ? weights[t] : all.filter(q => q.topic === t).length) * (lean.get(t) ?? 1);
  const total = topics.reduce((sum, t) => sum + weightOf(t), 0);
  const exact = topics.map(t => (weightOf(t) * limit) / total);
  const share = roundShares(exact, limit, random);
  // A topic's minimum for an exam this size, as far as its questions go; each place comes from the
  // topic furthest above its exact share (then the one with the most), never below its own minimum.
  // A minimum below 1 is a chance (the owner's choice, 2026-11-13: an ice chip question in half of the
  // exams of 10): the topic gets one question in that share of exams, and none in the others, its
  // places going to the topics furthest below their exact shares.
  const floor = new Map(); // topic -> its minimum in this exam
  for (const [t, rules] of Object.entries(minimums && typeof minimums === 'object' ? minimums : {})) {
    const i = topics.indexOf(t);
    if (i < 0 || !Array.isArray(rules)) continue;
    let need = Math.max(0, ...rules.filter(r => Array.isArray(r) && limit >= r[0]).map(r => r[1]));
    if (need > 0 && need < 1) {
      if (random() < need) need = 1;
      else {
        while (share[i] > 0) {
          let to = -1;
          share.forEach((n, k) => {
            if (k !== i && weightOf(topics[k]) > 0 && (to < 0 || exact[k] - n > exact[to] - share[to])) to = k;
          });
          if (to < 0) break;
          share[i]--;
          share[to]++;
        }
        floor.set(t, 0);
        continue;
      }
    }
    const target = Math.min(need, pool.filter(q => q.topic === t).length, limit);
    floor.set(t, target);
    while (share[i] < target) {
      let from = -1;
      share.forEach((n, k) => {
        if (k === i || n <= (floor.get(topics[k]) ?? 0)) return;
        const over = n - exact[k];
        if (from < 0 || over > share[from] - exact[from] || (over === share[from] - exact[from] && n > share[from])) from = k;
      });
      if (from < 0) break;
      share[from]--;
      share[i]++;
    }
  }
  const left = new Map(topics.map((t, i) => [t, share[i]])); // what each topic still needs
  // A case study's run that would take its topics more than 2 past their shares, or whose case
  // study has a topic weighted 0 (blueprint sets only).
  const tooBig = b => blueprint && ([...new Set((b.whole ?? b).map(q => q.topic))].some(t => weights[t] === 0)
    || [...new Set(b.map(q => q.topic))].some(t => b.filter(q => q.topic === t).length > left.get(t) + 2));
  // The missed questions that come back: up to a fifth of the exam, the ones seen longest
  // ago first. A single question needs a place left in its topic's share; a case study's run
  // comes back when it fits in the places left for them.
  const review = new Set();
  let places = Math.round(limit / 5);
  const room = new Map(left);
  let reviewCases = 0; // with caseStudies, no more missed case studies come back than an exam has
  for (const b of shuffle(blocks.filter(wasMissed), random).sort((a, b) => age(a) - age(b))) {
    if (b.length > places || (!isCase(b) ? room.get(b[0].topic) < 1 : tooBig(b) || (wanted !== null && reviewCases >= wanted))) continue;
    review.add(b);
    places -= b.length;
    if (isCase(b)) reviewCases++;
    for (const q of b) room.set(q.topic, room.get(q.topic) - 1);
  }
  // The order to pick in: those missed questions, then questions never seen, then the ones
  // seen longest ago (a missed one a little before one answered right at the same time),
  // in random order within each, the ones on more facts not met yet first (facts).
  const rank = b => (review.has(b) ? -2 : age(b) - (wasMissed(b) ? 0.5 : 0));
  const metNow = new Set(facts?.met ?? []); // the facts met before, and the ones this exam has brought
  const unmet = b => (facts ? new Set(b.flatMap(q => (facts.of.get(q.id) ?? []).filter(c => !metNow.has(c)))).size : 0);
  const unmetAtStart = new Map(facts ? blocks.map(b => [b, unmet(b)]) : []);
  const queue = shuffle(blocks, random).sort((a, b) => rank(a) - rank(b) || (unmetAtStart.get(b) ?? 0) - (unmetAtStart.get(a) ?? 0));
  const picked = [];
  let count = 0;
  const take = b => {
    queue.splice(queue.indexOf(b), 1);
    picked.push(b);
    for (const q of b) left.set(q.topic, left.get(q.topic) - 1);
    if (facts) for (const q of b) for (const c of facts.of.get(q.id) ?? []) metNow.add(c);
    count += b.length;
  };
  if (wanted === null) {
    // Case studies whose turn it is: the ones starting within the first `limit` questions of the queue.
    let start = 0;
    for (const b of queue.slice()) {
      if (start >= limit) break;
      start += b.length;
      if (isCase(b) && count + b.length <= limit && !tooBig(b)) take(b);
    }
  } else {
    // Exactly `wanted` case studies, the first in the queue (a missed one, then one never seen,
    // then the one seen longest ago), so they take turns; fewer if too few fit in half the exam.
    let taken = 0;
    for (const b of queue.slice()) {
      if (taken >= wanted) break;
      if (isCase(b) && count + b.length <= limit / 2 && !tooBig(b)) {
        take(b);
        taken++;
      }
    }
  }
  // In a blueprint set, a case study that went past its topics' shares leaves fewer open
  // places than the other topics still need: those places are shared out again by weight,
  // so the shortfall is spread over the topics instead of landing on one.
  if (blueprint) {
    const open = topics.filter(t => left.get(t) > 0 && weights[t] > 0);
    const places = limit - count;
    if (open.reduce((sum, t) => sum + left.get(t), 0) > places) {
      const given = new Map(open.map(t => [t, 0]));
      let rest = places;
      // A topic's minimum (topicMinimums) is kept first.
      for (const t of open) {
        const keep = Math.min(left.get(t), floor.get(t) ?? 0, rest);
        given.set(t, keep);
        rest -= keep;
      }
      let active = open.filter(t => given.get(t) < left.get(t));
      // By weight, never past what a topic still needs; places a full topic can't take go round again.
      while (rest > 0 && active.length) {
        const total = active.reduce((sum, t) => sum + weights[t], 0);
        const fair = active.map(t => (weights[t] * rest) / total);
        const whole = fair.map(Math.floor);
        const tie = active.map(() => random());
        const order = active.map((_, i) => i).sort((i, j) => fair[j] - whole[j] - (fair[i] - whole[i]) || tie[i] - tie[j]);
        for (const i of order.slice(0, rest - whole.reduce((a, b) => a + b, 0))) whole[i]++;
        let handed = 0;
        active.forEach((t, i) => {
          const add = Math.min(whole[i], left.get(t) - given.get(t));
          given.set(t, given.get(t) + add);
          handed += add;
        });
        if (!handed) break;
        rest -= handed;
        active = active.filter(t => given.get(t) < left.get(t));
      }
      for (const t of open) left.set(t, given.get(t));
    }
  }
  // Then single questions: in the order above, and among equals, ones whose topic still needs some.
  // In a blueprint set, topics that still need some come first, then the order above among them. In practice
  // (newFirst) they take only new questions and the missed ones coming back: a topic with none left gives its places
  // to the new questions of the topics weighted above 0, and its seen ones come back only when none are left anywhere.
  const full = b => (left.get(b[0].topic) > 0 ? 0 : 1);
  const fresh = b => review.has(b) || age(b) < 0;
  while (count < limit) {
    const singles = queue.filter(b => !isCase(b));
    if (!singles.length) break;
    let pool = singles;
    if (blueprint) {
      const needed = singles.filter(b => !full(b));
      const newNeeded = newFirst ? needed.filter(fresh) : needed;
      const newElsewhere = newFirst ? singles.filter(b => fresh(b) && weights[b[0].topic] > 0) : [];
      pool = newNeeded.length ? newNeeded : newElsewhere.length ? newElsewhere : needed.length ? needed : singles;
    }
    const better = (b, best) => rank(b) - rank(best) || full(b) - full(best) || unmet(best) - unmet(b);
    take(pool.reduce((best, b) => (better(b, best) < 0 ? b : best)));
  }
  // Too few single questions: more case studies that fit, then part of one rather than nothing.
  for (const b of queue.slice()) if (count + b.length <= limit) take(b);
  if (!picked.length) picked.push(queue[0].slice(0, limit));
  return picked;
}

// The questions of an attempt in the history. Attempts saved before the ids
// were kept count every question if they had the whole set, or else just the
// missed ones.
const attemptIds = (set, a) => a.ids ?? (a.scope === 'full' ? set.questions.map(q => q.id) : a.missed ?? []);

// When each of the set's questions was last seen, as id -> attempt number
// (higher is more recent).
export function lastSeen(set) {
  const seen = new Map();
  setHistory(set.id).forEach((a, n) => {
    for (const id of attemptIds(set, a)) seen.set(id, n);
  });
  return seen;
}

// The questions this browser has seen in earlier attempts at a set. Any other
// question in an attempt is a first try (SPEC 11.9): the honest measure of how
// ready a student is, since remembering a question isn't knowing it.
const seenBefore = setId => new Set(setHistory(setId).flatMap(a => a.ids ?? a.missed ?? []));

// The questions whose latest result was a miss (less than full points), so new
// exams bring some of them back (pickBlocks).
export function lastMissed(set) {
  const missed = new Set();
  for (const a of setHistory(set.id)) {
    const wrong = new Set(a.missed ?? []);
    for (const id of attemptIds(set, a)) {
      if (wrong.has(id)) missed.add(id);
      else missed.delete(id);
    }
  }
  return missed;
}

// How many questions an exam has unless the student changes it (SPEC 11.3):
// the set's defaultCount, or null for every question.
export function defaultCount(set) {
  const n = set.defaultCount;
  return Number.isInteger(n) && n >= 1 && n < set.questions.length ? n : null;
}

// A set whose exams are as long as the real NU1110 exams, 55 questions or more (60,
// and 58 for Exam 4) (the owner's choices, 2026-11-13 and 2026-11-20): half on a
// phone, and a shorter practice on a laptop.
const LONG_EXAM = 55;
const longExam = set => (defaultCount(set) ?? 0) >= LONG_EXAM;

// How many questions practice mode gives (SPEC 4.2; the owner's choices, 2026-11-02
// and 2026-11-13): 10 on a phone, and 25 on a laptop (15 for a long exam),
// never more than the set's questions per exam. null for every question.
export function practiceCount(set, onPhone = phone.matches) {
  const n = Math.min(onPhone ? 10 : longExam(set) ? 15 : 25, defaultCount(set) ?? set.questions.length);
  return n < set.questions.length ? n : null;
}

// How many questions exam simulation gives: the set's questions per exam, but half
// on a phone for a long exam (30 of 60, 29 of 58). null for every question.
export function examCount(set, onPhone = phone.matches) {
  return longExam(set) && onPhone ? Math.ceil(defaultCount(set) / 2) : defaultCount(set);
}

// "Best" on the homepage counts attempts of the whole set, or of at least its
// exam simulation's number of questions (a phone's, the smaller) with every topic
// and type (SPEC 11.3). Exams finished early never count.
export function countsForBest(attempt, set) {
  if (attempt.early) return false;
  if (attempt.scope === 'full') return true;
  return attempt.scope === 'part' && !attempt.settings?.topics && !attempt.settings?.types
    && attempt.count >= (examCount(set, true) ?? set.questions.length);
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

// Returns false when no questions match the settings. scope: 'saved' for a
// practice exam of saved questions (SPEC 11.7); otherwise it's worked out.
export function startExam(set, settings = {}, scope = null) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  // A question with changing numbers gets its numbers now (vary.js), so the whole
  // attempt, its review, and its history keep them; the next attempt gets new ones.
  const missedBefore = lastMissed(set);
  const questions = chooseQuestions(set, s, Math.random, lastSeen(set), missedBefore).map(q => vary(q));
  if (!questions.length) return false;
  if (s.fullscreen) enterFullscreen();
  const limitMs = timeLimitMs(set, questions.length, s);
  const now = Date.now();
  store.set(ACTIVE, {
    v: 2,
    setId: set.id,
    course: set.course ?? 'other', // for the usage stats
    title: set.title,
    settings: s,
    scope: scope ?? (s.only ? 'missed' : questions.length < set.questions.length ? 'part' : 'full'),
    cases: set.cases ?? {},
    questions, // a copy, so later edits to the set file can't break this attempt
    again: questions.filter(q => missedBefore.has(q.id)).map(q => q.id), // back because they were missed (a tag says so)
    layout: Object.fromEntries(questions.map(q => [q.id, prepareItem(q, { shuffle: s.shuffleChoices })])),
    index: 0,
    responses: {},
    caseTabs: {}, // the exhibit tab last shown for each case study
    revealed: {}, // practice mode: questions whose answer has been shown
    flags: {},
    crossed: {}, // choices crossed out on each question (a study aid)
    onGrid: false, // on the review grid before submitting
    reachedGrid: false, // the review grid has been shown, so Continue goes back to it
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
  if (st) track('exam-resume', { set: st.setId, class: st.course ?? undefined });
  if (st?.settings.fullscreen && !st.fullscreenDeclined) enterFullscreen();
  location.hash = '#/exam';
}

// reason: 'submitted', 'time', or 'early' (Close, then Finish and see results).
// Finishing early scores only the questions answered so far; the others stay
// unseen, so they come first next time. seen: seenBefore(), so each item knows
// whether it was a first try.
function grade(st, reason, seen = new Set()) {
  const early = reason === 'early';
  const questions = early ? st.questions.filter(q => isAnswered(q, st.responses[q.id])) : st.questions;
  const items = questions.map(q => ({ id: q.id, type: q.type, topic: q.topic, first: !seen.has(q.id), ...scoreItem(q, st.responses[q.id]) }));
  const firsts = items.filter(i => i.first);
  const earned = items.reduce((sum, i) => sum + i.earned, 0);
  const possible = items.reduce((sum, i) => sum + i.max, 0);
  const finishedAt = Date.now();
  const pausedMs = st.pausedMs + (st.pausedAt ? Math.min(finishedAt - st.pausedAt, st.pauseLeftMs) : 0);
  const usedMs = finishedAt - st.startedAt - pausedMs;
  return {
    setId: st.setId,
    title: st.title,
    reason,
    scope: early && !['missed', 'saved'].includes(st.scope) ? 'part' : st.scope ?? 'full',
    total: st.questions.length, // the exam's size, even when it was finished early
    startedAt: st.startedAt,
    finishedAt,
    timeUsedMs: st.limitMs ? Math.min(usedMs, st.limitMs) : usedMs,
    earned,
    possible,
    percent: possible ? Math.round((earned / possible) * 1000) / 10 : 0,
    items,
    missed: items.filter(i => i.earned < i.max).map(i => i.id), // "missed" = less than full points (SPEC 5.4)
    firstTry: { right: firsts.filter(i => i.earned === i.max).length, total: firsts.length }, // SPEC 11.9
    again: items.filter(i => (st.again ?? []).includes(i.id)).map(i => ({ id: i.id, right: i.earned === i.max })), // missed before
    settings: st.settings,
    questions,
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
    ids: result.items.map(i => i.id), // for showing questions not seen yet first
    missed: result.missed,
    settings: result.settings,
    ...(result.reason === 'early' ? { early: true } : {}),
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
// report: the set's id, to offer "Report a problem with this question" (SPEC 11.6).
// answerKey: the answer key is shown above, not a student's answer (a saved
// question's View answer, SPEC 11.7), so there's no score.
export function feedbackPanel(q, response, { answered = true, report = null, answerKey = false } = {}) {
  const { earned, max } = scoreItem(q, response);
  const result = answerKey ? 'key' : !answered ? 'wrong' : earned === max ? 'correct' : earned > 0 ? 'partial' : 'wrong';
  return h(`section.feedback.is-${result}`, { tabindex: '-1', 'aria-label': 'Answer and rationale' },
    answerKey ? null : h('p.feedback-result', answered
      ? [h('b', { correct: '✓ Correct', partial: 'Partially correct', wrong: '✗ Incorrect' }[result]),
          ` · ${earned} of ${max} point${max === 1 ? '' : 's'}`]
      : [h('b', 'No answer locked in'), ` · 0 of ${max} point${max === 1 ? '' : 's'}`]),
    h('h2.feedback-title', 'Rationale'),
    h('div.rationale', { html: q.rationale }),
    report ? reportLine(report, q.src ? { ...q, id: q.src.id } : q) : null);
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
// On phones (SPEC 11.8) the case folds into a "Client chart" card above the
// question: Open shows the exhibits full screen, and Back to the question
// folds them again, with the answers and the chosen tab kept.
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
  const opener = h('button.btn.chart-open', { type: 'button', 'aria-expanded': 'false', onclick: () => setOpen(true) }, 'Open');
  const aside = h('aside.case-panel', { 'aria-label': 'Case study' },
    h('div.chart-card',
      icon('chart'),
      h('div.chart-name',
        h('p.chart-title', 'Client chart'),
        tabs.length ? h('p.chart-tabs', tabs.map((tab, i) => tab.title || `Exhibit ${i + 1}`).join(' · ')) : null),
      tabs.length ? opener : null),
    intro ? h('p.case-intro', { html: intro }) : null,
    tabs.length ? tablist : null,
    panel,
    tabs.length ? h('button.chart-back', { type: 'button', onclick: () => setOpen(false) }, '← Back to the question') : null);

  function setOpen(open) {
    aside.classList.toggle('is-open', open);
    opener.setAttribute('aria-expanded', String(open));
    (open ? buttons[current] : opener).focus({ preventScroll: true });
  }
  aside.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !aside.classList.contains('is-open')) return;
    e.preventDefault();
    setOpen(false);
  });
  return aside;
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
  st.crossed ??= {}; // choices crossed out on each question (a study aid)
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
  // An event for the usage stats, sent once per exam (kept in pe.active, so a reload doesn't send it again).
  const once = (name, details = {}) => {
    st.tracked ??= {};
    if (st.tracked[name]) return;
    st.tracked[name] = true;
    save();
    track(name, { set: st.setId, class: st.course ?? undefined, ...details });
  };

  // --- build the page ---
  const counter = h('h1.q-counter', { tabindex: '-1' });
  // A question that's back because the student missed it last time says so (the owner's choice, 2026-11-13), when the
  // answers show after each question, as in practice mode. Exam simulation has no tag, like test day (the owner's
  // choice, 2026-11-17): the question still comes back, and the results still say how those went.
  const againTag = showsAnswers ? h('span.again-tag', { hidden: true }, icon('redo'), 'Missed before') : null;
  const timeVal = h('span.val');
  const pauseVal = h('span.val');
  const timer = h('div.timer',
    h('div', icon('clock'), h('b', 'Time Remaining:'), ' ', timeVal),
    h('div', h('b', 'Pause Remaining:'), ' ', pauseVal));
  const pauseBtn = h('button.btn.btn-pause', { type: 'button', onclick: () => pause() }, 'Pause');
  const calcBtn = h('button.calc-toggle', { type: 'button', 'aria-label': 'Calculator', 'aria-pressed': 'false', title: 'Calculator' }, icon('calc'));
  const question = h('section.question');
  // Previous and Flag only appear when going back is allowed (SPEC 4.3).
  const prevBtn = h('button.btn.btn-nav', { type: 'button', onclick: () => goTo(st.index - 1) }, 'Previous');
  const flagLabel = h('span', 'Flag');
  const flagBtn = h('button.btn.btn-flag', { type: 'button', 'aria-pressed': 'false', onclick: () => toggleFlag() }, icon('flag'), flagLabel);
  // Save (SPEC 11.7) appears when answers show after each question, as in
  // practice mode; exam simulation stays like test day.
  const saver = showsAnswers ? saveButton() : null;
  // Continue, which on phones says what it does: Check answer, Next question...
  const continueText = h('span.c-phone');
  const continueBtn = h('button.btn-continue', { type: 'button', onclick: () => onContinue() }, h('span.c-wide', 'Continue'), continueText);
  const actions = h('div.exam-actions',
    canGoBack || saver ? h('div.nav-left', canGoBack ? [prevBtn, flagBtn] : null, saver?.el) : null,
    continueBtn);
  const footer = siteFooter();
  const fsNotice = footer.querySelector('.fs-notice');
  const announcer = h('div.sr-only', { 'aria-live': 'polite' });

  // Phones (SPEC 11.8): a bar with Close, the question chip (it opens the list
  // of questions), and Flag, Save, and the calculator as icons, over a line
  // that fills as questions are answered. The header and Continue's row hide.
  const chip = h('button.m-chip', { type: 'button', 'aria-haspopup': 'dialog', onclick: () => showNavigator() });
  const mFlag = canGoBack ? h('button.m-icon.m-flag', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Flag', title: 'Flag', onclick: () => toggleFlag() }, icon('flag')) : null;
  const mSave = saver ? h('button.m-icon.m-save', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Save', title: 'Save', onclick: () => saver.el.click() }, icon('bookmark')) : null;
  const mCalc = s.calculator ? h('button.m-icon.m-calc', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Calculator', title: 'Calculator' }, icon('calc')) : null;
  const progress = h('span');
  // Clicking Save (either one) repaints the bar's icon after the button's own handler.
  saver?.el.addEventListener('click', () => mSave.setAttribute('aria-pressed', saver.el.getAttribute('aria-pressed')));
  const sheetShade = h('div.sheet-shade', { 'aria-hidden': 'true', onclick: () => foldSheet() });

  const page = h('div.page.exam.taking', { 'data-text-size': s.textSize ?? 'standard' },
    siteHeader({ title: st.title, onClose: () => confirmLeave(), link: false }),
    h('div.m-top',
      h('div.m-top-row',
        h('button.m-close', { type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => confirmLeave() }, icon('x')),
        chip, mFlag, mSave, mCalc),
      h('div.m-progress', { 'aria-hidden': 'true' }, progress)),
    h('main.wrap',
      h('div.info-row',
        h('div.counter-wrap', counter, s.preset === 'practice' ? h('span.mode-tag', 'Practice mode') : null, againTag),
        h('div.info-tools', timed ? [timer, pauseBtn] : null, s.calculator ? calcBtn : null)),
      question),
    footer,
    sheetShade,
    announcer);
  root.replaceChildren(page);

  const calc = s.calculator
    ? createCalculator({
        onClose: () => {
          calcBtn.setAttribute('aria-pressed', 'false');
          mCalc.setAttribute('aria-pressed', 'false');
          (phone.matches ? mCalc : calcBtn).focus({ preventScroll: true });
        },
      })
    : null;
  if (calc) {
    page.append(calc.el);
    const toggleCalc = button => {
      const open = calc.toggle(button);
      calcBtn.setAttribute('aria-pressed', String(open));
      mCalc.setAttribute('aria-pressed', String(open));
      if (open) once('calculator-open');
    };
    calcBtn.addEventListener('click', () => toggleCalc(calcBtn));
    mCalc.addEventListener('click', () => toggleCalc(mCalc));
  }

  const area = questionArea(question, st.cases, {
    get: key => st.caseTabs[key] ?? 0,
    set: (key, i) => {
      st.caseTabs = { ...st.caseTabs, [key]: i };
      save();
    },
  });

  // --- questions ---
  // checked: the answer was just checked, so on phones its sheet opens; a
  // question checked before (going back, or after a reload) shows it folded.
  function showQuestion(moveFocus, checked = false) {
    st.onGrid = false;
    page.classList.remove('on-grid');
    const q = st.questions[st.index];
    const revealed = showsAnswers && !!st.revealed[q.id];
    counter.textContent = `Question: ${st.index + 1} of ${st.questions.length}`;
    if (againTag) againTag.hidden = !(st.again ?? []).includes(q.id);
    paintChip(`Question ${st.index + 1} of ${st.questions.length}`);
    document.title = `${st.title} · Question ${st.index + 1}`;
    prevBtn.hidden = st.index === 0;
    paintFlag();
    saver?.show(q.src?.set ?? st.setId, q.src?.title ?? st.title, q.src?.id ?? q.id); // src: from a search (SPEC 11.14)
    mSave?.setAttribute('aria-pressed', saver.el.getAttribute('aria-pressed'));
    const feedback = revealed ? rationaleSheet(feedbackPanel(q, st.responses[q.id], { report: q.src?.set ?? st.setId })) : null;
    area.show(q, [
      ...questionParts(q, {
        response: st.responses[q.id],
        layout: st.layout[q.id],
        review: revealed,
        onChange: r => {
          st.responses[q.id] = r;
          save();
          paintProgress();
          paintContinue();
        },
        crossed: st.crossed[q.id],
        onCross: list => {
          if (list.length) st.crossed[q.id] = list;
          else delete st.crossed[q.id];
          save();
        },
      }),
      feedback,
      actions,
    ]);
    sheet = feedback;
    page.classList.toggle('has-sheet', !!feedback);
    sheetSizer.disconnect();
    if (feedback) {
      placeSheet(checked);
      sheetSizer.observe(feedback.querySelector('.sheet-head'));
    } else setSheet(false);
    paintProgress();
    paintContinue();
    if (moveFocus) {
      window.scrollTo(0, 0);
      counter.focus({ preventScroll: true });
    }
  }

  // --- phones (SPEC 11.8) ---
  function paintChip(text) {
    chip.replaceChildren(text, h('span.m-chip-arrow', { 'aria-hidden': 'true' }, '▾'));
    chip.setAttribute('aria-label', `${text}: show all questions`);
  }

  function paintProgress() {
    const answered = st.questions.filter(q => isAnswered(q, st.responses[q.id])).length;
    progress.style.width = `${(100 * answered) / st.questions.length}%`;
  }

  // What Continue will do, for its label on phones.
  function paintContinue() {
    const q = st.questions[st.index];
    const last = st.index === st.questions.length - 1;
    const label = showsAnswers && !st.revealed[q.id] && (isAnswered(q, st.responses[q.id]) || !st.flags[q.id]) ? 'Check answer'
      : canGoBack && (st.reachedGrid || last) ? 'Review answers'
      : last ? 'Submit exam' : 'Next question';
    continueText.textContent = label;
    continueBtn.classList.toggle('is-next', label === 'Next question');
  }

  // The answer and rationale on phones: a sheet pinned above the big button.
  // After Check answer it slides up from behind the button: all the way when
  // the answer was wrong or partly right, so the rationale comes when it
  // matters most, and only its top line when it was right (the grip, the
  // result, and "Rationale ▴"), so the question shows with its marks and the
  // rationale waits for a pull up or a tap on that line (the owner's idea,
  // 2026-11-15; misses open it, our suggestion, which the owner OK'd on
  // 2026-11-16; OPEN_ON_CHECK 'always' or 'never' does one or the other). The sheet follows the finger both ways: from anywhere on its top line, and
  // on the open rationale from anywhere while it's scrolled to its top (one
  // scrolled down scrolls back up first). Let go a quarter of the way, or with
  // a flick, and it finishes the move; otherwise it slides back. A tap on the
  // folded sheet opens it; a tap on the grip or the dimmed question folds it.
  // Only transform and opacity change as it moves, so phones draw it smoothly.
  const OPEN_ON_CHECK = 'missed';
  let sheet = null;
  function rationaleSheet(feedback) {
    const grip = h('button.sheet-grip', {
      type: 'button', 'aria-label': 'Rationale', 'aria-expanded': 'false',
      onclick: () => (feedback.classList.contains('is-folded') ? setSheet(true) : foldSheet()),
    }, h('span', { 'aria-hidden': 'true' }));
    // The top line stays put; the rest scrolls under it.
    const result = feedback.querySelector(':scope > .feedback-result');
    const head = h('div.sheet-head', grip, h('div.sheet-line', result, h('span.sheet-hint', { 'aria-hidden': 'true' }, 'Rationale ▴')));
    const body = h('div.sheet-body', [...feedback.childNodes].filter(n => n !== result));
    feedback.replaceChildren(head, body);
    feedback.classList.add('is-folded'); // drawn folded first, so nothing slides until asked
    feedback.addEventListener('click', e => {
      if (feedback.classList.contains('is-folded') && !e.target.closest('button, a')) setSheet(true);
    });
    dragSheet(feedback, head, body);
    return feedback;
  }

  // Folded, the sheet slides down by its height less its top line's (CSS
  // --peek, which also keeps the end of the question above that line).
  function measureSheet(el) {
    const head = el?.querySelector('.sheet-head');
    if (head) page.style.setProperty('--peek', `${head.getBoundingClientRect().height}px`);
  }
  const sheetSizer = new ResizeObserver(() => measureSheet(sheet));

  // Opens or folds the sheet; CSS slides it there from wherever it is. ms: how
  // long the slide takes (after a flick, quicker), or the CSS's own time.
  function setSheet(open, ms = 0) {
    page.classList.toggle('sheet-open', !!sheet && open);
    page.classList.remove('sheet-moving');
    sheetShade.style.opacity = '';
    if (!sheet) return;
    const el = sheet;
    el.style.transitionDuration = sheetShade.style.transitionDuration = ms ? `${ms}ms` : '';
    if (ms) setTimeout(() => { if (el.style.transitionDuration === `${ms}ms`) el.style.transitionDuration = sheetShade.style.transitionDuration = ''; }, ms + 60);
    el.classList.remove('is-dragging');
    el.classList.toggle('is-folded', !open);
    el.style.transform = '';
    el.querySelector('.sheet-grip')?.setAttribute('aria-expanded', String(open));
  }

  const sheetIsOpen = () => !!sheet && page.classList.contains('sheet-open') && !sheet.classList.contains('is-folded');
  const foldSheet = () => { if (sheetIsOpen()) setSheet(false); };
  const smooth = () => phone.matches && !matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A new sheet starts folded where it belongs; one for a question just
  // checked slides up from behind the big button instead, to its top line or
  // all the way (OPEN_ON_CHECK).
  function placeSheet(checked) {
    const el = sheet;
    const open = checked && (OPEN_ON_CHECK === 'always' || (OPEN_ON_CHECK === 'missed' && !el.classList.contains('is-correct')));
    el.style.transition = 'none';
    measureSheet(el);
    setSheet(open);
    if (checked && smooth()) el.style.transform = 'translateY(100%)';
    el.getBoundingClientRect(); // drawn there first, without sliding
    el.style.transition = el.style.transform = '';
  }

  // A finger moving the sheet. On its top line, and anywhere on the folded
  // sheet, the browser never scrolls (touch-action: none), so the sheet takes
  // every move. On the open rationale, the first move decides: down, with the
  // rationale at its top, moves the sheet (the browser can't start a scroll
  // the page can no longer stop); anything else scrolls the rationale.
  function dragSheet(el, head, body) {
    let g = null;
    el.addEventListener('touchstart', e => {
      g = null;
      if (el !== sheet || !phone.matches || e.touches.length !== 1) return;
      const onHead = el.classList.contains('is-folded') || head.contains(e.target);
      if (!onHead && body.scrollTop > 0) return;
      const t = e.touches[0];
      g = { id: t.identifier, x0: t.clientX, y0: t.clientY, onHead, live: false, wasOpen: page.classList.contains('sheet-open'),
        track: [[e.timeStamp, t.clientY]] };
    }, { passive: true });
    el.addEventListener('touchmove', e => {
      const t = g && [...e.touches].find(f => f.identifier === g.id);
      if (!t) return;
      const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
      if (!g.live) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // still a tap
        if (g.onHead ? Math.abs(dx) > 2 * Math.abs(dy) : dy <= 0 || Math.abs(dx) > dy) {
          g = null; // a sideways swipe, or scrolling the rationale
          return;
        }
        g.travel = Math.max(1, el.getBoundingClientRect().height - head.getBoundingClientRect().height);
        g.from = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42; // where it is, even mid-slide
        g.live = true;
        el.classList.add('is-dragging');
        el.classList.remove('is-folded'); // the rationale shows as it comes up
        page.classList.add('sheet-moving');
      }
      e.preventDefault();
      g.y = Math.min(g.travel, Math.max(0, g.from + dy));
      el.style.transform = `translateY(${g.y}px)`;
      sheetShade.style.opacity = String(1 - g.y / g.travel);
      g.track.push([e.timeStamp, t.clientY]);
      while (g.track.length > 2 && e.timeStamp - g.track[0][0] > 100) g.track.shift();
    }, { passive: false });
    const end = e => {
      if (!g || ![...e.changedTouches].some(f => f.identifier === g.id)) return;
      const d = g;
      g = null;
      if (!d.live) return;
      if (e.cancelable) e.preventDefault(); // no tap after a drag
      // The finger's speed over its last tenth of a second (px/ms; down is +).
      const [t0, y0] = d.track[0], [t1, y1] = d.track.at(-1);
      const v = e.type === 'touchend' && t1 > t0 && e.timeStamp - t1 < 80 ? (y1 - y0) / (t1 - t0) : 0;
      const moved = d.y - d.from; // how far the sheet came (down is +); a flick needs a little of it too
      const open = d.wasOpen
        ? !((v > 0.3 && moved > 20) || (moved > Math.min(96, d.travel / 4) && v > -0.1))
        : (v < -0.3 && moved < -12) || (-moved > Math.min(48, d.travel / 4) && v < 0.1);
      const left = Math.abs((open ? 0 : d.travel) - d.y);
      setSheet(open, Math.round(Math.min(320, Math.max(160, (2 * left) / Math.max(1, Math.abs(v))))));
      if (open && e.type === 'touchend') onTapGuard(e); // Back folds it again (the drag counts as a tap)
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  // The question chip: every question in a grid (answered, flagged, still to
  // do, and this one). With going back allowed, a tile goes to its question.
  // Finish and see results submits once every question is answered, and
  // otherwise finishes early (SPEC 4.4).
  async function showNavigator() {
    const done = q => isAnswered(q, st.responses[q.id]);
    const answered = st.questions.filter(done).length;
    const flagged = st.questions.filter(q => st.flags[q.id]).length;
    const here = st.onGrid ? -1 : st.index;
    let box = null, focus = null;
    const tiles = st.questions.map((q, i) => {
      const kind = `${done(q) ? 'answered' : 'unanswered'}${st.flags[q.id] ? ' flagged' : ''}${i === here ? ' current' : ''}`;
      const status = `${done(q) ? 'answered' : 'not answered'}${st.flags[q.id] ? ', flagged' : ''}${i === here ? ', this question' : ''}`;
      const kids = [String(i + 1), st.flags[q.id] ? icon('flag') : null];
      if (!canGoBack) return h('li', h('span.qtile', { class: kind }, kids, h('span.sr-only', `: ${status}`)));
      const tile = h('button.qtile', { type: 'button', class: kind, 'aria-label': `Question ${i + 1}: ${status}`, onclick: () => box.close(i) }, kids);
      if (i === here) focus = tile;
      return h('li', tile);
    });
    box = modal({
      sheet: true,
      title: 'All questions',
      message: [
        h('p.nav-counts', [`${answered} answered`, canGoBack ? `${flagged} flagged` : null, `${st.questions.length - answered} to go`].filter(Boolean).join(' · ')),
        canGoBack ? null : h('p.nav-note', "Going back is off in this exam, so the list only shows how far you've come."),
        h('ol.qgrid.nav-grid', tiles),
      ],
      buttons: [{ label: 'Back to question', value: 'back' }, ...(answered ? [{ label: 'Finish and see results', value: 'finish', accent: true }] : [])],
      focus,
    });
    focus?.scrollIntoView({ block: 'nearest' });
    const choice = await box;
    if (finished) return;
    if (Number.isInteger(choice)) goTo(choice);
    else if (choice === 'finish') finishNow();
  }

  async function finishNow() {
    const left = st.questions.filter(q => !isAnswered(q, st.responses[q.id])).length;
    if (!left) return confirmSubmit();
    const answered = st.questions.length - left;
    const choice = await modal({
      title: 'Finish Now?',
      message: `You've answered ${answered} of ${st.questions.length} questions. Your results will score just ${answered === 1 ? 'that one' : `those ${answered}`}, `
        + `and the ${left === 1 ? 'one' : left} you haven't answered will come first next time.`,
      buttons: [{ label: 'Finish and see results', value: 'finish', accent: true }, { label: 'Keep going', value: 'stay' }],
    });
    if (choice === 'finish') finish('early');
  }

  function goTo(i) {
    st.index = i;
    save();
    showQuestion(true);
  }

  function onContinue() {
    const q = st.questions[st.index];
    const answered = isAnswered(q, st.responses[q.id]);
    // A flagged question can be left unanswered, or partly answered, and
    // finished later (SPEC 4.3).
    if (!answered && !st.flags[q.id]) {
      const later = canGoBack ? ' To answer it later, flag it and select Continue.' : '';
      modal({ title: 'Question Unanswered', message: unansweredMessage(q) + later });
      return;
    }
    if (answered && showsAnswers && !st.revealed[q.id]) {
      // Practice mode: show the answer and rationale before moving on. (A
      // flagged question that isn't answered yet moves on without them.)
      st.revealed[q.id] = true;
      save();
      showQuestion(false, true);
      const feedback = question.querySelector('.feedback');
      if (!phone.matches) feedback?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      feedback?.focus({ preventScroll: true });
      return;
    }
    // After the review grid has been shown, Continue goes back to it (SPEC 4.3).
    if (canGoBack && (st.reachedGrid || st.index === st.questions.length - 1)) showGrid(true);
    else if (st.index < st.questions.length - 1) goTo(st.index + 1);
    else confirmSubmit();
  }

  function paintFlag() {
    const flagged = !!st.flags[st.questions[st.index].id];
    flagBtn.setAttribute('aria-pressed', String(flagged));
    mFlag?.setAttribute('aria-pressed', String(flagged));
    flagLabel.textContent = flagged ? 'Flagged' : 'Flag';
  }

  function toggleFlag() {
    const id = st.questions[st.index].id;
    if (st.flags[id]) delete st.flags[id];
    else st.flags[id] = true;
    save();
    paintFlag();
    paintContinue();
  }

  // With going back allowed, a grid of every question comes before submitting.
  function showGrid(moveFocus) {
    st.onGrid = true;
    page.classList.add('on-grid'); // phones: no Flag or Save on the bar here
    st.reachedGrid = true;
    save();
    counter.textContent = 'Review Your Answers';
    paintChip('Review your answers');
    sheet = null;
    setSheet(false);
    sheetSizer.disconnect();
    page.classList.remove('has-sheet');
    paintProgress();
    document.title = `${st.title} · Review your answers`;
    const done = q => isAnswered(q, st.responses[q.id]);
    const answeredCount = st.questions.filter(done).length;
    const flaggedCount = st.questions.filter(q => st.flags[q.id]).length;
    area.clear(
      h('p.grid-intro',
        `You answered ${answeredCount} of ${st.questions.length} questions${flaggedCount ? ` and flagged ${flaggedCount}` : ''}. `,
        'Select a question to go back to it, or submit your exam. Continue brings you back here.'),
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

  // Stay, Leave exam (saved for later), or, once a question is answered,
  // Finish and see results for the questions answered so far. On phones it
  // slides up from the bottom, with big buttons near the thumb.
  async function confirmLeave() {
    if (document.querySelector('.modal.leave-question')) return; // already asking
    const answered = st.questions.filter(q => isAnswered(q, st.responses[q.id])).length;
    const choice = await modal({
      sheet: phone.matches,
      kind: 'leave-question',
      title: 'Leave this exam?',
      message: `Your progress is saved and you can resume from the homepage.${timed ? ' The timer keeps running while you are away.' : ''}`
        + (answered ? ` Or finish now and see your results for the ${answered === 1 ? 'question' : `${answered} questions`} you've answered.` : ''),
      buttons: [{ label: 'Stay', value: 'stay', accent: true }, { label: 'Leave exam', value: 'leave' },
        ...(answered ? [{ label: 'Finish and see results', value: 'finish' }] : [])],
    });
    if (finished) return;
    if (choice === 'finish') {
      finish('early');
      return;
    }
    if (choice !== 'leave') return;
    leaving = true;
    leaveFullscreen();
    location.hash = '#/';
  }

  function finish(reason) {
    if (finished) return;
    track('exam-finish', {
      set: st.setId, class: st.course ?? undefined, mode: s.preset, questions: st.questions.length,
      ended: reason === 'time' ? 'time-up' : reason === 'early' ? 'finished-early' : 'submitted',
      flagged: Object.keys(st.flags).length ? 'yes' : 'no', 'crossed-out': Object.keys(st.crossed ?? {}).length ? 'yes' : 'no',
    });
    // A question practiced from a search (SPEC 11.14) is a first try only if its own set hasn't shown it before.
    const seen = seenBefore(st.setId);
    for (const q of st.questions) if (q.src && seenBefore(q.src.set).has(q.src.id)) seen.add(q.id);
    const result = grade(st, reason, seen);
    saveResult(result);
    recordStats(result); // the anonymous question stats (SPEC 11.9)
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
    once('pause');
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
      once('fullscreen-off');
    }
  }

  function onFullscreenChange() {
    fsNotice.hidden = !document.fullscreenElement;
    if (document.fullscreenElement) fsBox?.close(undefined);
    else if (wantsFullscreen()) askFullscreen('Full Screen Mode Ended');
  }

  // Clicking or tapping anywhere outside the answer just picked lets go of its
  // focus (and of the keyboard outline, if it had one); the choice stays
  // selected. Phones can keep focus after a tap on empty space, so let go of
  // it here.
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

  // The back button (a phone's, or the browser's; the owner's request,
  // 2026-11-15): it closes an open alert or list, folds an open rationale, and
  // otherwise asks before leaving (Stay, Leave exam, Finish and see results),
  // instead of going straight back to the start page. History entries with
  // this page's address catch it: one for the exam, added at the first tap,
  // and one while an alert or the rationale is open. They're added only right
  // after a tap, since Chrome's back button skips entries a page adds without one.
  const examAddress = location.hash;
  const guarding = () => !finished && !leaving && location.hash === examAddress;
  const onTapGuard = e => {
    if (!e.isTrusted || !guarding()) return;
    if (!history.state?.peGuard) history.pushState({ peGuard: 'exam' }, '');
    const layer = document.querySelector('.modal-backdrop') ? 'modal' : sheetIsOpen() ? 'sheet' : null;
    if (layer && history.state?.peGuard !== layer) history.pushState({ peGuard: layer }, '');
  };
  // An alert closes the way its Close button does; one without it (Exam
  // Paused, the full screen alert) stays until its own button is used.
  let restoring = false; // putting the exam's address back after a Back that went past those entries
  const onBack = () => {
    const top = [...document.querySelectorAll('.modal-backdrop')].at(-1);
    if (top) top.querySelector('.modal-head .close-btn')?.click();
    else if (sheetIsOpen()) foldSheet();
    else confirmLeave();
  };
  // After a Back, the entry is put back (browsers other than Chrome keep it;
  // Chrome's back button skips it, and the router check below takes over).
  const onPopState = () => {
    if (restoring || !guarding()) return;
    onBack();
    if (!history.state?.peGuard && guarding()) history.pushState({ peGuard: 'exam' }, '');
  };
  // When Back goes past those entries (Chrome skips some, or none were added
  // yet), the page router asks first: the exam stays, its address goes back in
  // place of the page before it (no new entry), and Back does what it does above.
  // Only a step back counts (Chrome's navigation.currentEntry tells), so typing
  // another address or following a link still leaves, as before.
  let examIndex = window.navigation?.currentEntry?.index ?? null;
  const keeper = address => {
    if (finished || leaving) return false;
    if (address === examAddress) {
      const was = restoring;
      restoring = false;
      return was;
    }
    const index = window.navigation?.currentEntry?.index;
    if (examIndex === null || !Number.isInteger(index) || index >= examIndex) return false;
    restoring = true;
    location.replace(examAddress);
    examIndex = window.navigation.currentEntry?.index ?? index;
    onBack();
    return true;
  };

  // --- start up ---
  if (st.onGrid && canGoBack) showGrid(false);
  else showQuestion(false);
  pauseBtn.disabled = st.pauseLeftMs <= 0;
  fsNotice.hidden = !document.fullscreenElement;
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', tick);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('click', onTapGuard);
  addEventListener('popstate', onPopState);
  setKeeper(keeper);
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
    document.removeEventListener('click', onTapGuard);
    removeEventListener('popstate', onPopState);
    sheetSizer.disconnect();
    setKeeper(null);
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
  track('review-open', { set: r.setId, which: onlyMissed ? 'incorrect' : 'all' });
  const list = r.questions.filter(q => !onlyMissed || missed.has(q.id));
  const scores = new Map((r.items ?? []).map(i => [i.id, i]));
  let index = 0;
  const tabs = new Map();

  const counter = h('h1.q-counter', { tabindex: '-1' });
  const tag = h('span.mode-tag');
  const question = h('section.question');
  const prevBtn = h('button.btn.btn-nav', { type: 'button', onclick: () => go(index - 1) }, 'Previous');
  const nextWide = h('span.c-wide'), nextPhone = h('span.c-phone');
  const nextBtn = h('button.btn-continue', {
    type: 'button',
    onclick: () => {
      if (index < list.length - 1) go(index + 1);
      else location.hash = '#/results';
    },
  }, nextWide, nextPhone);
  const saver = saveButton(); // SPEC 11.7
  const actions = h('div.exam-actions', h('div.nav-left', prevBtn, saver.el), nextBtn);
  const area = questionArea(question, r.cases ?? {}, { get: key => tabs.get(key) ?? 0, set: (key, i) => tabs.set(key, i) });

  // Phones (SPEC 11.8; the owner's choice, 2026-11-16): the exam's bar at the
  // top, with Close (back to the results), a chip that lists the questions, and
  // Save; one big button at the bottom; and a swipe to the next or previous one.
  const chip = h('button.m-chip', { type: 'button', 'aria-haspopup': 'dialog', onclick: () => showList() });
  const mSave = h('button.m-icon.m-save', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Save', title: 'Save', onclick: () => saver.el.click() }, icon('bookmark'));
  saver.el.addEventListener('click', () => mSave.setAttribute('aria-pressed', saver.el.getAttribute('aria-pressed')));
  const progress = h('span');
  const main = h('main.wrap',
    h('div.info-row',
      h('div.counter-wrap', counter, tag),
      h('div.info-tools', h('a.btn', { href: '#/results' }, 'Back to results'))),
    question);

  root.replaceChildren(h('div.page.exam.review', { 'data-text-size': r.settings?.textSize ?? 'standard' },
    siteHeader({ title: r.title, onClose: () => (location.hash = '#/results'), link: false }),
    h('div.m-top',
      h('div.m-top-row',
        h('button.m-close', { type: 'button', 'aria-label': 'Back to results', title: 'Back to results', onclick: () => (location.hash = '#/results') }, icon('x')),
        chip, mSave),
      h('div.m-progress', { 'aria-hidden': 'true' }, progress)),
    main,
    siteFooter()));
  // A swipe sideways goes to the next or previous question; not one that
  // starts on something that scrolls sideways itself, or a form field.
  onSwipe(main, (way, e) => {
    if (!phone.matches || e.target.closest('.table-scroll, .tabpanel, .matrix-wrap, input, select, textarea')) return;
    if (way === 'left' && index < list.length - 1) go(index + 1);
    else if (way === 'right' && index > 0) go(index - 1);
  });

  function paintChip(text) {
    chip.replaceChildren(text, h('span.m-chip-arrow', { 'aria-hidden': 'true' }, '▾'));
    chip.setAttribute('aria-label', `${text}: show the questions`);
  }

  // The questions under review in a grid, each marked right, partly right, or
  // wrong; a tile goes to its question.
  async function showList() {
    let box = null, focus = null;
    const mark = { right: '✓', partial: '◐', wrong: '✗', none: '–' };
    const said = { right: 'right', partial: 'partly right', wrong: 'wrong', none: 'not answered' };
    const tiles = list.map((q, i) => {
      const s = scores.get(q.id);
      const kind = !s || !s.max ? 'none' : s.earned === s.max ? 'right' : s.earned > 0 ? 'partial' : 'wrong';
      const n = r.questions.indexOf(q) + 1;
      const tile = h('button.qtile', {
        type: 'button', class: `rv-${kind}${i === index ? ' current' : ''}`,
        'aria-label': `Question ${n}: ${said[kind]}${i === index ? ', this question' : ''}`, onclick: () => box.close(i),
      }, String(n), h('span.qtile-mark', { 'aria-hidden': 'true' }, mark[kind]));
      if (i === index) focus = tile;
      return h('li', tile);
    });
    box = modal({
      sheet: true,
      title: onlyMissed ? 'Questions you missed' : 'All questions',
      message: [h('ol.qgrid.nav-grid', tiles)],
      buttons: [{ label: 'Back to question', value: 'back' }],
      focus,
    });
    focus?.scrollIntoView({ block: 'nearest' });
    const choice = await box;
    if (Number.isInteger(choice)) go(choice);
  }

  if (!list.length) {
    counter.textContent = 'Nothing to review';
    paintChip('Nothing to review');
    mSave.hidden = true;
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
    const last = index === list.length - 1;
    nextWide.textContent = last ? 'Finish' : 'Next';
    nextPhone.textContent = last ? 'Back to results' : 'Next question';
    nextBtn.classList.toggle('is-next', !last);
    paintChip(onlyMissed ? `Missed ${index + 1} of ${list.length}` : `Question ${r.questions.indexOf(q) + 1} of ${r.questions.length}`);
    progress.style.width = `${(100 * (index + 1)) / list.length}%`;
    saver.show(q.src?.set ?? r.setId, q.src?.title ?? r.title, q.src?.id ?? q.id);
    mSave.setAttribute('aria-pressed', saver.el.getAttribute('aria-pressed'));
    area.show(q, [
      ...questionParts(q, { response: r.responses[q.id], layout: r.layout?.[q.id], review: true }),
      feedbackPanel(q, r.responses[q.id], { report: q.src?.set ?? r.setId }),
      actions,
    ]);
    if (moveFocus) {
      window.scrollTo(0, 0);
      counter.focus({ preventScroll: true });
    }
  }

  show(false);
}
