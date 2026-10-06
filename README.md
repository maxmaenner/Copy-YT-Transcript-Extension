# Copy YouTube Transcript

A lightweight Manifest V3 browser extension that adds a **Copy transcript** button directly to YouTube watch pages.

Copy available captions as plain text or Markdown, with optional timestamps. The extension has no build step, no runtime dependencies, and no external backend.

## Preview

| YouTube watch page | Extension settings |
| --- | --- |
| ![Copy transcript button in the YouTube action bar](assets/readme-youtube-action-bar.png) | ![Extension popup with transcript formatting options](assets/readme-extension-popup.png) |

## Features

- Adds a native-looking **Copy transcript** action to YouTube watch pages
- Loads available manual or auto-generated captions without opening YouTube's transcript panel
- Supports **Plain text** and **Markdown** output
- Optional timestamps in `[mm:ss]` or `[hh:mm:ss]` format
- Remembers settings through `chrome.storage.sync`
- Handles YouTube's single-page navigation between videos
- Falls back across multiple YouTube caption response formats when necessary
- Shows clear loading, copied, and unavailable states

## Installation

### Load from source

1. Clone or download this repository.
2. Open your browser's extension manager:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository root containing `manifest.json`.

The extension is designed for Chromium-based browsers with Manifest V3 support.

## Usage

1. Open a YouTube video with captions.
2. Wait for **Copy transcript** to appear in the video action bar.
3. Click it to copy the transcript.
4. Use the extension popup to change output format or enable timestamps.

### Example output

Plain text:

```text
Welcome to the video.
Today we are covering...
```

With timestamps:

```text
[00:00] Welcome to the video.
[00:04] Today we are covering...
```

Markdown:

```md
- **[00:00]** Welcome to the video.
- **[00:04]** Today we are covering...
```

## How it works

The content script reads caption metadata exposed by the YouTube watch page. When necessary, it uses YouTube's own player endpoints as a fallback to resolve caption tracks, then parses supported caption formats and copies the formatted result locally.

There is no application server and transcript content is not sent to infrastructure operated by this project.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Stores output-format and timestamp preferences. |
| `clipboardWrite` | Allows the extension to copy the generated transcript. |
| `*://*.youtube.com/*` | Runs the extension and retrieves caption data on YouTube. |

For more detail, see [PRIVACY.md](PRIVACY.md).

## Project structure

```text
.
├── assets/          README screenshots
├── content.css      YouTube action-button styling
├── content.js       Caption discovery, parsing, formatting, and UI logic
├── manifest.json    Manifest V3 extension configuration
├── popup.html       Extension settings UI
└── popup.js         Settings persistence
```

## Development

No compilation or bundling is required.

After editing the source files:

1. Open `chrome://extensions`.
2. Click **Reload** on the extension.
3. Refresh an open YouTube watch page.

The repository CI performs JavaScript syntax checks and validates `manifest.json`.

## Limitations

- A transcript can only be copied when YouTube exposes a usable caption track for the video.
- YouTube is a frequently changing application, so DOM selectors or internal caption responses may occasionally require maintenance.
- The project is not affiliated with or endorsed by YouTube or Google.

## Contributing

Contributions and bug reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

For security-sensitive reports, see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
