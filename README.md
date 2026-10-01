# DayDo

A day-organized to-do list: one shared WebExtension codebase that loads
directly in **Firefox** and converts to a **Safari** extension (macOS and
iOS) with Apple's own tool, plus optional cross-device sync through **your
own Firebase Realtime Database**, and an optional live **Discord dashboard**.

```
todo-app/
├── extension/     Shared source for the Firefox & Safari extensions
├── firebase/      Database security rules + optional Discord Cloud Functions
├── scripts/       build-safari.sh, package-firefox.sh
└── tests/         Sync tests (node --test)
```

No build step for the extension — it's plain HTML/CSS/JS (ES modules), so
you can load it as-is and read every file directly. There is no server to
host anymore: the extension talks to Firebase directly.

## Assumptions worth knowing about

- **Lock-on-close** uses `browser.storage.session`, which the browser itself
  clears when it fully quits — so the app is locked again next launch with
  no extra code. The manual lock button just clears the same flag early.
- **"Current week"** is Sunday–Saturday. Yesterday and today are always
  shown; the rest of *this* week is always shown too (even with no tasks
  yet, so you can plan ahead); anything further out only appears once it
  actually has a task on it (added via the date-picker on the **+** button).
- **Two days back and older**: tasks drop out of the main view. If any of
  them are still unfinished, they're rolled into the **UNFINISHED TASKS (N)**
  button instead of just disappearing. Finished tasks are always still
  visible in **Settings → Trash**, regardless of age.
- **Sync** is last-write-wins per task by its `updatedAt` timestamp — and
  that's enforced by the database itself: the security rules reject any
  write that would replace a task with an *older* copy. Each sync reads your
  data, then writes everything that changed in one atomic update; if
  something newer landed in between (say, a task checked off from Discord),
  the database rejects the whole update and DayDo simply re-reads and tries
  again. Local edits made while a sync is in flight are never lost, and a
  sync that's been superseded by a newer one (from any page, or the
  background alarm) discards its own result.
- **Deletions** leave a small tombstone in the database, so deleting a task
  or yearly reminder on one device removes it from every device instead of
  another device re-uploading its copy. Tombstones are pruned after 90 days.
- **Yearly reminder** tasks get a deterministic id per occurrence, so two
  devices generating the same birthday before they've synced produce one
  task, not two.
- **Live updates**: while the popup is open it listens to the database, so a
  change from another device or from Discord appears within a second or two.
- The color theme is Discord's own blurple (`#5865F2`), including the
  extension icon and the Discord embed color.

## 1. Set up Firebase (optional — only needed for sync)

Skip this whole section to use DayDo local-only. It's free on the Spark
plan.

1. At <https://console.firebase.google.com>, **create a project** (Analytics
   isn't needed).
2. **Build → Realtime Database → Create Database.** Pick a location and
   start in **locked mode**.
3. **Build → Authentication → Get started → Sign-in method → Email/Password →
   Enable.**
4. **Deploy the security rules** in `firebase/database.rules.json`. These
   are what keep your data private to your account and enforce
   last-write-wins, so don't skip this. Either:
   - **Console:** Realtime Database → **Rules** tab → paste the file's
     contents → **Publish**, or
   - **CLI:**
     ```bash
     npm install -g firebase-tools
     firebase login
     cd firebase
     cp .firebaserc.example .firebaserc   # put your project id in it
     firebase deploy --only database
     ```
5. **Project settings (⚙) → General → Your apps → Add app → Web (`</>`).**
   Give it any nickname (no Hosting needed). Firebase shows a
   `firebaseConfig` snippet — you need its `apiKey` and `databaseURL`.
   (If `databaseURL` is missing, you created the app before the database;
   refresh the page and copy it again.)
6. In DayDo, open **Settings → Sync (Firebase)**. Paste the whole
   `firebaseConfig` snippet into either field (both fill in), enter an email
   and password, and click **Create account**. On every other device, enter
   the same config and click **Sign in** with the same account.

Optional hardening: once your account(s) exist, go to **Authentication →
Settings → User actions** and turn off **Enable create (sign-up)**. The web
API key is public by design and your data is already private to you, but
this stops anyone else from creating accounts on your project to use its
quota. (After that, DayDo's **Create account** will say sign-ups are off —
use **Sign in**.)

Your password is sent only to Firebase Auth and never stored; DayDo keeps a
refresh token, like the official Firebase SDK does.

### Coming from the old sync server?

The Node server is gone — the extension talks to Firebase directly now.
Your tasks live in each browser's local storage, so nothing is lost: the
first time you sign in, everything on that device uploads. Sign in on your
most up-to-date device first. If you ran the Discord bot, delete its old
dashboard message; the new one posts a fresh message.

