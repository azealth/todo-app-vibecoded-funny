import { ext, openSettingsPage } from "./lib/compat.js";
import {
  hasPin, isUnlocked, setUnlocked, getSetting, setSetting,
  getTasks, addTask, toggleTask, deleteTask, editTaskText, updateTaskInfo,
  ensureYearlyTasksGenerated,
} from "./lib/storage.js";
import { hashPin, verifyPin, isValidPin } from "./lib/pin.js";
import { isSyncConfigured, syncNow } from "./lib/api.js";
import { openStream } from "./lib/firebase.js";
import {
  todayStr, addDays, formatFriendly, formatShort, compareDateStr,
} from "./lib/dayUtils.js";

const $ = (sel) => document.querySelector(sel);

const pinScreen = $("#pin-screen");
const mainView = $("#main-view");
const unfinishedView = $("#unfinished-view");
const dayySections = $("#day-sections");
const unfinishedBtn = $("#unfinished-btn");
const unfinishedScroll = $("#unfinished-scroll");
const syncBtn = $("#sync-btn");

// Visible build marker so it's obvious whether a reloaded extension picked
// up new code — also reruns on every popup open, which itself is proof the
// script re-executed fresh rather than showing a stale cached popup.
try {
  const manifest = ext.runtime.getManifest();
  const tag = $("#build-tag");
  if (tag) tag.textContent = `DayDo v${manifest.version} · opened ${new Date().toLocaleTimeString()}`;
} catch (e) {
  console.warn("DayDo: could not read manifest version", e);
}

// ------------------------------------------------------------------
// Theme
// ------------------------------------------------------------------
async function applyTheme() {
  const settings = await getSetting("settings");
  document.documentElement.setAttribute("data-theme", settings?.theme === "dark" ? "dark" : "light");
}

// ------------------------------------------------------------------
// PIN gate
// ------------------------------------------------------------------
let pinBuffer = "";
let pinMode = "unlock"; // "unlock" | "create" | "confirm"
let pendingFirstPin = "";

async function startPinFlow() {
  pinScreen.hidden = false;
  mainView.hidden = true;
  let already = false;
  try {
    already = await hasPin();
  } catch (e) {
    console.error("DayDo: could not check for an existing PIN", e);
  }
  pinMode = already ? "unlock" : "create";
  pinBuffer = "";
  updatePinScreenCopy();
  renderPinDots();
}

function updatePinScreenCopy() {
  const title = $("#pin-title");
  const subtitle = $("#pin-subtitle");
  if (pinMode === "unlock") {
    title.textContent = "Enter your PIN";
    subtitle.textContent = "Unlock DayDo to see today's list.";
  } else if (pinMode === "create") {
    title.textContent = "Create a PIN";
    subtitle.textContent = "Choose a 4-digit PIN to protect your list.";
  } else if (pinMode === "confirm") {
    title.textContent = "Confirm your PIN";
    subtitle.textContent = "Enter the same 4 digits again.";
  }
  $("#pin-error").hidden = true;
}

function renderPinDots(errored = false) {
  const dots = document.querySelectorAll(".pin-dot");
  dots.forEach((dot, i) => {
    dot.classList.toggle("filled", i < pinBuffer.length && !errored);
    dot.classList.toggle("err", errored);
  });
}

async function handlePinKey(key) {
  if (key === "back") {
    pinBuffer = pinBuffer.slice(0, -1);
    renderPinDots();
    return;
  }
  if (pinBuffer.length >= 4) return;
  pinBuffer += key;
  renderPinDots();
  if (pinBuffer.length === 4) await submitPin();
}

async function submitPin() {
  const pin = pinBuffer;
  try {
    if (pinMode === "unlock") {
      const { pinHash, pinSalt } = await ext.storage.local.get(["pinHash", "pinSalt"]);
      const ok = await verifyPin(pin, pinSalt, pinHash);
      if (ok) {
        await setUnlocked(true);
        pinBuffer = "";
        await enterApp();
      } else {
        showPinError();
      }
    } else if (pinMode === "create") {
      pendingFirstPin = pin;
      pinMode = "confirm";
      pinBuffer = "";
      updatePinScreenCopy();
      renderPinDots();
    } else if (pinMode === "confirm") {
      if (pin === pendingFirstPin) {
        const { hash, salt } = await hashPin(pin);
        await ext.storage.local.set({ pinHash: hash, pinSalt: salt });
        await setUnlocked(true);
        pinBuffer = "";
        await enterApp();
      } else {
        showPinError("PINs didn't match. Let's start over.");
        pinMode = "create";
        setTimeout(updatePinScreenCopy, 900);
      }
    }
  } catch (err) {
    console.error("DayDo: PIN step failed", err);
    showPinError("Something went wrong. Please try again.");
  }
}

