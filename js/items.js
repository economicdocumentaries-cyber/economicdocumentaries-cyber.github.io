// Question types (SPEC 5): how each one is checked when a set loads, drawn on
// the exam screen, scored, and marked in review. Responses always hold
// original positions (indexes into the set file), so shuffled layouts never
// change scoring.
import { h, shuffle } from './util.js';

const isText = v => typeof v === 'string' && v.trim() !== '';
const isIndex = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
const range = n => [...Array(n).keys()];

// Display order for n things: shuffled, or 0, 1, 2, ...
function displayOrder(n, mix, random) {
  return mix ? shuffle(range(n), random) : range(n);
}

// +1 for each right pick, -1 for each wrong pick, never below 0.
function plusMinus(picked, key) {
  const right = new Set(key);
  let points = 0;
  for (const i of picked ?? []) points += right.has(i) ? 1 : -1;
  return Math.max(0, points);
}

// "5,000" -> 5000. Anything that isn't a plain number gives null.
function parseNumber(text) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
}

// The zero rules for medication math: no trailing zero after a decimal point
// ("20.0", "1.50", or "4."), and a zero before a decimal point (".5" is wrong).
function zerosOk(text) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  return !/\.(\d*0)?$/.test(t) && !/^[-+]?\./.test(t);
}

// A fill-in answer's value is right (within the tolerance), however it's written.
const rightValue = (q, n) => n != null && Math.abs(n - q.answer) <= (q.tolerance ?? 0) + 1e-9;

// Image paths in a set are relative to the sets folder, like "img/abdomen.svg".
// A picture the host uploaded on the console is "db:<id>" instead: it's kept
// in Firebase, at /setImages/<id>, and js/set-changes.js says how to load it.
const imageSrc = path => (/^https?:\/\//.test(path) ? path : `sets/${path}`);
export const uploadedPictureId = path => /^db:([\w-]+)$/.exec(path ?? '')?.[1] ?? null;
const pictures = new Map(); // id -> a promise of the picture as a data: URL
let loadPicture = null;
export const setPictureLoader = load => (loadPicture = load);
export const rememberPicture = (id, url) => pictures.set(id, Promise.resolve(url));

// Shows a set's picture in img. note (hidden at first) shows if an uploaded
// picture can't be loaded.
export function showPicture(img, path, note = null) {
  const id = uploadedPictureId(path);
  if (!id) {
    img.src = imageSrc(path);
    return;
  }
  if (!pictures.has(id)) {
    const loading = loadPicture ? loadPicture(id) : Promise.reject(new Error('Pictures can\'t be loaded on this page.'));
    pictures.set(id, loading);
    loading.catch(() => pictures.delete(id)); // try again next time
  }
  img.classList.add('is-loading');
  pictures.get(id).then(url => (img.src = url), () => note && (note.hidden = false)).finally(() => img.classList.remove('is-loading'));
}

// Plain text with <br> line breaks -> text and <br> elements.
const withBreaks = text => text.split(/<br\s*\/?>/i).flatMap((part, i) => (i ? [h('br'), part] : [part]));

// An element that works like a button (click, Enter, Space) but isn't a
// <button>: Firefox can't drag real buttons, and highlight phrases must wrap
// like normal text.
function pseudoButton(tag, { locked = false, ...props }, ...kids) {
  const el = h(tag, { role: 'button', tabindex: locked ? null : '0', 'aria-disabled': locked ? 'true' : null, ...props }, ...kids);
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    el.click();
  });
  return el;
}

// Puts makeBlank(n) at each {{n}} in an inline-HTML sentence.
function cloze(text, makeBlank) {
  const holder = h('span');
  holder.innerHTML = text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => `<span data-blank="${n}"></span>`);
  for (const spot of holder.querySelectorAll('[data-blank]')) spot.replaceWith(makeBlank(Number(spot.dataset.blank)));
  return holder;
}

// "text [[phrase]] more" -> [{ text }, { phrase, n }, ...], or null when the brackets don't pair up.
export function highlightParts(passage) {
  const parts = [];
  let n = 0;
  for (const chunk of passage.split(/(\[\[[\s\S]*?\]\])/)) {
    const phrase = /^\[\[([\s\S]+)\]\]$/.exec(chunk)?.[1];
    if (phrase != null && !phrase.includes('[[') && phrase.trim()) parts.push({ phrase, n: n++ });
    else if (chunk.includes('[[') || chunk.includes(']]')) return null;
    else if (chunk) parts.push({ text: chunk });
  }
  return parts;
}

// ---------- review marks (review mode and practice feedback) ----------

// A ✓ or ✗ with words, so color is never the only signal.
function mark(ok, words) {
  return h(`span.mark.${ok ? 'ok' : 'bad'}`, h('span', { 'aria-hidden': 'true' }, ok ? '✓' : '✗'), ` ${words}`);
}

// After a wrong or empty blank: "✗ Incorrect  Correct answer: apical"
function blankMark(ok, given, correctText) {
  if (ok) return h('span.blank-mark', mark(true, 'Correct'));
  return h('span.blank-mark', mark(false, given ? 'Incorrect' : 'No answer'), h('span.key-inline', 'Correct answer: ', h('b', correctText)));
}

const legend = text => h('p.review-legend', text);

// ---------- checks used by validateSet ----------

function checkList(list, field, min = 2) {
  if (!Array.isArray(list) || list.length < min) return [`"${field}" must be a list of at least ${min} entries.`];
  if (!list.every(isText)) return [`One of the entries in "${field}" is empty or is not text.`];
  return [];
}

function checkPicks(picks, n, field = 'answer') {
  if (!Array.isArray(picks) || !picks.length) return [`"${field}" must be a list of choice numbers, counting from 0, like [0, 2].`];
  if (!picks.every(p => isIndex(p, n))) return [`Every number in "${field}" must be from 0 to ${n - 1}.`];
  if (new Set(picks).size !== picks.length) return [`"${field}" lists the same choice more than once.`];
  return [];
}

// The text must hold {{0}} to {{count - 1}}, each exactly once.
function checkMarkers(text, count) {
  const found = [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => Number(m[1]));
  const problems = [];
  for (let n = 0; n < count; n++) {
    const times = found.filter(f => f === n).length;
    if (times !== 1) problems.push(times ? `The text has {{${n}}} more than once.` : `The text is missing {{${n}}}.`);
  }
  for (const n of new Set(found.filter(f => f >= count))) {
    problems.push(`The text has {{${n}}}, but there are only ${count} blanks (numbered from 0).`);
  }
  return problems;
}

// ---------- answer screens ----------
// ctx: { response, layout, locked, review, labelledBy, idPrefix, onChange(response) }.
// "review" draws the answer read-only, with the key and ✓ / ✗ marks.
// "idPrefix" keeps element ids unique when several questions share a page.

