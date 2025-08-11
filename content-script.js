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
  
  // Attempt to extract athlete name from the page using several fallbacks
  function extractAthleteName() {
    try {
      // 0) Specific anchor form: <a class="minimal" href="/athletes/{id}">Name</a>
      const minimalAthleteEl = document.querySelector('a.minimal[href^="/athletes/"]');
      if (minimalAthleteEl && minimalAthleteEl.textContent.trim()) {
        return minimalAthleteEl.textContent.trim();
      }

      // 1) Explicit testid used in some Strava builds
      const ownerNameEl = document.querySelector('[data-testid="owner-name"]');
      if (ownerNameEl && ownerNameEl.textContent.trim()) {
        return ownerNameEl.textContent.trim();
      }

      // 2) First link to an athlete profile
      const athleteLinkEl = document.querySelector('a[href^="/athletes/"]');
      if (athleteLinkEl && athleteLinkEl.textContent.trim()) {
        return athleteLinkEl.textContent.trim();
      }

      // 3) Parse from OpenGraph title
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
      if (ogTitle) {
        if (ogTitle.includes(' - ')) {
          const [left, right] = ogTitle.split(' - ');
          if (left && left.trim().split(' ').length >= 2) return left.trim();
          if (right && right.trim().split(' ').length >= 2) return right.trim();
        }
        if (ogTitle.includes(' | ')) {
          const [left, right] = ogTitle.split(' | ');
          if (right && right.trim().split(' ').length >= 2) return right.trim();
          if (left && left.trim().split(' ').length >= 2) return left.trim();
        }
      }

      // 4) Parse from OpenGraph description
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content');
      if (ogDesc) {
        const byMatch = ogDesc.match(/by\s+([^|–-]+?)\s+on\s+Strava/i);
        if (byMatch && byMatch[1]) return byMatch[1].trim();

        // Name followed by common activity verbs
        const verbMatch = ogDesc.match(/^([\p{L}\s.'-]{3,})\s+(ran|rode|walked|hiked|skied|swam)/iu);
        if (verbMatch && verbMatch[1]) return verbMatch[1].trim();
      }
    } catch (_) {
      // Ignore parsing errors and fall through
    }
    return null;
  }
  const athleteName = extractAthleteName();
  
  console.log(`Processing activity #${activityId}: "${activityTitle}"`);
  
  const activityData = {
    title: activityTitle,
    url: activityUrl,
    activityId: activityId,
    athleteName: athleteName,
    activityStats: [],
    segments: [],
    extractionTime: new Date().toISOString()
  };

  // Extract general activity stats from the page
  try {
    const stats = extractActivityStatsFromPage();
    activityData.activityStats = stats;
    console.log(`Extracted ${stats.length} activity stats entries`);
  } catch (e) {
    console.warn('Failed to extract activity stats:', e);
  }

  // Wait for the segments section to load
  console.log('Looking for segments section...');
  
  // Try different possible selectors for the segments table
  const segmentSelectors = [
    // '.segments-list',                   // Main selector
    // '.segments table',                  // Alternative selector
    'table.segments',                   // Another possible selector
    // '[data-react-class="SegmentLeaderboard"]', // React component
    // '.segment-efforts'                  // Another possible container
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
      console.log(`Processing segment row #${index + 1}:`, row.outerHTML);

      // Extract the segment effort ID
      const segmentEffortId = row.getAttribute('data-segment-effort-id');
      if (!segmentEffortId) {
        console.warn(`Segment #${index + 1}: Effort ID not found, skipping this segment`);
        skippedSegments++;
        return;
      }

      // Build the segment link
      const activityId = activityData.activityId;
      const segmentLink = `https://www.strava.com/activities/${activityId}/segments/${segmentEffortId}`;

      // Extract segment name - try multiple possible selectors
      let nameElement = row.querySelector('.name');
      if (!nameElement) nameElement = row.querySelector('.segment-name');
      if (!nameElement) nameElement = row.querySelector('[data-testid="segment-name"]');
      if (!nameElement) nameElement = row.querySelector('a');

      const name = nameElement ? nameElement.textContent.trim() : `Segment ${index + 1}`;
      console.log(`Found segment name: "${name}"`);

      // Extract time - try multiple possible selectors
      let timeElement = row.querySelector('.time');
      if (!timeElement) timeElement = row.querySelector('.segment-time');
      if (!timeElement) timeElement = row.querySelector('.time-col');
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
        link: segmentLink,
        time,
        speed,
        distance,
        power,
        index: index + 1
      });

      successfulSegments++;
    } catch (error) {
      console.error(`Error processing segment #${index + 1}:`, error);
      skippedSegments++;
    }
  });
  
  console.log(`Successfully extracted ${successfulSegments} segments (skipped ${skippedSegments})`);
  console.log('Segment data extraction complete!');
  
  return activityData;
}

