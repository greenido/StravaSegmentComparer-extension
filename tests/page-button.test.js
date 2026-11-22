// @vitest-environment jsdom
//
// Loads page-button.js on a pretend Strava page with a stubbed chrome API.
// The button lives in a closed shadow root, so the tests reach it the way a
// user's click does: through attachShadow, captured as the script calls it.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'page-button.js'), 'utf8');

let shadow;
let sent;
let onChanged;
const realAttachShadow = Element.prototype.attachShadow;

async function load(path, { pending } = {}) {
  window.history.replaceState({}, '', path);
  document.title = 'Morning Ride | Ride | Strava';
  document.body.innerHTML = '';
  shadow = null;
  sent = [];
  onChanged = null;

  Element.prototype.attachShadow = function attachShadow(init) {
    shadow = realAttachShadow.call(this, { ...init, mode: 'open' });
    return shadow;
  };
  globalThis.chrome = {
    runtime: {
      sendMessage: async message => {
        sent.push(message);
        return { ok: true };
      }
    },
    storage: {
      local: { get: async () => (pending ? { pendingPick: pending } : {}) },
      onChanged: { addListener: fn => (onChanged = fn) }
    }
  };

  (0, eval)(source);
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

const buttons = () => [...shadow.querySelectorAll('button')];
const main = () => buttons()[0];
const cancel = () => buttons()[1];

afterEach(() => {
  Element.prototype.attachShadow = realAttachShadow;
  window.history.replaceState({}, '', '/');
});

describe('the Compare button on an activity page', () => {
  it('appears on an activity page and offers to pick it', async () => {
    await load('/activities/111');

    expect(document.getElementById('strava-segment-comparator-button')).not.toBeNull();
    expect(main().textContent).toBe('⇄ Compare…');
    expect(cancel().hidden).toBe(true);
  });

  it('stays off the pages under an activity', async () => {
    await load('/activities/111/segments/999');
    expect(document.getElementById('strava-segment-comparator-button')).toBeNull();
  });

  it('picks this activity, named by its title', async () => {
    await load('/activities/111');
    main().click();

    expect(sent).toEqual([{ action: 'pickActivity', activityId: '111', label: 'Morning Ride' }]);
  });

  it('says this is the waiting pick, with a way out', async () => {
    await load('/activities/111', { pending: { activityId: '111', label: 'Morning Ride' } });

    expect(main().textContent).toBe('Picked — now open another activity');
    cancel().click();
    expect(sent).toEqual([{ action: 'cancelPick' }]);
  });

  it('offers to compare with a pick made elsewhere', async () => {
    await load('/activities/222', { pending: { activityId: '111', label: 'Morning Ride' } });
    expect(main().textContent).toBe('⇄ Compare with Morning Ride');
  });

  it('follows a pick made in another tab', async () => {
    await load('/activities/222');
    onChanged({ pendingPick: { newValue: { activityId: '111', label: 'Evening Ride' } } }, 'local');
    expect(main().textContent).toBe('⇄ Compare with Evening Ride');

    onChanged({ pendingPick: { newValue: undefined } }, 'local');
    expect(main().textContent).toBe('⇄ Compare…');
  });

  it('shows a hostile title as text', async () => {
    await load('/activities/222', { pending: { activityId: '111', label: '<img src=x onerror="globalThis.pwned=1">' } });
    expect(shadow.querySelector('img')).toBeNull();
    expect(globalThis.pwned).toBeUndefined();
  });
});
