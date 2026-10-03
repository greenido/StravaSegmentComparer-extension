// Loads background.js with a stubbed chrome API and plays the popup's side of
// the port, including going away mid-run.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let onConnect;
let removed;

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
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onConnect: { addListener: fn => (onConnect = fn) }
    },
    tabs: {
      remove: async tabId => {
        removed.push(tabId);
      }
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
