// Floating calculator (SPEC 7). Drag it by its title bar. While it has focus
// it takes keyboard input: digits, . + - * / Enter, Backspace, Delete (clear),
// and Esc to close.
import { h } from './util.js';

// [label, key, spoken name]
const KEYS = [
  ['C', 'clear', 'Clear'], ['←', 'back', 'Backspace'], ['±', 'neg', 'Change sign'], ['÷', '/', 'Divide'],
  ['7', '7'], ['8', '8'], ['9', '9'], ['×', '*', 'Multiply'],
  ['4', '4'], ['5', '5'], ['6', '6'], ['−', '-', 'Subtract'],
  ['1', '1'], ['2', '2'], ['3', '3'], ['+', '+', 'Add'],
  ['√', 'sqrt', 'Square root'], ['0', '0'], ['.', '.', 'Decimal point'], ['=', '=', 'Equals'],
];
const OPS = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => (b === 0 ? NaN : a / b) };
const SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const KEYBOARD = {
  Enter: '=', '=': '=', Backspace: 'back', Delete: 'clear', Escape: 'close',
  '+': '+', '-': '-', '*': '*', x: '*', X: '*', '/': '/', '.': '.', ',': '.',
};

const round12 = n => Number(n.toPrecision(12));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function createCalculator({ onClose } = {}) {
  // replace: the next digit starts a new number. typed: a new number was
  // entered (or made by √ or ±) since the last operator.
  let display = '0', acc = null, op = null, replace = true, typed = false, error = false, placed = false;

  const out = h('div.calc-out', { 'aria-live': 'polite' }, '0');
  const expr = h('div.calc-expr', { 'aria-hidden': 'true' });
  const buttons = {};
  const keys = KEYS.map(([label, key, name]) => {
    const kind = key === '=' ? 'eq' : SYMBOL[key] ? 'op' : /^\d$/.test(key) ? 'num' : 'fn';
    return (buttons[key] = h('button', { type: 'button', class: kind, 'aria-label': name ?? null, onclick: () => press(key) }, label));
  });
  const closeBtn = h('button.calc-x', { type: 'button', 'aria-label': 'Close calculator', onclick: () => close() }, '✕');
  const head = h('div.calc-head', h('h2', 'Calculator'), closeBtn);
  const panel = h('div.calc', { role: 'dialog', 'aria-label': 'Calculator', tabindex: '-1', hidden: true },
    head, h('div.calc-screen', expr, out), h('div.calc-keys', keys));

  function reset() {
    display = '0'; acc = null; op = null; replace = true; typed = false; error = false;
  }

  function result(n) {
    if (!Number.isFinite(n)) {
      error = true;
      return 'Error';
    }
    return String(round12(n));
  }

  function press(key) {
    if (key === 'clear') reset();
    else if (error) {
      reset();
      if (/^[\d.]$/.test(key)) press(key);
    } else if (/^\d$/.test(key)) {
      if (replace || display === '0') display = key;
      else if (display.replace(/\D/g, '').length < 15) display += key;
      replace = false;
      typed = true;
    } else if (key === '.') {
      if (replace) display = '0.';
      else if (!display.includes('.')) display += '.';
      replace = false;
      typed = true;
    } else if (key === 'back') {
      if (!replace) display = display.slice(0, -1).replace(/^-?$/, '0');
    } else if (key === 'neg') {
      if (display !== '0') display = display.startsWith('-') ? display.slice(1) : `-${display}`;
      typed = true;
    } else if (key === 'sqrt') {
      const x = Number(display);
      display = result(x < 0 ? NaN : Math.sqrt(x));
      replace = true;
      typed = true;
    } else if (OPS[key]) {
      // Works like a basic calculator: 2 + 3 × 4 = gives 20.
      if (op && typed) display = result(OPS[op](acc, Number(display)));
      acc = error ? null : Number(display);
      op = error ? null : key;
      replace = true;
      typed = false;
    } else if (key === '=') {
      if (op && acc != null) {
        display = result(OPS[op](acc, Number(display)));
        acc = null;
        op = null;
      }
      replace = true;
      typed = false;
    }
    out.textContent = display;
    expr.textContent = op && acc != null ? `${acc} ${SYMBOL[op]}` : '';
  }

  // Keyboard input, only while the calculator has focus.
  panel.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = /^\d$/.test(e.key) ? e.key : KEYBOARD[e.key];
    if (!key) return;
    e.preventDefault();
    if (key === 'close') return close();
    press(key);
    const btn = buttons[key];
    if (btn) {
      btn.classList.add('pressed');
      setTimeout(() => btn.classList.remove('pressed'), 120);
    }
  });

  // Dragging by the title bar (mouse, pen, or touch).
  head.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const box = panel.getBoundingClientRect();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    head.setPointerCapture(e.pointerId);
    const move = ev => place(ev.clientX - dx, ev.clientY - dy);
    const stop = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', stop);
      head.removeEventListener('pointercancel', stop);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', stop);
    head.addEventListener('pointercancel', stop);
    panel.focus({ preventScroll: true });
  });

  function place(x, y) {
    panel.style.left = `${clamp(x, 0, innerWidth - panel.offsetWidth)}px`;
    panel.style.top = `${clamp(y, 0, innerHeight - panel.offsetHeight)}px`;
  }

  const keepOnScreen = () => {
    if (!panel.hidden) place(panel.offsetLeft, panel.offsetTop);
  };
  addEventListener('resize', keepOnScreen);

  function open(anchor) {
    panel.hidden = false;
    if (!placed && anchor) {
      // First time: just below the calculator button, lined up with its right edge.
      const r = anchor.getBoundingClientRect();
      place(r.right - panel.offsetWidth, r.bottom + 8);
      placed = true;
    } else {
      keepOnScreen();
    }
    panel.focus({ preventScroll: true });
  }

  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    onClose?.();
  }

  return {
    el: panel,
    open,
    close,
    isOpen: () => !panel.hidden,
    toggle(anchor) {
      if (panel.hidden) open(anchor);
      else close();
      return !panel.hidden;
    },
    destroy() {
      removeEventListener('resize', keepOnScreen);
      panel.remove();
    },
  };
}
