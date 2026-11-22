// Background service worker for the Strava Segment Comparator extension.
//
// The popup talks to content scripts directly with request/response messaging,
// so the only job here is cleaning up after a popup that went away mid-run.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Strava Segment Comparator installed');
});

// Must match WORK_TABS_PORT in popup.js.
const WORK_TABS_PORT = 'workTabs';

/**
 * Close the background tabs a popup opened, if the popup goes away first.
 *
 * The popup opens a Strava tab when nothing it can use is open, and closes it
 * again in a `finally`. But a popup is destroyed the moment the user clicks
 * away, `finally` and all, so a tab opened half a minute into a PR lookup would
 * be left open for good. The popup keeps this side told which of its tabs are
 * still open, and a port disconnects when its page goes away, however that
 * happens.
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== WORK_TABS_PORT) return;

  // Each message is the whole list, so a popup that reconnects after this
  // worker was stopped only has to send it again.
  let tabIds = [];
  port.onMessage.addListener(message => {
    if (message && Array.isArray(message.tabIds)) tabIds = message.tabIds;
  });

  port.onDisconnect.addListener(() => {
    tabIds.forEach(tabId => chrome.tabs.remove(tabId).catch(() => {}));
  });
});

/* ------------------------------------------------------------------ *
 * Picking two activities from Strava's own pages
 *
 * The button on an activity page and the right-click menu both come here, so
 * they share one state: the activity picked first, waiting for a second. The
 * second pick opens the comparison in a tab of its own, with the first pick as
 * activity 1. The state lives in storage, so every tab's button shows it and
 * it survives this worker being stopped.
 * ------------------------------------------------------------------ */

// Must match PENDING_PICK_KEY in page-button.js.
const PENDING_PICK_KEY = 'pendingPick';
const ACTIVITY_URL_PATTERN = 'https://www.strava.com/activities/*';
const MENU_LINK = 'compareActivityLink';
const MENU_PAGE = 'compareActivityPage';

/** The activity id in a Strava activity URL, or null. */
function activityIdFromUrl(url) {
  const match = /^https:\/\/www\.strava\.com\/activities\/(\d+)/.exec(url || '');
  return match ? match[1] : null;
}

/**
 * Pick an activity. The first pick waits; a second, different one opens the
 * comparison and clears the pick. Picking the waiting activity again does
 * nothing, so a double click cannot compare an activity with itself.
 *
 * @returns {Promise<'picked'|'comparing'>}
 */
async function pickActivity(activityId, label) {
  if (!/^\d+$/.test(String(activityId || ''))) throw new Error('Not an activity id');

  const { [PENDING_PICK_KEY]: pending } = await chrome.storage.local.get(PENDING_PICK_KEY);
  if (!pending || pending.activityId === activityId) {
    // The label comes from a page title, so it is only ever shown as text,
    // and kept short enough for a menu.
    const shortLabel = label ? String(label).slice(0, 60) : null;
    await chrome.storage.local.set({ [PENDING_PICK_KEY]: { activityId, label: shortLabel } });
    return 'picked';
  }

  await chrome.storage.local.remove(PENDING_PICK_KEY);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`popup.html?view=tab&compare=${pending.activityId},${activityId}`)
  });
  return 'comparing';
}

/** The menu title and toolbar badge say whether a pick is waiting. */
function showPickState(pending) {
  const title = pending
    ? `Compare with ${pending.label || `activity ${pending.activityId}`}`
    : 'Pick this activity to compare';
  [MENU_LINK, MENU_PAGE].forEach(id => chrome.contextMenus.update(id, { title }, () => void chrome.runtime.lastError));
  chrome.action.setBadgeText({ text: pending ? '1' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#fc4c02' });
}

chrome.runtime.onInstalled.addListener(async () => {
  // Menus persist across worker restarts, so they are made once per install
  // or update, not every time the worker starts.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: 'Pick this activity to compare',
      contexts: ['link'],
      targetUrlPatterns: [ACTIVITY_URL_PATTERN]
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'Pick this activity to compare',
      contexts: ['page'],
      documentUrlPatterns: [ACTIVITY_URL_PATTERN]
    });
  });
  const { [PENDING_PICK_KEY]: pending } = await chrome.storage.local.get(PENDING_PICK_KEY);
  showPickState(pending);
});

chrome.contextMenus.onClicked.addListener(info => {
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  const activityId = activityIdFromUrl(url);
  if (activityId) pickActivity(activityId, null).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && PENDING_PICK_KEY in changes) showPickState(changes[PENDING_PICK_KEY].newValue);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'pickActivity') {
    pickActivity(String(request.activityId), request.label)
      .then(state => sendResponse({ ok: true, state }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (request && request.action === 'cancelPick') {
    chrome.storage.local.remove(PENDING_PICK_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
