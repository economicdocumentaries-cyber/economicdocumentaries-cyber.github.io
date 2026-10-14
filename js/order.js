// The order students see each class's practice exams and study guides in
// (SPEC 11.4): newest first, unless the host has moved them on the host
// console. Anything added after that comes first, newest first. The host's
// order is kept in Firebase at /order/<class code, or "other"> as
// { sets, guides }: JSON text lists of set ids and guide keys. The last order
// seen is kept in this browser too, so the homepage doesn't wait for Firebase.
import { h, store } from './util.js';
import { groupStudyOn, connectStudent } from './firebase.js';

const CACHE = 'pe.order';

// A study guide's key in the order: its file for a published guide, its id for an uploaded one.
export const guideKey = g => (g.uploaded ? `up:${g.id}` : `file:${g.file}`);

// Newest first: sets made on the console by when they were made, before the
// sets from files (whose list, sets/index.json, starts with the newest).
export const newestSet = (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
// Guides by the day they were uploaded or last updated; guides without a date last.
const dated = g => (g.uploaded ? g.added ?? 0 : g.updated ? new Date(`${g.updated}T12:00:00`).getTime() : 0);
export const newestGuide = (a, b) => dated(b) - dated(a);

// The items in the host's order, with any that aren't in it first, newest first.
export function arrange(items, keyOf, saved, newest) {
  const place = new Map((saved ?? []).map((key, i) => [key, i]));
  const added = items.filter(x => !place.has(keyOf(x))).sort(newest);
  const placed = items.filter(x => place.has(keyOf(x))).sort((a, b) => place.get(keyOf(a)) - place.get(keyOf(b)));
  return [...added, ...placed];
}

function list(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) && value.every(x => typeof x === 'string') ? value : null;
  } catch {
    return null;
  }
}

// /order as Firebase has it: { key: { sets, guides } }, with anything malformed left out.
export function readOrder(value) {
  if (!value || typeof value !== 'object') return {};
  const all = {};
  for (const [key, o] of Object.entries(value)) {
    const sets = list(o?.sets);
    const guides = list(o?.guides);
    if (sets || guides) all[key] = { ...(sets ? { sets } : {}), ...(guides ? { guides } : {}) };
  }
  return all;
}

export const cachedOrder = () => (groupStudyOn() ? readOrder(store.get(CACHE)) : {});
export const keepOrder = order => store.set(CACHE, order);

// Calls onChange with the order now and after every change; problems are
// ignored (the lists are then newest first). Returns a function that stops it.
export function watchOrder(onChange) {
  let stop = () => {};
  let stopped = false;
  if (groupStudyOn()) {
    connectStudent().then(db => {
      if (stopped) return;
      stop = db.watch('order', value => {
        const order = readOrder(value);
        keepOrder(order);
        onChange(order);
      }, () => {});
      if (stopped) stop();
    }, () => {});
  }
  return () => {
    stopped = true;
    stop();
  };
}

// ---------- moving things on the host console ----------

// A grip to drag and ▲ ▼ buttons for row i of n, named for screen readers.
// move(to) moves the row to position `to`.
export function orderTools(name, i, n, move) {
  return h('div.order-tools',
    h('span.order-grip', { draggable: 'true', title: 'Drag to move', 'aria-hidden': 'true' }, '⠿'),
    h('button.order-ctl', { type: 'button', 'aria-label': `Move ${name} up`, disabled: i === 0, onclick: () => move(i - 1) }, '▲'),
    h('button.order-ctl', { type: 'button', 'aria-label': `Move ${name} down`, disabled: i === n - 1, onclick: () => move(i + 1) }, '▼'));
}

// Drag and drop in a list whose rows have data-key and an .order-grip.
// onDrop(keys) gets the keys in their new order.
export function dragSort(listEl, onDrop) {
  let dragged = null;
  const clear = () => listEl.querySelectorAll('.drop-before, .drop-after').forEach(li => li.classList.remove('drop-before', 'drop-after'));
  const spot = e => {
    const li = e.target.closest?.('li[data-key]');
    if (!li || li === dragged || li.parentNode !== listEl) return null;
    const box = li.getBoundingClientRect();
    return { li, before: e.clientY < box.top + box.height / 2 };
  };
  listEl.addEventListener('dragstart', e => {
    if (!e.target.closest?.('.order-grip')) return;
    dragged = e.target.closest('li[data-key]');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged.dataset.key);
    e.dataTransfer.setDragImage(dragged, 24, 24);
    dragged.classList.add('dragging');
  });
  listEl.addEventListener('dragover', e => {
    if (!dragged) return;
    e.preventDefault();
    clear();
    const at = spot(e);
    if (at) at.li.classList.add(at.before ? 'drop-before' : 'drop-after');
  });
  listEl.addEventListener('drop', e => {
    if (!dragged) return;
    e.preventDefault();
    const at = spot(e);
    clear();
    if (!at) return;
    at.li[at.before ? 'before' : 'after'](dragged);
    onDrop([...listEl.children].map(li => li.dataset.key).filter(Boolean));
  });
  listEl.addEventListener('dragend', () => {
    dragged?.classList.remove('dragging');
    dragged = null;
    clear();
  });
}

// Keys in a new order: the one at `from` moved to `to`.
export function moved(keys, from, to) {
  const next = keys.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}
