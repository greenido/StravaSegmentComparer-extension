import { describe, it, expect } from 'vitest';
import {
  parseTimeToSeconds,
  formatTimeDiff,
  parseRate,
  compareRates,
  segmentKey,
  compareSegmentLists,
  rateColumnLabel
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
