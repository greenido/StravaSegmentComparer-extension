# Changelog

## Version 2.2 - Help System Enhancement

### 🆕 New Features
- **Help Icon**: Added a help icon (❓) in the top-right corner of the popup
- **Collapsible Help Section**: Tips and instructions are now hidden by default and shown only when the help icon is clicked
- **Interactive Help Button**: Help icon changes appearance when active and provides visual feedback
- **Improved UX**: Cleaner interface with help content accessible on-demand

### 🎨 UI/UX Improvements
- Moved tip text from always-visible to on-demand help section
- Added smooth transitions for help section show/hide
- Enhanced help content with step-by-step instructions
- Added visual feedback for help button states (hover, active)
- Improved header layout with help icon positioned in top-right corner

### 🔧 Technical Changes
- Added `toggleHelpSection()` function to handle help visibility
- Enhanced CSS with `.help-icon` styles and `.active` state
- Added transition animations for smooth help section appearance
- Updated DOM structure to accommodate help icon in header

## Version 2.1 - Auto-Detection Feature

### 🆕 New Features
- **Auto-Detection of Open Strava Activity Tabs**: The extension now automatically scans all open browser tabs to find Strava activity pages and populates the input fields automatically
- **Auto-Detect Button**: Added a manual "Auto-Detect" button to re-scan tabs on demand
- **Enhanced Status Messages**: Added emoji-enhanced status messages with better visual feedback
- **Detailed Tab Logging**: Activity logs now show detailed information about detected tabs

### 🔧 Technical Changes
- Added `"tabs"` permission to `manifest.json` to enable querying all browser tabs
- Created `autoPopulateActivityUrls()` function that:
  - Queries all open tabs using `chrome.tabs.query({})`
  - Filters tabs matching Strava activity URL pattern (`/https:\/\/www\.strava\.com\/activities\/\d+/`)
  - Sorts tabs by ID for consistent ordering (oldest tabs first)
  - Populates the first two detected activity URLs
  - Saves detected URLs to Chrome storage
- Modified popup initialization to run auto-detection after loading saved URLs
- Added event listener for the new "Auto-Detect" button

### 🎨 UI/UX Improvements
- Updated input field placeholders to indicate auto-detection capability
- Added informational tip text explaining the auto-detection feature
- Enhanced status messages with emojis for better visual feedback
- Improved activity logs with more detailed information about the detection process

### 📝 Documentation Updates
- Updated README.md with new auto-detection usage instructions
- Added "Quick Start" section for auto-detection workflow
- Created test documentation file (`test-auto-detect.html`)
- Updated feature list to highlight auto-detection capability

### 🔄 Workflow Changes
1. **Previous workflow**: User manually enters two Strava activity URLs
2. **New workflow**: 
   - User opens 2 Strava activity pages in separate tabs
   - Extension automatically detects and populates URLs when popup opens
   - User can click "Auto-Detect" to re-scan if needed
   - Fallback to manual entry if no tabs are detected

### 🛡️ Privacy & Security
- Extension only accesses tab URLs for detection purposes
- No external data transmission
- Maintains existing privacy standards
- Tab access is limited to URL pattern matching

### 🧪 Testing
- All JavaScript files pass syntax validation
- Auto-detection works with multiple tab scenarios:
  - 0 tabs: Shows message to open Strava activities
  - 1 tab: Populates first field, prompts for second
  - 2+ tabs: Populates both fields, uses first two found
- Maintains backward compatibility with manual URL entry 