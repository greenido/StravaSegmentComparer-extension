// Initialize variables for data table and comparison data
let dataTable = null;
let comparisonData = [];

// DOM Elements
const activity1Input = document.getElementById('activity1');
const activity2Input = document.getElementById('activity2');
const compareBtn = document.getElementById('compareBtn');
const statusDiv = document.getElementById('status');
const resultsDiv = document.getElementById('results');
const exportBtn = document.getElementById('exportBtn');
const logContent = document.getElementById('logContent');
const clearBtn = document.getElementById('clearBtn'); // Add a Clear button in your HTML
const autoDetectBtn = document.getElementById('autoDetectBtn');
const helpBtn = document.getElementById('helpBtn');
const helpSection = document.getElementById('helpSection');

// Log entries array to track all messages
let logEntries = [];

// Global variables
let athlete1Name = null;
let athlete2Name = null;

function getDisplayName(index) {
  const name = index === 1 ? athlete1Name : athlete2Name;
  return name && name.trim() ? name.trim() : `Activity ${index}`;
}

function updateTableHeaders() {
  const table = document.getElementById('segmentsTable');
  if (!table) return;
  const timeHeaders = table.querySelectorAll('thead th.col-time');
  const speedHeaders = table.querySelectorAll('thead th.col-speed');
  if (timeHeaders.length >= 2) {
    timeHeaders[0].textContent = `Time (${getDisplayName(1)})`;
    timeHeaders[1].textContent = `Time (${getDisplayName(2)})`;
  }
  if (speedHeaders.length >= 2) {
    speedHeaders[0].textContent = `Speed (${getDisplayName(1)})`;
    speedHeaders[1].textContent = `Speed (${getDisplayName(2)})`;
  }
}
// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  // Set up event listeners
  compareBtn.addEventListener('click', compareActivities);
  exportBtn.addEventListener('click', exportAsCSV);
  autoDetectBtn.addEventListener('click', autoPopulateActivityUrls);
  helpBtn.addEventListener('click', (e) => {
    e.preventDefault();
    toggleHelpSection();
  });
  // Keyboard accessibility: toggle with Enter/Space
  helpBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleHelpSection();
    }
  });
  clearBtn.addEventListener('click', () => {
    localStorage.removeItem('comparisonResults');
    location.reload();
    addLogEntry('Cleared saved results from localStorage', 'info');
    // resultsDiv.classList.add('hidden');
    // const tableBody = document.getElementById('segmentsTableBody');
    // tableBody.innerHTML = ''; // Clear the table
    showStatus('Results cleared successfully', 'success');
  });

  // Load any previously saved URLs first (as fallback)
  chrome.storage.local.get(['activity1', 'activity2', 'athlete1Name', 'athlete2Name'], data => {
    if (data.activity1) activity1Input.value = data.activity1;
    if (data.activity2) activity2Input.value = data.activity2;
    if (data.athlete1Name) athlete1Name = data.athlete1Name;
    if (data.athlete2Name) athlete2Name = data.athlete2Name;
    if (data.athlete1Name || data.athlete2Name) {
      addLogEntry(`Loaded athlete names from storage: ${getDisplayName(1)} vs ${getDisplayName(2)}`, 'info');
      updateTableHeaders();
    }
    
    // Then try to auto-detect and populate from open tabs (this will override saved URLs if found)
    autoPopulateActivityUrls();
  });

  // Load saved results from localStorage on popup load
  const savedResults = localStorage.getItem('comparisonResults');
  if (savedResults) {
    const parsedResults = JSON.parse(savedResults);
    addLogEntry('Loaded saved results from localStorage', 'info');
    displayResults(parsedResults);
    resultsDiv.classList.remove('hidden');
  }
});

