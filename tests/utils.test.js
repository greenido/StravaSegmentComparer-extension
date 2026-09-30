import { describe, it, expect } from 'vitest';
import {
  parseTimeToSeconds,
  formatTimeDiff,
  parseRate,
  parsePower,
  parseDistance,
  formatPowerDiff,
  compareRates,
  segmentKey,
  compareSegmentLists,
  rateColumnLabel,
  hasPowerData,
  hasPersonalRecords,
  summarizeComparison,
  sortMatched,
  applyPersonalRecords,
  parseHeartRate,
  computeVam,
  achievementLabel,
  hasHeartRateData,
  hasVamData,
  rankSharedActivities,
  ordinal,
  effortHistoryStats,
  applyEffortHistory,
  hasEffortHistory,
  effortQuality,
  hasQualityData,
  cumulativeTimeDeltas,
  markNestedSegments
} from '../utils.js';

describe('parseTimeToSeconds', () => {
  it('parses mm:ss and h:mm:ss', () => {
    expect(parseTimeToSeconds('2:05')).toBe(125);
    expect(parseTimeToSeconds('1:02:05')).toBe(3725);
  });

  it('parses bare seconds with or without a suffix', () => {
    expect(parseTimeToSeconds('45')).toBe(45);
    expect(parseTimeToSeconds('45s')).toBe(45);
  });

  it('returns null rather than 0 for missing values', () => {
    // 0 would be indistinguishable from a real time and would poison deltas.
    expect(parseTimeToSeconds('N/A')).toBeNull();
    expect(parseTimeToSeconds('')).toBeNull();
    expect(parseTimeToSeconds(null)).toBeNull();
    expect(parseTimeToSeconds('not a time')).toBeNull();
  });
});

describe('formatTimeDiff', () => {
  it('signs and pads the difference', () => {
    expect(formatTimeDiff(0)).toBe('0:00');
    expect(formatTimeDiff(5)).toBe('+0:05');
    expect(formatTimeDiff(-65)).toBe('-1:05');
    expect(formatTimeDiff(3725)).toBe('+1:02:05');
  });

  it('reports N/A when there is no comparable value', () => {
    expect(formatTimeDiff(null)).toBe('N/A');
  });
});

describe('parseRate', () => {
  it('parses metric and imperial speeds', () => {
    expect(parseRate('29.3 km/h')).toMatchObject({ kind: 'speed', unit: 'km/h', value: 29.3 });

    const mph = parseRate('18.2 mph');
    expect(mph.kind).toBe('speed');
    expect(mph.unit).toBe('mph');
    expect(mph.kmh).toBeCloseTo(29.29, 1);
  });

  it('parses running pace per km and per mile', () => {
    expect(parseRate('5:32 /km')).toMatchObject({ kind: 'pace', unit: '/km', value: 332 });

    const perMile = parseRate('8:54/mi');
    expect(perMile.kind).toBe('pace');
    expect(perMile.unit).toBe('/mi');
    expect(perMile.secPerKm).toBeCloseTo(331.8, 0);
  });

  it('returns null for missing or unrecognized cells', () => {
    expect(parseRate('N/A')).toBeNull();
    expect(parseRate('')).toBeNull();
    expect(parseRate(undefined)).toBeNull();
  });
});

describe('compareRates', () => {
  it('subtracts speeds in activity 1 units even when units differ', () => {
    // 18.2 mph is ~29.29 km/h, so this is a small loss, not a huge one.
    const result = compareRates('30.0 km/h', '18.2 mph');
    expect(result.delta).toBeCloseTo(-0.71, 1);
    expect(result.text).toBe('-0.7 km/h');
    expect(result.positiveIsFaster).toBe(true);
  });

  it('treats a larger pace as slower', () => {
    const result = compareRates('5:00 /km', '5:12 /km');
    expect(result.delta).toBe(12);
    expect(result.text).toBe('+0:12 /km');
    expect(result.positiveIsFaster).toBe(false);
  });

  it('refuses to compare a pace against a speed', () => {
    expect(compareRates('5:00 /km', '29.3 km/h')).toBeNull();
    expect(compareRates('29.3 km/h', 'N/A')).toBeNull();
  });
});

