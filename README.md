# 🚴🏼‍♂️ Strava Segment Comparator Extension 🏃🏼‍♀️

Chrome extension to compare two Strava activities by their segments. It can auto-detect activity tabs you already have open, read segment data from each activity, compute time and speed (or pace) deltas, and export the results as CSV. It runs entirely in your browser; no servers are involved.

If you have questions or issues, please open an issue on GitHub.

## Features

- **Auto-detect open Strava activity tabs**: Scans your open tabs and auto-fills the first two activity URLs
- **Manual URL entry**: Paste activity URLs if auto-detect isn’t used
- **No tab flicker**: If the activities are already open, they’re read in place; otherwise the page is fetched in the background. A hidden tab is only opened as a last resort
- **Segment comparison**: Matches segments by Strava's segment ID, so renamed segments still pair up and repeated efforts (laps, intervals) stay separate
- **Rides and runs**: Compares speed for rides and pace for runs, and normalizes across km/h vs mph and /km vs /mi
- **Unmatched segments**: Segments that only one activity has are listed rather than dropped
- **Athlete-aware headers**: Uses detected athlete names for table headers when available
- **Activity stats panels**: Shows a side-by-side comparison of key activity stats
- **CSV export**: One-click export of the comparison table
- **Persistent results**: The last comparison is auto-restored on popup open
- **Detailed logs**: Built-in activity log with statuses and errors; quick Clear button

Note: The current UI does not provide interactive table filtering. The comparison table is a simple, readable table with colored time and speed/pace deltas.

## Install (Load Unpacked)

1. In Chrome, go to `chrome://extensions/`
2. Enable Developer mode
3. Click “Load unpacked” and select this project folder
4. Pin the extension (optional) and open it from the toolbar

Required permissions: `tabs`, `storage`, and host access to `https://www.strava.com/*` (see `manifest.json`).

## Usage

### Quick start (Auto-detection)

1. Open two Strava activity pages in separate tabs
2. Click the extension icon
3. Click “Auto-Detect” to populate the URLs
4. Click “Compare Activities”

### Manual

1. Copy/paste two activity URLs into the input fields
2. Click “Compare Activities”

### Export

Click “Export CSV” to download a CSV with headers that include the detected athlete names.

### Status coloring

- Time deltas: positive = slower (red), negative = faster (green)
- Speed deltas: positive = faster (green), negative = slower (red)
- Pace deltas: positive = slower (red), negative = faster (green)

Shading intensity scales with the size of the delta: a full-strength tint is 60s
of time, 5 km/h of speed, or 30 s/km of pace.

## How it works (high-level)

Getting the data for one activity takes the cheapest route that works, and falls
back automatically when a route fails:

1. **The activity is already open in a tab** — the content script reads it directly. No new tabs, no fetching.
2. **Some other strava.com tab is open** — that tab fetches the activity HTML from its own origin (so your session cookie is sent), and the popup parses it with `DOMParser`.
3. **Nothing relevant is open** — the popup opens a background tab, waits for the content script to answer, reads the data, and closes the tab again.

Files:

- `extractor.js`: all DOM reading. Every function takes an explicit `Document`, so the same code runs against a live page or against fetched HTML
- `content-script.js`: request/response bridge on strava.com — extract this page, or fetch another activity. It waits for the segments table with a `MutationObserver` instead of a fixed sleep
- `popup.js`: tab detection, route selection, comparison, rendering, CSV export
- `utils.js`: pure parsing and comparison helpers (times, speeds, paces, segment matching)
- `background.js`: minimal MV3 service worker

## Development

### Tests

```sh
npm install
npm test
```

`utils.js` and `extractor.js` are covered by unit tests; `tests/popup.test.js`
loads the real `popup.html` and `popup.js` into jsdom with a stubbed `chrome`
API and exercises the full comparison and rendering path.

### Styles

`tailwind.output.css` is **hand-maintained plain CSS** — a small subset of
Tailwind-style utilities plus the extension's own component classes. It is not
generated from `tailwind.css`, so do not overwrite it with a Tailwind build;
edit it directly.

Project structure (selected):

- `manifest.json`: Chrome MV3 manifest (name, version, permissions)
- `popup.html`, `popup.js`, `tailwind.output.css`: Popup UI and logic
- `extractor.js`, `content-script.js`: Reading data out of Strava pages
- `utils.js`: Parsing and comparison helpers
- `tests/`: Vitest suites
- `icons/`: Extension icons

## Privacy

- No network requests to external servers are made by the extension
- Reads only Strava activity pages and your open tabs’ URLs (for auto-detection)
- Comparison results are stored with `chrome.storage.local` to auto-restore the last view

## Troubleshooting

- “No segments found”: Make sure you’re on an activity page that has segments and let the page fully load. Click Compare again
- Auto-detect didn’t find tabs: Ensure your tabs are `https://www.strava.com/activities/<id>` pages and the extension has the `tabs` permission
- “Redirected away from the activity page”: You’re signed out, or the activity is private. Open it in a tab and compare again
- Athlete names missing or “unknown”: Not all pages expose the same metadata; this is expected sometimes
- If the popup shows stale data, click “Clear” to reset and re-run the comparison
- The activity log in the popup names the route used for each activity, which is the fastest way to see where a comparison went wrong

## License

MIT — see `LICENSE.md`.
