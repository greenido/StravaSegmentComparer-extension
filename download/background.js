// Background script for the Strava Segment Comparator extension

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Strava Segment Comparator extension installed');
});

// Set up communication channel between popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward messages from content script to popup
  return true;
});
