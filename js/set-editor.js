// The host console's Question sets pages (SPEC 11.3):
// - #/host/sets: every set by class, with Edit (name, description, class,
//   exam, questions per exam, shown or hidden), Questions, and Preview; plus
//   New set and Download a backup.
// - #/host/sets/<set id>: a set's questions. Changes go into a draft,
//   /setDrafts/<set id>, which only the host can read, until Publish changes
//   copies it into /setInfo/<set id> (questions and cases, as JSON text). The
//   first change to a set whose questions come from its file starts the draft
//   from the file's; the file stays as a backup. Every question type can be
//   written and edited here, and so can case studies (their exhibits). The
//   questions can be put in order. Pictures uploaded for hot spot questions
//   go into /setImages/<id> together with the draft, and are deleted when
//   nothing uses them any more.
import { h, fill, modal, toast } from './util.js';
import { problemText } from './firebase.js';
import { typeLabel, validateSet, validateQuestion, keyResponse, highlightParts, showPicture, rememberPicture } from './items.js';
import { defaultCount, questionParts, questionArea, feedbackPanel, startExam, activeExam, DEFAULT_SETTINGS, PRESETS } from './exam.js';
import { LIMITS, readChanges, readDrafts, withChanges, keepChanges, pictureIds } from './set-changes.js';
import { arrange, newestSet, orderTools, dragSort, moved, readOrder, keepOrder } from './order.js';
import { formatSize } from './study-guides.js';

// The types this editor writes, and the fields each one's form manages.
const MANAGED = {
  mc: ['options', 'answer'],
  sata: ['options', 'answer', 'scoring'],
  emr: ['options', 'answer', 'select'],
  fill: ['answer', 'unit', 'round', 'tolerance', 'strictZeros'],
  order: ['items'],
  matrix: ['rows', 'columns', 'answer', 'multiple', 'rowHeader'],
  dropdown: ['text', 'blanks'],
  hotspot: ['image', 'alt', 'regions'],
  highlight: ['passage', 'answer'],
  dragdrop: ['text', 'tokens', 'answer'],
  bowtie: ['condition', 'actions', 'parameters'],
};
const EDITABLE = Object.keys(MANAGED);
const FIELD_NAMES = { title: 'name', description: 'description', course: 'class', exam: 'exam', defaultCount: 'questions per exam', hidden: 'shown or hidden' };
const DETAILS = Object.keys(FIELD_NAMES);

const isText = v => typeof v === 'string' && v.trim() !== '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const visible = questions => questions.filter(q => !q.hidden);

// The plain text of some HTML (a <template> doesn't load its pictures).
function plainText(html) {
  const t = document.createElement('template');
  t.innerHTML = String(html ?? '');
  return t.content.textContent.replace(/\s+/g, ' ').trim();
}

// The question text and rationale are kept as HTML. In the text boxes, a
// blank line starts a new paragraph and line breaks are kept; tags like <b>
// show as typed, and a < that doesn't start one stays a < sign.
const TAGS = 'b|i|u|em|strong|br|p|sub|sup|img|span|ul|ol|li|table|thead|tbody|tr|th|td|h4';
function toText(html) {
  return String(html ?? '')
    .replace(/\s*<\/p>\s*<p>\s*/gi, '\n\n')
    .replace(/^\s*<p>\s*|\s*<\/p>\s*$/gi, '')
    .replace(/<br\s*\/?>\n?/gi, '\n')
    .replace(/&lt;/g, '<');
}
const safeHtml = text => text.replace(new RegExp(`<(?!/?(?:${TAGS})\\b)`, 'gi'), '&lt;');
function toHtml(text) {
  const paragraphs = safeHtml(text.trim()).split(/\n\s*\n/).map(p => p.trim().replace(/\n/g, '<br>')).filter(Boolean);
  return paragraphs.length > 1 ? paragraphs.map(p => `<p>${p}</p>`).join('') : paragraphs[0] ?? '';
}

// A case study exhibit as text for the form, and back. The tab's title is the
// exhibit's heading, so it isn't in the text (heading: whether the exhibit
// starts with it). A blank line starts a paragraph, and a simple table is
// rows of cells with | between them, the first row being the heading row.
// Anything else (a list, or a table with joined cells) stays as its HTML.
function exhibitToText(html, title) {
  const t = document.createElement('template');
  t.innerHTML = String(html ?? '').trim();
  const nodes = [...t.content.childNodes].filter(n => n.nodeType === 1 || n.textContent.trim());
  const heading = nodes[0]?.nodeName === 'H4' && nodes[0].textContent.trim() === String(title ?? '').trim();
  if (heading) nodes.shift();
  const blocks = nodes.map(n => {
    if (n.nodeType !== 1) return n.textContent.trim();
    if (n.nodeName === 'P' && !n.attributes.length) return toText(n.innerHTML);
    if (n.nodeName === 'TABLE') return tableToText(n) ?? n.outerHTML;
    return n.outerHTML;
  });
  return { text: blocks.join('\n\n'), heading };
}

// "Vital sign | 0800\nPulse | 88/min", or null for a table that can't be written that way.
function tableToText(table) {
  if (table.attributes.length || table.caption || table.tFoot || table.tBodies.length > 1 || table.tHead?.rows.length !== 1) return null;
  if (table.querySelector('table, [colspan], [rowspan], [class], [style], [id]')) return null;
  const rows = [...table.rows];
  if (rows[0].parentNode !== table.tHead) return null;
  const lines = [];
  for (const [i, row] of rows.entries()) {
    const cells = [...row.cells];
    if (cells.length < 2 || cells.some(c => (c.nodeName === 'TH') !== (i === 0) || !c.innerHTML.trim() || /\||<br|\n/i.test(c.innerHTML))) return null;
    lines.push(cells.map(c => toText(c.innerHTML).trim()).join(' | '));
  }
  return lines.join('\n');
}

