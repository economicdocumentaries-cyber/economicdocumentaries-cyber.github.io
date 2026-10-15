// Anonymous usage stats with Umami Cloud (README "Usage stats"). The tracker
// script in index.html counts nothing by itself (data-auto-track="false"):
// this module sends one page view per page change (the # route as a path,
// like "/setup/nu1120-exam-3-senses") and a few events. Never names, group
// study display names, scores, or anything typed.
// The tracker sends only from the live site's domains (data-domains), so the
// local preview and the checks never count. A browser with localStorage
// "umami.disabled" sends nothing: the host's sign-in sets it, and so does
// #/stats-off. Calls made before the tracker loads wait in a short queue.
const OFF = 'umami.disabled';
const queue = [];

function flush() {
  const umami = window.umami;
  if (typeof umami?.track !== 'function') return;
  while (queue.length) {
    try {
      umami.track(...queue.shift());
    } catch {
      // Stats never get in the way of the site.
    }
  }
}
document.getElementById('umami')?.addEventListener('load', flush);

function statsOff() {
  try {
    return !!localStorage.getItem(OFF);
  } catch {
    return false;
  }
}

function send(...args) {
  if (statsOff()) return;
  queue.push(args);
  if (queue.length > 30) queue.shift(); // the tracker is blocked or slow: keep only the latest
  flush();
}

// A page change. path: like "/" or "/class/NU1120".
export function trackPage(path) {
  send(props => ({ ...props, url: path, title: document.title }));
}

// An event, with a few plain details (left out when empty).
export function track(name, details = {}) {
  const data = Object.fromEntries(Object.entries(details).filter(([, v]) => v != null && v !== ''));
  send(name, Object.keys(data).length ? data : undefined);
}

// Whether this browser's visits count. The host's own browsers are turned off.
export const thisBrowserCounts = () => !statsOff();
export function countThisBrowser(on) {
  try {
    if (on) localStorage.removeItem(OFF);
    else localStorage.setItem(OFF, '1');
  } catch {
    // Private windows can refuse; the tracker then just keeps counting.
  }
}
