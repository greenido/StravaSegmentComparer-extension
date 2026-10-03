/**
 * Popup controller.
 *
 * Activity data is obtained by the cheapest route that works:
 *   1. the activity is already open in a tab   -> read it straight from there
 *   2. some other strava.com tab is open       -> have it fetch the HTML for us
 *   3. nothing open                            -> open a background tab, then close it
 *
 * Routes 1 and 2 involve no new tabs and no fixed sleeps.
 */

const STORAGE_KEYS = [
  'activity1',
  'activity2',
  'athlete1Name',
  'athlete2Name',
  'comparisonResults'
];

// DOM Elements
const activity1Input = document.getElementById('activity1');
const activity2Input = document.getElementById('activity2');
const compareBtn = document.getElementById('compareBtn');
const statusDiv = document.getElementById('status');
const resultsDiv = document.getElementById('results');
const exportBtn = document.getElementById('exportBtn');
const prBtn = document.getElementById('prBtn');
const logContent = document.getElementById('logContent');
const clearBtn = document.getElementById('clearBtn');
const autoDetectBtn = document.getElementById('autoDetectBtn');
const myActivitiesBtn = document.getElementById('myActivitiesBtn');
const myActivitiesSection = document.getElementById('myActivitiesSection');
const openTabBtn = document.getElementById('openTabBtn');
const tableSearch = document.getElementById('tableSearch');
const filterCount = document.getElementById('filterCount');
const helpBtn = document.getElementById('helpBtn');
const helpSection = document.getElementById('helpSection');
const versionSpan = document.getElementById('version');

let logEntries = [];

// Current comparison, kept for CSV export and for re-rendering after a sort.
let comparison = { matched: [], onlyIn1: [], onlyIn2: [] };
let lastStats = { stats1: [], stats2: [] };
let athlete1Name = null;
let athlete2Name = null;
let rateLabel = 'Speed';

// null key means "activity 1 page order", which is course order and therefore
// meaningful in its own right. Sorting is opt-in, by clicking a header.
let sortState = { key: null, direction: 'desc' };

// Whether the summary counts segments that sit inside other segments. A view
// choice like the sort, so it is not saved with the comparison.
let excludeNested = false;

// Substring the table is narrowed to, by segment name. Also a view choice.
let filterText = '';

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  // The manifest is the one place the version is written down; a number typed
  // into the heading as well would eventually disagree with it.
  versionSpan.textContent = chrome.runtime.getManifest().version;

  applyTabView();

  compareBtn.addEventListener('click', compareActivities);
  exportBtn.addEventListener('click', exportAsCSV);
  prBtn.addEventListener('click', loadPersonalRecords);
  autoDetectBtn.addEventListener('click', () => autoPopulateActivityUrls());
  myActivitiesBtn.addEventListener('click', findMyActivities);

  helpBtn.addEventListener('click', e => {
    e.preventDefault();
    toggleHelpSection();
  });
  helpBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleHelpSection();
    }
  });

  openTabBtn.addEventListener('click', openInTab);
  tableSearch.addEventListener('input', () => {
    filterText = tableSearch.value.trim();
    renderComparison(comparison);
  });
  clearBtn.addEventListener('click', clearResults);

  restoreState();
});

async function restoreState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS);

  if (data.activity1) activity1Input.value = data.activity1;
  if (data.activity2) activity2Input.value = data.activity2;
  if (data.athlete1Name) athlete1Name = data.athlete1Name;
  if (data.athlete2Name) athlete2Name = data.athlete2Name;

  const saved = data.comparisonResults;
  if (saved && saved.matched) {
    comparison = { matched: saved.matched, onlyIn1: saved.onlyIn1 || [], onlyIn2: saved.onlyIn2 || [] };
    rateLabel = saved.rateLabel || 'Speed';
    lastStats = { stats1: saved.stats1 || [], stats2: saved.stats2 || [] };
    addLogEntry('Restored the previous comparison', 'info');
    renderComparison(comparison);
    if (saved.stats1 || saved.stats2) {
      displayStatsComparison(lastStats.stats1, lastStats.stats2);
    }
    resultsDiv.classList.remove('hidden');
  }

  // Open tabs win over saved URLs.
  autoPopulateActivityUrls({ quiet: true });
}

async function clearResults() {
  await chrome.storage.local.remove('comparisonResults');

  comparison = { matched: [], onlyIn1: [], onlyIn2: [] };
  sortState = { key: null, direction: 'desc' };
  filterText = '';
  tableSearch.value = '';
  filterCount.classList.add('hidden');
  document.getElementById('segmentsTableBody').replaceChildren();
  document.getElementById('segmentsTableHead').replaceChildren();
  document.getElementById('summarySection').replaceChildren();
  document.getElementById('activityStatsSection')?.remove();
  document.getElementById('unmatchedSection')?.remove();
  resultsDiv.classList.add('hidden');

  addLogEntry('Cleared saved results', 'info');
  showStatus('Results cleared successfully', 'success');
}

/* ------------------------------------------------------------------ *
 * Popup or tab
 * ------------------------------------------------------------------ */

// The same page serves both; this is what tells it which one it is in.
const TAB_VIEW_PARAM = 'view=tab';

function isTabView() {
  return new URLSearchParams(window.location.search).get('view') === 'tab';
}

/**
 * Drop the popup's size limits when the page is a tab of its own.
 *
 * A Chrome popup can be 800px wide at most, and the table reaches eighteen
 * columns with the optional ones showing, so the wide view is a real one — it
 * is the same page, reading the same saved comparison, without the clamps.
 */
function applyTabView() {
  if (!isTabView()) return;

  document.body.classList.add('view-tab');
  // Opening a tab from a tab would be a curiosity, not a feature.
  openTabBtn.classList.add('hidden');
}

function openInTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?${TAB_VIEW_PARAM}`) });
}

/* ------------------------------------------------------------------ *
 * Tab auto-detection
 * ------------------------------------------------------------------ */

const ACTIVITY_URL_RE = /^https:\/\/www\.strava\.com\/activities\/\d+/;

function isValidStravaActivityUrl(url) {
  return ACTIVITY_URL_RE.test(url || '');
}

function extractActivityIdFromUrl(url) {
  const match = (url || '').match(/activities\/(\d+)/);
  return match ? match[1] : null;
}

async function findActivityTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://www.strava.com/activities/*' });
  return tabs
    .filter(tab => isValidStravaActivityUrl(tab.url))
    .sort((a, b) => a.id - b.id);
}

/**
 * Fill the URL fields from the open activity tabs.
 *
 * Clicking Auto-Detect reports the outcome in the status line. Opening the
 * popup runs it `quiet`, logging only: no open tabs is not an error when nobody
 * asked, and a red banner on every open would sit on top of the comparison
 * restored underneath it.
 */
async function autoPopulateActivityUrls({ quiet = false } = {}) {
  const report = quiet ? addLogEntry : showStatus;

  try {
    addLogEntry('Searching for open Strava activity tabs...', 'info');
    if (!quiet) showStatus('Scanning open tabs for Strava activities...', 'loading');

    const stravaActivityTabs = await findActivityTabs();
    addLogEntry(`Found ${stravaActivityTabs.length} open Strava activity tabs`, 'info');

    if (!stravaActivityTabs.length) {
      if (!quiet) {
        showStatus('❌ No open Strava activity tabs found - please navigate to Strava activities first', 'error');
      }
      return;
    }

    activity1Input.value = stravaActivityTabs[0].url;
    addLogEntry(`Auto-populated Activity 1: ${extractActivityIdFromUrl(stravaActivityTabs[0].url)}`, 'success');

    if (stravaActivityTabs.length >= 2) {
      activity2Input.value = stravaActivityTabs[1].url;
      addLogEntry(`Auto-populated Activity 2: ${extractActivityIdFromUrl(stravaActivityTabs[1].url)}`, 'success');
      report('✅ Auto-detected 2 Strava activities - ready to compare!', 'success');
    } else {
      report('⚠️ Found 1 Strava activity - please open another activity tab or enter URL manually', 'info');
    }

    if (stravaActivityTabs.length > 2) {
      addLogEntry(`Note: ${stravaActivityTabs.length} activity tabs open, using the first 2`, 'info');
    }

    await chrome.storage.local.set({
      activity1: activity1Input.value,
      activity2: activity2Input.value
    });
  } catch (error) {
    addLogEntry(`Error auto-detecting Strava tabs: ${error.message}`, 'error');
    if (!quiet) showStatus(`Error scanning tabs: ${error.message}`, 'error');
  }
}

function toggleHelpSection() {
  const nowVisible = helpSection.classList.toggle('hidden') === false;
  helpBtn.classList.toggle('active', nowVisible);
  helpBtn.title = nowVisible ? 'Hide help and tips' : 'Show help and tips';
  helpBtn.setAttribute('aria-expanded', String(nowVisible));
}

/* ------------------------------------------------------------------ *
 * Data acquisition
 * ------------------------------------------------------------------ */

const TAB_READY_TIMEOUT_MS = 25000;
const PING_INTERVAL_MS = 300;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 * Used to fetch personal records without firing one request per segment at once.
 */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

function unwrap(response) {
  if (!response) throw new Error('No response from the Strava page');
  if (!response.ok) throw new Error(response.error || 'Extraction failed');
  return response;
}

/** Read the activity out of a tab that is already showing it. */
async function extractFromTab(tabId) {
  const response = await chrome.tabs.sendMessage(tabId, { action: 'extractSegmentData' });
  return unwrap(response).data;
}

/** Ask any strava.com tab to fetch the activity for us, then parse it here. */
async function extractViaProxyTab(proxyTabId, activityId) {
  const response = await chrome.tabs.sendMessage(proxyTabId, {
    action: 'fetchActivityHtml',
    activityId
  });

  const html = unwrap(response).html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return extractActivityData(doc, `https://www.strava.com/activities/${activityId}`);
}

/** Poll a tab until its content script is injected and answering. */
async function waitForContentScript(tabId) {
  const deadline = Date.now() + TAB_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      return true;
    } catch (_) {
      await delay(PING_INTERVAL_MS);
    }
  }

  return false;
}

// Background tabs this page opens for its own use. Closing one in a `finally`
// is not enough on its own: the popup is destroyed the moment the user clicks
// away, and its `finally` blocks with it. So the service worker is kept told
// which tabs are open, and closes whatever is left when this page's port
// disconnects (see background.js).

// Must match WORK_TABS_PORT in background.js.
const WORK_TABS_PORT = 'workTabs';
// The service worker is stopped after 30 seconds without an event, which would
// take its list down with it. A message on the port counts as one.
const WORK_TABS_HEARTBEAT_MS = 20000;

const workTabIds = new Set();
let workTabsPort = null;
let workTabsHeartbeat = null;

/** Send the service worker the full list of tabs this page has open. */
function syncWorkTabs() {
  if (!workTabsPort) {
    workTabsPort = chrome.runtime.connect({ name: WORK_TABS_PORT });
    // Reconnected, with the list sent again, on the next sync.
    workTabsPort.onDisconnect.addListener(() => {
      workTabsPort = null;
    });
  }
  workTabsPort.postMessage({ tabIds: [...workTabIds] });

  if (workTabIds.size && !workTabsHeartbeat) {
    workTabsHeartbeat = setInterval(syncWorkTabs, WORK_TABS_HEARTBEAT_MS);
  } else if (!workTabIds.size && workTabsHeartbeat) {
    clearInterval(workTabsHeartbeat);
    workTabsHeartbeat = null;
  }
}

async function openWorkTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  workTabIds.add(tab.id);
  syncWorkTabs();
  return tab;
}

async function closeWorkTab(tabId) {
  // Closed before it leaves the list, so there is no moment where the tab is
  // open and nobody would close it.
  await chrome.tabs.remove(tabId).catch(() => {});
  workTabIds.delete(tabId);
  syncWorkTabs();
}

/** Last resort: open the activity in a background tab and read it there. */
async function extractViaNewTab(activityId) {
  const tab = await openWorkTab(`https://www.strava.com/activities/${activityId}`);
  addLogEntry(`Opened background tab ${tab.id} for activity ${activityId}`, 'info');

  try {
    if (!(await waitForContentScript(tab.id))) {
      throw new Error('Timed out waiting for the activity page to load');
    }

    return await extractFromTab(tab.id);
  } finally {
    // Always clean up, including on failure.
    await closeWorkTab(tab.id);
    addLogEntry(`Closed background tab ${tab.id}`, 'info');
  }
}

/**
 * Get one activity, preferring routes that do not open tabs.
 * Each fallback is logged so failures are diagnosable from the popup.
 */
async function fetchActivityData(activityId, openTabs, proxyTabId) {
  const existing = openTabs.find(tab => extractActivityIdFromUrl(tab.url) === activityId);

  if (existing) {
    try {
      addLogEntry(`Activity ${activityId} is already open, reading tab ${existing.id}`, 'info');
      return await extractFromTab(existing.id);
    } catch (error) {
      addLogEntry(`Could not read the open tab (${error.message}), trying a fetch`, 'warning');
    }
  }

  if (proxyTabId !== null && proxyTabId !== undefined) {
    try {
      addLogEntry(`Fetching activity ${activityId} via tab ${proxyTabId} (no new tab)`, 'info');
      return await extractViaProxyTab(proxyTabId, activityId);
    } catch (error) {
      addLogEntry(`Fetch failed (${error.message}), falling back to a background tab`, 'warning');
    }
  }

  return extractViaNewTab(activityId);
}

/**
 * Any strava.com tab whose content script answers can act as the fetch proxy.
 *
 * A tab opened before the extension was installed or updated is still showing
 * Strava but has no live content script until it is reloaded. Using it anyway
 * would fail every request, so it is skipped.
 */
async function findProxyTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://www.strava.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      return tab.id;
    } catch (_) {
      // Try the next one.
    }
  }
  return null;
}

/**
 * Run `fn` with a tab id that can fetch from strava.com on our behalf.
 *
 * An already-open tab is reused. Only when there is none do we open one, and
 * it is always closed again — including when `fn` throws.
 */
async function withProxyTab(fn) {
  const existingId = await findProxyTabId();
  if (existingId !== null && existingId !== undefined) {
    return fn(existingId);
  }

  const tab = await openWorkTab('https://www.strava.com/dashboard');
  addLogEntry(`Opened background tab ${tab.id} to reach Strava`, 'info');

  try {
    if (!(await waitForContentScript(tab.id))) {
      throw new Error('Timed out waiting for Strava to load');
    }
    return await fn(tab.id);
  } finally {
    await closeWorkTab(tab.id);
    addLogEntry(`Closed background tab ${tab.id}`, 'info');
  }
}

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

