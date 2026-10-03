// @vitest-environment jsdom
//
// Loads the real popup.html and popup.js into jsdom with a stubbed chrome API,
// so the wiring and the rendering path are exercised, not just the pure helpers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    runtime: {
      getManifest: () => JSON.parse(read('manifest.json')),
      connect: () => ({ postMessage: () => {}, onDisconnect: { addListener: () => {} } })
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

/** Run `download`, returning the CSV text it handed to the Blob. */
async function capturedCsv(download) {
  const captured = [];
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
  globalThis.Blob = class {
    constructor(parts) {
      captured.push(parts.join(''));
    }
  };
  HTMLAnchorElement.prototype.click = () => {};

  await download();
  return captured[0];
}

const row = (overrides = {}) => ({
  key: 'id:1#0',
  segmentId: '1',
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

  it('shows the version from the manifest, not one typed into the heading', () => {
    const { version } = JSON.parse(read('manifest.json'));
    expect(document.getElementById('version').textContent).toBe(version);
    expect(document.querySelector('h1').textContent).toContain(version);
  });

  it('omits the unmatched section when every segment paired up', () => {
    renderComparison({ matched: [row()], onlyIn1: [], onlyIn2: [] });
    expect(document.getElementById('unmatchedSection')).toBeNull();
  });

});

describe('the summary strip', () => {
  beforeEach(async () => {
    await loadPopup();
  });

  const named = (name, seconds) =>
    row({ name, time_diff: formatTimeDiff(seconds), time_diff_seconds: seconds });

  it('leads with the net gap and which way it went', () => {
    renderComparison({
      matched: [named('Climb', 90), named('Descent', -30)],
      onlyIn1: [],
      onlyIn2: []
    });

    const summary = document.getElementById('summarySection');
    expect(summary.querySelector('.summary-net').textContent).toBe('+1:00');
    expect(summary.querySelector('.summary-net').className).toContain('summary-net-loss');
    expect(summary.textContent).toContain('slower than');
    expect(summary.textContent).toContain('2 matched segments');
  });

  it('counts the segments won and lost', () => {
    renderComparison({
      matched: [named('A', 10), named('B', -10), named('C', 0)],
      onlyIn1: [],
      onlyIn2: []
    });

    expect(document.querySelector('.summary-counts').textContent).toContain('Faster on 1, slower on 1');
    expect(document.querySelector('.summary-counts').textContent).toContain('level on 1');
  });

  it('names the biggest losses and gains, worst first', () => {
    renderComparison({
      matched: [named('Small', 5), named('Huge', 300), named('Gain', -60)],
      onlyIn1: [],
      onlyIn2: []
    });

    const chips = [...document.querySelectorAll('.summary-chip-name')].map(el => el.textContent);
    expect(chips.slice(0, 2)).toEqual(['Huge', 'Small']);
    expect(chips).toContain('Gain');

    const gainChip = [...document.querySelectorAll('.summary-chip')].find(chip =>
      chip.textContent.startsWith('Gain')
    );
    expect(gainChip.className).toContain('summary-chip-gain');
  });

  it('renders a hostile segment name in the summary as text', () => {
    const hostile = '<img src=x onerror="globalThis.pwnedSummary = true">';
    renderComparison({ matched: [named(hostile, 30)], onlyIn1: [], onlyIn2: [] });

    const chip = document.querySelector('.summary-chip-name');
    expect(chip.textContent).toBe(hostile);
    expect(chip.querySelector('img')).toBeNull();
    expect(globalThis.pwnedSummary).toBeUndefined();
  });

  it('stays empty when nothing is comparable', () => {
    renderComparison({
      matched: [row({ time_diff: 'N/A', time_diff_seconds: null })],
      onlyIn1: [],
      onlyIn2: []
    });

    expect(document.getElementById('summarySection').children).toHaveLength(0);
  });

  it('charts the running total, one bar per comparable segment', () => {
    renderComparison({
      matched: [
        row({ name: 'Run-in', time_diff_seconds: 5 }),
        row({ name: 'The climb', time_diff_seconds: 70 }),
        row({ name: 'Unreadable', time_diff_seconds: null }),
        row({ name: 'Descent', time_diff_seconds: -20 })
      ],
      onlyIn1: [],
      onlyIn2: []
    });

    const bars = document.querySelectorAll('.delta-chart .delta-bar');
    expect(bars).toHaveLength(3);
    // Running totals of +5, +1:15, +0:55 — all behind, so all red.
    expect([...bars].every(bar => bar.classList.contains('delta-bar-loss'))).toBe(true);
    expect(bars[1].querySelector('title').textContent).toBe('The climb: +1:15 after this segment');
    expect(document.querySelector('.delta-chart').getAttribute('aria-label')).toContain('ending at +0:55');
  });

  it('draws a segment that puts the rider ahead below the line, in green', () => {
    renderComparison({
      matched: [
        row({ name: 'Sprint', time_diff_seconds: -30 }),
        row({ name: 'Climb', time_diff_seconds: 10 })
      ],
      onlyIn1: [],
      onlyIn2: []
    });

    const bars = document.querySelectorAll('.delta-chart .delta-bar');
    // Still ahead overall after the climb (-0:20), so both bars are gains.
    expect([...bars].map(bar => bar.classList.contains('delta-bar-gain'))).toEqual([true, true]);
    // A gain hangs below the zero line: the taller bar starts at the same y.
    expect(Number(bars[0].getAttribute('y'))).toBeCloseTo(Number(bars[1].getAttribute('y')), 1);
  });

  it('skips the chart when a single segment would make it pointless', () => {
    renderComparison({ matched: [row({ time_diff_seconds: 5 })], onlyIn1: [], onlyIn2: [] });
    expect(document.querySelector('.delta-chart')).toBeNull();
  });
});

