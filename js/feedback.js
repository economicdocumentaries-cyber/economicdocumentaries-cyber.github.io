// Anonymous feedback about the site (SPEC 11.12, with the owner's landing page, 2026-11-05). A Feedback button on the
// homepage, and a link at the bottom of every page, open a short form: what it's about, and a message. Messages are
// saved in /feedback/<id> = { kind, text, page, at }, with no name, sign-in id, or score; anyone signed in can add one,
// and only the host can read them, on the host console's Feedback page. Each browser can send a few a day. Without
// Firebase there's nowhere to send them, so the button and link don't show.
import { h, fill, modal, toast, store, fmtDate } from './util.js';
import { groupStudyOn, connectStudent, problemText } from './firebase.js';

export const KINDS = { idea: 'An idea or request', problem: "Something isn't working", content: 'A study guide or question set' };
const TEXT_MAX = 600;
const SENT = 'pe.feedback'; // when this browser sent messages (times), for the daily limit
const PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export const feedbackOn = () => groupStudyOn();

const sentToday = () => (store.get(SENT, []) ?? []).filter(t => typeof t === 'number' && Date.now() - t < DAY_MS);

// The message's id: the time in base 36 and a few random letters, like the study guides' (the rules want 6 to 24
// lowercase letters or digits).
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// The page the message came from, as a path without anything a student typed: "/class/NU1120", "/setup/<set id>".
const pageNow = () => (location.hash.replace(/^#/, '') || '/').split('?')[0].slice(0, 100);

export async function openFeedback() {
  const radios = Object.entries(KINDS).map(([value, label], i) => h('label.choice-line.feedback-kind',
    h('input.ctl', { type: 'radio', name: 'feedback-kind', value, checked: i === 0 }), h('span', label)));
  const text = h('textarea.text-input.feedback-text#feedback-text', { rows: '5', maxlength: String(TEXT_MAX) });
  const count = h('span.feedback-count', `0 / ${TEXT_MAX}`);
  text.addEventListener('input', () => (count.textContent = `${text.value.length} / ${TEXT_MAX}`));
  const problem = h('p.form-problem', { role: 'alert' });
  const form = h('div.feedback-form',
    h('p', 'Ideas, problems, or requests for the site. The site\'s author reads every message.'),
    h('p.feedback-anon', h('b', 'Anonymous. '), 'It doesn\'t include your name, email, or scores. Please don\'t type anything personal.'),
    h('fieldset.feedback-kinds', h('legend.field-label', 'What\'s it about?'), radios),
    h('label.field-label', { for: 'feedback-text' }, 'Your message'),
    text,
    h('p.field-help', count, ' · A problem with one question? Use Report under that question, so it reaches the right set.'),
    problem);
  form.addEventListener('input', () => (problem.textContent = ''));
  const choice = await modal({
    title: 'Send Anonymous Feedback',
    message: form,
    buttons: [{ label: 'Send', value: 'send', accent: true }, { label: 'Cancel', value: 'cancel' }],
    focus: text,
    check: async value => {
      if (value !== 'send') return true;
      const message = text.value.trim().slice(0, TEXT_MAX);
      if (!message) {
        problem.textContent = 'Type your message first.';
        text.focus();
        return false;
      }
      if (sentToday().length >= PER_DAY) {
        problem.textContent = `You've sent ${PER_DAY} messages today. Thanks! Please send more tomorrow.`;
        return false;
      }
      problem.textContent = 'Sending…';
      const kind = form.querySelector('input[name=feedback-kind]:checked')?.value ?? 'idea';
      try {
        const db = await connectStudent();
        await db.write(`feedback/${newId()}`, { kind, text: message, page: pageNow(), at: db.serverTime() });
        store.set(SENT, [...sentToday(), Date.now()]);
        return true;
      } catch (err) {
        const refused = String(err?.code ?? '').toUpperCase() === 'PERMISSION_DENIED';
        problem.textContent = `The message wasn't sent. ${refused ? 'Please try again later.' : problemText(err)}`;
        return false;
      }
    },
  });
  if (choice === 'send') toast('Thanks! Your message was sent anonymously.');
}

// The homepage's Feedback button, in the corner of the screen.
export function feedbackButton() {
  if (!feedbackOn()) return null;
  return h('button.feedback-tab', { type: 'button', onclick: openFeedback, 'aria-label': 'Send anonymous feedback' },
    h('span.feedback-tab-icon', {
      'aria-hidden': 'true',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    }),
    h('span.feedback-tab-label', 'Feedback'));
}

// The line at the bottom of every page.
export function feedbackLine() {
  if (!feedbackOn()) return null;
  return h('p.feedback-line', 'Have an idea, or found a problem? ',
    h('button.link-button', { type: 'button', onclick: openFeedback }, 'Send anonymous feedback'));
}

// ---------- the host ----------

// How many messages there are, for the host console's menu.
export const feedbackCount = value => (value && typeof value === 'object' ? Object.keys(value).length : 0);

// The host console's Feedback page (#/host/feedback): the messages, newest first, each with Delete. Returns a
// function that stops it.
export function feedbackConsole(section, db, accountLine) {
  const list = h('ul.feedback-list');
  const empty = h('p.empty-note', 'No messages yet. They appear here as soon as a student sends one.');
  fill(section,
    h('h1.page-title', 'Feedback'),
    h('p.lead', 'Anonymous messages students sent about the site, from the Feedback button on the homepage and the link at the bottom of each page.'),
    list, empty, accountLine());
  const stop = db.watch('feedback', value => {
    const items = Object.entries(value && typeof value === 'object' ? value : {})
      .filter(([, m]) => m && typeof m === 'object' && typeof m.text === 'string')
      .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0));
    fill(list, items.map(([id, m]) => h('li.feedback-item',
      h('p.feedback-meta', h('span.tag', KINDS[m.kind] ?? 'Other'),
        ` ${m.at ? fmtDate(m.at) : ''}${m.page ? ` · from ${m.page}` : ''}`),
      h('p.feedback-message', m.text),
      h('button.btn.btn-small', { type: 'button', onclick: () => remove(id) }, 'Delete'))));
    list.hidden = !items.length;
    empty.hidden = !!items.length;
  }, err => fill(list, h('li', `The messages couldn't be loaded. ${problemText(err)}`)));

  async function remove(id) {
    const choice = await modal({
      title: 'Delete This Message?',
      message: 'It will be gone for good.',
      buttons: [{ label: 'Keep it', value: 'keep', accent: true }, { label: 'Delete', value: 'delete' }],
    });
    if (choice !== 'delete') return;
    try {
      await db.write(`feedback/${id}`, null);
      toast('The message was deleted.');
    } catch (err) {
      toast(`It wasn't deleted. ${problemText(err)}`, 9000);
    }
  }
  return stop;
}