function showPinError(message = "That PIN didn't match. Try again.") {
  const el = $("#pin-error");
  el.textContent = message;
  el.hidden = false;
  renderPinDots(true);
  setTimeout(() => {
    pinBuffer = "";
    renderPinDots();
  }, 700);
}

$("#pin-pad").addEventListener("click", (e) => {
  const btn = e.target.closest(".pin-key");
  if (btn) handlePinKey(btn.dataset.key);
});

// Let people type the PIN on their keyboard, not just click the on-screen pad.
document.addEventListener("keydown", (e) => {
  if (pinScreen.hidden) return;
  if (e.key >= "0" && e.key <= "9") {
    handlePinKey(e.key);
  } else if (e.key === "Backspace" || e.key === "Delete") {
    handlePinKey("back");
  }
});

$("#lock-btn").addEventListener("click", async () => {
  stopLiveUpdates();
  await setUnlocked(false);
  await startPinFlow();
});

// ------------------------------------------------------------------
// Entering the app (unlocked)
// ------------------------------------------------------------------
// Each step below is individually guarded so that the screen transition on
// the first two lines ALWAYS happens the moment this is called — nothing
// that runs afterward (yearly-reminder generation, rendering, sync-icon
// refresh) is allowed to block or undo it, even if one of those fails.
async function enterApp() {
  pinScreen.hidden = true;
  mainView.hidden = false;
  try {
    await ensureYearlyTasksGenerated();
  } catch (e) {
    console.error("DayDo: yearly reminder check failed", e);
  }
  try {
    await renderMain();
  } catch (e) {
    console.error("DayDo: rendering the task list failed", e);
  }
  try {
    refreshSyncIcon();
  } catch (e) {
    console.error("DayDo: sync icon refresh failed", e);
  }
  // Auto-sync every time the popup is opened (and unlocked), not just after
  // a local change. Local tasks are already rendered above, so this runs in
  // the background rather than delaying the popup showing something.
  try {
    if (await isSyncConfigured()) {
      doSync().catch((e) => console.error("DayDo: auto-sync on open failed", e));
      startLiveUpdates();
    }
  } catch (e) {
    console.error("DayDo: could not check sync configuration", e);
  }
}

// ------------------------------------------------------------------
// Live updates: while the popup is open, listen to the Realtime Database
// so a change from another device or from Discord shows up immediately,
// without waiting for the next open or local edit.
// ------------------------------------------------------------------
let liveStream = null;

async function startLiveUpdates() {
  if (liveStream) return;
  const uid = await getSetting("authUid");
  if (!uid) return;
  liveStream = openStream(`users/${uid}`, () => scheduleSync());
}

function stopLiveUpdates() {
  if (liveStream) liveStream.close();
  liveStream = null;
}

window.addEventListener("pagehide", stopLiveUpdates);

// ------------------------------------------------------------------
// Day-section computation
// ------------------------------------------------------------------
function restOfWeekDates(today) {
  const d = new Date(`${today}T00:00:00`);
  const daysLeft = 6 - d.getDay();
  const dates = [];
  for (let i = 1; i <= daysLeft; i++) dates.push(addDays(today, i));
  return dates;
}

