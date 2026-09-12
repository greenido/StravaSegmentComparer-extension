/**
 * Pure helpers for Strava Segment Comparator.
 *
 * Nothing here touches the DOM or chrome APIs, so it is unit-testable
 * (see tests/utils.test.js) and shared by the popup and the extractor.
 */

const KM_PER_MILE = 1.609344;
const METRES_PER_MILE = 1609.344;

/**
 * Parse a time string to seconds.
 * Accepts "h:mm:ss", "mm:ss", "45s", "45".
 * @returns {number|null} seconds, or null if unparseable
 */
function parseTimeToSeconds(timeStr) {
  if (timeStr === null || timeStr === undefined) return null;

  const raw = String(timeStr).trim();
  if (!raw || raw === 'N/A' || raw === '-') return null;

  // Bare seconds, with or without a trailing "s"
  const bareSeconds = raw.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (bareSeconds) return parseFloat(bareSeconds[1]);

  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every(p => /^\d+(\.\d+)?$/.test(p.trim()))) return null;

  const nums = parts.map(p => parseFloat(p.trim()));
  return nums.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1];
}

/**
 * Format a signed second count as "+m:ss" / "-h:mm:ss".
 */
function formatTimeDiff(diffSeconds) {
  if (diffSeconds === null || diffSeconds === undefined || Number.isNaN(diffSeconds)) return 'N/A';

  const rounded = Math.round(diffSeconds);
  if (rounded === 0) return '0:00';

  const sign = rounded > 0 ? '+' : '-';
  const abs = Math.abs(rounded);
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const seconds = abs % 60;

  return hours > 0
    ? `${sign}${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${sign}${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatSecondsToTime(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return 'N/A';

  const abs = Math.floor(Math.abs(seconds));
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parse the segment "rate" cell, which is a speed for rides and a pace for runs.
 *
 * Returns a normalized descriptor so two activities recorded in different units
 * can still be compared:
 *   speed -> { kind: 'speed', unit: 'km/h'|'mph', value, kmh }
 *   pace  -> { kind: 'pace',  unit: '/km'|'/mi',  value (sec per unit), secPerKm }
 * @returns {object|null} null when the cell is missing or unrecognized
 */
function parseRate(rateStr) {
  if (!rateStr) return null;

  const raw = String(rateStr).replace(/\s+/g, ' ').trim();
  if (!raw || raw === 'N/A' || raw === '-') return null;

  // Pace: "5:32 /km", "8:54/mi", "5:32 min/km"
  const pace = raw.match(/^(\d{1,3}):(\d{2})\s*(?:min)?\s*\/\s*(km|mi|mile)\b/i);
  if (pace) {
    const value = parseInt(pace[1], 10) * 60 + parseInt(pace[2], 10);
    const perMile = /^mi/i.test(pace[3]);
    return {
      kind: 'pace',
      unit: perMile ? '/mi' : '/km',
      value,
      secPerKm: perMile ? value / KM_PER_MILE : value,
      raw
    };
  }

  // Speed: "29.3 km/h", "18.2 mph"
  const speed = raw.match(/(-?\d+(?:[.,]\d+)?)\s*(km\/h|kph|mph|mi\/h)\b/i);
  if (speed) {
    const value = parseFloat(speed[1].replace(',', '.'));
    const isMph = /^(mph|mi\/h)$/i.test(speed[2]);
    return {
      kind: 'speed',
      unit: isMph ? 'mph' : 'km/h',
      value,
      kmh: isMph ? value * KM_PER_MILE : value,
      raw
    };
  }

  // Bare number with no unit: assume km/h, but say so via `assumedUnit`.
  const bare = raw.match(/^(-?\d+(?:[.,]\d+)?)$/);
  if (bare) {
    const value = parseFloat(bare[1].replace(',', '.'));
    return { kind: 'speed', unit: 'km/h', value, kmh: value, assumedUnit: true, raw };
  }

  return null;
}

/**
 * Compare two rate cells, reporting the delta in activity 1's unit.
 *
 * `positiveIsFaster` tells the UI which direction to colour green: a speed
 * gain is faster, a pace increase is slower.
 * @returns {{text: string, delta: number, positiveIsFaster: boolean}|null}
 */
function compareRates(rate1, rate2) {
  const r1 = parseRate(rate1);
  const r2 = parseRate(rate2);
  if (!r1 || !r2 || r1.kind !== r2.kind) return null;

  if (r1.kind === 'speed') {
    // Express activity 2 in activity 1's unit before subtracting.
    const v2 = r1.unit === 'mph' ? r2.kmh / KM_PER_MILE : r2.kmh;
    const delta = v2 - r1.value;
    const sign = delta > 0 ? '+' : '';
    return {
      text: `${sign}${delta.toFixed(1)} ${r1.unit}`,
      delta,
      positiveIsFaster: true
    };
  }

  const v2 = r1.unit === '/mi' ? r2.secPerKm * KM_PER_MILE : r2.secPerKm;
  const delta = v2 - r1.value;
  return {
    text: `${formatTimeDiff(delta)} ${r1.unit}`,
    delta,
    positiveIsFaster: false
  };
}

/**
 * Parse a segment power cell ("241 W", "241w", "241 watts") to watts.
 * @returns {number|null}
 */
function parsePower(powerStr) {
  if (!powerStr) return null;

  const raw = String(powerStr).replace(/\s+/g, ' ').trim();
  if (!raw || raw === 'N/A' || raw === '-') return null;

  const match = raw.match(/(-?\d+(?:[.,]\d+)?)\s*(?:w|watts?)\b/i);
  return match ? parseFloat(match[1].replace(',', '.')) : null;
}

/**
 * Parse a segment distance cell ("1.24 km", "0.8 mi", "450 m") to metres, so
 * distances recorded in different unit systems stay comparable.
 * @returns {number|null}
 */
function parseDistance(distanceStr) {
  if (!distanceStr) return null;

  const raw = String(distanceStr).replace(/\s+/g, ' ').trim();
  if (!raw || raw === 'N/A' || raw === '-') return null;

  const match = raw.match(/(-?\d+(?:[.,]\d+)?)\s*(km|mi|miles?|m|ft)\b/i);
  if (!match) return null;

  const value = parseFloat(match[1].replace(',', '.'));
  switch (match[2].toLowerCase()) {
    case 'km': return value * 1000;
    case 'm': return value;
    case 'ft': return value * 0.3048;
    default: return value * METRES_PER_MILE;
  }
}

/** Format a signed delta as "+12 W" / "-8 bpm", rounded to whole units. */
function formatSignedDiff(delta, unit) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'N/A';

  const rounded = Math.round(delta);
  if (rounded === 0) return `0 ${unit}`;
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded)} ${unit}`;
}

