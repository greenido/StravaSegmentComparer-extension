/**
 * Strava activity extraction.
 *
 * Every function here takes an explicit `doc` so the same code can run against
 * the live page (content script) or against a Document produced by DOMParser
 * from fetched HTML (popup). Nothing in this file may touch `window` or the
 * global `document`.
 */

// Extract the numeric activity id from an activity URL.
function extractActivityId(url) {
  const match = (url || '').match(/activities\/(\d+)/);
  return match ? match[1] : null;
}

// Athlete name, with fallbacks for the different markup Strava serves.
function extractAthleteName(doc) {
  try {
    // Specific anchor form: <a class="minimal" href="/athletes/{id}">Name</a>
    const minimalAthleteEl = doc.querySelector('a.minimal[href^="/athletes/"]');
    if (minimalAthleteEl && minimalAthleteEl.textContent.trim()) {
      return minimalAthleteEl.textContent.trim();
    }

    // Explicit testid used in some Strava builds
    const ownerNameEl = doc.querySelector('[data-testid="owner-name"]');
    if (ownerNameEl && ownerNameEl.textContent.trim()) {
      return ownerNameEl.textContent.trim();
    }

    // First link to an athlete profile
    const athleteLinkEl = doc.querySelector('a[href^="/athletes/"]');
    if (athleteLinkEl && athleteLinkEl.textContent.trim()) {
      return athleteLinkEl.textContent.trim();
    }

    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle) {
      if (ogTitle.includes(' - ')) {
        const [left, right] = ogTitle.split(' - ');
        if (left && left.trim().split(' ').length >= 2) return left.trim();
        if (right && right.trim().split(' ').length >= 2) return right.trim();
      }
      if (ogTitle.includes(' | ')) {
        const [left, right] = ogTitle.split(' | ');
        if (right && right.trim().split(' ').length >= 2) return right.trim();
        if (left && left.trim().split(' ').length >= 2) return left.trim();
      }
    }

    const ogDesc = doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
    if (ogDesc) {
      const byMatch = ogDesc.match(/by\s+([^|–-]+?)\s+on\s+Strava/i);
      if (byMatch && byMatch[1]) return byMatch[1].trim();

      const verbMatch = ogDesc.match(/^([\p{L}\s.'-]{3,})\s+(ran|rode|walked|hiked|skied|swam)/iu);
      if (verbMatch && verbMatch[1]) return verbMatch[1].trim();
    }
  } catch (_) {
    // Ignore parsing errors and fall through
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Activity stats
 * ------------------------------------------------------------------ */

const STAT_LABEL_KEYWORDS = [
  'distance', 'moving time', 'elapsed time', 'estimated avg power', 'weighted avg power',
  'avg power', 'energy output', 'calories', 'temperature', 'humidity', 'feels like',
  'wind speed', 'wind direction', 'heart rate', 'cadence', 'power', 'avg speed',
  'max speed', 'elevation', 'pace', 'device', 'bike', 'gear', 'shoes'
];

const VALUE_PATTERNS = [
  /^\d{1,2}:\d{2}(?::\d{2})?$/,                                                   // 4:26:05 / 26:05
  /^[-+]?\d[\d.,\s]*\s*(km|mi|m|ft|W|kJ|bpm|rpm|%|°C|℃|°F|km\/h|mph)$/i,           // 126 W, 56.78 km
  /^[NSEW]{1,3}$/i,                                                                // wind direction
  /^[-+]?\d[\d.,]*$/,                                                              // bare number
  /^(Cloudy|Sunny|Rainy|Windy|Clear|Overcast|Snowy|Hazy|Partly Cloudy)$/i
];

// A "value first, label second" run of text, e.g. "56.78 km Distance".
const VALUE_LABEL_PATTERNS = [
  /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/,
  /^([-+]?\d[\d.,\s]*\s*(?:km|mi|m|ft|W|kJ|bpm|rpm|%|°C|℃|°F|km\/h|mph))\s+(.+)$/i,
  /^([NSEW]{1,3})\s+(.+)$/i
];

function normalizeLabel(label) {
  return (label || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isLikelyValue(text) {
  const t = (text || '').trim();
  return t ? VALUE_PATTERNS.some(re => re.test(t)) : false;
}

function isLikelyLabel(text) {
  const t = (text || '').trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  if (STAT_LABEL_KEYWORDS.some(k => lower.includes(k))) return true;
  // Labels are otherwise multi-word alphabetic phrases
  return /^[A-Za-z][A-Za-z\s%°/+-]*$/.test(t) && /[a-zA-Z]{3,}/.test(t);
}

/**
 * Extract activity-level stats from the `.section.more-stats` block.
 *
 * Strategy: read structured markup first (tables, definition lists, explicit
 * label/value pairs). Only if a container yields nothing structured do we fall
 * back to text heuristics, and that fallback is limited to leaf elements so it
 * does not re-read the same text once per ancestor.
 */
function extractActivityStats(doc) {
  const results = [];
  const containers = Array.from(doc.querySelectorAll('.section.more-stats'));
  if (!containers.length) return results;

  const seenLabels = new Set();

  function pushIfNew(label, value) {
    let l = (label || '').replace(/\s+/g, ' ').trim();
    let v = (value || '').replace(/\s+/g, ' ').trim();

    // The two sides arrive in an inconsistent order depending on markup.
    if (isLikelyValue(l) && isLikelyLabel(v)) {
      [l, v] = [v, l];
    }

    const normalized = normalizeLabel(l);
    if (!normalized || !v || seenLabels.has(normalized)) return;
    seenLabels.add(normalized);
    results.push({ label: l, value: v });
  }

  containers.forEach(container => {
    const before = results.length;

    // 1) Two-column tables
    container.querySelectorAll('tr').forEach(tr => {
      const cells = tr.querySelectorAll('th, td');
      if (cells.length >= 2) pushIfNew(cells[0].textContent, cells[1].textContent);
    });

    // 2) Definition lists
    container.querySelectorAll('dl').forEach(dl => {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      const count = Math.min(dts.length, dds.length);
      for (let i = 0; i < count; i++) pushIfNew(dts[i].textContent, dds[i].textContent);
    });

    // 3) Explicit label/value elements
    container.querySelectorAll('[class*="stat" i]').forEach(block => {
      const labelEl = block.querySelector('[class*="label" i], [data-testid*="label" i]');
      const valueEl = block.querySelector('[class*="value" i], [data-testid*="value" i]');
      if (labelEl && valueEl) pushIfNew(labelEl.textContent, valueEl.textContent);
    });

    if (results.length > before) return;

    // 4) Text fallback, leaf elements only.
    container.querySelectorAll('li, div, span, p').forEach(el => {
      if (el.querySelector('li, div, span, p')) return; // not a leaf, skip
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) return;

      const colonIdx = text.indexOf(':');
      // Guard against times ("4:26:05") being read as "label: value".
      if (colonIdx > 0 && colonIdx < text.length - 1 && !/^\d{1,2}:\d{2}/.test(text)) {
        pushIfNew(text.slice(0, colonIdx), text.slice(colonIdx + 1));
        return;
      }

      const spaced = text.match(/^([\p{L}\d .,'%°/+-]+?)\s{2,}(.+)/u);
      if (spaced) {
        pushIfNew(spaced[1], spaced[2]);
        return;
      }

      for (const re of VALUE_LABEL_PATTERNS) {
        const m = text.match(re);
        if (m) {
          pushIfNew(m[2], m[1]);
          return;
        }
      }
    });
  });

  return results;
}

/* ------------------------------------------------------------------ *
 * Segments
 * ------------------------------------------------------------------ */

function findSegmentRows(doc) {
  const containerSelectors = ['table.segments', '.segments-list', '.segments table', '.segment-efforts'];
  let container = null;
  for (const selector of containerSelectors) {
    const el = doc.querySelector(selector);
    if (el) {
      container = el;
      break;
    }
  }

  const rowSelectors = ['tbody tr', 'tr.segment-effort', '.segment-row'];
  if (container) {
    for (const selector of rowSelectors) {
      const rows = container.querySelectorAll(selector);
      if (rows.length) return rows;
    }
  }

  return doc.querySelectorAll('[data-testid="segment-effort-row"]');
}

function firstMatch(row, selectors) {
  for (const selector of selectors) {
    const el = row.querySelector(selector);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return null;
}

// Find a cell whose text matches `re`, for markup where classes tell us nothing.
function cellMatching(row, re, selector = 'td') {
  for (const cell of row.querySelectorAll(selector)) {
    const text = cell.textContent.trim();
    if (re.test(text)) return text;
  }
  return null;
}

// Parse the JSON object that opens at `start`, found by matching braces
// outside of strings. Returns null if there is no complete, valid object.
function jsonObjectAt(text, start) {
  if (text[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

/**
 * Map each segment effort id on the page to its segment id.
 *
 * Strava's segment rows carry only `data-segment-effort-id`. The segment id is
 * in the inline script that seeds the page's efforts collection:
 *
 *   pageView.segmentEfforts().reset({"efforts":[{"id":"…","segment_id":123,…}],
 *                                    "hidden_efforts":[…]}, { parse: true });
 *
 * A DOMParser document never runs its scripts, but their text is still there,
 * so this works on fetched HTML as well as on the live page.
 */
function extractSegmentIdsByEffortId(doc) {
  const ids = new Map();

  for (const script of doc.querySelectorAll('script:not([src])')) {
    const text = script.textContent || '';
    const call = /segmentEfforts\(\)\.reset\(\s*/.exec(text);
    if (!call) continue;

    const data = jsonObjectAt(text, call.index + call[0].length);
    if (!data) continue;

    [...(data.efforts || []), ...(data.hidden_efforts || [])].forEach(effort => {
      if (effort && effort.id != null && effort.segment_id != null) {
        ids.set(String(effort.id), String(effort.segment_id));
      }
    });
  }

  return ids;
}

/**
 * Extract one segment effort per row.
 *
 * `segmentId` (the segment itself) is what identifies a segment across two
 * activities; `effortId` is unique per activity and only used to build links.
 */
function extractSegments(doc, activityId) {
  const rows = findSegmentRows(doc);
  if (!rows.length) return [];

  const segmentIdsByEffortId = extractSegmentIdsByEffortId(doc);
  const segments = [];
  const occurrences = new Map();

  rows.forEach((row, index) => {
    try {
      const effortId = row.getAttribute('data-segment-effort-id');

      // Only a link to the segment itself counts: /activities/{a}/segments/{n}
      // is an effort page, and its number is an effort id.
      const segmentHref =
        row
          .querySelector('a[href^="/segments/"], a[href^="https://www.strava.com/segments/"]')
          ?.getAttribute('href') || '';
      const segmentId =
        (effortId && segmentIdsByEffortId.get(effortId)) ||
        (segmentHref.match(/\/segments\/(\d+)/) || [])[1] ||
        null;

      const name =
        firstMatch(row, ['.name', '.segment-name', '[data-testid="segment-name"]', 'a']) ||
        `Segment ${index + 1}`;

      // Rows with neither an id nor a usable name are chrome, not data.
      if (!segmentId && !effortId) return;

      const time =
        firstMatch(row, ['.time', '.segment-time', '.time-col']) ||
        cellMatching(row, /^\d{1,2}:\d{2}(:\d{2})?$/) ||
        null;

      const speedOrPace =
        firstMatch(row, ['.speeds .text-nowrap', '.speed', '[data-testid="segment-speed"]', '.pace']) ||
        cellMatching(row, /(km\/h|mph|\/\s*(km|mi))/i) ||
        null;

      const link = effortId
        ? `https://www.strava.com/activities/${activityId}/segments/${effortId}`
        : `https://www.strava.com/segments/${segmentId}`;

      // Same segment ridden twice in one activity gets occurrence 0, 1, ...
      const key = segmentId || name;
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);

      segments.push({
        segmentId,
        effortId,
        occurrence,
        name,
        link,
        time,
        rate: speedOrPace,
        // Distance falls back to km/mi only: elevation is the other m/ft
        // value in the same row and would otherwise be picked up here. On
        // Strava's page it sits in the stats line under the segment name,
        // whose labels are localized, so the value is matched by its unit.
        distance:
          firstMatch(row, ['.distance', '[data-testid="segment-distance"]']) ||
          cellMatching(row, /^\d+(?:[.,]\d+)?\s*(km|mi)$/i, 'td, .stats span') ||
          null,
        power:
          firstMatch(row, ['.power', '[data-testid="segment-power"]']) ||
          cellMatching(row, /^\d+(?:[.,]\d+)?\s*W$/i) ||
          null,
        index
      });
    } catch (_) {
      // A malformed row should not abort the whole activity.
    }
  });

  return segments;
}

/**
 * Full activity payload. Throws if the page has no segments section at all,
 * so callers can distinguish "not loaded yet" from "genuinely zero segments".
 */
function extractActivityData(doc, url) {
  const activityId = extractActivityId(url) || 'unknown';
  const segments = extractSegments(doc, activityId);

  if (!segments.length) {
    throw new Error('No segments found on this activity');
  }

  return {
    title: (doc.title || '').trim(),
    url,
    activityId,
    athleteName: extractAthleteName(doc),
    activityStats: extractActivityStats(doc),
    segments,
    extractionTime: new Date().toISOString()
  };
}

// Cheap readiness probe used while waiting for a background tab to render.
function hasSegments(doc) {
  return findSegmentRows(doc).length > 0;
}

/* ------------------------------------------------------------------ *
 * Personal records
 * ------------------------------------------------------------------ */

// Self-contained: extractor.js runs in the content script, where utils.js is
// not loaded, so it cannot borrow the parsing helpers from there.
const TIME_TEXT_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/;
const PR_LABEL_RE = /\b(pr|personal record|my best|your best|best time)\b/i;

function timeIn(el) {
  if (!el) return null;
  const match = (el.textContent || '').replace(/\s+/g, ' ').match(TIME_TEXT_RE);
  return match ? match[1] : null;
}

/**
 * Find the signed-in athlete's personal record on a `/segments/{id}` page.
 *
 * Strava's markup for this panel has changed repeatedly and differs between
 * the logged-in and logged-out views, so this tries several shapes in
 * decreasing order of confidence and returns null rather than guessing. A null
 * means "unknown", which the UI renders as N/A — it never means "no PR".
 *
 * @returns {{time: string}|null}
 */
function extractSegmentPersonalRecord(doc) {
  try {
    // 1) Explicitly marked-up PR value.
    const explicit = [
      '[data-testid="personal-record-time"]',
      '[data-testid="pr-time"]',
      '.personal-record .time',
      '.personal-record time',
      '.pr-time'
    ];
    for (const selector of explicit) {
      const time = timeIn(doc.querySelector(selector));
      if (time) return { time };
    }

    // 2) A label/value pair (table row or definition list) labelled as the PR.
    const pairs = Array.from(doc.querySelectorAll('tr, dl > div, li'));
    for (const pair of pairs) {
      const cells = pair.querySelectorAll('th, td, dt, dd, span, strong');
      if (cells.length < 2) continue;

      const labelText = (cells[0].textContent || '').trim();
      if (!PR_LABEL_RE.test(labelText)) continue;

      for (let i = 1; i < cells.length; i++) {
        const time = timeIn(cells[i]);
        if (time) return { time };
      }
    }

    // 3) Leaf text that carries both the label and the time, e.g. "PR 12:34".
    for (const el of doc.querySelectorAll('li, div, span, p, td, dd')) {
      if (el.querySelector('li, div, span, p, td, dd')) continue; // leaves only
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60 || !PR_LABEL_RE.test(text)) continue;

      const match = text.match(TIME_TEXT_RE);
      if (match) return { time: match[1] };
    }
  } catch (_) {
    // A markup change should degrade to "unknown", not break the comparison.
  }

  return null;
}

function clockTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * The signed-in athlete's PR from `GET /athlete/segments/{id}/history`, which
 * lists their efforts on the segment with `elapsed_time` in whole seconds.
 * Strava ranks efforts by elapsed time, so the PR is simply the fastest one.
 *
 * @returns {{time: string}|null} null when there is no usable effort
 */
function personalRecordFromHistory(history) {
  const times = ((history && history.efforts) || [])
    .map(effort => effort && effort.elapsed_time)
    .filter(time => Number.isInteger(time) && time > 0);

  return times.length ? { time: clockTime(Math.min(...times)) } : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractActivityId,
    extractAthleteName,
    extractActivityStats,
    extractSegments,
    extractActivityData,
    extractSegmentPersonalRecord,
    personalRecordFromHistory,
    hasSegments
  };
}