async function computeView() {
  const tasks = await getTasks();
  const today = todayStr();
  const yesterday = addDays(today, -1);
  const rest = restOfWeekDates(today);
  const endOfWeek = rest.length ? rest[rest.length - 1] : today;

  const byDate = (d) => tasks.filter((t) => t.date === d);

  const upcomingDates = [...new Set(
    tasks.filter((t) => compareDateStr(t.date, endOfWeek) > 0).map((t) => t.date)
  )].sort(compareDateStr);

  const oldUnfinished = tasks.filter(
    (t) => compareDateStr(t.date, yesterday) < 0 && !t.done
  );
  const oldUnfinishedByDate = {};
  for (const t of oldUnfinished) {
    (oldUnfinishedByDate[t.date] ||= []).push(t);
  }

  return {
    today, yesterday, rest, upcomingDates, oldUnfinished, oldUnfinishedByDate,
    sections: [
      { date: yesterday, tasks: byDate(yesterday), addable: true },
      { date: today, tasks: byDate(today), addable: true, isToday: true },
      ...rest.map((d) => ({ date: d, tasks: byDate(d), addable: true })),
      ...upcomingDates.map((d) => ({ date: d, tasks: byDate(d), addable: true })),
    ],
  };
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------
function taskRowHTML(t) {
  const hasInfo = Boolean((t.description && t.description.trim()) || (t.links && t.links.length));
  const firstLink = t.links && t.links.length ? t.links[0] : null;
  return `
    <li class="task-row ${t.done ? "done" : ""}" data-id="${t.id}">
      <button class="task-check" data-action="toggle" aria-label="Mark done">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="task-text" data-action="edit" title="Click to edit">${escapeHtml(t.text)}</button>
      <button class="task-info ${hasInfo ? "has-info" : ""}" data-action="info" aria-label="Task details" title="${hasInfo ? "View details" : "Add a description or links"}">
        <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v5.5M12 8v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
      ${firstLink ? `
      <button class="task-link" data-action="open-link" data-url="${escapeAttr(firstLink)}" aria-label="Open first link" title="Open ${escapeAttr(firstLink)}">
        <svg viewBox="0 0 24 24" fill="none"><path d="M9 15L20 4M20 4h-6M20 4v6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>` : ""}
      <button class="task-del" data-action="delete" aria-label="Delete task">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </li>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function daySectionHTML(section, today) {
  const empty = section.tasks.length === 0
    ? `<p class="empty-state">No tasks yet.</p>`
    : `<ul class="task-list">${section.tasks.map(taskRowHTML).join("")}</ul>`;
  return `
    <div class="day-section ${section.isToday ? "is-today" : ""}" data-date="${section.date}">
      <div class="day-header">
        <span class="day-name">${formatFriendly(section.date, today)}</span>
        <span class="day-date">${formatShort(section.date)}</span>
        <button class="day-add-btn" data-action="quick-add" aria-label="Add task">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="day-body">${empty}</div>
    </div>`;
}

async function renderMain() {
  const view = await computeView();
  dayySections.innerHTML = view.sections.map((s) => daySectionHTML(s, view.today)).join("");

  if (view.oldUnfinished.length > 0) {
    unfinishedBtn.hidden = false;
    unfinishedBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/></svg>
      UNFINISHED TASKS (${view.oldUnfinished.length})`;
  } else {
    unfinishedBtn.hidden = true;
  }
}

async function renderUnfinished() {
  const view = await computeView();
  const dates = Object.keys(view.oldUnfinishedByDate).sort(compareDateStr);
  if (dates.length === 0) {
    unfinishedScroll.innerHTML = `<p class="empty-state" style="padding:18px">Nothing outstanding — you're all caught up.</p>`;
    return;
  }
  unfinishedScroll.innerHTML = dates.map((d) => daySectionHTML({
    date: d, tasks: view.oldUnfinishedByDate[d],
  }, view.today)).join("");
}

// ------------------------------------------------------------------
// Event delegation: task rows (checkbox / edit / delete) + day add button
// ------------------------------------------------------------------
function wireListEvents(container, onChanged) {
  container.addEventListener("click", async (e) => {
    const addBtn = e.target.closest("[data-action='quick-add']");
    if (addBtn) {
      openQuickAdd(addBtn.closest(".day-section"));
      return;
    }
    const row = e.target.closest(".task-row");
    if (!row) return;
    const id = row.dataset.id;
    const action = e.target.closest("button")?.dataset.action;
    if (action === "toggle") {
      await toggleTask(id);
      await onChanged();
      scheduleSync();
    } else if (action === "delete") {
      await deleteTask(id);
      await onChanged();
      scheduleSync();
    } else if (action === "edit") {
      const btn = e.target.closest(".task-text");
      startInlineEdit(btn, id, onChanged);
    } else if (action === "info") {
      await openInfoModal(id, onChanged);
    } else if (action === "open-link") {
      const url = e.target.closest("button").dataset.url;
      if (url) ext.tabs.create({ url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
    }
  });
}

function startInlineEdit(btn, id, onChanged) {
  const current = btn.textContent;
  const input = document.createElement("input");
  input.className = "text-input";
  input.style.fontSize = "13.5px";
  input.value = current;
  btn.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const val = input.value.trim();
    if (val) {
      await editTaskText(id, val);
      scheduleSync();
    }
    await onChanged();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") onChanged();
  });
  input.addEventListener("blur", commit);
}

function openQuickAdd(sectionEl) {
  if (sectionEl.querySelector(".quick-add-row")) return;
  const date = sectionEl.dataset.date;
  const row = document.createElement("div");
  row.className = "quick-add-row";
  row.innerHTML = `<input type="text" class="text-input" maxlength="200" placeholder="New task…" />`;
  sectionEl.querySelector(".day-body").appendChild(row);
  const input = row.querySelector("input");
  input.focus();
  const commit = async () => {
    const val = input.value.trim();
    if (val) {
      await addTask(val, date);
      scheduleSync();
    }
    await renderMain();
    await renderUnfinished();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { row.remove(); }
  });
  input.addEventListener("blur", commit);
}

wireListEvents(dayySections, async () => { await renderMain(); await renderUnfinished(); });
wireListEvents(unfinishedScroll, async () => { await renderUnfinished(); await renderMain(); });

// ------------------------------------------------------------------
// Unfinished tab open/close
// ------------------------------------------------------------------
unfinishedBtn.addEventListener("click", async () => {
  await renderUnfinished();
  unfinishedView.hidden = false;
});
$("#unfinished-back").addEventListener("click", () => {
  unfinishedView.hidden = true;
});

// ------------------------------------------------------------------
// FAB / add-task-on-any-date modal
// ------------------------------------------------------------------
const modalBackdrop = $("#add-modal-backdrop");
const modalText = $("#add-modal-text");
const modalDate = $("#add-modal-date");

$("#fab").addEventListener("click", () => {
  modalText.value = "";
  modalDate.value = todayStr();
  modalBackdrop.hidden = false;
  modalText.focus();
});
$("#add-modal-cancel").addEventListener("click", () => { modalBackdrop.hidden = true; });
modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) modalBackdrop.hidden = true; });
$("#add-modal-save").addEventListener("click", async () => {
  const text = modalText.value.trim();
  const date = modalDate.value || todayStr();
  if (!text) return;
  await addTask(text, date);
  modalBackdrop.hidden = true;
  await renderMain();
  await renderUnfinished();
  scheduleSync();
});