/** Format a signed watt delta as "+12 W" / "-8 W". */
function formatPowerDiff(diffWatts) {
  return formatSignedDiff(diffWatts, 'W');
}

/**
 * Parse a segment heart-rate cell ("121 bpm", "121bpm") to beats per minute.
 * @returns {number|null}
 */
function parseHeartRate(hrStr) {
  if (!hrStr) return null;
  const match = String(hrStr).match(/(\d+(?:[.,]\d+)?)\s*bpm\b/i);
  return match ? parseFloat(match[1].replace(',', '.')) : null;
}

// Below this average grade VAM says nothing useful, so it is left out.
const VAM_MIN_GRADE = 3;

/**
 * VAM: metres climbed per hour, as distance × average grade ÷ time.
 *
 * Strava only fills in its own `vam` for categorized climbs, so it is computed
 * here, the same way for both activities. On one segment the climb is fixed,
 * so VAM moves only with time — it is the time comparison in climbing units.
 * @returns {number|null} metres per hour
 */
function computeVam(distanceStr, gradePercent, timeStr) {
  const metres = parseDistance(distanceStr);
  const seconds = parseTimeToSeconds(timeStr);
  if (metres === null || !seconds) return null;
  if (typeof gradePercent !== 'number' || !(gradePercent >= VAM_MIN_GRADE)) return null;

  return (metres * gradePercent / 100) * 3600 / seconds;
}

function formatVam(metresPerHour) {
  return metresPerHour === null ? 'N/A' : `${Math.round(metresPerHour)} m/h`;
}

const PR_MEDAL_LABELS = ['PR', '2nd', '3rd'];

/**
 * A short badge for Strava's medal on an effort.
 *
 * Strava's personal-best medals are `icon-at-pr-1` to `-3`; anything else uses
 * Strava's own (localized) description, e.g. "KOM".
 * @returns {{label: string, description: string|null}|null}
 */