describe('segments inside other segments', () => {
  const compare = async () => {
    await loadPopup();

    const segment = (id, name, time, span) => ({
      segmentId: id,
      occurrence: 0,
      name,
      link: 'https://www.strava.com/activities/1/segments/1',
      time,
      rate: '18.0 km/h',
      span,
      index: Number(id)
    });

    chrome.tabs.query = async () => [
      { id: 10, url: 'https://www.strava.com/activities/1' },
      { id: 20, url: 'https://www.strava.com/activities/2' }
    ];
    chrome.tabs.sendMessage = async tabId => ({
      ok: true,
      data: {
        activityId: tabId === 10 ? '1' : '2',
        athleteName: tabId === 10 ? 'Ada' : 'Ada, last spring',
        activityStats: [],
        segments:
          tabId === 10
            ? [
                segment('1', 'Full lap', '20:00', { start: 0, end: 1200 }),
                segment('2', 'The climb', '8:00', { start: 200, end: 680 }),
                segment('3', 'Run home', '5:00', { start: 1300, end: 1600 })
              ]
            : [
                segment('1', 'Full lap', '21:00', null),
                segment('2', 'The climb', '8:30', null),
                segment('3', 'Run home', '5:10', null)
              ]
      }
    });

    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    await compareActivities();
  };

  it('names the segment a nested one sits inside', async () => {
    await compare();
    expect(document.querySelector('.segment-nested').textContent).toBe('inside Full lap');
  });

  it('counts everything by default and recounts when the nested ones are left out', async () => {
    await compare();

    // +1:00 on the lap, +0:30 on the climb inside it, +0:10 on the run home.
    expect(document.querySelector('.summary-net').textContent).toBe('+1:40');

    const toggle = document.querySelector('.summary-toggle input');
    expect(document.querySelector('.summary-toggle').textContent).toContain('1 segment inside another');

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));

    expect(document.querySelector('.summary-net').textContent).toBe('+1:10');
    expect(document.querySelector('.summary-counts').textContent).toContain('1 nested left out');
    expect(document.querySelectorAll('.delta-chart .delta-bar')).toHaveLength(2);
    // The table still shows the whole ride.
    expect(document.querySelectorAll('#segmentsTableBody tr')).toHaveLength(3);
  });

  it('says in the log when Strava gave no positions to work from', async () => {
    await loadPopup();
    chrome.tabs.query = async () => [{ id: 10, url: 'https://www.strava.com/activities/1' }];
    chrome.tabs.sendMessage = async tabId => ({
      ok: true,
      data: {
        activityId: '1',
        athleteName: 'Ada',
        activityStats: [],
        segments: [1, 2].map(i => ({
          segmentId: String(i),
          occurrence: 0,
          name: `Segment ${i}`,
          link: 'https://www.strava.com/activities/1/segments/1',
          time: '5:00',
          rate: '18.0 km/h',
          span: null,
          index: i
        }))
      }
    });

    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    await compareActivities();

    expect(document.getElementById('logContent').textContent).toContain('carries no segment positions');
    expect(document.querySelector('.summary-toggle')).toBeNull();
  });
});

describe('reading the table without colour', () => {
  beforeEach(async () => {
    await loadPopup();
  });

  it('marks every shaded delta with an arrow as well as a tint', () => {
    renderComparison({
      matched: [
        row({
          time_diff: '-0:15',
          time_diff_seconds: -15,
          power_1: '220 W',
          power_2: '245 W',
          power_diff: '+25 W',
          power_diff_value: 25
        })
      ],
      onlyIn1: [],
      onlyIn2: []
    });

    const marks = [...document.querySelectorAll('#segmentsTableBody .diff-mark')];
    // Time, rate and power deltas: faster, faster, more watts.
    expect(marks.map(mark => mark.textContent)).toEqual(['\u25b2', '\u25b2', '\u25b2']);
    expect(marks.every(mark => mark.title === 'Better')).toBe(true);
    expect(marks[0].getAttribute('aria-label')).toBe('better');
  });

  it('says nothing about a delta of zero or one it could not read', () => {
    renderComparison({
      matched: [row({ time_diff: '0:00', time_diff_seconds: 0, rate_diff: 'N/A', rate_diff_value: null })],
      onlyIn1: [],
      onlyIn2: []
    });

    expect(document.querySelectorAll('#segmentsTableBody .diff-mark')).toHaveLength(0);
  });

  it('leaves the heart-rate delta unmarked, as it is unshaded', () => {
    renderComparison({
      matched: [row({ hr_1: '150 bpm', hr_2: '142 bpm', hr_diff: '-8 bpm', hr_diff_value: -8 })],
      onlyIn1: [],
      onlyIn2: []
    });

    const hrCell = [...document.querySelectorAll('#segmentsTableBody td')].find(
      td => td.firstChild.textContent === '-8 bpm'
    );
    expect(hrCell.querySelector('.diff-mark')).toBeNull();
  });
});

describe('opening the comparison in a tab', () => {
  it('opens the same page with the popup size limits lifted', async () => {
    await loadPopup();

    const opened = [];
    chrome.tabs.create = async options => {
      opened.push(options);
      return { id: 99 };
    };
    chrome.runtime.getURL = path => `chrome-extension://abc/${path}`;

    document.getElementById('openTabBtn').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(opened).toEqual([{ url: 'chrome-extension://abc/popup.html?view=tab' }]);
  });

  it('drops the clamps and its own button when it is the tab', async () => {
    const url = new URL(window.location.href);
    url.search = '?view=tab';
    window.history.replaceState({}, '', url);

    await loadPopup();

    expect(document.body.classList.contains('view-tab')).toBe(true);
    expect(document.getElementById('openTabBtn').classList.contains('hidden')).toBe(true);

    window.history.replaceState({}, '', url.pathname);
  });
});