// Radio buttons (mc), checkboxes (sata), or checkboxes with a limit (emr).
// Crossing out (SPEC 4.4), a study aid that never changes the score: right-click
// a choice, or click the struck-through "abc" button next to it. Crossing out
// a picked choice un-picks it, and picking a crossed-out choice brings it back.
// ctx.crossed: the crossed-out choices (positions in the set file);
// ctx.onCross(list) gets the new list.
function choiceList(q, ctx, multiple, limit = Infinity) {
  const { response, layout, review = false, labelledBy, onChange, onCross } = ctx;
  const locked = ctx.locked || review;
  const order = layout?.options ?? range(q.options.length);
  const picked = new Set(multiple ? response ?? [] : response == null ? [] : [response]);
  const key = new Set([].concat(q.answer));
  const crossed = new Set(review ? [] : ctx.crossed ?? []);
  const lines = new Map(); // choice -> { row, input, strike }
  const answerNow = () => (multiple ? [...picked].sort((a, b) => a - b) : [...picked][0] ?? null);
  function setCrossed(i, on) {
    if (on === crossed.has(i)) return;
    if (on) crossed.add(i);
    else crossed.delete(i);
    const { row, strike } = lines.get(i);
    row.classList.toggle('crossed', on);
    strike?.setAttribute('aria-pressed', String(on));
    onCross?.([...crossed].sort((a, b) => a - b));
  }
  function toggleCross(i) {
    const on = !crossed.has(i);
    if (on && picked.has(i)) {
      picked.delete(i);
      lines.get(i).input.checked = false;
      applyLimit();
      onChange?.(answerNow());
    }
    setCrossed(i, on);
  }
  const rows = order.map(i => {
    const input = h('input.ctl', { type: multiple ? 'checkbox' : 'radio', name: `q-${q.id}`, value: String(i), checked: picked.has(i), disabled: locked });
    input.addEventListener('change', () => {
      if (!multiple) picked.clear();
      if (input.checked) {
        picked.add(i);
        setCrossed(i, false);
      } else picked.delete(i);
      applyLimit();
      onChange?.(multiple ? [...picked].sort((a, b) => a - b) : i);
    });
    // The outline box follows focus (.opt:focus-within). Safari doesn't focus
    // a radio or checkbox when it's clicked, so focus it here.
    input.addEventListener('click', () => input.focus({ preventScroll: true }));
    const row = h('label.opt', { class: crossed.has(i) ? 'crossed' : null }, input, h('span.opt-text', { html: q.options[i] }));
    lines.set(i, { row, input, strike: null });
    if (review) {
      const right = key.has(i), mine = picked.has(i);
      row.classList.add('reviewed', right ? 'is-key' : mine ? 'is-wrong' : 'is-plain');
      if (mine) row.append(mark(right, 'Your answer'));
      else if (right) row.append(mark(true, 'Correct answer'));
    }
    return row;
  });
  // Each choice in a line with its cross-out button (not inside the label, so
  // the button never picks the choice).
  const shown = rows.map((row, n) => {
    if (locked) return row;
    const i = order[n];
    const words = q.options[i].replace(/<[^>]+>/g, '').trim();
    const strike = h('button.strike-btn', {
      type: 'button', title: 'Cross out', 'aria-pressed': String(crossed.has(i)),
      'aria-label': `Cross out: ${words.length > 80 ? `${words.slice(0, 80)}…` : words}`,
      onclick: () => toggleCross(i),
    }, h('span.strike-icon', { 'aria-hidden': 'true' }, 'abc'));
    lines.get(i).strike = strike;
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      toggleCross(i);
    });
    return h('div.opt-line', row, strike);
  });
  // "Select 3": once 3 are checked, the rest wait until one is cleared.
  function applyLimit() {
    if (limit === Infinity || locked) return;
    for (const row of rows) {
      const full = !row.firstChild.checked && picked.size >= limit;
      row.firstChild.disabled = full;
      row.classList.toggle('capped', full);
    }
  }
  applyLimit();
  return h('div.choices', { role: multiple ? 'group' : 'radiogroup', 'aria-labelledby': labelledBy }, shown);
}