describe('segmentKey', () => {
  it('keys on the segment id and the occurrence', () => {
    expect(segmentKey({ segmentId: '123', occurrence: 0 })).toBe('id:123#0');
    expect(segmentKey({ segmentId: '123', occurrence: 1 })).toBe('id:123#1');
  });

  it('falls back to a normalized name when there is no id', () => {
    expect(segmentKey({ name: '  Old  La Honda ', occurrence: 0 })).toBe('name:old la honda#0');
  });
});

describe('compareSegmentLists', () => {
  const segment = (overrides = {}) => ({
    segmentId: '1',
    occurrence: 0,
    name: 'Climb',
    link: 'https://www.strava.com/segments/1',
    time: '5:00',
    rate: '20.0 km/h',
    ...overrides
  });

  it('matches on segment id, not on name', () => {
    const a = [segment({ segmentId: '1', name: 'Climb' })];
    const b = [segment({ segmentId: '1', name: 'Climb (renamed)', time: '4:50' })];

    const { matched } = compareSegmentLists(a, b);
    expect(matched).toHaveLength(1);
    expect(matched[0].time_diff).toBe('-0:10');
  });

  it('keeps repeated efforts on the same segment distinct', () => {
    // Two laps of the same segment in each activity: this must yield two rows,
    // pairing lap 1 with lap 1 and lap 2 with lap 2.
    const a = [
      segment({ occurrence: 0, time: '5:00' }),
      segment({ occurrence: 1, time: '5:30' })
    ];
    const b = [
      segment({ occurrence: 0, time: '4:50' }),
      segment({ occurrence: 1, time: '5:40' })
    ];

    const { matched, onlyIn1, onlyIn2 } = compareSegmentLists(a, b);
    expect(matched).toHaveLength(2);
    expect(matched[0].time_diff).toBe('-0:10');
    expect(matched[1].time_diff).toBe('+0:10');
    expect(onlyIn1).toHaveLength(0);
    expect(onlyIn2).toHaveLength(0);
  });

  it('reports segments that appear in only one activity', () => {
    const a = [segment({ segmentId: '1' }), segment({ segmentId: '2', name: 'Sprint' })];
    const b = [segment({ segmentId: '1' }), segment({ segmentId: '3', name: 'Descent' })];

    const { matched, onlyIn1, onlyIn2 } = compareSegmentLists(a, b);
    expect(matched).toHaveLength(1);
    expect(onlyIn1.map(s => s.name)).toEqual(['Sprint']);
    expect(onlyIn2.map(s => s.name)).toEqual(['Descent']);
  });

  it('preserves activity 1 ordering', () => {
    const a = [
      segment({ segmentId: '1', name: 'First' }),
      segment({ segmentId: '2', name: 'Second' })
    ];
    const b = [
      segment({ segmentId: '2', name: 'Second' }),
      segment({ segmentId: '1', name: 'First' })
    ];

    const { matched } = compareSegmentLists(a, b);
    expect(matched.map(m => m.name)).toEqual(['First', 'Second']);
  });

  it('does not invent a delta when a time is missing', () => {
    const a = [segment({ time: 'N/A' })];
    const b = [segment({ time: '5:00' })];

    const { matched } = compareSegmentLists(a, b);
    expect(matched[0].time_diff).toBe('N/A');
    expect(matched[0].time_diff_seconds).toBeNull();
  });
});

describe('rateColumnLabel', () => {
  it('labels rides Speed and runs Pace', () => {
    expect(rateColumnLabel([{ rate: '29.3 km/h' }])).toBe('Speed');
    expect(rateColumnLabel([{ rate: '5:32 /km' }])).toBe('Pace');
    expect(rateColumnLabel([{ rate: 'N/A' }, { rate: '5:32 /km' }])).toBe('Pace');
    expect(rateColumnLabel([])).toBe('Speed');
  });
});

