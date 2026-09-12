// @vitest-environment jsdom
//
// Loads extractor.js and content-script.js as the manifest does, with a stubbed
// chrome API and fetch, and talks to the script through its message listener.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(join(root, name), 'utf8');

let listener;
let requests;

/** A fetch that serves `routes` by path and 404s everything else. */
function stubFetch(routes) {
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, headers: init.headers || {} });

    const route = routes[path];
    if (!route) return { ok: false, status: 404, url, json: async () => ({}), text: async () => '' };

    const body = route.text ?? JSON.stringify(route.json);
    return {
      ok: true,
      status: 200,
      url: route.redirectTo || url,
      json: async () => JSON.parse(body),
      text: async () => body
    };
  };
}

const send = request => new Promise(resolve => listener(request, {}, resolve));
const fetchPr = segmentId => send({ action: 'fetchSegmentPr', segmentId });

beforeEach(() => {
  globalThis.chrome = { runtime: { onMessage: { addListener: fn => (listener = fn) } } };
  (0, eval)(read('extractor.js'));
  (0, eval)(read('content-script.js'));
});

describe('fetchSegmentPr', () => {
  const historyPath = '/athlete/segments/42/history';

  it('reads the PR from the effort history without loading the segment page', async () => {
    stubFetch({ [historyPath]: { json: { efforts: [{ elapsed_time: 800 }, { elapsed_time: 754 }] } } });

    expect(await fetchPr('42')).toEqual({ ok: true, pr: { time: '12:34' } });
    expect(requests.map(r => r.path)).toEqual([historyPath]);
    expect(requests[0].headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('trusts an empty history as "no PR" and does not ask again', async () => {
    stubFetch({ [historyPath]: { json: { efforts: [] } } });

    expect(await fetchPr('42')).toEqual({ ok: true, pr: null });
    expect(requests).toHaveLength(1);
  });

  it('falls back to the segment page when the history endpoint fails', async () => {
    stubFetch({ '/segments/42': { text: '<div data-testid="personal-record-time">12:34</div>' } });

    expect(await fetchPr('42')).toEqual({
      ok: true,
      pr: { time: '12:34' },
      historyError: 'Strava returned HTTP 404'
    });
    expect(requests.map(r => r.path)).toEqual([historyPath, '/segments/42']);
  });

  it('falls back when the history comes back in a shape it does not recognise', async () => {
    stubFetch({
      [historyPath]: { json: { results: [] } },
      '/segments/42': { text: '<div data-testid="personal-record-time">12:34</div>' }
    });

    expect(await fetchPr('42')).toEqual({
      ok: true,
      pr: { time: '12:34' },
      historyError: 'unrecognised response'
    });
  });

  it('reports a signed-out session rather than a missing PR', async () => {
    const login = { text: '<html>Log in</html>', redirectTo: 'https://www.strava.com/login' };
    stubFetch({ [historyPath]: login, '/segments/42': login });

    const response = await fetchPr('42');
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not signed in/);
  });

  it('refuses to fetch anything but a numeric segment id', async () => {
    stubFetch({});

    const response = await fetchPr('42/../../settings');
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/Refusing/);
    expect(requests).toHaveLength(0);
  });
});
