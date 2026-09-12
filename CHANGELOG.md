# Changelog

## Version 2.6.1 - PRs that load

### 🐛 Fixes

- **Compare vs my PRs always failed** with "These segments have no Strava
  segment id". The extractor looked for a `/segments/{id}` link in each row,
  which existed only in the test fixtures: Strava's rows carry just
  `data-segment-effort-id`. Segment ids are now read from the inline script
  that seeds the page's efforts list (`pageView.segmentEfforts().reset(…)`),
  which is present on the live page and in fetched HTML alike
- **Segments now really match by id**, as the README already claimed. Before
  this they silently fell back to matching by name, so a renamed segment did
  not pair up
- **PRs come from your effort history** (`/athlete/segments/{id}/history`,
  JSON) instead of scraping the segment page, which is now only the fallback.
  When the fallback is used, the activity log says so once, with the reason
- **Segment distance** under each name was always blank on real pages: it lives
  in the stats line under the name, not in its own cell
- An effort link (`/activities/{a}/segments/{effort}`) could be read as a
  segment id, which would have fetched the PR of an unrelated segment
- "Found your PR for N of M segments" counted laps in N but not in M
- A comparison saved by 2.6 has no segment ids; the PR button now says to run
  the comparison again instead of reporting a dead end

### 🔧 Technical Changes

- `content-script.js` fetches through one allowlist of paths, and its
  signed-out check compares the final URL's path instead of pattern-matching
  the whole URL, query string included
- New `tests/content-script.test.js` covers the history-then-page fallback,
  signed-out handling and the path allowlist

## Version 2.6 - Where the time went

### 🆕 New Features

- **Summary strip**: above the table, a headline showing the net gap, how many
  segments each athlete won, and the three biggest losses and gains by name.
  The question you opened the popup to answer is now the first thing on screen
- **Sortable columns**: click any header to sort by it, click again to reverse.
  Rows with no value for that column always sink to the bottom rather than
  ranking as "fastest", ties keep course order, and the CSV export follows
  whatever sort is on screen. The default is still activity 1's page order,
  which is course order
- **Power columns**: average power per segment for both activities plus the
  delta. Power was already being scraped and thrown away. The columns only
  appear when at least one activity recorded power, so runs are unaffected
- **Segment distance**: shown under the segment name, since it is context for
  the row rather than something to compare
- **Compare vs my PRs**: fetches your personal record for each matched segment
  from its Strava page and adds "Your PR" and "vs PR" columns. Results are
  cached for 24 hours, fetched three at a time, and capped at 60 segments per
  click. A segment whose PR cannot be read shows N/A — never a fabricated zero

### 🔧 Technical Changes

- The table is now generated from a single column model, so header text, cell
  contents and CSV output cannot drift apart, and conditional columns are one
  `when` predicate rather than three parallel edits
- `content-script.js` gained `fetchSegmentPr`, which fetches and parses the
  segment page in the content script so only the PR crosses the message
  boundary instead of a megabyte of HTML
- Path validation on the content script's fetch helper: it will only request
  `/activities/{id}` and `/segments/{id}`
- The background-tab ping loop moved into `waitForContentScript`, now shared by
  activity extraction and `withProxyTab`
- Segment distance and power fall back to matching cell contents when Strava
  drops the `.distance` / `.power` classes. The distance fallback deliberately
  accepts only km/mi, because the elevation column is the other m/ft value in
  the same row

### 🧪 Testing

- 94 tests, up from 46: summary maths, sort ordering and missing-value
  handling, power and distance parsing, PR pairing, PR extraction across four
  markup shapes, and an integration test that drives the PR fetch end to end
  including a mid-flight failure and the cache

## Version 2.4 - Reliability, correctness and cleanup

### 🐛 Bug Fixes

- **Speed deltas across unit systems**: speeds were parsed as bare numbers, so comparing an athlete on mph against one on km/h silently subtracted incompatible values and labelled the result `km/h`. Units are now parsed and normalized, and the delta is reported in activity 1's unit
- **Runs produced empty speed columns**: the segment table for a run shows pace (`5:32 /km`), which no selector matched, so every run row fell back to `N/A` and rendered a meaningless `0.0 km/h` delta. Pace is now parsed and compared, and the columns are labelled *Pace* instead of *Speed*
- **Repeated segments were dropped**: segments were keyed by name in a `Map`, so riding the same segment twice kept only the last effort and paired efforts arbitrarily. Matching now keys on Strava's segment ID plus an occurrence index
- **Renamed segments stopped matching**: name equality meant any difference in punctuation or whitespace dropped the pair. Segment ID is now authoritative, with the name only as a fallback
- **Delta shading was meaningless**: the tint intensity was computed by stripping non-digits from the formatted label, so `2:05` became the number `2.05` and a two-minute gap shaded lighter than a five-second one. Shading now scales on the real delta
- **Missing times counted as zero**: an unparseable time became `0`, producing large fake deltas. Missing values are now `null` and render as `N/A`
- **Leaked timers and cross-talk**: the fetch path never cleared its timeouts, closed already-closed tabs, and could resolve one activity's request with the other's data. Messaging is now request/response with no shared broadcast channel

