/**
 * Content script for strava.com.
 *
 * Two jobs, both request/response — the popup asks, we answer. There is no
 * broadcasting, so two concurrent extractions can never be confused for one
 * another.
 *
 *   extractSegmentData  -> extract from this live page
 *   fetchActivityHtml   -> same-origin fetch of another activity, so the popup
 *                          can parse it without opening a tab
 *
 * Depends on extractor.js, loaded first by the manifest.
 */

const SEGMENT_WAIT_TIMEOUT_MS = 15000;

/**
 * Resolve once the segments table exists, or after `timeoutMs`.
 *
 * Strava renders segments after the initial paint, so a fixed sleep is either
 * too short (flaky) or too long (slow). Observing the DOM is both.
 */
function waitForSegments(timeoutMs = SEGMENT_WAIT_TIMEOUT_MS) {
  if (hasSegments(document)) return Promise.resolve(true);

  return new Promise(resolve => {
    let settled = false;

    const finish = found => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(found);
    };

    const observer = new MutationObserver(() => {
      if (hasSegments(document)) finish(true);
    });

    const timer = setTimeout(() => finish(false), timeoutMs);

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // The table may have appeared between the initial check and observe().
    if (hasSegments(document)) finish(true);
  });
}

async function handleExtract() {
  await waitForSegments();
  return extractActivityData(document, window.location.href);
}

/**
 * Fetch another Strava activity from within the page's own origin so the
 * session cookie is sent. Returns the raw HTML for the popup to parse.
 */
async function handleFetchActivityHtml(activityId) {
  const response = await fetch(`https://www.strava.com/activities/${activityId}`, {
    credentials: 'include',
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`Strava returned HTTP ${response.status}`);
  }

  // A logged-out or redirected response is a login page, not an activity.
  if (!/\/activities\/\d+/.test(response.url)) {
    throw new Error('Redirected away from the activity page (not signed in?)');
  }

  return response.text();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractSegmentData') {
    handleExtract()
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'fetchActivityHtml') {
    handleFetchActivityHtml(request.activityId)
      .then(html => sendResponse({ ok: true, html }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
