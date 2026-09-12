# 🚴🏼‍♂️ Strava Segment Comparator Extension 🏃🏼‍♀️

Chrome extension to compare two Strava activities by their segments. It can auto-detect activity tabs you already have open, read segment data from each activity, compute time and speed (or pace) deltas, and export the results as CSV. It runs entirely in your browser; no servers are involved.

If you have questions or issues, please open an issue on GitHub.

## Features

- **Auto-detect open Strava activity tabs**: Scans your open tabs and auto-fills the first two activity URLs
- **Manual URL entry**: Paste activity URLs if auto-detect isn’t used
- **No tab flicker**: If the activities are already open, they’re read in place; otherwise the page is fetched in the background. A hidden tab is only opened as a last resort
- **Segment comparison**: Matches segments by Strava's segment ID, so renamed segments still pair up and repeated efforts (laps, intervals) stay separate
- **Summary strip**: The net gap, the win/loss count, and the biggest losses and gains by name, above the table
- **Sortable columns**: Click a header to sort; click again to reverse
- **Rides and runs**: Compares speed for rides and pace for runs, and normalizes across km/h vs mph and /km vs /mi. Runs no longer need to be open in a tab
- **Power and heart rate**: Average power and heart rate per segment and their deltas, each shown when either activity recorded it
- **VAM**: Metres climbed per hour on segments averaging 3% or steeper, and the delta
- **Medals**: Strava's own PR / 2nd / 3rd (and KOM) marker next to each effort's time
- **Segment context**: Distance and average grade under each segment name
- **Personal records**: One click adds your PR for each segment and how far off it you were
- **My Activities Here**: Lists your other activities on activity 1's segments, most shared first; click one to compare against it
- **Unmatched segments**: Segments that only one activity has are listed rather than dropped
- **Athlete-aware headers**: Uses detected athlete names for table headers when available
- **Activity stats panels**: Shows a side-by-side comparison of key activity stats
- **CSV export**: One-click export of the comparison table
- **Persistent results**: The last comparison is auto-restored on popup open
- **Detailed logs**: Built-in activity log with statuses and errors; quick Clear button

Note: The current UI does not provide interactive table filtering. The comparison table is a simple, readable table with colored time and speed/pace deltas, sortable by any column.

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

### My Activities Here

Fill in (or auto-detect) Activity 1 only, then click “My Activities Here”. It
reads activity 1’s segments, looks up your effort history on each, and lists up
to five of your other activities that share the most of them, with their date
and how many segments they share. Click one to fill Activity 2 and compare.

- “Your” means the signed-in Strava athlete, so this also works when activity 1
  is a friend’s ride: it finds your rides on the same segments
- Each segment’s history is one request, shared with “Compare vs my PRs” through
  a 24-hour cache, so running one makes the other free. Only your 20 most recent
  activities per segment are considered

### Reading the summary

Above the table you get the net gap, how many segments each athlete took, and
the biggest three losses and gains by name. The net is a plain sum of the
per-segment deltas — the sense in which people say “I lost three minutes” — so
a long segment contributes more to it than a short one. It is not weighted by
segment length, and a segment inside another (a climb within a lap, a lap within
a full-route segment) counts in both, by design: overlapping segments are often
the interesting ones.

### Sorting

Click any column header to sort by it; click the same header again to reverse.
Segments with no value in that column always sink to the bottom, in both
directions, so an unreadable row never ranks as the fastest. The default order
is activity 1’s page order, which is the order you rode them.

### Compare vs my PRs

“Compare vs my PRs” adds two columns: your personal record on each segment, and
how far activity 1 was off it. The PR is your all-time best, so if activity 1
is your own PR ride it shows `0:00`; a negative value means activity 1 beat
your PR.

Some caveats worth knowing:

- The PR is **yours**, as the signed-in Strava athlete. It is only meaningful
  when one of the two activities is yours
- It is read from your effort history on each segment
  (`/athlete/segments/{id}/history`, the JSON Strava’s own site uses), and the
  PR is your fastest elapsed time there. If that endpoint fails, the segment’s
  page is read instead, and the activity log says so and why
