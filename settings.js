import { ext, closeCurrentTab, requestHostPermissions } from "./lib/compat.js";
import {
  isUnlocked, setUnlocked, getSetting, setSetting,
  getTasks, saveTasks, toggleTask, deleteTask,
  getYearlyReminders, addYearlyReminder, deleteYearlyReminder, reminderLabel,
} from "./lib/storage.js";
import { hashPin, verifyPin } from "./lib/pin.js";
import { isSyncConfigured, syncNow } from "./lib/api.js";
import {
  signIn, signUp, signOut, getSession, normalizeDbUrl, parseFirebaseConfigText, originsFor,
} from "./lib/firebase.js";
import { formatShort, compareDateStr } from "./lib/dayUtils.js";

const $ = (sel) => document.querySelector(sel);

// -------------------------- PIN gate --------------------------
let pinBuffer = "";

function renderDots(err = false) {
  document.querySelectorAll(".pin-dot").forEach((d, i) => {
    d.classList.toggle("filled", i < pinBuffer.length && !err);
    d.classList.toggle("err", err);
  });
}

async function gate() {
  if (await isUnlocked()) {
    $("#pin-screen").hidden = true;
    $("#settings-app").hidden = false;
    initSettings();
  } else {
    $("#pin-screen").hidden = false;
    $("#settings-app").hidden = true;
  }
}

$("#pin-pad").addEventListener("click", async (e) => {
  const btn = e.target.closest(".pin-key");
  if (!btn) return;
  await handleSettingsPinKey(btn.dataset.key);
});

document.addEventListener("keydown", async (e) => {
  if ($("#pin-screen").hidden) return;
  if (e.key >= "0" && e.key <= "9") {
    await handleSettingsPinKey(e.key);
  } else if (e.key === "Backspace" || e.key === "Delete") {
    await handleSettingsPinKey("back");
  }
});

async function handleSettingsPinKey(key) {
  if (key === "back") { pinBuffer = pinBuffer.slice(0, -1); renderDots(); return; }
  if (pinBuffer.length >= 4) return;
  pinBuffer += key;
  renderDots();
  if (pinBuffer.length === 4) {
    try {
      const { pinHash, pinSalt } = await ext.storage.local.get(["pinHash", "pinSalt"]);
      const ok = await verifyPin(pinBuffer, pinSalt, pinHash);
      if (ok) {
        await setUnlocked(true);
        pinBuffer = "";
        gate();
      } else {
        $("#pin-error").hidden = false;
        renderDots(true);
        setTimeout(() => { pinBuffer = ""; renderDots(); }, 700);
      }
    } catch (err) {
      console.error("DayDo: PIN check failed", err);
      $("#pin-error").textContent = "Something went wrong. Please try again.";
      $("#pin-error").hidden = false;
      renderDots(true);
      setTimeout(() => { pinBuffer = ""; renderDots(); }, 700);
    }
  }
}

$("#close-btn").addEventListener("click", () => closeCurrentTab());

// -------------------------- Tabs --------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

let initialized = false;
async function initSettings() {
  if (initialized) return;
  initialized = true;
  await loadGeneral();
  await loadYearly();
  await loadTrash();
}

// -------------------------- General tab --------------------------
async function loadGeneral() {
  const settings = await getSetting("settings");
  const toggle = $("#theme-toggle");
  toggle.checked = settings?.theme === "dark";
  document.documentElement.setAttribute("data-theme", toggle.checked ? "dark" : "light");
  toggle.addEventListener("change", async () => {
    const theme = toggle.checked ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    await setSetting("settings", { ...settings, theme });
  });

  await initSyncCard();

  $("#pin-save").addEventListener("click", async () => {
    const current = $("#pin-current").value.trim();
    const next = $("#pin-new").value.trim();
    const confirm = $("#pin-new-confirm").value.trim();
    if (!/^\d{4}$/.test(next) || next !== confirm) {
      showMsg("#pin-msg", "New PIN must be 4 digits and match the confirmation.", "error");
      return;
    }
    const { pinHash, pinSalt } = await ext.storage.local.get(["pinHash", "pinSalt"]);
    const ok = await verifyPin(current, pinSalt, pinHash);
    if (!ok) {
      showMsg("#pin-msg", "Current PIN is incorrect.", "error");
      return;
    }
    const { hash, salt } = await hashPin(next);
    await ext.storage.local.set({ pinHash: hash, pinSalt: salt });
    $("#pin-current").value = ""; $("#pin-new").value = ""; $("#pin-new-confirm").value = "";
    showMsg("#pin-msg", "PIN updated.", "ok");
  });
}

