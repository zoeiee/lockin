"use strict";

const app = document.getElementById("app");
const storageNote = document.getElementById("storage-note");
const courseLink = document.getElementById("courses-link");
const intro = document.getElementById("intro");
const courseList = [
  ["microbiology", "Microbiology", "./data/microbiology.csv"],
  ["biochemistry", "Biochemistry", "./data/biochemistry.csv"],
  ["cell-molecular-biology", "Cell & Molecular Biology", "./data/cell-molecular-biology.csv"],
].map(([slug, name, csv]) => ({
  slug, name, csv,
  art: document.getElementById(`art-${slug}`).innerHTML,
  cards: [],
  sections: [],
  records: new Map(),
  history: [],
  selected: new Set(),
  expanded: new Set(),
  shuffle: true,
  skipRight: false,
  loadError: false,
}));
const courses = new Map(courseList.map((course) => [course.slug, course]));
const labels = { right: "Right", wrong: "Wrong", later: "Review later", unmarked: "Unmarked" };
const grades = ["again", "hard", "good", "easy"];
const gradeLabels = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };
const gradeHints = { again: "Forgot the answer", hard: "Recalled with difficulty", good: "Recalled correctly", easy: "Recalled immediately" };
const stageLabels = { new: "New", learning: "Learning", relearning: "Relearning", review: "Review" };
const defaultLimits = Object.freeze({ new: 20, review: 200 });
const emptyRecord = Object.freeze({ mark: "unmarked", later: false, schedule: null, newOn: null, reviewOn: null });
const minute = 60_000;
const dayLength = 86_400_000;
const learnAhead = 20 * minute;
const maxInterval = 36_500;
const storagePrefix = "lock-in.flashcards.v1/";
const volatileStorage = new Map();
const number = new Intl.NumberFormat();
const scoreNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const pageSize = 40;
const searchPageSize = 16;
const arrow = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>';
const openArrow = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h11m-4.5-4.5L15 10l-4.5 4.5"/></svg>';
const searchIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8.6" cy="8.6" r="4.8"/><path d="m12.3 12.3 3.9 3.9"/></svg>';

let ready = false;
let introActive = false;
let introTimer;
let courseView = null;
let studyView = null;
let scoreLists = null;
let session = null;

function escapeHTML(value) {
  const chars = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (character) => chars[character]);
}

function parseCSV(text) {
  if (text.startsWith("\ufeff")) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;

  function endField() {
    row.push(field);
    field = "";
    closedQuote = false;
  }

  function endRow() {
    if (!row.length && !field && !closedQuote) return;
    endField();
    rows.push(row);
    row = [];
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closedQuote = true;
      }
    } else if (char === ",") {
      endField();
    } else if (char === "\r" || char === "\n") {
      endRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (char === '"' && !field && !closedQuote) {
      quoted = true;
    } else {
      if (char === '"' || closedQuote) throw new Error("Invalid CSV quoting");
      field += char;
    }
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  endRow();
  return rows;
}

