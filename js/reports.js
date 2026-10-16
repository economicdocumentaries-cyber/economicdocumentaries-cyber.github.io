// Reporting a problem with a question (SPEC 11.6). Under a question's
// rationale, in practice mode and when reviewing answers, students can report
// what's wrong: a reason, and an optional note. Reports are saved in
// /reports/<set>/<question>/<student's anonymous id> = { reason, note?, at },
// one per question per student; only the host can read them (a student, only
// their own). The host
// console's Reports page lists them, with Edit question and Mark fixed.
// Without Firebase, there's nothing to report to, so the link doesn't show.
import { h, fill, modal, toast, store, fmtDate } from './util.js';
import { groupStudyOn, connectStudent, problemText } from './firebase.js';
import { track } from './analytics.js';
import { withChanges, readChanges } from './set-changes.js';
import { typeLabel } from './items.js';

export const REASONS = {
  answer: 'The answer marked correct is wrong',
  unclear: 'A typo, or the question or choices are unclear',
  rationale: 'The rationale is wrong or confusing',
  picture: 'A picture, table, or exhibit is wrong or missing',
  other: 'Something else',
};
const NOTE_MAX = 500; // the same as database.rules.json
const SENT = 'pe.reported'; // { "<set id>|<question id>": true }: reported on this browser