// Auto-populate activity URLs from open Strava activity tabs
async function autoPopulateActivityUrls() {
  try {
    addLogEntry('Searching for open Strava activity tabs...', 'info');
    showStatus('Scanning open tabs for Strava activities...', 'loading');
    
    // Query all tabs to find Strava activity pages
    const tabs = await chrome.tabs.query({});
    const stravaActivityTabs = tabs.filter(tab => 
      tab.url && tab.url.match(/https:\/\/www\.strava\.com\/activities\/\d+/)
    );
    
    // Sort tabs by tab ID to get a consistent order (oldest tabs first)
    stravaActivityTabs.sort((a, b) => a.id - b.id);
    
    addLogEntry(`Found ${stravaActivityTabs.length} open Strava activity tabs`, 'info');
    
    // Log details about found tabs
    stravaActivityTabs.forEach((tab, index) => {
      const activityId = extractActivityId(tab.url);
      addLogEntry(`Tab ${index + 1}: Activity ${activityId} (Tab ID: ${tab.id})`, 'info');
    });
    
    // Clear existing values first
    activity1Input.value = '';
    activity2Input.value = '';
    
    if (stravaActivityTabs.length >= 1) {
      activity1Input.value = stravaActivityTabs[0].url;
      addLogEntry(`Auto-populated Activity 1: ${extractActivityId(stravaActivityTabs[0].url)}`, 'success');
    }
    
    if (stravaActivityTabs.length >= 2) {
      activity2Input.value = stravaActivityTabs[1].url;
      addLogEntry(`Auto-populated Activity 2: ${extractActivityId(stravaActivityTabs[1].url)}`, 'success');
    }
    
    // Provide detailed feedback based on what was found
    if (stravaActivityTabs.length >= 2) {
      showStatus(`✅ Auto-detected 2 Strava activities - ready to compare!`, 'success');
    } else if (stravaActivityTabs.length === 1) {
      showStatus(`⚠️ Found 1 Strava activity - please open another activity tab or enter URL manually`, 'info');
    } else {
      showStatus(`❌ No open Strava activity tabs found - please navigate to Strava activities first`, 'error');
    }
    
    // Save the auto-populated URLs to storage
    if (stravaActivityTabs.length >= 1) {
      const storageData = {};
      if (stravaActivityTabs.length >= 1) storageData.activity1 = stravaActivityTabs[0].url;
      if (stravaActivityTabs.length >= 2) storageData.activity2 = stravaActivityTabs[1].url;
      
      chrome.storage.local.set(storageData);
      addLogEntry('Saved auto-detected URLs to storage', 'info');
    }
    
    // If more than 2 tabs found, inform user
    if (stravaActivityTabs.length > 2) {
      addLogEntry(`Note: Found ${stravaActivityTabs.length} Strava activity tabs, using the first 2`, 'info');
    }
    
  } catch (error) {
    addLogEntry(`Error auto-detecting Strava tabs: ${error.message}`, 'error');
    showStatus(`Error scanning tabs: ${error.message}`, 'error');
    console.error('Error in autoPopulateActivityUrls:', error);
  }
}

// Toggle help section visibility
function toggleHelpSection() {
  const isHidden = helpSection.classList.contains('hidden');
  
  if (isHidden) {
    helpSection.classList.remove('hidden');
    helpBtn.classList.add('active');
    helpBtn.title = 'Hide help and tips';
    helpBtn.setAttribute('aria-expanded', 'true');
    addLogEntry('Help section opened', 'info');
  } else {
    helpSection.classList.add('hidden');
    helpBtn.classList.remove('active');
    helpBtn.title = 'Show help and tips';
    helpBtn.setAttribute('aria-expanded', 'false');
    addLogEntry('Help section closed', 'info');
  }
}

// Extract activity ID from Strava URL
function extractActivityId(url) {
  const match = url.match(/activities\/(\d+)/);
  return match ? match[1] : null;
}

