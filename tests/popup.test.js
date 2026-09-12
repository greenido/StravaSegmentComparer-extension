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

    const cells = [...document.querySelectorAll('#segmentsTableBody tr td')].map(td => td.textContent);
    expect(cells).toContain('+25 W');
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

  it('shows VAM columns for climbs, with a faster climb shaded green', () => {
    renderComparison({
      matched: [row({ vam_1: '800 m/h', vam_2: '960 m/h', vam_diff: '+160 m/h', vam_diff_value: 160 })],
      onlyIn1: [],
      onlyIn2: []
    });

    expect(headers()).toContain('VAM Diff');
    const diff = cells().find(td => td.textContent === '+160 m/h');
    expect(diff.style.backgroundColor).toContain('34, 197, 94');
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
    expect(rows[0].children[3].textContent).toBe('+0:05');
    expect(rows[1].children[3].textContent).toBe('-0:10');
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

      if (request.action === 'fetchSegmentPr') {
        if (overrides.failOn === request.segmentId) throw new Error('network boom');
        const time = prBySegmentId[request.segmentId];
        return { ok: true, pr: time ? { time } : null, historyError: overrides.historyError };
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

      return { ok: true, data: tabId === 10 ? segments(['5:00', '4:00']) : segments(['5:10', '3:50']) };
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
    expect([...first.children].at(-1).textContent).toBe('+0:30');
  });

  it('shows a negative diff when the effort was itself a new PR', async () => {
    await setup({ 100: '4:30', 101: '4:10' });
    await loadPersonalRecords();

    // Climb 2 was ridden in 4:00 against a stored PR of 4:10.
    const second = document.querySelectorAll('#segmentsTableBody tr')[1];
    expect([...second.children].at(-1).textContent).toBe('-0:10');
  });

  it('fetches each segment once and reuses the cache on the next click', async () => {
    await setup({ 100: '4:30', 101: '4:10' });

    await loadPersonalRecords();
    const firstPass = sent.filter(r => r.action === 'fetchSegmentPr').length;

    await loadPersonalRecords();
    const total = sent.filter(r => r.action === 'fetchSegmentPr').length;

    expect(firstPass).toBe(2);
    expect(total).toBe(2);
  });

  it('keeps going when one segment fails, and does not retry it', async () => {
    await setup({ 100: '4:30', 101: '4:10' }, { failOn: '101' });
    await loadPersonalRecords();

    const rows = document.querySelectorAll('#segmentsTableBody tr');
    expect([...rows[0].children].at(-2).textContent).toBe('4:30');
    expect([...rows[1].children].at(-2).textContent).toBe('N/A');

    await loadPersonalRecords();
    expect(sent.filter(r => r.action === 'fetchSegmentPr').length).toBe(2);
  });

  it('asks for a fresh comparison, rather than fetching, when no segment has an id', async () => {
    // What a comparison saved by 2.6 looks like: it could not read segment ids.
    await setup({ 100: '4:30' }, { noIds: true });
    await loadPersonalRecords();

    expect(sent.filter(r => r.action === 'fetchSegmentPr')).toHaveLength(0);
    expect(document.getElementById('status').textContent).toContain('click "Compare Activities" again');
  });

  it('counts segments, not laps, when reporting how many PRs it found', async () => {
    // Two laps of one segment are two rows but one PR.
    await setup({ 100: '3:45' }, { laps: true });
    await loadPersonalRecords();

    expect(document.getElementById('status').textContent).toBe('Found your PR for 1 of 1 segments');
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