function cardFingerprint(fields) {
  const text = JSON.stringify(fields);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    first = Math.imul(first ^ char, 0x01000193);
    second = Math.imul(second ^ char, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

async function loadCourse(course) {
  try {
    const response = await fetch(course.csv);
    if (!response.ok) throw new Error("CSV request failed");
    const [header, ...rows] = parseCSV(await response.text());
    if (header?.length !== 3 || header.join(",") !== "chapter,question,answer") {
      throw new Error("Incorrect CSV header");
    }
    const sections = new Map();
    const occurrences = new Map();
    const cards = rows.map((row, index) => {
      if (row.length !== 3) throw new Error("Incorrect CSV column count");
      const [chapter, question, answer] = row;
      const fingerprint = cardFingerprint(row);
      const occurrence = (occurrences.get(fingerprint) || 0) + 1;
      occurrences.set(fingerprint, occurrence);
      if (!sections.has(chapter)) sections.set(chapter, { name: chapter, cards: [] });
      const card = {
        id: `${fingerprint}-${occurrence}`,
        number: index + 1,
        chapter,
        question,
        answer,
        searchText: `${question}\n${answer}`.toLowerCase(),
      };
      sections.get(chapter).cards.push(card);
      return card;
    });
    course.cards = cards;
    course.sections = Array.from(sections.values());
  } catch {
    course.loadError = true;
  }
}

function savedKeys() {
  const keys = new Set(volatileStorage.keys());
  try {
    for (let i = 0; i < localStorage.length; i++) keys.add(localStorage.key(i));
  } catch {
    storageNote.hidden = false;
  }
  return Array.from(keys).filter((key) => key?.startsWith(storagePrefix));
}

function readSaved(key) {
  if (volatileStorage.has(key)) return volatileStorage.get(key);
  try {
    return localStorage.getItem(key);
  } catch {
    storageNote.hidden = false;
    return null;
  }
}

function writeSaved(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    volatileStorage.delete(key);
  } catch {
    volatileStorage.set(key, value);
    storageNote.hidden = false;
  }
}

function markPrefix(course) { return `${storagePrefix}${course.slug}/mark/`; }
function historyPrefix(course) { return `${storagePrefix}${course.slug}/session/`; }
function limitsKey(course) { return `${storagePrefix}${course.slug}/limits`; }

function storedJSON(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function decodeRecord(raw) {
  // Marks from the original site have no scheduling history.
  if (raw === "right" || raw === "wrong") return { ...emptyRecord, mark: raw };
  if (raw === "later") return { ...emptyRecord, later: true };
  const record = storedJSON(raw);
  if (!record || typeof record !== "object") return emptyRecord;
  const schedule = record.schedule;
  const validSchedule = schedule && (
    (schedule.stage === "review" && Number.isSafeInteger(schedule.dueDay) &&
      Number.isSafeInteger(schedule.interval) && schedule.interval > 0 && Number.isFinite(schedule.ease)) ||
    ((schedule.stage === "learning" || schedule.stage === "relearning") &&
      (Number.isFinite(schedule.dueAt) || Number.isSafeInteger(schedule.dueDay)))
  );
  return {
    mark: record.mark === "right" || record.mark === "wrong" ? record.mark : "unmarked",
    later: record.later === true,
    schedule: validSchedule ? schedule : null,
    newOn: Number.isSafeInteger(record.newOn) ? record.newOn : null,
    reviewOn: Number.isSafeInteger(record.reviewOn) ? record.reviewOn : null,
  };
}

function readRecords(course) {
  course.records.clear();
  const prefix = markPrefix(course);
  for (const card of course.cards) {
    const record = decodeRecord(readSaved(prefix + card.id));
    if (record !== emptyRecord) course.records.set(card.id, record);
  }
}

function saveRecord(course, card, record) {
  const raw = JSON.stringify(record);
  writeSaved(markPrefix(course) + card.id, raw);
  course.records.set(card.id, record);
  return raw;
}

function readLimits(course) {
  const saved = storedJSON(readSaved(limitsKey(course)));
  return {
    new: validLimit(saved?.new) ? saved.new : defaultLimits.new,
    review: validLimit(saved?.review) ? saved.review : defaultLimits.review,
  };
}

function validLimit(value) {
  return Number.isInteger(value) && value >= 0 && value <= 9999;
}

function readHistory(course, keys) {
  course.history = [];
  const prefix = historyPrefix(course);
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const entry = storedJSON(readSaved(key));
    if (entry && typeof entry.scope === "string" && Number.isFinite(entry.endedAt) &&
        Number.isFinite(new Date(entry.endedAt).getTime()) &&
        ["right", "wrong", "later", "total"].every((name) => Number.isSafeInteger(entry[name]) && entry[name] >= 0) &&
        covered(entry) <= entry.total) {
      course.history.push(entry);
    }
  }
  course.history.sort((first, second) => second.endedAt - first.endedAt);
}

function tally(course, cards) {
  const counts = { right: 0, wrong: 0, later: 0 };
  for (const card of cards) {
    const record = course.records.get(card.id);
    if (record?.mark === "right" || record?.mark === "wrong") counts[record.mark]++;
    if (record?.later) counts.later++;
  }
  return counts;
}

function reviewed(counts) { return counts.answers ?? (counts.right + counts.wrong + counts.later); }
function covered(counts) { return counts.covered ?? reviewed(counts); }
function percent(top, bottom) { return bottom ? (100 * top) / bottom : 0; }
function showPercent(value) { return `${scoreNumber.format(value)}%`; }
function quantity(value, noun) { return `${number.format(value)} ${noun}${value === 1 ? "" : "s"}`; }
function courseHref(course) { return `#/course/${course.slug}`; }
function studyHref(course) { return `#/study/${course.slug}`; }
function courseCounts(course) { return `${quantity(course.sections.length, "section")} · ${quantity(course.cards.length, "card")}`; }

function progress(value, label) {
  return `<div class="progress" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}">
    <span class="progress-fill" style="width:${value}%"></span>
  </div>`;
}

function cover(course) {
  return `<div class="cover" data-course="${course.slug}" aria-hidden="true">${course.art}</div>`;
}

function breadcrumb(course, page) {
  if (!page) {
    return `<nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="#/">Courses</a><span aria-hidden="true">/</span>
      <span aria-current="page">${escapeHTML(course.name)}</span>
    </nav>`;
  }
  return `<nav class="breadcrumb" aria-label="Breadcrumb">
    <a href="#/">Courses</a><span aria-hidden="true">/</span>
    <a href="${courseHref(course)}">${escapeHTML(course.name)}</a><span aria-hidden="true">/</span>
    <span aria-current="page">${page}</span>
  </nav>`;
}

function renderDashboard() {
  const keys = savedKeys();
  const tiles = courseList.map((course) => {
    readRecords(course);
    readHistory(course, keys);
    const latest = course.history[0];
    const correct = percent(tally(course, course.cards).right, course.cards.length);
    const today = queueCounts(dailyQueue(course));
    return `<a class="course-tile" href="${courseHref(course)}">
      ${cover(course)}
      <div class="tile-body">
        <div>
          <div class="tile-title"><h2>${escapeHTML(course.name)}</h2>${openArrow}</div>
          <p class="tile-meta">${course.loadError ? "Flashcards unavailable" : courseCounts(course)}</p>
          ${course.cards.length ? `<p class="tile-queue number">${number.format(today.new)} new · ${number.format(today.learning)} learning · ${number.format(today.review)} due</p>` : ""}
        </div>
        <div class="tile-progress">
          <p class="progress-caption"><span>Marked right</span><strong class="number">${showPercent(correct)}</strong></p>
          ${progress(correct, "Cards marked right")}
        </div>
        <dl class="tile-last"><dt>Last session</dt><dd class="number">${latest ? showPercent(percent(latest.right, reviewed(latest))) : "—"}</dd></dl>
      </div>
    </a>`;
  }).join("");
  app.innerHTML = `<div class="page-heading"><h1>Courses</h1><p>Choose a course to browse flashcards or start a revision session.</p></div>
    <div class="course-grid">${tiles}</div>`;
}

function historyMarkup(course) {
  if (!course.history.length) return '<p class="empty">No sessions yet.</p>';
  return `<ol class="history-list">${course.history.map((entry) => {
    const date = new Date(entry.endedAt);
    const scheduled = entry.answers !== undefined;
    return `<li class="history-row">
      <strong class="history-score number">${showPercent(percent(entry.right, reviewed(entry)))}</strong>
      <div><span class="history-scope">${escapeHTML(entry.scope)}</span>
        <p class="history-detail">
          <span>${number.format(entry.right)} right</span> <span>${number.format(entry.wrong)} ${scheduled ? "again" : "wrong"}</span>
          <span>${number.format(entry.later)} ${scheduled ? "flagged" : "later"}</span> <span>${number.format(covered(entry))} reviewed</span>
        </p>
      </div>
      <time datetime="${date.toISOString()}">${escapeHTML(dateFormat.format(date))}</time>
    </li>`;
  }).join("")}</ol>`;
}

function cardListMarkup(id, action, index, hidden = false) {
  return `<div class="card-list" id="${id}"${hidden ? " hidden" : ""}>
    <div class="card-items"></div>
    <button class="button ghost" type="button" data-action="${action}" data-index="${index}" hidden>Show more cards</button>
  </div>`;
}

function sectionMarkup(section, index) {
  return `<section class="section-row" data-section="${index}">
    <div class="section-head">
      <label class="section-check"><input type="checkbox" data-section-check="${index}" aria-label="Select ${escapeHTML(section.name)}"></label>
      <button class="section-toggle" type="button" data-action="expand" data-index="${index}" aria-expanded="false" aria-controls="section-cards-${index}">
        ${arrow}<span>${escapeHTML(section.name)}</span>
      </button>
      <div class="section-tally"></div>
      <button class="button" type="button" data-action="revise-section" data-index="${index}" aria-label="Revise ${escapeHTML(section.name)}">Revise</button>
    </div>
    ${cardListMarkup(`section-cards-${index}`, "more-section", index, true)}
  </section>`;
}

function queueMarkup(counts) {
  return `<dl class="queue-stats">
    <div><dt>New</dt><dd data-queue="new">${number.format(counts.new)}</dd></div>
    <div><dt>Learning</dt><dd data-queue="learning">${number.format(counts.learning)}</dd></div>
    <div><dt>Review</dt><dd data-queue="review">${number.format(counts.review)}</dd></div>
  </dl>`;
}

function updateQueue(root, counts) {
  for (const count of root.querySelectorAll("[data-queue]")) {
    count.textContent = number.format(counts[count.dataset.queue]);
  }
}

function dailyMarkup(course) {
  if (!course.cards.length) return "";
  const queue = dailyQueue(course);
  const limits = readLimits(course);
  return `<section class="daily-panel panel" id="daily-panel" aria-labelledby="daily-title">
    <div class="daily-top">
      <div><h2 id="daily-title">Today’s study</h2><p class="daily-message muted" role="status">${queue.length ? "New cards, learning steps, and due reviews." : "No cards in today’s queue."}</p></div>
      ${queueMarkup(queueCounts(queue))}
      <button class="button primary" id="study-today" type="button" data-action="study-today"${queue.length ? "" : " disabled"}>Study today</button>
    </div>
    <details class="daily-options">
      <summary>Daily limits</summary>
      <form id="daily-limits">
        <label>New cards per day <input name="new" type="number" min="0" max="9999" required value="${limits.new}"></label>
        <label>Reviews per day <input name="review" type="number" min="0" max="9999" required value="${limits.review}"></label>
        <button class="button" type="submit">Save limits</button>
      </form>
      <p class="muted">A new study day starts at 4:00 AM local time.</p>
    </details>
  </section>`;
}

function updateDailyPanel(view) {
  if (!view.daily) return;
  const queue = dailyQueue(view.course);
  updateQueue(view.daily, queueCounts(queue));
  view.daily.querySelector("#study-today").disabled = queue.length === 0;
  view.daily.querySelector(".daily-message").textContent = queue.length
    ? "New cards, learning steps, and due reviews."
    : "No cards in today’s queue.";
}

function renderCourse(course) {
  readRecords(course);
  readHistory(course, savedKeys());
  const disabled = course.cards.length ? "" : " disabled";
  const missing = course.loadError ? "Could not load this course’s CSV." : "No flashcards yet.";
  app.innerHTML = `${breadcrumb(course)}
    <div class="course-hero">
      <div class="course-title"><h1>${escapeHTML(course.name)}</h1><p>${course.loadError ? "Flashcards unavailable" : courseCounts(course)}</p></div>
      ${cover(course)}
    </div>
    <section class="course-area" aria-label="Revision controls and sections">
      ${dailyMarkup(course)}
      <div class="toolbar panel">
        <h2 class="custom-title">Custom study</h2>
        <div class="toolbar-row">
          <button class="button" type="button" data-action="revise-all"${disabled}>Revise entire course</button>
          <button class="button" id="selected-button" type="button" data-action="revise-selected" disabled>Revise selected · 0 sections</button>
          <button class="button" id="later-button" type="button" data-action="revise-later" hidden>Review later</button>
        </div>
        <div class="toolbar-row toolbar-options">
          <button class="button ghost" id="select-all" type="button" data-action="select-all">Select all</button>
          <button class="button ghost" id="clear-selection" type="button" data-action="clear-selection">Clear selection</button>
          <label class="toggle"><input id="shuffle" role="switch" type="checkbox"${course.shuffle ? " checked" : ""}${disabled}>Shuffle</label>
          <label class="toggle"><input id="skip-right" role="switch" type="checkbox"${course.skipRight ? " checked" : ""}${disabled}>Skip cards already right</label>
          <button class="button ghost reset" id="reset-marks" type="button" data-action="ask-reset">Reset marks</button>
        </div>
      </div>
      <p class="notice" id="course-notice" role="status"></p>
      <div class="section-heading">
        <h2>Sections</h2>
        <label class="search">${searchIcon}<input type="search" id="search" aria-label="Search questions and answers" placeholder="Search questions and answers" autocomplete="off" spellcheck="false"${disabled}></label>
      </div>
      <p class="search-meta muted" id="search-meta" role="status"></p>
      <div class="section-list">${course.sections.map(sectionMarkup).join("")}</div>
      <p class="empty" id="course-empty"${disabled ? "" : " hidden"}>${missing}</p>
    </section>
    <section class="history" aria-labelledby="history-title">
      <h2 id="history-title">Session history</h2>
      ${historyMarkup(course)}
    </section>
    <dialog class="panel reset-dialog" id="reset-dialog" aria-labelledby="reset-title">
      <form method="dialog">
        <h2 id="reset-title">Reset marks?</h2>
        <p>Clear card marks and Review later flags for ${escapeHTML(course.name)}.</p>
        <div class="actions">
          <button class="button" value="cancel" autofocus>Cancel</button>
          <button class="button primary" value="reset">Reset marks</button>
        </div>
      </form>
    </dialog>`;

  const view = {
    course,
    query: "",
    searchCollapsed: new Set(),
    searchTimer: undefined,
    rows: Array.from(app.querySelectorAll(".section-row"), (row, index) => ({
      row,
      section: course.sections[index],
      check: row.querySelector("input"),
      toggle: row.querySelector(".section-toggle"),
      tally: row.querySelector(".section-tally"),
      list: connectCardList(row.querySelector(".card-list"), course),
    })),
    searchMeta: document.getElementById("search-meta"),
    empty: document.getElementById("course-empty"),
    notice: document.getElementById("course-notice"),
    dialog: document.getElementById("reset-dialog"),
    daily: document.getElementById("daily-panel"),
  };
  courseView = view;
  view.dialog.addEventListener("close", () => {
    if (view === courseView && view.dialog.returnValue === "reset") resetMarks(view);
  });
  updateToolbar(view);
  updateTallies(view);
  view.rows.forEach((row, index) => updateSection(view, row, index));
  if (view.daily) view.dailyTimer = setInterval(() => updateDailyPanel(view), minute);
}

function updateToolbar(view) {
  const { course } = view;
  const selected = course.selected.size;
  const selectedButton = document.getElementById("selected-button");
  selectedButton.textContent = `Revise selected · ${quantity(selected, "section")}`;
  selectedButton.disabled = selected === 0;
  document.getElementById("select-all").disabled = selected === course.sections.length;
  document.getElementById("clear-selection").disabled = selected === 0;
  const counts = tally(course, course.cards);
  document.getElementById("reset-marks").disabled = !counts.right && !counts.wrong && !counts.later;
  const { later } = counts;
  const laterButton = document.getElementById("later-button");
  laterButton.textContent = `Review later · ${number.format(later)}`;
  laterButton.hidden = later === 0;
  view.rows.forEach((row, index) => { row.check.checked = course.selected.has(index); });
}

function updateTallies(view) {
  for (const row of view.rows) {
    const counts = tally(view.course, row.section.cards);
    row.tally.innerHTML = `<span>${quantity(row.section.cards.length, "card")}</span>
      <span>${number.format(counts.right)} right</span><span>${number.format(counts.wrong)} wrong</span><span>${number.format(counts.later)} later</span>`;
  }
}

function resetMarks(view) {
  const prefix = markPrefix(view.course);
  for (const key of savedKeys()) {
    if (!key.startsWith(prefix)) continue;
    const record = decodeRecord(readSaved(key));
    if (record.schedule) writeSaved(key, JSON.stringify({ ...record, mark: "unmarked", later: false }));
    else writeSaved(key, null);
  }
  readRecords(view.course);
  updateToolbar(view);
  updateTallies(view);
  view.rows.forEach((row, index) => updateSection(view, row, index));
  view.notice.textContent = "Card marks reset.";
}

function connectCardList(container, course, fixedMark = null) {
  return {
    container, course, fixedMark,
    items: container.querySelector(".card-items"),
    more: container.querySelector("button"),
    cards: [],
    rendered: 0,
    reveal: false,
  };
}

function browseCard(card, list) {
  const record = list.course.records.get(card.id) ?? emptyRecord;
  const mark = list.fixedMark || record.mark;
  const next = !list.fixedMark && record.schedule;
  const date = next && (next.dueAt !== undefined ? dateFormat : dayFormat).format(dueAt(next));
  return `<article class="browse-card">
    <div class="browse-card-head">
      <span class="card-index number">#${number.format(card.number)}</span>
      <div><p class="card-copy browse-question">${escapeHTML(card.question)}</p>
        ${list.fixedMark ? `<span class="result-chapter">${escapeHTML(card.chapter)}</span>` : ""}
        ${next ? `<span class="result-chapter">${stageLabels[next.stage]} · ${escapeHTML(date)}</span>` : ""}
      </div>
      <div class="card-pills">
        <span class="pill" data-mark="${mark}">${labels[mark]}</span>
        ${!list.fixedMark && record.later ? '<span class="pill" data-mark="later">Review later</span>' : ""}
      </div>
    </div>
    <details class="answer-disclosure"${list.reveal ? " open" : ""}>
      <summary><span class="when-closed">Show answer</span><span class="when-open">Hide answer</span></summary>
      <p class="card-copy">${escapeHTML(card.answer)}</p>
    </details>
  </article>`;
}

function setCardList(list, cards, reveal = false) {
  list.cards = cards;
  list.rendered = 0;
  list.reveal = reveal;
  list.items.replaceChildren();
  appendCards(list);
}

function appendCards(list, moveFocus = false) {
  const start = list.rendered;
  const stop = Math.min(list.cards.length, start + (list.reveal ? searchPageSize : pageSize));
  const html = list.cards.slice(start, stop).map((card) => browseCard(card, list)).join("");
  if (html) list.items.insertAdjacentHTML("beforeend", html);
  list.rendered = stop;
  const remaining = list.cards.length - stop;
  list.more.hidden = remaining === 0;
  list.more.textContent = `Show more cards · ${number.format(remaining)} remaining`;
  if (moveFocus) list.items.children[start]?.querySelector("summary").focus();
}

function updateSection(view, row, index) {
  const searching = Boolean(view.query);
  const matches = searching
    ? row.section.cards.filter((card) => card.searchText.includes(view.query))
    : row.section.cards;
  row.row.hidden = searching && !matches.length;
  const open = !row.row.hidden && (searching ? !view.searchCollapsed.has(index) : view.course.expanded.has(index));
  row.toggle.setAttribute("aria-expanded", String(open));
  row.list.container.hidden = !open;
  setCardList(row.list, open ? matches : [], searching);
  return matches.length;
}

function applySearch(view, query) {
  if (view !== courseView || view.query === query) return;
  view.query = query;
  view.searchCollapsed.clear();
  let matches = 0;
  let sections = 0;
  view.rows.forEach((row, index) => {
    const count = updateSection(view, row, index);
    matches += count;
    if (count) sections++;
  });
  view.searchMeta.textContent = query ? `${number.format(matches)} match${matches === 1 ? "" : "es"} in ${quantity(sections, "section")}` : "";
  view.empty.textContent = "No matching flashcards.";
  view.empty.hidden = !query || matches > 0;
}

function shuffleCards(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const next = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[next]] = [cards[next], cards[i]];
  }
}