describe('parsePower', () => {
  it('reads watts in the forms Strava uses', () => {
    expect(parsePower('241 W')).toBe(241);
    expect(parsePower('241w')).toBe(241);
    expect(parsePower('241 watts')).toBe(241);
  });

  it('returns null for anything that is not a power reading', () => {
    expect(parsePower('N/A')).toBeNull();
    expect(parsePower('18.5 km/h')).toBeNull();
    expect(parsePower(null)).toBeNull();
  });
});

describe('parseDistance', () => {
  it('normalizes every unit to metres', () => {
    expect(parseDistance('1.24 km')).toBeCloseTo(1240);
    expect(parseDistance('450 m')).toBe(450);
    expect(parseDistance('1 mi')).toBeCloseTo(1609.344);
  });

  it('returns null when there is no distance to read', () => {
    expect(parseDistance('N/A')).toBeNull();
    expect(parseDistance('')).toBeNull();
  });
});

describe('formatPowerDiff', () => {
  it('signs and rounds the watt delta', () => {
    expect(formatPowerDiff(12.4)).toBe('+12 W');
    expect(formatPowerDiff(-8)).toBe('-8 W');
    expect(formatPowerDiff(0)).toBe('0 W');
    expect(formatPowerDiff(null)).toBe('N/A');
  });
});

describe('compareSegmentLists power and distance', () => {
  const withPower = (power1, power2) =>
    compareSegmentLists(
      [{ segmentId: '1', name: 'Climb', time: '5:00', power: power1, distance: '1.2 km' }],
      [{ segmentId: '1', name: 'Climb', time: '5:00', power: power2 }]
    ).matched[0];

  it('carries the segment distance and the power delta', () => {
    const row = withPower('220 W', '245 W');

    expect(row.distance).toBe('1.2 km');
    expect(row.power_diff).toBe('+25 W');
    expect(row.power_diff_value).toBe(25);
  });

  it('leaves the power delta empty when only one activity recorded power', () => {
    const row = withPower('220 W', null);

    expect(row.power_diff).toBe('N/A');
    expect(row.power_diff_value).toBeNull();
  });

  it('carries the segment id so PRs can be looked up later', () => {
    expect(withPower('220 W', '245 W').segmentId).toBe('1');
  });
});

describe('hasPowerData', () => {
  it('is true as soon as either side has a power reading', () => {
    expect(hasPowerData([{ power_1: 'N/A', power_2: '245 W' }])).toBe(true);
    expect(hasPowerData([{ power_1: 'N/A', power_2: 'N/A' }])).toBe(false);
    expect(hasPowerData([])).toBe(false);
  });
});

describe('summarizeComparison', () => {
  const row = (name, seconds) => ({
    name,
    time_diff: formatTimeDiff(seconds),
    time_diff_seconds: seconds
  });

  it('nets the deltas and counts the wins and losses', () => {
    const summary = summarizeComparison([
      row('A', 60),
      row('B', -20),
      row('C', 0),
      row('D', 5)
    ]);

    expect(summary.netSeconds).toBe(45);
    expect(summary.netText).toBe('+0:45');
    expect(summary.fasterCount).toBe(1);
    expect(summary.slowerCount).toBe(2);
    expect(summary.evenCount).toBe(1);
    expect(summary.compared).toBe(4);
  });

  it('ranks the three biggest losses and gains by size', () => {
    const summary = summarizeComparison([
      row('small loss', 5),
      row('huge loss', 300),
      row('mid loss', 60),
      row('tiny loss', 1),
      row('big gain', -90),
      row('small gain', -3)
    ]);

    expect(summary.biggestLosses.map(r => r.name)).toEqual(['huge loss', 'mid loss', 'small loss']);
    expect(summary.biggestGains.map(r => r.name)).toEqual(['big gain', 'small gain']);
  });

  it('ignores rows with no comparable time but still counts them', () => {
    const summary = summarizeComparison([row('A', 30), { name: 'B', time_diff_seconds: null }]);

    expect(summary.total).toBe(2);
    expect(summary.compared).toBe(1);
    expect(summary.netSeconds).toBe(30);
  });

  it('reports nothing rather than zero when no row is comparable', () => {
    // A net of "0:00" would read as "dead even", which is not what we know.
    const summary = summarizeComparison([{ name: 'A', time_diff_seconds: null }]);

    expect(summary.netSeconds).toBeNull();
    expect(summary.netText).toBe('N/A');
  });
});

