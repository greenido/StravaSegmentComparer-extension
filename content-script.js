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
  console.log('Starting segment data extraction...');
  const activityTitle = document.title;
  const activityUrl = window.location.href;
  
  // Extract activity ID from URL
  const activityIdMatch = activityUrl.match(/activities\/(\d+)/);
  const activityId = activityIdMatch ? activityIdMatch[1] : 'unknown';
  
  console.log(`Processing activity #${activityId}: "${activityTitle}"`);
  
  const activityData = {
    title: activityTitle,
    url: activityUrl,
    activityId: activityId,
    segments: [],
    extractionTime: new Date().toISOString()
  };

  // Wait for the segments section to load
  console.log('Looking for segments section...');
  const segmentsTable = document.querySelector('.segments-list');
  
  if (!segmentsTable) {
    console.error('Segments section not found!');
    throw new Error('Segments section not found on this activity');
  }
  
  console.log('Segments section found, extracting segment rows...');
  
  // Extract segment rows
  const segmentRows = segmentsTable.querySelectorAll('tbody tr');
  
  if (segmentRows.length === 0) {
    console.error('No segment rows found in the table!');
    throw new Error('No segments found for this activity');
  }
  
  console.log(`Found ${segmentRows.length} segment rows, processing each one...`);
  
  // Process each segment row
  let successfulSegments = 0;
  let skippedSegments = 0;
  
  segmentRows.forEach((row, index) => {
    try {
      // Extract segment name
      const nameElement = row.querySelector('.name');
      if (!nameElement) {
        console.warn(`Segment #${index+1}: Name element not found, skipping this segment`);
        skippedSegments++;
        return;
      }
      
      const name = nameElement.textContent.trim();
      
      // Extract time
      const timeElement = row.querySelector('.time');
      const time = timeElement ? timeElement.textContent.trim() : 'N/A';
      
      // Extract speed
      const speedElement = row.querySelector('.speeds .text-nowrap');
      const speed = speedElement ? speedElement.textContent.trim() : 'N/A';
      
      // Additional data if available
      const distanceElement = row.querySelector('.distance');
      const distance = distanceElement ? distanceElement.textContent.trim() : null;
      
      const powerElement = row.querySelector('.power');
      const power = powerElement ? powerElement.textContent.trim() : null;
      
      // Add to segments array
      activityData.segments.push({
        name,
        time,
        speed,
        distance,
        power,
        index: index + 1
      });
      
      successfulSegments++;
    } catch (error) {
      console.error(`Error processing segment #${index+1}:`, error);
      skippedSegments++;
    }
  });
  
  console.log(`Successfully extracted ${successfulSegments} segments (skipped ${skippedSegments})`);
  console.log('Segment data extraction complete!');
  
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