function exhibitToHtml(text, title, heading = true) {
  const blocks = text.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const body = blocks.map(block => {
    // A table: | between the cells, or tabs (a table pasted from Word or Excel).
    const lines = block.split('\n').map(l => l.replace(/^ +| +$/g, ''));
    const cut = lines.every(l => l.includes('|')) ? '|' : lines.every(l => l.includes('\t')) ? '\t' : null;
    if (cut) {
      const rows = lines.map(l => (cut === '|' ? l.trim().replace(/^\||\|$/g, '') : l).split(cut).map(c => safeHtml(c.trim())));
      const head = `<thead><tr>${rows[0].map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
      const rest = rows.length > 1 ? `<tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>` : '';
      return `<table>${head}${rest}</table>`;
    }
    if (/^<(table|ul|ol|h4|p)\b/i.test(block)) return safeHtml(block);
    return `<p>${safeHtml(block).replace(/\n/g, '<br>')}</p>`;
  }).join('');
  const name = title.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `${heading && name ? `<h4>${name}</h4>` : ''}${body}`;
}

// JSON with every object's keys in order, so two copies of a question compare
// equal however their fields were written.
const stable = value => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

// Database deletes for the uploaded pictures in ids that aren't in keep.
const forget = (ids, keep = new Set()) => Object.fromEntries([...ids].filter(id => !keep.has(id)).map(id => [`setImages/${id}`, null]));

// Text cut to a whole word near `most` characters, with "…" when it's cut.
const shorten = (text, most) => (text.length <= most ? text : `${text.slice(0, most).replace(/\s+\S*$/, '')}…`);

// [3, 4, 5, 9] -> "3–5 and 9"
function numberRanges(list) {
  const runs = [];
  for (const n of list) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const words = runs.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`));
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? '';
}

// A new question's id, numbered after the set's: "pn3-51" after "pn3-50",
// or "<set id>-q1" when the ids don't end in numbers.
function nextId(setId, questions) {
  const taken = new Set(questions.map(q => q.id));
  const numbered = questions.map(q => /^(.*?)(\d+)$/.exec(q.id ?? '')).filter(Boolean);
  const counts = new Map();
  for (const [, prefix] of numbered) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  const prefix = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${setId}-q`;
  const same = numbered.filter(m => m[1] === prefix);
  const width = Math.max(1, ...same.map(m => m[2].length));
  let n = Math.max(0, ...same.map(m => Number(m[2]))) + 1;
  let id;
  do id = `${prefix}${String(n++).padStart(width, '0')}`;
  while (taken.has(id));
  return id;
}

// A short id for a new set, from its class and name: "nu1110-pharmacology-review".
function newSetId(title, course, taken) {
  const slug = `${course ? `${course}-` : ''}${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'set';
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
  return id;
}

// Saves text as a file on the host's computer.
function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = h('a', { href: url, download: name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- #/host/sets: every set, in the order students see them ----------

// sets: the way their files have them (from loadSets). Returns a function that stops it.
export function setsConsole(section, db, { sets, courses }, accountLine) {
  document.title = 'Question sets · Host console';
  let changes = {};
  let drafts = {};
  let order = {};
  let raw = { setInfo: null, setDrafts: null }; // for the backup, exactly as the database has it
  let loaded = 0; // 1: /setInfo, 2: /setDrafts, 4: /order; 7: all three
  let listProblem = null;
  let editing = null; // { id, el }: the set whose details are being changed
  const listArea = h('div.set-admin', h('p.lead', 'Loading the question sets…'));
  const newArea = h('div');
  const all = () => withChanges(sets, changes, courses, { keepHidden: true });

  // The order students see a class's sets in (SPEC 11.4); null for newest first.
  async function saveOrder(key, keys) {
    try {
      await db.update(`order/${key}`, { sets: keys ? JSON.stringify(keys) : null });
    } catch (err) {
      toast(`The order wasn't saved. ${problemText(err)}`, 9000);
    }
  }

  // tools: the grip and ▲ ▼ for this row (none while a set's details are open).
  function setItem(set, forStudents, tools) {
    if (editing?.id === set.id) return editing.el;
    const shown = visible(set.questions);
    const hidden = set.questions.length - shown.length;
    const n = defaultCount({ ...set, questions: shown });
    const c = changes[set.id] ?? {};
    const flags = [
      set.hidden ? h('b', 'Hidden from students') : null,
      set.made ? 'Made here' : null,
      !set.made && DETAILS.some(k => k in c) ? `Changed here: ${DETAILS.filter(k => k in c).map(k => FIELD_NAMES[k]).join(', ')}` : null,
      !set.made && set.edited ? 'Questions edited here' : null,
      drafts[set.id] ? h('b', 'Draft not published yet') : null,
    ].filter(Boolean);
    return h('li.set-row', { 'data-key': set.id },
      tools,
      h('div.set-info',
        set.exam ? h('p.set-exam', h('span.tag', set.exam)) : null,
        h('h3', set.title),
        set.description ? h('p.set-desc', set.description) : null,
        h('p.set-meta', shown.length
          ? `${plural(shown.length, 'question')}${hidden ? ` (and ${hidden} hidden)` : ''} · ${n ? `${n} per exam` : 'every question in each exam'}`
          : 'No questions yet'),
        flags.length ? h('p.set-meta.set-flags', flags.flatMap((f, i) => (i ? [' · ', f] : [f]))) : null),
      h('div.set-actions',
        h('button.btn', { type: 'button', 'aria-label': `Edit ${set.title}`, onclick: () => edit(set) }, 'Edit'),
        h('a.btn', { href: `#/host/sets/${encodeURIComponent(set.id)}`, 'aria-label': `Questions in ${set.title}` }, 'Questions'),
        forStudents.has(set.id) ? h('a.btn', { href: `#/setup/${encodeURIComponent(set.id)}`, 'aria-label': `Preview ${set.title}` }, 'Preview') : null));
  }

  function paintList() {
    if (listProblem) {
      fill(listArea, h('p.notice', problemText(listProblem)));
      return;
    }
    if (loaded !== 7) return;
    const list = all();
    const forStudents = new Set(withChanges(sets, changes, courses).map(s => s.id));
    const groups = courses.map(c => ({ key: c.code, label: `${c.code} · ${c.name}`, list: list.filter(s => s.course === c.code) }));
    const other = list.filter(s => !courses.some(c => c.code === s.course));
    if (other.length || !courses.length) groups.push({ key: 'other', label: courses.length ? 'Other' : 'Question sets', list: other });
    fill(listArea, groups.map(g => {
      // In the order students see them; drag a set's grip, or use ▲ ▼, to move it.
      const ordered = arrange(g.list, s => s.id, order[g.key]?.sets, newestSet);
      const keys = ordered.map(s => s.id);
      const canMove = ordered.length > 1 && !editing;
      const ul = h('ul.set-list', { class: canMove ? 'orderable' : null }, ordered.map((s, i) => setItem(s, forStudents,
        canMove ? orderTools(s.title, i, ordered.length, to => saveOrder(g.key, moved(keys, i, to))) : null)));
      if (canMove) dragSort(ul, next => saveOrder(g.key, next));
      return h('section.set-class',
        h('div.set-class-head',
          h('h2.set-class-title', g.label),
          h('span.set-class-links',
            order[g.key]?.sets ? h('button.link-btn', { type: 'button', onclick: () => saveOrder(g.key, null) }, 'Newest first') : null,
            courses.length ? h('a.link-btn', { href: `#/class/${encodeURIComponent(g.key)}` }, 'See it as students do') : null)),
        ordered.length ? ul : h('p.empty-note', 'No question sets for this class yet.'));
    }));
  }

  // The class select and exam box shared by the New set and Edit forms.
  function classAndExam(prefix, course, exam) {
    const cls = h(`select.text-input#${prefix}-class`,
      courses.map(c => h('option', { value: c.code, selected: c.code === course }, `${c.code} · ${c.name}`)),
      h('option', { value: '', selected: !course }, courses.length ? 'Other (no class)' : 'No class'));
    const exams = h(`datalist#${prefix}-exams`);
    const examBox = h(`input.text-input#${prefix}-exam`, { type: 'text', maxlength: String(LIMITS.exam), list: `${prefix}-exams`, value: exam ?? '', autocomplete: 'off' });
    // Exams already used in the chosen class, as suggestions.
    const suggest = () => fill(exams, [...new Set(all().filter(s => (s.course ?? '') === cls.value).map(s => s.exam).filter(isText))]
      .sort(naturally).map(e => h('option', { value: e })));
    cls.addEventListener('change', suggest);
    suggest();
    return { cls, exam: examBox, exams };
  }

  // A new set: its details now; its questions on its own page.
  function newSet() {
    const title = h('input.text-input#new-title', { type: 'text', maxlength: String(LIMITS.title) });
    const { cls, exam, exams } = classAndExam('new', courses[0]?.code ?? '', '');
    const desc = h('textarea.text-input#new-desc', { rows: '2', maxlength: String(LIMITS.description) });
    const note = h('p.form-problem', { role: 'alert' });
    const create = h('button.btn.btn-accent', { type: 'submit' }, 'Create set');
    const fail = (text, field) => {
      note.textContent = text;
      field?.focus();
    };
    const form = h('form.host-card.new-set-form', {
      'aria-label': 'New set',
      novalidate: true,
      onsubmit: async e => {
        e.preventDefault();
        note.textContent = '';
        const details = { title: title.value.trim(), course: cls.value, exam: exam.value.trim(), description: desc.value.trim() };
        if (!details.title) return fail('Type a name for the set.', title);
        if (details.course && !details.exam) return fail('Type which exam or unit it\'s for, like "Exam 4". A set in a class needs one.', exam);
        const id = newSetId(details.title, details.course, new Set([...sets.map(s => s.id), ...Object.keys(changes)]));
        const record = { title: details.title, created: true, createdAt: db.serverTime(), editedAt: db.serverTime() };
        for (const key of ['course', 'exam', 'description']) if (details[key]) record[key] = details[key];
        create.disabled = true;
        try {
          await db.write(`setInfo/${id}`, record);
          toast('Created. Now add its questions.');
          location.hash = `#/host/sets/${encodeURIComponent(id)}`;
        } catch (err) {
          fail(`It wasn't created. ${problemText(err)}`);
          create.disabled = false;
        }
      },
    },
      h('h2.section-title', 'New set'),
      h('div.editor-grid',
        h('div.field', h('label.field-label', { for: 'new-title' }, 'Name'), title),
        h('div.field', h('label.field-label', { for: 'new-class' }, 'Class'), cls),
        h('div.field', h('label.field-label', { for: 'new-exam' }, 'Exam or unit'), exam, exams),
        h('div.field.wide', h('label.field-label', { for: 'new-desc' }, 'Description ', h('span.optional', '(optional)')), desc)),
      h('p.field-help', 'Students don\'t see the set until you publish its first questions.'),
      note,
      h('div.form-actions', create, h('button.btn', { type: 'button', onclick: () => fill(newArea) }, 'Cancel')));
    form.addEventListener('input', () => (note.textContent = ''));
    fill(newArea, form);
    title.focus();
  }

  // Everything changed on the console, as a file: the sets the way students see
  // them (with hidden questions), the drafts, the pictures uploaded for their
  // hot spot questions, and the database's exact copy.
  async function backup() {
    const strip = ({ file, made, edited, ...set }) => set;
    const saved = all().filter(s => changes[s.id] || drafts[s.id]).map(strip);
    const ids = new Set([...saved, ...Object.values(drafts)].flatMap(s => [...pictureIds(s.questions)]));
    const pictures = {};
    for (const id of ids) {
      try {
        pictures[id] = await db.read(`setImages/${id}`);
      } catch {
        pictures[id] = null;
      }
    }
    const data = {
      backup: 'Practice Exam Center: question sets changed on the host console',
      savedAt: new Date().toISOString(),
      sets: saved,
      drafts,
      pictures,
      firebase: raw,
    };
    saveFile(`question-sets-backup-${new Date().toISOString().slice(0, 10)}.json`, `${JSON.stringify(data, null, 2)}\n`);
  }

  // Change a set's details. For a set from a file, only what differs from the
  // file is saved, so later changes to the file still show.
  function edit(set) {
    const file = sets.find(s => s.id === set.id);
    const shown = visible(set.questions);
    const total = shown.length;
    const n = defaultCount({ ...set, questions: shown });
    const title = h('input.text-input#set-title', { type: 'text', maxlength: String(LIMITS.title), value: set.title });
    const desc = h('textarea.text-input#set-desc', { rows: '3', maxlength: String(LIMITS.description), value: set.description ?? '' });
    const { cls, exam, exams } = classAndExam('set', set.course, set.exam);
    const every = h('input.ctl#set-every', { type: 'radio', name: 'set-count', checked: !n });
    const some = h('input.ctl', { type: 'radio', name: 'set-count', checked: !!n, disabled: total < 2, 'aria-label': 'This many questions' });
    const count = h('input.num-input#set-count', {
      type: 'number', min: '1', max: String(Math.max(1, total - 1)), step: '1', inputmode: 'numeric', value: String(n ?? Math.min(25, Math.max(1, total - 1))), disabled: total < 2,
    });
    count.addEventListener('input', () => (some.checked = true));
    const shownBox = h('input.ctl#set-shown', { type: 'checkbox', checked: !set.hidden });
    const note = h('p.form-problem', { role: 'alert' });
    const save = h('button.btn.btn-accent', { type: 'submit' }, 'Save');
    const c = changes[set.id] ?? {};

    const done = () => {
      editing = null;
      paintList();
    };
    const fail = (text, field) => {
      note.textContent = text;
      field?.focus();
    };

    // Put the details back the way the file has them (questions changed here stay).
    async function undo() {
      const choice = await modal({
        title: 'Undo Your Changes?',
        message: `${file.title} goes back to the way its file has it: the name, description, class, exam, questions per exam, and whether students see it.`,
        buttons: [{ label: 'Keep my changes', value: 'keep', accent: true }, { label: 'Undo changes', value: 'undo' }],
      });
      if (choice !== 'undo') return;
      try {
        if (c.questions) await db.update(`setInfo/${set.id}`, Object.fromEntries(DETAILS.map(k => [k, null])));
        else await db.write(`setInfo/${set.id}`, null);
        toast('Done. It looks the way its file has it again.');
        done();
      } catch (err) {
        note.textContent = `It didn't change. ${problemText(err)}`;
      }
    }

    // A set made here: deleted with its questions and draft.
    async function remove() {
      const choice = await modal({
        title: 'Delete This Set?',
        message: `${set.title} and its questions disappear from the site for everyone. This can't be undone. Download a backup first if you might want it later.`,
        buttons: [{ label: 'Keep it', value: 'keep', accent: true }, { label: 'Delete set', value: 'delete' }],
      });
      if (choice !== 'delete') return;
      const pictures = new Set([...pictureIds(changes[set.id]?.questions), ...pictureIds(drafts[set.id]?.questions)]);
      try {
        await db.update('', { [`setInfo/${set.id}`]: null, [`setDrafts/${set.id}`]: null, ...forget(pictures) });
        toast('Deleted.');
        done();
      } catch (err) {
        note.textContent = `It wasn't deleted. ${problemText(err)}`;
      }
    }

    const el = h('li.set-editor', h('form', {
      'aria-label': `Edit ${set.title}`,
      novalidate: true, // the messages below say what's wrong in plain words
      onsubmit: async e => {
        e.preventDefault();
        note.textContent = '';
        const want = {
          title: title.value.trim(),
          description: desc.value.trim(),
          course: cls.value,
          exam: exam.value.trim(),
          defaultCount: some.checked ? Number(count.value) : 0,
          hidden: !shownBox.checked,
        };
        if (!want.title) return fail('Type a name for the set.', title);
        if (want.course && !want.exam) return fail('Type which exam or unit it\'s for, like "Exam 3". A set in a class needs one.', exam);
        if (some.checked && !(Number.isInteger(want.defaultCount) && want.defaultCount >= 1 && want.defaultCount < total)) {
          return fail(`Type a whole number from 1 to ${total - 1}, or choose every question.`, count);
        }
        const before = file
          ? { title: file.title.trim(), description: (file.description ?? '').trim(), course: file.course ?? '', exam: (file.exam ?? '').trim(), defaultCount: defaultCount(file) ?? 0, hidden: !!file.hidden }
          : { title: '', description: '', course: '', exam: '', defaultCount: 0, hidden: false };
        const record = Object.fromEntries(DETAILS.map(k => [k, want[k] !== before[k] ? want[k] : null]));
        const keeps = Object.values(record).some(v => v != null) || c.questions || c.created;
        save.disabled = true;
        try {
          if (keeps) await db.update(`setInfo/${set.id}`, { ...record, editedAt: db.serverTime() });
          else await db.write(`setInfo/${set.id}`, null);
          toast('Saved. Students see it right away.');
          done();
        } catch (err) {
          note.textContent = `It didn't save. ${problemText(err)}`;
          save.disabled = false;
        }
      },
    },
      h('div.editor-grid',
        h('div.field', h('label.field-label', { for: 'set-title' }, 'Name'), title),
        h('div.field', h('label.field-label', { for: 'set-class' }, 'Class'), cls),
        h('div.field.wide', h('label.field-label', { for: 'set-desc' }, 'Description ', h('span.optional', '(optional)')), desc),
        h('div.field', h('label.field-label', { for: 'set-exam' }, 'Exam or unit'), exam, exams),
        h('fieldset.field.count-field',
          h('legend.field-label', 'Questions per exam'),
          h('label.choice-line', every, h('span', `Every question (${total})`)),
          h('div.choice-line', some, count, h('label', { for: 'set-count' }, 'questions')))),
      h('p.field-help', 'Students get this many questions, spread across the topics, when they click Start and Begin in either mode. They can still choose another number under Customize settings.'),
      h('label.choice-line.show-line', shownBox, h('span', 'Show this set on the homepage')),
      note,
      h('div.form-actions',
        save,
        h('button.btn', { type: 'button', onclick: done }, 'Cancel'),
        set.made ? h('button.link-btn', { type: 'button', onclick: remove }, 'Delete this set')
          : DETAILS.some(k => k in c) ? h('button.link-btn', { type: 'button', onclick: undo }, 'Undo my changes') : null)));
    el.addEventListener('input', () => (note.textContent = '')); // a problem goes away once something changes
    editing = { id: set.id, el };
    paintList();
    title.focus();
  }

  const stopInfo = db.watch('setInfo', value => {
    raw.setInfo = value ?? null;
    changes = readChanges(value);
    keepChanges(changes);
    loaded |= 1;
    listProblem = null;
    paintList();
  }, err => {
    listProblem = err;
    paintList();
  });
  const stopDrafts = db.watch('setDrafts', value => {
    raw.setDrafts = value ?? null;
    drafts = readDrafts(value);
    loaded |= 2;
    paintList();
  }, err => {
    listProblem = err;
    paintList();
  });
  const stopOrder = db.watch('order', value => {
    order = readOrder(value);
    keepOrder(order);
    loaded |= 4;
    paintList();
  }, err => {
    listProblem = err;
    paintList();
  });

  fill(section,
    h('h1.page-title', 'Question sets'),
    h('p.lead', 'Change a set\'s name, description, class, or exam, how many questions an exam has, or hide it from students. Click Questions to add, edit, or hide its questions. Drag a set by its grip (⠿), or use ▲ ▼, to change the order students see. Students see your changes right away, with no publishing to GitHub needed.'),
    h('div.console-tools',
      h('button.btn.btn-accent', { type: 'button', onclick: newSet }, 'New set'),
      h('button.btn', { type: 'button', onclick: backup }, 'Download a backup')),
    newArea,
    listArea,
    accountLine());
  return () => {
    stopInfo();
    stopDrafts();
    stopOrder();
  };
}

// ---------- #/host/sets/<set id>: one set's questions ----------

// How a draft differs from what students see: its questions, their order, and
// the case studies.
const bare = q => stable({ ...q, hidden: undefined });
function differences(before, after, casesBefore = {}, casesAfter = {}) {
  const was = new Map(before.map(q => [q.id, q]));
  const now = new Set(after.map(q => q.id));
  const d = { new: 0, changed: 0, hidden: 0, 'shown again': 0, deleted: 0 };
  for (const q of after) {
    const old = was.get(q.id);
    if (!old) d.new++;
    else {
      if (bare(old) !== bare(q)) d.changed++;
      if (!old.hidden && q.hidden) d.hidden++;
      if (old.hidden && !q.hidden) d['shown again']++;
    }
  }
  for (const q of before) if (!now.has(q.id)) d.deleted++;
  const out = Object.entries(d).filter(([, n]) => n).map(([word, n]) => `${n} ${word}`);
  const kept = after.filter(q => was.has(q.id)).map(q => q.id);
  if (kept.join('\n') !== before.filter(q => now.has(q.id)).map(q => q.id).join('\n')) out.push('questions in a new order');
  const c = { new: 0, changed: 0, deleted: 0 };
  for (const key of new Set([...Object.keys(casesBefore), ...Object.keys(casesAfter)])) {
    if (!(key in casesBefore)) c.new++;
    else if (!(key in casesAfter)) c.deleted++;
    else if (stable(casesBefore[key]) !== stable(casesAfter[key])) c.changed++;
  }
  const study = n => (n === 1 ? 'case study' : 'case studies');
  if (c.new) out.push(`${c.new} new ${study(c.new)}`);
  if (c.changed) out.push(`${c.changed} ${study(c.changed)} changed`);
  if (c.deleted) out.push(`${c.deleted} ${study(c.deleted)} deleted`);
  return out;
}

// questionId: a question whose form opens once the page has loaded
// (#/host/sets/<set id>/<question id>, from the Reports page).
export function questionsPage(section, db, { sets, courses }, accountLine, setId, questionId = null) {
  let changes = {};
  let drafts = {};
  let loaded = 0;
  let pageProblem = null;
  let editing = null; // { id (or '' for a new question), el }
  let painted = null;
  const file = sets.find(s => s.id === setId);

  // The set as students see it (with its hidden questions), and the questions
  // being edited: the draft's, or else those.
  function state() {
    const live = withChanges(sets, changes, courses, { keepHidden: true }).find(s => s.id === setId) ?? null;
    const draft = drafts[setId] ?? null;
    return { live, draft, questions: draft?.questions ?? live?.questions ?? [], cases: draft?.cases ?? live?.cases ?? {} };
  }

  // Saves the draft, with any other writes (a picture uploaded for a question).
  // Uploaded pictures that nothing uses any more (neither the draft nor what
  // students see) are deleted with it.
  function saveDraft(questions, cases, extra = {}) {
    const { live, draft } = state();
    const keep = new Set([...pictureIds(live?.questions), ...pictureIds(questions)]);
    return db.update('', {
      [`setDrafts/${setId}`]: { questions: JSON.stringify(questions), cases: JSON.stringify(cases ?? {}), editedAt: db.serverTime() },
      ...extra,
      ...forget(pictureIds(draft?.questions), keep),
    });
  }

  function paint(force = false) {
    if (pageProblem) {
      fill(section, h('h1.page-title', 'Question set'), h('p.notice', problemText(pageProblem)), accountLine());
      return;
    }
    if (loaded !== 3) return;
    const s = state();
    if (questionId) {
      const q = s.questions.find(x => x.id === questionId);
      questionId = null; // only the first time
      if (q) {
        openEditor(q);
        editing?.el.scrollIntoView({ block: 'start' });
        return;
      }
    }
    const key = JSON.stringify([s, editing?.id]);
    if (!force && key === painted) return;
    painted = key;
    const { live, draft, questions, cases } = s;
    const crumb = h('p.crumb', h('a', { href: '#/host/sets' }, '← Question sets'));
    if (!live) {
      document.title = 'Question set not found · Host console';
      fill(section, crumb, h('h1.page-title', 'Question set not found'), h('p', 'This set isn\'t on the site any more.'), accountLine());
      return;
    }
    document.title = `${live.title} · Question sets · Host console`;
    const course = courses.find(c => c.code === live.course);
    fill(section,
      crumb,
      live.exam ? h('p.set-exam', h('span.tag', live.exam)) : null,
      h('h1.page-title', live.title),
      h('p.set-meta.q-page-meta', [course ? `${course.code} · ${course.name}` : 'Other (no class)', plural(visible(questions).length, 'question')].join(' · ')),
      statusBox(live, draft, questions, cases),
      h('div.console-tools',
        h('button.btn.btn-accent', { type: 'button', onclick: () => openEditor(null) }, 'Add a question'),
        h('button.btn', { type: 'button', onclick: () => openCase(null) }, 'Add a case study')),
      editing?.id === '' || editing?.id === 'case:' ? editing.el : null,
      caseList(cases, questions),
      Object.keys(cases).length && questions.length ? h('h2.section-title.q-list-title', 'Questions') : null,
      questions.length ? questionList(questions, live) : h('p.empty-note', 'No questions yet. Click Add a question to write the first one.'),
      sourceNote(live, draft),
      accountLine());
  }

  // The questions in order: drag one by its grip (⠿), or use ▲ ▼, to move it.
  // A case study's questions show in this order too.
  function questionList(questions, live) {
    const canMove = questions.length > 1 && !editing;
    const ids = questions.map(q => q.id);
    const list = h('ol.q-list', { 'aria-label': 'Questions', class: canMove ? 'orderable' : null }, questions.map((q, i) => questionRow(q, i + 1, live,
      canMove ? orderTools(`question ${i + 1}`, i, questions.length, to => reorder(moved(ids, i, to))) : null)));
    if (canMove) dragSort(list, reorder);
    return list;
  }

  async function reorder(ids) {
    const { questions, cases } = state();
    const byId = new Map(questions.map(q => [q.id, q]));
    const next = ids.map(id => byId.get(id)).filter(Boolean);
    if (next.length !== questions.length) return;
    try {
      await saveDraft(next, cases);
    } catch (err) {
      toast(`The order wasn't saved. ${problemText(err)}`, 9000);
    }
  }

  // The case studies: their exhibits, and which questions are in each.
  function caseList(cases, questions) {
    const keys = Object.keys(cases);
    if (!keys.length) return null;
    return h('section.case-studies',
      h('h2.section-title', 'Case studies'),
      h('ul.case-list', keys.map(key => {
        if (editing?.id === `case:${key}`) return editing.el;
        const c = cases[key] ?? {};
        const tabs = (c.tabs ?? []).map((t, i) => t.title || `Exhibit ${i + 1}`);
        const used = questions.flatMap((q, i) => (q.case === key ? [i + 1] : []));
        return h('li.case-row',
          h('div.q-row-info',
            h('p.q-row-head', h('b', key), ` · ${plural(tabs.length, 'exhibit')}: ${tabs.join(', ')} · `,
              used.length ? `${used.length === 1 ? 'question' : 'questions'} ${numberRanges(used)}` : 'no questions yet'),
            c.intro ? h('p.q-row-stem', plainText(c.intro).slice(0, 220)) : null),
          h('div.set-actions',
            h('button.btn', { type: 'button', 'aria-label': `Edit case study ${key}`, onclick: () => openCase(key) }, 'Edit'),
            h('button.btn', { type: 'button', 'aria-label': `Delete case study ${key}`, onclick: () => removeCase(key, used) }, 'Delete')));
      })));
  }

  function openCase(key) {
    const { cases } = state();
    editing = {
      id: `case:${key ?? ''}`,
      el: caseEditor(key, cases, {
        onSave: async (name, study) => {
          const now = state();
          // A renamed case study keeps its place, and its questions follow it.
          const next = {};
          for (const [k, v] of Object.entries(now.cases)) next[k === key ? name : k] = k === key ? study : v;
          if (!key) next[name] = study;
          const questions = key && key !== name ? now.questions.map(q => (q.case === key ? { ...q, case: name } : q)) : now.questions;
          await saveDraft(questions, next);
          editing = null;
          toast(key ? 'Saved in the draft.' : 'Added to the draft. Now add its questions, and choose this case study in each one.', key ? 4000 : 7000);
          paint(true);
        },
        onCancel: () => {
          editing = null;
          paint(true);
        },
      }),
    };
    paint(true);
    editing.el.querySelector('input, textarea')?.focus();
  }

  async function removeCase(key, used) {
    if (used.length) {
      const one = used.length === 1;
      await modal({
        title: 'This Case Study Has Questions',
        message: `${one ? 'Question' : 'Questions'} ${numberRanges(used)} ${one ? 'is' : 'are'} part of it. Take ${one ? 'it' : 'them'} out of the case study (in ${one ? 'its' : 'each'} Edit form), or delete ${one ? 'it' : 'them'}, first.`,
        buttons: [{ label: 'OK', value: 'ok', accent: true }],
      });
      return;
    }
    const choice = await modal({
      title: 'Delete This Case Study?',
      message: `The case study "${key}" and its exhibits are taken out of the draft. Students keep seeing them until you publish.`,
      buttons: [{ label: 'Keep it', value: 'keep', accent: true }, { label: 'Delete case study', value: 'delete' }],
    });
    if (choice !== 'delete') return;
    const { questions, cases } = state();
    const { [key]: gone, ...rest } = cases;
    try {
      await saveDraft(questions, rest);
    } catch (err) {
      toast(`It wasn't deleted. ${problemText(err)}`, 9000);
    }
  }

  // What students see now, or the draft and how to publish it.
  function statusBox(live, draft, questions, cases) {
    if (!draft) {
      return h('div.draft-box',
        h('p', live.questions.length ? `Students see ${plural(visible(live.questions).length, 'question')}.` : 'This set has no questions yet, so students don\'t see it.',
          ' Changes you make are kept as a draft until you publish them.'));
    }
    const diff = differences(live.questions, questions, live.cases ?? {}, cases ?? {});
    const problems = questions.length ? validateSet({ ...live, questions, cases }) : [{ problem: 'Add at least one question.' }];
    const ownWork = h('input.ctl#q-own-work', { type: 'checkbox' });
    const note = h('p.form-problem', { role: 'alert' });
    const publish = h('button.btn.btn-accent', { type: 'button', disabled: !!problems.length || !diff.length }, 'Publish changes');
    publish.addEventListener('click', async () => {
      note.textContent = '';
      if (!ownWork.checked) {
        note.textContent = 'Tick the box to confirm the questions are your own work.';
        ownWork.focus();
        return;
      }
      publish.disabled = true;
      try {
        await db.update('', {
          [`setInfo/${setId}/questions`]: JSON.stringify(questions),
          [`setInfo/${setId}/cases`]: JSON.stringify(cases ?? {}),
          [`setInfo/${setId}/publishedAt`]: db.serverTime(),
          [`setDrafts/${setId}`]: null,
          ...forget(pictureIds(live.questions), pictureIds(questions)), // pictures students no longer see
        });
        toast('Published. Students see the changes now.');
      } catch (err) {
        note.textContent = `It wasn't published. ${problemText(err)}`;
        publish.disabled = false;
      }
    });
    ownWork.addEventListener('change', () => (note.textContent = ''));
    return h('div.draft-box.has-draft',
      h('p', h('b', 'Draft: '), diff.length ? `${diff.join(', ')}.` : 'the same as what students see.', ' Students don\'t see these changes until you publish them.'),
      problems.length ? h('div.draft-problems',
        h('p', h('b', 'Fix these before publishing:')),
        h('ul', problems.map(p => h('li', p.question ? `Question ${p.question}: ` : '', p.problem)))) : null,
      diff.length ? h('label.choice-line.own-work', ownWork,
        h('span', 'These questions are my own work, or Claude wrote them in its own words from my class materials. None are copied from ATI, a test bank, a review book, or a leaked exam.')) : null,
      note,
      h('div.form-actions',
        diff.length ? publish : null,
        visible(questions).length ? h('button.btn', { type: 'button', onclick: tryIt }, 'Try it') : null,
        h('button.btn', { type: 'button', onclick: discard }, 'Discard draft')));
  }

  // tools: the grip and ▲ ▼ for this row (none while a form is open).
  function questionRow(q, n, live, tools) {
    if (editing && editing.id === q.id) return editing.el;
    const old = live.questions.find(x => x.id === q.id);
    const badges = [!old ? 'New' : bare(old) !== bare(q) ? 'Changed' : null, q.hidden ? 'Hidden' : null].filter(Boolean);
    const editable = EDITABLE.includes(q.type);
    return h('li.q-row', { 'data-key': q.id, class: q.hidden ? 'is-hidden' : null },
      tools,
      h('div.q-row-info',
        h('p.q-row-head', h('b', `${n}.`), ` ${typeLabel(q.type)} · ${q.topic}`, q.case ? ` · case study "${q.case}"` : '',
          badges.map(b => h(`span.badge.badge-${b.toLowerCase()}`, b))),
        h('p.q-row-stem', plainText(q.stem).slice(0, 220))),
      h('div.set-actions',
        editable ? h('button.btn', { type: 'button', 'aria-label': `Edit question ${n}`, onclick: () => openEditor(q) }, 'Edit') : null,
        h('button.btn', { type: 'button', 'aria-label': `${q.hidden ? 'Show' : 'Hide'} question ${n}`, onclick: () => setHidden(q, !q.hidden) }, q.hidden ? 'Show' : 'Hide'),
        h('button.btn', { type: 'button', 'aria-label': `Delete question ${n}`, onclick: () => remove(q, n) }, 'Delete')),
      editable ? null : h('p.q-row-note', `${typeLabel(q.type)} questions can't be edited here yet. You can hide or delete this one.`));
  }

  // Where the questions come from.
  function sourceNote(live, draft) {
    if (!file) return null;
    if (!live.edited && !draft) return h('p.field-help.q-source', 'These questions come from the set\'s file. Your first change starts a draft copy here, and the file stays as a backup.');
    return h('p.field-help.q-source', 'The questions here replace the ones in the set\'s file, which stays as a backup. ',
      h('button.link-btn', { type: 'button', onclick: useFile }, 'Go back to the file\'s questions'));
  }

  function openEditor(q) {
    const { questions, cases } = state();
    // The pictures this set's hot spot questions use, to use again.
    const pictures = [...new Map(questions.filter(x => x.type === 'hotspot' && isText(x.image)).map(x => [x.image, { path: x.image, alt: x.alt ?? '' }])).values()];
    editing = {
      id: q?.id ?? '',
      el: questionEditor(q, {
        setId, questions, cases, pictures,
        onSave: async (question, upload) => {
          const now = state();
          const next = now.questions.filter(x => x.id !== question.id);
          let at = q ? now.questions.findIndex(x => x.id === q.id) : next.length;
          // A question that joins a case study goes after the case study's other questions.
          if (question.case && question.case !== q?.case) {
            const last = next.map(x => x.case).lastIndexOf(question.case);
            if (last >= 0) at = last + 1;
          }
          next.splice(Math.max(0, Math.min(at, next.length)), 0, question);
          const extra = upload ? {
            [`setImages/${upload.id}`]: { data: upload.data, set: setId, name: upload.name, size: upload.size, uploadedAt: db.serverTime() },
          } : {};
          await saveDraft(next, now.cases, extra);
          editing = null;
          toast(q ? 'Saved in the draft.' : 'Added to the draft.');
          paint(true);
        },
        onCancel: () => {
          editing = null;
          paint(true);
        },
      }),
    };
    paint(true);
    editing.el.querySelector('select, input, textarea')?.focus();
  }

  async function setHidden(q, hide) {
    const { questions, cases } = state();
    const next = questions.map(x => {
      if (x.id !== q.id) return x;
      const { hidden, ...rest } = x;
      return hide ? { ...rest, hidden: true } : rest;
    });
    try {
      await saveDraft(next, cases);
    } catch (err) {
      toast(`It didn't change. ${problemText(err)}`, 9000);
    }
  }

  async function remove(q, n) {
    const choice = await modal({
      title: 'Delete This Question?',
      message: `Question ${n} is taken out of the draft. Students keep seeing it until you publish. To keep it but take it out of exams, hide it instead.`,
      buttons: [{ label: 'Keep it', value: 'keep', accent: true }, { label: 'Delete question', value: 'delete' }],
    });
    if (choice !== 'delete') return;
    const { questions, cases } = state();
    try {
      await saveDraft(questions.filter(x => x.id !== q.id), cases);
    } catch (err) {
      toast(`It wasn't deleted. ${problemText(err)}`, 9000);
    }
  }

  async function discard() {
    const choice = await modal({
      title: 'Discard the Draft?',
      message: 'Every change since you last published is thrown away. Students see no difference.',
      buttons: [{ label: 'Keep the draft', value: 'keep', accent: true }, { label: 'Discard draft', value: 'discard' }],
    });
    if (choice !== 'discard') return;
    const { live, draft } = state();
    try {
      await db.update('', { [`setDrafts/${setId}`]: null, ...forget(pictureIds(draft?.questions), pictureIds(live?.questions)) });
      editing = null;
      toast('The draft was discarded.');
    } catch (err) {
      toast(`It wasn't discarded. ${problemText(err)}`, 9000);
    }
  }

  // The draft as a practice exam, on this browser only.
  async function tryIt() {
    const { live, questions, cases } = state();
    const set = { ...live, questions: visible(questions), cases };
    const active = activeExam();
    if (active) {
      const choice = await modal({
        title: 'Start a New Exam?',
        message: `You have an exam in progress (${active.title}). Trying the draft ends it, and its answers will not be scored.`,
        buttons: [{ label: 'Cancel', value: 'cancel', accent: true }, { label: 'Try the draft', value: 'go' }],
      });
      if (choice !== 'go') return;
    }
    startExam(set, { ...DEFAULT_SETTINGS, ...PRESETS.practice, preset: 'practice', fullscreen: false, count: null });
  }

  async function useFile() {
    const choice = await modal({
      title: 'Go Back to the File\'s Questions?',
      message: 'Students see the questions in the set\'s file again. The questions published here, and the draft, are deleted. Download a backup first (on the Question sets page) if you might want them later.',
      buttons: [{ label: 'Keep these questions', value: 'keep', accent: true }, { label: 'Use the file\'s questions', value: 'file' }],
    });
    if (choice !== 'file') return;
    const { live, draft } = state();
    try {
      await db.update('', {
        [`setInfo/${setId}/questions`]: null, [`setInfo/${setId}/cases`]: null, [`setInfo/${setId}/publishedAt`]: null, [`setDrafts/${setId}`]: null,
        ...forget(new Set([...pictureIds(live?.questions), ...pictureIds(draft?.questions)])),
      });
      editing = null;
      toast('Done. Students see the file\'s questions.');
    } catch (err) {
      toast(`It didn't change. ${problemText(err)}`, 9000);
    }
  }

  const fail = err => {
    pageProblem = err;
    paint(true);
  };
  const stopInfo = db.watch('setInfo', value => {
    changes = readChanges(value);
    keepChanges(changes);
    loaded |= 1;
    paint();
  }, fail);
  const stopDrafts = db.watch(`setDrafts/${setId}`, value => {
    drafts = readDrafts(value ? { [setId]: value } : null);
    loaded |= 2;
    paint();
  }, fail);
  fill(section, h('p.lead', 'Loading the questions…'));
  return () => {
    stopInfo();
    stopDrafts();
  };
}

// ---------- the question form ----------

// A form for one question (q: null for a new one). onSave(question, upload)
// gets a question that passes every check, and a new picture to save with it
// (a hot spot's), if there is one. pictures: the set's hot spot pictures.
function questionEditor(q, { setId, questions, cases, pictures = [], onSave, onCancel }) {
  const isNew = !q;
  let type = q?.type ?? 'mc';
  let typeForm = null;
  let tried = false; // problems show after the first Save
  const typeSelect = isNew ? h('select.text-input#qe-type', EDITABLE.map(t => h('option', { value: t }, typeLabel(t)))) : null;
  const topics = h('datalist#qe-topics', [...new Set(questions.map(x => x.topic).filter(isText))].sort(naturally).map(t => h('option', { value: t })));
  const topic = h('input.text-input#qe-topic', { type: 'text', list: 'qe-topics', maxlength: '80', value: q?.topic ?? '', autocomplete: 'off' });
  const caseKeys = Object.keys(cases ?? {});
  const caseSelect = caseKeys.length ? h('select.text-input#qe-case',
    h('option', { value: '' }, 'None: a stand-alone question'),
    caseKeys.map(key => h('option', { value: key, selected: q?.case === key }, `${key}: ${shorten(plainText(cases[key].intro), 80) || plural(cases[key].tabs?.length ?? 0, 'exhibit')}`))) : null;
  const stem = h('textarea.text-input#qe-stem', { rows: '4', value: toText(q?.stem) });
  const rationale = h('textarea.text-input#qe-rationale', { rows: '6', value: toText(q?.rationale) });
  const typeArea = h('div.qe-type-area');
  const problemsBox = h('div.qe-problems', { role: 'alert' });
  const waiting = () => [h('p.qe-preview-title', 'Preview'), h('p.field-help', 'The preview appears when the question is complete.')];
  const preview = h('div.qe-preview', waiting());
  const save = h('button.btn.btn-accent', { type: 'submit' }, isNew ? 'Add to draft' : 'Save in draft');

  function useType(t, carried = {}) {
    type = t;
    typeForm = TYPE_FORMS[t](isNew ? carried : q, { pictures });
    fill(typeArea, typeForm.el);
    refresh();
  }

  // The question as the form has it, and what's missing in plain words.
  function build() {
    const { fields, problems } = typeForm.read();
    const managed = ['id', 'type', 'case', 'topic', 'stem', 'rationale', ...MANAGED[q?.type ?? type]];
    const kept = isNew ? {} : Object.fromEntries(Object.entries(q).filter(([k]) => !managed.includes(k)));
    const study = caseSelect?.value || (caseSelect ? null : q?.case) || null; // a case study that's gone stays named, so the set check says so
    // Text that wasn't changed keeps its HTML exactly, so the question doesn't count as changed.
    const html = (box, before) => (q && box.value === toText(before) ? before : toHtml(box.value));
    const question = {
      id: q?.id ?? nextId(setId, questions), type, ...(study ? { case: study } : {}),
      topic: topic.value.trim(), stem: html(stem, q?.stem), ...fields, rationale: html(rationale, q?.rationale), ...kept,
    };
    const missing = [];
    if (!question.topic) missing.push('Type a topic, like "Pharmacology". Students see their score by topic.');
    if (!stem.value.trim()) missing.push('Type the question.');
    missing.push(...problems);
    if (!rationale.value.trim()) missing.push('Type the rationale: why the right answer is right, and why each wrong option is wrong.');
    return { question, problems: missing.length ? missing : validateQuestion(question, cases), upload: typeForm.upload?.() ?? null };
  }

  let timer = 0;
  let previewTab = 0; // the exhibit tab shown in the preview
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { question, problems } = build();
      fill(problemsBox, tried && problems.length ? h('ul', problems.map(p => h('li', p))) : null);
      if (problems.length) {
        fill(preview, waiting());
        return;
      }
      const key = keyResponse(question);
      const parts = [questionParts(question, { response: key, review: true, idPrefix: 'qe-pv-' }), feedbackPanel(question, key)];
      // A case study question shows next to the case study's exhibits, as in an exam.
      const area = h('div.qe-preview-area');
      if (question.case && cases[question.case]) {
        questionArea(area, cases, { get: () => previewTab, set: (_, i) => (previewTab = i) }).show(question, parts);
      } else fill(area, parts);
      fill(preview, h('p.qe-preview-title', 'Preview: what students see, with the right answer marked'), area);
      // The key is shown as if it were an answer; here it's the correct answer, not "your" answer.
      for (const m of preview.querySelectorAll('.mark.ok')) {
        if (m.lastChild?.textContent === ' Your answer') m.lastChild.textContent = ' Correct answer';
        if (m.lastChild?.textContent === ' Your click is in the correct area.') m.lastChild.textContent = ' A click in the green area is correct.';
      }
    }, 150);
  }

  const form = h('form.q-editor', {
    'aria-label': isNew ? 'New question' : `Edit question ${q.id}`,
    novalidate: true,
    onsubmit: async e => {
      e.preventDefault();
      tried = true;
      const { question, problems, upload } = build();
      if (problems.length) {
        fill(problemsBox, h('ul', problems.map(p => h('li', p))));
        problemsBox.scrollIntoView({ block: 'nearest' });
        return;
      }
      save.disabled = true;
      const label = save.textContent;
      if (upload) save.textContent = 'Saving the picture…';
      try {
        await onSave(question, upload);
      } catch (err) {
        fill(problemsBox, h('ul', h('li', `It didn't save. ${problemText(err)}`)));
        save.disabled = false;
        save.textContent = label;
      }
    },
  },
    h('h2.section-title', isNew ? 'New question' : `Edit question ${q.id}`),
    h('div.editor-grid',
      isNew ? h('div.field', h('label.field-label', { for: 'qe-type' }, 'Question type'), typeSelect)
        : h('div.field', h('p.field-label', 'Question type'), h('p.qe-fixed', typeLabel(type))),
      h('div.field', h('label.field-label', { for: 'qe-topic' }, 'Topic'), topic, topics),
      caseSelect ? h('div.field.wide', h('label.field-label', { for: 'qe-case' }, 'Case study'), caseSelect,
        h('p.field-help', 'A case study question shows next to the case study\'s exhibits, after the case study\'s other questions.')) : null),
    !caseSelect && q?.case ? h('p.field-help', `This question names the case study "${q.case}", which isn't in the set.`) : null,
    h('div.field', h('label.field-label', { for: 'qe-stem' }, 'Question'), stem,
      h('p.field-help', 'A blank line starts a new paragraph.')),
    typeArea,
    h('div.field', h('label.field-label', { for: 'qe-rationale' }, 'Rationale'), rationale,
      h('p.field-help', 'Say why the right answer is right, and why each wrong option is wrong.')),
    problemsBox,
    h('div.form-actions', save, h('button.btn', { type: 'button', onclick: onCancel }, 'Cancel')),
    preview);
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  typeSelect?.addEventListener('change', () => useType(typeSelect.value, typeForm.options ? { options: typeForm.options() } : {}));
  useType(type);
  return form;
}

// ---------- each type's part of the form ----------
// Each returns { el, read() -> { fields, problems } }.

let lists = 0;

// An editable list of short texts, in order, each with an optional mark
// ('radio' or 'checkbox') and buttons to move it up or down, or remove it.
function listEditor({ values, marks = [], mark = null, noun, addLabel, onChange = () => {} }) {
  const group = `qe-list-${++lists}`;
  const list = h('ol.edit-list', { 'aria-label': `${noun}s` });
  let keys = 0;
  const changed = () => {
    label();
    onChange();
    list.dispatchEvent(new Event('change', { bubbles: true })); // the form's preview follows
  };

  function row(text = '', marked = false) {
    const box = mark ? h('input.ctl.edit-mark', { type: mark, name: group, checked: marked }) : null;
    const input = h('input.text-input.edit-text', { type: 'text', maxlength: '600', value: text });
    const li = h('li.edit-item', box, input,
      h('span.order-ctls',
        h('button.order-ctl', { type: 'button', onclick: () => { li.previousElementSibling?.before(li); changed(); } }, '▲'),
        h('button.order-ctl', { type: 'button', onclick: () => { li.nextElementSibling?.after(li); changed(); } }, '▼'),
        h('button.order-ctl', { type: 'button', onclick: () => { li.remove(); changed(); } }, '✕')));
    return Object.assign(li, { key: ++keys, box, input });
  }

  // Screen readers hear "Choice 2", "Correct: choice 2", "Move choice 2 up".
  function label() {
    const items = [...list.children];
    items.forEach((li, i) => {
      const name = `${noun.toLowerCase()} ${i + 1}`;
      li.input.setAttribute('aria-label', `${noun} ${i + 1}`);
      li.box?.setAttribute('aria-label', `Correct: ${name}`);
      const [up, down, remove] = li.querySelectorAll('.order-ctl');
      up.setAttribute('aria-label', `Move ${name} up`);
      up.disabled = i === 0;
      down.setAttribute('aria-label', `Move ${name} down`);
      down.disabled = i === items.length - 1;
      remove.setAttribute('aria-label', `Remove ${name}`);
    });
  }

  values.forEach((v, i) => list.append(row(v, !!marks[i])));
  label();
  const add = h('button.btn.btn-small', {
    type: 'button',
    onclick: () => {
      const li = row();
      list.append(li);
      changed();
      li.input.focus();
    },
  }, addLabel);
  return {
    el: h('div.edit-list-wrap', list, add),
    items: () => [...list.children].map(li => ({ key: li.key, text: li.input.value.trim(), marked: !!li.box?.checked })),
  };
}

// Multiple choice (mode 'one'), select all ('many'), and select N ('select').
function choicesForm(q, mode) {
  const options = q.options?.length ? q.options : ['', '', '', ''];
  const picked = new Set(mode === 'one' ? (Number.isInteger(q.answer) ? [q.answer] : []) : Array.isArray(q.answer) ? q.answer : []);
  const list = listEditor({
    values: options, marks: options.map((_, i) => picked.has(i)), mark: mode === 'one' ? 'radio' : 'checkbox', noun: 'Choice', addLabel: 'Add a choice',
  });
  const scoring = mode === 'many'
    ? h('select.text-input#qe-scoring',
        h('option', { value: '' }, 'All or nothing: 1 point only when every pick is right'),
        h('option', { value: 'partial', selected: q.scoring === 'partial' }, 'Partial credit: +1 for each right pick, −1 for each wrong one'))
    : null;
  const help = {
    one: 'Type each choice, and mark the correct one.',
    many: 'Type each choice, and mark every correct one.',
    select: 'Type each choice, and mark the correct ones. Students are told how many to select.',
  }[mode];
  return {
    el: h('div.field',
      h('p.field-label', 'Choices'),
      h('p.field-help', help, ' Students see them in a shuffled order.'),
      list.el,
      scoring ? h('div.field', h('label.field-label', { for: 'qe-scoring' }, 'Scoring'), scoring) : null),
    options: () => list.items().map(it => it.text),
    read() {
      const items = list.items();
      const problems = [];
      if (items.length < 2) problems.push('Add at least 2 choices.');
      items.forEach((it, i) => it.text || problems.push(`Choice ${i + 1} is empty. Type it, or remove it with ✕.`));
      const answer = items.flatMap((it, i) => (it.marked ? [i] : []));
      if (!answer.length) problems.push(mode === 'one' ? 'Mark the correct choice.' : 'Mark at least one correct choice.');
      const fields = { options: items.map(it => it.text) };
      if (mode === 'one') fields.answer = answer[0] ?? null;
      else {
        fields.answer = answer;
        if (mode === 'select') fields.select = answer.length;
        if (scoring?.value) fields.scoring = scoring.value;
      }
      return { fields, problems };
    },
  };
}

const ROUNDING = ['to the nearest whole number', 'to the nearest tenth', 'to the nearest hundredth'];
const asNumber = text => (/^-?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : null);

function fillForm(q) {
  const answer = h('input.text-input#qe-answer', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: q.answer ?? '' });
  const unit = h('input.text-input#qe-unit', { type: 'text', maxlength: '20', placeholder: 'mL', value: q.unit ?? '' });
  const round = h('select.text-input#qe-round',
    h('option', { value: '' }, 'No rounding instruction'),
    [...new Set([...ROUNDING, ...(q.round ? [q.round] : [])])].map(r => h('option', { value: r, selected: r === q.round }, `Round ${r}`)));
  const tolerance = h('input.text-input#qe-tolerance', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', value: q.tolerance ?? '' });
  const zeros = h('input.ctl#qe-zeros', { type: 'checkbox', checked: !!q.strictZeros });
  return {
    el: h('div.editor-grid',
      h('div.field', h('label.field-label', { for: 'qe-answer' }, 'Correct answer (a number)'), answer),
      h('div.field', h('label.field-label', { for: 'qe-unit' }, 'Unit ', h('span.optional', '(optional)')), unit),
      h('div.field', h('label.field-label', { for: 'qe-round' }, 'Rounding'), round),
      h('div.field', h('label.field-label', { for: 'qe-tolerance' }, 'Also accept answers this close ', h('span.optional', '(optional)')), tolerance),
      h('label.choice-line.wide', zeros,
        h('span', 'Zero rules: no trailing zero (20, not 20.0) and a leading zero below 1 (0.5, not .5). An answer that breaks them scores 0.'))),
    read() {
      const problems = [];
      const fields = {};
      const value = asNumber(answer.value.trim());
      if (value == null) problems.push('Type the correct answer as a number, like 0.5 or 1200, with no unit or commas.');
      else fields.answer = value;
      if (unit.value.trim()) fields.unit = unit.value.trim();
      if (round.value) fields.round = round.value;
      if (tolerance.value.trim()) {
        const t = asNumber(tolerance.value.trim());
        if (t == null || t < 0) problems.push('"Also accept answers this close" must be a number, like 0.1, or empty.');
        else fields.tolerance = t;
      }
      if (zeros.checked) fields.strictZeros = true;
      return { fields, problems };
    },
  };
}

function orderForm(q) {
  const list = listEditor({ values: q.items?.length ? q.items : ['', '', '', ''], noun: 'Step', addLabel: 'Add a step' });
  return {
    el: h('div.field',
      h('p.field-label', 'Steps, in the correct order'),
      h('p.field-help', 'Students see them shuffled and put them in order. Use ▲ and ▼ to reorder.'),
      list.el),
    read() {
      const items = list.items();
      const problems = [];
      if (items.length < 2) problems.push('Add at least 2 steps.');
      items.forEach((it, i) => it.text || problems.push(`Step ${i + 1} is empty. Type it, or remove it with ✕.`));
      return { fields: { items: items.map(it => it.text) }, problems };
    },
  };
}

function matrixForm(q) {
  const multiple = h('input.ctl#qe-multiple', { type: 'checkbox', checked: !!q.multiple });
  const rowHeader = h('input.text-input#qe-rowheader', { type: 'text', maxlength: '60', placeholder: 'Finding', value: q.rowHeader ?? '' });
  const grid = h('div.matrix-key');
  const marks = new Set(); // "rowKey|columnKey"
  const columns = listEditor({ values: q.columns?.length ? q.columns : ['', ''], noun: 'Column', addLabel: 'Add a column', onChange: draw });
  const rows = listEditor({ values: q.rows?.length ? q.rows : ['', '', ''], noun: 'Row', addLabel: 'Add a row', onChange: draw });
  const [c0, r0] = [columns.items(), rows.items()];
  (Array.isArray(q.answer) ? q.answer : []).forEach((a, r) => [].concat(a).forEach(c => {
    if (r0[r] && c0[c]) marks.add(`${r0[r].key}|${c0[c].key}`);
  }));

  function draw() {
    const cols = columns.items();
    const many = multiple.checked;
    fill(grid, h('table.matrix-key-table',
      h('thead', h('tr', h('th', { scope: 'col' }, rowHeader.value.trim() || 'Row'), cols.map((c, i) => h('th', { scope: 'col' }, c.text || `Column ${i + 1}`)))),
      h('tbody', rows.items().map((r, ri) => {
        if (!many) cols.filter(c => marks.has(`${r.key}|${c.key}`)).slice(1).forEach(c => marks.delete(`${r.key}|${c.key}`));
        return h('tr', h('th', { scope: 'row' }, r.text || `Row ${ri + 1}`), cols.map((c, ci) => {
          const box = h('input.ctl', {
            type: many ? 'checkbox' : 'radio', name: `qe-key-${r.key}`, checked: marks.has(`${r.key}|${c.key}`),
            'aria-label': `Correct: row ${ri + 1}, ${c.text || `column ${ci + 1}`}`,
          });
          box.addEventListener('input', () => {
            if (!many) cols.forEach(x => marks.delete(`${r.key}|${x.key}`));
            if (box.checked) marks.add(`${r.key}|${c.key}`);
            else marks.delete(`${r.key}|${c.key}`);
          });
          return h('td', box);
        }));
      }))));
  }
  for (const el of [columns.el, rows.el, rowHeader]) el.addEventListener('input', draw);
  multiple.addEventListener('change', draw);
  draw();
  return {
    el: h('div.qe-matrix',
      h('div.editor-grid',
        h('div.field', h('p.field-label', 'Columns (the choices across the top)'), columns.el),
        h('div.field', h('p.field-label', 'Rows (the items down the side)'), rows.el)),
      h('label.choice-line', multiple, h('span', 'Students can choose more than one column in a row')),
      h('div.field', h('label.field-label', { for: 'qe-rowheader' }, 'Heading above the rows ', h('span.optional', '(optional)')), rowHeader),
      h('div.field', h('p.field-label', 'Correct answers'), h('p.field-help', 'Mark the right column in each row.'), grid)),
    read() {
      const cols = columns.items();
      const rws = rows.items();
      const many = multiple.checked;
      const problems = [];
      if (cols.length < 2) problems.push('Add at least 2 columns.');
      if (!rws.length) problems.push('Add at least 1 row.');
      cols.forEach((c, i) => c.text || problems.push(`Column ${i + 1} is empty. Type it, or remove it with ✕.`));
      rws.forEach((r, i) => r.text || problems.push(`Row ${i + 1} is empty. Type it, or remove it with ✕.`));
      const answer = rws.map((r, i) => {
        const marked = cols.flatMap((c, ci) => (marks.has(`${r.key}|${c.key}`) ? [ci] : []));
        if (!marked.length) problems.push(`Mark the correct ${many ? 'column or columns' : 'column'} for row ${i + 1}.`);
        return many ? marked : marked[0] ?? null;
      });
      const fields = { rows: rws.map(r => r.text), columns: cols.map(c => c.text), answer };
      if (many) fields.multiple = true;
      if (rowHeader.value.trim()) fields.rowHeader = rowHeader.value.trim();
      return { fields, problems };
    },
  };
}

// In the form, the drop-down lists are {{1}}, {{2}}, …; in the set they're {{0}}, {{1}}, ….
const MARKER = /\{\{\s*(\d+)\s*\}\}/g;

function dropdownForm(q) {
  const text = h('textarea.text-input#qe-text', { rows: '3', value: (q.text ?? '').replace(MARKER, (_, n) => `{{${Number(n) + 1}}}`) });
  const area = h('div.blank-editors');
  const blanks = [];
  const changed = () => text.dispatchEvent(new Event('input', { bubbles: true }));

  function paintBlanks() {
    fill(area, blanks.map((list, i) => h('fieldset.blank-editor',
      h('legend', `Drop-down {{${i + 1}}}: its options, with the correct one marked`),
      list.el,
      h('button.link-btn', { type: 'button', onclick: () => removeBlank(i) }, `Remove drop-down {{${i + 1}}}`))));
  }
  function addBlank(options = ['', ''], answer = null) {
    blanks.push(listEditor({ values: options, marks: options.map((_, i) => i === answer), mark: 'radio', noun: 'Option', addLabel: 'Add an option' }));
    paintBlanks();
  }
  // Takes its marker out of the sentence, and renumbers the later ones.
  function removeBlank(i) {
    blanks.splice(i, 1);
    text.value = text.value.replace(MARKER, (m, k) => (Number(k) === i + 1 ? '' : Number(k) > i + 1 ? `{{${Number(k) - 1}}}` : m));
    paintBlanks();
    changed();
  }
  const insert = h('button.btn.btn-small', {
    type: 'button',
    onclick: () => {
      const end = text.selectionEnd ?? text.value.length;
      text.setRangeText(`{{${blanks.length + 1}}}`, text.selectionStart ?? end, end, 'end');
      addBlank();
      text.focus();
      changed();
    },
  }, 'Add a drop-down at the cursor');
  (q.blanks ?? []).forEach(b => addBlank(b.options, b.answer));

  return {
    el: h('div.field',
      h('label.field-label', { for: 'qe-text' }, 'Sentence with drop-down lists'),
      h('p.field-help', 'Type the sentence. Put the cursor where a drop-down list goes and click "Add a drop-down at the cursor". It shows as {{1}}, {{2}}, and so on.'),
      text,
      h('div.form-actions', insert),
      area),
    read() {
      const problems = [];
      const found = [...text.value.matchAll(MARKER)].map(m => Number(m[1]));
      if (!text.value.trim()) problems.push('Type the sentence.');
      if (!blanks.length) problems.push('Add at least one drop-down list.');
      blanks.forEach((list, i) => {
        const n = i + 1;
        const times = found.filter(f => f === n).length;
        if (times !== 1) problems.push(times ? `The sentence has {{${n}}} more than once.` : `The sentence needs {{${n}}} where drop-down ${n} goes.`);
        const items = list.items();
        if (items.length < 2) problems.push(`Drop-down {{${n}}} needs at least 2 options.`);
        items.forEach((it, j) => it.text || problems.push(`Drop-down {{${n}}}: option ${j + 1} is empty. Type it, or remove it with ✕.`));
        if (!items.some(it => it.marked)) problems.push(`Drop-down {{${n}}}: mark the correct option.`);
      });
      for (const f of new Set(found)) {
        if (f < 1 || f > blanks.length) problems.push(`The sentence has {{${f}}}, but there ${blanks.length === 1 ? 'is 1 drop-down list' : `are ${blanks.length} drop-down lists`}.`);
      }
      return {
        fields: {
          text: text.value.trim().replace(MARKER, (_, k) => `{{${Number(k) - 1}}}`),
          blanks: blanks.map(list => {
            const items = list.items();
            return { options: items.map(it => it.text), answer: items.findIndex(it => it.marked) };
          }),
        },
        problems,
      };
    },
  };
}

// ---------- hot spot: a picture, and boxes over the correct area ----------

const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const PICTURE_MAX = 2 * 1024 * 1024; // bytes, once shrunk (database.rules.json allows 2,800,000 characters of data)
const PICTURE_SIDE = 1600; // pixels: bigger pictures are shrunk to fit

const newPictureId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const dataBytes = url => Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);

function fileAsUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('That file couldn\'t be read. Try again, or choose another picture.'));
    reader.readAsDataURL(file);
  });
}

function pictureFrom(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file isn\'t a picture this browser can show. Choose a PNG, JPG, GIF, WebP, or SVG picture.'));
    img.src = url;
  });
}

// A picture file as a data: URL, shrunk when it's bigger than a question needs.
async function readPicture(file) {
  if (!PICTURE_TYPES.includes(file.type)) throw new Error('Choose a PNG, JPG, GIF, WebP, or SVG picture.');
  if (file.size > 25 * 1024 * 1024) throw new Error(`That picture is ${formatSize(file.size)}. Choose one smaller than 25 MB.`);
  const url = await fileAsUrl(file);
  const img = await pictureFrom(url);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('This picture has no size. If it\'s an SVG, give its <svg> tag a width and height, or save it as a PNG.');
  const side = Math.max(img.naturalWidth, img.naturalHeight);
  if (file.type === 'image/svg+xml' || (side <= PICTURE_SIDE && file.size <= PICTURE_MAX)) {
    if (file.size > PICTURE_MAX) throw new Error(`That picture is ${formatSize(file.size)}, and the limit is 2 MB. Save a smaller copy and try again.`);
    return { data: url, size: file.size, shrunk: false };
  }
  // Too big: draw it smaller. Drawings stay PNG unless only a JPEG fits; photos are JPEG.
  const scale = Math.min(1, PICTURE_SIDE / side);
  const canvas = h('canvas', { width: String(Math.max(1, Math.round(img.naturalWidth * scale))), height: String(Math.max(1, Math.round(img.naturalHeight * scale))) });
  const g = canvas.getContext('2d');
  let data = '';
  if (!['image/jpeg', 'image/webp'].includes(file.type)) {
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    data = canvas.toDataURL('image/png');
  }
  if (!data || dataBytes(data) > PICTURE_MAX) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    data = canvas.toDataURL('image/jpeg', 0.85);
  }
  if (dataBytes(data) > PICTURE_MAX) throw new Error(`That picture is still ${formatSize(dataBytes(data))} after shrinking it, and the limit is 2 MB. Try a simpler picture.`);
  return { data, size: dataBytes(data), shrunk: true };
}