describe('sortMatched', () => {
  const rows = [
    { name: 'Beta', time_diff_seconds: 10, time_1: '5:00' },
    { name: 'Alpha', time_diff_seconds: -30, time_1: '4:00' },
    { name: 'Gamma', time_diff_seconds: 100, time_1: '6:00' }
  ];

  it('sorts by a numeric column in both directions', () => {
    expect(sortMatched(rows, 'time_diff', 'desc').map(r => r.name)).toEqual(['Gamma', 'Beta', 'Alpha']);
    expect(sortMatched(rows, 'time_diff', 'asc').map(r => r.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('sorts by name alphabetically', () => {
    expect(sortMatched(rows, 'name', 'asc').map(r => r.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('sinks rows with no value to the bottom in both directions', () => {
    // An unparseable segment is not the fastest one, whichever way we sort.
    const withGap = [...rows, { name: 'Missing', time_diff_seconds: null }];

    expect(sortMatched(withGap, 'time_diff', 'desc').at(-1).name).toBe('Missing');
    expect(sortMatched(withGap, 'time_diff', 'asc').at(-1).name).toBe('Missing');
  });

  it('keeps ties in their original order', () => {
    const tied = [
      { name: 'First', time_diff_seconds: 5 },
      { name: 'Second', time_diff_seconds: 5 },
      { name: 'Third', time_diff_seconds: 5 }
    ];

    expect(sortMatched(tied, 'time_diff', 'desc').map(r => r.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('returns a copy in the original order for an unknown column', () => {
    const sorted = sortMatched(rows, 'nonsense', 'asc');

    expect(sorted.map(r => r.name)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(sorted).not.toBe(rows);
  });

  it('sorts paces and speeds on their normalized value, not their text', () => {
    // "9:00 /km" sorts after "10:00 /mi" (6:13 /km) despite the smaller number.
    const paces = [
      { name: 'slow', rate_1: '9:00 /km' },
      { name: 'fast', rate_1: '10:00 /mi' }
    ];

    expect(sortMatched(paces, 'rate_1', 'asc').map(r => r.name)).toEqual(['fast', 'slow']);
  });
});

describe('applyPersonalRecords', () => {
  const matched = [
    { segmentId: '1', name: 'Climb', time_1: '5:30' },
    { segmentId: '2', name: 'Sprint', time_1: '1:00' },
    { segmentId: null, name: 'Unlinked', time_1: '2:00' }
  ];

  it('compares activity 1 against the PR', () => {
    const rows = applyPersonalRecords(matched, { 1: { time: '5:00' } });

    expect(rows[0].pr_time).toBe('5:00');
    expect(rows[0].pr_diff_seconds).toBe(30);
    expect(rows[0].pr_diff).toBe('+0:30');
  });

  it('reports a negative diff when the effort beat the stored PR', () => {
    const rows = applyPersonalRecords(matched, { 2: { time: '1:10' } });

    expect(rows[1].pr_diff).toBe('-0:10');
  });

  it('leaves rows without a PR as N/A rather than zero', () => {
    const rows = applyPersonalRecords(matched, { 1: { time: '5:00' } });

    expect(rows[1].pr_time).toBe('N/A');
    expect(rows[1].pr_time_seconds).toBeNull();
    expect(rows[1].pr_diff).toBe('N/A');
    expect(rows[2].pr_time).toBe('N/A');
  });

  it('marks the comparison as having PRs only once one lands', () => {
    expect(hasPersonalRecords(matched)).toBe(false);
    expect(hasPersonalRecords(applyPersonalRecords(matched, { 1: { time: '5:00' } }))).toBe(true);
    expect(hasPersonalRecords(applyPersonalRecords(matched, {}))).toBe(false);
  });
});

describe('parseHeartRate', () => {
  it('reads beats per minute with or without a space', () => {
    expect(parseHeartRate('121 bpm')).toBe(121);
    expect(parseHeartRate('121bpm')).toBe(121);
  });

  it('returns null when there is no reading', () => {
    expect(parseHeartRate(null)).toBeNull();
    expect(parseHeartRate('N/A')).toBeNull();
  });
});

describe('computeVam', () => {
  it('is metres climbed per hour: distance x grade / time', () => {
    // 1 km at 8% is 80 m of climbing; in 6 minutes that is 800 m/h.
    expect(computeVam('1.00 km', 8, '6:00')).toBeCloseTo(800);
  });

  it('works in miles', () => {
    expect(computeVam('1 mi', 5, '10:00')).toBeCloseTo(482.8, 1);
  });

  it('is left out below a 3% average grade, where it means nothing', () => {
    expect(computeVam('5.00 km', 2.9, '8:00')).toBeNull();
  });

  it('needs a distance, a grade and a time', () => {
    expect(computeVam(null, 8, '6:00')).toBeNull();
    expect(computeVam('1.00 km', null, '6:00')).toBeNull();
    expect(computeVam('1.00 km', 8, 'N/A')).toBeNull();
  });
});

describe('achievementLabel', () => {
  it("shortens Strava's personal-best medals", () => {
    expect(achievementLabel({ sprite: 'icon-at-pr-1', description: 'Personal Record' })).toEqual({
      label: 'PR',
      description: 'Personal Record'
    });
    expect(achievementLabel({ sprite: 'icon-at-pr-2', description: null }).label).toBe('2nd');
    expect(achievementLabel({ sprite: 'icon-at-pr-3', description: null }).label).toBe('3rd');
  });

  it("falls back to Strava's own wording for any other medal", () => {
    expect(achievementLabel({ sprite: 'icon-at-kom-1', description: 'KOM' })).toEqual({
      label: 'KOM',
      description: 'KOM'
    });
  });

  it('returns null when there is nothing to show', () => {
    expect(achievementLabel(null)).toBeNull();
    expect(achievementLabel({ sprite: 'icon-at-unknown', description: null })).toBeNull();
  });
});

describe('compareSegmentLists heart rate, VAM, grade and medals', () => {
  const climb = overrides => ({
    segmentId: '1',
    name: 'Ridge Road',
    distance: '1.00 km',
    grade: 8,
    time: '6:00',
    heartRate: '150 bpm',
    ...overrides
  });

  const compare = (a, b) => compareSegmentLists([climb(a)], [climb(b)]).matched[0];

  it('compares heart rate', () => {
    const row = compare({}, { heartRate: '145 bpm' });
    expect(row).toMatchObject({ hr_1: '150 bpm', hr_2: '145 bpm', hr_diff: '-5 bpm', hr_diff_value: -5 });
  });

  it('compares VAM, each from its own time on the shared climb', () => {
    const row = compare({}, { time: '5:00' });
    expect(row).toMatchObject({ vam_1: '800 m/h', vam_2: '960 m/h', vam_diff: '+160 m/h', vam_diff_value: 160 });
  });

  it('carries the grade and each effort\'s medal', () => {
    const row = compare({ achievement: { sprite: 'icon-at-pr-1', description: null } }, {});
    expect(row.grade).toBe(8);
    expect(row.achievement_1).toEqual({ label: 'PR', description: null });
    expect(row.achievement_2).toBeNull();
  });

  it('marks what it cannot compare as N/A', () => {
    const row = compare({ heartRate: null, grade: 1 }, {});
    expect(row).toMatchObject({ hr_1: 'N/A', hr_diff: 'N/A', hr_diff_value: null, vam_1: 'N/A', vam_diff: 'N/A' });
  });
});

describe('hasHeartRateData and hasVamData', () => {
  it('report whether any row has a reading', () => {
    expect(hasHeartRateData([{ hr_1: 'N/A', hr_2: '140 bpm' }])).toBe(true);
    expect(hasHeartRateData([{ hr_1: 'N/A', hr_2: 'N/A' }])).toBe(false);
    expect(hasVamData([{ vam_1: '800 m/h', vam_2: 'N/A' }])).toBe(true);
    expect(hasVamData([{}])).toBe(false);
  });
});

describe('sorting the new columns', () => {
  it('sorts by heart-rate and VAM difference', () => {
    const rows = [
      { name: 'a', hr_diff_value: 3, vam_diff_value: -20 },
      { name: 'b', hr_diff_value: -8, vam_diff_value: 90 }
    ];
    expect(sortMatched(rows, 'hr_diff', 'asc').map(r => r.name)).toEqual(['b', 'a']);
    expect(sortMatched(rows, 'vam_diff', 'desc').map(r => r.name)).toEqual(['b', 'a']);
  });
});

describe('rankSharedActivities', () => {
  const ride = (activityId, date, name = `Ride ${activityId}`) => ({ activityId, name, date });

  const recentBySegmentId = {
    s1: [ride('A', '2026-09-01'), ride('B', '2026-08-01'), ride('SELF', '2026-09-10')],
    s2: [ride('A', '2026-09-01'), ride('C', '2026-09-05')],
    s3: [ride('A', '2026-09-01'), ride('B', '2026-08-01')]
  };

  it('ranks your other activities by how many of the segments they share', () => {
    expect(rankSharedActivities(['s1', 's2', 's3'], recentBySegmentId, 'SELF')).toEqual([
      { activityId: 'A', name: 'Ride A', date: '2026-09-01', shared: 3 },
      { activityId: 'B', name: 'Ride B', date: '2026-08-01', shared: 2 },
      { activityId: 'C', name: 'Ride C', date: '2026-09-05', shared: 1 }
    ]);
  });

  it('breaks ties with the most recent activity', () => {
    const ranked = rankSharedActivities(['s2'], recentBySegmentId, 'SELF');
    expect(ranked.map(a => a.activityId)).toEqual(['C', 'A']);
  });

  it('never suggests the activity being compared', () => {
    const ids = rankSharedActivities(['s1'], recentBySegmentId, 'SELF').map(a => a.activityId);
    expect(ids).not.toContain('SELF');
  });

  it('keeps the top few, and copes with segments it has no history for', () => {
    expect(rankSharedActivities(['s1', 's2', 's3', 'nope'], recentBySegmentId, 'SELF', 2)).toHaveLength(2);
    expect(rankSharedActivities(['nope'], recentBySegmentId, 'SELF')).toEqual([]);
  });
});

describe('ordinal', () => {
  it('uses the English suffixes, including the teens', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th'
    ]);
  });
});

describe('effortHistoryStats', () => {
  const times = [{ seconds: 320 }, { seconds: 300 }, { seconds: 310 }, { seconds: 290 }];

  it('ranks an effort by how many of your efforts were faster', () => {
    // 290 and 300 were faster than 310, so it is the third best.
    expect(effortHistoryStats(times, '5:10', 4)).toMatchObject({
      rank: 3,
      count: 4,
      total: 4,
      bestSeconds: 290,
      label: '3rd of 4'
    });
  });

  it('calls your fastest effort first', () => {
    expect(effortHistoryStats(times, '4:50', 4).label).toBe('1st of 4');
  });

  it('says the list is a tail when Strava reported more efforts than it kept', () => {
    const stats = effortHistoryStats(times, '5:00', 90);
    expect(stats.label).toBe('2nd of last 4');
    expect(stats.title).toContain('of 90');
  });

  it('names your best time in the tooltip', () => {
    expect(effortHistoryStats(times, '5:00', 4).title).toContain('4:50');
  });

  it('returns null without usable times or an unreadable effort time', () => {
    expect(effortHistoryStats([], '5:00', 0)).toBeNull();
    expect(effortHistoryStats(null, '5:00', 0)).toBeNull();
    expect(effortHistoryStats(times, 'N/A', 4)).toBeNull();
  });
});

describe('applyEffortHistory', () => {
  const matched = [
    { segmentId: '1', time_1: '5:10' },
    { segmentId: '2', time_1: '2:00' },
    { segmentId: null, time_1: '1:00' }
  ];
  const history = {
    1: { times: [{ seconds: 290 }, { seconds: 310 }], effortCount: 2 }
  };

  it('attaches the rank and the times for a segment it knows', () => {
    const [first] = applyEffortHistory(matched, history);
    expect(first.history_rank).toBe(2);
    expect(first.history_label).toBe('2nd of 2');
    expect(first.history_times).toHaveLength(2);
  });

  it('leaves rows it knows nothing about as N/A rather than dropping them', () => {
    const rows = applyEffortHistory(matched, history);
    expect(rows).toHaveLength(3);
    expect(rows[1].history_label).toBe('N/A');
    expect(rows[1].history_times).toBeNull();
    expect(rows[2].history_times).toBeNull();
  });

  it('shows the column only once a segment has two points to draw', () => {
    expect(hasEffortHistory(applyEffortHistory(matched, history))).toBe(true);
    const single = { 1: { times: [{ seconds: 290 }], effortCount: 1 } };
    expect(hasEffortHistory(applyEffortHistory(matched, single))).toBe(false);
    expect(hasEffortHistory(applyEffortHistory(matched, {}))).toBe(false);
  });
});

describe('effortQuality', () => {
  // Deltas are activity 2 minus activity 1: negative time is faster, negative
  // heart rate is easier.
  const read = (time, hr) => {
    const quality = effortQuality(time, hr);
    return quality && quality.key;
  };

  it('calls a faster time at a lower or equal heart rate fitness', () => {
    expect(read(-20, -6)).toBe('fitness');
    expect(read(-20, 0)).toBe('fitness');
    expect(read(-20, 2)).toBe('fitness'); // within the heart-rate tolerance
  });

  it('calls a faster time bought with a higher heart rate effort', () => {
    expect(read(-20, 8)).toBe('effort');
  });

  it('separates slower-but-easier from slower-while-working-harder', () => {
    expect(read(30, -10)).toBe('easier');
    expect(read(30, 0)).toBe('slower');
    expect(read(30, 10)).toBe('fading');
  });

  it('reads the same time at a lower heart rate as fitness too', () => {
    expect(read(0, -8)).toBe('fitness');
    expect(read(0, 8)).toBe('effort');
    expect(read(0, 0)).toBe('even');
  });

  it('treats a second and a couple of beats as noise, not a signal', () => {
    expect(read(1, 2)).toBe('even');
    expect(read(-1, -2)).toBe('even');
  });

  it('explains itself in words, for the tooltip', () => {
    expect(effortQuality(-20, -6).title).toBe('Faster at a lower heart rate');
    expect(effortQuality(30, 10).title).toBe('Slower at a higher heart rate');
    expect(effortQuality(0, 0).title).toBe('Same time at the same heart rate');
  });

  it('says nothing when either reading is missing', () => {
    expect(effortQuality(-20, null)).toBeNull();
    expect(effortQuality(null, -6)).toBeNull();
    expect(effortQuality(NaN, 0)).toBeNull();
  });
});

describe('hasQualityData', () => {
  it('is true only once a segment has both readings', () => {
    const withBoth = compareSegmentLists(
      [{ segmentId: '1', name: 'A', time: '5:00', heartRate: '150 bpm' }],
      [{ segmentId: '1', name: 'A', time: '4:40', heartRate: '142 bpm' }]
    );
    expect(hasQualityData(withBoth.matched)).toBe(true);
    expect(withBoth.matched[0].quality.key).toBe('fitness');

    const noHr = compareSegmentLists(
      [{ segmentId: '1', name: 'A', time: '5:00' }],
      [{ segmentId: '1', name: 'A', time: '4:40' }]
    );
    expect(hasQualityData(noHr.matched)).toBe(false);
    expect(noHr.matched[0].quality).toBeNull();
  });
});

describe('cumulativeTimeDeltas', () => {
  const rows = [
    { name: 'Flat run-in', time_diff_seconds: 5 },
    { name: 'The climb', time_diff_seconds: 70 },
    { name: 'Descent', time_diff_seconds: -20 }
  ];

  it('adds the deltas up in course order', () => {
    expect(cumulativeTimeDeltas(rows)).toEqual([
      { name: 'Flat run-in', delta: 5, cumulative: 5 },
      { name: 'The climb', delta: 70, cumulative: 75 },
      { name: 'Descent', delta: -20, cumulative: 55 }
    ]);
  });

  it('skips a segment it could not compare rather than counting it as zero', () => {
    const withGap = [rows[0], { name: 'Unreadable', time_diff_seconds: null }, rows[1]];
    expect(cumulativeTimeDeltas(withGap).map(p => p.name)).toEqual(['Flat run-in', 'The climb']);
    expect(cumulativeTimeDeltas(withGap).at(-1).cumulative).toBe(75);
  });

  it('ends on the same number the summary reports as the net', () => {
    expect(cumulativeTimeDeltas(rows).at(-1).cumulative).toBe(summarizeComparison(rows).netSeconds);
  });

  it('survives an empty or missing list', () => {
    expect(cumulativeTimeDeltas([])).toEqual([]);
    expect(cumulativeTimeDeltas(null)).toEqual([]);
  });
});

describe('markNestedSegments', () => {
  // A lap containing a climb, which itself contains a sprint, plus a separate
  // segment further along the road.
  const lap = { name: 'Full lap', span: { start: 0, end: 1000 } };
  const climb = { name: 'The climb', span: { start: 200, end: 600 } };
  const sprint = { name: 'Sprint', span: { start: 300, end: 350 } };
  const later = { name: 'Run home', span: { start: 1200, end: 1500 } };

  const nesting = segments =>
    Object.fromEntries(markNestedSegments(segments).map(s => [s.name, s.nestedIn]));

  it('names the smallest segment that contains each one', () => {
    expect(nesting([lap, climb, sprint, later])).toEqual({
      'Full lap': null,
      'The climb': 'Full lap',
      // Inside the lap as well, but the climb is the one a rider would name.
      Sprint: 'The climb',
      'Run home': null
    });
  });

  it('leaves segments alone when Strava gave no positions', () => {
    const blind = [{ name: 'A', span: null }, { name: 'B', span: null }];
    expect(nesting(blind)).toEqual({ A: null, B: null });
  });

  it('does not nest a segment inside one of exactly the same extent', () => {
    const twin = { name: 'Twin', span: { start: 200, end: 600 } };
    expect(nesting([climb, twin])).toEqual({ 'The climb': null, Twin: null });
  });

  it('does not nest overlapping segments that merely share road', () => {
    const overlap = { name: 'Overlap', span: { start: 500, end: 1400 } };
    expect(nesting([climb, overlap])).toEqual({ 'The climb': null, Overlap: null });
  });
});

describe('leaving nested segments out of the summary', () => {
  const segments1 = [
    { segmentId: '1', name: 'Full lap', time: '20:00', span: { start: 0, end: 1200 } },
    { segmentId: '2', name: 'The climb', time: '8:00', span: { start: 200, end: 680 } },
    { segmentId: '3', name: 'Run home', time: '5:00', span: { start: 1300, end: 1600 } }
  ];
  const segments2 = [
    { segmentId: '1', name: 'Full lap', time: '21:00' },
    { segmentId: '2', name: 'The climb', time: '8:30' },
    { segmentId: '3', name: 'Run home', time: '5:10' }
  ];
  const { matched } = compareSegmentLists(segments1, segments2);

  it('counts every segment by default, nesting and all', () => {
    const summary = summarizeComparison(matched);
    // 60 + 30 + 10, with the climb counted inside the lap as well.
    expect(summary.netSeconds).toBe(100);
    expect(summary.compared).toBe(3);
    expect(summary.nestedCount).toBe(1);
  });

  it('drops the nested segment when asked, so no road counts twice', () => {
    const summary = summarizeComparison(matched, { excludeNested: true });
    expect(summary.netSeconds).toBe(70);
    expect(summary.compared).toBe(2);
    expect(summary.nestedCount).toBe(1);
  });

  it('keeps "not comparable" about unreadable rows, not about excluded ones', () => {
    const withGap = [...matched, { name: 'Unreadable', time_diff_seconds: null }];
    expect(summarizeComparison(withGap, { excludeNested: true }).notComparable).toBe(1);
  });

  it('reports no nesting when the segments carried no positions', () => {
    const flat = compareSegmentLists(
      segments1.map(({ span, ...rest }) => rest),
      segments2
    );
    expect(summarizeComparison(flat.matched).nestedCount).toBe(0);
  });
});