// Classic Anki scheduling for one deck, with its standard learning steps.
function studyDay(at) {
  const date = new Date(at);
  if (date.getHours() < 4) date.setDate(date.getDate() - 1);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / dayLength;
}

function studyDayStart(day) {
  const date = new Date(day * dayLength);
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 4).getTime();
}

function reviewPlan(days, ease, lapses) {
  return { stage: "review", days, ease, lapses };
}

function learningPlan(stage, step, minutes, ease = 250, lapses = 0) {
  return { stage, step, minutes, ease, lapses };
}

function reviewInterval(raw, minimum = 1) {
  return Math.min(maxInterval, Math.max(minimum, Math.round(raw)));
}

function spreadInterval(raw, minimum, roll) {
  const spread = raw < 2.5 ? 0 : 1
    + Math.max(0, Math.min(raw, 7) - 2.5) * .15
    + Math.max(0, Math.min(raw, 20) - 7) * .10
    + Math.max(0, raw - 20) * .05;
  const low = reviewInterval(raw - spread, minimum);
  const high = reviewInterval(raw + spread, low);
  return low + Math.floor(roll * (high - low + 1));
}

function answerPlans(state, day, roll) {
  if (!state || state.stage === "learning") {
    const step = state?.step === 1 ? 1 : 0;
    return {
      again: learningPlan("learning", 0, 1),
      hard: learningPlan("learning", step, step ? 10 : 5.5),
      good: step ? reviewPlan(1, 250, 0) : learningPlan("learning", 1, 10),
      easy: reviewPlan(4, 250, 0),
    };
  }
  const { ease, lapses } = state;
  if (state.stage === "relearning") {
    return {
      again: learningPlan("relearning", 0, 10, ease, lapses),
      hard: learningPlan("relearning", 0, 15, ease, lapses),
      good: reviewPlan(1, ease, lapses),
      easy: reviewPlan(2, ease, lapses),
    };
  }
  const days = state.interval;
  const late = day - state.dueDay;
  const factor = ease / 100;
  let hard;
  let good;
  let easy;
  if (late < 0) {
    const elapsed = Math.max(0, days + late);
    hard = reviewInterval(Math.max(elapsed * 1.2, days * .6));
    good = reviewInterval(Math.max(elapsed * factor, days));
    easy = reviewInterval(Math.max(elapsed * factor, days) * 1.15);
  } else {
    hard = spreadInterval(days * 1.2, days + 1, roll);
    good = spreadInterval((days + late / 2) * factor, hard + 1, roll);
    easy = spreadInterval((days + late) * factor * 1.3, good + 1, roll);
  }
  return {
    again: learningPlan("relearning", 0, 10, Math.max(130, ease - 20), lapses + 1),
    hard: reviewPlan(hard, Math.max(130, ease - 15), lapses),
    good: reviewPlan(good, ease, lapses),
    easy: reviewPlan(easy, ease + 15, lapses),
  };
}

