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
