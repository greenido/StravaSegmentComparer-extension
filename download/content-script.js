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
  
  // Try different possible selectors for the segments table
  const segmentSelectors = [
    '.segments-list',                   // Main selector
    '.segments table',                  // Alternative selector
    'table.segments',                   // Another possible selector
    '[data-react-class="SegmentLeaderboard"]', // React component
    '.segment-efforts'                  // Another possible container
  ];
  
  let segmentsTable = null;
  
  for (const selector of segmentSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      console.log(`Found segments container using selector: ${selector}`);
      segmentsTable = element;
      break;
    }
  }
  
  if (!segmentsTable) {
    console.error('Segments section not found!');
    // Try to log potential segment containers for debugging
    console.log('Potential segment containers in the DOM:');
    document.querySelectorAll('table').forEach((table, i) => {
      console.log(`Table #${i}:`, table.className, table.id);
    });
    throw new Error('Segments section not found on this activity');
  }
  
  console.log('Segments section found, extracting segment rows...');
  
  // Extract segment rows - try different possible row selectors
  let segmentRows = segmentsTable.querySelectorAll('tbody tr');
  
  // If no rows found with the first selector, try alternative selectors
  if (segmentRows.length === 0) {
    segmentRows = segmentsTable.querySelectorAll('tr.segment-effort');
  }
  
  if (segmentRows.length === 0) {
    segmentRows = segmentsTable.querySelectorAll('.segment-row');
  }
  
  if (segmentRows.length === 0) {
    segmentRows = document.querySelectorAll('[data-testid="segment-effort-row"]');
  }
  
  if (segmentRows.length === 0) {
    console.error('No segment rows found in the table!');
    // Log the HTML of the segments table for debugging
    console.log('Segments table HTML:', segmentsTable.outerHTML);
    throw new Error('No segments found for this activity');
  }
  
  console.log(`Found ${segmentRows.length} segment rows, processing each one...`);
  
  // Process each segment row
  let successfulSegments = 0;
  let skippedSegments = 0;
  
  segmentRows.forEach((row, index) => {
    try {
      // Log the current row for debugging
      console.log(`Processing segment row #${index+1}:`, row.outerHTML);
      
      // Extract segment name - try multiple possible selectors
      let nameElement = row.querySelector('.name');
      if (!nameElement) nameElement = row.querySelector('.segment-name');
      if (!nameElement) nameElement = row.querySelector('[data-testid="segment-name"]');
      if (!nameElement) nameElement = row.querySelector('a');
      
      if (!nameElement) {
        console.warn(`Segment #${index+1}: Name element not found, skipping this segment`);
        skippedSegments++;
        return;
      }
      
      const name = nameElement.textContent.trim();
      console.log(`Found segment name: "${name}"`);
      
      // Extract time - try multiple possible selectors
      let timeElement = row.querySelector('.time');
      if (!timeElement) timeElement = row.querySelector('.segment-time');
      if (!timeElement) timeElement = row.querySelector('[data-testid="segment-time"]');
      if (!timeElement) {
        // Try to find time in any cell that contains time format (mm:ss)
        const cells = row.querySelectorAll('td');
        for (const cell of cells) {
          if (cell.textContent.trim().match(/^\d+:\d+$/)) {
            timeElement = cell;
            break;
          }
        }
      }
      
      const time = timeElement ? timeElement.textContent.trim() : 'N/A';
      console.log(`Found segment time: "${time}"`);
      
      // Extract speed - try multiple possible selectors
      let speedElement = row.querySelector('.speeds .text-nowrap');
      if (!speedElement) speedElement = row.querySelector('.speed');
      if (!speedElement) speedElement = row.querySelector('[data-testid="segment-speed"]');
      if (!speedElement) {
        // Try to find speed in any cell that contains speed format (X.X km/h or X.X mph)
        const cells = row.querySelectorAll('td');
        for (const cell of cells) {
          if (cell.textContent.trim().match(/(km\/h|mph)/)) {
            speedElement = cell;
            break;
          }
        }
      }
      
      const speed = speedElement ? speedElement.textContent.trim() : 'N/A';
      console.log(`Found segment speed: "${speed}"`);
      
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

// Use MutationObserver instead of injecting scripts
function setupSegmentMonitor() {
  console.log('Setting up segment monitor...');
  
  // Define the selectors to check for segment containers
  const segmentSelectors = [
    '.segments-list',                   
    '.segments table',                  
    'table.segments',                   
    '[data-react-class="SegmentLeaderboard"]',
    '.segment-efforts',
    // Additional fallback selectors
    'section.segments',
    'div[data-react-class*="Segment"]',
    '.efforts-table'
  ];
  
  // Function to check if segments are loaded
  function checkForSegments() {
    for (const selector of segmentSelectors) {
      if (document.querySelector(selector)) {
        console.log(`Segments detected in the page using selector: ${selector}`);
        document.dispatchEvent(new CustomEvent('extractSegmentData'));
        return true;
      }
    }
    
    // Also check for alternative indicators that segments exist
    const potentialSegmentIndicators = [
      // Headers or titles that might indicate segments are present
      'h3:contains("Segments")',
      '.segments-header',
      // Buttons or tabs related to segments
      'button:contains("Segment")',
      'a:contains("Segments")',
      // Any element with segment in the class or id
      '[class*="segment" i]',
      '[id*="segment" i]'
    ];
    
    for (const indicator of potentialSegmentIndicators) {
      try {
        if (document.querySelector(indicator) || 
            (indicator.includes(':contains') && 
             document.evaluate(`//*[contains(text(), '${indicator.match(/:contains\("(.+?)"\)/)[1]}')]`, 
                              document, null, XPathResult.ANY_TYPE, null).iterateNext())) {
          console.log(`Segment indicator found in page: ${indicator}`);
          document.dispatchEvent(new CustomEvent('extractSegmentData'));
          return true;
        }
      } catch (e) {
        // Ignore errors with complex selectors
      }
    }
    
    return false;
  }
  
  // Check immediately in case the segments are already loaded
  if (checkForSegments()) {
    return;
  }
  
  // Otherwise, set up a MutationObserver to watch for changes
  console.log('Segments not found yet, setting up observer...');
  
  const observer = new MutationObserver((mutations) => {
    // Look for mutations that might indicate segments have loaded
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if this node or its children contain segment-related content
            if (node.querySelector && (
                node.querySelector('[class*="segment" i]') || 
                node.classList && Array.from(node.classList).some(c => c.toLowerCase().includes('segment')))) {
              console.log('Potential segment-related content detected in DOM mutation');
              if (checkForSegments()) {
                observer.disconnect();
                return;
              }
            }
          }
        }
      }
    }
    
    // Also periodically check regardless of specific mutations
    if (checkForSegments()) {
      observer.disconnect();
    }
  });
  
  // Start observing the document body for DOM changes
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'id', 'data-react-class']
  });
  
  // Set a timeout to stop observing after a reasonable time
  setTimeout(() => {
    observer.disconnect();
    console.log('Segment detection timeout reached');
    
    // Try one final extraction even if no segments were detected by the observer
    if (!document.querySelector(segmentSelectors.join(', '))) {
      console.log('No segments detected by timeout. Attempting final extraction anyway...');
      document.dispatchEvent(new CustomEvent('extractSegmentData'));
    }
  }, 30000); // 30 seconds timeout
}

// Run on page load
setupSegmentMonitor();
