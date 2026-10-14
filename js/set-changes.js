// The host's changes to the question sets (SPEC 11.3), made on the host
// console's Question sets page (js/set-editor.js) and kept in Firebase at
// /setInfo/<set id>. Each one holds only what differs from the set's file, so
// later changes to the file still show where the host changed nothing: title,
// description, course ("" for no class), exam, defaultCount (0 for every
// question), hidden, and, once the host has published question changes,
// questions and cases (JSON text) that replace the file's. A set made on the
// console has created: true and no file. Students' pages put the changes on
// top of the files. The last ones seen are kept in this browser too, so pages
// don't wait for Firebase.
import { store } from './util.js';
import { groupStudyOn, connectStudent } from './firebase.js';
import { validateSet } from './items.js';

const CACHE = 'pe.setInfo';
export const LIMITS = { title: 120, description: 600, course: 20, exam: 60 }; // the same as database.rules.json

const isText = v => typeof v === 'string' && v.trim() !== '';

// JSON text from the database, read back; null when it isn't the expected kind.
function parsed(text, check) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return check(value) ? value : null;
  } catch {
    return null;
  }
}
const isList = v => Array.isArray(v);
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

// /setInfo as Firebase has it, with anything malformed left out.
export function readChanges(value) {
  if (!isObject(value)) return {};
  const all = {};
  for (const [id, c] of Object.entries(value)) {
    if (!isObject(c)) continue;
    const clean = {};
    for (const key of ['title', 'description', 'course', 'exam']) {
      if (typeof c[key] === 'string' && c[key].length <= LIMITS[key] && (key !== 'title' || isText(c[key]))) clean[key] = c[key].trim();
    }
    if (Number.isInteger(c.defaultCount) && c.defaultCount >= 0) clean.defaultCount = c.defaultCount;
    if (typeof c.hidden === 'boolean') clean.hidden = c.hidden;
    if (c.created === true) clean.created = true;
    const questions = parsed(c.questions, isList);
    if (questions) {
      clean.questions = questions;
      clean.cases = parsed(c.cases, isObject) ?? {};
    }
    if (Object.keys(clean).length) all[id] = clean;
  }
  return all;
}

// /setDrafts as Firebase has it (only the host can read it): { id: { questions, cases } }.
export function readDrafts(value) {
  if (!isObject(value)) return {};
  const all = {};
  for (const [id, d] of Object.entries(value)) {
    const questions = parsed(d?.questions, isList);
    if (questions) all[id] = { questions, cases: parsed(d.cases, isObject) ?? {} };
  }
  return all;
}

// The sets with the host's changes, and the sets made on the console. A class
// that's no longer in the class list is ignored, a set in a class keeps an
// exam, and questions with a mistake are ignored (the file's stay). Hidden
// questions are left out, and so are sets with none left, unless keepHidden
// (the host console). A set's `edited` is true when its questions come from
// the console.
export function withChanges(sets, changes, courses = [], { keepHidden = false } = {}) {
  const files = new Set(sets.map(s => s.id));
  const made = Object.entries(changes ?? {})
    .filter(([id, c]) => !files.has(id) && c.created && c.title)
    .map(([id]) => ({ id, title: '', questions: [], made: true }));
  const out = [];
  for (const base of [...sets, ...made]) {
    let set = base;
    const c = changes?.[base.id];
    if (c) {
      set = { ...base };
      if (c.title) set.title = c.title;
      if ('description' in c) set.description = c.description || null;
      if (c.course === '') set.course = null;
      else if (c.course) set.course = courses.find(x => x.code.toLowerCase() === c.course.toLowerCase())?.code ?? set.course;
      if ('exam' in c && (c.exam || !set.course)) set.exam = c.exam || null;
      if ('defaultCount' in c) set.defaultCount = c.defaultCount || null;
      if ('hidden' in c) set.hidden = c.hidden;
      if (c.questions) {
        const edited = { ...set, questions: c.questions, cases: c.cases };
        if (!validateSet(edited).length) set = { ...edited, edited: true };
      }
    }
    if (!keepHidden) {
      const shown = set.questions.filter(q => !q.hidden);
      if (!shown.length) continue;
      if (shown.length < set.questions.length) set = { ...set, questions: shown };
    }
    out.push(set);
  }
  return out;
}

// The changes last seen on this browser.
export const cachedChanges = () => (groupStudyOn() ? readChanges(store.get(CACHE)) : {});

// Keeps the changes for next time (the host console's pages call this too).
export const keepChanges = changes => store.set(CACHE, changes);

// Calls onChange with the changes now and after every change. Problems are
// ignored: without the changes, the sets look the way their files say.
// Returns a function that stops it.
export function watchChanges(onChange) {
  let stop = () => {};
  let stopped = false;
  if (groupStudyOn()) {
    connectStudent().then(db => {
      if (stopped) return;
      stop = db.watch('setInfo', value => {
        const changes = readChanges(value);
        keepChanges(changes);
        onChange(changes);
      }, () => {});
      if (stopped) stop();
    }, () => {});
  }
  return () => {
    stopped = true;
    stop();
  };
}

// The changes from Firebase, or the ones last seen on this browser if Firebase
// doesn't answer within `wait` milliseconds.
export function currentChanges(wait = 2500) {
  if (!groupStudyOn()) return Promise.resolve({});
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      stop();
      resolve(cachedChanges());
    }, wait);
    const stop = watchChanges(changes => {
      clearTimeout(timer);
      setTimeout(() => stop());
      resolve(changes);
    });
  });
}