// ------------------------------------------------------------------
// Task info modal (description + links)
// ------------------------------------------------------------------
const infoModalBackdrop = $("#info-modal-backdrop");
const infoModalDesc = $("#info-modal-desc");
const infoModalLinksEl = $("#info-modal-links");
let infoModalTaskId = null;
let infoModalOnChanged = null;

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function linkRowHTML(url = "") {
  return `
    <div class="link-row">
      <input type="url" class="text-input link-input" placeholder="https://…" value="${escapeAttr(url)}" />
      <button type="button" class="icon-btn link-open" aria-label="Open link">
        <svg viewBox="0 0 24 24" fill="none"><path d="M9 15L20 4M20 4h-6M20 4v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="icon-btn link-remove" aria-label="Remove link">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>`;
}

function renderLinkRows(links) {
  infoModalLinksEl.innerHTML = (links && links.length ? links : [""]).map(linkRowHTML).join("");
}

infoModalLinksEl.addEventListener("click", (e) => {
  const openBtn = e.target.closest(".link-open");
  if (openBtn) {
    const url = openBtn.closest(".link-row").querySelector(".link-input").value.trim();
    if (url) ext.tabs.create({ url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
    return;
  }
  const removeBtn = e.target.closest(".link-remove");
  if (removeBtn) {
    const row = removeBtn.closest(".link-row");
    if (infoModalLinksEl.children.length > 1) row.remove();
    else row.querySelector(".link-input").value = "";
  }
});

$("#info-modal-add-link").addEventListener("click", () => {
  infoModalLinksEl.insertAdjacentHTML("beforeend", linkRowHTML());
  infoModalLinksEl.lastElementChild.querySelector(".link-input").focus();
});

async function openInfoModal(id, onChanged) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  infoModalTaskId = id;
  infoModalOnChanged = onChanged;
  $("#info-modal-title").textContent = task.text;
  infoModalDesc.value = task.description || "";
  renderLinkRows(task.links || []);
  infoModalBackdrop.hidden = false;
  infoModalDesc.focus();
}

$("#info-modal-cancel").addEventListener("click", () => { infoModalBackdrop.hidden = true; });
infoModalBackdrop.addEventListener("click", (e) => {
  if (e.target === infoModalBackdrop) infoModalBackdrop.hidden = true;
});

$("#info-modal-save").addEventListener("click", async () => {
  const description = infoModalDesc.value;
  const links = [...infoModalLinksEl.querySelectorAll(".link-input")]
    .map((i) => i.value.trim())
    .filter(Boolean);
  await updateTaskInfo(infoModalTaskId, { description, links });
  infoModalBackdrop.hidden = true;
  scheduleSync();
  if (infoModalOnChanged) await infoModalOnChanged();
});

// ------------------------------------------------------------------
// Settings navigation
// ------------------------------------------------------------------
$("#settings-btn").addEventListener("click", async () => {
  await openSettingsPage();
  // Firefox closes the popup on its own when a tab opens; Safari doesn't.
  window.close();
});

// ------------------------------------------------------------------
// Sync status icon
// ------------------------------------------------------------------
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12.5l5 5L20 6.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SYNC_ICON = `<svg class="spin" viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M20 4v5h-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ERROR_ICON = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/></svg>`;

async function refreshSyncIcon() {
  const configured = await isSyncConfigured();
  if (!configured) {
    syncBtn.hidden = true;
    return;
  }
  syncBtn.hidden = false;
  const lastSync = await getSetting("lastSync");
  syncBtn.className = "icon-btn state-ok";
  syncBtn.innerHTML = CHECK_ICON;
  syncBtn.title = lastSync
    ? `Synced • last update ${new Date(lastSync).toLocaleString()}`
    : "Sync enabled • not yet synced";
}

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(doSync, 500);
}

