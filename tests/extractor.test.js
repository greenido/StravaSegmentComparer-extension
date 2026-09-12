// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  extractActivityId,
  extractAthleteName,
  extractActivityStats,
  extractSegments,
  extractActivityData,
  extractSegmentPersonalRecord,
  personalRecordFromHistory,
  hasSegments
} from '../extractor.js';

const parse = html => new DOMParser().parseFromString(html, 'text/html');

const rideSegments = `
  <table class="segments">
    <tbody>
      <tr data-segment-effort-id="111">
        <td class="name"><a href="/segments/999">Old La Honda</a></td>
        <td class="time">18:20</td>
        <td class="speeds"><span class="text-nowrap">18.5 km/h</span></td>
      </tr>
      <tr data-segment-effort-id="112">
        <td class="name"><a href="/segments/1000">Kings Mountain</a></td>
        <td class="time">1:02:05</td>
        <td class="speeds"><span class="text-nowrap">14.2 km/h</span></td>
      </tr>
    </tbody>
  </table>
`;

describe('extractActivityId', () => {
  it('pulls the id out of an activity URL', () => {
    expect(extractActivityId('https://www.strava.com/activities/12345')).toBe('12345');
    expect(extractActivityId('https://www.strava.com/athletes/7')).toBeNull();
  });
});

describe('extractSegments', () => {
  it('captures the segment id, effort id, name, time and rate', () => {
    const segments = extractSegments(parse(rideSegments), '12345');

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      segmentId: '999',
      effortId: '111',
      occurrence: 0,
      name: 'Old La Honda',
      time: '18:20',
      rate: '18.5 km/h',
      link: 'https://www.strava.com/activities/12345/segments/111'
    });
  });

  it('numbers repeated efforts on the same segment', () => {
    const html = `
      <table class="segments"><tbody>
        <tr data-segment-effort-id="1">
          <td class="name"><a href="/segments/50">Lap</a></td>
          <td class="time">2:00</td>
        </tr>
        <tr data-segment-effort-id="2">
          <td class="name"><a href="/segments/50">Lap</a></td>
          <td class="time">2:10</td>
        </tr>
      </tbody></table>`;

    const segments = extractSegments(parse(html), '1');
    expect(segments.map(s => s.occurrence)).toEqual([0, 1]);
  });

  it('reads a running pace column', () => {
    const html = `
      <table class="segments"><tbody>
        <tr data-segment-effort-id="7">
          <td class="name"><a href="/segments/77">Bay Trail Mile</a></td>
          <td class="time">5:32</td>
          <td>5:32 /km</td>
        </tr>
      </tbody></table>`;

    expect(extractSegments(parse(html), '1')[0].rate).toBe('5:32 /km');
  });

  it('finds time and rate cells that carry no useful class names', () => {
    const html = `
      <table class="segments"><tbody>
        <tr data-segment-effort-id="9">
          <td><a href="/segments/88">Unlabelled</a></td>
          <td>7:45</td>
          <td>22.4 km/h</td>
        </tr>
      </tbody></table>`;

    expect(extractSegments(parse(html), '1')[0]).toMatchObject({
      name: 'Unlabelled',
      time: '7:45',
      rate: '22.4 km/h'
    });
  });

  it('returns an empty list when there is no segments table', () => {
    expect(extractSegments(parse('<div>no segments here</div>'), '1')).toEqual([]);
  });
});

