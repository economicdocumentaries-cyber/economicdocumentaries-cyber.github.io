// Loading the question sets listed in sets/index.json (SPEC 5.2, 5.3). Used by
// the homepage, setup, results, and group study.
import { validateSet } from './items.js';

let setsLoading = null;

// Loads every file listed in sets/index.json. A broken file never stops the
// others from loading; its problems are collected for the homepage (SPEC 5.3).
// Each problem: { file, title, question, qid, problem, code }.
export function loadSets() {
  setsLoading ??= fetchSets();
  return setsLoading;
}

// Where JSON.parse gave up: the line number from its error message, and that
// line with the one before it (a missing comma is usually at the end of the line before).
function jsonSpot(text, err) {
  const message = String(err?.message ?? '');
  let line = Number(/line (\d+)/i.exec(message)?.[1]);
  const position = /position (\d+)/i.exec(message)?.[1];
  if (!line && position != null) line = text.slice(0, Number(position)).split('\n').length;
  if (!line) return null;
  const lines = text.split('\n');
  const show = n => (n >= 1 && n <= lines.length ? `${String(n).padStart(4)} | ${lines[n - 1].trimEnd().slice(0, 110)}` : null);
  return { line, code: [show(line - 1), show(line)].filter(Boolean).join('\n') };
}

function typingMistake(text, err) {
  const spot = jsonSpot(text, err);
  return {
    problem: `This file has a typing mistake${spot ? ` near line ${spot.line}` : ''}, so it can't be read. `
      + `Look for a missing or extra comma, a missing quotation mark, or a missing } or ]${spot ? ', often at the end of the line before' : ''}.`,
    code: spot?.code ?? null,
  };
}

async function loadSet(file) {
  try {
    const res = await fetch(`sets/${encodeURI(file)}`, { cache: 'no-cache' });
    if (!res.ok) {
      return {
        file,
        found: [{
          problem: res.status === 404
            ? "The file isn't in the sets folder. Check that its name in sets/index.json matches the file name exactly, including capital letters."
            : `The file could not be downloaded (the server answered ${res.status}).`,
        }],
      };
    }
    const text = await res.text();
    let set;
    try {
      set = JSON.parse(text);
    } catch (err) {
      return { file, found: [typingMistake(text, err)] };
    }
    return { file, set, title: typeof set?.title === 'string' ? set.title : null, found: validateSet(set) };
  } catch (err) {
    return { file, found: [{ problem: `This file could not be loaded: ${err.message}.` }] };
  }
}

async function fetchSets() {
  const sets = [], problems = [];
  let files;
  try {
    const res = await fetch('sets/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status === 404 ? 'the file is missing' : `the server answered ${res.status}`);
    const text = await res.text();
    try {
      files = JSON.parse(text);
    } catch (err) {
      problems.push({ file: 'index.json', ...typingMistake(text, err) });
      return { sets, problems };
    }
    if (!Array.isArray(files) || !files.every(f => typeof f === 'string' && f.trim())) {
      throw new Error('it should be a list of file names in quotes, like ["my-set.json"]');
    }
  } catch (err) {
    problems.push({ file: 'index.json', problem: `The list of question sets could not be read: ${err.message}.` });
    return { sets, problems };
  }

  const results = await Promise.all([...new Set(files)].map(loadSet));
  const ids = new Set();
  for (const { file, set, title, found } of results) {
    if (!found.length && ids.has(set.id)) found.push({ problem: `Another file already uses the set id "${set.id}". Each set needs its own id.` });
    if (found.length) {
      problems.push(...found.map(p => ({ file, title: title ?? null, ...p })));
    } else {
      ids.add(set.id);
      sets.push({ ...set, file });
    }
  }
  return { sets, problems };
}