let syncInFlight = false;
let syncAgainQueued = false;

async function doSync() {
  const configured = await isSyncConfigured();
  if (!configured) return;
  if (syncInFlight) {
    // Don't run two sync requests concurrently — just remember to sync
    // again right after this one finishes so nothing gets missed.
    syncAgainQueued = true;
    return;
  }
  syncInFlight = true;
  syncBtn.hidden = false;
  syncBtn.className = "icon-btn state-syncing";
  syncBtn.innerHTML = SYNC_ICON;
  syncBtn.title = "Syncing…";
  try {
    await syncNow();
    // A reminder added on another device may have just arrived — generate
    // its task occurrence immediately rather than waiting for the next
    // popup open.
    await ensureYearlyTasksGenerated();
    await refreshSyncIcon();
    await renderMain();
    await renderUnfinished();
  } catch (err) {
    syncBtn.className = "icon-btn state-error";
    syncBtn.innerHTML = ERROR_ICON;
    syncBtn.title = `Sync failed: ${err.message}. Click to retry.`;
  } finally {
    syncInFlight = false;
    if (syncAgainQueued) {
      syncAgainQueued = false;
      doSync();
    }
  }
}
syncBtn.addEventListener("click", doSync);

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
(async function boot() {
  try {
    await applyTheme();
    const unlocked = await isUnlocked();
    const pinExists = await hasPin();
    if (pinExists && unlocked) {
      await enterApp();
    } else {
      await startPinFlow();
    }
  } catch (err) {
    // Surface this instead of leaving a blank popup — if you see this,
    // please share the exact message so it can be tracked down.
    console.error("DayDo: startup failed", err);
    pinScreen.hidden = false;
    mainView.hidden = true;
    $("#pin-title").textContent = "Something went wrong loading DayDo";
    $("#pin-subtitle").textContent = String(err && err.message ? err.message : err);
  }
})();