async function compareActivities() {
  const activity1Url = activity1Input.value.trim();
  const activity2Url = activity2Input.value.trim();

  if (!isValidStravaActivityUrl(activity1Url) || !isValidStravaActivityUrl(activity2Url)) {
    showStatus('Please enter valid Strava activity URLs', 'error');
    return;
  }

  const activity1Id = extractActivityIdFromUrl(activity1Url);
  const activity2Id = extractActivityIdFromUrl(activity2Url);

  if (activity1Id === activity2Id) {
    showStatus('Both URLs point at the same activity', 'error');
    return;
  }

  compareBtn.disabled = true;
  await chrome.storage.local.set({ activity1: activity1Url, activity2: activity2Url });
  showStatus('Fetching segment data from both activities...', 'loading');

  try {
    const openTabs = await findActivityTabs();
    const proxyTabId = await findProxyTabId();

    const [activity1Data, activity2Data] = await Promise.all([
      fetchActivityData(activity1Id, openTabs, proxyTabId),
      fetchActivityData(activity2Id, openTabs, proxyTabId)
    ]);

    athlete1Name = activity1Data.athleteName || `Activity ${activity1Id}`;
    athlete2Name = activity2Data.athleteName || `Activity ${activity2Id}`;
    await chrome.storage.local.set({ athlete1Name, athlete2Name });

    addLogEntry(`Activity #1: ${activity1Data.segments.length} segments`, 'success');
    addLogEntry(`Activity #2: ${activity2Data.segments.length} segments`, 'success');
    logStatsSource(1, activity1Data);
    logStatsSource(2, activity2Data);

    rateLabel = rateColumnLabel(activity1Data.segments);
    comparison = compareSegmentLists(activity1Data.segments, activity2Data.segments);
    logNestingSupport(activity1Data.segments, comparison.matched);
    // A fresh comparison starts in course order again.
    sortState = { key: null, direction: 'desc' };
    excludeNested = false;
    filterText = '';
    tableSearch.value = '';
    lastStats = { stats1: activity1Data.activityStats, stats2: activity2Data.activityStats };

    if (!comparison.matched.length) {
      showStatus('No segments in common between these two activities', 'error');
    } else {
      showStatus(`Successfully compared ${comparison.matched.length} segments`, 'success');
    }

    renderComparison(comparison);
    displayStatsComparison(activity1Data.activityStats, activity2Data.activityStats);
    resultsDiv.classList.remove('hidden');

    await saveComparison();
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    compareBtn.disabled = false;
  }
}

/**
 * Say where the activity stats came from, when it was not the page itself.
 *
 * Reading the rendered markup is the normal path and stays quiet. The other two
 * outcomes are worth a line: they are the difference between "Strava changed
 * its layout again" and "this page never had stats to read".
 */
function logStatsSource(index, activity) {
  if (activity.activityStatsSource === 'data') {
    addLogEntry(`Activity #${index}: stats read from Strava's embedded data, not the page markup`, 'info');
  } else if (activity.activityStatsSource === 'none') {
    addLogEntry(`Activity #${index}: no activity stats found`, 'warning');
  }
}

/**
 * Say in the log whether overlapping segments could be detected at all.
 *
 * Whether Strava's efforts payload carries positions is not something this can
 * know in advance, and its absence is invisible in the UI — the toggle simply
 * never appears. One line makes the difference between "no nested segments" and
 * "nesting could not be read" checkable on any real activity.
 */
function logNestingSupport(segments, matched) {
  if (segments.length < 2) return;

  if (!segments.some(segment => segment.span)) {
    addLogEntry(
      "Strava's efforts data on this page carries no segment positions, so segments inside other segments cannot be found",
      'info'
    );
    return;
  }

  const nested = matched.filter(row => row.nestedIn).length;
  addLogEntry(
    nested
      ? `${nested} matched segment(s) sit inside another segment; the summary can leave them out`
      : 'No matched segment sits inside another',
    'info'
  );
}

function saveComparison() {
  return chrome.storage.local.set({
    comparisonResults: {
      matched: comparison.matched,
      onlyIn1: comparison.onlyIn1,
      onlyIn2: comparison.onlyIn2,
      rateLabel,
      stats1: lastStats.stats1,
      stats2: lastStats.stats2
    }
  });
}

/* ------------------------------------------------------------------ *
 * Your effort history
 *
 * Strava has no bulk endpoint for "my efforts on these segments", so each
 * segment's history is one request, made through a strava.com tab and reduced
 * there to your PR and your recent activities on it. The work is capped, run
 * at a small concurrency and cached for a day, and the cache is shared by
 * "Compare vs my PRs" and "My Activities Here", so either warms it for the
 * other.
 * ------------------------------------------------------------------ */

const HISTORY_CACHE_KEY = 'segmentHistoryCache';
// Where 2.6 kept PRs alone; cleared on the next write.
const LEGACY_PR_CACHE_KEY = 'prCache';
const HISTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// A segment whose history could not be read is tried again much sooner. The
// usual reasons — a rate limit, a network blip, a moment signed out — pass in
// minutes, and holding on to one for a day would show N/A for a day.
const HISTORY_RETRY_AFTER_MS = 10 * 60 * 1000;
const HISTORY_FETCH_CONCURRENCY = 3;
const HISTORY_MAX_SEGMENTS = 60;
// How often the cache is written back while a run is in progress. Also the
// progress-message cadence, so the number the user sees and the number that is
// safely stored are the same.
const HISTORY_FLUSH_EVERY = 5;
// Breathing room between requests, so a 60-segment ride is a steady trickle
// rather than a burst at Strava.
const HISTORY_FETCH_SPACING_MS = 250;

/** Read the history cache, dropping entries older than their TTL. */
async function readHistoryCache() {
  const data = await chrome.storage.local.get(HISTORY_CACHE_KEY);
  const cached = data[HISTORY_CACHE_KEY] || {};
  const fresh = {};

  Object.entries(cached).forEach(([segmentId, entry]) => {
    if (!entry) return;
    const ttl = entry.incomplete ? HISTORY_RETRY_AFTER_MS : HISTORY_CACHE_TTL_MS;
    if (Date.now() - (entry.fetchedAt || 0) < ttl) fresh[segmentId] = entry;
  });

  return fresh;
}

/** Write the cache back, dropping nothing that is already in it. */
function persistHistoryCache(cache) {
  return chrome.storage.local.set({ [HISTORY_CACHE_KEY]: cache });
}

/** Distinct segment ids, capped at what one click may look up. */
function segmentIdsToLookUp(segments) {
  const segmentIds = [...new Set(segments.map(segment => segment.segmentId).filter(Boolean))];
  if (segmentIds.length > HISTORY_MAX_SEGMENTS) {
    addLogEntry(`Looking up the first ${HISTORY_MAX_SEGMENTS} of ${segmentIds.length} segments`, 'warning');
  }
  return segmentIds.slice(0, HISTORY_MAX_SEGMENTS);
}

/**
 * Your history on each of `segmentIds`: `{ pr, recent }` per segment, where
 * `recent` is null if Strava's history could not be read for it.
 */
