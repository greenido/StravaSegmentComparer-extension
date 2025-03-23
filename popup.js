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

// Log entries array to track all messages
let logEntries = [];

// Global variables

// Initialize popup
document.addEventListener('DOMContentLoaded', () => {
  // Set up event listeners
  compareBtn.addEventListener('click', compareActivities);
  exportBtn.addEventListener('click', exportAsCSV);
  
  // Check if we're on a Strava activity page and pre-fill the first input
  chrome.tabs.query({active: true, currentWindow: true}, tabs => {
    const url = tabs[0].url;
    if (url && url.match(/https:\/\/www\.strava\.com\/activities\/\d+/)) {
      activity1Input.value = url;
    }
  });
  
  // Load any previously saved URLs
  chrome.storage.local.get(['activity1', 'activity2'], data => {
    if (data.activity1) activity1Input.value = data.activity1;
    if (data.activity2) activity2Input.value = data.activity2;
  });
});

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
  
  // Save URLs to local storage
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
    
    addLogEntry(`Activity #1: Found ${activity1Data.segments.length} segments`, 'success');
    addLogEntry(`Activity #2: Found ${activity2Data.segments.length} segments`, 'success');
    
    // Process and compare segment data
    addLogEntry('Comparing segment data between activities...', 'info');
    comparisonData = compareSegmentData(activity1Data, activity2Data);
    
    // Display results
    addLogEntry(`Displaying ${comparisonData.length} matched segments in table`, 'info');
    displayResults(comparisonData);
    
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
  
  // Sort results by segment name
  const sortedResults = results.sort((a, b) => a.name.localeCompare(b.name));
  addLogEntry(`Sorting ${sortedResults.length} segments alphabetically`, 'info');
  
  return sortedResults;
}

// Display results in the table
function displayResults(data) {
  addLogEntry('Setting up results table...', 'info');
  const tableBody = document.getElementById('segmentsTableBody');
  
  // Clear existing table
  tableBody.innerHTML = '';
  addLogEntry('Cleared previous table data', 'info');
  
  // Add rows to table
  addLogEntry(`Adding ${data.length} rows to table`, 'info');
  data.forEach((row, index) => {
    const tr = document.createElement('tr');
    
    // Add cells for each data point
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.time_1}</td>
      <td>${row.time_2}</td>
      <td class="${getTimeDiffClass(row.time_diff)}">${row.time_diff}</td>
      <td>${row.speed_1}</td>
      <td>${row.speed_2}</td>
      <td class="${getSpeedDiffClass(row.speed_diff)}">${row.speed_diff}</td>
    `;
    
    tableBody.appendChild(tr);
    
    // Log progress for large tables (every 10 rows)
    if (data.length > 20 && index % 10 === 0 && index > 0) {
      addLogEntry(`Added ${index} of ${data.length} rows to table...`, 'info');
    }
  });
  
  // Initialize or refresh DataTable
  if (dataTable) {
    addLogEntry('Refreshing existing DataTable instance', 'info');
    dataTable.destroy();
  }
  
  addLogEntry('Initializing sortable/filterable table', 'info');
  // The library might expose itself as either simpleDatatables or SimpleDatatables
  const DataTableConstructor = window.simpleDatatables?.DataTable || 
                               window.SimpleDatatables?.DataTable || 
                               window.DataTable;
                               
  if (!DataTableConstructor) {
    addLogEntry('Error: DataTable library not properly loaded', 'error');
    return;
  }
  
  dataTable = new DataTableConstructor("#segmentsTable", {
    searchable: true,
    fixedHeight: false,
    perPage: 50
  });
  
  addLogEntry('Table setup complete', 'success');
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
  const headers = ['Segment Name', 'Time 1', 'Time 2', 'Time Difference', 'Speed 1', 'Speed 2', 'Speed Difference'];
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


