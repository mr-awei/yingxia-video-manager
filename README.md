# YingXia (影匣)

<div align="center">
  <strong><a href="README.md">English</a></strong>
  <span> · </span>
  <a href="README.zh-CN.md">中文</a>
</div>

<div align="center">
  <strong>v2.6.6</strong> ·
  <span>2026-09-02</span> ·
  <a href="CHANGELOG.md">Changelog</a>
</div>

<br />

## Local Video Poster Wall Manager · Excel-Sheet-Driven Private Library

**Core principle: 100% local. No data collection. No outbound transmission.**

YingXia is a Windows desktop app that turns a local video folder into a beautiful poster-wall library. Pair it with an Excel sheet (your personal catalog) and the app will organize, categorize, and enrich your collection automatically — while keeping every byte of metadata on your own machine.

> ⚠️ This tool is intended for managing **adult video collections** stored locally by the owner. It does not distribute, upload, or share any content.

---

## Highlights

- **Excel-sheet-driven catalog**: Your spreadsheet is the single source of truth for `分类 / 推荐评分 / 简介 / 主题 / 角色 / 服装 / 体型 / 行为 / 玩法 / 场景 / 剧情 / 其他`. Reconcile it against the folder anytime — the detail page renders every non-empty tag group from your sheet as-is.
- **Three-layer tag model**: Sheet tags → structured `tagCategories` (grouped) → flat `tags` (all) → source `backupTags` (JavDB/JavBus/etc). Clean separators, trailing numbers, and bracket noise out of the box.
- **Poster wall browsing**: Three density levels (immersive / standard / compact), 1 s hover-to-zoom delay, and smooth virtual scrolling for large libraries.
- **Flat or grouped view**: Choose whether the default library view shows everything flat or grouped by the Excel `分类` column — persisted in Settings.
- **Smart metadata fetch**: Auto-identifies video codes and fetches metadata from configurable sources (JavDB, JavBus, JavLibrary, Javapi, Javinfo) with automatic fallback. Drag-to-reorder sources, pause/resume/stop the batch, and get per-video failure reasons shown both as a toast and inline in the detail page.
- **Series episodes**: Multiple files for the same code (e.g. `SONE-560_1.mp4`, `SONE-560_2.mp4`) show as one card; the detail page lists episodes and lets you switch.
- **Random, quality-filtered frame extraction**: When no source cover is available, ffmpeg extracts 12–22 candidate frames and automatically rejects black, white, blurry, or monotonous frames — so "Re-frame" always produces a fresh, sharp pick. Auto-framing on the detail page uses the same pipeline as manual framing.
- **Bilingual from install**: The NSIS installer asks for your language (简体中文 / English) on the first screen; the app opens in that language, the uninstaller follows it, and you can switch anytime in Settings.
- **English notice without PRC laws**: The in-app legal notice renders locale-specific content — Chinese users see PRC law excerpts; English users see a generic disclaimer.
- **Privacy shield**: One-click blur of all covers, deletion-lock with SHA-256 verification, and zero uploads.
- **Network proxy**: Configurable HTTP / HTTPS / SOCKS5 proxy covering both Node.js requests and the Chromium network stack.
- **Statistics & discovery**: Filter by tag / series / custom field, view totals and top largest files, random picks, and favorites.
- **System integration**: Windows NSIS installer, auto-start on boot, tray minimization, update checker, and GitHub / Gitee dual release.

---

## Excel Sheet Schema

The app expects an **English-header** sheet with columns in this order:

| Column | Purpose |
| --- | --- |
| Code | 番号 / Video code (e.g. `SONE-560`) — **required** |
| Rating | 用户评分 / Your personal rating (optional) |
| Category | 分类 / Single-value category, shown as a MetaRow in the detail page |
| Theme | 主题 / Theme tags |
| Role | 角色 / Role tags |
| Costume | 服装 / Costume tags |
| BodyType | 体型 / Body type tags |
| Behavior | 行为 / Behavior tags |
| Play | 玩法 / Play tags |
| Scene | 场景 / Scene tags |
| Plot | 剧情 / Plot tags |
| Other | 其他 / Other tags |

AI-generated sheets usually produce **中文 headers**. The onboard wizard auto-maps common Chinese header names to the English schema above before writing to disk.

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

## Version History

**v2.6.6** (2026-09-02) — Tag-layer fix · screenshot-failure details · Excel sheet wizard alignment · metadata cleanup

- **Fixed inconsistent `Source tags` display**: all source-side genres now unconditionally land in `backupTags`, so the detail page shows the full category set.
- **Fixed the Excel `分类` column leaking into tag groups**: the column now flows through a dedicated `Video.introCategory` field and renders as a standalone MetaRow.
- **Fixed JavDB genres parser pulling actor groups** (`【多人】5`): corrected to `/tags` structure and added a shared `cleanGenreName()` sanitizer used by all five sources.
- **Screenshot-failure details in two places**: failed count, de-duplicated reasons, and hints shown both in the toast and inline in the detail page.
- **Unified hover-to-zoom delay to 1 s**; **auto framing now uses the same multi-frame pipeline** as manual "Re-frame".
- **Excel sheet wizard prompt aligned to the real schema**; **store schema bumped to `2026090204`** with dirty-tag cleanup.

Older releases: see [CHANGELOG.md](CHANGELOG.md).

---

## Privacy Statement

1. **Zero uploads**: The app never transmits any user data — no video lists, no tags, no ratings, no file paths, no filenames — to any server.
2. **Local-only storage**: All data lives in `%APPDATA%\local-video-manager\data.json`. Back it up or delete it at any time.
3. **Anonymous network requests**: Outbound requests are only made when you explicitly configure a cover/metadata source. Requests carry no identifying headers (anonymous User-Agent, no cookies).
4. **Works fully offline**: With the network disconnected, every core feature — scanning, browsing, details, playback, reconciliation — functions normally. Only the optional fetch features stop.

---

## License

MIT