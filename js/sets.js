// Loading the question sets listed in sets/index.json, the class list in
// sets/courses.json, and the study guides listed in guides/index.json
// (SPEC 5.2, 5.3, 11). Used by the homepage, setup, results, and group study.
import { validateSet } from './items.js';

let setsLoading = null;

const isText = v => typeof v === 'string' && v.trim() !== '';

// Loads the class list, the study guide list, and every file listed in
// sets/index.json. A broken file never stops the others from loading; its
// problems are collected for the homepage (SPEC 5.3).
// Returns { sets, courses, guides, problems }:
// - courses is [{ code, name, term }] in tab order, or [] without a class list.
// - guides is [{ file, title, course, exam, description, pages, updated }].
// - each problem is { file, title, question, qid, where, problem, code }, with
//   file as a path in the site, like "sets/my-set.json".
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

// Downloads a JSON file and reads it. Returns { data }, { missing: true }
// when there's no such file, or { problem, code } in plain words.
async function readJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (res.status === 404) return { missing: true };
    if (!res.ok) return { problem: `The file could not be downloaded (the server answered ${res.status}).` };
    const text = await res.text();
    try {
      return { data: JSON.parse(text) };
    } catch (err) {
      return typingMistake(text, err);
    }
  } catch (err) {
    return { problem: `This file could not be loaded: ${err.message}.` };
  }
}

async function loadSet(file) {
  const { data: set, missing, problem, code } = await readJson(`sets/${encodeURI(file)}`);
  if (missing) {
    return { file, found: [{ problem: "The file isn't in the sets folder. Check that its name in sets/index.json matches the file name exactly, including capital letters." }] };
  }
  if (problem) return { file, found: [{ problem, code }] };
  try {
    return { file, set, title: typeof set?.title === 'string' ? set.title : null, found: validateSet(set) };
  } catch (err) {
    return { file, found: [{ problem: `This file could not be checked: ${err.message}.` }] };
  }
}

// The class list (SPEC 11). Returns { courses, missing, problems }; courses
// is null when the file is missing or can't be read, and then the homepage
// lists every set without class tabs.
async function loadCourses() {
  const file = 'sets/courses.json';
  const { data, missing, problem, code } = await readJson(file);
  if (missing) return { courses: null, missing: true, problems: [] };
  const fallback = ' Until it is fixed, the homepage lists every set without class tabs.';
  if (problem) return { courses: null, problems: [{ file, problem: problem + fallback, code }] };
  if (!Array.isArray(data)) {
    return {
      courses: null,
      problems: [{ file, problem: `The class list should be a list in [ ], like [{ "code": "NU1110", "name": "Professional Nursing I", "term": "Fall 2026" }].${fallback}` }],
    };
  }
  const courses = [], problems = [], codes = new Set();
  data.forEach((c, i) => {
    const where = `Class ${i + 1}${isText(c?.code) ? ` ("${c.code}")` : ''}`;
    const note = text => problems.push({ file, where, problem: text });
    if (!c || typeof c !== 'object' || Array.isArray(c)) return note('This class is not written as an object { ... }.');
    const before = problems.length;
    if (!isText(c.code)) note('Missing "code" (the class code, like "NU1110").');
    else if (codes.has(c.code.trim().toLowerCase())) note(`Another class already uses the code "${c.code}". Each class needs its own code.`);
    if (!isText(c.name)) note('Missing "name" (the class name, like "Professional Nursing I").');
    if (c.term != null && !isText(c.term)) note('"term" must be text, like "Fall 2026".');
    if (problems.length > before) return;
    codes.add(c.code.trim().toLowerCase());
    courses.push({ code: c.code.trim(), name: c.name.trim(), term: isText(c.term) ? c.term.trim() : null });
  });
  return { courses, problems };
}

// The class a "course" names, matched without regard to capital letters.
const findCourse = (courses, code) => courses.find(c => c.code.toLowerCase() === code.trim().toLowerCase());

const unknownCourse = (code, courses) => (courses.length
  ? `"course" is "${code}", but sets/courses.json has no class with that code. Use one of: ${courses.map(c => c.code).join(', ')}.`
  : `"course" is "${code}", but sets/courses.json doesn't list any classes yet.`);

