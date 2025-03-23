/**
 * Utility functions for Strava Segment Comparator
 */

/**
 * Parse time string (like "3:45") to seconds
 * @param {string} timeStr - Time string in format "mm:ss" or "h:mm:ss"
 * @returns {number} - Time in seconds
 */
function parseTimeToSeconds(timeStr) {
  if (!timeStr || timeStr === 'N/A') return 0;
  
  const parts = timeStr.split(':').map(part => parseInt(part, 10));
  
  if (parts.length === 3) {
    // Format: h:mm:ss
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // Format: mm:ss
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    // Format: ss or ss's'
    const seconds = parts[0];
    return seconds.toString().endsWith('s') ? parseInt(seconds.slice(0, -1), 10) : seconds;
  }
  
  return 0;
}

/**
 * Format time difference in seconds to a readable string
 * @param {number} diffSeconds - Difference in seconds
 * @returns {string} - Formatted time difference
 */
function formatTimeDiff(diffSeconds) {
  if (diffSeconds === 0) return '0:00';
  
  const sign = diffSeconds > 0 ? '+' : '-';
  const absoluteDiff = Math.abs(diffSeconds);
  
  const hours = Math.floor(absoluteDiff / 3600);
  const minutes = Math.floor((absoluteDiff % 3600) / 60);
  const seconds = absoluteDiff % 60;
  
  if (hours > 0) {
    return `${sign}${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  } else {
    return `${sign}${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
}

/**
 * Parse speed value from string (like "32.5 km/h")
 * @param {string} speedStr - Speed string
 * @returns {number} - Speed value in km/h
 */
function parseSpeedValue(speedStr) {
  if (!speedStr || speedStr === 'N/A') return 0;
  
  const match = speedStr.match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Format seconds to time string (mm:ss or h:mm:ss)
 * @param {number} seconds - Time in seconds
 * @returns {string} - Formatted time string
 */
function formatSecondsToTime(seconds) {
  if (isNaN(seconds)) return 'N/A';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}