// Ordered response: options start in the Unordered box (never in the right
// order) and move to the Ordered Response box by click or drag; ▲ ▼ ✕ adjust.
function orderUI(q, ctx) {
  const { response, layout, labelledBy, onChange } = ctx;
  if (ctx.review) return orderReview(q, response, labelledBy);
  const locked = !!ctx.locked;
  const start = layout?.items ?? range(q.items.length);
  let placed = Array.isArray(response) ? response.filter(i => isIndex(i, q.items.length)) : [];
  let dragged = null;
  const pool = h('ul.order-list', { 'aria-label': 'Unordered options' });
  const answer = h('ol.order-list', { 'aria-label': 'Ordered response' });

  function save(next, focusKey) {
    placed = next;
    onChange?.(placed.slice());
    draw();
    if (focusKey) root.querySelector(`[data-key="${focusKey}"]`)?.focus();
  }

  function draggable(li, i) {
    if (locked) return li;
    li.draggable = true;
    li.addEventListener('dragstart', e => {
      dragged = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      dragged = null;
      li.classList.remove('dragging');
      pool.classList.remove('over');
      answer.classList.remove('over');
    });
    return li;
  }

  function draw() {
    const waiting = start.filter(i => !placed.includes(i));
    pool.replaceChildren(...waiting.map((i, pos) => {
      const next = waiting[pos + 1] ?? waiting[pos - 1];
      const btn = pseudoButton('div.order-text', { locked, 'data-key': `pool-${i}`, title: 'Move to the ordered response' }, q.items[i]);
      btn.addEventListener('click', () => {
        if (!locked) save([...placed, i], next != null ? `pool-${next}` : `out-${i}`);
      });
      return draggable(h('li.order-item', btn), i);
    }));
    if (!waiting.length) pool.append(h('li.order-empty', 'All options are in the ordered response.'));

    answer.replaceChildren(...placed.map((i, pos) => {
      const move = (to, focusKey) => {
        const next = placed.filter(p => p !== i);
        next.splice(to, 0, i);
        save(next, focusKey);
      };
      const last = placed.length - 1;
      return draggable(h('li.order-item.placed',
        h('span.order-num', `${pos + 1}.`),
        h('span.order-text', q.items[i]),
        h('span.order-ctls',
          h('button.order-ctl', { type: 'button', 'data-key': `up-${i}`, disabled: locked || pos === 0, 'aria-label': `Move ${q.items[i]} up`, onclick: () => move(pos - 1, pos - 1 === 0 ? `down-${i}` : `up-${i}`) }, '▲'),
          h('button.order-ctl', { type: 'button', 'data-key': `down-${i}`, disabled: locked || pos === last, 'aria-label': `Move ${q.items[i]} down`, onclick: () => move(pos + 1, pos + 1 === last ? `up-${i}` : `down-${i}`) }, '▼'),
          h('button.order-ctl', { type: 'button', 'data-key': `out-${i}`, disabled: locked, 'aria-label': `Remove ${q.items[i]}`, onclick: () => save(placed.filter(p => p !== i), `pool-${i}`) }, '✕'))), i);
    }));
    if (!placed.length) answer.append(h('li.order-empty', 'Move options here.'));
  }

  // Where a drop at height y lands in the ordered list.
  function dropIndex(y) {
    const items = [...answer.querySelectorAll('.order-item')];
    const at = items.findIndex(li => {
      const box = li.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    return at === -1 ? items.length : at;
  }

  answer.addEventListener('dragover', e => {
    if (dragged == null) return;
    e.preventDefault();
    answer.classList.add('over');
  });
  answer.addEventListener('dragleave', e => {
    if (!answer.contains(e.relatedTarget)) answer.classList.remove('over');
  });
  answer.addEventListener('drop', e => {
    e.preventDefault();
    answer.classList.remove('over');
    if (dragged == null) return;
    const from = placed.indexOf(dragged);
    let to = dropIndex(e.clientY);
    if (from !== -1 && from < to) to--;
    const next = placed.filter(p => p !== dragged);
    next.splice(to, 0, dragged);
    save(next);
  });
  pool.addEventListener('dragover', e => {
    if (dragged == null || !placed.includes(dragged)) return;
    e.preventDefault();
    pool.classList.add('over');
  });
  pool.addEventListener('dragleave', e => {
    if (!pool.contains(e.relatedTarget)) pool.classList.remove('over');
  });
  pool.addEventListener('drop', e => {
    e.preventDefault();
    pool.classList.remove('over');
    if (dragged != null) save(placed.filter(p => p !== dragged));
  });

  const root = h('div.order', { role: 'group', 'aria-labelledby': labelledBy },
    h('div.order-box', h('h3.order-title', 'Unordered Options'), pool),
    h('div.order-box', h('h3.order-title', 'Ordered Response'), answer));
  draw();
  return root;
}

// Review: the student's order with each position marked, next to the right order.
function orderReview(q, response, labelledBy) {
  const placed = Array.isArray(response) ? response : [];
  return h('div.order', { role: 'group', 'aria-labelledby': labelledBy },
    h('div.order-box', h('h3.order-title', 'Your order'), h('ol.order-list',
      placed.length
        ? placed.map((i, pos) => h('li.order-item.placed', { class: i === pos ? 'is-key' : 'is-wrong' },
            h('span.order-num', `${pos + 1}.`), h('span.order-text', q.items[i]), mark(i === pos, i === pos ? 'Correct' : 'Incorrect')))
        : h('li.order-empty', 'No answer'))),
    h('div.order-box', h('h3.order-title', 'Correct order'), h('ol.order-list',
      q.items.map((item, pos) => h('li.order-item.placed.is-key', h('span.order-num', `${pos + 1}.`), h('span.order-text', item))))));
}

function fillUI(q, ctx) {
  const { response, review = false, labelledBy, onChange } = ctx;
  const unitId = `${ctx.idPrefix ?? ''}fill-unit`;
  const input = h('input.fill-input', {
    type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
    value: response ?? '', disabled: ctx.locked || review, 'aria-labelledby': q.unit ? `${labelledBy} ${unitId}` : labelledBy,
  });
  input.addEventListener('input', () => onChange?.(input.value));
  const row = h('div.fill', input, q.unit ? h('span.fill-unit', { id: unitId }, q.unit) : null);
  if (!review) return row;
  const ok = TYPES.fill.score(q, response).earned === 1;
  const n = parseNumber(response);
  row.append(mark(ok, ok ? 'Correct' : n == null ? 'No answer' : 'Incorrect'));
  return h('div', row, ok ? null : h('p.key-note', 'Correct answer: ', h('b', `${q.answer}${q.unit ? ` ${q.unit}` : ''}`),
    q.tolerance ? ` (answers within ${q.tolerance} are accepted)` : '',
    rightValue(q, n) ? '. Your number has the right value, but it must be written with no trailing zero, and with a zero before a decimal point.' : ''));
}

// Hot spot: click the image to place a marker. Mouse and touch only; this is
// the one item type without keyboard support (SPEC 9).
function hotspotUI(q, ctx) {
  const { response, review = false, onChange } = ctx;
  const locked = ctx.locked || review;
  const img = h('img', { alt: q.alt, draggable: 'false' });
  const missing = h('p.picture-missing', { role: 'alert', hidden: true }, 'The picture couldn\'t be loaded. Check the internet connection, then reload the page.');
  showPicture(img, q.image, missing);
  const marker = h('span.hotspot-marker', { 'aria-hidden': 'true' });
  const status = h('p.sr-only', { 'aria-live': 'polite' });
  const regions = review
    ? q.regions.map(g => h('span.hotspot-region', { 'aria-hidden': 'true', style: `left:${g.x}%;top:${g.y}%;width:${g.w}%;height:${g.h}%` }))
    : [];
  const area = h('div.hotspot', { class: locked ? 'locked' : null }, img, regions, marker);
  const show = spot => {
    marker.hidden = !spot;
    if (spot) Object.assign(marker.style, { left: `${spot.x}%`, top: `${spot.y}%` });
  };
  area.addEventListener('click', e => {
    if (locked) return;
    const box = img.getBoundingClientRect();
    const spot = {
      x: Math.round(((e.clientX - box.left) / box.width) * 1000) / 10,
      y: Math.round(((e.clientY - box.top) / box.height) * 1000) / 10,
    };
    if (!(spot.x >= 0 && spot.x <= 100 && spot.y >= 0 && spot.y <= 100)) return;
    show(spot);
    status.textContent = 'Location marked.';
    onChange?.(spot);
  });
  show(response);
  if (!review) return h('div.hotspot-wrap', area, missing, status);
  const ok = TYPES.hotspot.score(q, response).earned === 1;
  return h('div.hotspot-wrap', area, missing,
    h('p.key-note', response ? mark(ok, ok ? 'Your click is in the correct area.' : 'Your click is outside the correct area.') : mark(false, 'No answer.'),
      ' The correct area is outlined in green.'));
}

// Matrix: one radio per row (single) or checkboxes per row (multiple).
function matrixUI(q, ctx) {
  const { response, review = false, labelledBy, onChange } = ctx;
  const locked = ctx.locked || review;
  const multiple = !!q.multiple;
  const p = ctx.idPrefix ?? '';
  const value = q.rows.map((_, r) => (multiple ? [...(response?.[r] ?? [])] : response?.[r] ?? null));
  const head = h('thead', h('tr',
    h('th.row-head', { scope: 'col' }, q.rowHeader ?? ''),
    q.columns.map((col, c) => h('th', { scope: 'col', id: `${p}mx-col-${c}`, html: col }))));
  const body = h('tbody', q.rows.map((row, r) => h('tr',
    h('th', { scope: 'row', id: `${p}mx-row-${r}`, html: row }),
    q.columns.map((_, c) => {
      const mine = multiple ? value[r].includes(c) : value[r] === c;
      const input = h('input.ctl', {
        type: multiple ? 'checkbox' : 'radio', name: `mx-${q.id}-${r}`, disabled: locked, checked: mine,
        'aria-labelledby': `${p}mx-row-${r} ${p}mx-col-${c}`,
      });
      input.addEventListener('change', () => {
        if (!multiple) value[r] = c;
        else value[r] = input.checked ? [...value[r], c].sort((a, b) => a - b) : value[r].filter(v => v !== c);
        onChange?.(value.map(v => (Array.isArray(v) ? v.slice() : v)));
      });
      input.addEventListener('click', () => input.focus({ preventScroll: true }));
      if (!review) return h('td', h('label.cell', input));
      const right = multiple ? q.answer[r].includes(c) : q.answer[r] === c;
      return h('td', { class: right ? 'is-key' : mine ? 'is-wrong' : null },
        h('label.cell', input,
          right ? h('span.cell-mark.ok', h('span', { 'aria-hidden': 'true' }, '✓'), h('span.sr-only', 'correct answer'))
            : mine ? h('span.cell-mark.bad', h('span', { 'aria-hidden': 'true' }, '✗'), h('span.sr-only', 'incorrect')) : null));
    }))));
  const table = h('div.matrix-wrap', h('table.matrix', { 'aria-labelledby': labelledBy }, head, body));
  return review ? h('div', table, legend('✓ Green cells are the correct answers. ✗ Red cells are boxes you checked that are incorrect.')) : table;
}

function dropdownUI(q, ctx) {
  const { response, review = false, labelledBy, onChange } = ctx;
  const value = q.blanks.map((b, n) => (isIndex(response?.[n], b.options.length) ? response[n] : null));
  const sentence = cloze(q.text, n => {
    const blank = q.blanks[n];
    const select = h('select.blank-select', { disabled: ctx.locked || review, 'aria-label': `Drop-down list ${n + 1}` },
      h('option', { value: '' }, 'Select…'),
      blank.options.map((text, i) => h('option', { value: String(i) }, text)));
    select.value = value[n] == null ? '' : String(value[n]);
    select.addEventListener('change', () => {
      value[n] = select.value === '' ? null : Number(select.value);
      onChange?.(value.slice());
    });
    if (!review) return select;
    return h('span.blank-wrap', select, blankMark(value[n] === blank.answer, value[n] != null, blank.options[blank.answer]));
  });
  return h('div.cloze-text', { role: 'group', 'aria-labelledby': labelledBy, class: review ? 'reviewed' : null }, sentence);
}

// Drag and drop: drag an option into a blank, or click an option and then a
// blank. Each option fits one blank; clicking a filled blank empties it.
function dragdropUI(q, ctx) {
  const { response, layout, review = false, labelledBy, onChange } = ctx;
  const locked = ctx.locked || review;
  const order = layout?.tokens ?? range(q.tokens.length);
  const value = q.answer.map((_, n) => (isIndex(response?.[n], q.tokens.length) ? response[n] : null));
  if (review) {
    return h('div.cloze-text.reviewed', { role: 'group', 'aria-labelledby': labelledBy }, cloze(q.text, n => {
      const t = value[n], ok = t === q.answer[n];
      return h('span.blank-wrap',
        h('span.drop.filled', { class: ok ? 'is-key' : 'is-wrong' }, t == null ? '—' : q.tokens[t]),
        blankMark(ok, t != null, q.tokens[q.answer[n]]));
    }));
  }
  let picked = null; // option clicked and waiting for a blank
  const tokenOf = e => Number(/^token:(\d+)$/.exec(e.dataTransfer.getData('text/plain'))?.[1]);
  const startDrag = (e, t) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `token:${t}`);
  };

  const tokens = new Map(order.map(t => {
    const btn = pseudoButton('span.token', { locked, draggable: locked ? null : 'true' }, q.tokens[t]);
    btn.addEventListener('click', () => {
      if (locked) return;
      picked = picked === t ? null : t;
      draw();
    });
    btn.addEventListener('dragstart', e => startDrag(e, t));
    return [t, btn];
  }));

  const blanks = [];
  const sentence = cloze(q.text, n => {
    const blank = pseudoButton('span.drop', { locked });
    blank.addEventListener('click', () => {
      if (locked) return;
      if (picked != null) place(picked, n);
      else if (value[n] != null) {
        value[n] = null;
        commit();
      }
    });
    blank.addEventListener('dragstart', e => startDrag(e, value[n]));
    blank.addEventListener('dragover', e => {
      if (locked) return;
      e.preventDefault();
      blank.classList.add('over');
    });
    blank.addEventListener('dragleave', () => blank.classList.remove('over'));
    blank.addEventListener('drop', e => {
      e.preventDefault();
      blank.classList.remove('over');
      const t = tokenOf(e);
      if (isIndex(t, q.tokens.length)) place(t, n);
    });
    return (blanks[n] = blank);
  });

  const bank = h('div.token-bank', { role: 'group', 'aria-label': 'Options' }, [...tokens.values()]);
  // Dragging a placed option back to the bank empties its blank.
  bank.addEventListener('dragover', e => {
    if (!locked) e.preventDefault();
  });
  bank.addEventListener('drop', e => {
    e.preventDefault();
    const at = value.indexOf(tokenOf(e));
    if (at !== -1) {
      value[at] = null;
      commit();
    }
  });

  function place(t, n) {
    const before = value.indexOf(t);
    if (before !== -1) value[before] = null;
    value[n] = t;
    picked = null;
    commit();
  }

  function commit() {
    onChange?.(value.slice());
    draw();
  }

  function draw() {
    const used = new Set(value);
    for (const [t, btn] of tokens) {
      btn.hidden = used.has(t);
      btn.setAttribute('aria-pressed', String(picked === t));
    }
    blanks.forEach((blank, n) => {
      const t = value[n];
      blank.textContent = t == null ? '' : q.tokens[t];
      blank.classList.toggle('filled', t != null);
      blank.draggable = t != null && !locked;
      blank.setAttribute('aria-label', t == null ? `Blank ${n + 1}, empty` : `Blank ${n + 1}: ${q.tokens[t]}. Select to empty it.`);
    });
    root.classList.toggle('picking', picked != null);
  }

  const root = h('div.dragdrop', bank, h('div.cloze-text', { role: 'group', 'aria-labelledby': labelledBy }, sentence));
  draw();
  return root;
}