// Compare activities function
async function compareActivities() {
  // Validate inputs
  const activity1Url = activity1Input.value.trim();
  const activity2Url = activity2Input.value.trim();

  addLogEntry('Starting comparison process', 'info');

  if (!isValidStravaActivityUrl(activity1Url) || !isValidStravaActivityUrl(activity2Url)) {
    showStatus('Please enter valid Strava activity URLs', 'error');
    return;
  }

  // Save URLs to localStorage
  chrome.storage.local.set({
    activity1: activity1Url,
    activity2: activity2Url
  });
  addLogEntry('Saved activity URLs to storage', 'info');

  // Extract activity IDs
  const activity1Id = extractActivityId(activity1Url);
  const activity2Id = extractActivityId(activity2Url);
  addLogEntry(`Extracted Activity IDs: #1=${activity1Id}, #2=${activity2Id}`, 'info');

  // Show loading status
  showStatus('Fetching segment data from both activities...', 'loading');

  try {
    // Request segment data for both activities
    addLogEntry('Opening tabs to fetch segment data...', 'info');
    const [activity1Data, activity2Data] = await Promise.all([
      fetchActivityData(activity1Id),
      fetchActivityData(activity2Id)
    ]);

    // Capture athlete names for header labels
    athlete1Name = activity1Data.athleteName || `Activity ${activity1Id}`;
    athlete2Name = activity2Data.athleteName || `Activity ${activity2Id}`;
    chrome.storage.local.set({ athlete1Name, athlete2Name });
    addLogEntry(`Comparing ${athlete1Name} vs ${athlete2Name}`, 'info');

    addLogEntry(`Activity #1: Found ${activity1Data.segments.length} segments`, 'success');
    addLogEntry(`Activity #2: Found ${activity2Data.segments.length} segments`, 'success');

    // Process and compare segment data
    addLogEntry('Comparing segment data between activities...', 'info');
    comparisonData = compareSegmentData(activity1Data, activity2Data);

    // Display results
    addLogEntry(`Displaying ${comparisonData.length} matched segments in table`, 'info');
    displayResults(comparisonData);
    // Display activity stats comparison panels (side-by-side, not a table)
    addLogEntry('Building activity stats panels...', 'info');
    displayStatsComparison(activity1Data, activity2Data);
    updateTableHeaders();

    // Show success status
    showStatus(`Successfully compared ${comparisonData.length} segments`, 'success');

    // Show results container
    resultsDiv.classList.remove('hidden');

  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
    addLogEntry(`Error occurred: ${error.message}`, 'error');
    console.error(error);
  }
}

// Fetch activity data function
function fetchActivityData(activityId) {
  return new Promise((resolve, reject) => {
    // Send message to content script to extract data from the page
    addLogEntry(`Opening tab for activity ${activityId}...`, 'info');

    chrome.tabs.create(
      { url: `https://www.strava.com/activities/${activityId}`, active: false },
      tab => {
        addLogEntry(`Tab created (ID: ${tab.id}) for activity ${activityId}`, 'info');

        // Listen for the content script to finish extracting data
        const listener = (message, sender, sendResponse) => {
          if (sender.tab && sender.tab.id === tab.id && message.type === 'segmentData') {
            addLogEntry(`Received data from tab ${tab.id}, closing tab`, 'info');
            chrome.tabs.remove(tab.id);
            chrome.runtime.onMessage.removeListener(listener);

            if (message.error) {
              addLogEntry(`Error retrieving data for activity ${activityId}: ${message.error}`, 'error');
              reject(new Error(message.error));
            } else {
              const segmentCount = message.data.segments ? message.data.segments.length : 0;
              addLogEntry(`Successfully extracted ${segmentCount} segments from activity ${activityId}`, 'success');
              resolve(message.data);
            }
          }
        };

        chrome.runtime.onMessage.addListener(listener);

        // Execute content script after page load
        addLogEntry(`Waiting for page to load (activity ${activityId})...`, 'info');
        setTimeout(() => {
          addLogEntry(`Sending message to extract data from activity ${activityId}`, 'info');
          chrome.tabs.sendMessage(tab.id, { action: 'extractSegmentData' })
            .catch(err => {
              addLogEntry(`Error sending message to tab: ${err.message}`, 'error');
            });
        }, 3000); // Wait for page to load

        // Add timeout to prevent hanging if data is never received
        setTimeout(() => {
          addLogEntry(`Timeout reached for activity ${activityId}, closing tab`, 'warning');
          chrome.tabs.remove(tab.id);
          chrome.runtime.onMessage.removeListener(listener);
          reject(new Error('Timeout while extracting segment data'));
        }, 20000); // 20 second timeout
      }
    );
  });
}

