// Loads background.js with a stubbed chrome API and plays the popup's side of
// the port, including going away mid-run.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let onConnect;
let removed;
let created;
let store;
let listeners;
let badge;
let menus;

/** A port as the service worker sees it, with the popup's end in our hands. */
function connect(name) {
  const listeners = { message: [], disconnect: [] };
  const port = {
    name,
    onMessage: { addListener: fn => listeners.message.push(fn) },
    onDisconnect: { addListener: fn => listeners.disconnect.push(fn) }
  };
  onConnect(port);

  return {
    send: message => listeners.message.forEach(fn => fn(message)),
    disconnect: () => listeners.disconnect.forEach(fn => fn())
  };
}

beforeEach(() => {
  removed = [];
  created = [];
  store = {};
  listeners = { installed: [], message: [], menu: [], storage: [] };
  badge = null;
  menus = {};

  // Storage that tells its listeners about changes, as Chrome's does.
  const notify = changes => listeners.storage.forEach(fn => fn(changes, 'local'));

  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: { addListener: fn => listeners.installed.push(fn) },
      onConnect: { addListener: fn => (onConnect = fn) },
      onMessage: { addListener: fn => listeners.message.push(fn) },
      getURL: path => `chrome-extension://abc/${path}`
    },
    tabs: {
      remove: async tabId => {
        removed.push(tabId);
      },
      create: async options => {
        created.push(options.url);
        return { id: 7 };
      }
    },
    storage: {
      local: {
        get: async key => (key in store ? { [key]: store[key] } : {}),
        set: async values => {
          const changes = {};
          Object.entries(values).forEach(([key, value]) => {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = value;
          });
          notify(changes);
        },
        remove: async key => {
          const changes = { [key]: { oldValue: store[key], newValue: undefined } };
          delete store[key];
          notify(changes);
        }
      },
      onChanged: { addListener: fn => listeners.storage.push(fn) }
    },
    contextMenus: {
      removeAll: done => {
        menus = {};
        done();
      },
      create: item => (menus[item.id] = { ...item }),
      update: (id, props, done) => {
        if (menus[id]) Object.assign(menus[id], props);
        if (done) done();
      },
      onClicked: { addListener: fn => listeners.menu.push(fn) }
    },
    action: {
      setBadgeText: ({ text }) => (badge = text),
      setBadgeBackgroundColor: () => {}
    }
  };
  (0, eval)(readFileSync(join(root, 'background.js'), 'utf8'));
});

describe('closing the tabs a popup left behind', () => {
  it('closes the tabs still open when the popup goes away', () => {
    const popup = connect('workTabs');
    popup.send({ tabIds: [41, 42] });

    popup.disconnect();

    expect(removed).toEqual([41, 42]);
  });

  it('leaves alone the tabs the popup closed itself', () => {
    const popup = connect('workTabs');
    popup.send({ tabIds: [41, 42] });
    popup.send({ tabIds: [42] });
    popup.send({ tabIds: [] });

    popup.disconnect();

    expect(removed).toEqual([]);
  });

  it('keeps each popup to its own tabs', () => {
    const popup = connect('workTabs');
    const tabView = connect('workTabs');
    popup.send({ tabIds: [41] });
    tabView.send({ tabIds: [51] });

    popup.disconnect();

    expect(removed).toEqual([41]);
  });

  it('ignores ports that are not for this', () => {
    const other = connect('somethingElse');
    other.send({ tabIds: [41] });

    other.disconnect();

    expect(removed).toEqual([]);
  });

  it('survives a tab that is already gone', async () => {
    chrome.tabs.remove = async () => {
      throw new Error('No tab with id: 41');
    };
    const popup = connect('workTabs');
    popup.send({ tabIds: [41] });

    expect(() => popup.disconnect()).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

describe('picking two activities on Strava', () => {
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  const message = request =>
    new Promise(resolve => {
      const async = listeners.message.map(fn => fn(request, {}, resolve));
      if (!async.some(Boolean)) resolve(undefined);
    });
  const clickMenu = info => listeners.menu.forEach(fn => fn(info));
  const install = async () => {
    listeners.installed.forEach(fn => fn());
    await settle();
  };

  it('waits after the first pick, then compares on the second, first pick as activity 1', async () => {
    expect(await message({ action: 'pickActivity', activityId: '111', label: 'Morning Ride' })).toEqual({
      ok: true,
      state: 'picked'
    });
    expect(store.pendingPick).toEqual({ activityId: '111', label: 'Morning Ride' });
    expect(created).toEqual([]);

    expect(await message({ action: 'pickActivity', activityId: '222', label: 'Evening Ride' })).toEqual({
      ok: true,
      state: 'comparing'
    });
    expect(created).toEqual(['chrome-extension://abc/popup.html?view=tab&compare=111,222']);
    expect(store.pendingPick).toBeUndefined();
  });

  it('never compares an activity with itself', async () => {
    await message({ action: 'pickActivity', activityId: '111' });
    await message({ action: 'pickActivity', activityId: '111' });

    expect(created).toEqual([]);
    expect(store.pendingPick.activityId).toBe('111');
  });

  it('refuses anything that is not an activity id', async () => {
    const response = await message({ action: 'pickActivity', activityId: '../settings' });
    expect(response.ok).toBe(false);
    expect(store.pendingPick).toBeUndefined();
  });

  it('keeps a long page title short', async () => {
    await message({ action: 'pickActivity', activityId: '111', label: 'x'.repeat(200) });
    expect(store.pendingPick.label).toHaveLength(60);
  });

  it('forgets the pick on cancel', async () => {
    await message({ action: 'pickActivity', activityId: '111' });
    await message({ action: 'cancelPick' });
    expect(store.pendingPick).toBeUndefined();
  });

  it('offers the same picking on activity links and pages', async () => {
    await install();
    expect(menus.compareActivityLink.targetUrlPatterns).toEqual(['https://www.strava.com/activities/*']);
    expect(menus.compareActivityPage.documentUrlPatterns).toEqual(['https://www.strava.com/activities/*']);

    clickMenu({ menuItemId: 'compareActivityLink', linkUrl: 'https://www.strava.com/activities/111' });
    await settle();
    clickMenu({ menuItemId: 'compareActivityPage', pageUrl: 'https://www.strava.com/activities/222/overview' });
    await settle();

    expect(created).toEqual(['chrome-extension://abc/popup.html?view=tab&compare=111,222']);
  });

  it('shows a waiting pick on the toolbar badge and in the menu', async () => {
    await install();
    expect(badge).toBe('');
    expect(menus.compareActivityLink.title).toBe('Pick this activity to compare');

    await message({ action: 'pickActivity', activityId: '111', label: 'Morning Ride' });
    expect(badge).toBe('1');
    expect(menus.compareActivityLink.title).toBe('Compare with Morning Ride');

    await message({ action: 'cancelPick' });
    expect(badge).toBe('');
  });
});