function scheduleFromPlan(plan, now, roll) {
  const { stage, days, minutes, step, ease, lapses } = plan;
  const day = studyDay(now);
  if (stage === "review") return { stage, dueDay: day + days, interval: days, ease, lapses };
  const dueAt = now + Math.round((minutes + roll * Math.min(minutes / 4, 5)) * minute);
  const dueDay = studyDay(dueAt);
  const due = dueDay === day ? { dueAt } : { dueDay };
  return { stage, ...due, step, ease, lapses };
}

function queueKind(schedule) {
  if (!schedule) return "new";
  return schedule.stage === "review" ? "review" : "learning";
}

function dueAt(schedule) {
  return schedule.dueAt ?? studyDayStart(schedule.dueDay);
}

function intervalLabel(plan, now) {
  const days = plan.days ?? (studyDay(now + plan.minutes * minute) - studyDay(now));
  if (!days) return `${Math.round(plan.minutes)}m`;
  if (days < 30) return `${days}d`;
  if (days < 365) return `${scoreNumber.format(days / 30)}mo`;
  return `${scoreNumber.format(days / 365)}y`;
}

function mixNewAndReview(fresh, reviews) {
  const mixed = [];
  let nextNew = 0;
  let nextReview = 0;
  while (nextNew < fresh.length || nextReview < reviews.length) {
    const newFraction = (nextNew + 1) / (fresh.length + 1);
    const reviewFraction = (nextReview + 1) / (reviews.length + 1);
    if (nextNew < fresh.length && (nextReview === reviews.length || newFraction < reviewFraction)) {
      mixed.push(fresh[nextNew++]);
    } else {
      mixed.push(reviews[nextReview++]);
    }
  }
  return mixed;
}