// The picture comes from an upload (saved with the question, after the
// own-work box is ticked) or from another hot spot question in the set. The
// correct area is one or more boxes: drag across the picture to draw one, drag
// a box to move it or its corner to resize it, or type its numbers.
function hotspotForm(q, { pictures = [] }) {
  let image = q.image ?? '';
  let upload = null; // a new picture: { id, data, name, size }
  let boxes = Array.isArray(q.regions) ? q.regions.map(g => ({ ...g })) : [];
  let picked = boxes.length ? 0 : -1;
  let drag = null; // { mode: 'new' | 'move' | 'size', i, from, was }

  const fileInput = h('input.file-input#qe-picture', { type: 'file', accept: PICTURE_TYPES.join(',') });
  const fileNote = h('p.field-help.qe-file-note', { 'aria-live': 'polite' });
  const own = h('input.ctl#qe-picture-own', { type: 'checkbox' });
  const ownLine = h('label.choice-line.own-work', { hidden: true }, own,
    h('span', 'This picture is my own drawing or photo. It isn\'t from a textbook, class slides, or the internet.'));
  const choices = h('div.qe-picture-choices');
  const alt = h('input.text-input#qe-alt', { type: 'text', maxlength: '300', value: q.alt ?? '' });
  const img = h('img.qe-picture', { alt: '', draggable: 'false' });
  const missing = h('p.picture-missing', { role: 'alert', hidden: true }, 'The picture couldn\'t be loaded. Check the internet connection, or upload it again.');
  const layer = h('div.qe-boxes');
  const stage = h('div.qe-stage', { hidden: !image }, img, layer);
  const boxList = h('ol.qe-box-list', { 'aria-label': 'Boxes over the correct area' });
  const changed = () => layer.dispatchEvent(new Event('change', { bubbles: true })); // the preview follows
  // A box in the middle, to move by typing its numbers (or by dragging it).
  const addBox = h('button.btn.btn-small', {
    type: 'button',
    hidden: !image,
    onclick: () => {
      boxes.push({ x: 40, y: 40, w: 20, h: 20 });
      picked = boxes.length - 1;
      drawBoxes();
      drawList();
      changed();
      boxList.lastElementChild?.querySelector('input')?.focus();
    },
  }, 'Add a box');

  const round = v => Math.round(v * 10) / 10;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const tidy = b => {
    const x = clamp(round(b.x), 0, 99);
    const y = clamp(round(b.y), 0, 99);
    return { x, y, w: clamp(round(b.w), 1, round(100 - x)), h: clamp(round(b.h), 1, round(100 - y)) };
  };
  const spot = e => {
    const r = img.getBoundingClientRect();
    return { x: clamp(((e.clientX - r.left) / r.width) * 100, 0, 100), y: clamp(((e.clientY - r.top) / r.height) * 100, 0, 100) };
  };

  function drawBoxes() {
    fill(layer, boxes.map((b, i) => h('div.qe-box', {
      'data-i': String(i), class: i === picked ? 'picked' : null,
      style: { left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` },
    }, h('span.qe-box-num', String(i + 1)), h('span.qe-box-handle', { title: 'Drag to resize' }))));
  }

  // The boxes' numbers, in percent of the picture, to check or type.
  function drawList() {
    fill(boxList, boxes.map((b, i) => {
      const inputs = {};
      const field = (key, label) => {
        const input = h('input.num-input', {
          type: 'number', min: '0', max: '100', step: '0.1', inputmode: 'decimal', value: String(b[key]),
          'aria-label': `Box ${i + 1}: ${label.toLowerCase()}, in percent of the picture`,
        });
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          if (!Number.isFinite(v)) return;
          boxes[i] = tidy({ ...boxes[i], [key]: v });
          picked = i;
          drawBoxes();
          for (const [k, el] of Object.entries(inputs)) if (el !== input) el.value = String(boxes[i][k]);
        });
        input.addEventListener('change', () => (input.value = String(boxes[i][key])));
        inputs[key] = input;
        return h('label.qe-box-field', h('span', label), input);
      };
      return h('li.qe-box-row', { class: i === picked ? 'picked' : null },
        h('b', `Box ${i + 1}`), field('x', 'Left'), field('y', 'Top'), field('w', 'Width'), field('h', 'Height'),
        h('button.link-btn', {
          type: 'button',
          onclick: () => {
            boxes.splice(i, 1);
            picked = Math.min(picked, boxes.length - 1);
            drawBoxes();
            drawList();
            changed();
          },
        }, `Remove box ${i + 1}`));
    }));
  }

  layer.addEventListener('pointerdown', e => {
    if (e.button > 0 || !img.naturalWidth) return;
    e.preventDefault();
    const p = spot(e);
    const box = e.target.closest('.qe-box');
    if (box) {
      picked = Number(box.dataset.i);
      drag = { mode: e.target.closest('.qe-box-handle') ? 'size' : 'move', i: picked, from: p, was: { ...boxes[picked] } };
    } else {
      boxes.push({ x: p.x, y: p.y, w: 0, h: 0 });
      picked = boxes.length - 1;
      drag = { mode: 'new', i: picked, from: p };
    }
    layer.setPointerCapture(e.pointerId);
    drawBoxes();
  });
  layer.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = spot(e);
    const b = boxes[drag.i];
    const dx = p.x - drag.from.x;
    const dy = p.y - drag.from.y;
    if (drag.mode === 'new') Object.assign(b, { x: Math.min(p.x, drag.from.x), y: Math.min(p.y, drag.from.y), w: Math.abs(dx), h: Math.abs(dy) });
    else if (drag.mode === 'move') Object.assign(b, { x: clamp(drag.was.x + dx, 0, 100 - b.w), y: clamp(drag.was.y + dy, 0, 100 - b.h) });
    else Object.assign(b, { w: clamp(drag.was.w + dx, 1, 100 - b.x), h: clamp(drag.was.h + dy, 1, 100 - b.y) });
    drawBoxes();
  });
  const stop = () => {
    if (!drag) return;
    const b = boxes[drag.i];
    if (drag.mode === 'new' && (b.w < 1 || b.h < 1)) {
      boxes.splice(drag.i, 1); // a click, not a drag
      picked = -1;
    } else boxes[drag.i] = tidy(b);
    drag = null;
    drawBoxes();
    drawList();
    changed();
  };
  layer.addEventListener('pointerup', stop);
  layer.addEventListener('pointercancel', stop);

  function usePicture(path) {
    image = path;
    missing.hidden = true;
    stage.hidden = false;
    addBox.hidden = false;
    img.removeAttribute('src');
    showPicture(img, path, missing);
    drawBoxes();
    paintChoices();
    changed();
  }

  // The set's other pictures, to use again (no new upload needed).
  function paintChoices() {
    const others = pictures.filter(p => p.path !== image);
    fill(choices, others.length ? [
      h('p.field-help', 'Or use a picture from another hot spot question in this set:'),
      h('div.qe-thumbs', others.map((p, i) => {
        const thumb = h('img', { alt: '' });
        showPicture(thumb, p.path);
        return h('button.qe-thumb', {
          type: 'button',
          'aria-label': `Use picture ${i + 1}${p.alt ? `: ${p.alt}` : ''}`,
          onclick: () => {
            upload = null;
            ownLine.hidden = true;
            fileNote.textContent = '';
            if (!alt.value.trim()) alt.value = p.alt;
            usePicture(p.path);
          },
        }, thumb);
      }))] : null);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // so the same file can be chosen again
    if (!file) return;
    fileNote.textContent = 'Reading the picture…';
    try {
      const picture = await readPicture(file);
      const id = newPictureId();
      rememberPicture(id, picture.data);
      upload = { id, data: picture.data, name: file.name.slice(0, 200), size: picture.size };
      own.checked = false;
      ownLine.hidden = false;
      fileNote.textContent = `${file.name} · ${formatSize(picture.size)}${picture.shrunk ? ' (made smaller to fit)' : ''}`;
      usePicture(`db:${id}`);
    } catch (err) {
      fileNote.textContent = err.message;
    }
  });

  if (image) showPicture(img, image, missing);
  drawBoxes();
  drawList();
  paintChoices();
  return {
    el: h('div.qe-hotspot',
      h('div.field',
        h('label.field-label', { for: 'qe-picture' }, image ? 'Picture (choose a file to replace it)' : 'Picture'),
        h('p.field-help', 'Upload a PNG, JPG, GIF, WebP, or SVG picture you drew or took yourself. Big pictures are made smaller to fit (2 MB at most).'),
        fileInput, fileNote, choices, ownLine),
      h('div.field', h('label.field-label', { for: 'qe-alt' }, 'Describe the picture'), alt,
        h('p.field-help', 'For students who use a screen reader. Say what it shows without giving the answer away, like "Side view of the eye with the front on the left."')),
      h('div.field',
        h('p.field-label', 'Correct area'),
        h('p.field-help', 'Drag across the picture to draw a box over the correct area. Drag a box to move it, or its corner to resize it, or type its numbers (in percent of the picture). Use more boxes for an odd shape. A click inside any box is correct.'),
        stage, boxList, h('div.qe-box-actions', addBox))),
    read() {
      const problems = [];
      if (!image) problems.push('Upload a picture, or choose one already in this set.');
      if (upload && !own.checked) problems.push('Tick the box to confirm the picture is your own drawing or photo.');
      if (!alt.value.trim()) problems.push('Describe the picture for students who use a screen reader, without giving the answer away.');
      if (image && !boxes.length) problems.push('Drag across the picture to draw a box over the correct area.');
      return { fields: { image, alt: alt.value.trim(), regions: boxes.map(tidy) }, problems };
    },
    upload: () => upload,
  };
}

// ---------- highlight: a passage with phrases students can click ----------

// The passage is plain text, and line breaks are <br>.
const toPassage = text => text.replace(/\r\n?/g, '\n').trim().replace(/\n/g, '<br>');

function highlightForm(q) {
  const passage = h('textarea.text-input#qe-passage', { rows: '6', value: (q.passage ?? '').replace(/<br\s*\/?>/gi, '\n') });
  const list = h('ul.qe-phrases', { 'aria-label': 'Clickable phrases' });
  const note = h('p.field-help.qe-phrase-note', { role: 'status' });
  const marked = new Set(); // "phrase#2": the second phrase with that text, so marks survive edits
  const keyed = phrases => {
    const seen = new Map();
    return phrases.map(p => {
      const k = (seen.get(p.phrase) ?? 0) + 1;
      seen.set(p.phrase, k);
      return { ...p, key: `${p.phrase}#${k}` };
    });
  };
  const phrasesIn = value => {
    const parts = highlightParts(value);
    return parts ? keyed(parts.filter(p => p.phrase != null)) : null;
  };
  for (const p of phrasesIn(q.passage ?? '') ?? []) if ((q.answer ?? []).includes(p.n)) marked.add(p.key);
  const changed = () => passage.dispatchEvent(new Event('input', { bubbles: true }));

  function paintList() {
    const phrases = phrasesIn(toPassage(passage.value));
    if (!phrases) {
      fill(list, h('li.qe-phrase-problem', 'A [[ doesn\'t have a matching ]], or the other way around.'));
      return;
    }
    fill(list, phrases.length ? phrases.map((p, i) => {
      const words = p.phrase.replace(/<br\s*\/?>/gi, ' ');
      const box = h('input.ctl', { type: 'checkbox', checked: marked.has(p.key), 'aria-label': `Should be highlighted: ${words}` });
      box.addEventListener('change', () => (box.checked ? marked.add(p.key) : marked.delete(p.key)));
      return h('li', h('label.choice-line', box, h('span', words)),
        h('button.link-btn', { type: 'button', 'aria-label': `Make "${words}" plain text again`, onclick: () => unwrap(i) }, 'Make it plain text'));
    }) : h('li.qe-phrase-none', 'No clickable phrases yet.'));
  }

  // Puts [[ ]] around the selected words.
  function makeClickable() {
    const v = passage.value;
    let a = passage.selectionStart;
    let b = passage.selectionEnd;
    while (a < b && /\s/.test(v[a])) a++;
    while (b > a && /\s/.test(v[b - 1])) b--;
    if (a === b) {
      note.textContent = 'First select some words in the passage, then click the button.';
      return;
    }
    const before = v.slice(0, a);
    const words = v.slice(a, b);
    const open = (before.match(/\[\[/g) ?? []).length - (before.match(/\]\]/g) ?? []).length;
    if (open > 0 || words.includes('[[') || words.includes(']]')) {
      note.textContent = 'Those words overlap a phrase that\'s already clickable.';
      return;
    }
    passage.setRangeText(`[[${words}]]`, a, b, 'end');
    note.textContent = '';
    passage.focus();
    paintList();
    changed();
  }

  // Takes the [[ ]] off phrase i.
  function unwrap(i) {
    let n = -1;
    passage.value = passage.value.replace(/\[\[([\s\S]*?)\]\]/g, (m, words) => (++n === i ? words : m));
    paintList();
    changed();
  }

  passage.addEventListener('input', paintList);
  paintList();
  return {
    el: h('div.qe-highlight',
      h('div.field',
        h('label.field-label', { for: 'qe-passage' }, 'Passage'),
        h('p.field-help', 'Type or paste the text, like part of the nurses\' notes. Then select the words or phrases students can click, and click "Make the selected words clickable". They show as [[like this]].'),
        passage,
        h('div.form-actions', h('button.btn.btn-small', { type: 'button', onclick: makeClickable }, 'Make the selected words clickable')),
        note),
      h('div.field',
        h('p.field-label', 'Clickable phrases'),
        h('p.field-help', 'Tick the ones that should be highlighted. The others are there to see whether students can tell the difference.'),
        list)),
    read() {
      const problems = [];
      const value = toPassage(passage.value);
      const phrases = phrasesIn(value);
      if (!value) problems.push('Type the passage.');
      else if (!phrases) problems.push('A [[ in the passage doesn\'t have a matching ]], or the other way around.');
      else if (!phrases.length) problems.push('Make some words clickable: select them in the passage, then click "Make the selected words clickable".');
      else if (!phrases.some(p => marked.has(p.key))) problems.push('Tick the phrases that should be highlighted.');
      if (/<(?!br\s*\/?>)[a-z/!]/i.test(value)) problems.push('The passage can only hold plain text, without tags like <b>.');
      return { fields: { passage: value, answer: (phrases ?? []).filter(p => marked.has(p.key)).map(p => p.n) }, problems };
    },
  };
}

// ---------- drag and drop: a sentence with blanks, and words to drag ----------

function dragdropForm(q) {
  const text = h('textarea.text-input#qe-dd-text', { rows: '3', value: (q.text ?? '').replace(MARKER, (_, n) => `{{${Number(n) + 1}}}`) });
  const area = h('div.blank-editors');
  const words = listEditor({ values: q.tokens?.length ? q.tokens : ['', '', '', ''], noun: 'Word', addLabel: 'Add a word', onChange: () => paintBlanks() });
  const first = words.items();
  const answers = (Array.isArray(q.answer) ? q.answer : []).map(a => first[a]?.key ?? null); // each blank's word, by its key
  const changed = () => text.dispatchEvent(new Event('input', { bubbles: true }));

  function paintBlanks() {
    const list = words.items();
    fill(area, answers.map((key, i) => {
      const select = h('select.text-input', { id: `qe-dd-blank-${i + 1}` },
        h('option', { value: '' }, 'Choose the word that goes here'),
        list.map((w, j) => h('option', { value: String(w.key), selected: w.key === key }, w.text || `Word ${j + 1}`)));
      select.addEventListener('change', () => (answers[i] = select.value ? Number(select.value) : null));
      return h('div.blank-editor.dd-blank',
        h('label.field-label', { for: select.id }, `Blank {{${i + 1}}}: the word that goes there`),
        select,
        h('button.link-btn', { type: 'button', onclick: () => removeBlank(i) }, `Remove blank {{${i + 1}}}`));
    }));
  }
  // Takes its {{n}} out of the sentence, and renumbers the later ones.
  function removeBlank(i) {
    answers.splice(i, 1);
    text.value = text.value.replace(MARKER, (m, k) => (Number(k) === i + 1 ? '' : Number(k) > i + 1 ? `{{${Number(k) - 1}}}` : m));
    paintBlanks();
    changed();
  }
  const insert = h('button.btn.btn-small', {
    type: 'button',
    onclick: () => {
      const end = text.selectionEnd ?? text.value.length;
      text.setRangeText(`{{${answers.length + 1}}}`, text.selectionStart ?? end, end, 'end');
      answers.push(null);
      paintBlanks();
      text.focus();
      changed();
    },
  }, 'Add a blank at the cursor');
  words.el.addEventListener('input', () => paintBlanks()); // the choices follow the words as they're typed
  paintBlanks();

  return {
    el: h('div.qe-dragdrop',
      h('div.field',
        h('label.field-label', { for: 'qe-dd-text' }, 'Sentence with blanks'),
        h('p.field-help', 'Type the sentence. Put the cursor where a blank goes and click "Add a blank at the cursor". It shows as {{1}}, {{2}}, and so on.'),
        text,
        h('div.form-actions', insert)),
      h('div.field',
        h('p.field-label', 'Words to drag'),
        h('p.field-help', 'The words or phrases students drag into the blanks. Add a few wrong ones too. Students see them in a shuffled order.'),
        words.el),
      area),
    read() {
      const list = words.items();
      const problems = [];
      const found = [...text.value.matchAll(MARKER)].map(m => Number(m[1]));
      if (!text.value.trim()) problems.push('Type the sentence.');
      if (!answers.length) problems.push('Add at least one blank: put the cursor where it goes, and click "Add a blank at the cursor".');
      answers.forEach((key, i) => {
        const n = i + 1;
        const times = found.filter(f => f === n).length;
        if (times !== 1) problems.push(times ? `The sentence has {{${n}}} more than once.` : `The sentence needs {{${n}}} where blank ${n} goes.`);
        if (key == null || !list.some(w => w.key === key)) problems.push(`Blank {{${n}}}: choose the word that goes there.`);
      });
      for (const f of new Set(found)) {
        if (f < 1 || f > answers.length) problems.push(`The sentence has {{${f}}}, but there ${answers.length === 1 ? 'is 1 blank' : `are ${answers.length} blanks`}.`);
      }
      if (list.length < 2) problems.push('Add at least 2 words to drag.');
      list.forEach((w, i) => w.text || problems.push(`Word ${i + 1} is empty. Type it, or remove it with ✕.`));
      const used = answers.filter(k => k != null);
      if (new Set(used).size !== used.length) problems.push('A word can fill only one blank. If two blanks need the same word, add it to the list twice.');
      return {
        fields: {
          text: text.value.trim().replace(MARKER, (_, k) => `{{${Number(k) - 1}}}`),
          tokens: list.map(w => w.text),
          answer: answers.map(key => list.findIndex(w => w.key === key)),
        },
        problems,
      };
    },
  };
}

// ---------- bow tie: a condition, actions to take, and parameters to monitor ----------

const BOWTIE_LISTS = {
  condition: { noun: 'Condition', mark: 'radio', count: 4, add: 'Add a condition', label: 'Conditions: mark the one the client is most likely experiencing',
    missing: 'Mark the condition the client is most likely experiencing.' },
  actions: { noun: 'Action', mark: 'checkbox', count: 5, add: 'Add an action', label: 'Actions to take: mark the ones the nurse should take',
    missing: 'Mark the actions the nurse should take.' },
  parameters: { noun: 'Parameter', mark: 'checkbox', count: 5, add: 'Add a parameter', label: 'Parameters to monitor: mark the ones the nurse should monitor',
    missing: 'Mark the parameters the nurse should monitor.' },
};

function bowtieForm(q) {
  const editors = Object.fromEntries(Object.entries(BOWTIE_LISTS).map(([key, l]) => {
    const g = q[key] ?? {};
    const options = g.options?.length ? g.options : Array(l.count).fill('');
    const picked = new Set(key === 'condition' ? (Number.isInteger(g.answer) ? [g.answer] : []) : Array.isArray(g.answer) ? g.answer : []);
    return [key, listEditor({ values: options, marks: options.map((_, i) => picked.has(i)), mark: l.mark, noun: l.noun, addLabel: l.add })];
  }));
  return {
    el: h('div.qe-bowtie',
      h('p.field-help', 'Students put 1 condition in the middle of the diagram, and as many actions and parameters as you mark (usually 2 of each) on its sides. Add a few believable wrong options to each list. Students see each list in a shuffled order.'),
      Object.entries(BOWTIE_LISTS).map(([key, l]) => h('div.field', h('p.field-label', l.label), editors[key].el))),
    read() {
      const problems = [];
      const fields = {};
      for (const [key, l] of Object.entries(BOWTIE_LISTS)) {
        const items = editors[key].items();
        if (items.length < 2) problems.push(`Add at least 2 ${l.noun.toLowerCase()}s.`);
        items.forEach((it, i) => it.text || problems.push(`${l.noun} ${i + 1} is empty. Type it, or remove it with ✕.`));
        const answer = items.flatMap((it, i) => (it.marked ? [i] : []));
        if (!answer.length) problems.push(l.missing);
        const options = items.map(it => it.text);
        fields[key] = key === 'condition' ? { options, answer: answer[0] ?? null } : { options, answer, select: answer.length };
      }
      return { fields, problems };
    },
  };
}

const TYPE_FORMS = {
  mc: q => choicesForm(q, 'one'),
  sata: q => choicesForm(q, 'many'),
  emr: q => choicesForm(q, 'select'),
  fill: fillForm,
  order: orderForm,
  matrix: matrixForm,
  dropdown: dropdownForm,
  hotspot: hotspotForm,
  highlight: highlightForm,
  dragdrop: dragdropForm,
  bowtie: bowtieForm,
};

// ---------- the case study form ----------

const EXHIBIT_TITLES = ['Nurses\' Notes', 'Vital Signs', 'Laboratory Results', 'Orders', 'Health History', 'Medication Administration Record',
  'Admission Note', 'Progress Notes', 'Diagnostic Results', 'Intake and Output', 'Flow Sheet'];
let exhibits = 0;

// A form for a case study (key: null for a new one): its short name, its
// introduction, and its exhibit tabs. onSave(name, caseStudy).
function caseEditor(key, cases, { onSave, onCancel }) {
  const c = key ? cases[key] : { intro: '', tabs: [{ title: 'Nurses\' Notes', html: '' }] };
  const name = h('input.text-input#ce-name', { type: 'text', maxlength: '40', value: key ?? '', autocomplete: 'off' });
  const intro = h('textarea.text-input#ce-intro', { rows: '3', value: toText(c.intro) });
  const titles = h('datalist#ce-titles', EXHIBIT_TITLES.map(t => h('option', { value: t })));
  const tabList = h('ol.exhibit-list', { 'aria-label': 'Exhibit tabs' });
  const problemsBox = h('div.qe-problems', { role: 'alert' });
  const preview = h('div.qe-preview');
  const save = h('button.btn.btn-accent', { type: 'submit' }, key ? 'Save in draft' : 'Add to draft');
  let tried = false;
  let previewTab = 0;

  function tabEditor(tab = { title: '', html: '' }) {
    const n = ++exhibits;
    const { text, heading } = exhibitToText(tab.html, tab.title);
    const title = h('input.text-input', { id: `ce-title-${n}`, type: 'text', maxlength: '60', list: 'ce-titles', value: tab.title ?? '', autocomplete: 'off' });
    const content = h('textarea.text-input.ce-content', { id: `ce-content-${n}`, rows: '8', value: text });
    const legend = h('legend');
    const li = h('li.exhibit-editor', h('fieldset',
      legend,
      h('div.field', h('label.field-label', { for: title.id }, 'Tab title'), title),
      h('div.field', h('label.field-label', { for: content.id }, 'Content'), content),
      h('span.order-ctls',
        h('button.order-ctl', { type: 'button', onclick: () => { li.previousElementSibling?.before(li); relabel(); } }, '▲'),
        h('button.order-ctl', { type: 'button', onclick: () => { li.nextElementSibling?.after(li); relabel(); } }, '▼'),
        h('button.order-ctl', { type: 'button', onclick: () => { li.remove(); relabel(); } }, '✕'))));
    // A new exhibit starts with its title as a heading, like the others. One
    // that isn't changed keeps its HTML exactly.
    return Object.assign(li, { tabTitle: title, tabContent: content, tabHeading: tab.html ? heading : true, tabLegend: legend, tabBefore: { ...tab, text } });
  }

  // "Exhibit 2", and its buttons named for screen readers.
  function relabel() {
    const items = [...tabList.children];
    items.forEach((li, i) => {
      li.tabLegend.textContent = `Exhibit ${i + 1}`;
      const [up, down, remove] = li.querySelectorAll('.order-ctl');
      up.setAttribute('aria-label', `Move exhibit ${i + 1} up`);
      up.disabled = i === 0;
      down.setAttribute('aria-label', `Move exhibit ${i + 1} down`);
      down.disabled = i === items.length - 1;
      remove.setAttribute('aria-label', `Remove exhibit ${i + 1}`);
    });
    refresh();
  }

  function build() {
    const problems = [];
    const short = name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!short) problems.push('Type a short name for the case study, like "copd" or "hip-fracture".');
    else if (short !== key && Object.hasOwn(cases, short)) problems.push(`Another case study in this set is already called "${short}".`);
    if (!intro.value.trim()) problems.push('Type the introduction: who the client is and where, like "A nurse is caring for a 68-year-old client on a medical unit."');
    const tabs = [...tabList.children].map((li, i) => {
      const title = li.tabTitle.value.trim();
      if (!title) problems.push(`Exhibit ${i + 1} needs a tab title, like "Vital Signs".`);
      if (!li.tabContent.value.trim()) problems.push(`Exhibit ${i + 1} is empty. Type what it shows, or remove it with ✕.`);
      const before = li.tabBefore;
      const same = before.html && li.tabContent.value === before.text && title === (before.title ?? '').trim();
      return { title, html: same ? before.html : exhibitToHtml(li.tabContent.value, title, li.tabHeading) };
    });
    if (!tabs.length) problems.push('Add at least one exhibit tab.');
    const introHtml = key && intro.value === toText(c.intro) ? c.intro : toHtml(intro.value);
    return { short, study: { intro: introHtml, tabs }, problems };
  }

  let timer = 0;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { short, study, problems } = build();
      fill(problemsBox, tried && problems.length ? h('ul', problems.map(p => h('li', p))) : null);
      const area = h('div.qe-preview-area');
      const k = short || 'case';
      questionArea(area, { [k]: study }, { get: () => previewTab, set: (_, i) => (previewTab = i) })
        .show({ case: k }, h('p.field-help', 'The case study\'s questions show here, one at a time, next to its exhibits.'));
      fill(preview, h('p.qe-preview-title', 'Preview: what students see'), area);
    }, 150);
  }

  const addTab = h('button.btn.btn-small', {
    type: 'button',
    onclick: () => {
      const li = tabEditor();
      tabList.append(li);
      relabel();
      li.tabTitle.focus();
    },
  }, 'Add an exhibit tab');
  (c.tabs ?? []).forEach(tab => tabList.append(tabEditor(tab)));

  const form = h('form.q-editor.case-editor', {
    'aria-label': key ? `Edit case study ${key}` : 'New case study',
    novalidate: true,
    onsubmit: async e => {
      e.preventDefault();
      tried = true;
      const { short, study, problems } = build();
      if (problems.length) {
        fill(problemsBox, h('ul', problems.map(p => h('li', p))));
        problemsBox.scrollIntoView({ block: 'nearest' });
        return;
      }
      save.disabled = true;
      try {
        await onSave(short, study);
      } catch (err) {
        fill(problemsBox, h('ul', h('li', `It didn't save. ${problemText(err)}`)));
        save.disabled = false;
      }
    },
  },
    h('h2.section-title', key ? `Edit case study "${key}"` : 'New case study'),
    h('div.field', h('label.field-label', { for: 'ce-name' }, 'Short name'), name,
      h('p.field-help', 'Only you see it, here and in the question form. Use letters, numbers, and dashes, like "copd" or "hip-fracture".')),
    h('div.field', h('label.field-label', { for: 'ce-intro' }, 'Introduction'), intro,
      h('p.field-help', 'Students read it above the exhibit tabs.')),
    h('div.field',
      h('p.field-label', 'Exhibit tabs'),
      h('p.field-help', 'Each tab\'s title is its heading. In the content, a blank line starts a new paragraph, and tags like <b> work. For a table, put each row on its own line with | between the columns, or paste a table copied from Word or Excel; the first row is the heading row. For example:'),
      h('pre.ce-example', 'Vital sign | 0800 | 1200\nHeart rate | 88/min | 112/min\nTemperature | 37.2° C | 38.4° C'),
      tabList, h('div.form-actions', addTab), titles),
    problemsBox,
    h('div.form-actions', save, h('button.btn', { type: 'button', onclick: onCancel }, 'Cancel')),
    preview);
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  relabel();
  return form;
}
