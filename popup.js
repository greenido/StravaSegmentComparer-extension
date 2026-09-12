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
const helpBtn = document.getElementById('helpBtn');
const helpSection = document.getElementById('helpSection');

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

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  compareBtn.addEventListener('click', compareActivities);
  exportBtn.addEventListener('click', exportAsCSV);
  prBtn.addEventListener('click', loadPersonalRecords);
  autoDetectBtn.addEventListener('click', autoPopulateActivityUrls);

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
  autoPopulateActivityUrls();
}

async function clearResults() {
  await chrome.storage.local.remove('comparisonResults');

  comparison = { matched: [], onlyIn1: [], onlyIn2: [] };
  sortState = { key: null, direction: 'desc' };
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

async function autoPopulateActivityUrls() {
  try {
    addLogEntry('Searching for open Strava activity tabs...', 'info');
    showStatus('Scanning open tabs for Strava activities...', 'loading');

    const stravaActivityTabs = await findActivityTabs();
    addLogEntry(`Found ${stravaActivityTabs.length} open Strava activity tabs`, 'info');

    if (!stravaActivityTabs.length) {
      showStatus('❌ No open Strava activity tabs found - please navigate to Strava activities first', 'error');
      return;
    }

    activity1Input.value = stravaActivityTabs[0].url;
    addLogEntry(`Auto-populated Activity 1: ${extractActivityIdFromUrl(stravaActivityTabs[0].url)}`, 'success');

    if (stravaActivityTabs.length >= 2) {
      activity2Input.value = stravaActivityTabs[1].url;
      addLogEntry(`Auto-populated Activity 2: ${extractActivityIdFromUrl(stravaActivityTabs[1].url)}`, 'success');
      showStatus('✅ Auto-detected 2 Strava activities - ready to compare!', 'success');
    } else {
      showStatus('⚠️ Found 1 Strava activity - please open another activity tab or enter URL manually', 'info');
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
    showStatus(`Error scanning tabs: ${error.message}`, 'error');
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

/** Last resort: open the activity in a background tab and read it there. */
async function extractViaNewTab(activityId) {
  const tab = await chrome.tabs.create({
    url: `https://www.strava.com/activities/${activityId}`,
    active: false
  });
  addLogEntry(`Opened background tab ${tab.id} for activity ${activityId}`, 'info');

  try {
    if (!(await waitForContentScript(tab.id))) {
      throw new Error('Timed out waiting for the activity page to load');
    }

    return await extractFromTab(tab.id);
  } finally {
    // Always clean up, including on failure.
    await chrome.tabs.remove(tab.id).catch(() => {});
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

/** Any strava.com tab can act as the fetch proxy. */
async function findProxyTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://www.strava.com/*' });
  return tabs.length ? tabs[0].id : null;
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

  const tab = await chrome.tabs.create({ url: 'https://www.strava.com/dashboard', active: false });
  addLogEntry(`Opened background tab ${tab.id} to reach Strava`, 'info');

  try {
    if (!(await waitForContentScript(tab.id))) {
      throw new Error('Timed out waiting for Strava to load');
    }
    return await fn(tab.id);
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
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

    rateLabel = rateColumnLabel(activity1Data.segments);
    comparison = compareSegmentLists(activity1Data.segments, activity2Data.segments);
    // A fresh comparison starts in course order again.
    sortState = { key: null, direction: 'desc' };
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
 * Personal records
 *
 * Strava does not expose a PR endpoint we can call, so each segment's PR comes
 * from its own `/segments/{id}` page, fetched through a strava.com tab and
 * parsed there. That is one request per segment, so the work is capped, run at
 * a small concurrency, and cached for a day.
 * ------------------------------------------------------------------ */

const PR_CACHE_KEY = 'prCache';
const PR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PR_FETCH_CONCURRENCY = 3;
const PR_MAX_SEGMENTS = 60;
// Breathing room between requests, so a 60-segment ride is a steady trickle
// rather than a burst at Strava.
const PR_FETCH_SPACING_MS = 250;

/** Read the PR cache, dropping entries older than the TTL. */
async function readPrCache() {
  const data = await chrome.storage.local.get(PR_CACHE_KEY);
  const cached = data[PR_CACHE_KEY] || {};
  const fresh = {};

  Object.entries(cached).forEach(([segmentId, entry]) => {
    if (entry && Date.now() - (entry.fetchedAt || 0) < PR_CACHE_TTL_MS) {
      fresh[segmentId] = entry;
    }
  });

  return fresh;
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

  const segmentIds = [...new Set(comparison.matched.map(row => row.segmentId).filter(Boolean))];
  if (!segmentIds.length) {
    // Most likely a comparison saved by a version that could not read segment
    // ids; re-reading the activities fixes it.
    showStatus('No Strava segment ids in this comparison — click "Compare Activities" again, then retry', 'error');
    return;
  }

  const wanted = segmentIds.slice(0, PR_MAX_SEGMENTS);
  if (wanted.length < segmentIds.length) {
    addLogEntry(`Looking up the first ${PR_MAX_SEGMENTS} of ${segmentIds.length} segments`, 'warning');
  }

  prBtn.disabled = true;

  try {
    const cache = await readPrCache();
    const missing = wanted.filter(segmentId => !(segmentId in cache));
    addLogEntry(`${wanted.length - missing.length} PRs cached, ${missing.length} to fetch`, 'info');

    if (missing.length) {
      showStatus(`Fetching your PR for ${missing.length} segments...`, 'loading');

      const historyErrors = [];

      await withProxyTab(async tabId => {
        let done = 0;

        await mapWithLimit(missing, PR_FETCH_CONCURRENCY, async segmentId => {
          try {
            const response = unwrap(
              await chrome.tabs.sendMessage(tabId, { action: 'fetchSegmentPr', segmentId })
            );
            if (response.historyError) historyErrors.push(response.historyError);
            cache[segmentId] = { pr: response.pr || null, fetchedAt: Date.now() };
          } catch (error) {
            // Cache the miss too, so one bad segment is not retried on every click.
            addLogEntry(`Segment ${segmentId}: ${error.message}`, 'warning');
            cache[segmentId] = { pr: null, fetchedAt: Date.now() };
          }

          done += 1;
          if (done % 5 === 0 || done === missing.length) {
            showStatus(`Fetched ${done}/${missing.length} personal records...`, 'loading');
          }
          if (done < missing.length) await delay(PR_FETCH_SPACING_MS);
        });
      });

      // One line, not one per segment: it is almost always the same reason.
      if (historyErrors.length) {
        addLogEntry(
          `Effort history unavailable for ${historyErrors.length} segment(s) (${historyErrors[0]}), ` +
            'read their segment pages instead',
          'warning'
        );
      }

      await chrome.storage.local.set({ [PR_CACHE_KEY]: cache });
    }

    const prBySegmentId = {};
    Object.entries(cache).forEach(([segmentId, entry]) => {
      if (entry.pr) prBySegmentId[segmentId] = entry.pr;
    });

    comparison = {
      ...comparison,
      matched: applyPersonalRecords(comparison.matched, prBySegmentId)
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
 * Rendering
 * ------------------------------------------------------------------ */

function getDisplayName(index) {
  const name = index === 1 ? athlete1Name : athlete2Name;
  return name && name.trim() ? name.trim() : `Activity ${index}`;
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
  if (delta === null || delta === undefined || Number.isNaN(delta) || delta === 0) return '';

  const faster = positiveIsFaster ? delta > 0 : delta < 0;
  const alpha = Math.min(0.85, Math.abs(delta) / scale);
  return faster
    ? `background-color: rgba(34, 197, 94, ${alpha.toFixed(2)});`
    : `background-color: rgba(220, 38, 38, ${alpha.toFixed(2)});`;
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
    style: row => diffStyle(row.time_diff_seconds, false, 60)
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
      diffStyle(row.rate_diff_value, row.rate_positive_is_faster, row.rate_positive_is_faster ? 5 : 30)
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
    when: data => hasPersonalRecords(data.matched)
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
  vam_1: 'desc',
  vam_2: 'desc',
  vam_diff: 'desc',
  pr_time: 'asc',
  pr_diff: 'desc'
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

    if (!isSortable(column.key)) {
      tr.appendChild(th);
      return;
    }

    const active = sortState.key === column.key;
    th.classList.add('sortable');
    th.tabIndex = 0;
    th.setAttribute('role', 'button');
    th.title = `Sort by ${column.label()}`;
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

function renderComparison(data) {
  const columns = visibleColumns(data);
  const rows = sortState.key
    ? sortMatched(data.matched, sortState.key, sortState.direction)
    : data.matched;

  renderTableHead(columns);

  const tableBody = document.getElementById('segmentsTableBody');
  tableBody.replaceChildren();

  rows.forEach(row => {
    const tr = document.createElement('tr');

    columns.forEach(column => {
      const td = column.build ? column.build(row) : cell(column.text(row));
      if (!column.build && column.style) td.style.cssText = column.style(row);
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

  const summary = summarizeComparison(data.matched);
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
    (summary.compared < summary.total ? ` · ${summary.total - summary.compared} not comparable` : '');
  panel.appendChild(counts);

  const losses = summaryRow('Biggest losses', summary.biggestLosses);
  if (losses) panel.appendChild(losses);

  const gains = summaryRow('Biggest gains', summary.biggestGains);
  if (gains) panel.appendChild(gains);

  const note = document.createElement('div');
  note.className = 'summary-note';
  note.textContent =
    'Net is the plain sum of per-segment deltas, so longer segments count for more, and a segment ' +
    'inside another (a climb within a lap) counts in both. Click a column header to sort.';
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

  document.getElementById('segmentsTable').parentElement.insertAdjacentElement('afterend', section);
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

  const segmentsTable = document.getElementById('segmentsTable');
  segmentsTable.parentElement.insertAdjacentElement('afterend', section);
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

  // Same columns the table is showing, in the same order and sort.
  const columns = visibleColumns(comparison);
  const rows = sortState.key
    ? sortMatched(comparison.matched, sortState.key, sortState.direction)
    : comparison.matched;

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
