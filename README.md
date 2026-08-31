# YingXia (影匣)

<div align="center">
  <strong><a href="README.md">English</a></strong>
  <span> · </span>
  <a href="README.zh-CN.md">中文</a>
</div>

<br />

## Local Video Poster Wall Manager · Excel-Sheet-Driven Private Library

**Core principle: 100% local. No data collection. No outbound transmission.**

YingXia is a Windows desktop app that turns a local video folder into a beautiful poster-wall library. Pair it with an Excel sheet (your personal catalog) and the app will organize, categorize, and enrich your collection automatically — while keeping every byte of metadata on your own machine.

> ⚠️ This tool is intended for managing **adult video collections** stored locally by the owner. It does not distribute, upload, or share any content.

---

## Highlights

- **Excel-sheet-driven catalog**: Your spreadsheet is the single source of truth for categories, ratings, tags, and descriptions. Reconcile it against the folder anytime to spot missing or uncategorized entries.
- **Poster wall browsing**: Three density levels (immersive / standard / compact), hover cards for quick info, and smooth virtual scrolling for large libraries.
- **Flat or grouped view**: Choose whether the default library view shows everything flat or grouped by Excel category — persisted in Settings.
- **Smart metadata fetch**: Auto-identifies video codes and fetches metadata from configurable sources (JavDB, JavBus, JavLibrary, Javapi, Javinfo) with automatic fallback and a draggable progress panel that supports pause / resume / stop.
- **Series episodes**: Multiple files for the same code (e.g. `SONE-560_1.mp4`, `SONE-560_2.mp4`) show as one card in the grid; the detail page lists episodes and lets you switch between them.
- **Random, quality-filtered frame extraction**: When no source cover is available, ffmpeg extracts 12–22 candidate frames and automatically rejects black, white, blurry, or monotonous frames — so "re-screenshot" always produces a fresh, sharp pick.
- **Bilingual UI from install**: The NSIS installer asks for your language (简体中文 / English) on the very first screen; the app opens in that language on first launch, and the uninstaller follows it too. Switch anytime in Settings.
- **English notice without PRC laws**: The in-app legal notice renders locale-specific content — Chinese users see PRC law excerpts; English users see a generic disclaimer without references to Chinese laws.
- **Privacy shield**: One-click blur of all covers, deletion-lock with SHA-256 verification, and zero uploads.
- **Network proxy**: Configurable HTTP / HTTPS / SOCKS5 proxy that covers both Node.js requests and the Chromium network stack.
- **Statistics & discovery**: Filter by tag / series / custom field, view totals and top largest files, random picks, and favorites.
- **System integration**: Windows NSIS installer, auto-start on boot, tray minimization, update checker, and GitHub / Gitee dual release.

---

## Tech Stack

- **Desktop**: Electron 31 + electron-vite
- **Frontend**: React 18 + TypeScript + Tailwind CSS
- **Build & packaging**: electron-builder (Windows NSIS installer)
- **Data**: Local JSON + Excel (xlsx) parsing
- **Media**: ffmpeg / ffprobe (system or bundled fallback)

---

## Development

```bash
npm install
npm run dev        # start dev mode (DevTools opens automatically)
npm run build      # build renderer + main + preload
npm run typecheck  # TypeScript type checking
npm run pack       # clean + build + electron-builder installer
```

---

## Privacy Statement

1. **Zero uploads**: The app never transmits any user data — no video lists, no tags, no ratings, no file paths, no filenames — to any server.
2. **Local-only storage**: All data lives in `%APPDATA%\local-video-manager\data.json`. Back it up or delete it at any time.
3. **Anonymous network requests**: Outbound requests are only made when you explicitly configure a cover/metadata source. Requests carry no identifying headers (anonymous User-Agent, no cookies).
4. **Works fully offline**: With the network disconnected, every core feature — scanning, browsing, details, playback, reconciliation — functions normally. Only the optional fetch features stop.

---

## License

MIT