describe('segment ids on a real activity page', () => {
  // The shape Strava actually serves: rows carry only the effort id and no
  // segment link. The segment id is in the inline script that seeds the page's
  // efforts collection, with the effort id as a string.
  const bootstrap = (payload, tail = ', { parse: true });') =>
    `<script>
      jQuery(document).ready(function() {
        pageView.segmentEfforts().reset(${JSON.stringify(payload)}${tail}
      });
    </script>`;

  const rows = `
    <table class="dense hoverable marginless segments"><tbody>
      <tr data-segment-effort-id="9000000000000000001" class="full-columns track-props">
        <td class="name-col"><div class="name">Sprint {not json}</div></td>
        <td class="time-col">52<abbr class="unit" title="seconds">s</abbr></td>
      </tr>
      <tr data-segment-effort-id="9000000000000000002" class="full-columns track-props">
        <td class="name-col"><div class="name">Long Climb</div></td>
        <td class="time-col">29:03</td>
      </tr>
    </tbody></table>`;

  const payload = {
    efforts: [
      { id: '9000000000000000001', segment_id: 111, name: 'Sprint {not json}' },
      { id: '9000000000000000002', segment_id: 222, name: 'Long Climb' }
    ],
    hidden_efforts: [{ id: '9000000000000000003', segment_id: 333, name: 'Hidden TT' }]
  };

  it('reads the segment id from the inline efforts data', () => {
    const segments = extractSegments(parse(bootstrap(payload) + rows), '1');

    expect(segments.map(s => s.segmentId)).toEqual(['111', '222']);
    expect(segments[0].effortId).toBe('9000000000000000001');
  });

  it('finds the id of a hidden effort too', () => {
    const hiddenRow = `
      <table class="segments"><tbody>
        <tr data-segment-effort-id="9000000000000000003"><td class="name">Hidden TT</td></tr>
      </tbody></table>`;

    expect(extractSegments(parse(bootstrap(payload) + hiddenRow), '1')[0].segmentId).toBe('333');
  });

  it('does not depend on the second argument to reset()', () => {
    const segments = extractSegments(parse(bootstrap(payload, ');') + rows), '1');
    expect(segments.map(s => s.segmentId)).toEqual(['111', '222']);
  });

  it('leaves the id null, without throwing, when the inline data is unreadable', () => {
    const broken = '<script>pageView.segmentEfforts().reset({"efforts": [ oops</script>';
    const segments = extractSegments(parse(broken + rows), '1');

    expect(segments).toHaveLength(2);
    expect(segments.map(s => s.segmentId)).toEqual([null, null]);
  });

  it('never mistakes an effort link for a segment id', () => {
    // /activities/{activity}/segments/{effort} is an effort page; its number is
    // an effort id, and fetching /segments/{that} would be a different segment.
    const html = `
      <table class="segments"><tbody>
        <tr data-segment-effort-id="5">
          <td><a href="/activities/1/segments/5">Effort link only</a></td>
          <td>2:00</td>
        </tr>
      </tbody></table>`;

    expect(extractSegments(parse(html), '1')[0].segmentId).toBeNull();
  });
});

describe('extractAthleteName', () => {
  it('prefers the athlete profile link', () => {
    const doc = parse('<a class="minimal" href="/athletes/42">Ada Lovelace</a>');
    expect(extractAthleteName(doc)).toBe('Ada Lovelace');
  });

  it('falls back to the OpenGraph description', () => {
    const doc = parse(
      '<meta property="og:description" content="Ada Lovelace rode 56.8 km on Strava">'
    );
    expect(extractAthleteName(doc)).toBe('Ada Lovelace');
  });

  it('returns null when the page exposes nothing usable', () => {
    expect(extractAthleteName(parse('<div></div>'))).toBeNull();
  });
});

describe('extractActivityStats', () => {
  it('reads label/value pairs from a stats table', () => {
    const doc = parse(`
      <div class="section more-stats">
        <table>
          <tr><td>Distance</td><td>56.78 km</td></tr>
          <tr><td>Moving Time</td><td>2:26:05</td></tr>
        </table>
      </div>`);

    expect(extractActivityStats(doc)).toEqual([
      { label: 'Distance', value: '56.78 km' },
      { label: 'Moving Time', value: '2:26:05' }
    ]);
  });

  it('swaps a value/label pair back into the right order', () => {
    const doc = parse(`
      <div class="section more-stats">
        <table><tr><td>126 W</td><td>Estimated Avg Power</td></tr></table>
      </div>`);

    expect(extractActivityStats(doc)).toEqual([
      { label: 'Estimated Avg Power', value: '126 W' }
    ]);
  });

  it('ignores everything outside the more-stats section', () => {
    const doc = parse('<div class="other"><table><tr><td>Distance</td><td>5 km</td></tr></table></div>');
    expect(extractActivityStats(doc)).toEqual([]);
  });
});

describe('extractActivityData', () => {
  it('assembles the full payload', () => {
    const doc = parse(`
      <title>Morning Ride | Strava</title>
      <a class="minimal" href="/athletes/42">Ada Lovelace</a>
      ${rideSegments}`);

    const data = extractActivityData(doc, 'https://www.strava.com/activities/12345');
    expect(data.activityId).toBe('12345');
    expect(data.athleteName).toBe('Ada Lovelace');
    expect(data.segments).toHaveLength(2);
  });

  it('throws when the page has no segments, so callers can retry', () => {
    const doc = parse('<div>loading…</div>');
    expect(() => extractActivityData(doc, 'https://www.strava.com/activities/1')).toThrow(/no segments/i);
  });
});

describe('hasSegments', () => {
  it('reports whether the segments table has rendered yet', () => {
    expect(hasSegments(parse(rideSegments))).toBe(true);
    expect(hasSegments(parse('<div></div>'))).toBe(false);
  });
});

