// Study guides the host uploads on the host console (SPEC 11.2). Firebase's
// file storage needs the paid plan, so each PDF is kept in the Realtime
// Database (free on the Spark plan) as base64 text in pieces,
// /guideFiles/<id>/<n>, and its details are in /guides/<id>. Students see
// uploaded guides on their class's tab right away, next to the guides that
// are published with the site files (SPEC 11.1).
import { h, fill, modal, toast, fmtDate } from './util.js';
import { groupStudyOn, connectStudent, problemText } from './firebase.js';
import { arrange, newestGuide, guideKey, orderTools, dragSort, moved, readOrder, keepOrder } from './order.js';
import { track } from './analytics.js';

const LIMIT_MB = 5; // the same as for published files (tools/publish.py)
export const MAX_GUIDE_BYTES = LIMIT_MB * 1024 * 1024;
const PIECE_BYTES = 3 * 131072; // 384 KB, exactly 512 KB of base64, so the pieces join cleanly
const FREE_STORAGE = 1024 ** 3; // the Spark plan stores 1 GB

const isText = v => typeof v === 'string' && v.trim() !== '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// 350 KB, 1.2 MB, 3 MB
export function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${+(bytes / 1048576).toFixed(1)} MB`;
}

// The name a downloaded guide is saved as: the class and title, like
// "NU1110 Exam 2 Study Guide.pdf" (the title alone if it starts with the class).
export function guideFileName(guide) {
  const name = `${guide.title.toLowerCase().startsWith(guide.course.toLowerCase()) ? '' : `${guide.course} `}${guide.title}`;
  return `${name.replace(/[\\/:*?"<>|]+/g, '-').trim()}.pdf`;
}

// The uploaded guides in /guides, shaped like the published ones plus
// { id, uploaded: true, size, chunks, added }, sorted by exam, then title.
// "course" is spelled the way the class list spells it. Entries with a
// mistake are skipped.
export function readUploaded(value, courses = []) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([id, g]) => {
    if (!g || typeof g !== 'object' || ![g.title, g.course, g.exam].every(isText) || !(g.chunks > 0) || !(g.size > 0)) return [];
    const course = g.course.trim();
    return [{
      id,
      uploaded: true,
      title: g.title.trim(),
      course: courses.find(c => c.code.toLowerCase() === course.toLowerCase())?.code ?? course,
      exam: g.exam.trim(),
      description: isText(g.description) ? g.description.trim() : null,
      size: g.size,
      chunks: g.chunks,
      added: Number(g.uploadedAt) || null,
    }];
  }).sort((a, b) => naturally(a.exam, b.exam) || naturally(a.title, b.title));
}