function achievementLabel(achievement) {
  if (!achievement) return null;

  const pr = /icon-at-pr-(\d+)/.exec(achievement.sprite || '');
  const label = (pr && PR_MEDAL_LABELS[Number(pr[1]) - 1]) || achievement.description;
  return label ? { label, description: achievement.description || null } : null;
}

/**
 * Stable key for pairing a segment effort across two activities.
 *
 * Segment id is authoritative; the name is only a fallback for markup that
 * does not expose a segment link. The occurrence suffix keeps repeated efforts
 * on the same segment (laps, intervals) as distinct rows instead of collapsing
 * them onto one another.
 */
function segmentKey(segment) {
  const base = segment.segmentId
    ? `id:${segment.segmentId}`
    : `name:${(segment.name || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return `${base}#${segment.occurrence || 0}`;
}

/**
 * Pair up the segments of two activities.
 *
 * Matched rows keep activity 1's page order. Segments present in only one
 * activity are returned separately rather than silently dropped.
 */
function compareSegmentLists(segments1, segments2) {
  const byKey2 = new Map();
  (segments2 || []).forEach(segment => byKey2.set(segmentKey(segment), segment));

  const matched = [];
  const onlyIn1 = [];
  const matchedKeys2 = new Set();

  (segments1 || []).forEach(segment1 => {
    const key = segmentKey(segment1);
    const segment2 = byKey2.get(key);

    if (!segment2) {
      onlyIn1.push(segment1);
      return;
    }
    matchedKeys2.add(key);

    const time1 = parseTimeToSeconds(segment1.time);
    const time2 = parseTimeToSeconds(segment2.time);
    const timeDiffSeconds = time1 === null || time2 === null ? null : time2 - time1;
    const rateComparison = compareRates(segment1.rate, segment2.rate);

    const power1 = parsePower(segment1.power);
    const power2 = parsePower(segment2.power);
    const powerDiffWatts = power1 === null || power2 === null ? null : power2 - power1;

    const hr1 = parseHeartRate(segment1.heartRate);
    const hr2 = parseHeartRate(segment2.heartRate);
    const hrDiff = hr1 === null || hr2 === null ? null : hr2 - hr1;

    // The same segment, so either activity's reading will do.
    const distance = segment1.distance || segment2.distance || null;
    const grade = [segment1.grade, segment2.grade].find(g => typeof g === 'number' && Number.isFinite(g));
    const vam1 = computeVam(distance, grade, segment1.time);
    const vam2 = computeVam(distance, grade, segment2.time);
    const vamDiff = vam1 === null || vam2 === null ? null : vam2 - vam1;

    matched.push({
      key,
      segmentId: segment1.segmentId || null,
      name: segment1.name,
      link: segment1.link,
      link_2: segment2.link,
      distance,
      grade: grade === undefined ? null : grade,
      time_1: segment1.time || 'N/A',
      time_2: segment2.time || 'N/A',
      time_diff: formatTimeDiff(timeDiffSeconds),
      time_diff_seconds: timeDiffSeconds,
      rate_1: segment1.rate || 'N/A',
      rate_2: segment2.rate || 'N/A',
      rate_diff: rateComparison ? rateComparison.text : 'N/A',
      rate_diff_value: rateComparison ? rateComparison.delta : null,
      rate_positive_is_faster: rateComparison ? rateComparison.positiveIsFaster : true,
      power_1: segment1.power || 'N/A',
      power_2: segment2.power || 'N/A',
      power_diff: formatPowerDiff(powerDiffWatts),
      power_diff_value: powerDiffWatts,
      hr_1: segment1.heartRate || 'N/A',
      hr_2: segment2.heartRate || 'N/A',
      hr_diff: formatSignedDiff(hrDiff, 'bpm'),
      hr_diff_value: hrDiff,
      vam_1: formatVam(vam1),
      vam_2: formatVam(vam2),
      vam_diff: formatSignedDiff(vamDiff, 'm/h'),
      vam_diff_value: vamDiff,
      achievement_1: achievementLabel(segment1.achievement),
      achievement_2: achievementLabel(segment2.achievement)
    });
  });

  const onlyIn2 = (segments2 || []).filter(s => !matchedKeys2.has(segmentKey(s)));

  return { matched, onlyIn1, onlyIn2 };
}

/**
 * Header label for the rate columns: "Speed" for rides, "Pace" for runs.
 */