// Highlight: click phrases in the passage to highlight them; click again to clear.
function highlightUI(q, ctx) {
  const { response, review = false, labelledBy, onChange } = ctx;
  const locked = ctx.locked || review;
  const picked = new Set(response ?? []);
  const key = new Set(q.answer);
  const nodes = highlightParts(q.passage).map(part => {
    if (part.text != null) return withBreaks(part.text);
    if (review) {
      const right = key.has(part.n), mine = picked.has(part.n);
      const kind = mine ? (right ? 'hl-right' : 'hl-wrong') : right ? 'hl-missed' : null;
      return h('span.hl', { class: kind }, withBreaks(part.phrase),
        kind ? h('span.sr-only', { 'hl-right': ' (highlighted, correct)', 'hl-wrong': ' (highlighted, incorrect)', 'hl-missed': ' (should have been highlighted)' }[kind]) : null);
    }
    const span = pseudoButton('span.hl', { locked, 'aria-pressed': String(picked.has(part.n)) }, withBreaks(part.phrase));
    span.addEventListener('click', () => {
      if (locked) return;
      if (picked.has(part.n)) picked.delete(part.n);
      else picked.add(part.n);
      span.setAttribute('aria-pressed', String(picked.has(part.n)));
      onChange?.([...picked].sort((a, b) => a - b));
    });
    return span;
  });
  const passage = h('div.passage', { role: 'group', 'aria-labelledby': labelledBy }, nodes);
  if (!review) return passage;
  return h('div', passage, h('p.review-legend.hl-legend',
    h('span.hl.hl-right', 'Green'), ' you highlighted correctly. ',
    h('span.hl.hl-wrong', 'Red'), ' you highlighted, but it is incorrect. ',
    h('span.hl.hl-missed', 'Dashed'), ' should have been highlighted.'));
}