### 🔒 Security

- Segment names and log messages are page-controlled text and were being written with `innerHTML`. All rendering now goes through `textContent` / `createElement`
- Segment links are validated against `https://www.strava.com` before being used as an `href`
- Removed `web_accessible_resources`, which exposed extension files to every site

### ⚡ Reliability

- Activity data is now read by the cheapest route available: directly from a tab that already has the activity open, else by fetching the HTML from within an existing strava.com tab, else by opening a background tab
- The fixed 3-second wait before extraction is gone. The content script waits for the segments table with a `MutationObserver`, and the popup polls the tab until the content script answers
- Background tabs are always closed, including when extraction fails

### 🆕 Improvements

- Segments present in only one activity are listed in a collapsible section instead of being silently discarded
- All storage moved to `chrome.storage.local`; `Clear` no longer reloads the popup
- CSV export quotes every field

### 🧹 Cleanup

- Removed `lib/simple-datatables.*` (~140 KB loaded on every popup open, unused) and its dead CSS rules
- Removed `popup.css`, which was never linked from `popup.html`
- Removed dead helpers: `getTimeDiffClass`, `getSpeedDiffClass`, `buildStatsMap`, `lookup`, `sanitize`, and the unused `dataTable` global
- DOM reading moved into `extractor.js`, shared by the content script and the popup
- Activity stats extraction no longer re-reads the same text once per ancestor element
- Version strings in `manifest.json` and `popup.html` now agree

### 🧪 Testing

- Added Vitest with 46 tests: unit coverage for parsing and matching, DOM coverage for extraction, and an integration test that drives the real popup in jsdom
- `npm test` runs the suite (it previously exited 1 by design)

## Version 2.2 - Help System Enhancement

### 🆕 New Features
- **Help Icon**: Added a help icon (❓) in the top-right corner of the popup
- **Collapsible Help Section**: Tips and instructions are now hidden by default and shown only when the help icon is clicked
- **Interactive Help Button**: Help icon changes appearance when active and provides visual feedback
- **Improved UX**: Cleaner interface with help content accessible on-demand

### 🎨 UI/UX Improvements
- Moved tip text from always-visible to on-demand help section
- Added smooth transitions for help section show/hide
- Enhanced help content with step-by-step instructions
- Added visual feedback for help button states (hover, active)
- Improved header layout with help icon positioned in top-right corner

### 🔧 Technical Changes
- Added `toggleHelpSection()` function to handle help visibility
- Enhanced CSS with `.help-icon` styles and `.active` state
- Added transition animations for smooth help section appearance
- Updated DOM structure to accommodate help icon in header

## Version 2.1 - Auto-Detection Feature

### 🆕 New Features
- **Auto-Detection of Open Strava Activity Tabs**: The extension now automatically scans all open browser tabs to find Strava activity pages and populates the input fields automatically
- **Auto-Detect Button**: Added a manual "Auto-Detect" button to re-scan tabs on demand
- **Enhanced Status Messages**: Added emoji-enhanced status messages with better visual feedback
- **Detailed Tab Logging**: Activity logs now show detailed information about detected tabs

### 🔧 Technical Changes
- Added `"tabs"` permission to `manifest.json` to enable querying all browser tabs
- Created `autoPopulateActivityUrls()` function that:
  - Queries all open tabs using `chrome.tabs.query({})`
  - Filters tabs matching Strava activity URL pattern (`/https:\/\/www\.strava\.com\/activities\/\d+/`)
  - Sorts tabs by ID for consistent ordering (oldest tabs first)
  - Populates the first two detected activity URLs
  - Saves detected URLs to Chrome storage
- Modified popup initialization to run auto-detection after loading saved URLs
- Added event listener for the new "Auto-Detect" button

### 🎨 UI/UX Improvements
- Updated input field placeholders to indicate auto-detection capability
- Added informational tip text explaining the auto-detection feature
- Enhanced status messages with emojis for better visual feedback
- Improved activity logs with more detailed information about the detection process

### 📝 Documentation Updates
- Updated README.md with new auto-detection usage instructions
- Added "Quick Start" section for auto-detection workflow
- Created test documentation file (`test-auto-detect.html`)
- Updated feature list to highlight auto-detection capability

### 🔄 Workflow Changes
1. **Previous workflow**: User manually enters two Strava activity URLs
2. **New workflow**: 
   - User opens 2 Strava activity pages in separate tabs
   - Extension automatically detects and populates URLs when popup opens
   - User can click "Auto-Detect" to re-scan if needed
   - Fallback to manual entry if no tabs are detected

### 🛡️ Privacy & Security
- Extension only accesses tab URLs for detection purposes
- No external data transmission
- Maintains existing privacy standards
- Tab access is limited to URL pattern matching

### 🧪 Testing
- All JavaScript files pass syntax validation
- Auto-detection works with multiple tab scenarios:
  - 0 tabs: Shows message to open Strava activities
  - 1 tab: Populates first field, prompts for second
  - 2+ tabs: Populates both fields, uses first two found
- Maintains backward compatibility with manual URL entry 