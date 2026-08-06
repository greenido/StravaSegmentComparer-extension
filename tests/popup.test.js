// @vitest-environment jsdom
//
// Loads the real popup.html and popup.js into jsdom with a stubbed chrome API,
// so the wiring and the rendering path are exercised, not just the pure helpers.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(join(root, name), 'utf8');

function stubChrome(overrides = {}) {
  const store = {};
  return {
    storage: {
      local: {
        get: async keys => {
          const result = {};
          [].concat(keys).forEach(key => {
            if (key in store) result[key] = store[key];
          });
          return result;
        },
        set: async values => Object.assign(store, values),
        remove: async keys => [].concat(keys).forEach(key => delete store[key])
      }
    },
    tabs: {
      query: async () => [],
      create: async () => ({ id: 1 }),
      remove: async () => {},
      sendMessage: async () => ({ ok: true })
    },
    ...overrides
  };
}

async function loadPopup() {
  const html = read('popup.html');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');

  document.body.innerHTML = body;
  globalThis.chrome = stubChrome();

  // Indirect eval runs these as classic scripts, matching how the popup loads
  // them, so their function declarations land on the global object.
  (0, eval)(read('utils.js'));
  (0, eval)(read('extractor.js'));
  (0, eval)(read('popup.js'));

  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 0));
}

const row = (overrides = {}) => ({
  key: 'id:1#0',
  name: 'Old La Honda',
  link: 'https://www.strava.com/activities/1/segments/11',
  time_1: '18:20',
  time_2: '18:05',
  time_diff: '-0:15',
  time_diff_seconds: -15,
  rate_1: '18.5 km/h',
  rate_2: '18.8 km/h',
  rate_diff: '+0.3 km/h',
  rate_diff_value: 0.3,
  rate_positive_is_faster: true,
  ...overrides
});

describe('popup rendering', () => {
  beforeEach(async () => {
    await loadPopup();
  });

  it('renders one table row per matched segment', () => {
    renderComparison({ matched: [row(), row({ name: 'Kings Mountain' })], onlyIn1: [], onlyIn2: [] });

    const rows = document.querySelectorAll('#segmentsTableBody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('a').textContent).toBe('Old La Honda');
    expect(rows[0].querySelector('a').href).toBe('https://www.strava.com/activities/1/segments/11');
  });

  it('treats a segment name containing markup as text', () => {
    // Segment names are attacker-controlled: anyone can name a public segment.
    const hostile = '<img src=x onerror="globalThis.pwned = true">';
    renderComparison({ matched: [row({ name: hostile })], onlyIn1: [], onlyIn2: [] });

    const cell = document.querySelector('#segmentsTableBody tr td');
    expect(cell.textContent).toBe(hostile);
    expect(cell.querySelector('img')).toBeNull();
    expect(globalThis.pwned).toBeUndefined();
  });

  it('refuses to link anywhere other than strava.com', () => {
    renderComparison({
      matched: [row({ link: 'javascript:globalThis.pwned = true' })],
      onlyIn1: [],
      onlyIn2: []
    });

    const cell = document.querySelector('#segmentsTableBody tr td');
    expect(cell.querySelector('a')).toBeNull();
    expect(cell.textContent).toBe('Old La Honda');
  });

  it('shades the time delta by its size in seconds, not by its digits', () => {
    // "-2:05" must shade harder than "-0:45"; parsing the label as a number
    // would rank them the other way round.
    renderComparison({
      matched: [
        row({ time_diff: '-0:45', time_diff_seconds: -45 }),
        row({ time_diff: '-2:05', time_diff_seconds: -125 })
      ],
      onlyIn1: [],
      onlyIn2: []
    });

    const alpha = index => {
      const cells = document.querySelectorAll('#segmentsTableBody tr');
      return parseFloat(cells[index].children[3].style.backgroundColor.match(/[\d.]+\)$/)[0]);
    };

    expect(alpha(1)).toBeGreaterThan(alpha(0));
  });

  it('colours a faster time green and a slower time red', () => {
    renderComparison({
      matched: [
        row({ time_diff: '-0:30', time_diff_seconds: -30 }),
        row({ time_diff: '+0:30', time_diff_seconds: 30 })
      ],
      onlyIn1: [],
      onlyIn2: []
    });

    const rows = document.querySelectorAll('#segmentsTableBody tr');
    expect(rows[0].children[3].style.backgroundColor).toContain('34, 197, 94');
    expect(rows[1].children[3].style.backgroundColor).toContain('220, 38, 38');
  });

  it('lists segments that only one activity has', () => {
    renderComparison({
      matched: [row()],
      onlyIn1: [{ name: 'Sprint' }],
      onlyIn2: [{ name: 'Descent' }, { name: 'Bridge' }]
    });

    const section = document.getElementById('unmatchedSection');
    expect(section).not.toBeNull();
    expect(section.textContent).toContain('1 segment only in');
    expect(section.textContent).toContain('2 segments only in');
    expect(section.textContent).toContain('Sprint');
    expect(section.textContent).toContain('Descent');
  });

  it('omits the unmatched section when every segment paired up', () => {
    renderComparison({ matched: [row()], onlyIn1: [], onlyIn2: [] });
    expect(document.getElementById('unmatchedSection')).toBeNull();
  });

});