// Bow tie (SPEC 5.1): action boxes on the left, the condition in the middle,
// parameter boxes on the right. Click an option to fill a box; click a
// filled box, or the option again, to clear it.
const BOWTIE = [
  { key: 'actions', list: 'Actions to Take', box: 'Action to take' },
  { key: 'condition', list: 'Potential Conditions', box: 'Condition most likely experiencing' },
  { key: 'parameters', list: 'Parameters to Monitor', box: 'Parameter to monitor' },
];

function bowtieUI(q, ctx) {
  const { response, layout, review = false, labelledBy, onChange } = ctx;
  const locked = ctx.locked || review;
  const boxCount = key => (key === 'condition' ? 1 : q[key].answer.length);
  const keyOf = key => (key === 'condition' ? [q.condition.answer] : q[key].answer);
  // Each group is a list of boxes, holding option indexes or null.
  const value = Object.fromEntries(BOWTIE.map(({ key }) => {
    const saved = key === 'condition' ? [response?.condition] : response?.[key] ?? [];
    return [key, range(boxCount(key)).map(s => (isIndex(saved[s], q[key].options.length) ? saved[s] : null))];
  }));

  const boxes = {}, options = {};
  for (const { key } of BOWTIE) {
    boxes[key] = value[key].map((_, s) => h('button.bt-slot', {
      type: 'button', disabled: locked,
      onclick: () => {
        if (value[key][s] == null) return;
        value[key][s] = null;
        commit();
      },
    }));
    options[key] = (layout?.[key] ?? range(q[key].options.length)).map(i =>
      h('button.bt-opt', { type: 'button', disabled: locked, 'data-index': String(i), onclick: () => choose(key, i) }, q[key].options[i]));
  }

  function choose(key, i) {
    const list = value[key];
    const at = list.indexOf(i);
    if (at !== -1) list[at] = null;
    else if (key === 'condition') list[0] = i;
    else if (list.includes(null)) list[list.indexOf(null)] = i;
    else return;
    commit();
  }

  function commit() {
    onChange?.({ condition: value.condition[0], actions: value.actions.slice(), parameters: value.parameters.slice() });
    draw();
  }

  function draw() {
    for (const { key, box } of BOWTIE) {
      const list = value[key];
      boxes[key].forEach((btn, s) => {
        const i = list[s];
        const name = list.length > 1 ? `${box} ${s + 1}` : box;
        btn.textContent = i == null ? '' : q[key].options[i];
        btn.classList.toggle('filled', i != null);
        btn.setAttribute('aria-label', i == null ? `${name}, empty` : `${name}: ${q[key].options[i]}${review ? '' : '. Select to clear.'}`);
        if (review) {
          const ok = i != null && keyOf(key).includes(i);
          btn.classList.add(ok ? 'is-key' : 'is-wrong');
          btn.append(h('span.bt-mark', mark(ok, ok ? 'Correct' : i == null ? 'No answer' : 'Incorrect')));
        }
      });
      const full = !list.includes(null);
      for (const btn of options[key]) {
        const placed = list.includes(Number(btn.dataset.index));
        btn.setAttribute('aria-pressed', String(placed));
        btn.disabled = locked || (full && !placed && key !== 'condition');
      }
    }
  }

  // Lines from each side box to the condition box, drawn in a 100 x 100 box stretched to fit.
  const lines = (side, count) => {
    let paths = '';
    for (let s = 0; s < count; s++) {
      const y = ((s + 0.5) / count) * 100;
      paths += side === 'left' ? `<line x1="0" y1="${y}" x2="100" y2="50"/>` : `<line x1="0" y1="50" x2="100" y2="${y}"/>`;
    }
    const holder = h(`div.bt-lines.bt-lines-${side}`, { 'aria-hidden': 'true' });
    holder.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${paths}</svg>`;
    return holder;
  };
  const column = (key, side) => h(`div.bt-col.bt-${side}`, { style: `--n: ${boxCount(key)}` }, boxes[key]);

  const diagram = h('div.bt-diagram',
    h('p.bt-head.bt-head-left', 'Actions to Take'),
    h('p.bt-head.bt-head-mid', 'Condition Most Likely Experiencing'),
    h('p.bt-head.bt-head-right', 'Parameters to Monitor'),
    column('actions', 'left'), lines('left', boxCount('actions')),
    column('condition', 'mid'), lines('right', boxCount('parameters')),
    column('parameters', 'right'));
  draw();
  if (review) {
    const names = key => keyOf(key).map(i => q[key].options[i]).join('; ');
    return h('div.bowtie.reviewed', { role: 'group', 'aria-labelledby': labelledBy }, diagram,
      h('div.bt-key',
        h('h3.bt-list-title', 'Correct answers'),
        h('p', h('b', 'Condition: '), names('condition')),
        h('p', h('b', 'Actions to take: '), names('actions')),
        h('p', h('b', 'Parameters to monitor: '), names('parameters'))));
  }
  const lists = h('div.bt-lists', BOWTIE.map(({ key, list }) =>
    h('div.bt-list', h('h3.bt-list-title', list), h('div.bt-opts', { role: 'group', 'aria-label': list }, options[key]))));
  return h('div.bowtie', { role: 'group', 'aria-labelledby': labelledBy }, diagram, lists);
}

// ---------- the types ----------
// label: name shown on the results page
// instruction: default bold line under the stem (a question's "instruction" overrides it)
// help: a lighter line saying how to use the answer controls
// prompt: the message when Continue is pressed before the question is answered
// validate(q): problems in plain words; prepare(q, opts): per-attempt layout
// answered(q, r), score(q, r) -> { earned, max }
// key(q): the correct answer written as a response (the host's answer key)

const TYPES = {
  mc: {
    label: 'Multiple choice',
    validate(q) {
      const problems = checkList(q.options, 'options');
      if (!problems.length && !isIndex(q.answer, q.options.length)) {
        problems.push(`"answer" must be the number of the correct choice, counting from 0 (so 0 to ${q.options.length - 1}).`);
      }
      return problems;
    },
    prepare: (q, o) => ({ options: displayOrder(q.options.length, o.shuffle, o.random) }),
    render: (q, ctx) => choiceList(q, ctx, false),
    answered: (q, r) => Number.isInteger(r),
    score: (q, r) => ({ earned: r === q.answer ? 1 : 0, max: 1 }),
    key: q => q.answer,
  },

  sata: {
    label: 'Select all that apply',
    instruction: 'Select all that apply.',
    validate(q) {
      const problems = checkList(q.options, 'options');
      if (!problems.length) problems.push(...checkPicks(q.answer, q.options.length));
      if (q.scoring != null && q.scoring !== 'partial') problems.push('"scoring" can only be "partial" (or leave it out for all-or-nothing).');
      return problems;
    },
    prepare: (q, o) => ({ options: displayOrder(q.options.length, o.shuffle, o.random) }),
    render: (q, ctx) => choiceList(q, ctx, true),
    answered: (q, r) => Array.isArray(r) && r.length > 0,
    // All-or-nothing by default; "partial" scores +/- per choice.
    score(q, r) {
      if (q.scoring === 'partial') return { earned: plusMinus(r, q.answer), max: q.answer.length };
      const picked = new Set(r ?? []);
      const exact = picked.size === q.answer.length && q.answer.every(i => picked.has(i));
      return { earned: exact ? 1 : 0, max: 1 };
    },
    key: q => [...q.answer].sort((a, b) => a - b),
  },

  emr: {
    label: 'Multiple response (select N)',
    instruction: q => `Select ${q.select}.`,
    prompt: q => `Select ${q.select} answers to continue.`,
    validate(q) {
      const problems = checkList(q.options, 'options');
      if (!problems.length) problems.push(...checkPicks(q.answer, q.options.length));
      if (Array.isArray(q.answer) && q.select !== q.answer.length) problems.push(`"select" must equal the number of answers in "answer" (${q.answer.length}).`);
      return problems;
    },
    prepare: (q, o) => ({ options: displayOrder(q.options.length, o.shuffle, o.random) }),
    render: (q, ctx) => choiceList(q, ctx, true, q.select),
    answered: (q, r) => Array.isArray(r) && r.length === q.select,
    score: (q, r) => ({ earned: (r ?? []).filter(i => q.answer.includes(i)).length, max: q.answer.length }),
    key: q => [...q.answer].sort((a, b) => a - b),
  },

  order: {
    label: 'Ordered response',
    instruction: 'Place the options in the correct order.',
    help: 'Click an option, or drag it, to move it into the Ordered Response box. Use ▲ and ▼ to reorder, and ✕ to remove.',
    prompt: 'Move every option into the Ordered Response box to continue.',
    validate: q => checkList(q.items, 'items'),
    // Always shuffled, and never already in the correct order.
    prepare(q, o) {
      const items = shuffle(range(q.items.length), o.random);
      return { items: items.every((v, i) => v === i) ? [...items.slice(1), items[0]] : items };
    },
    render: orderUI,
    answered: (q, r) => Array.isArray(r) && r.length === q.items.length,
    score: (q, r) => ({ earned: Array.isArray(r) && r.length === q.items.length && r.every((v, i) => v === i) ? 1 : 0, max: 1 }),
    key: q => range(q.items.length),
  },

  fill: {
    label: 'Fill in the blank',
    instruction: q => `Enter a number.${q.round ? ` Round the answer ${q.round}.` : ''}${q.strictZeros ? ' Use a leading zero if it applies. Do not use a trailing zero.' : ''}`,
    prompt: 'Enter a number to continue.',
    validate(q) {
      const problems = [];
      if (typeof q.answer !== 'number' || !Number.isFinite(q.answer)) problems.push('"answer" must be a number, like 0.5 (no quotes).');
      if (q.tolerance != null && !(typeof q.tolerance === 'number' && q.tolerance >= 0)) problems.push('"tolerance" must be a number of 0 or more.');
      if (q.unit != null && typeof q.unit !== 'string') problems.push('"unit" must be text, like "mL".');
      if (q.round != null && typeof q.round !== 'string') problems.push('"round" must be text, like "to the nearest tenth".');
      if (q.strictZeros != null && typeof q.strictZeros !== 'boolean') problems.push('"strictZeros" must be true or false, with no quotes.');
      return problems;
    },
    render: fillUI,
    answered: (q, r) => parseNumber(r) != null,
    // With "strictZeros", the number must also follow the zero rules (zerosOk).
    score: (q, r) => ({ earned: rightValue(q, parseNumber(r)) && (!q.strictZeros || zerosOk(r)) ? 1 : 0, max: 1 }),
    key: q => String(q.answer),
  },

  hotspot: {
    label: 'Hot spot',
    instruction: 'Click the correct location on the image.',
    help: 'Click again to move the marker.',
    prompt: 'Click a location on the image to continue.',
    validate(q) {
      const problems = [];
      if (!isText(q.image)) problems.push('Missing "image" (a path like "img/abdomen.svg" inside the sets folder).');
      if (!isText(q.alt)) problems.push('Missing "alt" (a short description of the image for screen readers).');
      if (!Array.isArray(q.regions) || !q.regions.length) problems.push('"regions" must list at least one correct area, like { "x": 20, "y": 50, "w": 25, "h": 30 }.');
      else q.regions.forEach((g, n) => {
        const ok = g && ['x', 'y', 'w', 'h'].every(k => typeof g[k] === 'number')
          && g.x >= 0 && g.y >= 0 && g.w > 0 && g.h > 0 && g.x + g.w <= 100 && g.y + g.h <= 100;
        if (!ok) problems.push(`Region ${n + 1} must have x, y, w, h as percentages of the image that stay inside 0 to 100.`);
      });
      return problems;
    },
    render: hotspotUI,
    answered: (q, r) => Number.isFinite(r?.x) && Number.isFinite(r?.y),
    score: (q, r) => ({
      earned: r && q.regions.some(g => r.x >= g.x && r.x <= g.x + g.w && r.y >= g.y && r.y <= g.y + g.h) ? 1 : 0,
      max: 1,
    }),
    key: q => ({ x: q.regions[0].x + q.regions[0].w / 2, y: q.regions[0].y + q.regions[0].h / 2 }),
  },

  matrix: {
    label: 'Matrix',
    instruction: q => (q.multiple ? 'Select all that apply in each row.' : 'Select one option in each row.'),
    prompt: q => (q.multiple ? 'Select at least one option in each row to continue.' : 'Select an option in each row to continue.'),
    validate(q) {
      const problems = [...checkList(q.rows, 'rows', 1), ...checkList(q.columns, 'columns')];
      if (q.multiple != null && typeof q.multiple !== 'boolean') problems.push('"multiple" must be true or false (no quotes).');
      if (q.rowHeader != null && typeof q.rowHeader !== 'string') problems.push('"rowHeader" must be text.');
      if (problems.length) return problems;
      if (!Array.isArray(q.answer) || q.answer.length !== q.rows.length) {
        problems.push(`"answer" must have one entry per row (${q.rows.length}).`);
      } else if (q.multiple) {
        q.answer.forEach((a, r) => {
          if (!Array.isArray(a) || !a.every(c => isIndex(c, q.columns.length)) || new Set(a).size !== a.length) {
            problems.push(`answer[${r}] must be a list of column numbers from 0 to ${q.columns.length - 1}, like [0, 1].`);
          }
        });
      } else if (!q.answer.every(c => isIndex(c, q.columns.length))) {
        problems.push(`Each entry in "answer" must be a column number from 0 to ${q.columns.length - 1}.`);
      }
      return problems;
    },
    render: matrixUI,
    answered: (q, r) => Array.isArray(r) && q.rows.every((_, i) => (q.multiple ? r[i]?.length > 0 : Number.isInteger(r[i]))),
    // Single: 1 point per row. Multiple: +/- per row, never below 0.
    score(q, r) {
      if (!q.multiple) return { earned: q.rows.filter((_, i) => r?.[i] === q.answer[i]).length, max: q.rows.length };
      return {
        earned: q.rows.reduce((sum, _, i) => sum + plusMinus(r?.[i], q.answer[i]), 0),
        max: q.answer.reduce((sum, a) => sum + a.length, 0),
      };
    },
    key: q => q.answer.map(a => (Array.isArray(a) ? [...a].sort((x, y) => x - y) : a)),
  },

  dropdown: {
    label: 'Drop-down',
    instruction: 'Select an option from each drop-down list.',
    prompt: 'Select an option from each drop-down list to continue.',
    validate(q) {
      if (!isText(q.text)) return ['Missing "text" (the sentence, with {{0}}, {{1}} where the drop-down lists go).'];
      if (!Array.isArray(q.blanks) || !q.blanks.length) return ['"blanks" must be a list with one entry per drop-down list.'];
      const problems = checkMarkers(q.text, q.blanks.length);
      q.blanks.forEach((b, n) => {
        const list = checkList(b?.options, `blanks[${n}].options`);
        problems.push(...list);
        if (!list.length && !isIndex(b.answer, b.options.length)) problems.push(`blanks[${n}].answer must be a choice number from 0 to ${b.options.length - 1}.`);
      });
      return problems;
    },
    render: dropdownUI,
    answered: (q, r) => Array.isArray(r) && q.blanks.every((_, n) => Number.isInteger(r[n])),
    score: (q, r) => ({ earned: q.blanks.filter((b, n) => r?.[n] === b.answer).length, max: q.blanks.length }),
    key: q => q.blanks.map(b => b.answer),
  },

  dragdrop: {
    label: 'Drag and drop',
    instruction: 'Drag an option into each blank.',
    help: 'You can also click an option and then click a blank. Click a filled blank to empty it.',
    prompt: 'Fill each blank to continue.',
    validate(q) {
      if (!isText(q.text)) return ['Missing "text" (the sentence, with {{0}}, {{1}} where the blanks go).'];
      const problems = checkList(q.tokens, 'tokens');
      if (problems.length) return problems;
      problems.push(...checkPicks(q.answer, q.tokens.length));
      if (Array.isArray(q.answer)) problems.push(...checkMarkers(q.text, q.answer.length));
      return problems;
    },
    prepare: (q, o) => ({ tokens: displayOrder(q.tokens.length, o.shuffle, o.random) }),
    render: dragdropUI,
    answered: (q, r) => Array.isArray(r) && q.answer.every((_, n) => Number.isInteger(r[n])),
    score: (q, r) => ({ earned: q.answer.filter((t, n) => r?.[n] === t).length, max: q.answer.length }),
    key: q => [...q.answer],
  },

  highlight: {
    label: 'Highlight',
    // The stem usually says what to highlight ("Click to highlight the findings that...").
    help: 'Click a word or phrase to highlight it. Click it again to remove the highlight.',
    prompt: 'Highlight at least one item to continue.',
    validate(q) {
      if (!isText(q.passage)) return ['Missing "passage" (the text, with [[ ]] around each phrase students can highlight).'];
      const problems = [];
      const parts = highlightParts(q.passage);
      if (!parts) problems.push('The "passage" has a [[ without a matching ]] (or the other way around).');
      else {
        const count = parts.filter(p => p.phrase != null).length;
        if (!count) problems.push('The "passage" has no [[phrases]] to highlight.');
        else problems.push(...checkPicks(q.answer, count));
      }
      if (/<(?!br\s*\/?>)[a-z/!]/i.test(q.passage)) problems.push('The "passage" can only hold plain text and <br> line breaks.');
      return problems;
    },
    render: highlightUI,
    answered: (q, r) => Array.isArray(r) && r.length > 0,
    score: (q, r) => ({ earned: plusMinus(r, q.answer), max: q.answer.length }),
    key: q => [...q.answer].sort((a, b) => a - b),
  },

  bowtie: {
    label: 'Bow tie',
    instruction: q => `Complete the diagram to show the condition the client is most likely experiencing, ${q.actions.answer.length} actions the nurse should take to address that condition, and ${q.parameters.answer.length} parameters the nurse should monitor to assess the client's progress.`,
    help: 'Click an option below to place it in a box. Click a filled box to clear it.',
    prompt: 'Fill every box in the diagram to continue.',
    validate(q) {
      const problems = [];
      for (const key of ['condition', 'actions', 'parameters']) {
        const g = q[key];
        if (!g || typeof g !== 'object') {
          problems.push(`Missing "${key}" ({ "options": [...], "answer": ... }).`);
          continue;
        }
        const list = checkList(g.options, `${key}.options`);
        problems.push(...list);
        if (list.length) continue;
        if (key === 'condition') {
          if (!isIndex(g.answer, g.options.length)) problems.push(`condition.answer must be a choice number from 0 to ${g.options.length - 1}.`);
        } else {
          problems.push(...checkPicks(g.answer, g.options.length, `${key}.answer`));
          if (g.select != null && g.select !== g.answer?.length) problems.push(`${key}.select must equal the number of answers in ${key}.answer.`);
        }
      }
      return problems;
    },
    prepare: (q, o) => ({
      actions: displayOrder(q.actions.options.length, o.shuffle, o.random),
      condition: displayOrder(q.condition.options.length, o.shuffle, o.random),
      parameters: displayOrder(q.parameters.options.length, o.shuffle, o.random),
    }),
    render: bowtieUI,
    answered: (q, r) => Number.isInteger(r?.condition)
      && ['actions', 'parameters'].every(key => q[key].answer.every((_, s) => Number.isInteger(r[key]?.[s]))),
    // 1 point per correct box.
    score(q, r) {
      const hits = key => (r?.[key] ?? []).filter(i => q[key].answer.includes(i)).length;
      return {
        earned: (r?.condition === q.condition.answer ? 1 : 0) + hits('actions') + hits('parameters'),
        max: 1 + q.actions.answer.length + q.parameters.answer.length,
      };
    },
    key: q => ({ condition: q.condition.answer, actions: [...q.actions.answer], parameters: [...q.parameters.answer] }),
  },
};

