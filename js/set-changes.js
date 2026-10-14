// The host's changes to how question sets appear (SPEC 11.3), made on the
// host console's Question sets page (#/host/sets) and kept in Firebase at
// /setInfo/<set id>. Each one holds only what differs from the set's file, so
// later changes to the file still show where the host changed nothing: title,
// description, course ("" for no class), exam, defaultCount (0 for every
// question), and hidden. Students' pages put them on top of the files. The
// last ones seen are kept in this browser too, so pages don't wait for Firebase.
import { h, fill, modal, toast, store } from './util.js';
import { groupStudyOn, connectStudent, problemText } from './firebase.js';
import { defaultCount } from './exam.js';

const CACHE = 'pe.setInfo';
const LIMITS = { title: 120, description: 600, course: 20, exam: 60 }; // the same as database.rules.json
const FIELD_NAMES = { title: 'name', description: 'description', course: 'class', exam: 'exam', defaultCount: 'questions per exam', hidden: 'shown or hidden' };

const isText = v => typeof v === 'string' && v.trim() !== '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// /setInfo as Firebase has it, with anything malformed left out.
export function readChanges(value) {
  if (!value || typeof value !== 'object') return {};
  const all = {};
  for (const [id, c] of Object.entries(value)) {
    if (!c || typeof c !== 'object') continue;
    const clean = {};
    for (const key of ['title', 'description', 'course', 'exam']) {
      if (typeof c[key] === 'string' && c[key].length <= LIMITS[key] && (key !== 'title' || isText(c[key]))) clean[key] = c[key].trim();
    }
    if (Number.isInteger(c.defaultCount) && c.defaultCount >= 0) clean.defaultCount = c.defaultCount;
    if (typeof c.hidden === 'boolean') clean.hidden = c.hidden;
    if (Object.keys(clean).length) all[id] = clean;
  }
  return all;
}

// The sets with the host's changes. A class that's no longer in the class
// list is ignored, and a set in a class keeps an exam.
export function withChanges(sets, changes, courses = []) {
  return sets.map(set => {
    const c = changes?.[set.id];
    if (!c) return set;
    const out = { ...set };
    if (c.title) out.title = c.title;
    if ('description' in c) out.description = c.description || null;
    if (c.course === '') out.course = null;
    else if (c.course) out.course = courses.find(x => x.code.toLowerCase() === c.course.toLowerCase())?.code ?? out.course;
    if ('exam' in c && (c.exam || !out.course)) out.exam = c.exam || null;
    if ('defaultCount' in c) out.defaultCount = c.defaultCount || null;
    if ('hidden' in c) out.hidden = c.hidden;
    return out;
  });
}

// The changes last seen on this browser.
export const cachedChanges = () => (groupStudyOn() ? readChanges(store.get(CACHE)) : {});

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
        store.set(CACHE, changes);
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

// ---------- the host's "Question sets" page (#/host/sets) ----------