// Compare segment data from both activities
function compareSegmentData(activity1Data, activity2Data) {
  const results = [];

  addLogEntry(`Activity 1 has ${activity1Data.segments.length} segments`, 'info');
  addLogEntry(`Activity 2 has ${activity2Data.segments.length} segments`, 'info');

  // Create a map of segments from activity 1
  const activity1Segments = new Map();
  activity1Data.segments.forEach(segment => {
    activity1Segments.set(segment.name, segment);
  });

  addLogEntry('Starting segment matching process...', 'info');
  let matchCount = 0;

  // Match segments from activity 2 with activity 1
  activity2Data.segments.forEach(segment2 => {
    const segment1 = activity1Segments.get(segment2.name);

    if (segment1) {
      matchCount++;

      // Calculate time difference
      const time1Seconds = parseTimeToSeconds(segment1.time);
      const time2Seconds = parseTimeToSeconds(segment2.time);
      const timeDiffSeconds = time2Seconds - time1Seconds;

      // Calculate speed difference
      const speed1Value = parseSpeedValue(segment1.speed);
      const speed2Value = parseSpeedValue(segment2.speed);
      const speedDiff = (speed2Value - speed1Value).toFixed(1);

      // Add to results
      results.push({
        name: segment1.name,
        link: segment1.link,
        time_1: segment1.time,
        time_2: segment2.time,
        time_diff: formatTimeDiff(timeDiffSeconds),
        speed_1: segment1.speed,
        speed_2: segment2.speed,
        speed_diff: `${speedDiff} km/h`
      });

      // Add log entry for significant time differences
      if (Math.abs(timeDiffSeconds) > 30) {
        const betterOrWorse = timeDiffSeconds > 0 ? 'slower' : 'faster';
        addLogEntry(`Segment "${segment1.name}": ${Math.abs(formatTimeDiff(timeDiffSeconds))} ${betterOrWorse} in Activity 2`, 
          timeDiffSeconds > 0 ? 'warning' : 'success');
      }

      // Remove matched segment from activity1Segments
      activity1Segments.delete(segment1.name);
    }
  });

  const unmatchedCount = activity1Segments.size;
  addLogEntry(`Matched ${matchCount} segments between both activities`, 'success');

  if (unmatchedCount > 0) {
    addLogEntry(`${unmatchedCount} segments from Activity 1 were not found in Activity 2`, 'warning');
  }

  // Preserve Strava page order based on Activity 1 segment order
  const sortedResults = results
    .map(r => {
      // Attach order index from activity 1 if available; default large number to push unknowns last
      const activity1Segment = activity1Data.segments.find(s => s.name === r.name);
      return { ...r, orderIndex: activity1Segment && typeof activity1Segment.index === 'number' ? activity1Segment.index : Number.MAX_SAFE_INTEGER };
    })
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map(({ orderIndex, ...rest }) => rest);

  addLogEntry(`Ordering ${sortedResults.length} segments to match Strava page order`, 'info');

  return sortedResults;
}