async function fetchSegmentHistories(segmentIds) {
  const cache = await readHistoryCache();
  const missing = segmentIds.filter(segmentId => !(segmentId in cache));
  addLogEntry(`${segmentIds.length - missing.length} segment histories cached, ${missing.length} to fetch`, 'info');
  if (!missing.length) return cache;

  showStatus(`Reading your history on ${missing.length} segments...`, 'loading');
  const historyErrors = [];

  await withProxyTab(async tabId => {
    let done = 0;

    try {
      await mapWithLimit(missing, HISTORY_FETCH_CONCURRENCY, async segmentId => {
        try {
          const response = unwrap(
            await chrome.tabs.sendMessage(tabId, { action: 'fetchSegmentHistory', segmentId })
          );
          if (response.historyError) historyErrors.push(response.historyError);
          cache[segmentId] = {
            pr: response.pr || null,
            recent: response.recent || null,
            times: response.times || null,
            effortCount: response.effortCount || null,
            // The PR came from the segment page, without the history behind
            // it, so the history is worth asking for again soon.
            incomplete: Boolean(response.historyError),
            fetchedAt: Date.now()
          };
        } catch (error) {
          // Cache the miss too, so one bad segment is not retried on every
          // click, but only briefly: the cause is usually gone in minutes.
          addLogEntry(`Segment ${segmentId}: ${error.message}`, 'warning');
          cache[segmentId] = {
            pr: null,
            recent: null,
            times: null,
            effortCount: null,
            incomplete: true,
            fetchedAt: Date.now()
          };
        }

        done += 1;
        if (done % HISTORY_FLUSH_EVERY === 0 || done === missing.length) {
          showStatus(`Read ${done}/${missing.length} segment histories...`, 'loading');
          // Saved as we go: a 60-segment ride takes half a minute, and the
          // popup — with this whole run in it — is destroyed the moment the
          // user clicks away. Whatever has been read by then is kept, so the
          // next click resumes instead of starting over.
          await persistHistoryCache(cache);
        }
        if (done < missing.length) await delay(HISTORY_FETCH_SPACING_MS);
      });
    } finally {
      // Also keep it when the run is cut short by an error, not only when a
      // batch boundary happens to fall at the end.
      await persistHistoryCache(cache);
    }
  });

  // One line, not one per segment: it is almost always the same reason.
  if (historyErrors.length) {
    addLogEntry(
      `Effort history unavailable for ${historyErrors.length} segment(s) (${historyErrors[0]}), ` +
        'read their segment pages instead',
      'warning'
    );
  }

  await chrome.storage.local.remove(LEGACY_PR_CACHE_KEY);
  return cache;
}

/**
 * Look up the signed-in athlete's PR for every matched segment and add two
 * columns comparing activity 1 against it.
 *
 * Note this is *your* PR as the signed-in athlete, which is only meaningful
 * when one of the two activities is yours.
 */
