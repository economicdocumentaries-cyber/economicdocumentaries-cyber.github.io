// Shared helpers: building page elements, shuffling, saving to the browser,
// alert boxes, toasts, and the header and footer used on every page.
import { SITE_NAME, SITE_TAGLINE } from './config.js';

// h('div.card#main', { onclick: fn, html: '<b>hi</b>' }, child, 'text', [more])
// Builds an element. Props starting with "on" become event listeners,
// "html" sets innerHTML, and null/false props or children are skipped.
export function h(tag, props, ...kids) {
  const [name, ...bits] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const bit of bits) {
    if (bit[0] === '.') el.classList.add(bit.slice(1));
    else el.id = bit.slice(1);
  }
  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = `${el.className} ${v}`.trim();
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'checked' || k === 'value') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  } else {
    kids.unshift(props);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// Replaces an element's children, skipping null/false like h() does.
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  return el;
}

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Fisher–Yates shuffle. Returns a new array.
export function shuffle(list, random = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Repeatable random numbers from a text seed (xmur3 hash + mulberry32), so
// everyone in a group session sees the same layout for the same question.
export function seededRandom(seed) {
  const s = String(seed);
  let x = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    x = Math.imul(x ^ s.charCodeAt(i), 3432918353);
    x = (x << 13) | (x >>> 19);
  }
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  let a = (x ^ (x >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seededShuffle = (list, seed) => shuffle(list, seededRandom(seed));

// localStorage with JSON, which never throws (private windows can block storage).
export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

// 83000 ms -> "00:01:23"
export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const two = n => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

// 1791499200000 -> "Oct 8, 2026, 5:20 PM" (or "Oct 8" when short)
export function fmtDate(ms, short = false) {
  const d = new Date(ms);
  return short
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- icons ----------

function calculatorIcon() {
  let keys = '';
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      keys += `<rect x="${(4 + col * 5.4).toFixed(1)}" y="${(14 + row * 3.9).toFixed(1)}" width="3.8" height="2.7" rx=".5"/>`;
    }
  }
  return `<svg viewBox="0 0 28 32" width="28" height="32" aria-hidden="true" focusable="false"><rect x=".5" y=".5" width="27" height="31" rx="3.5" fill="currentColor"/><rect x="4" y="4" width="20" height="7" rx="1" fill="#fff"/><g fill="#fff">${keys}</g></svg>`;
}

const ICONS = {
  close: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="8" fill="currentColor"/><path d="M5.3 5.3l5.4 5.4m0-5.4l-5.4 5.4" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/></svg>',
  calc: calculatorIcon(),
  flag: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M3.5 1.5v13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.3 2.2h8.4l-2.1 3.3 2.1 3.3H4.3z" fill="currentColor"/></svg>',
};

export function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name];
  return t.content.firstElementChild;
}

// ---------- header and footer ----------

// Logo + site name on the left, optional set title, optional Close button,
// and the striped divider under it (SPEC 3.2 item 1).
export function siteHeader({ title = '', onClose = null, link = true } = {}) {
  const brandParts = [
    h('img', { src: 'img/icon.svg', alt: '', width: 40, height: 40 }),
    h('span.brand-text', h('span.brand-name', SITE_NAME), SITE_TAGLINE ? h('span.brand-tag', SITE_TAGLINE) : null),
  ];
  return h('header.topbar',
    h('div.wrap.topbar-inner',
      link ? h('a.brand', { href: '#/' }, brandParts) : h('div.brand', brandParts),
      title ? h('p.set-title', title) : null,
      onClose ? h('button.close-btn', { type: 'button', onclick: onClose }, icon('close'), h('span', 'Close')) : null),
    h('div.stripe', { 'aria-hidden': 'true' }));
}

// The full screen notice starts hidden; the exam screen shows it while
// full screen is on (SPEC 3.2 item 7).
export function siteFooter() {
  return h('footer.site-footer',
    h('div.wrap',
      h('div.fs-notice', { hidden: true },
        h('img', { src: 'img/icon.svg', alt: '', width: 32, height: 32 }),
        h('p', h('b', 'Full screen mode is on for this practice exam.'), ' Press Esc to leave it.')),
      h('p.disclaimer', 'Independent practice site for our class. Not affiliated with or endorsed by ATI.'),
      h('p.disclaimer.stats-note', 'This site collects anonymous usage stats to help improve it.')));
}

// ---------- alert boxes (SPEC 3.4) ----------

const openModals = [];
let modalCount = 0;

function syncModals() {
  const app = document.getElementById('app');
  if (app) app.inert = openModals.length > 0;
  openModals.forEach((m, i) => {
    m.backdrop.inert = i < openModals.length - 1;
    m.backdrop.style.zIndex = String(1000 + i);
  });
}

// Shows an alert and resolves with the value of the button pressed, 'close'
// for the Close button or Esc, or undefined if closeModals() removed it.
// The returned promise also has .close(value).
export function modal({ title, message = '', buttons = [], closable = true } = {}) {
  const n = ++modalCount;
  const returnFocus = document.activeElement;
  let resolve;
  const result = new Promise(r => (resolve = r));

  const actions = buttons.map(b => h('button.btn', { type: 'button', class: b.accent ? 'btn-accent' : null, onclick: () => close(b.value) }, b.label));
  const box = h('div.modal', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': `modal-title-${n}`, 'aria-describedby': `modal-msg-${n}`, tabindex: '-1' },
    h('div.modal-head',
      h('h2.modal-title', { id: `modal-title-${n}` }, title),
      closable ? h('button.close-btn', { type: 'button', onclick: () => close('close') }, icon('close'), h('span', 'Close')) : null),
    h('div.modal-msg', { id: `modal-msg-${n}` }, message),
    actions.length ? h('div.modal-actions', actions) : null);
  const backdrop = h('div.modal-backdrop', box);
  const entry = { backdrop, box, closable, close };

  function close(value) {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    openModals.splice(openModals.indexOf(entry), 1);
    syncModals();
    const top = openModals.at(-1);
    if (top) top.box.focus({ preventScroll: true });
    else if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    resolve(value);
  }

  openModals.push(entry);
  document.body.append(backdrop);
  syncModals();
  (actions[0] ?? box.querySelector('.close-btn') ?? box).focus({ preventScroll: true });
  result.close = close;
  return result;
}

export function closeModals() {
  for (const m of [...openModals].reverse()) m.close(undefined);
}

// Esc closes the top alert (when it has a Close button); Tab stays inside it.
document.addEventListener('keydown', e => {
  const top = openModals.at(-1);
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (top.closable) top.close('close');
  } else if (e.key === 'Tab') {
    const items = [...top.box.querySelectorAll('button:not([disabled])')];
    if (!items.length) return e.preventDefault();
    const first = items[0], last = items.at(-1), inside = top.box.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === top.box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
      e.preventDefault();
      first.focus();
    }
  }
});

// ---------- toasts ----------

let toastArea = null;

export function toast(text, ms = 4500) {
  toastArea ??= document.body.appendChild(h('div.toasts', { 'aria-live': 'polite' }));
  const el = toastArea.appendChild(h('div.toast', text));
  setTimeout(() => el.remove(), ms);
}