function dailyQueue(course, now = Date.now()) {
  const day = studyDay(now);
  const limits = readLimits(course);
  const fresh = [];
  const learning = [];
  const interday = [];
  const reviews = [];
  let newStudied = 0;
  let reviewsStudied = 0;
  for (const card of course.cards) {
    const record = course.records.get(card.id) ?? emptyRecord;
    const state = record.schedule;
    if (record.newOn === day) newStudied++;
    if (record.reviewOn === day) reviewsStudied++;
    if (!state) fresh.push({ card, kind: "new" });
    else if (state.stage === "review" && state.dueDay <= day) reviews.push({ card, kind: "review" });
    else if (state.stage !== "review" && state.dueAt <= now + learnAhead) {
      learning.push({ card, kind: "learning", waitUntil: state.dueAt });
    } else if (state.stage !== "review" && state.dueDay <= day) interday.push({ card, kind: "learning" });
  }
  const byDue = (first, second) => course.records.get(first.card.id).schedule.dueDay
    - course.records.get(second.card.id).schedule.dueDay;
  const availableReviews = Math.max(0, limits.review - reviewsStudied);
  const mainReviews = [...interday.sort(byDue), ...reviews.sort(byDue)].slice(0, availableReviews);
  const newSlots = Math.max(0, Math.min(limits.new - newStudied, availableReviews - mainReviews.length - newStudied));
  return [...learning, ...mixNewAndReview(fresh.slice(0, newSlots), mainReviews)];
}

function queueCounts(entries) {
  const counts = { new: 0, learning: 0, review: 0 };
  for (const entry of entries) counts[entry.kind]++;
  return counts;
}

function startCustomStudy(course, cards, scope, skipRight = false) {
  readRecords(course);
  if (skipRight) {
    cards = cards.filter((card) => course.records.get(card.id)?.mark !== "right");
  }
  if (!cards.length) {
    const notice = document.getElementById("course-notice");
    if (notice) {
      notice.textContent = skipRight
        ? "All cards in this selection are marked right. Turn off Skip cards already right to include them."
        : "No cards are available in this revision set.";
    }
    return;
  }
  const ordered = cards.slice();
  if (course.shuffle) shuffleCards(ordered);
  beginSession(course, ordered.map((card) => ({
    card,
    kind: queueKind(course.records.get(card.id)?.schedule),
  })), scope);
}

function startDailyStudy(course) {
  readRecords(course);
  const queue = dailyQueue(course);
  if (queue.length) beginSession(course, queue, "Daily study");
  else if (courseView) updateDailyPanel(courseView);
}

function nextStudyEntry(run, now) {
  let primary;
  let due;
  let ahead;
  let alternate;
  const previous = run.answers.at(-1)?.entry.card.id;
  for (const entry of run.pending.values()) {
    if (entry.waitUntil === undefined) primary ??= entry;
    else if (entry.waitUntil <= now && (!due || entry.waitUntil < due.waitUntil)) due = entry;
    else if (entry.waitUntil <= now + learnAhead) {
      if (!ahead || entry.waitUntil < ahead.waitUntil) ahead = entry;
      if (entry.card.id !== previous && (!alternate || entry.waitUntil < alternate.waitUntil)) alternate = entry;
    }
  }
  return due ?? primary ?? alternate ?? ahead;
}

function beginSession(course, queue, scope) {
  session = {
    course,
    scope,
    source: queue.map((entry) => entry.card),
    pending: new Map(queue.map((entry) => [entry.card.id, entry])),
    counts: { right: 0, wrong: 0, later: 0, covered: 0, answers: 0 },
    answers: [],
    seen: new Set(),
    visited: new Map(),
    current: null,
    revealed: false,
    result: null,
  };
  session.current = nextStudyEntry(session, Date.now());
  if (location.hash === studyHref(course)) renderRoute();
  else location.hash = studyHref(course);
}

