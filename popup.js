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
const logContent = document.getElementById('logContent');
const clearBtn = document.getElementById('clearBtn');
const autoDetectBtn = document.getElementById('autoDetectBtn');
const helpBtn = document.getElementById('helpBtn');
const helpSection = document.getElementById('helpSection');

let logEntries = [];

// Current comparison, kept for CSV export.
let comparison = { matched: [], onlyIn1: [], onlyIn2: [] };
let athlete1Name = null;
let athlete2Name = null;
let rateLabel = 'Speed';

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  compareBtn.addEventListener('click', compareActivities);
  exportBtn.addEventListener('click', exportAsCSV);
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
    addLogEntry('Restored the previous comparison', 'info');
    renderComparison(comparison);
    if (saved.stats1 || saved.stats2) {
      displayStatsComparison(saved.stats1 || [], saved.stats2 || []);
    }
    resultsDiv.classList.remove('hidden');
  }

  // Open tabs win over saved URLs.
  autoPopulateActivityUrls();
}

async function clearResults() {
  await chrome.storage.local.remove('comparisonResults');

  comparison = { matched: [], onlyIn1: [], onlyIn2: [] };
  document.getElementById('segmentsTableBody').replaceChildren();
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

/** Last resort: open the activity in a background tab and read it there. */
async function extractViaNewTab(activityId) {
  const tab = await chrome.tabs.create({
    url: `https://www.strava.com/activities/${activityId}`,
    active: false
  });
  addLogEntry(`Opened background tab ${tab.id} for activity ${activityId}`, 'info');

  try {
    const deadline = Date.now() + TAB_READY_TIMEOUT_MS;
    let ready = false;

    // Poll until the content script is injected and answering.
    while (!ready && Date.now() < deadline) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
        ready = true;
      } catch (_) {
        await delay(PING_INTERVAL_MS);
      }
    }

    if (!ready) {
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

    if (!comparison.matched.length) {
      showStatus('No segments in common between these two activities', 'error');
    } else {
      showStatus(`Successfully compared ${comparison.matched.length} segments`, 'success');
    }

    renderComparison(comparison);
    displayStatsComparison(activity1Data.activityStats, activity2Data.activityStats);
    resultsDiv.classList.remove('hidden');

    await chrome.storage.local.set({
      comparisonResults: {
        matched: comparison.matched,
        onlyIn1: comparison.onlyIn1,
        onlyIn2: comparison.onlyIn2,
        rateLabel,
        stats1: activity1Data.activityStats,
        stats2: activity2Data.activityStats
      }
    });
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    compareBtn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function getDisplayName(index) {
  const name = index === 1 ? athlete1Name : athlete2Name;
  return name && name.trim() ? name.trim() : `Activity ${index}`;
}

function updateTableHeaders() {
  const table = document.getElementById('segmentsTable');
  if (!table) return;

  const timeHeaders = table.querySelectorAll('thead th.col-time');
  const rateHeaders = table.querySelectorAll('thead th.col-speed');
  const rateDiffHeader = table.querySelector('thead th.col-rate-diff');

  if (timeHeaders.length >= 2) {
    timeHeaders[0].textContent = `Time (${getDisplayName(1)})`;
    timeHeaders[1].textContent = `Time (${getDisplayName(2)})`;
  }
  if (rateHeaders.length >= 2) {
    rateHeaders[0].textContent = `${rateLabel} (${getDisplayName(1)})`;
    rateHeaders[1].textContent = `${rateLabel} (${getDisplayName(2)})`;
  }
  if (rateDiffHeader) {
    rateDiffHeader.textContent = `${rateLabel} Diff`;
  }
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

function renderComparison(data) {
  const tableBody = document.getElementById('segmentsTableBody');
  tableBody.replaceChildren();

  data.matched.forEach(row => {
    const tr = document.createElement('tr');

    const nameCell = document.createElement('td');
    const href = safeStravaLink(row.link);
    if (href) {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'text-blue-500 hover:underline';
      link.textContent = row.name;
      nameCell.appendChild(link);
    } else {
      nameCell.textContent = row.name;
    }
    tr.appendChild(nameCell);

    tr.appendChild(cell(row.time_1));
    tr.appendChild(cell(row.time_2));

    const timeDiffCell = cell(row.time_diff);
    // 60s of difference reaches full tint.
    timeDiffCell.style.cssText = diffStyle(row.time_diff_seconds, false, 60);
    tr.appendChild(timeDiffCell);

    tr.appendChild(cell(row.rate_1));
    tr.appendChild(cell(row.rate_2));

    const rateDiffCell = cell(row.rate_diff);
    // Speeds saturate at 5 km/h, paces at 30 s/km.
    const rateScale = row.rate_positive_is_faster ? 5 : 30;
    rateDiffCell.style.cssText = diffStyle(row.rate_diff_value, row.rate_positive_is_faster, rateScale);
    tr.appendChild(rateDiffCell);

    tableBody.appendChild(tr);
  });

  updateTableHeaders();
  renderUnmatched(data);
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

  const headers = [
    'Segment Name',
    `Time (${getDisplayName(1)})`,
    `Time (${getDisplayName(2)})`,
    'Time Difference',
    `${rateLabel} (${getDisplayName(1)})`,
    `${rateLabel} (${getDisplayName(2)})`,
    `${rateLabel} Difference`
  ];

  const lines = [headers.map(csvField).join(',')];
  comparison.matched.forEach(row => {
    lines.push([
      row.name,
      row.time_1,
      row.time_2,
      row.time_diff,
      row.rate_1,
      row.rate_2,
      row.rate_diff
    ].map(csvField).join(','));
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