describe('the results toolbar', () => {
  it('names each icon-only button, both aloud and in its tooltip', async () => {
    await loadPopup();

    ['exportBtn', 'prBtn', 'openTabBtn', 'clearBtn'].forEach(id => {
      const button = document.getElementById(id);
      expect(button.textContent.trim()).toBe('');
      expect(button.getAttribute('aria-label')).toBeTruthy();
      expect(button.dataset.tooltip).toBe(button.getAttribute('aria-label'));
    });
  });
});

describe('filtering the table', () => {
  const names = () =>
    [...document.querySelectorAll('#segmentsTableBody tr')].map(tr => tr.children[0].textContent);

  const type = text => {
    const input = document.getElementById('tableSearch');
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };

  // Driven through a real comparison: typing re-renders from the popup's own
  // state, as a header click does.
  beforeEach(async () => {
    await loadPopup();

    chrome.tabs.query = async () => [
      { id: 10, url: 'https://www.strava.com/activities/1' },
      { id: 20, url: 'https://www.strava.com/activities/2' }
    ];
    chrome.tabs.sendMessage = async tabId => ({
      ok: true,
      data: {
        activityId: tabId === 10 ? '1' : '2',
        athleteName: tabId === 10 ? 'Ada' : 'Grace',
        activityStats: [],
        segments: ['Old La Honda', 'Kings Mountain', 'Old La Honda (west)'].map((name, i) => ({
          segmentId: String(i),
          occurrence: 0,
          name,
          link: 'https://www.strava.com/activities/1/segments/1',
          time: `${5 + i}:00`,
          rate: '18.0 km/h',
          index: i
        }))
      }
    });

    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    await compareActivities();
  });

  it('narrows the table to the segments whose name matches', () => {
    type('la honda');
    expect(names()).toEqual(['Old La Honda', 'Old La Honda (west)']);

    type('');
    expect(names()).toHaveLength(3);
  });

  it('says how many of the segments are showing', () => {
    type('kings');
    expect(document.getElementById('filterCount').textContent).toBe('Showing 1 of 3 segments');
    expect(document.getElementById('filterCount').classList.contains('hidden')).toBe(false);

    type('');
    expect(document.getElementById('filterCount').classList.contains('hidden')).toBe(true);
  });

  it('leaves the summary describing the whole ride, not the search', () => {
    const net = document.querySelector('.summary-net').textContent;
    type('kings');

    expect(document.querySelector('.summary-net').textContent).toBe(net);
    expect(document.querySelectorAll('.delta-chart .delta-bar')).toHaveLength(3);
  });

  it('exports what the table is showing', async () => {
    type('kings');

    const csv = await capturedCsv(() => exportAsCSV());
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).toContain('"Kings Mountain"');
    expect(csv).not.toContain('"Old La Honda"');
  });

  it('starts a fresh comparison unfiltered', async () => {
    type('kings');
    await compareActivities();

    expect(document.getElementById('tableSearch').value).toBe('');
    expect(names()).toHaveLength(3);
  });
});

