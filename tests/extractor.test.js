// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  extractActivityId,
  extractAthleteName,
  extractActivityStats,
  extractSegments,
  extractActivityData,
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