function statMarkup(counts, total) {
  return `<dl class="stats">
    <div><dt>Reviewed</dt><dd data-count="reviewed">${number.format(covered(counts))}/${number.format(total)}</dd></div>
    <div><dt>Right</dt><dd data-count="right">${number.format(counts.right)}</dd></div>
    <div><dt>Again</dt><dd data-count="wrong">${number.format(counts.wrong)}</dd></div>
    <div><dt>Flagged</dt><dd data-count="later">${number.format(counts.later)}</dd></div>
  </dl>`;
}

function renderStudyStart(course) {
  readRecords(course);
  const queue = dailyQueue(course);
  const summary = course.loadError ? "Could not load this course’s CSV." : courseCounts(course);
  app.innerHTML = `<div class="narrow">
    ${breadcrumb(course, "Revision")}
    <div class="page-heading"><h1>Revise ${escapeHTML(course.name)}</h1><p>${summary}</p></div>
    ${course.cards.length ? queueMarkup(queueCounts(queue)) : ""}
    <div class="actions">
      <button class="button primary" type="button" data-action="study-start" data-course="${course.slug}"${queue.length ? "" : " disabled"}>Study today</button>
      <a class="button" href="${courseHref(course)}">Back to course</a>
    </div>
  </div>`;
}

function renderStudy() {
  app.innerHTML = `<div class="narrow">
    ${breadcrumb(session.course, "Revision")}
    <header class="study-header">
      <h1>Revision</h1>
      <button class="button ghost" type="button" data-action="finish">Finish and exit <kbd aria-hidden="true">Esc</kbd></button>
    </header>
    <div class="study-progress panel">
      <div class="study-queue" aria-label="Remaining cards">${queueMarkup(queueCounts(session.pending.values()))}</div>
      <div class="study-counts" role="status">${statMarkup(session.counts, session.source.length)}</div>
      ${progress(0, "Cards reviewed")}
    </div>
    <article class="study-card panel" aria-labelledby="study-question">
      <div class="study-card-top">
        <p class="study-chapter" id="study-chapter"></p>
        <span class="stage-pill" id="study-stage"></span>
      </div>
      <h2 class="study-question card-copy" id="study-question" tabindex="-1"></h2>
      <div class="study-answer" id="study-answer" hidden>
        <h3 id="answer-heading" tabindex="-1">Answer</h3>
        <p class="card-copy" id="answer-copy"></p>
      </div>
      <div class="study-actions">
        <button class="button primary" id="reveal-button" type="button" data-action="reveal" aria-controls="study-answer" aria-keyshortcuts="Space Enter">Show answer <kbd aria-hidden="true">Space</kbd></button>
        <div class="grade-grid" id="mark-actions" hidden>
          ${grades.map((grade, i) => `<button class="button grade-button" type="button" data-action="grade" data-grade="${grade}" title="${gradeHints[grade]}" aria-label="${gradeLabels[grade]}" aria-keyshortcuts="${i + 1}" aria-describedby="interval-${grade}">
            <span class="grade-interval number" id="interval-${grade}"></span>
            <span class="grade-name">${gradeLabels[grade]} <kbd aria-hidden="true">${i + 1}</kbd></span>
          </button>`).join("")}
        </div>
      </div>
    </article>
    <div class="study-tools">
      <p class="study-caption">${escapeHTML(session.scope)}</p>
      <div class="actions">
        <button class="button ghost" type="button" data-action="flag" id="study-flag" aria-pressed="false">Review later</button>
        <button class="button ghost" type="button" data-action="undo" id="study-undo" aria-keyshortcuts="Control+Z Meta+Z">Undo last answer</button>
      </div>
    </div>
    <p class="notice" id="study-notice" role="status"></p>
  </div>`;
  studyView = {
    chapter: document.getElementById("study-chapter"),
    stage: document.getElementById("study-stage"),
    question: document.getElementById("study-question"),
    answer: document.getElementById("study-answer"),
    answerHeading: document.getElementById("answer-heading"),
    answerCopy: document.getElementById("answer-copy"),
    reveal: document.getElementById("reveal-button"),
    actions: document.getElementById("mark-actions"),
    intervals: Object.fromEntries(grades.map((grade) => [grade, document.getElementById(`interval-${grade}`)])),
    queue: app.querySelector(".study-queue"),
    counts: Object.fromEntries(Array.from(app.querySelectorAll("[data-count]"), (node) => [node.dataset.count, node])),
    progress: app.querySelector(".progress"),
    fill: app.querySelector(".progress-fill"),
    flag: document.getElementById("study-flag"),
    undo: document.getElementById("study-undo"),
    notice: document.getElementById("study-notice"),
  };
  displayStudyCard();
}

function flaggedInSession(run) {
  return Array.from(run.visited.values()).filter((card) => run.course.records.get(card.id)?.later);
}

function updateStudyProgress() {
  const { source, pending, counts, answers } = session;
  counts.later = flaggedInSession(session).length;
  studyView.counts.reviewed.textContent = `${number.format(counts.covered)}/${number.format(source.length)}`;
  for (const mark of ["right", "wrong", "later"]) {
    studyView.counts[mark].textContent = number.format(counts[mark]);
  }
  updateQueue(studyView.queue, queueCounts(pending.values()));
  const completed = percent(counts.covered, source.length);
  studyView.progress.setAttribute("aria-valuenow", String(completed));
  studyView.fill.style.width = `${completed}%`;
  studyView.undo.disabled = answers.length === 0;
}

function displayStudyCard() {
  const { course, current, visited } = session;
  const { card } = current;
  const record = course.records.get(card.id) ?? emptyRecord;
  const stage = record.schedule?.stage ?? "new";
  session.revealed = false;
  visited.set(card.id, card);
  studyView.chapter.textContent = card.chapter;
  studyView.stage.textContent = stageLabels[stage];
  studyView.stage.dataset.stage = stage;
  studyView.question.textContent = card.question;
  studyView.answerCopy.textContent = card.answer;
  studyView.answer.hidden = true;
  studyView.reveal.hidden = false;
  studyView.actions.hidden = true;
  studyView.flag.setAttribute("aria-pressed", String(record.later));
  studyView.notice.textContent = "";
  updateStudyProgress();
  window.scrollTo(0, 0);
  if (!introActive) studyView.question.focus({ preventScroll: true });
}

function showIntervals(schedule, now, roll = Math.random()) {
  session.revealDay = studyDay(now);
  session.revealSchedule = JSON.stringify(schedule);
  session.roll = roll;
  session.plans = answerPlans(schedule, session.revealDay, roll);
  for (const grade of grades) studyView.intervals[grade].textContent = intervalLabel(session.plans[grade], now);
}

