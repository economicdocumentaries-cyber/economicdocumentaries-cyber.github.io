// Saved questions (SPEC 11.7): each student's own list, kept on this browser
// like the score history, with no sign-in. Students save a question with the
// Save button in practice mode and in review mode; the Saved questions page
// (#/saved, in app.js) lists them.
// pe.saved = { setId: { title, questions: { questionId: when it was saved } } }.
// The title is the set's when a question was last saved, for a set that's
// later taken off the site.
import { h, store, icon, toast } from './util.js';

const SAVED = 'pe.saved';

// The list, leaving out anything malformed.
export const savedSets = () => {
  const all = store.get(SAVED, {});
  if (!all || typeof all !== 'object' || Array.isArray(all)) return {};
  return Object.fromEntries(Object.entries(all).filter(([, s]) => s?.questions && typeof s.questions === 'object'));
};

export const isSaved = (setId, qid) => !!savedSets()[setId]?.questions?.[qid];

export const savedCount = () => Object.values(savedSets()).reduce((n, s) => n + Object.keys(s?.questions ?? {}).length, 0);

// Saves or removes one question. False when the browser won't store anything.
export function setSaved(setId, title, qid, on) {
  const all = savedSets();
  const entry = { title: all[setId]?.title ?? title, questions: { ...all[setId]?.questions } };
  if (on) {
    entry.title = title || entry.title;
    entry.questions[qid] = Date.now();
  } else delete entry.questions[qid];
  if (Object.keys(entry.questions).length) all[setId] = entry;
  else delete all[setId];
  return store.set(SAVED, all);
}

// Removes every saved question of a set (one that's no longer on the site).
export function forgetSet(setId) {
  const all = savedSets();
  delete all[setId];
  return store.set(SAVED, all);
}

// The Save button: one per screen, next to Flag in practice mode, and in
// review mode. show() points it at the question on the screen.
export function saveButton() {
  const label = h('span', 'Save');
  const el = h('button.btn.btn-save', { type: 'button', 'aria-pressed': 'false', onclick: () => toggle() }, icon('bookmark'), label);
  let at = null; // { setId, title, id }

  function paint() {
    const on = isSaved(at.setId, at.id);
    el.setAttribute('aria-pressed', String(on));
    label.textContent = on ? 'Saved' : 'Save';
  }

  function toggle() {
    const first = !savedCount();
    const on = !isSaved(at.setId, at.id);
    if (!setSaved(at.setId, at.title, at.id, on)) toast('This browser isn\'t letting the site save anything, so the question can\'t be saved.');
    else if (on && first) toast('Saved. Your saved questions are listed on the homepage.');
    paint();
  }

  return {
    el,
    show(setId, title, id) {
      at = { setId, title, id };
      paint();
    },
  };
}
