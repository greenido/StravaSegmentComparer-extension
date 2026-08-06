/**
 * Pure helpers for Strava Segment Comparator.
 *
 * Nothing here touches the DOM or chrome APIs, so it is unit-testable
 * (see tests/utils.test.js) and shared by the popup and the extractor.
 */

const KM_PER_MILE = 1.609344;

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

    matched.push({
      key,
      name: segment1.name,
      link: segment1.link,
      link_2: segment2.link,
      time_1: segment1.time || 'N/A',
      time_2: segment2.time || 'N/A',
      time_diff: formatTimeDiff(timeDiffSeconds),
      time_diff_seconds: timeDiffSeconds,
      rate_1: segment1.rate || 'N/A',
      rate_2: segment2.rate || 'N/A',
      rate_diff: rateComparison ? rateComparison.text : 'N/A',
      rate_diff_value: rateComparison ? rateComparison.delta : null,
      rate_positive_is_faster: rateComparison ? rateComparison.positiveIsFaster : true
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    KM_PER_MILE,
    parseTimeToSeconds,
    formatTimeDiff,
    formatSecondsToTime,
    parseRate,
    compareRates,
    segmentKey,
    compareSegmentLists,
    rateColumnLabel
  };
}