// -------------------------- Firebase sync card --------------------------
async function renderAccount() {
  const session = await getSession();
  $("#account-signed-out").hidden = Boolean(session);
  $("#account-signed-in").hidden = !session;
  // Changing project while signed in would point the session at the wrong
  // database — sign out first.
  $("#fb-db-url").disabled = Boolean(session);
  $("#fb-api-key").disabled = Boolean(session);
  if (session) {
    $("#fb-account-email").textContent = session.email || "(unknown)";
    $("#fb-account-uid").textContent = session.uid;
  }
}

async function initSyncCard() {
  $("#fb-db-url").value = await getSetting("firebaseDbUrl");
  $("#fb-api-key").value = await getSetting("firebaseApiKey");

  // Pasting the whole firebaseConfig snippet into either field fills both.
  for (const sel of ["#fb-db-url", "#fb-api-key"]) {
    $(sel).addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") || "";
      const cfg = parseFirebaseConfigText(text);
      if (cfg.databaseURL || cfg.apiKey) {
        e.preventDefault();
        if (cfg.databaseURL) $("#fb-db-url").value = cfg.databaseURL;
        if (cfg.apiKey) $("#fb-api-key").value = cfg.apiKey;
        if (!cfg.databaseURL) showMsg("#sync-msg", "That config has no databaseURL — create a Realtime Database first, then copy the config again.", "error");
      }
    });
  }

  const authenticate = (fn, verb) => async () => {
    // Read fields and request permissions synchronously, while we're still
    // inside the click (Firefox requires permissions.request to be called
    // directly from the user gesture).
    const rawUrl = $("#fb-db-url").value;
    const apiKey = $("#fb-api-key").value.trim();
    const email = $("#fb-email").value.trim();
    const password = $("#fb-password").value;
    let dbUrl;
    try {
      dbUrl = normalizeDbUrl(rawUrl);
    } catch (e) {
      showMsg("#sync-msg", e.message, "error");
      return;
    }
    const permissionRequest = requestHostPermissions(originsFor(dbUrl));
    if (!dbUrl || !apiKey) { showMsg("#sync-msg", "Enter the database URL and Web API key.", "error"); return; }
    if (!email || !password) { showMsg("#sync-msg", "Enter your email and password.", "error"); return; }

    await permissionRequest;
    showMsg("#sync-msg", `${verb}…`, "");
    try {
      await setSetting("firebaseDbUrl", dbUrl);
      await setSetting("firebaseApiKey", apiKey);
      $("#fb-db-url").value = dbUrl;
      await fn(email, password);
      $("#fb-password").value = "";
      await renderAccount();
      showMsg("#sync-msg", "Signed in. Syncing…", "");
      await syncNow();
      showMsg("#sync-msg", "Signed in and synced.", "ok");
      await loadYearly();
      await loadTrash();
    } catch (e) {
      await renderAccount();
      showMsg("#sync-msg", e.message, "error");
    }
  };

  $("#fb-sign-in").addEventListener("click", authenticate(signIn, "Signing in"));
  $("#fb-sign-up").addEventListener("click", authenticate(signUp, "Creating account"));

  $("#fb-sync-now").addEventListener("click", async () => {
    showMsg("#sync-msg", "Syncing…", "");
    try {
      await syncNow();
      showMsg("#sync-msg", `Synced at ${new Date().toLocaleTimeString()}.`, "ok");
      await loadYearly();
      await loadTrash();
    } catch (e) {
      await renderAccount();
      showMsg("#sync-msg", `Couldn't sync: ${e.message}`, "error");
    }
  });

  $("#fb-sign-out").addEventListener("click", async () => {
    await signOut();
    await renderAccount();
    showMsg("#sync-msg", "Signed out. DayDo is local-only on this device until you sign in again.", "ok");
  });

  await renderAccount();
}