function revealAnswer() {
  if (!studyView || session.revealed) return;
  const { course, current } = session;
  const record = decodeRecord(readSaved(markPrefix(course) + current.card.id));
  showIntervals(record.schedule, Date.now());
  session.revealed = true;
  studyView.answer.hidden = false;
  studyView.reveal.hidden = true;
  studyView.actions.hidden = false;
  studyView.answerHeading.focus();
}

function gradeCard(grade) {
  if (!studyView || !session.revealed || session.result || !grades.includes(grade)) return;
  const { course, current, counts, pending, seen, answers } = session;
  const { card } = current;
  const key = markPrefix(course) + card.id;
  const priorRaw = readSaved(key);
  const record = decodeRecord(priorRaw);
  const now = Date.now();
  const day = studyDay(now);
  if (session.revealDay !== day || session.revealSchedule !== JSON.stringify(record.schedule)) {
    showIntervals(record.schedule, now, session.roll);
    studyView.notice.textContent = "The schedule changed. Choose a grade with the updated intervals.";
    return;
  }
  const mark = grade === "again" ? "wrong" : "right";
  const state = scheduleFromPlan(session.plans[grade], now, session.roll);
  const wasNew = !record.schedule;
  const wasDailyReview = record.schedule?.stage === "review" || record.schedule?.dueDay !== undefined;
  const saved = saveRecord(course, card, {
    ...record, mark, schedule: state,
    newOn: wasNew ? day : record.newOn,
    reviewOn: wasDailyReview ? day : record.reviewOn,
  });
  const first = !seen.has(card.id);
  answers.push({ entry: current, priorRaw, saved, mark, first });
  seen.add(card.id);
  counts[mark]++;
  counts.answers++;
  counts.covered = seen.size;
  pending.delete(card.id);
  if (state.stage !== "review" && state.dueAt !== undefined) {
    pending.set(card.id, { card, kind: "learning", waitUntil: state.dueAt });
  }
  session.current = nextStudyEntry(session, now);
  if (session.current) displayStudyCard();
  else finishSession(true);
}

function toggleStudyFlag() {
  const { course, current } = session;
  const { card } = current;
  const record = decodeRecord(readSaved(markPrefix(course) + card.id));
  const later = !record.later;
  saveRecord(course, card, { ...record, later });
  studyView.flag.setAttribute("aria-pressed", String(later));
  updateStudyProgress();
}

function undoAnswer() {
  const { course, answers, counts, pending, seen } = session;
  const latest = answers.at(-1);
  if (!latest) return;
  const { entry, priorRaw, saved, mark, first } = latest;
  const key = markPrefix(course) + entry.card.id;
  const stored = decodeRecord(readSaved(key));
  const expected = decodeRecord(saved);
  if (JSON.stringify(stored.schedule) !== JSON.stringify(expected.schedule) || stored.mark !== expected.mark) {
    studyView.notice.textContent = "This card’s progress changed after the last answer.";
    return;
  }
  const prior = decodeRecord(priorRaw);
  if (stored.later === prior.later) {
    writeSaved(key, priorRaw);
    if (prior === emptyRecord) course.records.delete(entry.card.id);
    else course.records.set(entry.card.id, prior);
  } else saveRecord(course, entry.card, { ...prior, later: stored.later });
  answers.pop();
  if (first) seen.delete(entry.card.id);
  counts[mark]--;
  counts.answers--;
  counts.covered = seen.size;
  pending.set(entry.card.id, entry);
  session.current = entry;
  displayStudyCard();
}

function finishSession(showScore) {
  if (!session || session.result) return;
  const endedAt = Date.now();
  const { course, scope, counts, source, answers } = session;
  const missed = new Map();
  for (const { entry, mark } of answers) {
    if (mark === "wrong") missed.set(entry.card.id, entry.card);
  }
  session.flagged = { wrong: Array.from(missed.values()), later: flaggedInSession(session) };
  session.result = { endedAt, scope, ...counts, later: session.flagged.later.length, total: source.length };
  const id = [endedAt, ...crypto.getRandomValues(new Uint32Array(2))].join("-");
  writeSaved(historyPrefix(course) + id, JSON.stringify(session.result));
  if (showScore) renderRoute();
}

function resultGroup(mark, cards) {
  return `<section class="panel result-group" aria-labelledby="result-${mark}-title">
    <h2 id="result-${mark}-title">${mark === "wrong" ? "Cards rated Again" : "Review-later cards"} · ${number.format(cards.length)}</h2>
    ${cards.length ? cardListMarkup(`result-${mark}-cards`, "more-score", mark) : '<p class="empty-result">No cards.</p>'}
  </section>`;
}

function renderScore() {
  const { course, result, flagged } = session;
  const done = reviewed(result);
  const score = percent(result.right, done);
  app.innerHTML = `<div class="narrow">
    ${breadcrumb(course, "Score")}
    <section class="panel score-panel" aria-labelledby="score-heading">
      <h1 id="score-heading">Session score</h1>
      <p class="score-value number">${showPercent(score)}</p>
      <p class="score-scope">${escapeHTML(result.scope)} · ${number.format(covered(result))} of ${quantity(result.total, "card")} reviewed · ${quantity(done, "answer")}</p>
      ${progress(score, "Session score")}
      ${statMarkup(result, result.total)}
      <div class="actions">
        <button class="button primary" type="button" data-action="retry-wrong"${flagged.wrong.length ? "" : " disabled"}>Retry wrong</button>
        <button class="button" type="button" data-action="retry-later"${flagged.later.length ? "" : " disabled"}>Review later now</button>
        <button class="button" type="button" data-action="revise-again">Revise again</button>
        <a class="button ghost" href="${courseHref(course)}">Back to course</a>
      </div>
    </section>
    <div class="score-lists">${resultGroup("wrong", flagged.wrong)}${resultGroup("later", flagged.later)}</div>
  </div>`;
  scoreLists = new Map();
  for (const mark of ["wrong", "later"]) {
    const container = document.getElementById(`result-${mark}-cards`);
    if (container) {
      const list = connectCardList(container, course, mark);
      scoreLists.set(mark, list);
      setCardList(list, flagged[mark]);
    }
  }
}