// Every set by class, each with an Edit form for its name, description,
// class, exam, questions per exam, and whether students see it. sets: the
// way their files have them (from loadSets). Returns a function that stops it.
export function setsConsole(section, db, { sets, courses }, accountLine) {
  document.title = 'Question sets · Host console';
  let changes = {};
  let loaded = false;
  let listProblem = null;
  let editing = null; // { id, el }: the set whose details are being changed
  const listArea = h('div.set-admin', h('p.lead', 'Loading the question sets…'));

  function setItem(set) {
    if (editing?.id === set.id) return editing.el;
    const n = defaultCount(set);
    const changed = Object.keys(changes[set.id] ?? {}).map(k => FIELD_NAMES[k]);
    return h('li.set-row',
      h('div.set-info',
        set.exam ? h('p.set-exam', h('span.tag', set.exam)) : null,
        h('h3', set.title),
        set.description ? h('p.set-desc', set.description) : null,
        h('p.set-meta', `${plural(set.questions.length, 'question')} · ${n ? `${n} per exam` : 'every question in each exam'}`),
        set.hidden || changed.length ? h('p.set-meta.set-flags',
          set.hidden ? h('b', 'Hidden from students') : null,
          set.hidden && changed.length ? ' · ' : null,
          changed.length ? `Changed here: ${changed.join(', ')}` : null) : null),
      h('div.set-actions',
        h('button.btn', { type: 'button', 'aria-label': `Edit ${set.title}`, onclick: () => edit(set) }, 'Edit'),
        h('a.btn', { href: `#/setup/${encodeURIComponent(set.id)}`, 'aria-label': `Preview ${set.title}` }, 'Preview')));
  }

  function paintList() {
    if (listProblem) {
      fill(listArea, h('p.notice', problemText(listProblem)));
      return;
    }
    if (!loaded) return;
    const all = withChanges(sets, changes, courses);
    const groups = courses.map(c => ({ key: c.code, label: `${c.code} · ${c.name}`, list: all.filter(s => s.course === c.code) }));
    const other = all.filter(s => !courses.some(c => c.code === s.course));
    if (other.length || !courses.length) groups.push({ key: 'other', label: courses.length ? 'Other' : 'Question sets', list: other });
    fill(listArea, groups.map(g => h('section.set-class',
      h('div.set-class-head',
        h('h2.set-class-title', g.label),
        courses.length ? h('a.link-btn', { href: `#/class/${encodeURIComponent(g.key)}` }, 'See it as students do') : null),
      g.list.length ? h('ul.set-list', g.list.map(setItem)) : h('p.empty-note', 'No question sets for this class yet.'))));
  }

  // Change a set's details. Only what differs from the set's file is saved.
  function edit(set) {
    const file = sets.find(s => s.id === set.id);
    const total = set.questions.length;
    const n = defaultCount(set);
    const title = h('input.text-input#set-title', { type: 'text', maxlength: String(LIMITS.title), value: set.title });
    const desc = h('textarea.text-input#set-desc', { rows: '3', maxlength: String(LIMITS.description), value: set.description ?? '' });
    const cls = h('select.text-input#set-class',
      courses.map(c => h('option', { value: c.code, selected: c.code === set.course }, `${c.code} · ${c.name}`)),
      h('option', { value: '', selected: !set.course }, courses.length ? 'Other (no class)' : 'No class'));
    const exams = h('datalist#set-exams');
    const exam = h('input.text-input#set-exam', { type: 'text', maxlength: String(LIMITS.exam), list: 'set-exams', value: set.exam ?? '', autocomplete: 'off' });
    const every = h('input.ctl#set-every', { type: 'radio', name: 'set-count', checked: !n });
    const some = h('input.ctl', { type: 'radio', name: 'set-count', checked: !!n, disabled: total < 2, 'aria-label': 'This many questions' });
    const count = h('input.num-input#set-count', {
      type: 'number', min: '1', max: String(Math.max(1, total - 1)), step: '1', inputmode: 'numeric', value: String(n ?? Math.min(25, Math.max(1, total - 1))), disabled: total < 2,
    });
    count.addEventListener('input', () => (some.checked = true));
    const shown = h('input.ctl#set-shown', { type: 'checkbox', checked: !set.hidden });
    const note = h('p.form-problem', { role: 'alert' });
    const save = h('button.btn.btn-accent', { type: 'submit' }, 'Save');

    // Exams already used in the chosen class, as suggestions.
    const suggest = () => fill(exams, [...new Set(withChanges(sets, changes, courses).filter(s => (s.course ?? '') === cls.value).map(s => s.exam).filter(isText))]
      .sort(naturally).map(e => h('option', { value: e })));
    cls.addEventListener('change', suggest);
    suggest();

    const done = () => {
      editing = null;
      paintList();
    };
    const fail = (text, field) => {
      note.textContent = text;
      field?.focus();
    };

    async function undo() {
      const choice = await modal({
        title: 'Undo Your Changes?',
        message: `${file.title} goes back to the way its file has it: the name, description, class, exam, questions per exam, and whether students see it.`,
        buttons: [{ label: 'Keep my changes', value: 'keep', accent: true }, { label: 'Undo changes', value: 'undo' }],
      });
      if (choice !== 'undo') return;
      try {
        await db.write(`setInfo/${set.id}`, null);
        toast('Done. It looks the way its file has it again.');
        done();
      } catch (err) {
        note.textContent = `It didn't change. ${problemText(err)}`;
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
          hidden: !shown.checked,
        };
        if (!want.title) return fail('Type a name for the set.', title);
        if (want.course && !want.exam) return fail('Type which exam or unit it\'s for, like "Exam 3". A set in a class needs one.', exam);
        if (some.checked && !(Number.isInteger(want.defaultCount) && want.defaultCount >= 1 && want.defaultCount < total)) {
          return fail(`Type a whole number from 1 to ${total - 1}, or choose every question.`, count);
        }
        // Only what differs from the file, so later changes to the file still show.
        const before = {
          title: file.title.trim(), description: (file.description ?? '').trim(), course: file.course ?? '', exam: (file.exam ?? '').trim(),
          defaultCount: defaultCount(file) ?? 0, hidden: !!file.hidden,
        };
        const differs = Object.fromEntries(Object.entries(want).filter(([key, value]) => value !== before[key]));
        save.disabled = true;
        try {
          await db.write(`setInfo/${set.id}`, Object.keys(differs).length ? { ...differs, editedAt: db.serverTime() } : null);
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
      h('label.choice-line.show-line', shown, h('span', 'Show this set on the homepage')),
      note,
      h('div.form-actions',
        save,
        h('button.btn', { type: 'button', onclick: done }, 'Cancel'),
        changes[set.id] ? h('button.link-btn', { type: 'button', onclick: undo }, 'Undo my changes') : null)));
    el.addEventListener('input', () => (note.textContent = '')); // a problem goes away once something changes
    editing = { id: set.id, el };
    paintList();
    title.focus();
  }

  const stop = db.watch('setInfo', value => {
    loaded = true;
    listProblem = null;
    changes = readChanges(value);
    store.set(CACHE, changes);
    paintList();
  }, err => {
    listProblem = err;
    paintList();
  });

  fill(section,
    h('h1.page-title', 'Question sets'),
    h('p.lead', 'Change a set\'s name, description, class, or exam, how many questions an exam has, or hide it from students. Students see your changes right away, with no publishing needed.'),
    listArea,
    accountLine());
  return () => stop();
}