const valueFor = (v, q) => (typeof v === 'function' ? v(q) : v);

export const QUESTION_TYPES = Object.keys(TYPES);

export const typeLabel = type => TYPES[type]?.label ?? type;

export const instructionFor = q => q.instruction ?? valueFor(TYPES[q.type].instruction, q) ?? '';

export const helpFor = q => TYPES[q.type].help ?? '';

export const unansweredMessage = q => valueFor(TYPES[q.type].prompt, q) ?? 'Select an answer to continue.';

// Per-attempt layout, such as shuffled choices. Saved with the attempt.
// opts: { shuffle, random } (group study passes a seeded random).
export const prepareItem = (q, opts = {}) => TYPES[q.type].prepare?.(q, { random: Math.random, ...opts }) ?? {};

// ctx: { response, layout, locked, review, labelledBy, onChange(response) }
export const renderItem = (q, ctx = {}) => TYPES[q.type].render(q, ctx);

export const isAnswered = (q, r) => r != null && TYPES[q.type].answered(q, r);

// The correct answer as a response, for showing the answer key in the normal controls.
export const keyResponse = q => TYPES[q.type].key(q);

export const scoreItem = (q, r) => TYPES[q.type].score(q, r);

// Checks a whole set file (SPEC 5.3). Returns a list of
// { question, qid, problem }: the question's position in the file (1, 2, ...)
// and its id when the problem is inside one question, and the problem in
// plain words. An empty list means the set is fine.
export function validateSet(set) {
  const problems = [];
  const add = (problem, question = null, qid = null) => problems.push({ question, qid, problem });

  if (!set || typeof set !== 'object' || Array.isArray(set)) {
    add('The file should hold one question set: an object that starts with { and ends with }.');
    return problems;
  }
  if (!isText(set.id)) add('The set is missing its "id" (a short name like "cardio-unit-2").');
  if (!isText(set.title)) add('The set is missing its "title" (the name students see on the homepage).');
  if (set.description != null && typeof set.description !== 'string') add('"description" must be text.');
  if (set.timeMinutes != null && !(typeof set.timeMinutes === 'number' && set.timeMinutes > 0)) add('"timeMinutes" must be a number greater than 0, with no quotes.');
  if (set.hidden != null && typeof set.hidden !== 'boolean') add('"hidden" must be true or false, with no quotes.');
  if (set.defaultCount != null && !(Number.isInteger(set.defaultCount) && set.defaultCount >= 1)) {
    add('"defaultCount" must be a whole number of questions, like 25, with no quotes.');
  }
  // The class and exam (SPEC 11). Whether the class exists is checked in sets.js.
  if (set.course != null && !isText(set.course)) add('"course" must be text: a class code from sets/courses.json, like "NU1110".');
  if (set.exam != null && !isText(set.exam)) add('"exam" must be text: the exam or unit the set is for, like "Exam 2".');
  else if (isText(set.course) && set.exam == null) add('The set has a "course" but no "exam". Add the exam or unit it is for, like "exam": "Exam 2".');
  if (set.cases != null && (typeof set.cases !== 'object' || Array.isArray(set.cases))) {
    add('"cases" must be an object that holds the case studies.');
  } else {
    for (const [key, c] of Object.entries(set.cases ?? {})) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        add(`Case study "${key}" is not written as an object { ... }.`);
        continue;
      }
      if (c.intro != null && typeof c.intro !== 'string') add(`Case study "${key}": "intro" must be text.`);
      if (!Array.isArray(c.tabs) || !c.tabs.length) add(`Case study "${key}" needs a "tabs" list with at least one exhibit.`);
      else c.tabs.forEach((tab, i) => {
        if (!isText(tab?.html)) add(`Case study "${key}", tab ${i + 1}: missing "html" (the exhibit's content).`);
        if (tab?.title != null && typeof tab.title !== 'string') add(`Case study "${key}", tab ${i + 1}: "title" must be text.`);
      });
    }
  }
  if (!Array.isArray(set.questions) || !set.questions.length) {
    add('The set has no "questions" list, or the list is empty.');
    return problems;
  }

  const seen = new Set();
  set.questions.forEach((q, i) => {
    const note = problem => add(problem, i + 1, isText(q?.id) ? q.id : null);
    if (isText(q?.id) && seen.has(q.id)) note(`Another question already uses the id "${q.id}". Each id must be different.`);
    else if (isText(q?.id)) seen.add(q.id);
    validateQuestion(q, set.cases).forEach(note);
  });
  // Topic weights (SPEC 11.3): how an exam's questions are split across the
  // topics, like a blueprint's counts, whatever the size of each topic's pool.
  if (set.topicWeights != null) {
    const weights = set.topicWeights;
    if (typeof weights !== 'object' || Array.isArray(weights)) {
      add('"topicWeights" must give each topic a number, like { "Safety": 10, "Pharmacology": 8 }.');
    } else {
      const topics = new Set(set.questions.map(q => q?.topic).filter(isText));
      for (const [topic, n] of Object.entries(weights)) {
        if (!(typeof n === 'number' && n >= 0)) add(`"topicWeights": the weight for "${topic}" must be a number of 0 or more, with no quotes.`);
        if (!topics.has(topic)) add(`"topicWeights" names "${topic}", but no question has that topic. Check the spelling.`);
      }
      for (const topic of topics) if (!(topic in weights)) add(`"topicWeights" has no weight for the topic "${topic}". Give every topic a weight.`);
      if (!Object.values(weights).some(n => n > 0)) add('"topicWeights" needs at least one weight greater than 0.');
    }
  }
  return problems;
}

