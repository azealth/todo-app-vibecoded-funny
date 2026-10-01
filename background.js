import { ext } from "./lib/compat.js";
import { ensureYearlyTasksGenerated } from "./lib/storage.js";
import { isSyncConfigured, syncNow } from "./lib/api.js";

const ALARM_NAME = "daydo-daily-check";
const PERIOD_MINUTES = 60 * 6;

async function runDailyCheck() {
  try {
    await ensureYearlyTasksGenerated();
  } catch (e) {
    console.error("DayDo: yearly reminder generation failed", e);
  }
  try {
    if (await isSyncConfigured()) await syncNow();
  } catch (e) {
    // Background sync is best-effort; the popup will retry and surface errors.
    console.warn("DayDo: background sync skipped", e.message);
  }
}

// Alarms are NOT guaranteed to survive a browser restart (Firefox drops
// them; Safari may too when it unloads the extension). So instead of only
// creating the alarm in onInstalled, make sure it exists every time this
// non-persistent background page wakes up for any reason.
async function ensureAlarm() {
  try {
    const existing = await ext.alarms.get(ALARM_NAME);
    if (!existing) ext.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });
  } catch (e) {
    console.warn("DayDo: could not schedule alarm", e);
  }
}

// Listeners must be registered synchronously at top level so a
// non-persistent background page can be woken up by them.
ext.runtime.onInstalled.addListener(() => {
  runDailyCheck();
});

ext.runtime.onStartup?.addListener(() => {
  runDailyCheck();
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runDailyCheck();
});

ensureAlarm();
