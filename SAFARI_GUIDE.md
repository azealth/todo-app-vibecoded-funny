# Building DayDo as a Safari Extension

This is the full walkthrough for turning `extension/` into a working Safari
extension on your Mac: converting it, building it in Xcode, enabling it in
Safari, and fixing the most common way it silently fails to show up.

There's no separate Safari source to maintain — `extension/` is the single
source of truth for both Firefox and Safari. Apple's own converter tool
wraps it into an Xcode project that *references* `extension/` in place, so
you never hand-edit web extension files inside the generated project (see
"Keep the source of truth straight" below for why that matters).

What makes the one codebase work in both browsers:

- The background is a non-persistent event page (`background.html` loading
  `background.js` as a module) — the one background form both browsers, on
  both macOS and iOS, run the same way. Safari rejects persistent MV3
  backgrounds outright.
- Everything uses the promise-based `browser.*` APIs (`lib/compat.js`).
- Settings is declared as `options_ui`, so it's reachable from Safari's own
  **Settings → Extensions → DayDo → Settings** button too, and it's closed
  via the tabs API (Safari ignores `window.close()` on tabs it didn't open).
- The popup closes itself after opening Settings (Firefox does this
  automatically; Safari doesn't), and fills the screen on iPhone/iPad.
- Sync uses Firebase's plain REST APIs with `fetch` — no SDK, no remote
  code — and host permissions are limited to Firebase's own domains instead
  of every website, so Safari doesn't ask for access to all sites.

## Requirements

- A Mac with **Xcode** installed (from the App Store).
- **Safari 16.4 or later** (macOS or iOS/iPadOS), for full Manifest V3
  support. Check your version under **Safari → About Safari**.

## Part 1 — Convert and build

### 1. Run the converter

From the `todo-app` folder:

```bash
./scripts/build-safari.sh
# optionally with your own bundle id:
BUNDLE_ID=com.yourname.daydo ./scripts/build-safari.sh
```

That runs Apple's packager — `xcrun safari-web-extension-packager` on
current Xcode, or its old name `safari-web-extension-converter` on older
versions; the script picks whichever exists — with
`--project-location safari-build --app-name DayDo`,
and generates an Xcode project at `safari-build/DayDo/` with a macOS app and
an iOS app, both wrapping `extension/`.

**You will very likely see a wall of warnings** like:

```
Warning: The following keys in your manifest.json are not supported by
your current version of Safari:
    manifest_version
    icons
    storage
    content_security_policy
    ...
```

This is a long-standing, widely-reported quirk of the converter itself —
developers have seen it flag keys Safari indisputably supports, sometimes
almost the entire manifest. **Ignore this list and continue.** Specific to
this project: `browser_specific_settings.gecko` / `gecko_android`
(Firefox-only, meaningless to Safari), `options_ui`, and
`content_security_policy` may all show up here — expected and harmless.

### 2. Open the project and set a signing team

Open the generated `.xcodeproj` in Xcode. In the project navigator, select
the top-level project, then for **both** the app target and the extension
target:

- Go to **Signing & Capabilities**.
- Under **Team**, choose your Apple ID (add one via Xcode → Settings →
  Accounts if you haven't already).

Leaving Team as "None" is a common reason the next step silently fails to
actually register the extension.

### 3. Build and run the app — not just build it

Pick the **DayDo (macOS)** app scheme (not the extension scheme) at the top of the
Xcode window, and press **Run (▶)** — not just Build (⌘B).

This is the step people most often skip, and the single most common reason
an extension "isn't showing up": **the extension only registers itself with
Safari the first time its container app actually launches.** Building
alone produces a binary; it doesn't register anything with the system.

Once the app opens (it'll likely just show a near-empty window with
instructions), you can quit it — it's done its job.

## Part 2 — Enable it in Safari

### 4. Turn on Safari's Develop menu and allow unsigned extensions

1. **Safari → Settings → Advanced** → check **"Show features for web
   developers."** A **Develop** menu appears in the menu bar.
2. **Develop → Allow Unsigned Extensions.**

This has to be re-enabled **every time Safari fully quits and reopens** (or
your Mac restarts) — it does not persist, for any extension that isn't
notarized and distributed outside development. If DayDo worked yesterday
and is gone today, this is the first thing to check.

### 5. Enable it in Extensions settings

**Safari → Settings → Extensions.** DayDo should now be listed — check its
box to turn it on. Grant it permission to run on websites if prompted
("Always Allow" is simplest for personal use).

You're done — the toolbar icon should now open the same popup as the
Firefox version.

## iPhone and iPad

The same project has an iOS app target.

1. Pick the **DayDo (iOS)** scheme and your connected device (or a
   simulator), with a signing Team set on the iOS app *and* iOS extension
   targets, and press **Run**.
2. On the device: **Settings → Apps → Safari → Extensions → DayDo** → turn it
   on, and allow it (the Firebase sites are all it needs for sync).
3. In Safari, tap the **puzzle-piece / "Aa"** button in the address bar →
   **DayDo**.

Sign in with the same Firebase account as your desktop browsers and your
list syncs across all of them.

## Troubleshooting: sync fails in Safari but works in Firefox

DayDo requests access to Firebase's domains when you sign in. If you
declined, or Safari reset it: **Safari → Settings → Extensions → DayDo →
Edit Websites…** (on iOS: Settings → Apps → Safari → Extensions → DayDo) and
allow `firebaseio.com` / `firebasedatabase.app` / `googleapis.com`. Then
click the sync icon in the popup to retry.

## Troubleshooting: extension isn't appearing at all

Work through these roughly in order of likelihood:

1. **Did you actually Run the app, not just Build it?** (Step 3 above.) By
   far the most common cause. Building compiles it; running is what
   registers it with Safari.

2. **Did "Allow Unsigned Extensions" reset itself?** It doesn't survive a
   full Safari restart for unsigned/dev extensions. Re-check
   **Develop → Allow Unsigned Extensions** first if something that used to
   work has vanished.

3. **Is a signing Team actually set?** Check Signing & Capabilities on
   *both* the app target and the extension target — not just one.

4. **Is Safari new enough?** MV3 needs Safari 16.4+. On an older Safari the
   extension may fail to load, or only partially load.

5. **Force Safari to re-scan its extensions.** This is Apple's/1Password's
   own documented fix for "installed and enabled-looking, but not actually
   appearing," caused by a stale Launch Services cache:

   ```bash
   # Quit Safari first, then run this, then reopen Safari:
   /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R /Applications/Safari.app
   ```

6. **Keep the source of truth straight.** The generated project points at
   `extension/` rather than copying it. If you hand-edit web extension files
   through Xcode, you're editing `extension/` itself — fine — but never copy
   files *into* `safari-build/`, or you'll end up with a stale second copy
   that silently wins. If the project gets confused, delete `safari-build/`
   and re-run `./scripts/build-safari.sh`.

## Updating the extension after a code change

Because the Xcode project references `extension/` in place:

1. Edit `extension/` (or drop in a new version of this project's
   `extension/` folder).
2. Press **Run (▶)** in Xcode again so Safari picks up the change. No need to
   re-run the converter.
3. If Safari doesn't seem to reflect the update, toggle the extension's
   checkbox off and on in **Safari → Settings → Extensions**, or use the
   `lsregister` command above.

Only re-run `./scripts/build-safari.sh --force` if you want a fresh Xcode
project (it resets signing settings).
