# Contributing

Contributions are welcome.

## Local setup

1. Fork or clone the repository.
2. Open `chrome://extensions` in a Chromium-based browser.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the repository root.
5. Reload the extension after source changes.

There is no build step.

## Before opening a pull request

- Keep changes focused and easy to review.
- Preserve the extension's no-dependency, no-build architecture unless there is a strong reason to change it.
- Test on a standard YouTube watch page.
- Test navigation between multiple videos without a full page reload.
- Test at least one video with captions and one without captions.
- Keep user-facing text in English.
- Run the same syntax and manifest checks used by CI.

## Bug reports

Please include:

- Browser and version
- Example YouTube URL or video ID when appropriate
- Whether captions are visible in YouTube itself
- Expected behavior
- Actual behavior