// Set and question ids as database keys, which can't hold . # $ [ ] or /.
const toKey = id => String(id).replace(/[.#$[\]/%]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const fromKey = key => key.replace(/%([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
const sentKey = (setId, qid) => `${setId}|${qid}`;
const plainText = html => {
  const t = document.createElement('template');
  t.innerHTML = String(html ?? '');
  return t.content.textContent.replace(/\s+/g, ' ').trim();
};

// ---------- students ----------

// The line under a rationale: "Report a problem with this question", or, once
// it's reported on this browser, "You reported this question. Thanks!".
export function reportLine(setId, q) {
  if (!groupStudyOn() || !setId || !q?.id) return null;
  const button = h('button.link-btn.report-btn', { type: 'button' });
  const line = h('p.report-line', button);
  const sent = () => !!store.get(SENT, {})[sentKey(setId, q.id)];
  const paint = () => {
    // aria-disabled rather than disabled, so the keyboard focus can come back here after sending.
    if (sent()) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    fill(button, sent() ? 'You reported this question. Thanks!' : 'Report a problem with this question');
  };
  button.addEventListener('click', () => {
    if (!sent()) openReport(setId, q, paint);
  });
  paint();
  return line;
}

function markSent(setId, qid) {
  store.set(SENT, { ...store.get(SENT, {}), [sentKey(setId, qid)]: true });
}

async function openReport(setId, q, onDone) {
  const radios = Object.entries(REASONS).map(([value, label]) => h('label.choice-line.report-reason',
    h('input.ctl', { type: 'radio', name: 'report-reason', value }), h('span', label)));
  const note = h('textarea.text-input.report-note#report-note', { rows: '3', maxlength: String(NOTE_MAX) });
  const problem = h('p.form-problem', { role: 'alert' });
  const form = h('div.report-form',
    h('p', 'Tell the site\'s author what\'s wrong, so it can be fixed. Reports don\'t include your name.'),
    h('fieldset.report-reasons', h('legend.field-label', 'What\'s wrong?'), radios),
    h('label.field-label', { for: 'report-note' }, 'More details ', h('span.optional', '(optional)')),
    note,
    h('p.field-help', 'Please don\'t include your name or anything personal.'),
    problem);
  form.addEventListener('change', () => (problem.textContent = ''));
  let reason = null;
  const choice = await modal({
    title: 'Report a Problem',
    message: form,
    buttons: [{ label: 'Send report', value: 'send', accent: true }, { label: 'Cancel', value: 'cancel' }],
    focus: radios[0].querySelector('input'),
    check: async value => {
      if (value !== 'send') return true;
      reason = form.querySelector('input[name=report-reason]:checked')?.value ?? null;
      if (!reason) {
        problem.textContent = 'Choose what\'s wrong.';
        radios[0].querySelector('input').focus();
        return false;
      }
      problem.textContent = 'Sending…';
      const text = note.value.trim().slice(0, NOTE_MAX);
      let db = null;
      let path = null;
      try {
        db = await connectStudent();
        path = `reports/${toKey(setId)}/${toKey(q.id)}/${db.uid}`;
        await db.write(path, { reason, ...(text ? { note: text } : {}), at: db.serverTime() });
        return true;
      } catch (err) {
        // Refused: if this student's report is already there, they reported the
        // question before (in another tab, say). Otherwise it's a real problem.
        const refused = String(err?.code ?? '').toUpperCase() === 'PERMISSION_DENIED';
        if (refused && path && await db.read(path).then(v => v != null, () => false)) {
          markSent(setId, q.id);
          onDone();
          problem.textContent = 'You already reported this question. Thanks!';
          return false;
        }
        // problemText's words for a refusal are for the host, so students get these.
        problem.textContent = `The report wasn't sent. ${refused ? 'Please try again later.' : problemText(err)}`;
        return false;
      }
    },
  });
  if (choice !== 'send') return;
  markSent(setId, q.id);
  onDone();
  toast('Thanks! Your report was sent.');
  track('question-report', { set: setId, reason }); // never the note
}

// ---------- the host ----------

// How many questions have reports, for the host console's menu.
export function reportedCount(value) {
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((sum, set) => sum + (set && typeof set === 'object' ? Object.keys(set).length : 0), 0);
}

// /reports as a list of questions, newest report first:
// [{ setKey, qKey, setId, qid, reports: [{ reason, note, at }], latest }].
function readReports(value) {
  const out = [];
  for (const [setKey, questions] of Object.entries(value ?? {})) {
    for (const [qKey, byStudent] of Object.entries(questions ?? {})) {
      const reports = Object.values(byStudent ?? {})
        .filter(r => r && REASONS[r.reason])
        .map(r => ({ reason: r.reason, note: typeof r.note === 'string' ? r.note : '', at: Number(r.at) || 0 }))
        .sort((a, b) => b.at - a.at);
      if (reports.length) out.push({ setKey, qKey, setId: fromKey(setKey), qid: fromKey(qKey), reports, latest: reports[0].at });
    }
  }
  return out.sort((a, b) => b.latest - a.latest);
}

// The host console's Reports page (#/host/reports). Returns a function that stops it.
export function reportsConsole(section, db, { sets, courses }, accountLine) {
  document.title = 'Reports · Host console';
  let changes = {};
  let reports = [];
  let loaded = 0; // 1: /setInfo, 2: /reports
  let problem = null;
  const list = h('div.report-list', h('p.lead', 'Loading the reports…'));

  function paint() {
    if (problem) return fill(list, h('p.notice', problemText(problem)));
    if (loaded !== 3) return;
    if (!reports.length) {
      return fill(list, h('p.empty-note', 'No reports right now. Students can report a problem from a question\'s rationale, in practice mode or when they review their answers.'));
    }
    const all = withChanges(sets, changes, courses, { keepHidden: true });
    fill(list, reports.map(item => {
      const set = all.find(s => s.id === item.setId);
      const n = set ? set.questions.findIndex(q => q.id === item.qid) : -1;
      const q = n >= 0 ? set.questions[n] : null;
      const course = set?.course ? courses.find(c => c.code === set.course) : null;
      const counts = Object.keys(REASONS).map(r => [r, item.reports.filter(x => x.reason === r).length]).filter(([, c]) => c);
      const notes = item.reports.filter(r => r.note);
      return h('section.report-item',
        h('p.q-row-head',
          h('b', set ? set.title : item.setId), course ? ` · ${course.code}` : '',
          q ? ` · question ${n + 1} (${item.qid}) · ${typeLabel(q.type)} · ${q.topic}` : ` · ${item.qid}`),
        h('p.report-stem', q ? plainText(q.stem).slice(0, 260) : 'This question isn\'t in the set any more.'),
        h('ul.report-reasons-list', counts.map(([r, c]) => h('li', h('b', `${c} ×`), ` ${REASONS[r]}`))),
        notes.length ? h('ul.report-notes', notes.map(r => h('li', h('span.report-date', fmtDate(r.at, true)), ' ', `“${r.note}”`))) : null,
        h('p.report-meta', `${item.reports.length === 1 ? '1 report' : `${item.reports.length} reports`}, the latest ${fmtDate(item.latest)}.`),
        h('div.set-actions',
          q ? h('a.btn', { href: `#/host/sets/${encodeURIComponent(item.setId)}/${encodeURIComponent(item.qid)}`, 'aria-label': `Edit question ${n + 1} of ${set.title}` }, 'Edit question') : null,
          h('button.btn', { type: 'button', 'aria-label': `Mark fixed: ${set ? `question ${n + 1} of ${set.title}` : item.qid}`, onclick: () => markFixed(item) }, 'Mark fixed')));
    }));
  }

  async function markFixed(item) {
    const choice = await modal({
      title: 'Mark as Fixed?',
      message: `The ${item.reports.length === 1 ? 'report' : `${item.reports.length} reports`} for this question ${item.reports.length === 1 ? 'is' : 'are'} deleted. If students report it again, it comes back to this list.`,
      buttons: [{ label: 'Mark fixed', value: 'fixed', accent: true }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'fixed') return;
    try {
      await db.write(`reports/${item.setKey}/${item.qKey}`, null);
      toast('Marked fixed.');
    } catch (err) {
      toast(`It didn't change. ${problemText(err)}`, 9000);
    }
  }

  const fail = err => {
    problem = err;
    paint();
  };
  const stopInfo = db.watch('setInfo', value => {
    changes = readChanges(value);
    loaded |= 1;
    paint();
  }, fail);
  const stopReports = db.watch('reports', value => {
    reports = readReports(value);
    loaded |= 2;
    paint();
  }, fail);
  fill(section,
    h('h1.page-title', 'Reports'),
    h('p.lead', 'Problems students reported with questions, newest first. Reports don\'t include names. Fix the question with Edit question (or ask Claude, who can read these reports), then click Mark fixed to clear its reports.'),
    list,
    accountLine());
  return () => {
    stopInfo();
    stopReports();
  };
}