// Display results in the table and save them to localStorage
function displayResults(data) {
  addLogEntry('Setting up results table...', 'info');
  const tableBody = document.getElementById('segmentsTableBody');

  // Check if the table body exists
  if (!tableBody) {
    console.error('Error: Table body element with ID "segmentsTableBody" not found.');
    // Create a new table element
    const newTable = document.createElement('table');
    newTable.id = 'segmentsTable';
    newTable.className = 'w-full text-sm';

    // Add table header
    newTable.innerHTML = `
      <thead>
      <tr>
        <th class="col-segment">Segment Name</th>
        <th class="col-time">Time 1</th>
        <th class="col-time">Time 2</th>
        <th class="col-diff">Time Diff</th>
        <th class="col-speed">Speed 1</th>
        <th class="col-speed">Speed 2</th>
        <th class="col-diff">Speed Diff</th>
      </tr>
      </thead>
      <tbody id="segmentsTableBody"></tbody>
    `;

    // Append the new table to the resultsDiv
    resultsDiv.appendChild(newTable);

    // Add a log entry for creating the table
    addLogEntry('Created a new results table and added it to the page', 'info');
  }

  // Clear existing table
  tableBody.innerHTML = '';
  addLogEntry('Cleared previous table data', 'info');

  // Add rows to table
  addLogEntry(`Adding ${data.length} rows to table`, 'info');
  data.forEach((row, index) => {
    const tr = document.createElement('tr');

    // Add cells for each data point
    tr.innerHTML = `
      <td>
        <a href="${row.link}" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline">
          ${row.name}
        </a>
      </td>
      <td>${row.time_1}</td>
      <td>${row.time_2}</td>
      <td style="${getTimeDiffStyle(row.time_diff)}">${row.time_diff}</td>
      <td>${row.speed_1}</td>
      <td>${row.speed_2}</td>
      <td style="${getSpeedDiffStyle(row.speed_diff)}">${row.speed_diff}</td>
    `;

    tableBody.appendChild(tr);
  });

  // Save results to localStorage
  localStorage.setItem('comparisonResults', JSON.stringify(data));
  addLogEntry('Saved results to localStorage', 'info');
}