describe('segment distance and power', () => {
  it('reads them from their own classes', () => {
    const doc = parse(`
      <table class="segments"><tbody>
        <tr data-segment-effort-id="1">
          <td class="name"><a href="/segments/9">Climb</a></td>
          <td class="distance">1.24 km</td>
          <td class="time">5:00</td>
          <td class="power">241 W</td>
        </tr>
      </tbody></table>
    `);

    expect(extractSegments(doc, '1')[0]).toMatchObject({ distance: '1.24 km', power: '241 W' });
  });

  it('falls back to matching the cell contents when the classes are missing', () => {
    const doc = parse(`
      <table class="segments"><tbody>
        <tr data-segment-effort-id="1">
          <td><a href="/segments/9">Climb</a></td>
          <td>1.24 km</td>
          <td>128 m</td>
          <td>5:00</td>
          <td>241 W</td>
        </tr>
      </tbody></table>
    `);

    const segment = extractSegments(doc, '1')[0];
    // "128 m" is the elevation column and must not be read as the distance.
    expect(segment.distance).toBe('1.24 km');
    expect(segment.power).toBe('241 W');
  });

  it('reads distance from the stats line under the name, as Strava serves it', () => {
    // Labels are localized ("Distance", "距离"), so only the value can be trusted.
    const doc = parse(`
      <table class="segments"><tbody>
        <tr data-segment-effort-id="1">
          <td class="name-col">
            <div class="name">Climb</div>
            <div class="stats">
              <span title="Elevation difference"> 45<abbr class="unit"> m</abbr> </span>
              <span title="Distance"> 0.49<abbr class="unit"> km</abbr> </span>
              <span title="Average grade"> 9.7<abbr class="unit">%</abbr> </span>
            </div>
          </td>
          <td class="time-col">52<abbr class="unit">s</abbr></td>
        </tr>
      </tbody></table>
    `);

    expect(extractSegments(doc, '1')[0].distance).toBe('0.49 km');
  });

  it('leaves them null when the row has neither', () => {
    const segment = extractSegments(parse(rideSegments), '1')[0];

    expect(segment.distance).toBeNull();
    expect(segment.power).toBeNull();
  });
});

describe('personalRecordFromHistory', () => {
  // Shape of GET /athlete/segments/{id}/history: the signed-in athlete's
  // efforts on the segment, elapsed_time in whole seconds.
  const history = (...times) => ({ efforts: times.map((t, i) => ({ id: i, elapsed_time: t })) });

  it('takes the fastest elapsed time as the PR', () => {
    expect(personalRecordFromHistory(history(812, 754, 790))).toEqual({ time: '12:34' });
  });

  it('formats an hour-long PR with hours', () => {
    expect(personalRecordFromHistory(history(3754))).toEqual({ time: '1:02:34' });
  });

  it('pads seconds on a sub-minute PR', () => {
    expect(personalRecordFromHistory(history(46))).toEqual({ time: '0:46' });
  });

  it('skips efforts without a usable time', () => {
    const data = { efforts: [{ elapsed_time: null }, { elapsed_time: 0 }, { elapsed_time: '9' }, { elapsed_time: 61 }] };
    expect(personalRecordFromHistory(data)).toEqual({ time: '1:01' });
  });

  it('returns null when the athlete has no efforts on the segment', () => {
    expect(personalRecordFromHistory({ efforts: [] })).toBeNull();
    expect(personalRecordFromHistory(null)).toBeNull();
  });
});

describe('extractSegmentPersonalRecord', () => {
  it('reads an explicitly marked-up PR', () => {
    const doc = parse('<div data-testid="personal-record-time">12:34</div>');
    expect(extractSegmentPersonalRecord(doc)).toEqual({ time: '12:34' });
  });

  it('reads a PR from a labelled table row', () => {
    const doc = parse(`
      <table><tbody>
        <tr><td>Best 30 days</td><td>13:10</td></tr>
        <tr><td>Personal Record</td><td>12:34</td></tr>
      </tbody></table>
    `);

    expect(extractSegmentPersonalRecord(doc)).toEqual({ time: '12:34' });
  });

  it('reads a PR from a single run of text', () => {
    const doc = parse('<div><span>PR 1:02:34</span></div>');
    expect(extractSegmentPersonalRecord(doc)).toEqual({ time: '1:02:34' });
  });

  it('returns null rather than guessing when there is no PR on the page', () => {
    // Null means "unknown", which renders as N/A. It never means "no PR".
    expect(extractSegmentPersonalRecord(parse('<div>Log in to see your efforts</div>'))).toBeNull();
    expect(extractSegmentPersonalRecord(parse('<div>Leaderboard 9:12</div>'))).toBeNull();
  });
});