async function loadPersonalRecords() {
  if (!comparison.matched.length) {
    showStatus('Compare two activities first', 'error');
    return;
  }

  const wanted = segmentIdsToLookUp(comparison.matched);
  if (!wanted.length) {
    // Most likely a comparison saved by a version that could not read segment
    // ids; re-reading the activities fixes it.
    showStatus('No Strava segment ids in this comparison — click "Compare Activities" again, then retry', 'error');
    return;
  }

  prBtn.disabled = true;

  try {
    const cache = await fetchSegmentHistories(wanted);

    const prBySegmentId = {};
    const historyBySegmentId = {};
    Object.entries(cache).forEach(([segmentId, entry]) => {
      if (entry.pr) prBySegmentId[segmentId] = entry.pr;
      if (entry.times && entry.times.length) historyBySegmentId[segmentId] = entry;
    });

    comparison = {
      ...comparison,
      // Both come out of the same response, so the PR columns and the history
      // column always agree with each other.
      matched: applyEffortHistory(applyPersonalRecords(comparison.matched, prBySegmentId), historyBySegmentId)
    };

    // Per segment, not per row: laps of one segment share one PR.
    const found = wanted.filter(segmentId => prBySegmentId[segmentId]).length;
    renderComparison(comparison);
    await saveComparison();

    if (found) {
      showStatus(`Found your PR for ${found} of ${wanted.length} segments`, 'success');
    } else {
      showStatus('No personal records found — are you signed in to Strava as the athlete who rode these?', 'error');
    }
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    prBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * My activities here
 * ------------------------------------------------------------------ */

const MY_ACTIVITIES_SHOWN = 5;

/**
 * Suggest your other activities on activity 1's segments, most shared first,
 * so activity 2 can be picked instead of hunted for.
 */
async function findMyActivities() {
  const activity1Url = activity1Input.value.trim();
  if (!isValidStravaActivityUrl(activity1Url)) {
    showStatus('Enter or auto-detect Activity 1 first', 'error');
    return;
  }
  const activity1Id = extractActivityIdFromUrl(activity1Url);

  myActivitiesBtn.disabled = true;
  myActivitiesSection.classList.add('hidden');

  try {
    showStatus('Reading the segments of activity 1...', 'loading');
    const openTabs = await findActivityTabs();
    const activity = await fetchActivityData(activity1Id, openTabs, await findProxyTabId());

    const segmentIds = segmentIdsToLookUp(activity.segments);
    if (!segmentIds.length) {
      showStatus('Activity 1 has no segments with a Strava id to look up', 'error');
      return;
    }

    const cache = await fetchSegmentHistories(segmentIds);
    const recentBySegmentId = {};
    segmentIds.forEach(segmentId => {
      if (cache[segmentId] && cache[segmentId].recent) recentBySegmentId[segmentId] = cache[segmentId].recent;
    });

    const candidates = rankSharedActivities(segmentIds, recentBySegmentId, activity1Id, MY_ACTIVITIES_SHOWN);
    renderMyActivities(candidates, segmentIds.length);

    if (candidates.length) {
      showStatus(`Pick one of your activities to compare with activity 1`, 'success');
    } else if (!Object.keys(recentBySegmentId).length) {
      showStatus('Could not read your effort history on these segments — see the log', 'error');
    } else {
      showStatus('None of your other activities share these segments', 'info');
    }
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    myActivitiesBtn.disabled = false;
  }
}

function formatActivityDate(date) {
  // Strava's local start time: the calendar date is the part that matters,
  // and reading it as UTC could move it by a day.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function renderMyActivities(candidates, segmentCount) {
  myActivitiesSection.replaceChildren();
  if (!candidates.length) return;

  const heading = document.createElement('div');
  heading.className = 'activity-options-heading';
  heading.textContent = 'Your activities on these segments — pick one to compare:';
  myActivitiesSection.appendChild(heading);

  candidates.forEach(candidate => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'activity-option';

    // Activity names are free text, so they only ever go in as text.
    const name = document.createElement('span');
    name.className = 'activity-option-name';
    name.textContent = candidate.name || `Activity ${candidate.activityId}`;
    option.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'activity-option-meta';
    meta.textContent = [
      formatActivityDate(candidate.date),
      `${candidate.shared} of ${segmentCount} segments`
    ].filter(Boolean).join(' · ');
    option.appendChild(meta);

    option.addEventListener('click', () => {
      activity2Input.value = `https://www.strava.com/activities/${candidate.activityId}`;
      compareActivities();
    });

    myActivitiesSection.appendChild(option);
  });

  myActivitiesSection.classList.remove('hidden');
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * What to call activity 1 or 2 in headers, the summary and the stats panels.
 *
 * The athlete's name, unless both activities are the same athlete's — the most
 * common comparison of all, two of your own rides — where the name would label
 * both columns alike. The activity number then says which is which, and matches
 * the URL fields it came from.
 */
function getDisplayName(index) {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const name = clean(index === 1 ? athlete1Name : athlete2Name);
  const other = clean(index === 1 ? athlete2Name : athlete1Name);

  if (!name || name.toLowerCase() === other.toLowerCase()) return `Activity ${index}`;
  return name;
}

/** Only ever link to strava.com; segment names come from a page we don't own. */
function safeStravaLink(url) {
  try {
    const parsed = new URL(url, 'https://www.strava.com');
    return parsed.origin === 'https://www.strava.com' ? parsed.href : null;
  } catch (_) {
    return null;
  }
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

/**
 * Background tint whose opacity scales with how big the delta is.
 * `scale` is the delta at which the tint reaches full strength, in whatever
 * unit `delta` is expressed (seconds, km/h, seconds per km).
 */
function diffStyle(delta, positiveIsFaster, scale) {
  const better = isImprovement(delta, positiveIsFaster);
  if (better === null) return '';

  const alpha = Math.min(0.85, Math.abs(delta) / scale);
  return better
    ? `background-color: rgba(34, 197, 94, ${alpha.toFixed(2)});`
    : `background-color: rgba(220, 38, 38, ${alpha.toFixed(2)});`;
}

/**
 * Which way a delta went, as a judgement rather than a sign.
 *
 * The tint and the arrow are the same statement made twice, so they are
 * decided in one place.
 *
 * @returns {boolean|null} null when there is nothing to say
 */
function isImprovement(delta, positiveIsFaster) {
  if (delta === null || delta === undefined || Number.isNaN(delta) || delta === 0) return null;
  return positiveIsFaster ? delta > 0 : delta < 0;
}

/**
 * Put an arrow next to a delta.
 *
 * Colour alone carries the whole meaning of these columns, which leaves out
 * anyone who cannot separate the red from the green — around one man in twelve,
 * on a table aimed at cyclists. The arrow says the same thing in a second
 * channel, and reads aloud.
 */
function appendDirectionMark(td, better) {
  if (better === null) return;

  const mark = document.createElement('span');
  mark.className = `diff-mark ${better ? 'diff-mark-better' : 'diff-mark-worse'}`;
  mark.textContent = better ? '\u25b2' : '\u25bc';
  mark.title = better ? 'Better' : 'Worse';
  mark.setAttribute('aria-label', better ? 'better' : 'worse');
  td.appendChild(mark);
}

/**
 * The segment name, with its distance and average grade underneath.
 *
 * These live here rather than in their own columns because they are the same
 * for both activities — context for the row, not something to compare.
 */
function buildNameCell(row) {
  const td = document.createElement('td');

  const href = safeStravaLink(row.link);
  if (href) {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'text-blue-500 hover:underline';
    link.textContent = row.name;
    td.appendChild(link);
  } else {
    td.textContent = row.name;
  }

  const grade = typeof row.grade === 'number' ? `${row.grade.toFixed(1)}%` : null;
  const context = [row.distance, grade].filter(Boolean).join(' · ');
  if (context) {
    const line = document.createElement('div');
    line.className = 'segment-distance';
    line.textContent = context;
    td.appendChild(line);
  }

  // Says why a row may be missing from the summary, and why the same road can
  // appear twice in the table.
  if (row.nestedIn) {
    const inside = document.createElement('div');
    inside.className = 'segment-nested';
    inside.textContent = `inside ${row.nestedIn}`;
    td.appendChild(inside);
  }

  return td;
}

/** The reading of time against heart rate, as a tinted word. */
function buildQualityCell(row) {
  const td = document.createElement('td');
  if (!row.quality) {
    td.textContent = 'N/A';
    return td;
  }

  const badge = document.createElement('span');
  badge.className = `quality quality-${row.quality.key}`;
  badge.textContent = row.quality.label;
  badge.title = row.quality.title;
  td.appendChild(badge);

  return td;
}

/* ------------------------------------------------------------------ *
 * Your history on a segment
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPARK_WIDTH = 70;
const SPARK_HEIGHT = 18;
const SPARK_PADDING = 2;

function svgElement(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

/**
 * Your times on one segment, oldest to newest, as a sparkline.
 *
 * Faster is higher, which is the direction people read as improvement, and the
 * fastest effort — your PR — is marked. The scale is per segment: the shape of
 * your own progression is the point, not how it compares to another segment.
 */
function buildSparkline(times) {
  const points = (times || []).filter(point => point && Number.isFinite(point.seconds));
  if (points.length < 2) return null;

  const seconds = points.map(point => point.seconds);
  const fastest = Math.min(...seconds);
  const slowest = Math.max(...seconds);
  const span = slowest - fastest;

  const usableWidth = SPARK_WIDTH - SPARK_PADDING * 2;
  const usableHeight = SPARK_HEIGHT - SPARK_PADDING * 2;

  const x = index => SPARK_PADDING + (usableWidth * index) / (points.length - 1);
  // No spread at all (every effort the same time) sits on the middle line
  // rather than dividing by zero.
  const y = value =>
    span === 0
      ? SPARK_PADDING + usableHeight / 2
      : SPARK_PADDING + (usableHeight * (value - fastest)) / span;

  const svg = svgElement('svg', {
    class: 'spark',
    viewBox: `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`,
    width: SPARK_WIDTH,
    height: SPARK_HEIGHT,
    role: 'img',
    'aria-hidden': 'true'
  });

  svg.appendChild(
    svgElement('polyline', {
      class: 'spark-line',
      points: points.map((point, index) => `${x(index).toFixed(1)},${y(point.seconds).toFixed(1)}`).join(' ')
    })
  );

  const fastestIndex = seconds.indexOf(fastest);
  svg.appendChild(
    svgElement('circle', {
      class: 'spark-best',
      cx: x(fastestIndex).toFixed(1),
      cy: y(fastest).toFixed(1),
      r: 1.6
    })
  );

  return svg;
}

/** The rank among your efforts here, with the progression underneath. */
function buildHistoryCell(row) {
  const td = document.createElement('td');
  if (row.history_title) td.title = row.history_title;

  const label = document.createElement('div');
  label.className = 'history-rank';
  label.textContent = row.history_label || 'N/A';
  td.appendChild(label);

  const spark = buildSparkline(row.history_times);
  if (spark) td.appendChild(spark);

  return td;
}

/** An effort's time, with Strava's medal for it (PR, 2nd, KOM…) alongside. */
function buildTimeCell(time, medal) {
  const td = cell(time);
  if (medal) {
    const badge = document.createElement('span');
    badge.className = 'medal';
    badge.textContent = medal.label;
    if (medal.description) badge.title = medal.description;
    td.appendChild(badge);
  }
  return td;
}

/**
 * The table's columns, in order.
 *
 * A column with a `when` is only shown if the data supports it, so runs do not
 * get empty power columns and the PR columns stay hidden until they are asked
 * for. Header text, cell contents and CSV output all come from here, so they
 * cannot drift apart.
 */
const COLUMNS = [
  {
    key: 'name',
    className: 'col-segment',
    label: () => 'Segment Name',
    build: buildNameCell,
    csv: row => row.name
  },
  {
    key: 'time_1',
    className: 'col-time',
    label: () => `Time (${getDisplayName(1)})`,
    build: row => buildTimeCell(row.time_1, row.achievement_1),
    text: row => row.time_1
  },
  {
    key: 'time_2',
    className: 'col-time',
    label: () => `Time (${getDisplayName(2)})`,
    build: row => buildTimeCell(row.time_2, row.achievement_2),
    text: row => row.time_2
  },
  {
    key: 'time_diff',
    className: 'col-diff',
    label: () => 'Time Diff',
    csvLabel: () => 'Time Difference',
    text: row => row.time_diff,
    // 60s of difference reaches full tint.
    style: row => diffStyle(row.time_diff_seconds, false, 60),
    mark: row => isImprovement(row.time_diff_seconds, false)
  },
  {
    key: 'rate_1',
    className: 'col-speed',
    label: () => `${rateLabel} (${getDisplayName(1)})`,
    text: row => row.rate_1
  },
  {
    key: 'rate_2',
    className: 'col-speed',
    label: () => `${rateLabel} (${getDisplayName(2)})`,
    text: row => row.rate_2
  },
  {
    key: 'rate_diff',
    className: 'col-diff col-rate-diff',
    label: () => `${rateLabel} Diff`,
    csvLabel: () => `${rateLabel} Difference`,
    text: row => row.rate_diff,
    // Speeds saturate at 5 km/h, paces at 30 s/km.
    style: row =>
      diffStyle(row.rate_diff_value, row.rate_positive_is_faster, row.rate_positive_is_faster ? 5 : 30),
    mark: row => isImprovement(row.rate_diff_value, row.rate_positive_is_faster)
  },
  {
    key: 'power_1',
    className: 'col-power',
    label: () => `Power (${getDisplayName(1)})`,
    text: row => row.power_1,
    when: data => hasPowerData(data.matched)
  },
  {
    key: 'power_2',
    className: 'col-power',
    label: () => `Power (${getDisplayName(2)})`,
    text: row => row.power_2,
    when: data => hasPowerData(data.matched)
  },
  {
    key: 'power_diff',
    className: 'col-diff',
    label: () => 'Power Diff',
    text: row => row.power_diff,
    // More watts is not automatically better, but it is the reading a cyclist
    // expects to see rewarded, and 50 W is a decisive gap.
    style: row => diffStyle(row.power_diff_value, true, 50),
    mark: row => isImprovement(row.power_diff_value, true),
    when: data => hasPowerData(data.matched)
  },
  {
    key: 'hr_1',
    className: 'col-hr',
    label: () => `HR (${getDisplayName(1)})`,
    text: row => row.hr_1 || 'N/A',
    when: data => hasHeartRateData(data.matched)
  },
  {
    key: 'hr_2',
    className: 'col-hr',
    label: () => `HR (${getDisplayName(2)})`,
    text: row => row.hr_2 || 'N/A',
    when: data => hasHeartRateData(data.matched)
  },
  {
    key: 'hr_diff',
    className: 'col-diff',
    label: () => 'HR Diff',
    // Deliberately unshaded: a lower heart rate is only good news if the time
    // held up, so the colour would mislead as often as it helped.
    text: row => row.hr_diff || 'N/A',
    when: data => hasHeartRateData(data.matched)
  },
  {
    key: 'quality',
    className: 'col-quality',
    label: () => 'Form',
    headerTitle: () => 'What the time change means once heart rate is taken into account',
    build: buildQualityCell,
    text: row => (row.quality ? row.quality.label : 'N/A'),
    when: data => hasQualityData(data.matched)
  },
  {
    key: 'vam_1',
    className: 'col-vam',
    label: () => `VAM (${getDisplayName(1)})`,
    text: row => row.vam_1 || 'N/A',
    when: data => hasVamData(data.matched)
  },
  {
    key: 'vam_2',
    className: 'col-vam',
    label: () => `VAM (${getDisplayName(2)})`,
    text: row => row.vam_2 || 'N/A',
    when: data => hasVamData(data.matched)
  },
  {
    key: 'vam_diff',
    className: 'col-diff',
    label: () => 'VAM Diff',
    text: row => row.vam_diff || 'N/A',
    // Climbing faster is better; 200 m/h is a decisive gap.
    style: row => diffStyle(row.vam_diff_value, true, 200),
    mark: row => isImprovement(row.vam_diff_value, true),
    when: data => hasVamData(data.matched)
  },
  {
    key: 'pr_time',
    className: 'col-time',
    label: () => 'Your PR',
    text: row => row.pr_time || 'N/A',
    when: data => hasPersonalRecords(data.matched)
  },
  {
    key: 'pr_diff',
    className: 'col-diff',
    label: () => `vs PR (${getDisplayName(1)})`,
    text: row => row.pr_diff || 'N/A',
    style: row => diffStyle(row.pr_diff_seconds, false, 60),
    mark: row => isImprovement(row.pr_diff_seconds, false),
    when: data => hasPersonalRecords(data.matched)
  },
  {
    key: 'history',
    className: 'col-history',
    label: () => 'Your history',
    build: buildHistoryCell,
    // The CSV gets the rank, not the drawing.
    text: row => row.history_label || 'N/A',
    when: data => hasEffortHistory(data.matched)
  }
];

function visibleColumns(data) {
  return COLUMNS.filter(column => !column.when || column.when(data));
}

/** Clicking a header sorts by it; clicking the active header reverses it. */
const DEFAULT_SORT_DIRECTION = {
  name: 'asc',
  time_1: 'asc',
  time_2: 'asc',
  time_diff: 'desc',
  rate_1: 'desc',
  rate_2: 'desc',
  rate_diff: 'desc',
  power_1: 'desc',
  power_2: 'desc',
  power_diff: 'desc',
  hr_1: 'desc',
  hr_2: 'desc',
  hr_diff: 'desc',
  // Best reading first.
  quality: 'asc',
  vam_1: 'desc',
  vam_2: 'desc',
  vam_diff: 'desc',
  pr_time: 'asc',
  pr_diff: 'desc',
  // Rank 1 is your best, so the first click puts your best efforts on top.
  history: 'asc'
};

function toggleSort(key) {
  sortState =
    sortState.key === key
      ? { key, direction: sortState.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: DEFAULT_SORT_DIRECTION[key] || 'asc' };

  renderComparison(comparison);
}

function renderTableHead(columns) {
  const tr = document.createElement('tr');

  columns.forEach(column => {
    const th = document.createElement('th');
    if (column.className) th.className = column.className;
    th.textContent = column.label();
    // A column whose heading needs explaining says so; the rest get the hint
    // that they can be sorted.
    if (column.headerTitle) th.title = column.headerTitle();

    if (!isSortable(column.key)) {
      tr.appendChild(th);
      return;
    }

    const active = sortState.key === column.key;
    th.classList.add('sortable');
    th.tabIndex = 0;
    th.setAttribute('role', 'button');
    if (!column.headerTitle) th.title = `Sort by ${column.label()}`;
    th.setAttribute(
      'aria-sort',
      active ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none'
    );

    if (active) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = sortState.direction === 'asc' ? '▲' : '▼';
      th.appendChild(arrow);
    }

    th.addEventListener('click', () => toggleSort(column.key));
    th.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSort(column.key);
      }
    });

    tr.appendChild(th);
  });

  document.getElementById('segmentsTableHead').replaceChildren(tr);
}