## 2. Discord dashboard (optional)

The dashboard now runs as three small **Cloud Functions** in your Firebase
project, so there's still nothing to host. Cloud Functions need the
**Blaze** (pay-as-you-go) plan; a single-person dashboard uses a tiny
fraction of the monthly free allowance.

1. Create an application at the
   [Discord Developer Portal](https://discord.com/developers/applications).
   Copy its **Public Key** (General Information). Under **Bot**, reset and
   copy the **token**. No privileged intents are needed.
2. Invite the bot to your server (**OAuth2 → URL Generator**, scope `bot`,
   permissions **Send Messages** + **Embed Links**).
3. Configure and deploy:
   ```bash
   cd firebase/functions
   npm install
   cp .env.example .env    # fill in public key, channel id, your DayDo user id, timezone, region
   cd ..
   firebase functions:secrets:set DISCORD_BOT_TOKEN   # paste the bot token
   firebase deploy --only functions
   ```
   Your DayDo user ID is shown in **Settings → Sync** once you're signed in.
   `DAYDO_REGION` must match your database's location.
4. The deploy prints a URL for **`discordInteractions`**. Paste it into the
   Developer Portal → **General Information → Interactions Endpoint URL** →
   **Save**. (Discord pings it to verify; it must say saved.)
5. Add or check off any task in DayDo — the dashboard message appears in the
   channel.

It works like before: one live-updating message listing every active task
grouped into ⚠️ Unfinished / 📌 Today / 🗓️ Upcoming, blurple (or red once
something's overdue). Click a task to check it off, **➕ Add task** to add
one via a form, or **🔄 Refresh**. It's edited in place, re-sorted right
after midnight in your timezone, and updates within seconds of any change
from any device.

If a click after a long idle period says "This interaction failed", that's
a function cold start exceeding Discord's 3-second limit — click again. To
avoid it entirely, add `minInstances: 1` to the `discordInteractions`
options in `functions/index.js` (keeps one instance warm, at a small cost).

## 3. Load the extension in Firefox

**For development:**

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `extension/manifest.json`.

(or `npm run run:firefox` to launch a fresh Firefox with it loaded.)

Firefox 140+ is required (140 is the current ESR). `npm run lint:firefox`
runs Mozilla's official validator; `npm run package:firefox` zips it for
[addons.mozilla.org](https://addons.mozilla.org) — to install a permanent
copy, upload that zip to AMO for signing (it can be unlisted/self-distributed).

If sync ever fails with a network error in Firefox, check **about:addons →
DayDo → Permissions** and make sure the Firebase sites are allowed (DayDo
asks for them when you sign in).

## 4. Build the Safari extension

```bash
./scripts/build-safari.sh
```

Then open the generated Xcode project, set a signing team, and press
**Run**. **See [SAFARI_GUIDE.md](./SAFARI_GUIDE.md) for the full
walkthrough** — including iPhone/iPad, and a troubleshooting checklist for
the most common way it silently fails to show up in Safari's Extensions list.

## Using the extension

- **First launch**: you'll be asked to create a 4-digit PIN. After that, the
  same PIN unlocks it every time.
- **Locking**: click the lock icon top-right any time, or just close the
  browser — it's locked again next time it opens.
- **Adding tasks**: click the **+** next to any visible day to add straight
  to that day, or use the round **+** button bottom-right to add a task on
  any date, including months out.
- **Checking things off**: tap the checkbox. It stays listed under the day
  it was created on, just shown as done.
- **Task details**: the small (i) button on any task opens a spot to add a
  description and any number of links. Once a task has a link attached, a
  second small icon appears next to it as a shortcut straight to the first
  link.
- **Unfinished tasks**: once a day is more than a day old, it drops off the
  main list — unless it still has unfinished tasks, in which case an
  **UNFINISHED TASKS (N)** button appears; tapping it opens those, grouped
  by their original day.
- **Settings** (gear icon, or the browser's own extension settings): Dark/Light
  mode, changing your PIN, **Sync (Firebase)**, **Trash** (every finished
  task, ever, by day — with restore/delete), and **Yearly Reminder** (add
  something like a birthday once and it creates a task automatically every
  year).
- **Sync status**: once you're signed in, a check icon appears next to the
  lock. It spins while syncing, turns into a check when everything's up to
  date (hover it to see the last sync time), and turns into a warning icon if
  a sync attempt fails (hover for why, click to retry).

## Tests

```bash
npm test                      # extension sync logic, two simulated devices + Discord
cd firebase/functions && npm test   # Discord payloads, dates, signature checks
```

The sync tests run the real `extension/lib` modules against an in-memory
stand-in for Firebase's REST API that enforces the same rules as
`database.rules.json`.