describe('comparing two activities that are already open', () => {
  const runSegments = (athlete, times) => ({
    activityId: athlete === 'Ada' ? '1' : '2',
    athleteName: athlete,
    activityStats: [{ label: 'Distance', value: '10.0 km' }],
    segments: times.map((time, i) => ({
      segmentId: String(100 + i),
      occurrence: 0,
      name: `Mile ${i + 1}`,
      link: `https://www.strava.com/activities/1/segments/${i}`,
      time,
      rate: '5:30 /km',
      index: i
    }))
  });

  let createdTabs;

  beforeEach(async () => {
    await loadPopup();
    createdTabs = 0;

    chrome.tabs.query = async () => [
      { id: 10, url: 'https://www.strava.com/activities/1' },
      { id: 20, url: 'https://www.strava.com/activities/2' }
    ];
    chrome.tabs.create = async () => {
      createdTabs += 1;
      return { id: 99 };
    };
    chrome.tabs.sendMessage = async tabId => ({
      ok: true,
      data: tabId === 10 ? runSegments('Ada', ['5:00', '5:10']) : runSegments('Grace', ['5:05', '5:00'])
    });

    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';

    await compareActivities();
  });

  it('reads both activities without opening a tab', () => {
    expect(createdTabs).toBe(0);
  });

  it('labels the rate columns Pace and names them after the athletes', () => {
    const headers = [...document.querySelectorAll('#segmentsTable thead th')].map(th => th.textContent);

    expect(headers).toContain('Time (Ada)');
    expect(headers).toContain('Pace (Grace)');
    expect(headers).toContain('Pace Diff');
  });

  it('renders the matched segments with their deltas', () => {
    const rows = document.querySelectorAll('#segmentsTableBody tr');

    expect(rows).toHaveLength(2);
    expect(rows[0].children[3].textContent).toBe('+0:05');
    expect(rows[1].children[3].textContent).toBe('-0:10');
  });

  it('shows the activity stats panels', () => {
    const stats = document.getElementById('activityStatsSection');
    expect(stats).not.toBeNull();
    expect(stats.textContent).toContain('Distance');
  });

  it('exports a CSV with the athlete names in the headers', async () => {
    const captured = [];
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.Blob = class {
      constructor(parts) {
        captured.push(parts.join(''));
      }
    };
    HTMLAnchorElement.prototype.click = () => {};

    exportAsCSV();

    const [header, first] = captured[0].split('\n');
    expect(header).toContain('"Pace (Ada)"');
    expect(first).toBe('"Mile 1","5:00","5:05","+0:05","5:30 /km","5:30 /km","0:00 /km"');
  });
});