function rateColumnLabel(segments) {
  const firstParsed = (segments || [])
    .map(s => parseRate(s.rate))
    .find(Boolean);
  return firstParsed && firstParsed.kind === 'pace' ? 'Pace' : 'Speed';
}

/** True when either activity reported average power for at least one segment. */
function hasPowerData(matched) {
  return (matched || []).some(
    row => parsePower(row.power_1) !== null || parsePower(row.power_2) !== null
  );
}

/** True when either activity reported heart rate for at least one segment. */
function hasHeartRateData(matched) {
  return (matched || []).some(
    row => parseHeartRate(row.hr_1) !== null || parseHeartRate(row.hr_2) !== null
  );
}

/** True when at least one matched segment is steep enough to have a VAM. */
function hasVamData(matched) {
  return (matched || []).some(row => [row.vam_1, row.vam_2].some(v => v && v !== 'N/A'));
}

/** True when at least one matched row carries a personal record. */
function hasPersonalRecords(matched) {
  return (matched || []).some(row => row.pr_time_seconds !== null && row.pr_time_seconds !== undefined);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

const SUMMARY_HIGHLIGHT_COUNT = 3;

/**
 * Roll a matched list up into the answer people actually opened the popup for:
 * how big the gap is, and which segments produced it.
 *
 * The net is a plain sum of per-segment deltas, which is what "I lost three
 * minutes" means colloquially. It deliberately does not weight by segment
 * length, so a long segment contributes more than a short one.
 */
function summarizeComparison(matched) {
  const rows = (matched || []).filter(
    row => typeof row.time_diff_seconds === 'number' && !Number.isNaN(row.time_diff_seconds)
  );

  const empty = {
    total: (matched || []).length,
    compared: 0,
    netSeconds: null,
    netText: 'N/A',
    fasterCount: 0,
    slowerCount: 0,
    evenCount: 0,
    biggestLosses: [],
    biggestGains: []
  };
  if (!rows.length) return empty;

  // Descending: worst losses at the front, best gains at the back.
  const byDelta = [...rows].sort((a, b) => b.time_diff_seconds - a.time_diff_seconds);
  const netSeconds = rows.reduce((sum, row) => sum + row.time_diff_seconds, 0);

  return {
    total: (matched || []).length,
    compared: rows.length,
    netSeconds,
    netText: formatTimeDiff(netSeconds),
    fasterCount: rows.filter(row => row.time_diff_seconds < 0).length,
    slowerCount: rows.filter(row => row.time_diff_seconds > 0).length,
    evenCount: rows.filter(row => row.time_diff_seconds === 0).length,
    biggestLosses: byDelta.filter(row => row.time_diff_seconds > 0).slice(0, SUMMARY_HIGHLIGHT_COUNT),
    biggestGains: byDelta
      .filter(row => row.time_diff_seconds < 0)
      .slice(-SUMMARY_HIGHLIGHT_COUNT)
      .reverse()
  };
}

/* ------------------------------------------------------------------ *
 * Sorting
 * ------------------------------------------------------------------ */

/** Rate cells sort on their normalized value so mph and km/h interleave correctly. */
function rateSortValue(rateStr) {
  const parsed = parseRate(rateStr);
  if (!parsed) return null;
  return parsed.kind === 'pace' ? parsed.secPerKm : parsed.kmh;
}

const SORT_ACCESSORS = {
  name: row => (row.name || '').toLowerCase(),
  distance: row => parseDistance(row.distance),
  time_1: row => parseTimeToSeconds(row.time_1),
  time_2: row => parseTimeToSeconds(row.time_2),
  time_diff: row => row.time_diff_seconds,
  rate_1: row => rateSortValue(row.rate_1),
  rate_2: row => rateSortValue(row.rate_2),
  rate_diff: row => row.rate_diff_value,
  power_1: row => parsePower(row.power_1),
  power_2: row => parsePower(row.power_2),
  power_diff: row => row.power_diff_value,
  hr_1: row => parseHeartRate(row.hr_1),
  hr_2: row => parseHeartRate(row.hr_2),
  hr_diff: row => row.hr_diff_value,
  vam_1: row => parseFloat(row.vam_1),
  vam_2: row => parseFloat(row.vam_2),
  vam_diff: row => row.vam_diff_value,
  pr_time: row => row.pr_time_seconds,
  pr_diff: row => row.pr_diff_seconds
};

/** Whether a column can be sorted, so the UI knows which headers are clickable. */
function isSortable(key) {
  return Object.prototype.hasOwnProperty.call(SORT_ACCESSORS, key);
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value));
}

