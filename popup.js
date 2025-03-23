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
  
  if (!isValidStravaActivityUrl(activity1Url) || !isValidStravaActivityUrl(activity2Url)) {
    showStatus('Please enter valid Strava activity URLs', 'error');
    return;
  }
  
  // Save URLs to local storage
  chrome.storage.local.set({
    activity1: activity1Url,
    activity2: activity2Url
  });
  
  // Extract activity IDs
  const activity1Id = extractActivityId(activity1Url);
  const activity2Id = extractActivityId(activity2Url);
  
  // Show loading status
  showStatus('Fetching segment data from both activities...', 'loading');
  
  try {
    // Request segment data for both activities
    const [activity1Data, activity2Data] = await Promise.all([
      fetchActivityData(activity1Id),
      fetchActivityData(activity2Id)
    ]);
    
    // Process and compare segment data
    comparisonData = compareSegmentData(activity1Data, activity2Data);
    
    // Display results
    displayResults(comparisonData);
    
    // Show success status
    showStatus(`Successfully compared ${comparisonData.length} segments`, 'success');
    
    // Show results container
    resultsDiv.classList.remove('hide');
    
  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
    console.error(error);
  }
}

// Fetch activity data function
function fetchActivityData(activityId) {
  return new Promise((resolve, reject) => {
    // Send message to content script to extract data from the page
    chrome.tabs.create(
      { url: `https://www.strava.com/activities/${activityId}`, active: false },
      tab => {
        // Listen for the content script to finish extracting data
        const listener = (message, sender, sendResponse) => {
          if (sender.tab && sender.tab.id === tab.id && message.type === 'segmentData') {
            chrome.tabs.remove(tab.id);
            chrome.runtime.onMessage.removeListener(listener);
            
            if (message.error) {
              reject(new Error(message.error));
            } else {
              resolve(message.data);
            }
          }
        };
        
        chrome.runtime.onMessage.addListener(listener);
        
        // Execute content script after page load
        setTimeout(() => {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: () => {
              // This function is executed in the context of the opened tab
              const scriptElement = document.createElement('script');
              scriptElement.textContent = `
                // Notify that we need to extract segments data
                document.dispatchEvent(new CustomEvent('extractSegmentData'));
              `;
              document.documentElement.appendChild(scriptElement);
              scriptElement.remove();
            }
          });
        }, 3000); // Wait for page to load
      }
    );
  });
}

// Compare segment data from both activities
function compareSegmentData(activity1Data, activity2Data) {
  const results = [];
  
  // Create a map of segments from activity 1
  const activity1Segments = new Map();
  activity1Data.segments.forEach(segment => {
    activity1Segments.set(segment.name, segment);
  });
  
  // Match segments from activity 2 with activity 1
  activity2Data.segments.forEach(segment2 => {
    const segment1 = activity1Segments.get(segment2.name);
    
    if (segment1) {
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
      
      // Remove matched segment from activity1Segments
      activity1Segments.delete(segment1.name);
    }
  });
  
  // Sort results by segment name
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// Display results in the table
function displayResults(data) {
  const tableBody = document.getElementById('segmentsTableBody');
  
  // Clear existing table
  tableBody.innerHTML = '';
  
  // Add rows to table
  data.forEach(row => {
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
  });
  
  // Initialize or refresh DataTable
  if (dataTable) {
    dataTable.destroy();
  }
  
  dataTable = new simpleDatatables.DataTable("#segmentsTable", {
    searchable: true,
    fixedHeight: false,
    perPage: 10
  });
}

// Export data as CSV
function exportAsCSV() {
  if (!comparisonData.length) {
    showStatus('No data to export', 'error');
    return;
  }
  
  // Create CSV content
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
  
  // Create download link
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', 'strava_segment_comparison.csv');
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// Show status message
function showStatus(message, type = 'info') {
  statusDiv.textContent = message;
  statusDiv.className = 'status ' + type;
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
