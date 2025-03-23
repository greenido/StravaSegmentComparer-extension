# Strava Segment Comparator Extension

This is a Chrome extension that allows users to compare two Strava activities by their segments. The extension provides a user-friendly interface to input activity URLs, compare segments, and export the comparison data as a CSV file.

If you have any questions or issues, please open an issue on GitHub.

## Features

- Input URLs for two Strava activities
- Compare segments between the two activities
- Filter segments by name
- Export comparison data as a CSV file
- View activity logs

## Installation

1. Clone the repository:
    ```sh
    git clone https://github.com/yourusername/StravaSegmentComparer-extension.git
    ```
2. Navigate to the project directory:
    ```sh
    cd StravaSegmentComparer-extension
    ```
3. Install dependencies:
    ```sh
    npm install
    ```

## Usage

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable "Developer mode" using the toggle in the top right corner.
3. Click "Load unpacked" and select the project directory.
4. The extension should now appear in your list of extensions.

## Development

### File Structure

- `background.js`: Background script for the extension.
- `content-script.js`: Content script injected into Strava pages.
- `popup.html`: HTML for the popup interface.
- `popup.js`: JavaScript for the popup interface.
- `utils.js`: Utility functions used across the extension.
- `tailwind.config.js`: Configuration for Tailwind CSS.
- `postcss.config.js`: Configuration for PostCSS.
- `manifest.json`: Manifest file for the Chrome extension.
- `icons/`: Directory containing icon files.
- `lib/`: Directory containing third-party libraries (e.g., Simple-DataTables).

### Scripts

- `popup.js`: Handles user interactions in the popup and communicates with the background script.
- `utils.js`: Contains utility functions for data processing and API requests.

### Styles

- `tailwind.css`: Source file for Tailwind CSS.
- `tailwind.output.css`: Compiled Tailwind CSS file.
- `popup.css`: Custom styles for the popup interface.

### Configuration

- `tailwind.config.js`: Tailwind CSS configuration file.
- `postcss.config.js`: PostCSS configuration file.

## Contributing

1. Fork the repository.
2. Create a new branch:
    ```sh
    git checkout -b feature/your-feature-name
    ```
3. Make your changes and commit them:
    ```sh
    git commit -m "Add your commit message"
    ```
4. Push to the branch:
    ```sh
    git push origin feature/your-feature-name
    ```
5. Open a pull request.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE.md) file for details.

## Acknowledgements

- [Simple-DataTables](https://github.com/fiduswriter/Simple-DataTables) for the data table functionality.
- [Tailwind CSS](https://tailwindcss.com/) for the utility-first CSS framework.

## Contact

For any inquiries or issues, please open an issue on GitHub or contact the repository owner.