function renderRoute() {
  if (!ready) return;
  clearTimeout(courseView?.searchTimer);
  clearInterval(courseView?.dailyTimer);
  courseView = null;
  studyView = null;
  scoreLists = null;

  if (!location.hash) history.replaceState(null, "", "#/");
  const hash = location.hash;
  if (session && hash !== studyHref(session.course)) {
    finishSession(false);
    session = null;
  }
  const home = hash === "#/";
  if (home) courseLink.setAttribute("aria-current", "page");
  else courseLink.removeAttribute("aria-current");

  const route = /^#\/(course|study)\/([a-z-]+)$/.exec(hash);
  const course = courses.get(route?.[2]);
  let title = "Courses";
  if (home) {
    renderDashboard();
  } else if (!course) {
    title = "Page not found";
    app.innerHTML = '<div class="page-heading"><h1>Page not found</h1></div><a class="button" href="#/">Back to courses</a>';
  } else if (route[1] === "course") {
    title = course.name;
    renderCourse(course);
  } else {
    title = session?.result ? "Session score" : `Revise ${course.name}`;
    if (!session) renderStudyStart(course);
    else if (session.result) renderScore();
    else renderStudy();
  }
  document.title = `${title} | Lock In`;
  if (!studyView) {
    window.scrollTo(0, 0);
    if (!introActive) app.focus({ preventScroll: true });
  }
}

function handleCourseAction(action, button) {
  const view = courseView;
  const { course } = view;
  const index = Number(button.dataset.index);
  const row = view.rows[index];

  switch (action) {
    case "study-today":
      startDailyStudy(course);
      break;
    case "revise-all":
      startCustomStudy(course, course.cards, "Entire course", course.skipRight);
      break;
    case "revise-selected": {
      const cards = course.sections.flatMap((section, i) => course.selected.has(i) ? section.cards : []);
      startCustomStudy(course, cards, `Selected · ${quantity(course.selected.size, "section")}`, course.skipRight);
      break;
    }
    case "revise-section":
      startCustomStudy(course, row.section.cards, row.section.name, course.skipRight);
      break;
    case "revise-later":
      readRecords(course);
      updateToolbar(view);
      updateTallies(view);
      startCustomStudy(course, course.cards.filter((card) => course.records.get(card.id)?.later), "Review later");
      break;
    case "select-all":
      course.selected = new Set(course.sections.map((_, i) => i));
      updateToolbar(view);
      break;
    case "clear-selection":
      course.selected.clear();
      updateToolbar(view);
      break;
    case "expand": {
      const state = view.query ? view.searchCollapsed : course.expanded;
      if (state.has(index)) state.delete(index);
      else state.add(index);
      updateSection(view, row, index);
      break;
    }
    case "more-section":
      appendCards(row.list, true);
      break;
    case "ask-reset":
      view.dialog.returnValue = "";
      view.dialog.showModal();
      break;
  }
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const { action, grade, index } = button.dataset;
  if (courseView) {
    handleCourseAction(action, button);
    return;
  }
  switch (action) {
    case "study-start": {
      const course = courses.get(button.dataset.course);
      startDailyStudy(course);
      break;
    }
    case "finish":
      finishSession(true);
      break;
    case "reveal":
      revealAnswer();
      break;
    case "grade":
      gradeCard(grade);
      break;
    case "flag":
      toggleStudyFlag();
      break;
    case "undo":
      undoAnswer();
      break;
    case "retry-wrong":
      startCustomStudy(session.course, session.flagged.wrong, "Retry wrong");
      break;
    case "retry-later":
      startCustomStudy(session.course, session.flagged.later, "Review later");
      break;
    case "revise-again":
      startCustomStudy(session.course, session.source, `Repeat · ${session.scope.replace(/^Repeat · /, "")}`);
      break;
    case "more-score":
      appendCards(scoreLists.get(index), true);
      break;
  }
});

app.addEventListener("submit", (event) => {
  if (!courseView || event.target.id !== "daily-limits") return;
  event.preventDefault();
  const form = event.target;
  const limits = { new: form.elements.new.valueAsNumber, review: form.elements.review.valueAsNumber };
  if (!validLimit(limits.new) || !validLimit(limits.review)) return;
  writeSaved(limitsKey(courseView.course), JSON.stringify(limits));
  updateDailyPanel(courseView);
});

app.addEventListener("change", (event) => {
  if (!courseView) return;
  const input = event.target;
  const course = courseView.course;
  if (input.id === "shuffle") course.shuffle = input.checked;
  if (input.id === "skip-right") {
    course.skipRight = input.checked;
    courseView.notice.textContent = "";
  }
  if (input.hasAttribute("data-section-check")) {
    const index = Number(input.dataset.sectionCheck);
    if (input.checked) course.selected.add(index);
    else course.selected.delete(index);
    updateToolbar(courseView);
  }
});

app.addEventListener("input", (event) => {
  if (!courseView || event.target.id !== "search") return;
  const view = courseView;
  const query = event.target.value.trim().toLowerCase();
  clearTimeout(view.searchTimer);
  view.searchTimer = setTimeout(() => applySearch(view, query), 100);
});

function endIntro() {
  if (!introActive) return;
  introActive = false;
  clearTimeout(introTimer);
  intro.hidden = true;
  document.body.classList.remove("intro-active");
  document.querySelector(".site-header").inert = false;
  document.getElementById("skip-link").inert = false;
  app.inert = false;
  if (ready) app.focus({ preventScroll: true });
}

function startIntro() {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches) {
    intro.hidden = true;
    return;
  }
  introActive = true;
  document.body.classList.add("intro-active");
  document.querySelector(".site-header").inert = true;
  document.getElementById("skip-link").inert = true;
  app.inert = true;
  intro.addEventListener("click", endIntro, { once: true });
  intro.addEventListener("animationend", (event) => {
    if (event.target === intro) endIntro();
  });
  reduced.addEventListener("change", (event) => { if (event.matches) endIntro(); });
  introTimer = setTimeout(endIntro, 4100);
}

window.addEventListener("keydown", (event) => {
  if (introActive) {
    event.preventDefault();
    event.stopPropagation();
    endIntro();
    return;
  }
  if (!studyView || event.repeat || event.isComposing) return;
  if (event.key.toLowerCase() === "z" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    undoAnswer();
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key === "Escape") {
    event.preventDefault();
    finishSession(true);
  } else if ((event.code === "Space" || event.key === "Enter") &&
             (!event.target.closest?.("button") || event.target.id === "reveal-button")) {
    event.preventDefault();
    if (session.revealed) gradeCard("good");
    else revealAnswer();
  } else if (session.revealed && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    gradeCard(grades[Number(event.key) - 1]);
  }
}, true);

document.getElementById("skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  app.focus();
});
window.addEventListener("hashchange", renderRoute);
window.addEventListener("pagehide", () => finishSession(false));
window.addEventListener("pageshow", (event) => { if (event.persisted) renderRoute(); });
window.addEventListener("focus", () => {
  if (!courseView) return;
  readRecords(courseView.course);
  updateDailyPanel(courseView);
});

startIntro();
Promise.all(courseList.map(loadCourse)).then(() => {
  ready = true;
  renderRoute();
});