// Display activity-level stats side-by-side (no tables)
function displayStatsComparison(activity1Data, activity2Data) {
  const resultsContainer = document.getElementById('results');
  if (!resultsContainer) return;

  // Remove existing stats section if present
  const existingSection = document.getElementById('activityStatsSection');
  if (existingSection) existingSection.remove();

  const statsSection = document.createElement('div');
  statsSection.id = 'activityStatsSection';
  statsSection.className = 'mb-4';

  // Build label->value maps and ordered union of labels for alignment
  const rawPairs1 = activity1Data.activityStats || [];
  const rawPairs2 = activity2Data.activityStats || [];

  const normalizeForKey = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const cleanStatText = (s) => {
    let out = (s || '').replace(/\s+/g, ' ').trim();
    // Remove common toggle/expand cues
    out = out.replace(/\bshow\s*more\b/ig, '').replace(/\bshow\s*less\b/ig, '').replace(/…/g, '');
    // Remove trailing separators like "|" if any
    out = out.replace(/\s*[|]\s*$/, '');
    return out.trim();
  };

  // Map of normalized label -> { label, value }
  const map1 = new Map();
  const map2 = new Map();
  rawPairs1.forEach(({ label, value }) => {
    const k = normalizeForKey(label);
    if (!k) return;
    if (!map1.has(k)) map1.set(k, { label: cleanStatText(label), value: cleanStatText(value) });
  });
  rawPairs2.forEach(({ label, value }) => {
    const k = normalizeForKey(label);
    if (!k) return;
    if (!map2.has(k)) map2.set(k, { label: cleanStatText(label), value: cleanStatText(value) });
  });

  // Ordered union: start with activity1 order, then add missing from activity2 order
  const orderedLabels = [];
  const seen = new Set();
  rawPairs1.forEach(({ label }) => {
    const k = normalizeForKey(label);
    if (k && !seen.has(k)) { seen.add(k); orderedLabels.push(k); }
  });
  rawPairs2.forEach(({ label }) => {
    const k = normalizeForKey(label);
    if (k && !seen.has(k)) { seen.add(k); orderedLabels.push(k); }
  });

  // Wrapper: grid with two synced columns
  const wrapper = document.createElement('div');
  wrapper.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';

  function buildAlignedColumn(title, isLeft) {
    const col = document.createElement('div');
    col.className = 'card';
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between mb-2';
    header.innerHTML = `<h3 class=\"text-sm font-bold text-gray-700\">${title}</h3>`;
    col.appendChild(header);

    // Build a table for stats
    const table = document.createElement('table');
    table.className = 'w-full text-sm';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const thLabel = document.createElement('th');
    thLabel.className = 'text-left text-xs font-semibold text-gray-600';
    thLabel.textContent = 'Metric';
    const thValue = document.createElement('th');
    thValue.className = 'text-right text-xs font-semibold text-gray-600';
    thValue.textContent = 'Value';
    headerRow.appendChild(thLabel);
    headerRow.appendChild(thValue);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    orderedLabels.forEach((k) => {
      const pair = (isLeft ? map1 : map2).get(k);
      if (!pair) return;
      const displayLabel = cleanStatText(pair.label);
      const displayValue = cleanStatText(pair.value);

      const tr = document.createElement('tr');
      tr.className = 'border-t border-gray-100';

      const tdLabel = document.createElement('td');
      tdLabel.className = 'py-1.5 pr-3 text-[11px] uppercase tracking-wide text-gray-500 align-baseline';
      tdLabel.textContent = displayLabel;

      const tdValue = document.createElement('td');
      tdValue.className = 'py-1.5 pl-3 text-sm md:text-base font-semibold text-gray-900 text-right align-baseline';
      const valueSpan = document.createElement('span');
      valueSpan.className = 'bg-yellow-100 rounded px-1 inline-block';
      valueSpan.style.backgroundColor = '#FEF3C7';
      valueSpan.textContent = displayValue;
      tdValue.appendChild(valueSpan);

      tr.appendChild(tdLabel);
      tr.appendChild(tdValue);
      tbody.appendChild(tr);
    });

    if (tbody.children.length === 0) {
      const trEmpty = document.createElement('tr');
      const tdEmpty = document.createElement('td');
      tdEmpty.colSpan = 2;
      tdEmpty.className = 'py-2 text-xs text-gray-500 text-center';
      tdEmpty.textContent = 'No activity stats found';
      trEmpty.appendChild(tdEmpty);
      tbody.appendChild(trEmpty);
    }

    table.appendChild(tbody);
    col.appendChild(table);
    return col;
  }

  const col1 = buildAlignedColumn(getDisplayName(1), true);
  const col2 = buildAlignedColumn(getDisplayName(2), false);

  wrapper.appendChild(col1);
  wrapper.appendChild(col2);
  statsSection.appendChild(wrapper);

  const segmentsTable = document.getElementById('segmentsTable');
  if (segmentsTable && segmentsTable.parentElement) {
    segmentsTable.parentElement.insertAdjacentElement('afterend', statsSection);
  } else {
    resultsContainer.appendChild(statsSection);
  }
}

// Helpers
function buildStatsMap(pairs) {
  const map = new Map();
  pairs.forEach(({ label, value }) => {
    if (!label) return;
    const key = normalizeKey(label);
    if (key && !map.has(key)) {
      map.set(key, value || '');
    }
  });
  return map;
}

function normalizeKey(label) {
  return label.toLowerCase().replace(/\s+/g, ' ').trim();
}

function lookup(map, keys) {
  for (const k of keys) {
    const key = normalizeKey(k);
    // Try exact
    if (map.has(key)) return map.get(key);
    // Try contains match among existing keys
    for (const existingKey of map.keys()) {
      if (existingKey.includes(key)) return map.get(existingKey);
    }
  }
  return '';
}

function sanitize(value) {
  return (value || '').toString();
}

