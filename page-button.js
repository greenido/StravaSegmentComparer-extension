/**
 * A "Compare" button on Strava activity pages.
 *
 * Click it on one activity to pick it, then on another to compare the two: the
 * comparison opens in a tab of its own, with the first pick as activity 1. The
 * picking itself happens in the service worker (background.js), which the
 * right-click menu shares, so this file only draws the state stored there.
 *
 * The button sits in a shadow root, fixed to the corner of the window rather
 * than placed inside Strava's layout: nothing of Strava's markup is touched or
 * relied on, so a redesign of the page cannot break it, and Strava's styles
 * cannot leak into it.
 */
(() => {
  // Must match PENDING_PICK_KEY in background.js.
  const PENDING_PICK_KEY = 'pendingPick';

  const match = /^\/activities\/(\d+)\/?$/.exec(window.location.pathname);
  // Only the activity page itself; its sub-pages (a segment effort, the
  // analysis view) are not what anyone means by "this activity".
  if (!match || window.top !== window) return;
  const activityId = match[1];

  // "Morning Ride | Ride | Strava" -> "Morning Ride".
  const pageLabel = () => (document.title.split(' | ')[0] || '').trim() || `activity ${activityId}`;

  const host = document.createElement('div');
  host.id = 'strava-segment-comparator-button';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .bar {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      display: flex; align-items: center; gap: 4px;
      font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); border-radius: 999px;
      background: #fc4c02; color: #fff;
    }
    button {
      all: unset; cursor: pointer; padding: 9px 14px; border-radius: 999px;
      max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    button:hover { background: rgba(0, 0, 0, 0.12); }
    button:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
    .cancel { padding: 9px 12px 9px 6px; font-size: 15px; }
    .cancel[hidden] { display: none; }
  `;

  const bar = document.createElement('div');
  bar.className = 'bar';
  const main = document.createElement('button');
  main.type = 'button';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cancel';
  cancel.textContent = '\u00d7';
  cancel.title = 'Cancel the pick';
  cancel.setAttribute('aria-label', 'Cancel the pick');
  bar.append(main, cancel);
  root.append(style, bar);

  function render(pending) {
    // Labels come from page titles: text only, never markup.
    if (!pending) {
      main.textContent = '\u21c4 Compare\u2026';
      main.title = 'Pick this activity, then open another one and click Compare there';
      cancel.hidden = true;
    } else if (pending.activityId === activityId) {
      main.textContent = 'Picked \u2014 now open another activity';
      main.title = 'This activity will be activity 1';
      cancel.hidden = false;
    } else {
      main.textContent = `\u21c4 Compare with ${pending.label || `activity ${pending.activityId}`}`;
      main.title = 'Open the comparison in a new tab';
      cancel.hidden = false;
    }
  }

  main.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'pickActivity', activityId, label: pageLabel() }).catch(() => {});
  });
  cancel.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'cancelPick' }).catch(() => {});
  });

  // Every open activity tab follows the same pick, wherever it was made.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && PENDING_PICK_KEY in changes) render(changes[PENDING_PICK_KEY].newValue);
  });

  chrome.storage.local.get(PENDING_PICK_KEY).then(data => {
    render(data[PENDING_PICK_KEY]);
    (document.body || document.documentElement).appendChild(host);
  });
})();