// Calls onChange with the uploaded guides now and after every change. For the
// homepage: problems are ignored, because it works the same without them.
// Returns a function that stops it.
export function watchUploadedGuides(courses, onChange) {
  let stop = () => {};
  let stopped = false;
  if (groupStudyOn()) {
    connectStudent().then(db => {
      if (!stopped) stop = db.watch('guides', value => onChange(readUploaded(value, courses)), () => {});
    }, () => {});
  }
  return () => {
    stopped = true;
    stop();
  };
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Fetches an uploaded guide's pieces and saves it as a PDF.
async function downloadUploaded(guide) {
  const db = await connectStudent();
  const raw = await db.read(`guideFiles/${guide.id}`);
  const pieces = Array.isArray(raw) ? raw : Object.keys(raw ?? {}).sort((a, b) => a - b).map(key => raw[key]);
  if (pieces.length !== guide.chunks || !pieces.every(p => typeof p === 'string')) {
    throw new Error('This study guide is missing part of its file. Ask the host to upload it again.');
  }
  const url = URL.createObjectURL(new Blob(pieces.map(fromBase64), { type: 'application/pdf' }));
  const link = h('a', { href: url, download: guideFileName(guide), hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The Download button for an uploaded guide.
export function downloadButton(guide, { accent = true } = {}) {
  const button = h('button.btn', { type: 'button', class: accent ? 'btn-accent' : null, 'aria-label': `Download ${guide.title} (PDF)` }, 'Download');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Downloading…';
    try {
      await downloadUploaded(guide);
      track('guide-download', { class: guide.course, guide: guide.title, kind: 'uploaded' });
    } catch (err) {
      toast(err.code ? `The study guide didn't download. ${problemText(err)}` : err.message, 9000);
    } finally {
      button.disabled = false;
      button.textContent = 'Download';
    }
  });
  return button;
}

// Asks before the page closes while an upload is running.
const stayWhileUploading = e => {
  e.preventDefault();
  e.returnValue = '';
};

// Uploads the file in pieces, then its details. The details go last, so
// students never see a guide whose file isn't all there.
async function upload(db, details, bytes, fileName, onProgress) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const count = Math.max(1, Math.ceil(bytes.length / PIECE_BYTES));
  addEventListener('beforeunload', stayWhileUploading);
  try {
    for (let i = 0; i < count; i++) {
      await db.write(`guideFiles/${id}/${i}`, toBase64(bytes.subarray(i * PIECE_BYTES, (i + 1) * PIECE_BYTES)));
      onProgress((i + 1) / count);
    }
    await db.write(`guides/${id}`, { ...details, name: fileName.slice(0, 120), size: bytes.length, chunks: count, uploadedAt: db.serverTime() });
  } catch (err) {
    db.write(`guideFiles/${id}`, null).catch(() => {});
    throw err;
  } finally {
    removeEventListener('beforeunload', stayWhileUploading);
  }
}

// ---------- the host's "Study guides" page (#/host/guides) ----------

// Upload a PDF to a class, and see, edit, and delete what's on the site.
// published: the guides published with the site files (shown, not editable here).
// Returns a function that stops it.
export function guidesConsole(section, db, { courses, sets, published }, accountLine) {
  document.title = 'Study guides · Host console';
  let uploaded = [];
  let order = {};
  let loaded = 0; // 1: /guides, 2: /order, 3: both
  let listProblem = null;
  let editing = null; // { id, el }: the guide whose details are being changed
  const listArea = h('div.guide-admin', h('p.lead', 'Loading the study guides…'));

  // The order students see a class's guides in (SPEC 11.4); null for newest first.
  async function saveOrder(code, keys) {
    try {
      await db.update(`order/${code}`, { guides: keys ? JSON.stringify(keys) : null });
    } catch (err) {
      toast(`The order wasn't saved. ${problemText(err)}`, 9000);
    }
  }

  if (!courses.length) {
    fill(section,
      h('h1.page-title', 'Study guides'),
      h('p.notice', 'There are no classes yet, so there\'s nowhere to put a study guide. The class list is sets/courses.json: ask Claude to add your classes.'),
      accountLine());
    return () => {};
  }

  // --- the upload form ---
  const classSelect = h('select.text-input#guide-class', courses.map(c => h('option', { value: c.code }, `${c.code} · ${c.name}`)));
  const exams = h('datalist#guide-exams');
  const examInput = h('input.text-input#guide-exam', { type: 'text', maxlength: '60', list: 'guide-exams', placeholder: 'Exam 2', autocomplete: 'off' });
  const titleInput = h('input.text-input#guide-title', { type: 'text', maxlength: '120', placeholder: 'Exam 2 Study Guide', autocomplete: 'off' });
  const descInput = h('input.text-input#guide-desc', { type: 'text', maxlength: '200', autocomplete: 'off' });
  const fileInput = h('input.file-input#guide-file', { type: 'file', accept: '.pdf,application/pdf' });
  const ownWork = h('input.ctl#guide-own', { type: 'checkbox' });
  const problem = h('p.form-problem', { role: 'alert' });
  const progress = h('progress.upload-bar', { max: '100', value: '0', 'aria-label': 'Upload progress' });
  const progressText = h('span');
  const progressBox = h('div.upload-progress', { hidden: true }, progress, progressText);
  const uploadBtn = h('button.btn.btn-accent.btn-big', { type: 'submit' }, 'Upload study guide');

  // Exams already used in this class, as suggestions.
  function suggestExams() {
    const code = classSelect.value;
    const used = [...sets.filter(s => s.course === code).map(s => s.exam), ...published.filter(g => g.course === code).map(g => g.exam),
      ...uploaded.filter(g => g.course === code).map(g => g.exam)].filter(isText);
    fill(exams, [...new Set(used)].sort(naturally).map(exam => h('option', { value: exam })));
  }
  classSelect.addEventListener('change', suggestExams);

  const form = h('form.host-card.guide-form', {
    onsubmit: async e => {
      e.preventDefault();
      problem.textContent = '';
      const file = fileInput.files[0];
      const fail = (text, field) => {
        problem.textContent = text;
        field?.focus();
      };
      if (!examInput.value.trim()) return fail('Type which exam or unit it\'s for, like "Exam 2".', examInput);
      if (!titleInput.value.trim()) return fail('Type a title, like "Exam 2 Study Guide".', titleInput);
      if (!file) return fail('Choose the PDF to upload.', fileInput);
      if (file.size > MAX_GUIDE_BYTES) {
        const mb = Math.ceil(file.size / 104857.6) / 10; // rounded up, so it never looks like the limit itself
        return fail(`That PDF is ${mb} MB, and the limit is ${LIMIT_MB} MB. Save a smaller PDF (in Word: File > Save As > PDF, then "Minimum size"), or split it into two guides.`, fileInput);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!/\.pdf$/i.test(file.name) || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
        return fail('That file isn\'t a PDF. Open it, save it as a PDF (File > Save As > PDF), and choose that file.', fileInput);
      }
      if (!ownWork.checked) return fail('Tick the box to confirm this guide is your own work.', ownWork);

      const details = { title: titleInput.value.trim(), course: classSelect.value, exam: examInput.value.trim() };
      if (descInput.value.trim()) details.description = descInput.value.trim();
      uploadBtn.disabled = true;
      progressBox.hidden = false;
      const show = share => {
        progress.value = String(Math.round(share * 100));
        progressText.textContent = `Uploading… ${Math.round(share * 100)}%`;
      };
      show(0);
      try {
        await upload(db, details, bytes, file.name, show);
        toast(`Uploaded. Students can see it on the ${details.course} tab now.`, 6000);
        titleInput.value = '';
        descInput.value = '';
        fileInput.value = '';
        ownWork.checked = false;
      } catch (err) {
        fail(`The study guide didn't upload. ${problemText(err)}`);
      } finally {
        uploadBtn.disabled = false;
        progressBox.hidden = true;
      }
    },
  },
    h('h2.section-title', 'Add a study guide'),
    h('div.field', h('label.field-label', { for: 'guide-class' }, 'Class'), classSelect),
    h('div.field', h('label.field-label', { for: 'guide-exam' }, 'Exam or unit'), examInput, exams),
    h('div.field', h('label.field-label', { for: 'guide-title' }, 'Title'), titleInput),
    h('div.field', h('label.field-label', { for: 'guide-desc' }, 'Description ', h('span.optional', '(optional)')), descInput),
    h('div.field',
      h('label.field-label', { for: 'guide-file' }, 'PDF file'), fileInput,
      h('p.field-help', `A PDF up to ${LIMIT_MB} MB. To turn a Word or PowerPoint file into a PDF: File > Save As (or Export) > PDF.`)),
    h('label.choice-line.own-work', ownWork,
      h('span', 'I made this guide myself, or Claude wrote it from my notes in its own words (pictures from the class slides are fine). It isn\'t textbook pages, test questions, or a file copied from the class folder.')),
    problem,
    progressBox,
    h('div.form-actions', uploadBtn));

  // --- what's on the site ---
  // tools: the grip and ▲ ▼ for this row (none while a guide's details are open).
  function guideItem(guide, tools = null) {
    if (guide.uploaded && editing?.id === guide.id) return editing.el;
    const facts = guide.uploaded
      ? ['PDF', formatSize(guide.size), guide.added ? `Added ${fmtDate(guide.added, true)}` : null]
      : ['PDF', 'Published with the site files. To change it, ask Claude.'];
    return h('li.set-row.guide-row', { 'data-key': guideKey(guide) },
      tools,
      h('div.set-info',
        h('p.set-exam', h('span.tag', guide.exam)),
        h('h4', guide.title),
        guide.description ? h('p.set-desc', guide.description) : null,
        h('p.set-meta', facts.filter(Boolean).join(' · '))),
      h('div.set-actions', guide.uploaded
        ? [downloadButton(guide, { accent: false }),
            h('button.btn', { type: 'button', 'aria-label': `Edit ${guide.title}`, onclick: () => edit(guide) }, 'Edit'),
            h('button.btn', { type: 'button', 'aria-label': `Delete ${guide.title}`, onclick: () => remove(guide) }, 'Delete')]
        : h('a.btn', { href: `guides/${encodeURIComponent(guide.file)}`, download: guideFileName(guide), 'aria-label': `Download ${guide.title} (PDF)` }, 'Download')));
  }

  function paintList() {
    if (listProblem) {
      fill(listArea, h('h2.section-title', 'On the site now'), h('p.notice', problemText(listProblem)));
      return;
    }
    if (loaded !== 3) return;
    const total = uploaded.reduce((sum, g) => sum + Math.ceil(g.size / 3) * 4, 0); // stored as base64 text
    const share = (total / FREE_STORAGE) * 100;
    const known = new Set(courses.map(c => c.code));
    const lost = uploaded.filter(g => !known.has(g.course));
    fill(listArea,
      h('h2.section-title', 'On the site now'),
      h('p.usage-note', uploaded.length
        ? `${plural(uploaded.length, 'uploaded guide')} · about ${formatSize(total)} of the free 1 GB (${share < 0.1 ? 'under 0.1' : share.toFixed(1)}%)`
        : 'No uploaded guides yet.'),
      courses.map(c => {
        // In the order students see them; drag a guide's grip, or use ▲ ▼, to move it.
        const list = arrange([...published.filter(g => g.course === c.code), ...uploaded.filter(g => g.course === c.code)],
          guideKey, order[c.code]?.guides, newestGuide);
        const keys = list.map(guideKey);
        const canMove = list.length > 1 && !editing;
        const ul = h('ul.set-list', { class: canMove ? 'orderable' : null }, list.map((g, i) => guideItem(g,
          canMove ? orderTools(g.title, i, list.length, to => saveOrder(c.code, moved(keys, i, to))) : null)));
        if (canMove) dragSort(ul, next => saveOrder(c.code, next));
        return h('section.guide-class',
          h('div.guide-class-head',
            h('h3.guide-class-title', `${c.code} · ${c.name}`),
            h('span.set-class-links',
              order[c.code]?.guides ? h('button.link-btn', { type: 'button', onclick: () => saveOrder(c.code, null) }, 'Newest first') : null,
              h('a.link-btn', { href: `#/class/${encodeURIComponent(c.code)}` }, 'See it as students do'))),
          list.length ? ul : h('p.empty-note', 'No study guides for this class yet.'));
      }),
      lost.length ? h('section.guide-class',
        h('h3.guide-class-title', 'Not on the site'),
        h('p.field-help', 'These guides\' class isn\'t in the class list any more, so students can\'t see them. Edit them to choose a class, or delete them.'),
        h('ul.set-list', lost.map(guideItem))) : null);
    suggestExams();
  }

  // Change a guide's class, exam, title, or description (the file stays).
  function edit(guide) {
    const id = `edit-${guide.id}`;
    const cls = h('select.text-input', { id: `${id}-class` }, courses.map(c => h('option', { value: c.code, selected: c.code === guide.course }, `${c.code} · ${c.name}`)));
    const exam = h('input.text-input', { id: `${id}-exam`, type: 'text', maxlength: '60', value: guide.exam });
    const title = h('input.text-input', { id: `${id}-title`, type: 'text', maxlength: '120', value: guide.title });
    const desc = h('input.text-input', { id: `${id}-desc`, type: 'text', maxlength: '200', value: guide.description ?? '' });
    const note = h('p.form-problem', { role: 'alert' });
    const save = h('button.btn.btn-accent', { type: 'submit' }, 'Save');
    const done = () => {
      editing = null;
      paintList();
    };
    const el = h('li.guide-editor', h('form', {
      'aria-label': `Edit ${guide.title}`,
      onsubmit: async e => {
        e.preventDefault();
        if (!exam.value.trim() || !title.value.trim()) {
          note.textContent = 'The exam or unit and the title can\'t be empty.';
          return;
        }
        save.disabled = true;
        try {
          await db.update(`guides/${guide.id}`, {
            course: cls.value, exam: exam.value.trim(), title: title.value.trim(), description: desc.value.trim() || null, editedAt: db.serverTime(),
          });
          toast('Saved.');
          done();
        } catch (err) {
          note.textContent = `It didn't save. ${problemText(err)}`;
          save.disabled = false;
        }
      },
    },
      h('div.editor-grid',
        h('div.field', h('label.field-label', { for: `${id}-class` }, 'Class'), cls),
        h('div.field', h('label.field-label', { for: `${id}-exam` }, 'Exam or unit'), exam),
        h('div.field', h('label.field-label', { for: `${id}-title` }, 'Title'), title),
        h('div.field', h('label.field-label', { for: `${id}-desc` }, 'Description ', h('span.optional', '(optional)')), desc)),
      note,
      h('div.form-actions', save, h('button.btn', { type: 'button', onclick: done }, 'Cancel'))));
    editing = { id: guide.id, el };
    paintList();
    title.focus();
  }

  async function remove(guide) {
    const choice = await modal({
      title: 'Delete This Study Guide?',
      message: `${guide.title} (${guide.course}, ${guide.exam}) will disappear from the site for everyone. This can't be undone.`,
      buttons: [{ label: 'Keep it', value: 'keep', accent: true }, { label: 'Delete', value: 'delete' }],
    });
    if (choice !== 'delete') return;
    try {
      await db.update('', { [`guides/${guide.id}`]: null, [`guideFiles/${guide.id}`]: null });
      toast('Deleted.');
    } catch (err) {
      toast(`It wasn't deleted. ${problemText(err)}`, 9000);
    }
  }

  const stop = db.watch('guides', value => {
    loaded |= 1;
    listProblem = null;
    uploaded = readUploaded(value, courses);
    if (editing && !uploaded.some(g => g.id === editing.id)) editing = null;
    paintList();
  }, err => {
    listProblem = err;
    paintList();
  });
  const stopOrder = db.watch('order', value => {
    order = readOrder(value);
    keepOrder(order);
    loaded |= 2;
    paintList();
  }, err => {
    listProblem = err;
    paintList();
  });

  fill(section,
    h('h1.page-title', 'Study guides'),
    h('p.lead', 'Upload a PDF to a class. Students see it on that class\'s tab on the homepage right away, with no publishing needed, newest first. To change the order, drag a guide by its grip (⠿), or use ▲ ▼. Anyone who opens the site can download a guide.'),
    form,
    listArea,
    accountLine());
  suggestExams();
  return () => {
    stop();
    stopOrder();
  };
}
