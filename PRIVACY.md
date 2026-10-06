# Privacy

Copy YouTube Transcript is designed to work locally in the browser.

## Data handled by the extension

The extension may access:

- The current YouTube video ID and page state
- Caption metadata and transcript responses provided by YouTube
- The user's selected output format and timestamp preference

## Data storage

Only extension preferences are stored using `chrome.storage.sync`.

Transcript text is held temporarily in memory while the current video is open and is copied to the clipboard when requested.

## Network requests

The extension communicates with YouTube domains to discover and retrieve caption data. It does not send transcript content or usage data to servers operated by this project.

## Analytics

This project does not include its own analytics or tracking system.

## Third parties

YouTube and the browser may process data according to their own policies. This project is independent and is not affiliated with Google or YouTube.