// Export data as CSV
function exportAsCSV() {
  addLogEntry('Starting CSV export process...', 'info');

  if (!comparisonData.length) {
    showStatus('No data to export', 'error');
    addLogEntry('Export failed: No comparison data available', 'error');
    return;
  }

  // Create CSV content
  addLogEntry(`Preparing to export ${comparisonData.length} segment rows`, 'info');
  const headers = [
    'Segment Name',
    `Time (${getDisplayName(1)})`,
    `Time (${getDisplayName(2)})`,
    'Time Difference',
    `Speed (${getDisplayName(1)})`,
    `Speed (${getDisplayName(2)})`,
    'Speed Difference'
  ];
  let csvContent = headers.join(',') + '\n';

  comparisonData.forEach(row => {
    const values = [
      `"${row.name.replace(/"/g, '""')}"`,
      row.time_1,
      row.time_2,
      row.time_diff,
      row.speed_1,
      row.speed_2,
      row.speed_diff
    ];
    csvContent += values.join(',') + '\n';
  });

  addLogEntry('CSV content generated, creating download link', 'info');

  // Create download link
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', 'strava_segment_comparison.csv');
  link.style.visibility = 'hidden';
  document.body.appendChild(link);

  addLogEntry('Initiating download...', 'info');
  link.click();
  document.body.removeChild(link);

  // Clean up the URL object
  setTimeout(() => {
    URL.revokeObjectURL(url);
    addLogEntry('CSV export completed successfully', 'success');
  }, 100);
}

// Show status message
function showStatus(message, type = 'info') {
  statusDiv.textContent = message;
  statusDiv.className = 'status-message';

  // Add appropriate class based on type
  if (type === 'error') {
    statusDiv.classList.add('status-error');
  } else if (type === 'loading') {
    statusDiv.classList.add('status-loading');
  } else if (type === 'success') {
    statusDiv.classList.add('status-success');
  }

  // Show the status div
  statusDiv.classList.remove('hidden');

  // Also log this message
  addLogEntry(message, type);
}

// Add log entry to log container
function addLogEntry(message, type = 'info') {
  // Create timestamp
  const now = new Date();
  const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

  // Create log entry
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry log-${type}`;

  // Set inner HTML with timestamp and message
  logEntry.innerHTML = `<span class="log-timestamp">[${timestamp}]</span> ${message}`;

  // Add to log content
  logContent.appendChild(logEntry);

  // Auto-scroll to bottom
  logContent.scrollTop = logContent.scrollHeight;

  // Store in log entries array
  logEntries.push({
    timestamp,
    message,
    type
  });

  // Limit to last 50 entries
  if (logEntries.length > 50) {
    logEntries.shift();
    // Only remove from DOM if there are too many entries to avoid flickering
    if (logContent.children.length > 50) {
      logContent.removeChild(logContent.firstChild);
    }
  }
}

// Check if a URL is a valid Strava activity URL
function isValidStravaActivityUrl(url) {
  return /^https:\/\/www\.strava\.com\/activities\/\d+/.test(url);
}

// Get CSS class for time difference (red for slower, green for faster)
function getTimeDiffClass(timeDiff) {
  if (timeDiff.startsWith('+')) return 'positive-diff';
  if (timeDiff.startsWith('-')) return 'negative-diff';
  return '';
}

// Get CSS class for speed difference (green for faster, red for slower)
function getSpeedDiffClass(speedDiff) {
  const value = parseFloat(speedDiff);
  if (value > 0) return 'negative-diff';
  if (value < 0) return 'positive-diff';
  return '';
}

// Get CSS class and inline style for time difference
function getTimeDiffStyle(timeDiff) {
  const diffValue = parseFloat(timeDiff.replace(/[^\d.-]/g, '')); // Extract numeric value
  const intensity = Math.min(255, Math.abs(diffValue) * 10); // Scale intensity (max 255)
  const color = timeDiff.startsWith('+') ? `rgba(220, 38, 38, ${intensity / 255})` : `rgba(34, 197, 94, ${intensity / 255})`; // Red for positive, green for negative
  return `background-color: ${color};`;
}

// Get CSS class and inline style for speed difference
function getSpeedDiffStyle(speedDiff) {
  const diffValue = parseFloat(speedDiff.replace(/[^\d.-]/g, '')); // Extract numeric value
  const intensity = Math.min(255, Math.abs(diffValue) * 10); // Scale intensity (max 255)
  const color = diffValue > 0 ? `rgba(220, 38, 38, ${intensity / 255})` : `rgba(34, 197, 94, ${intensity / 255})`; // Red for positive, green for negative
  return `background-color: ${color};`;
}