// Extract activity-level stats from elements whose class contains "activity-stats"
function extractActivityStatsFromPage() {
  const results = [];

  // Only take stats inside elements with class "section more-stats"
  const containers = Array.from(document.querySelectorAll('.section.more-stats'));
  if (!containers.length) {
    console.warn('No ".section.more-stats" container found');
    return results;
  }

  const seenLabels = new Set();

  function normalizeLabel(label) {
    return label.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Heuristics to detect which side looks like the value vs. label
  function isLikelyValue(text) {
    const t = (text || '').trim();
    if (!t) return false;
    // Time formats like 4:26:05 or 26:05
    if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t)) return true;
    // Numbers with units (km, mi, m, W, kJ, bpm, %, °C/℃, km/h, mph)
    if (/^[-+]?\d[\d.,\s]*\s*(km|mi|m|W|kJ|bpm|%|°C|℃|km\/h|mph)$/i.test(t)) return true;
    // Temperature like 9 ℃ or 17 °C
    if (/^[-+]?\d[\d.,]*\s*(°C|℃)$/i.test(t)) return true;
    // Cardinal wind dir like SSW, NE, W
    if (/^[NSEW]{1,3}$/i.test(t)) return true;
    // Pure numeric
    if (/^[-+]?\d[\d.,]*$/.test(t)) return true;
    // Weather words: Cloudy, Sunny, Rainy, Windy, Clear, Overcast
    if (/^(Cloudy|Sunny|Rainy|Windy|Clear|Overcast|Snowy|Hazy)$/i.test(t)) return true;
    return false;
  }

  function isLikelyLabel(text) {
    const t = (text || '').trim();
    if (!t) return false;
    const lower = t.toLowerCase();
    // Common stat labels
    const keywords = [
      'distance', 'moving time', 'elapsed time', 'estimated avg power', 'weighted avg power', 'avg power',
      'energy output', 'calories', 'temperature', 'humidity', 'feels like', 'wind speed', 'wind direction',
      'heart rate', 'avg heart rate', 'max heart rate', 'cadence', 'power', 'avg speed', 'max speed',
      'device', 'bike', 'gear'
    ];
    if (keywords.some(k => lower.includes(k))) return true;
    // Labels are often multi-word alphabetic phrases
    if (/^[A-Za-z][A-Za-z\s%°/+-]*$/.test(t) && /[a-zA-Z]{3,}/.test(t)) return true;
    return false;
  }

  function pushIfNew(label, value) {
    let l = (label || '').trim();
    let v = (value || '').trim();

    // Swap if first looks like a value and second like a label
    if (isLikelyValue(l) && isLikelyLabel(v)) {
      const tmp = l; l = v; v = tmp;
    }

    const normalized = normalizeLabel(l);
    if (!normalized || !v || seenLabels.has(normalized)) return;
    seenLabels.add(normalized);
    results.push({ label: l, value: v });
  }

  containers.forEach((container) => {
    // Prefer parsing simple two-column tables if present
    const tables = container.querySelectorAll('table');
    tables.forEach((tbl) => {
      const rows = tbl.querySelectorAll('tr');
      rows.forEach((tr) => {
        const cells = tr.querySelectorAll('th, td');
        if (cells.length >= 2) {
          const label = (cells[0].textContent || '').trim();
          const value = (cells[1].textContent || '').trim();
          if (label && value) pushIfNew(label, value);
        }
      });
    });

    // 1) dl/dt/dd structure
    const dls = container.querySelectorAll('dl');
    dls.forEach((dl) => {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      const count = Math.min(dts.length, dds.length);
      for (let i = 0; i < count; i++) {
        const label = dts[i].textContent || '';
        const value = dds[i].textContent || '';
        pushIfNew(label, value);
      }
    });

    // 2) Elements with class containing "stat" that may have label/value sub-elements
    const statBlocks = container.querySelectorAll('[class*="stat" i]');
    statBlocks.forEach((block) => {
      // Try common label/value patterns
      const labelEl = block.querySelector('[class*="label" i], [data-testid*="label" i]');
      const valueEl = block.querySelector('[class*="value" i], [data-testid*="value" i]');
      if (labelEl && valueEl) {
        const label = labelEl.textContent || '';
        const value = valueEl.textContent || '';
        if (label.trim() && value.trim()) pushIfNew(label, value);
        return;
      }

      // Fallback: try to infer a label and a numeric/text value from immediate children
      const children = Array.from(block.children || []);
      if (children.length >= 2) {
        const label = children[0].textContent || '';
        const value = children[1].textContent || '';
        if (label.trim() && value.trim()) pushIfNew(label, value);
      }
    });

    // 3) Simple list items or rows like "Label: Value" or "Value Label"
    const simpleItems = container.querySelectorAll('li, div, span');
    simpleItems.forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      // Match patterns like "Distance: 10.0 km" or "Distance 10.0 km"
      const colonIdx = text.indexOf(':');
      if (colonIdx > 0 && colonIdx < text.length - 1) {
        const label = text.slice(0, colonIdx).trim();
        const value = text.slice(colonIdx + 1).trim();
        if (label && value) pushIfNew(label, value);
        return;
      }

      // If no colon, split by two or more spaces and try first token as label
      const match = text.match(/^([\p{L}\d .,'%°\/+-]+?)\s{2,}(.+)/u);
      if (match && match[1] && match[2]) {
        pushIfNew(match[1], match[2]);
        return;
      }

      // Handle "Value Label" pattern (value-like first, then label-like)
      // e.g., "56.78 km Distance" or "4:26:05 Moving Time" or "126 W Estimated Avg Power"
      const valueLabelPatterns = [
        /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/, // time first
        /^([-+]?\d[\d.,\s]*\s*(?:km|mi|m|W|kJ|bpm|%|°C|℃|km\/h|mph))\s+(.+)$/i, // number+unit first
        /^([NSEW]{1,3})\s+(.+)$/i // wind dir first
      ];
      for (const re of valueLabelPatterns) {
        const m = text.match(re);
        if (m && m[1] && m[2]) {
          const value = m[1].trim();
          const label = m[2].trim();
          pushIfNew(label, value);
          return;
        }
      }
    });
  });

  return results;
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