/**
 * The rows the table shows: the matched list, narrowed by the filter and put
 * in the chosen order.
 *
 * The summary above the table is deliberately not narrowed — it describes the
 * ride, not the current search.
 */
function visibleRows(matched) {
  const filtered = filterSegments(matched, filterText);
  return sortState.key ? sortMatched(filtered, sortState.key, sortState.direction) : filtered;
}

function renderFilterCount(shown, total) {
  const filtering = Boolean(filterText) && total > 0;
  filterCount.classList.toggle('hidden', !filtering);
  filterCount.textContent = filtering ? `Showing ${shown} of ${total} segments` : '';
}

function renderComparison(data) {
  const columns = visibleColumns(data);
  const rows = visibleRows(data.matched);
  renderFilterCount(rows.length, data.matched.length);

  renderTableHead(columns);

  const tableBody = document.getElementById('segmentsTableBody');
  tableBody.replaceChildren();

  rows.forEach(row => {
    const tr = document.createElement('tr');

    columns.forEach(column => {
      const td = column.build ? column.build(row) : cell(column.text(row));
      if (!column.build) {
        if (column.style) td.style.cssText = column.style(row);
        if (column.mark) appendDirectionMark(td, column.mark(row));
      }
      tr.appendChild(td);
    });

    tableBody.appendChild(tr);
  });

  renderSummary(data);
  renderUnmatched(data);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

/** One "Segment name +1:12" chip, coloured by whether it was a gain or a loss. */
function summaryChip(row) {
  const chip = document.createElement('span');
  chip.className = `summary-chip ${row.time_diff_seconds > 0 ? 'summary-chip-loss' : 'summary-chip-gain'}`;

  const name = document.createElement('span');
  name.className = 'summary-chip-name';
  name.textContent = row.name;
  chip.appendChild(name);

  const delta = document.createElement('span');
  delta.className = 'summary-chip-delta';
  delta.textContent = row.time_diff;
  chip.appendChild(delta);

  return chip;
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 56;
const CHART_PADDING = 4;

/**
 * Where the gap opened up, as one bar per segment in course order.
 *
 * Each bar is the running total after that segment, so the shape answers a
 * question the net number cannot: whether the time went in one place or
 * everywhere. Above the zero line is behind, below is ahead — the same red and
 * green as the table, so the colour is reinforcement rather than the only clue.
 */
function buildDeltaChart(points) {
  if (points.length < 2) return null;

  const values = points.map(point => point.cumulative);
  // Zero is always in the domain, so the baseline is where it really is.
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;

  const usableWidth = CHART_WIDTH - CHART_PADDING * 2;
  const usableHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const y = value => CHART_PADDING + (usableHeight * (top - value)) / span;
  const slot = usableWidth / points.length;
  const barWidth = Math.max(1, slot - Math.min(2, slot * 0.25));

  const svg = svgElement('svg', {
    class: 'delta-chart',
    viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label':
      `Running time difference over ${points.length} segments, ` +
      `ending at ${formatTimeDiff(values[values.length - 1])}`
  });

  const zero = y(0);
  points.forEach((point, index) => {
    const value = point.cumulative;
    const height = Math.abs(y(value) - zero);

    const bar = svgElement('rect', {
      class: value > 0 ? 'delta-bar delta-bar-loss' : 'delta-bar delta-bar-gain',
      x: (CHART_PADDING + index * slot).toFixed(1),
      y: (value > 0 ? y(value) : zero).toFixed(1),
      width: barWidth.toFixed(1),
      // A segment that leaves the running total at zero still gets a hairline,
      // so the bar count matches the segment count.
      height: Math.max(0.5, height).toFixed(1)
    });

    const label = svgElement('title', {});
    label.textContent = `${point.name}: ${formatTimeDiff(value)} after this segment`;
    bar.appendChild(label);

    svg.appendChild(bar);
  });

  svg.appendChild(
    svgElement('line', {
      class: 'delta-zero',
      x1: CHART_PADDING,
      x2: CHART_WIDTH - CHART_PADDING,
      y1: zero.toFixed(1),
      y2: zero.toFixed(1)
    })
  );

  return svg;
}

/**
 * The choice between "every segment" and "no stretch of road counted twice".
 *
 * Offered only when some segment really does sit inside another, so a ride of
 * plain, separate segments never sees it.
 */
function nestedToggle(nestedCount) {
  const label = document.createElement('label');
  label.className = 'summary-toggle';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = excludeNested;
  checkbox.addEventListener('change', () => {
    excludeNested = checkbox.checked;
    renderComparison(comparison);
  });
  label.appendChild(checkbox);

  const text = document.createElement('span');
  text.textContent =
    `Leave out the ${nestedCount} segment${nestedCount === 1 ? '' : 's'} inside another segment`;
  label.appendChild(text);

  return label;
}

function summaryRow(title, rows) {
  if (!rows.length) return null;

  const line = document.createElement('div');
  line.className = 'summary-line';

  const label = document.createElement('span');
  label.className = 'summary-label';
  label.textContent = title;
  line.appendChild(label);

  rows.forEach(row => line.appendChild(summaryChip(row)));
  return line;
}

/**
 * The headline answer: how big the gap is and which segments produced it.
 *
 * Everything here is derived from the same deltas the table shows, so it needs
 * no extra data — it just puts the conclusion above the fold.
 */
function renderSummary(data) {
  const container = document.getElementById('summarySection');
  container.replaceChildren();

  if (!data.matched.length) return;

  const summary = summarizeComparison(data.matched, { excludeNested });
  if (!summary.compared) return;

  const panel = document.createElement('div');
  panel.className = 'summary-panel';

  // Deltas are activity 2 minus activity 1, so activity 2 is the subject.
  const slower = summary.netSeconds > 0;

  const headline = document.createElement('div');
  headline.className = 'summary-headline';

  const net = document.createElement('span');
  net.className = `summary-net ${slower ? 'summary-net-loss' : 'summary-net-gain'}`;
  net.textContent = summary.netText;
  headline.appendChild(net);

  const caption = document.createElement('span');
  caption.className = 'summary-caption';
  const direction = summary.netSeconds === 0 ? 'level with' : slower ? 'slower than' : 'faster than';
  caption.textContent =
    `${getDisplayName(2)} ${direction} ${getDisplayName(1)} across ` +
    `${summary.compared} matched segment${summary.compared === 1 ? '' : 's'}`;
  headline.appendChild(caption);
  panel.appendChild(headline);

  const counts = document.createElement('div');
  counts.className = 'summary-counts';
  counts.textContent =
    `Faster on ${summary.fasterCount}, slower on ${summary.slowerCount}` +
    (summary.evenCount ? `, level on ${summary.evenCount}` : '') +
    (summary.notComparable ? ` · ${summary.notComparable} not comparable` : '') +
    (excludeNested && summary.nestedCount ? ` · ${summary.nestedCount} nested left out` : '');
  panel.appendChild(counts);

  if (summary.nestedCount) panel.appendChild(nestedToggle(summary.nestedCount));

  const charted = excludeNested ? data.matched.filter(row => !row.nestedIn) : data.matched;
  const chart = buildDeltaChart(cumulativeTimeDeltas(charted));
  if (chart) {
    const figure = document.createElement('div');
    figure.className = 'delta-chart-figure';
    figure.appendChild(chart);

    const caption = document.createElement('div');
    caption.className = 'delta-chart-caption';
    caption.textContent = `Running total along the course · above the line, ${getDisplayName(2)} is behind`;
    figure.appendChild(caption);

    panel.appendChild(figure);
  }

  const losses = summaryRow('Biggest losses', summary.biggestLosses);
  if (losses) panel.appendChild(losses);

  const gains = summaryRow('Biggest gains', summary.biggestGains);
  if (gains) panel.appendChild(gains);

  const note = document.createElement('div');
  note.className = 'summary-note';
  note.textContent =
    'Net is the plain sum of per-segment deltas, so longer segments count for more' +
    (excludeNested
      ? '. Segments that sit inside another are left out, so no stretch of road is counted twice.'
      : ', and a segment inside another (a climb within a lap) counts in both.') +
    ' Click a column header to sort.';
  panel.appendChild(note);

  container.appendChild(panel);
}

/** Segments present in only one activity, so they are not silently dropped. */
function renderUnmatched(data) {
  document.getElementById('unmatchedSection')?.remove();
  if (!data.onlyIn1.length && !data.onlyIn2.length) return;

  const section = document.createElement('div');
  section.id = 'unmatchedSection';
  section.className = 'mt-3 text-xs text-gray-600';

  const addGroup = (segments, who) => {
    if (!segments.length) return;

    const details = document.createElement('details');
    details.className = 'mb-1';

    const summary = document.createElement('summary');
    summary.className = 'cursor-pointer font-semibold';
    summary.textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'} only in ${who}`;
    details.appendChild(summary);

    const list = document.createElement('ul');
    list.className = 'list-disc list-inside mt-1 ml-2';
    segments.forEach(segment => {
      const li = document.createElement('li');
      li.textContent = segment.name;
      list.appendChild(li);
    });
    details.appendChild(list);

    section.appendChild(details);
  };

  addGroup(data.onlyIn1, getDisplayName(1));
  addGroup(data.onlyIn2, getDisplayName(2));

  document.getElementById('unmatchedSlot').replaceChildren(section);
}

/** Side-by-side activity stats, aligned on a shared, ordered label set. */
function displayStatsComparison(stats1, stats2) {
  document.getElementById('activityStatsSection')?.remove();

  const normalizeForKey = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const cleanStatText = s =>
    (s || '')
      .replace(/\s+/g, ' ')
      .replace(/\bshow\s*(more|less)\b/gi, '')
      .replace(/…/g, '')
      .replace(/\s*\|\s*$/, '')
      .trim();

  const toMap = pairs => {
    const map = new Map();
    (pairs || []).forEach(({ label, value }) => {
      const key = normalizeForKey(label);
      if (key && !map.has(key)) {
        map.set(key, { label: cleanStatText(label), value: cleanStatText(value) });
      }
    });
    return map;
  };

  const map1 = toMap(stats1);
  const map2 = toMap(stats2);

  const orderedLabels = [];
  const seen = new Set();
  [...(stats1 || []), ...(stats2 || [])].forEach(({ label }) => {
    const key = normalizeForKey(label);
    if (key && !seen.has(key)) {
      seen.add(key);
      orderedLabels.push(key);
    }
  });

  if (!orderedLabels.length) return;

  const buildColumn = (title, map) => {
    const col = document.createElement('div');
    col.className = 'card';

    const heading = document.createElement('h3');
    heading.className = 'text-sm font-bold text-gray-700 mb-2';
    heading.textContent = title;
    col.appendChild(heading);

    const table = document.createElement('table');
    table.className = 'w-full text-sm';

    const tbody = document.createElement('tbody');
    orderedLabels.forEach(key => {
      const pair = map.get(key);
      if (!pair) return;

      const tr = document.createElement('tr');
      tr.className = 'border-t border-gray-100';

      tr.appendChild(cell(pair.label, 'py-1.5 pr-3 text-[11px] uppercase tracking-wide text-gray-500 align-baseline'));

      const valueCell = document.createElement('td');
      valueCell.className = 'py-1.5 pl-3 text-sm font-semibold text-gray-900 text-right align-baseline';
      const valueSpan = document.createElement('span');
      valueSpan.className = 'stat-value';
      valueSpan.textContent = pair.value;
      valueCell.appendChild(valueSpan);
      tr.appendChild(valueCell);

      tbody.appendChild(tr);
    });

    if (!tbody.children.length) {
      const tr = document.createElement('tr');
      tr.appendChild(cell('No activity stats found', 'py-2 text-xs text-gray-500 text-center'));
      tr.firstChild.colSpan = 2;
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    col.appendChild(table);
    return col;
  };

  const section = document.createElement('div');
  section.id = 'activityStatsSection';
  section.className = 'mb-4';

  const wrapper = document.createElement('div');
  wrapper.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';
  wrapper.appendChild(buildColumn(getDisplayName(1), map1));
  wrapper.appendChild(buildColumn(getDisplayName(2), map2));
  section.appendChild(wrapper);

  document.getElementById('activityStatsSlot').replaceChildren(section);
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function csvField(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportAsCSV() {
  if (!comparison.matched.length) {
    showStatus('No data to export', 'error');
    return;
  }

  // Same columns the table is showing, in the same order, sort and filter.
  const columns = visibleColumns(comparison);
  const rows = visibleRows(comparison.matched);

  const lines = [
    columns.map(column => csvField((column.csvLabel || column.label)())).join(',')
  ];

  rows.forEach(row => {
    lines.push(
      columns.map(column => csvField(column.csv ? column.csv(row) : column.text(row))).join(',')
    );
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'strava_segment_comparison.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
    addLogEntry('CSV export completed', 'success');
  }, 100);
}

/* ------------------------------------------------------------------ *
 * Status & logging
 * ------------------------------------------------------------------ */

function showStatus(message, type = 'info') {
  statusDiv.textContent = message;
  statusDiv.className = 'status-message';

  if (type === 'error') statusDiv.classList.add('status-error');
  else if (type === 'loading') statusDiv.classList.add('status-loading');
  else if (type === 'success') statusDiv.classList.add('status-success');

  statusDiv.classList.remove('hidden');
  addLogEntry(message, type);
}

function addLogEntry(message, type = 'info') {
  const now = new Date();
  const timestamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');

  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;

  const stamp = document.createElement('span');
  stamp.className = 'log-timestamp';
  stamp.textContent = `[${timestamp}]`;
  entry.appendChild(stamp);
  // Log text can include page-controlled strings, so never build it as HTML.
  entry.appendChild(document.createTextNode(` ${message}`));

  logContent.appendChild(entry);
  logContent.scrollTop = logContent.scrollHeight;

  logEntries.push({ timestamp, message, type });
  if (logEntries.length > 50) {
    logEntries.shift();
    if (logContent.firstChild) logContent.removeChild(logContent.firstChild);
  }
}
