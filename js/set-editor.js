// The host console's Question sets pages (SPEC 11.3):
// - #/host/sets: every set by class, with Edit (name, description, class,
//   exam, questions per exam, shown or hidden), Questions, and Preview; plus
//   New set and Download a backup.
// - #/host/sets/<set id>: a set's questions. Changes go into a draft,
//   /setDrafts/<set id>, which only the host can read, until Publish changes
//   copies it into /setInfo/<set id> (questions and cases, as JSON text). The
//   first change to a set whose questions come from its file starts the draft
//   from the file's; the file stays as a backup. Multiple choice, select all,
//   select N, fill in the blank, ordered response, matrix, and drop-down
//   questions can be written and edited here; other types (and case study
//   exhibits) are kept as they are, and can be hidden or deleted.
import { h, fill, modal, toast } from './util.js';
import { problemText } from './firebase.js';
import { typeLabel, validateSet, validateQuestion, keyResponse } from './items.js';
import { defaultCount, questionParts, feedbackPanel, startExam, activeExam, DEFAULT_SETTINGS, PRESETS } from './exam.js';
import { LIMITS, readChanges, readDrafts, withChanges, keepChanges } from './set-changes.js';
import { arrange, newestSet, orderTools, dragSort, moved, readOrder, keepOrder } from './order.js';