// "2026-10-13", and a real date.
function isDate(text) {
  const m = typeof text === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

// The study guide list, guides/index.json (SPEC 11). Each guide is a PDF in
// the guides folder, with a title, class, and exam. A guide with a mistake is
// left off the homepage; the others still show.
function checkGuides({ data, missing, problem, code }, courses) {
  const file = 'guides/index.json';
  if (missing) return { guides: [], problems: [] };
  const left = ' Until it is fixed, no study guides are listed.';
  if (problem) return { guides: [], problems: [{ file, problem: problem + left, code }] };
  if (!Array.isArray(data)) {
    return {
      guides: [],
      problems: [{ file, problem: `The list of study guides should be a list in [ ], like [{ "file": "nu1110-exam-2.pdf", "title": "Exam 2 Study Guide", "course": "NU1110", "exam": "Exam 2" }].${left}` }],
    };
  }
  const guides = [], problems = [], names = new Set();
  data.forEach((g, i) => {
    const where = `Guide ${i + 1}${isText(g?.file) ? ` ("${g.file}")` : ''}`;
    const note = text => problems.push({ file, where, problem: text });
    if (!g || typeof g !== 'object' || Array.isArray(g)) return note('This guide is not written as an object { ... }.');
    const before = problems.length;
    if (!isText(g.file)) note('Missing "file" (the name of the PDF in the guides folder, like "nu1110-exam-2.pdf").');
    else if (!/^[^\\/]+\.pdf$/i.test(g.file.trim()) || g.file.includes('..')) note('"file" must be the name of a PDF in the guides folder, ending in .pdf, like "nu1110-exam-2.pdf".');
    else if (names.has(g.file.trim().toLowerCase())) note('Another guide already uses this file.');
    if (!isText(g.title)) note('Missing "title" (the name students see).');
    if (!isText(g.course)) note('Missing "course" (the class code, like "NU1110").');
    else if (courses && !findCourse(courses, g.course)) note(unknownCourse(g.course, courses));
    if (!isText(g.exam)) note('Missing "exam" (the exam or unit it is for, like "Exam 2").');
    if (g.description != null && !isText(g.description)) note('"description" must be text.');
    if (g.pages != null && !(Number.isInteger(g.pages) && g.pages > 0)) note('"pages" must be a whole number, like 4, with no quotes.');
    if (g.updated != null && !isDate(g.updated)) note('"updated" must be a date written like "2026-10-13".');
    if (problems.length > before) return;
    names.add(g.file.trim().toLowerCase());
    guides.push({
      file: g.file.trim(),
      title: g.title.trim(),
      course: courses ? findCourse(courses, g.course).code : g.course.trim(),
      exam: g.exam.trim(),
      description: isText(g.description) ? g.description.trim() : null,
      pages: g.pages ?? null,
      updated: g.updated ?? null,
    });
  });
  return { guides, problems };
}

async function fetchSets() {
  const sets = [], problems = [];
  const [list, classes, guideList] = await Promise.all([readJson('sets/index.json'), loadCourses(), readJson('guides/index.json')]);
  const { courses } = classes;
  const study = checkGuides(guideList, courses);
  problems.push(...classes.problems);
  const done = () => ({ sets, courses: courses ?? [], guides: study.guides, problems: [...problems, ...study.problems] });

  const file = 'sets/index.json';
  if (list.missing) {
    problems.push({ file, problem: 'The list of question sets could not be read: the file is missing.' });
    return done();
  }
  if (list.problem) {
    problems.push({ file, problem: list.problem, code: list.code });
    return done();
  }
  const files = list.data;
  if (!Array.isArray(files) || !files.every(f => typeof f === 'string' && f.trim())) {
    problems.push({ file, problem: 'The list of question sets could not be read: it should be a list of file names in quotes, like ["my-set.json"].' });
    return done();
  }

  const results = await Promise.all([...new Set(files)].map(loadSet));
  const ids = new Set();
  for (const { file, set, title, found } of results) {
    let course = null;
    if (!found.length) {
      if (ids.has(set.id)) found.push({ problem: `Another file already uses the set id "${set.id}". Each set needs its own id.` });
      if (isText(set.course) && courses) {
        course = findCourse(courses, set.course);
        if (!course) found.push({ problem: unknownCourse(set.course, courses) });
      }
    }
    if (found.length) {
      problems.push(...found.map(p => ({ file: `sets/${file}`, title: title ?? null, ...p })));
    } else {
      ids.add(set.id);
      // "course" is stored the way the class list spells it.
      sets.push(isText(set.course) ? { ...set, course: course?.code ?? set.course.trim(), file } : { ...set, file });
    }
  }
  if (classes.missing && (sets.some(s => s.course) || study.guides.length)) {
    problems.unshift({ file: 'sets/courses.json', problem: 'The class list is missing, so the homepage lists everything without class tabs. It names the classes that the sets\' and study guides\' "course" fields refer to.' });
  }
  return done();
}
