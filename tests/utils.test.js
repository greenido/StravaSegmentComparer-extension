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
  rankSharedActivities
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