- Strava has no bulk PR endpoint, so this is one request per segment. It is
  capped at 60 segments per click, runs three at a time, and caches results for
  24 hours, shared with “My Activities Here”. `Clear` does not empty that cache
- Segments where the PR cannot be read show `N/A`. That means "unknown", not
  "no PR" — this reads what Strava serves rather than guessing

### Export

Click “Export CSV” to download a CSV with headers that include the detected
athlete names. It contains exactly the columns the table is showing, in the
sort order you left it in.

### Status coloring

- Time deltas: positive = slower (red), negative = faster (green)
- Speed deltas: positive = faster (green), negative = slower (red)
- Pace deltas: positive = slower (red), negative = faster (green)
- Power and VAM deltas: positive = more (green), negative = less (red)
- Heart-rate deltas are not shaded: a lower heart rate is only good news if the
  time held up, so a colour would mislead as often as it helped

Shading intensity scales with the size of the delta: a full-strength tint is 60s
of time, 5 km/h of speed, 30 s/km of pace, 50 W of power, or 200 m/h of VAM.

### VAM

VAM is computed as distance × average grade ÷ time, for both activities alike.
Strava fills in its own VAM only for categorized climbs, and it means little on
flat ground, so segments averaging under 3% show `N/A`. On one segment the climb
is the same for both activities, so the VAM delta is the time delta expressed in
climbing units — useful for comparing across climbs, not new information within
one.

## How it works (high-level)

Getting the data for one activity takes the cheapest route that works, and falls
back automatically when a route fails:

1. **The activity is already open in a tab** — the content script reads it directly. No new tabs, no fetching.
2. **Some other strava.com tab is open** — that tab fetches the activity HTML from its own origin (so your session cookie is sent), and the popup parses it with `DOMParser`.
3. **Nothing relevant is open** — the popup opens a background tab, waits for the content script to answer, reads the data, and closes the tab again.

A strava.com tab is only used for route 2 if its content script answers. Tabs
opened before the extension was installed or updated are skipped until you
reload them.

Segment data comes from the inline script that seeds Strava’s efforts list
(`pageView.segmentEfforts().reset(…)`) rather than from the table: it has raw
numbers (times, heart rate, power, grade), reads the same in every language and
unit system, and is in the page’s HTML even for runs, whose table is only drawn
after the page loads. The table is read only when that data is missing.

Files:

- `extractor.js`: all DOM reading. Every function takes an explicit `Document`, so the same code runs against a live page or against fetched HTML
- `content-script.js`: request/response bridge on strava.com — extract this page, fetch another activity, or look up your effort history on a segment (your PR and recent activities there; the segment page is the fallback for the PR). It only fetches from an allowlist of paths, and waits for the segments table with a `MutationObserver` instead of a fixed sleep
- `popup.js`: tab detection, route selection, comparison, rendering, CSV export. The table's columns are declared once in `COLUMNS`, which drives the headers, the cells and the CSV together
- `utils.js`: pure parsing and comparison helpers (times, speeds, paces, power, heart rate, VAM, distances, segment matching, sorting, summary, ranking your activities)
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
- “No personal records found”: You are either not signed in, or signed in as an athlete who has not ridden these segments. The PR columns stay hidden rather than filling with N/A
- “No Strava segment ids in this comparison”: The comparison was saved by 2.6, which could not read segment ids. Click “Compare Activities” again, then retry
- “Effort history unavailable … read their segment pages instead” in the log: Strava refused or changed the history endpoint, so PRs came from the slower, less reliable segment page. The message includes the first error
- Power or heart-rate columns missing: Neither activity recorded it, or Strava served data this version does not recognise. Runs usually have no power
- VAM columns missing: None of the matched segments averages 3% or steeper
- “My Activities Here” lists nothing: None of your 20 most recent activities on each segment is another activity than activity 1, or your effort history could not be read — the log says which
- If the popup shows stale data, click “Clear” to reset and re-run the comparison
- The activity log in the popup names the route used for each activity, which is the fastest way to see where a comparison went wrong

## License

MIT — see `LICENSE.md`.