describe('sorting by a column header', () => {
  const clickHeader = label => {
    const th = [...document.querySelectorAll('#segmentsTable thead th')].find(el =>
      el.textContent.startsWith(label)
    );
    th.click();
    return th;
  };

  const names = () =>
    [...document.querySelectorAll('#segmentsTableBody tr')].map(tr => tr.children[0].textContent);

  // Driven through the real comparison rather than renderComparison(), because
  // a header click re-renders from the popup's own state.
  beforeEach(async () => {
    await loadPopup();

    const activity = times => ({
      activityId: '1',
      athleteName: 'Ada',
      activityStats: [],
      segments: ['Beta', 'Alpha', 'Gamma'].map((name, i) => ({
        segmentId: String(i),
        occurrence: 0,
        name,
        link: 'https://www.strava.com/activities/1/segments/1',
        time: times[i],
        rate: '18.0 km/h',
        index: i
      }))
    });

    chrome.tabs.query = async () => [
      { id: 10, url: 'https://www.strava.com/activities/1' },
      { id: 20, url: 'https://www.strava.com/activities/2' }
    ];
    chrome.tabs.sendMessage = async tabId => ({
      ok: true,
      data: tabId === 10 ? activity(['5:00', '4:00', '6:00']) : activity(['5:10', '3:30', '7:40'])
    });

    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    await compareActivities();
  });

  it('starts in activity 1 page order, which is course order', () => {
    expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('sorts biggest loss first on the first click', () => {
    clickHeader('Time Diff');
    expect(names()).toEqual(['Gamma', 'Beta', 'Alpha']);
  });

  it('reverses when the same header is clicked again', () => {
    clickHeader('Time Diff');
    clickHeader('Time Diff');
    expect(names()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('marks the sorted column for assistive tech', () => {
    const th = clickHeader('Time Diff');
    const sorted = [...document.querySelectorAll('#segmentsTable thead th')].find(el =>
      el.textContent.startsWith('Time Diff')
    );

    expect(th.getAttribute('role')).toBe('button');
    expect(sorted.getAttribute('aria-sort')).toBe('descending');
    expect(sorted.querySelector('.sort-arrow').textContent).toBe('▼');
  });
});

describe('power columns', () => {
  beforeEach(async () => {
    await loadPopup();
  });

  it('are hidden when neither activity recorded power', () => {
    renderComparison({ matched: [row()], onlyIn1: [], onlyIn2: [] });

    const headers = [...document.querySelectorAll('#segmentsTable thead th')].map(th => th.textContent);
    expect(headers.some(h => h.includes('Power'))).toBe(false);
  });

  it('appear as soon as one segment has a power reading', () => {
    renderComparison({
      matched: [row({ power_1: '220 W', power_2: '245 W', power_diff: '+25 W', power_diff_value: 25 })],
      onlyIn1: [],
      onlyIn2: []
    });

    const headers = [...document.querySelectorAll('#segmentsTable thead th')].map(th => th.textContent);
    expect(headers).toContain('Power Diff');

    const cells = [...document.querySelectorAll('#segmentsTableBody tr td')];
    const diff = cells.find(td => td.firstChild.textContent === '+25 W');
    expect(diff.querySelector('.diff-mark').textContent).toBe('\u25b2');
  });

  it('shows the segment distance under its name', () => {
    renderComparison({ matched: [row({ distance: '5.7 km' })], onlyIn1: [], onlyIn2: [] });

    expect(document.querySelector('.segment-distance').textContent).toBe('5.7 km');
  });

  it('adds the average grade next to the distance', () => {
    renderComparison({ matched: [row({ distance: '0.49 km', grade: 9.68 })], onlyIn1: [], onlyIn2: [] });

    expect(document.querySelector('.segment-distance').textContent).toBe('0.49 km · 9.7%');
  });
});

describe('heart rate, VAM and medals', () => {
  beforeEach(async () => {
    await loadPopup();
  });

  const headers = () => [...document.querySelectorAll('#segmentsTable thead th')].map(th => th.textContent);
  const cells = () => [...document.querySelectorAll('#segmentsTableBody tr td')];

  it('shows heart-rate columns only when an activity recorded heart rate', () => {
    renderComparison({ matched: [row()], onlyIn1: [], onlyIn2: [] });
    expect(headers().some(h => h.startsWith('HR'))).toBe(false);

    renderComparison({
      matched: [row({ hr_1: '150 bpm', hr_2: '155 bpm', hr_diff: '+5 bpm', hr_diff_value: 5 })],
      onlyIn1: [],
      onlyIn2: []
    });
    expect(headers()).toContain('HR Diff');
    expect(cells().map(td => td.textContent)).toContain('+5 bpm');
  });

  it('reads the time change against the heart-rate change in a Form column', () => {
    renderComparison({ matched: [row()], onlyIn1: [], onlyIn2: [] });
    expect(headers()).not.toContain('Form');

    renderComparison({
      matched: [
        row({
          hr_1: '150 bpm',
          hr_2: '142 bpm',
          hr_diff: '-8 bpm',
          hr_diff_value: -8,
          // 15 s faster on 8 fewer beats.
          quality: { key: 'fitness', label: 'Fitness', title: 'Faster at a lower heart rate' }
        })
      ],
      onlyIn1: [],
      onlyIn2: []
    });

    expect(headers()).toContain('Form');
    const badge = document.querySelector('.quality');
    expect(badge.textContent).toBe('Fitness');
    expect(badge.classList.contains('quality-fitness')).toBe(true);
    expect(badge.title).toBe('Faster at a lower heart rate');
  });

  it('explains the Form heading rather than telling it to sort', () => {
    renderComparison({
      matched: [row({ hr_1: '150 bpm', hr_diff_value: -8, quality: { key: 'even', label: 'Even', title: 'x' } })],
      onlyIn1: [],
      onlyIn2: []
    });

    const th = [...document.querySelectorAll('#segmentsTable thead th')].find(h => h.textContent === 'Form');
    expect(th.title).toContain('heart rate');
    expect(th.classList.contains('sortable')).toBe(true);
  });

  it('shows VAM columns for climbs, with a faster climb shaded green', () => {
    renderComparison({
      matched: [row({ vam_1: '800 m/h', vam_2: '960 m/h', vam_diff: '+160 m/h', vam_diff_value: 160 })],
      onlyIn1: [],
      onlyIn2: []
    });

    expect(headers()).toContain('VAM Diff');
    const diff = cells().find(td => td.firstChild.textContent === '+160 m/h');
    expect(diff.style.backgroundColor).toContain('34, 197, 94');
    expect(diff.querySelector('.diff-mark').textContent).toBe('\u25b2');
  });

  it("puts Strava's medal next to the effort's time", () => {
    renderComparison({
      matched: [row({ achievement_1: { label: 'PR', description: 'Personal Record' } })],
      onlyIn1: [],
      onlyIn2: []
    });

    const medal = document.querySelector('#segmentsTableBody .medal');
    expect(medal.textContent).toBe('PR');
    expect(medal.title).toBe('Personal Record');
    expect(medal.parentElement).toBe(cells()[1]);
  });

  it('shows the medal from a real comparison, and keeps it out of the exported time', async () => {
    const captured = [];
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.Blob = class {
      constructor(parts) {
        captured.push(parts.join(''));
      }
    };
    HTMLAnchorElement.prototype.click = () => {};

    chrome.tabs.query = async () => [
      { id: 10, url: 'https://www.strava.com/activities/1' },
      { id: 20, url: 'https://www.strava.com/activities/2' }
    ];
    chrome.tabs.sendMessage = async tabId => ({
      ok: true,
      data: {
        activityId: tabId === 10 ? '1' : '2',
        athleteName: tabId === 10 ? 'Ada' : 'Grace',
        activityStats: [],
        segments: [{
          segmentId: '1',
          name: 'Climb',
          link: 'https://www.strava.com/activities/1/segments/1',
          time: '5:00',
          rate: '18.0 km/h',
          achievement: tabId === 10 ? { sprite: 'icon-at-pr-1', description: 'Personal Record' } : null
        }]
      }
    });
    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    await compareActivities();

    expect(document.querySelector('#segmentsTableBody .medal').textContent).toBe('PR');

    exportAsCSV();
    const [, first] = captured[0].split('\n');
    expect(first.split(',')[1]).toBe('"5:00"');
  });

  it('says in the summary that nested segments count more than once', () => {
    renderComparison({ matched: [row()], onlyIn1: [], onlyIn2: [] });
    expect(document.querySelector('.summary-note').textContent).toContain('counts in both');
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
    // The delta, then the arrow that repeats it without relying on colour.
    expect(rows[0].children[3].firstChild.textContent).toBe('+0:05');
    expect(rows[0].children[3].querySelector('.diff-mark').textContent).toBe('\u25bc');
    expect(rows[1].children[3].firstChild.textContent).toBe('-0:10');
    expect(rows[1].children[3].querySelector('.diff-mark').textContent).toBe('\u25b2');
  });

  it('shows the activity stats panels', () => {
    const stats = document.getElementById('activityStatsSection');
    expect(stats).not.toBeNull();
    expect(stats.textContent).toContain('Distance');
  });

  it('exports the visible columns in the visible order', async () => {
    const captured = [];
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.Blob = class {
      constructor(parts) {
        captured.push(parts.join(''));
      }
    };
    HTMLAnchorElement.prototype.click = () => {};

    // Sorting the table sorts the export too, so the CSV matches what was seen.
    [...document.querySelectorAll('#segmentsTable thead th')]
      .find(th => th.textContent.startsWith('Time Diff'))
      .click();
    exportAsCSV();

    const [, first] = captured[0].split('\n');
    expect(first).toContain('"Mile 1"');
  });

  it('keeps the direction arrows out of the CSV', async () => {
    const csv = await capturedCsv(() => exportAsCSV());

    expect(csv).toContain('"+0:05"');
    expect(csv).not.toContain('\u25b2');
    expect(csv).not.toContain('\u25bc');
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

describe('comparing two activities by the same athlete', () => {
  const ride = (activityId, athleteName, time) => ({
    activityId,
    athleteName,
    activityStats: [{ label: 'Distance', value: '10.0 km' }],
    segments: [
      { segmentId: '100', occurrence: 0, name: 'Climb', time, rate: '18.0 km/h' },
      { segmentId: '101', occurrence: 0, name: 'Descent', time: '2:00', rate: '40.0 km/h' }
    ]
  });

  const compare = async (name1, name2) => {
    await loadPopup();
    chrome.tabs.query = async () => [
      { id: 10, url: 'https://www.strava.com/activities/1' },
      { id: 20, url: 'https://www.strava.com/activities/2' }
    ];
    chrome.tabs.sendMessage = async (tabId, request) =>
      request.action === 'ping'
        ? { ok: true }
        : { ok: true, data: tabId === 10 ? ride('1', name1, '5:00') : ride('2', name2, '5:10') };
    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    await compareActivities();
  };

  const headers = () => [...document.querySelectorAll('#segmentsTable thead th')].map(th => th.textContent);

  it('tells the two columns apart by activity number, not the shared name', async () => {
    // Two of your own rides is the most common comparison of all.
    await compare('Ada Lovelace', 'Ada Lovelace');

    expect(headers()).toContain('Time (Activity 1)');
    expect(headers()).toContain('Time (Activity 2)');
    expect(headers().join()).not.toContain('Ada Lovelace');
  });

  it('says which activity was slower in the summary', async () => {
    await compare('Ada Lovelace', 'Ada Lovelace');

    expect(document.querySelector('.summary-caption').textContent).toBe(
      'Activity 2 slower than Activity 1 across 2 matched segments'
    );
  });

  it('heads the stats panels and the CSV the same way', async () => {
    await compare('Ada Lovelace', 'Ada Lovelace');

    const panels = [...document.querySelectorAll('#activityStatsSection h3')].map(h => h.textContent);
    expect(panels).toEqual(['Activity 1', 'Activity 2']);

    const csv = await capturedCsv(() => exportAsCSV());
    expect(csv.split('\n')[0]).toContain('"Time (Activity 1)","Time (Activity 2)"');
  });

  it('treats names that differ only in case or spacing as the same athlete', async () => {
    await compare('Ada Lovelace', ' ada  lovelace ');

    expect(headers()).toContain('Time (Activity 1)');
    expect(headers()).toContain('Time (Activity 2)');
  });

  it('keeps the names when the athletes differ', async () => {
    await compare('Ada Lovelace', 'Grace Hopper');

    expect(headers()).toContain('Time (Ada Lovelace)');
    expect(headers()).toContain('Time (Grace Hopper)');
  });
});

describe('comparing two activities when no Strava tab is open', () => {
  let opened;
  let removed;
  let reported;
  let intervals;

  beforeEach(async () => {
    await loadPopup();
    opened = {};
    removed = [];
    reported = [];
    intervals = { started: [], cleared: [] };

    let nextTabId = 40;
    chrome.runtime.connect = ({ name }) => ({
      postMessage: message => reported.push({ name, tabIds: message.tabIds }),
      onDisconnect: { addListener: () => {} }
    });
    chrome.tabs.query = async () => [];
    chrome.tabs.create = async ({ url, active }) => {
      const id = nextTabId++;
      opened[id] = { url, active };
      return { id };
    };
    chrome.tabs.remove = async tabId => {
      removed.push(tabId);
    };
    chrome.tabs.sendMessage = async (tabId, request) => {
      if (request.action === 'ping') return { ok: true };
      const activityId = opened[tabId].url.split('/').pop();
      return {
        ok: true,
        data: {
          activityId,
          athleteName: activityId === '1' ? 'Ada' : 'Grace',
          activityStats: [],
          segments: [{ segmentId: '100', occurrence: 0, name: 'Climb', time: activityId === '1' ? '5:00' : '5:10' }]
        }
      };
    };

    const { setInterval: realSet, clearInterval: realClear } = globalThis;
    globalThis.setInterval = (fn, ms) => {
      const handle = realSet(fn, ms);
      intervals.started.push({ handle, ms });
      return handle;
    };
    globalThis.clearInterval = handle => {
      intervals.cleared.push(handle);
      realClear(handle);
    };

    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    try {
      await compareActivities();
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });

  it('reads each activity in a background tab, then closes it', () => {
    expect(Object.values(opened).map(tab => tab.url).sort()).toEqual([
      'https://www.strava.com/activities/1',
      'https://www.strava.com/activities/2'
    ]);
    expect(Object.values(opened).every(tab => tab.active === false)).toBe(true);
    expect(removed.sort()).toEqual([40, 41]);
    expect(document.getElementById('status').textContent).toBe('Successfully compared 1 segments');
  });

  it('keeps the service worker told which tabs are open, so they close even if the popup does first', () => {
    expect(reported.every(message => message.name === 'workTabs')).toBe(true);
    // Both were reported while open, and the list was empty again at the end.
    expect(reported.some(message => message.tabIds.includes(40))).toBe(true);
    expect(reported.some(message => message.tabIds.includes(41))).toBe(true);
    expect(reported.at(-1).tabIds).toEqual([]);
  });

  it('keeps the service worker awake only while a tab is open', () => {
    expect(intervals.started).toHaveLength(1);
    expect(intervals.started[0].ms).toBeLessThan(30000);
    expect(intervals.cleared).toEqual([intervals.started[0].handle]);
  });
});

describe('comparing against your personal records', () => {
  let sent;

  const setup = async (prBySegmentId, overrides = {}) => {
    await loadPopup();
    sent = [];

    chrome.tabs.query = async () => [
      { id: 10, url: 'https://www.strava.com/activities/1' },
      { id: 20, url: 'https://www.strava.com/activities/2' }
    ];
    chrome.tabs.create = async () => {
      throw new Error('should not need a new tab when strava is already open');
    };
    chrome.tabs.sendMessage = async (tabId, request) => {
      sent.push(request);

      if (request.action === 'fetchSegmentHistory') {
        if (overrides.failOn === request.segmentId) throw new Error('network boom');
        const time = prBySegmentId[request.segmentId];
        const times = (overrides.historyTimes || {})[request.segmentId] || null;
        return {
          ok: true,
          pr: time ? { time } : null,
          times,
          effortCount: times ? overrides.effortCount || times.length : null,
          historyError: overrides.historyError
        };
      }

      const segments = times => ({
        activityId: '1',
        athleteName: tabId === 10 ? 'Ada' : 'Grace',
        activityStats: [],
        segments: times.map((time, i) => ({
          segmentId: overrides.noIds ? null : overrides.laps ? '100' : String(100 + i),
          occurrence: overrides.laps ? i : 0,
          name: `Climb ${i + 1}`,
          link: 'https://www.strava.com/activities/1/segments/1',
          time,
          rate: '18.0 km/h',
          index: i
        }))
      });

      const times1 = overrides.times1 || ['5:00', '4:00'];
      const times2 = overrides.times2 || ['5:10', '3:50'];
      return { ok: true, data: tabId === 10 ? segments(times1) : segments(times2) };
    };

    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = 'https://www.strava.com/activities/2';
    await compareActivities();
  };

  const headers = () =>
    [...document.querySelectorAll('#segmentsTable thead th')].map(th => th.textContent);

  it('adds the PR columns and compares activity 1 against them', async () => {
    await setup({ 100: '4:30', 101: '4:10' });
    await loadPersonalRecords();

    expect(headers()).toContain('Your PR');
    expect(headers()).toContain('vs PR (Ada)');

    const first = document.querySelectorAll('#segmentsTableBody tr')[0];
    expect([...first.children].at(-2).textContent).toBe('4:30');
    // Slower than the PR, so the arrow agrees with the red tint.
    expect([...first.children].at(-1).firstChild.textContent).toBe('+0:30');
    expect([...first.children].at(-1).querySelector('.diff-mark').textContent).toBe('\u25bc');
  });

  it('shows a negative diff when the effort was itself a new PR', async () => {
    await setup({ 100: '4:30', 101: '4:10' });
    await loadPersonalRecords();

    // Climb 2 was ridden in 4:00 against a stored PR of 4:10.
    const second = document.querySelectorAll('#segmentsTableBody tr')[1];
    expect([...second.children].at(-1).firstChild.textContent).toBe('-0:10');
    expect([...second.children].at(-1).querySelector('.diff-mark').textContent).toBe('\u25b2');
  });

  it('fetches each segment once and reuses the cache on the next click', async () => {
    await setup({ 100: '4:30', 101: '4:10' });

    await loadPersonalRecords();
    const firstPass = sent.filter(r => r.action === 'fetchSegmentHistory').length;

    await loadPersonalRecords();
    const total = sent.filter(r => r.action === 'fetchSegmentHistory').length;

    expect(firstPass).toBe(2);
    expect(total).toBe(2);
  });

  it('saves what it has read while the run is still going', async () => {
    // The popup dies the instant the user clicks away, taking the run with it.
    // Storing only at the end would throw away half a minute of requests.
    const times = ['5:00', '4:00', '3:00', '2:00', '1:00', '0:50'];
    await setup(
      { 100: '4:30', 101: '4:10', 102: '2:55', 103: '1:58', 104: '0:59', 105: '0:45' },
      { times1: times, times2: times }
    );

    const sizes = [];
    const set = chrome.storage.local.set;
    chrome.storage.local.set = async values => {
      if (values.segmentHistoryCache) sizes.push(Object.keys(values.segmentHistoryCache).length);
      return set(values);
    };

    await loadPersonalRecords();

    // Written at the flush boundary, not once at the end.
    expect(sizes[0]).toBe(5);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.at(-1)).toBe(6);
  });

  it('keeps going when one segment fails, and does not retry it straight away', async () => {
    await setup({ 100: '4:30', 101: '4:10' }, { failOn: '101' });
    await loadPersonalRecords();

    const rows = document.querySelectorAll('#segmentsTableBody tr');
    expect([...rows[0].children].at(-2).textContent).toBe('4:30');
    expect([...rows[1].children].at(-2).textContent).toBe('N/A');

    await loadPersonalRecords();
    expect(sent.filter(r => r.action === 'fetchSegmentHistory').length).toBe(2);
  });

  describe('as time passes', () => {
    const realNow = Date.now;
    let now;

    beforeEach(() => {
      now = realNow();
      Date.now = () => now;
    });
    afterEach(() => {
      Date.now = realNow;
    });

    const historyRequests = () => sent.filter(r => r.action === 'fetchSegmentHistory').map(r => r.segmentId);

    it('retries a failed segment after ten minutes, not a day', async () => {
      // A rate limit or a network blip is gone in minutes; N/A for a day is not.
      await setup({ 100: '4:30', 101: '4:10' }, { failOn: '101' });
      await loadPersonalRecords();

      now += 11 * 60 * 1000;
      await loadPersonalRecords();

      // Only the failed one is asked for again.
      expect(historyRequests()).toEqual(['100', '101', '101']);
    });

    it('retries soon when only the segment page could be read', async () => {
      // The PR is there, but the history behind it (and "My Activities") is not.
      await setup({ 100: '4:30', 101: '4:10' }, { historyError: 'Strava returned HTTP 429' });
      await loadPersonalRecords();

      now += 11 * 60 * 1000;
      await loadPersonalRecords();

      expect(historyRequests()).toHaveLength(4);
    });

    it('keeps a segment that was read properly for a day', async () => {
      await setup({ 100: '4:30', 101: '4:10' });
      await loadPersonalRecords();

      now += 23 * 60 * 60 * 1000;
      await loadPersonalRecords();
      expect(historyRequests()).toHaveLength(2);

      now += 2 * 60 * 60 * 1000;
      await loadPersonalRecords();
      expect(historyRequests()).toHaveLength(4);
    });
  });

  it('asks for a fresh comparison, rather than fetching, when no segment has an id', async () => {
    // What a comparison saved by 2.6 looks like: it could not read segment ids.
    await setup({ 100: '4:30' }, { noIds: true });
    await loadPersonalRecords();

    expect(sent.filter(r => r.action === 'fetchSegmentHistory')).toHaveLength(0);
    expect(document.getElementById('status').textContent).toContain('click "Compare Activities" again');
  });

  it('counts segments, not laps, when reporting how many PRs it found', async () => {
    // Two laps of one segment are two rows but one PR.
    await setup({ 100: '3:45' }, { laps: true });
    await loadPersonalRecords();

    expect(document.getElementById('status').textContent).toBe('Found your PR for 1 of 1 segments');
  });

  it('draws your history on the segment, from the same lookup as the PR', async () => {
    const history = {
      100: [{ date: '2026-01-01T07:00:00Z', seconds: 290 }, { date: '2026-02-01T07:00:00Z', seconds: 300 }],
      101: [{ date: '2026-01-01T07:00:00Z', seconds: 250 }, { date: '2026-02-01T07:00:00Z', seconds: 240 }]
    };
    await setup({ 100: '4:30', 101: '4:10' }, { historyTimes: history });
    await loadPersonalRecords();

    expect(headers()).toContain('Your history');

    const first = document.querySelectorAll('#segmentsTableBody tr')[0];
    const cell = [...first.children].at(-1);
    // Activity 1 rode 5:00 (300 s), which one earlier effort of 4:50 beat.
    expect(cell.querySelector('.history-rank').textContent).toBe('2nd of 2');
    expect(cell.querySelector('polyline.spark-line').getAttribute('points').split(' ')).toHaveLength(2);
    expect(cell.title).toContain('Best: 4:50');

    // No extra requests: the history rides along with the PR lookup.
    expect(sent.filter(r => r.action === 'fetchSegmentHistory')).toHaveLength(2);
  });

  it('marks your fastest effort on the sparkline, however the times run', async () => {
    const rising = [{ seconds: 300 }, { seconds: 280 }, { seconds: 310 }];
    await setup({ 100: '4:30' }, { historyTimes: { 100: rising } });
    await loadPersonalRecords();

    const dot = document.querySelector('#segmentsTableBody tr circle.spark-best');
    // Fastest is the middle point of three: half way across, at the top.
    expect(Number(dot.getAttribute('cx'))).toBeCloseTo(35, 0);
    expect(Number(dot.getAttribute('cy'))).toBeCloseTo(2, 0);
  });

  it('exports the rank, not the drawing', async () => {
    const history = { 100: [{ seconds: 290 }, { seconds: 300 }] };
    await setup({ 100: '4:30' }, { historyTimes: history });
    await loadPersonalRecords();

    const csv = await capturedCsv(() => exportAsCSV());
    expect(csv.split('\n')[0]).toContain('"Your history"');
    expect(csv).toContain('"2nd of 2"');
    expect(csv).not.toContain('svg');
  });

  it('keeps the column hidden when Strava exposed no effort history', async () => {
    await setup({ 100: '4:30', 101: '4:10' });
    await loadPersonalRecords();

    expect(headers()).not.toContain('Your history');
  });

  it('logs once, with the reason, when PRs had to come from segment pages', async () => {
    await setup({ 100: '4:30', 101: '4:10' }, { historyError: 'Strava returned HTTP 403' });
    await loadPersonalRecords();

    const lines = [...document.querySelectorAll('#logContent .log-entry')]
      .map(el => el.textContent)
      .filter(text => text.includes('Effort history unavailable'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 segment(s) (Strava returned HTTP 403)');
  });

  it('leaves the table alone when Strava exposes no PR at all', async () => {
    await setup({});
    await loadPersonalRecords();

    expect(headers()).not.toContain('Your PR');
    expect(document.getElementById('status').textContent).toContain('No personal records found');
  });
});

describe('finding your other activities on these segments', () => {
  let sent;

  const ride = (activityId, name, date) => ({ activityId, name, date });
  // Activity 1 has segments 100-102. Your history on them mentions activity 7
  // on all three, 8 on two, 9 on one — and activity 1 itself.
  const recentBySegment = {
    100: [ride('7', 'Hill repeats', '2026-09-01T07:00:00Z'), ride('8', 'Easy spin', '2026-08-20T07:00:00Z'), ride('1', 'This one', '2026-09-10T07:00:00Z')],
    101: [ride('7', 'Hill repeats', '2026-09-01T07:00:00Z'), ride('9', 'Club ride', '2026-09-05T07:00:00Z')],
    102: [ride('7', 'Hill repeats', '2026-09-01T07:00:00Z'), ride('8', 'Easy spin', '2026-08-20T07:00:00Z')]
  };

  const efforts = (activityId, seconds) =>
    ['100', '101', '102'].map((segmentId, i) => ({
      id: `${activityId}00${i}`,
      segment_id: Number(segmentId),
      name: `Climb ${i + 1}`,
      elapsed_time_raw: seconds[i],
      avg_speed: '18.0 km/h'
    }));

  // A fetched activity page: Strava's efforts data and no table, like a run.
  const activityHtml = (activityId, seconds) =>
    `<title>Ride | Strava</title><script>pageView.segmentEfforts().reset(${JSON.stringify({
      efforts: efforts(activityId, seconds)
    })}, { parse: true });</script>`;

  const stub = ({ recent = recentBySegment, tabs } = {}) => {
    sent = [];
    chrome.tabs.query = async () => tabs || [{ id: 10, url: 'https://www.strava.com/activities/1' }];
    chrome.tabs.create = async () => {
      throw new Error('no new tabs expected');
    };
    chrome.tabs.sendMessage = async (tabId, request) => {
      sent.push({ tabId, ...request });
      if (tabId === 30) throw new Error('Could not establish connection. Receiving end does not exist.');
      if (request.action === 'ping') return { ok: true };
      if (request.action === 'fetchSegmentHistory') {
        return { ok: true, pr: { time: '4:00' }, recent: recent[request.segmentId] || [] };
      }
      if (request.action === 'fetchActivityHtml') {
        return { ok: true, html: activityHtml(request.activityId, [290, 350, 410]) };
      }
      const doc = new DOMParser().parseFromString(activityHtml('1', [300, 360, 420]), 'text/html');
      return { ok: true, data: extractActivityData(doc, 'https://www.strava.com/activities/1') };
    };
  };

  const options = () => [...document.querySelectorAll('#myActivitiesSection .activity-option')];
  const until = async condition => {
    for (let i = 0; i < 50 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  };

  beforeEach(async () => {
    await loadPopup();
    document.getElementById('activity1').value = 'https://www.strava.com/activities/1';
    document.getElementById('activity2').value = '';
  });

  it('lists them, most shared segments first, never the activity itself', async () => {
    stub();
    await findMyActivities();

    const texts = options().map(option => option.textContent);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('Hill repeats');
    expect(texts[0]).toContain('3 of 3 segments');
    expect(texts[1]).toContain('Easy spin');
    expect(texts[2]).toContain('Club ride');
    expect(texts.join()).not.toContain('This one');
  });

  it('fills activity 2 and compares when you pick one', async () => {
    stub();
    await findMyActivities();

    options()[0].click();
    await until(() => document.getElementById('status').textContent.startsWith('Successfully'));

    expect(document.getElementById('activity2').value).toBe('https://www.strava.com/activities/7');
    expect(document.getElementById('status').textContent).toBe('Successfully compared 3 segments');
    expect(document.querySelectorAll('#segmentsTableBody tr')).toHaveLength(3);
  });

  it('shares its lookups with Compare vs my PRs, so that costs no extra requests', async () => {
    stub();
    await findMyActivities();
    options()[0].click();
    await until(() => document.getElementById('status').textContent.startsWith('Successfully'));

    const before = sent.filter(r => r.action === 'fetchSegmentHistory').length;
    await loadPersonalRecords();

    expect(before).toBe(3);
    expect(sent.filter(r => r.action === 'fetchSegmentHistory')).toHaveLength(3);
    expect(document.getElementById('status').textContent).toBe('Found your PR for 3 of 3 segments');
  });

  it('says so when none of your other activities share these segments', async () => {
    stub({ recent: {} });
    await findMyActivities();

    expect(options()).toHaveLength(0);
    expect(document.getElementById('status').textContent).toContain('None of your other activities');
  });

  it('asks for activity 1 first', async () => {
    stub();
    document.getElementById('activity1').value = '';
    await findMyActivities();

    expect(sent).toHaveLength(0);
    expect(document.getElementById('status').textContent).toContain('Activity 1');
  });

  it('skips a Strava tab whose content script is gone, as after an extension update', async () => {
    stub({
      tabs: [
        { id: 30, url: 'https://www.strava.com/dashboard' },
        { id: 10, url: 'https://www.strava.com/activities/1' }
      ]
    });
    await findMyActivities();

    expect(options()).toHaveLength(3);
    // It may be asked whether it is alive, but is never given work.
    const toStaleTab = sent.filter(r => r.tabId === 30).map(r => r.action);
    expect(toStaleTab.length).toBeGreaterThan(0);
    expect(toStaleTab.every(action => action === 'ping')).toBe(true);
  });
});