function showMsg(sel, text, cls) {
  const el = $(sel);
  el.textContent = text;
  el.className = `msg ${cls}`;
}

// -------------------------- Yearly reminders tab --------------------------
async function loadYearly() {
  const list = $("#yearly-list");
  const reminders = await getYearlyReminders();
  if (reminders.length === 0) {
    list.innerHTML = `<p class="empty-state">No yearly reminders yet.</p>`;
  } else {
    list.innerHTML = reminders.map((r) => `
      <div class="list-row" data-id="${r.id}">
        <span class="row-main">${escapeHtml(r.text)}<div class="row-sub">Every ${reminderLabel(r)}</div></span>
        <div class="row-actions"><button class="btn btn-danger" data-action="del-yearly">Remove</button></div>
      </div>`).join("");
  }
  list.querySelectorAll("[data-action='del-yearly']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteYearlyReminder(btn.closest(".list-row").dataset.id);
      await loadYearly();
      triggerSyncQuietly();
    });
  });

}

// Wired exactly once (loadYearly re-renders the list and may run many times).
$("#yearly-add").addEventListener("click", async () => {
  const text = $("#yearly-text").value.trim();
  const month = Number($("#yearly-month").value);
  const day = Number($("#yearly-day").value);
  if (!text || !day || day < 1 || day > 31) return;
  await addYearlyReminder(text, month, day);
  $("#yearly-text").value = "";
  $("#yearly-day").value = 1;
  await loadYearly();
  triggerSyncQuietly();
});

// Fire a background sync (no visible progress UI on this page — the popup's
// own sync icon will reflect the outcome next time it's opened) whenever a
// yearly reminder is added or removed, so it's not left waiting for the
// next task edit or popup open to actually reach the server.
function triggerSyncQuietly() {
  isSyncConfigured()
    .then((configured) => {
      if (configured) syncNow().catch((e) => console.error("DayDo: background sync failed", e));
    })
    .catch((e) => console.error("DayDo: could not check sync configuration", e));
}

// -------------------------- Trash tab --------------------------
async function loadTrash() {
  const list = $("#trash-list");
  const tasks = (await getTasks()).filter((t) => t.done).sort((a, b) => compareDateStr(b.date, a.date));
  if (tasks.length === 0) {
    list.innerHTML = `<p class="empty-state">No finished tasks yet.</p>`;
    return;
  }
  const groups = {};
  for (const t of tasks) (groups[t.date] ||= []).push(t);

  list.innerHTML = Object.keys(groups).map((date) => `
    <div class="group-label">${formatShort(date)}</div>
    ${groups[date].map((t) => `
      <div class="list-row done" data-id="${t.id}">
        <span class="row-main">${escapeHtml(t.text)}
          <div class="row-sub">Finished ${t.doneAt ? new Date(t.doneAt).toLocaleString() : ""}</div>
          ${t.description ? `<div class="row-sub row-desc">${escapeHtml(t.description)}</div>` : ""}
          ${(t.links && t.links.length) ? `<div class="row-links">${t.links.map((l) => `<a href="${escapeAttr(l)}" target="_blank" rel="noopener">${escapeHtml(l)}</a>`).join(" · ")}</div>` : ""}
        </span>
        <div class="row-actions">
          <button class="btn" data-action="restore">Restore</button>
          <button class="btn btn-danger" data-action="purge">Delete</button>
        </div>
      </div>`).join("")}
  `).join("");

  list.querySelectorAll("[data-action='restore']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await toggleTask(btn.closest(".list-row").dataset.id);
      await loadTrash();
      triggerSyncQuietly();
    });
  });
  list.querySelectorAll("[data-action='purge']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await deleteTask(btn.closest(".list-row").dataset.id);
      await loadTrash();
      triggerSyncQuietly();
    });
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// -------------------------- Boot --------------------------
(async function boot() {
  const settings = await getSetting("settings");
  document.documentElement.setAttribute("data-theme", settings?.theme === "dark" ? "dark" : "light");
  await gate();
})();