// The types this editor writes, and the fields each one's form manages.
const MANAGED = {
  mc: ['options', 'answer'],
  sata: ['options', 'answer', 'scoring'],
  emr: ['options', 'answer', 'select'],
  fill: ['answer', 'unit', 'round', 'tolerance', 'strictZeros'],
  order: ['items'],
  matrix: ['rows', 'columns', 'answer', 'multiple', 'rowHeader'],
  dropdown: ['text', 'blanks'],
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
function toHtml(text) {
  const safe = text.trim().replace(new RegExp(`<(?!/?(?:${TAGS})\\b)`, 'gi'), '&lt;');
  const paragraphs = safe.split(/\n\s*\n/).map(p => p.trim().replace(/\n/g, '<br>')).filter(Boolean);
  return paragraphs.length > 1 ? paragraphs.map(p => `<p>${p}</p>`).join('') : paragraphs[0] ?? '';
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
  // them (with hidden questions), the drafts, and the database's exact copy.
  function backup() {
    const strip = ({ file, made, edited, ...set }) => set;
    const data = {
      backup: 'Practice Exam Center: question sets changed on the host console',
      savedAt: new Date().toISOString(),
      sets: all().filter(s => changes[s.id] || drafts[s.id]).map(strip),
      drafts,
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
      try {
        await db.update('', { [`setInfo/${set.id}`]: null, [`setDrafts/${set.id}`]: null });
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

// How a draft differs from what students see.
const bare = q => JSON.stringify({ ...q, hidden: undefined });
function differences(before, after) {
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
  return Object.entries(d).filter(([, n]) => n).map(([word, n]) => `${n} ${word}`);
}

export function questionsPage(section, db, { sets, courses }, accountLine, setId) {
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

  const saveDraft = (questions, cases) => db.write(`setDrafts/${setId}`, {
    questions: JSON.stringify(questions), cases: JSON.stringify(cases ?? {}), editedAt: db.serverTime(),
  });

  function paint(force = false) {
    if (pageProblem) {
      fill(section, h('h1.page-title', 'Question set'), h('p.notice', problemText(pageProblem)), accountLine());
      return;
    }
    if (loaded !== 3) return;
    const s = state();
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
        h('button.btn.btn-accent', { type: 'button', onclick: () => openEditor(null) }, 'Add a question')),
      editing?.id === '' ? editing.el : null,
      questions.length
        ? h('ol.q-list', { 'aria-label': 'Questions' }, questions.map((q, i) => questionRow(q, i + 1, live)))
        : h('p.empty-note', 'No questions yet. Click Add a question to write the first one.'),
      sourceNote(live, draft),
      accountLine());
  }

  // What students see now, or the draft and how to publish it.
  function statusBox(live, draft, questions, cases) {
    if (!draft) {
      return h('div.draft-box',
        h('p', live.questions.length ? `Students see ${plural(visible(live.questions).length, 'question')}.` : 'This set has no questions yet, so students don\'t see it.',
          ' Changes you make are kept as a draft until you publish them.'));
    }
    const diff = differences(live.questions, questions);
    const problems = validateSet({ ...live, questions, cases });
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

  function questionRow(q, n, live) {
    if (editing && editing.id === q.id) return editing.el;
    const old = live.questions.find(x => x.id === q.id);
    const badges = [!old ? 'New' : bare(old) !== bare(q) ? 'Changed' : null, q.hidden ? 'Hidden' : null].filter(Boolean);
    const editable = EDITABLE.includes(q.type);
    return h('li.q-row', { class: q.hidden ? 'is-hidden' : null },
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
    editing = {
      id: q?.id ?? '',
      el: questionEditor(q, {
        setId, questions, cases,
        onSave: async question => {
          const now = state();
          const next = q ? now.questions.map(x => (x.id === q.id ? question : x)) : [...now.questions, question];
          await saveDraft(next, now.cases);
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
    try {
      await db.write(`setDrafts/${setId}`, null);
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
    try {
      await db.update('', {
        [`setInfo/${setId}/questions`]: null, [`setInfo/${setId}/cases`]: null, [`setInfo/${setId}/publishedAt`]: null, [`setDrafts/${setId}`]: null,
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

// A form for one question (q: null for a new one). onSave(question) gets a
// question that passes every check.
function questionEditor(q, { setId, questions, cases, onSave, onCancel }) {
  const isNew = !q;
  let type = q?.type ?? 'mc';
  let typeForm = null;
  let tried = false; // problems show after the first Save
  const typeSelect = isNew ? h('select.text-input#qe-type', EDITABLE.map(t => h('option', { value: t }, typeLabel(t)))) : null;
  const topics = h('datalist#qe-topics', [...new Set(questions.map(x => x.topic).filter(isText))].sort(naturally).map(t => h('option', { value: t })));
  const topic = h('input.text-input#qe-topic', { type: 'text', list: 'qe-topics', maxlength: '80', value: q?.topic ?? '', autocomplete: 'off' });
  const stem = h('textarea.text-input#qe-stem', { rows: '4', value: toText(q?.stem) });
  const rationale = h('textarea.text-input#qe-rationale', { rows: '6', value: toText(q?.rationale) });
  const typeArea = h('div.qe-type-area');
  const problemsBox = h('div.qe-problems', { role: 'alert' });
  const waiting = () => [h('p.qe-preview-title', 'Preview'), h('p.field-help', 'The preview appears when the question is complete.')];
  const preview = h('div.qe-preview', waiting());
  const save = h('button.btn.btn-accent', { type: 'submit' }, isNew ? 'Add to draft' : 'Save in draft');

  function useType(t, carried = {}) {
    type = t;
    typeForm = TYPE_FORMS[t](isNew ? carried : q);
    fill(typeArea, typeForm.el);
    refresh();
  }

  // The question as the form has it, and what's missing in plain words.
  function build() {
    const { fields, problems } = typeForm.read();
    const kept = isNew ? {} : Object.fromEntries(Object.entries(q).filter(([k]) => !['id', 'type', 'topic', 'stem', 'rationale', ...MANAGED[q.type]].includes(k)));
    const question = { id: q?.id ?? nextId(setId, questions), type, topic: topic.value.trim(), stem: toHtml(stem.value), ...fields, rationale: toHtml(rationale.value), ...kept };
    const missing = [];
    if (!question.topic) missing.push('Type a topic, like "Pharmacology". Students see their score by topic.');
    if (!stem.value.trim()) missing.push('Type the question.');
    missing.push(...problems);
    if (!rationale.value.trim()) missing.push('Type the rationale: why the right answer is right, and why each wrong option is wrong.');
    return { question, problems: missing.length ? missing : validateQuestion(question, cases) };
  }

  let timer = 0;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { question, problems } = build();
      fill(problemsBox, tried && problems.length ? h('ul', problems.map(p => h('li', p))) : null);
      if (problems.length) fill(preview, waiting());
      else {
        const key = keyResponse(question);
        fill(preview,
          h('p.qe-preview-title', 'Preview: what students see, with the right answer marked'),
          questionParts(question, { response: key, review: true, idPrefix: 'qe-pv-' }),
          feedbackPanel(question, key));
        // The key is shown as if it were an answer; here it's the correct answer, not "your" answer.
        for (const m of preview.querySelectorAll('.mark.ok')) {
          if (m.lastChild?.textContent === ' Your answer') m.lastChild.textContent = ' Correct answer';
        }
      }
    }, 150);
  }

  const form = h('form.q-editor', {
    'aria-label': isNew ? 'New question' : `Edit question ${q.id}`,
    novalidate: true,
    onsubmit: async e => {
      e.preventDefault();
      tried = true;
      const { question, problems } = build();
      if (problems.length) {
        fill(problemsBox, h('ul', problems.map(p => h('li', p))));
        problemsBox.scrollIntoView({ block: 'nearest' });
        return;
      }
      save.disabled = true;
      try {
        await onSave(question);
      } catch (err) {
        fill(problemsBox, h('ul', h('li', `It didn't save. ${problemText(err)}`)));
        save.disabled = false;
      }
    },
  },
    h('h2.section-title', isNew ? 'New question' : `Edit question ${q.id}`),
    h('div.editor-grid',
      isNew ? h('div.field', h('label.field-label', { for: 'qe-type' }, 'Question type'), typeSelect)
        : h('div.field', h('p.field-label', 'Question type'), h('p.qe-fixed', typeLabel(type))),
      h('div.field', h('label.field-label', { for: 'qe-topic' }, 'Topic'), topic, topics)),
    q?.case ? h('p.field-help', `This question is part of a case study ("${q.case}"). Its exhibits stay as they are.`) : null,
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

const TYPE_FORMS = {
  mc: q => choicesForm(q, 'one'),
  sata: q => choicesForm(q, 'many'),
  emr: q => choicesForm(q, 'select'),
  fill: fillForm,
  order: orderForm,
  matrix: matrixForm,
  dropdown: dropdownForm,
};
