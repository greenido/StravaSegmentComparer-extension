# 🚴🏼‍♂️ Strava Segment Comparator Extension 🏃🏼‍♀️

Chrome extension to compare two Strava activities by their segments. It can auto-detect activity tabs you already have open, fetch segment data from each page, compute time and speed deltas, and export the results as CSV. It runs entirely in your browser; no servers are involved.

If you have questions or issues, please open an issue on GitHub.

## Features

- **Auto-detect open Strava activity tabs**: Scans your open tabs and auto-fills the first two activity URLs
- **Manual URL entry**: Paste activity URLs if auto-detect isn’t used
- **Segment comparison**: Matches segments by exact name, preserves Activity 1 page order
- **Athlete-aware headers**: Uses detected athlete names for table headers when available
- **Activity stats panels**: Shows a side-by-side comparison of key activity stats
- **CSV export**: One-click export of the comparison table
- **Persistent results**: The last comparison is auto-restored on popup open
- **Detailed logs**: Built-in activity log with statuses and errors; quick Clear button

Note: The current UI does not provide interactive table filtering. The comparison table is a simple, readable table with colored time/speed deltas.

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

The extension opens the two activities in background tabs (inactive), waits a short moment for the page to load, asks the content script to extract data, then closes the tabs. Default timeout per activity is ~20s.

### Manual

1. Copy/paste two activity URLs into the input fields
2. Click “Compare Activities”

### Export

Click “Export CSV” to download a CSV with headers that include the detected athlete names.

### Status coloring

- Time deltas: positive = slower (red), negative = faster (green)
- Speed deltas: positive = faster (green), negative = slower (red)

## How it works (high-level)

- `content-script.js` runs only on `https://www.strava.com/activities/*` pages and extracts:
  - Activity title, URL, activity ID, and athlete name (with multiple fallbacks)
  - Activity stats from `.section.more-stats` using robust label/value heuristics
  - Segment rows from common table variants, capturing name, time, speed, distance, power
- `popup.js`:
  - Auto-detects open Strava tabs (`chrome.tabs.query`) to auto-fill URLs
  - Opens hidden tabs to fetch both activities, receives `segmentData` messages, compares by segment name, and computes deltas
  - Renders results with headers that include detected athlete names, builds stats panels, and supports CSV export
- `background.js` is a light MV3 service worker scaffold

## Development

You can use the checked-in CSS as-is. If you want to tweak styles and rebuild Tailwind:

1. Install deps once (for Tailwind/PostCSS tooling):

   ```sh
   npm install
   ```

2. Build CSS from `tailwind.css` to `tailwind.output.css`:

   ```sh
   npx tailwindcss -i tailwind.css -o tailwind.output.css --minify
   ```

Project structure (selected):

- `manifest.json`: Chrome MV3 manifest (name, version, permissions)
- `popup.html`, `popup.js`, `tailwind.output.css`: Popup UI and logic
- `content-script.js`: Extracts activity stats and segments from Strava pages
- `background.js`: MV3 service worker
- `utils.js`: Parsing helpers for times and speeds
- `icons/`: Extension icons
- `lib/simple-datatables.*`: Library bundled for optional table enhancements (not required by current UI)

## Privacy

- No network requests to external servers are made by the extension
- Reads only Strava activity pages and your open tabs’ URLs (for auto-detection)
- Comparison results are stored in `localStorage` to auto-restore the last view

## Troubleshooting

- “No segments found”: Make sure you’re on an activity page that has segments and let the page fully load. Click Compare again
- Auto-detect didn’t find tabs: Ensure your tabs are `https://www.strava.com/activities/<id>` pages and the extension has the `tabs` permission
- Athlete names missing or “unknown”: Not all pages expose the same metadata; this is expected sometimes
- If the popup shows stale data, click “Clear” to reset and re-run the comparison

## License

MIT — see `LICENSE.md`.