/**
 * Sort matched rows by one column.
 *
 * Rows with no value for the column always sink to the bottom, in both
 * directions — a segment we could not parse is not "the fastest". Ties keep
 * their original (activity 1 page) order.
 */
function sortMatched(matched, key, direction = 'asc') {
  const rows = [...(matched || [])];
  const accessor = SORT_ACCESSORS[key];
  if (!accessor) return rows;

  const sign = direction === 'desc' ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index, value: accessor(row) }))
    .sort((a, b) => {
      const aMissing = isMissing(a.value);
      const bMissing = isMissing(b.value);
      if (aMissing || bMissing) {
        if (aMissing && bMissing) return a.index - b.index;
        return aMissing ? 1 : -1;
      }
      if (a.value < b.value) return -sign;
      if (a.value > b.value) return sign;
      return a.index - b.index;
    })
    .map(entry => entry.row);
}

/* ------------------------------------------------------------------ *
 * Personal records
 * ------------------------------------------------------------------ */

/**
 * Attach the signed-in athlete's PR for each segment onto the matched rows.
 *
 * The PR is compared against activity 1's time, since that is the column the
 * rest of the table is anchored on. A positive diff means activity 1 was slower
 * than the PR; a negative diff means that effort *was* a new PR (or the cached
 * PR is stale).
 *
 * @param {Array} matched
 * @param {Object} prBySegmentId  segment id -> { time } (or a falsy value when unknown)
 */
function applyPersonalRecords(matched, prBySegmentId) {
  const lookup = prBySegmentId || {};

  return (matched || []).map(row => {
    const pr = row.segmentId ? lookup[row.segmentId] : null;
    const prSeconds = pr && pr.time ? parseTimeToSeconds(pr.time) : null;
    const time1 = parseTimeToSeconds(row.time_1);
    const diff = prSeconds === null || time1 === null ? null : time1 - prSeconds;

    return {
      ...row,
      pr_time: prSeconds === null ? 'N/A' : pr.time,
      pr_time_seconds: prSeconds,
      pr_diff: formatTimeDiff(diff),
      pr_diff_seconds: diff
    };
  });
}

/* ------------------------------------------------------------------ *
 * "My activities here"
 * ------------------------------------------------------------------ */

/**
 * Rank the signed-in athlete's other activities by how many of `segmentIds`
 * they share, most recent first on a tie.
 *
 * @param {string[]} segmentIds  the segments of the activity being compared
 * @param {Object} recentBySegmentId  segment id -> [{activityId, name, date}]
 * @param {string} excludeActivityId  the activity being compared
 * @returns {Array<{activityId: string, name: string|null, date: string|null, shared: number}>}
 */
function rankSharedActivities(segmentIds, recentBySegmentId, excludeActivityId, limit = 5) {
  const byActivity = new Map();

  (segmentIds || []).forEach(segmentId => {
    ((recentBySegmentId || {})[segmentId] || []).forEach(({ activityId, name, date }) => {
      if (!activityId || activityId === String(excludeActivityId)) return;

      const entry = byActivity.get(activityId) || { activityId, name: null, date: null, segments: new Set() };
      entry.name = entry.name || name || null;
      entry.date = entry.date || date || null;
      entry.segments.add(segmentId);
      byActivity.set(activityId, entry);
    });
  });

  const when = date => Date.parse(date || '') || 0;

  return [...byActivity.values()]
    .map(({ segments, ...activity }) => ({ ...activity, shared: segments.size }))
    .sort((a, b) => b.shared - a.shared || when(b.date) - when(a.date))
    .slice(0, limit);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KM_PER_MILE,
    METRES_PER_MILE,
    parseTimeToSeconds,
    formatTimeDiff,
    formatSecondsToTime,
    parseRate,
    parsePower,
    parseDistance,
    formatPowerDiff,
    formatSignedDiff,
    parseHeartRate,
    computeVam,
    achievementLabel,
    hasHeartRateData,
    hasVamData,
    compareRates,
    segmentKey,
    compareSegmentLists,
    rateColumnLabel,
    hasPowerData,
    hasPersonalRecords,
    summarizeComparison,
    rateSortValue,
    isSortable,
    sortMatched,
    applyPersonalRecords,
    rankSharedActivities
  };
}
