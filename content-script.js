// Listen for messages from the extension
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractSegmentData') {
    try {
      const data = extractSegmentData();
      chrome.runtime.sendMessage({
        type: 'segmentData',
        data: data
      });
    } catch (error) {
      chrome.runtime.sendMessage({
        type: 'segmentData',
        error: error.message
      });
    }
  }
  return true;
});

// Listen for custom events from injected script
document.addEventListener('extractSegmentData', () => {
  try {
    const data = extractSegmentData();
    chrome.runtime.sendMessage({
      type: 'segmentData',
      data: data
    });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: 'segmentData',
      error: error.message
    });
  }
});

// Function to extract segment data from Strava activity page
function extractSegmentData() {
  const activityData = {
    title: document.title,
    url: window.location.href,
    segments: []
  };

  // Wait for the segments section to load
  const segmentsTable = document.querySelector('.segments-list');
  
  if (!segmentsTable) {
    throw new Error('Segments section not found on this activity');
  }
  
  // Extract segment rows
  const segmentRows = segmentsTable.querySelectorAll('tbody tr');
  
  if (segmentRows.length === 0) {
    throw new Error('No segments found for this activity');
  }
  
  // Process each segment row
  segmentRows.forEach(row => {
    // Extract segment name
    const nameElement = row.querySelector('.name');
    if (!nameElement) return;
    
    const name = nameElement.textContent.trim();
    
    // Extract time
    const timeElement = row.querySelector('.time');
    const time = timeElement ? timeElement.textContent.trim() : 'N/A';
    
    // Extract speed
    const speedElement = row.querySelector('.speeds .text-nowrap');
    const speed = speedElement ? speedElement.textContent.trim() : 'N/A';
    
    // Add to segments array
    activityData.segments.push({
      name,
      time,
      speed
    });
  });
  
  return activityData;
}

// Inject helper script to page
function injectHelperScript() {
  const script = document.createElement('script');
  script.textContent = `
    // Function to notify that the page has loaded all dynamic content
    function notifyContentLoaded() {
      // Check if segments are loaded
      if (document.querySelector('.segments-list')) {
        document.dispatchEvent(new CustomEvent('stravaPageLoaded'));
      } else {
        // Wait and check again
        setTimeout(notifyContentLoaded, 500);
      }
    }
    
    // Start checking
    setTimeout(notifyContentLoaded, 1000);
  `;
  
  document.head.appendChild(script);
  script.remove();
}

// Run on page load
injectHelperScript();
