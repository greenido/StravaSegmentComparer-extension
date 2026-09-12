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
 *   fetchSegmentHistory -> same-origin fetch of your effort history on a
 *                          segment (or, failing that, its page), reduced here
 *                          to your PR and your recent activities there
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

    // The efforts data was already checked above and does not arrive later,
    // so from here on only the table is worth watching for.
    const observer = new MutationObserver(() => {
      if (findSegmentRows(document).length) finish(true);
    });

    const timer = setTimeout(() => finish(false), timeoutMs);

    observer.observe(document.documentElement, { childList: true, subtree: true });

    // The table may have appeared between the initial check and observe().
    if (findSegmentRows(document).length) finish(true);
  });
}

async function handleExtract() {
  await waitForSegments();
  return extractActivityData(document, window.location.href);
}

// Every path this script will fetch. Ids arrive in messages, so they are
// checked here rather than trusted.
const FETCHABLE_PATHS = [
  /^\/activities\/\d+$/,
  /^\/segments\/\d+$/,
  /^\/athlete\/segments\/\d+\/history$/
];

/**
 * Fetch from Strava within the page's own origin so the session cookie is
 * sent. Checking the final URL guards against a silent redirect to the login
 * page being read as if it were the thing we asked for.
 */
async function fetchFromStrava(path, headers = {}) {
  if (!FETCHABLE_PATHS.some(re => re.test(path))) {
    throw new Error(`Refusing to fetch ${path}`);
  }

  const response = await fetch(`https://www.strava.com${path}`, {
    credentials: 'include',
    redirect: 'follow',
    headers
  });

  if (!response.ok) {
    throw new Error(`Strava returned HTTP ${response.status}`);
  }
  if (!new URL(response.url).pathname.startsWith(path)) {
    throw new Error('Redirected away from the requested page (not signed in?)');
  }

  return response;
}

async function handleFetchActivityHtml(activityId) {
  return (await fetchFromStrava(`/activities/${activityId}`)).text();
}

/**
 * The signed-in athlete's PR on a segment and their recent activities on it,
 * reduced here so a large response never has to cross the message boundary.
 *
 * The effort history is JSON and exact, so it comes first. The segment page is
 * the fallback for when that endpoint fails or changes shape; it has the PR
 * but not the activities, so `recent` is null then, and the reason is passed
 * back so the popup can log it. An empty history is an answer ("no PR"), not
 * a failure, so it does not trigger the fallback.
 *
 * @returns {Promise<{pr: {time: string}|null, recent: Array|null, historyError?: string}>}
 */
async function handleFetchSegmentHistory(segmentId) {
  let historyError;
  try {
    const response = await fetchFromStrava(`/athlete/segments/${segmentId}/history`, {
      'X-Requested-With': 'XMLHttpRequest'
    });
    const history = await response.json();
    if (Array.isArray(history && history.efforts)) {
      return { pr: personalRecordFromHistory(history), recent: recentActivitiesFromHistory(history) };
    }
    historyError = 'unrecognised response';
  } catch (error) {
    historyError = error.message;
  }

  // Validates the id again, so a refused id still fails here.
  const html = await (await fetchFromStrava(`/segments/${segmentId}`)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return { pr: extractSegmentPersonalRecord(doc), recent: null, historyError };
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

  if (request.action === 'fetchSegmentHistory') {
    handleFetchSegmentHistory(request.segmentId)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
