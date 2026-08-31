# YingXia (影匣)

<div align="center">
  <strong><a href="README.md">English</a></strong>
  <span> · </span>
  <a href="README.zh-CN.md">中文</a>
</div>

<br />

## Local Video Poster Wall Manager · Excel-Sheet-Driven Private Library

**Core principle: 100% local. No data collection. No outbound transmission.** All metadata (video info, ratings, tags) is stored in local JSON files. The app **never actively crawls any third-party services for video data**. Users may optionally configure a third-party cover image service, but all requests are made solely to fetch cover images — with no user identifiers attached and nothing uploaded anywhere.

Point it at a local video folder → optionally pair it with an Excel sheet → get an auto-generated poster wall library: hover to see descriptions, click for details, open videos with your local player, and reconcile folders against the sheet to spot missing entries.

## Features

- **Poster wall browsing**: browse videos grouped by categories from your sheet, with three density levels — immersive, standard, and compact
- **Hover preview**: mouse hover reveals description, code, tags, and custom fields
- **Detail page**: poster, tag filtering, series episode linking, and random recommendations
- **Local playback**: opens videos with your system's default player
- **Sheet reconciliation**: automatically reconciles files in the folder against entries in your sheet, listing any videos not yet cataloged
- **Cover auto-fetch (optional)**: for videos missing cover art, pull covers from a user-configured third-party service — fully transparent and toggleable
- **Smart ffmpeg resolution**: prefers an ffmpeg installation already on your system to save disk space
- **Privacy mode**: one-click blur of all cover images, ideal for screen sharing
- **Statistics panel**: total file size, top 10 largest files, filter and aggregate by tag / series / custom field
- **Settings**: auto-start on boot, minimize to tray, privacy mode default-on, scan concurrency, language switch (中文 / English), and more

## Tech Stack

- Electron + electron-vite
- React 18 + TypeScript
- Tailwind CSS
- electron-builder (Windows NSIS installer)

## Development

```bash
npm install
npm run dev        # start dev mode (DevTools opens automatically)
npm run build      # build only
npm run pack       # clean + build + electron-builder installer
```

## Privacy Statement

1. **Zero uploads**: The app never transmits any user data — no video lists, no tags, no ratings, no file paths, no filenames — to any server.
2. **Local-only storage**: All data lives in `%APPDATA%\local-video-manager\data.json`. Back it up or delete it at any time.
3. **Anonymous network requests**: The app only makes outbound requests after the user explicitly configures a cover image service. Requests carry no identifying headers (anonymous User-Agent, no cookies).
4. **Works fully offline**: With network disconnected, every core feature — scanning, browsing, details, playback, reconciliation — functions normally. Only the optional cover-fetch feature stops.

## License

MIT