// Checks one question (SPEC 5.3). cases: the set's case studies, for "case".
// Returns its problems in plain words.
export function validateQuestion(q, cases = {}) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return ['This question is not written as an object { ... }.'];
  const problems = [];
  const note = problem => problems.push(problem);
  if (typeof q.id === 'number') note('"id" must be text in quotes, like "q1".');
  else if (!isText(q.id)) note('Missing "id" (a short name for the question, like "q1").');
  const type = TYPES[q.type];
  if (!type) note(q.type ? `Unknown question type "${q.type}". Use one of: ${QUESTION_TYPES.join(', ')}.` : `Missing "type" (one of: ${QUESTION_TYPES.join(', ')}).`);
  const needed = {
    topic: 'the topic name used on the results page',
    stem: 'the question text',
    rationale: 'the explanation students see after answering',
  };
  for (const [field, what] of Object.entries(needed)) {
    if (!isText(q[field])) note(`Missing "${field}" (${what}).`);
  }
  if (q.case != null && !(cases && Object.hasOwn(cases, q.case))) note(`"case" is "${q.case}", but "cases" has no case study with that name.`);
  if (q.instruction != null && typeof q.instruction !== 'string') note('"instruction" must be text.');
  if (q.hidden != null && typeof q.hidden !== 'boolean') note('"hidden" must be true or false, with no quotes.');
  if (!type) return problems;
  try {
    type.validate(q).forEach(note);
  } catch {
    note(`This ${type.label.toLowerCase()} question couldn't be checked. Compare it with a working question of the same type.`);
  }
  return problems;
}
