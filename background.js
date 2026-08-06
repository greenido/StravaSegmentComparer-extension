// Background service worker for the Strava Segment Comparator extension.
//
// The popup talks to content scripts directly with request/response messaging,
// so there is nothing to relay here.

chrome.runtime.onInstalled.addListener(() => {
  console.log('Strava Segment Comparator installed');
});
