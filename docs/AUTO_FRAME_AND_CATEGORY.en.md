# Requirement: Cover Frame Fallback + Auto-Categorization

> Version: v0.1 (draft, pending review)
> Applies to: YingXia (yingxia-video-manager) v2.x
> Related: v2.0.1 (auto ffmpeg frame for missing covers) + v2.0.2 (thumbnail filter) + v2.0.3 (detail-page UI rollback)

---

## 1. Background & Current State

### 1.1 Problems

**A. Missing-cover videos pile up as gray placeholders**

Inside a typical library (100–500 videos), the following scenario is common:
- Some titles have **no matching entry across JavDB / JavBus / JavLibrary** (obscure titles, unreleased, code extraction error, etc.)
- These videos have no cover, empty metadata — the list page / detail page / card wall shows a **gray placeholder**, which looks bad
- v2.0.1 already implemented "auto ffmpeg frame for missing covers" (scan / reconcile / completion paths), v2.0.2 already uses the `thumbnail` filter to pick the most representative frame; but **behavioral details, fallback handling, concurrency, retries, and more still need to be worked out**

**B. "Uncategorized" bucket is meaningless**

For videos that "have JavDB/JavBus metadata but are NOT in the sheet" (e.g., 8 videos in the DLDSS series), reconcileLibrary currently lumps them all into one `【Uncategorized】` category.

This creates two problems:
1. Users see "Uncategorized - 8 titles" and can't tell whether these are "no metadata" or "metadata exists but isn't in the sheet"
2. JavBus already fetched `genres: ["HD", "Subtitled", ...]` — but this structured data is discarded

### 1.2 Screenshot Example

**List page "Uncategorized - 8 titles" actually has JavBus metadata**

```
MeiNaoSora - 16 titles
  Uncategorized - 8 titles
    dldss-001.mp4   [JavBus]
    dldss-030.mp4   [JavBus]
    dldss-129.mp4   [JavBus]
    ... (all 8 are DLDSS series, all from JavBus)
```

**Detail page shows JavBus-fetched genres but they're not being used** (screenshot 1 DLDSS-409)

- Source: JavBus
- Genres: `HD` / `Subtitled` (from `javdbDetail.genres`)
- Current category: `【Uncategorized】` (should auto-categorize based on genres)

---

## 2. Goals

1. **All videos without covers end up with a real image** (ffmpeg frame), and the frame has actual content — no black frames, no static frames
2. **Videos with metadata but not in the sheet get auto-categorized by their genres**, no more meaningless "Uncategorized" buckets
3. **Don't break existing data**: categories defined in the sheet (md/Excel) take priority; auto-categorization is the fallback layer
4. **Graceful degradation**: when ffmpeg is unavailable, file is inaccessible, or concurrency pool is full, library scan / reconcile / completion still complete normally (frame-fetch failure never blocks the main flow)

---

## 3. Detailed Requirements

### Requirement A: Auto ffmpeg Frame Fallback for Missing Covers (refined)

#### A.1 Trigger Conditions (precise)

Videos that satisfy **ALL** of the following conditions trigger auto frame-fetch to generate a cover:

| Condition | Description |
|---|---|
| `video.posterPath` is empty | Field missing or value is `undefined`/`null`/`''` |
| `video.posterSource === 'placeholder'` | Current source is a placeholder (manual spec / sidecar / source fetch / ffmpeg all failed) |
| Source fetch is complete | At least one round of javdb / javbus / javlibrary fetch was attempted (detail-page "complete info" or batch completion has run) |

**Trigger paths** (covers all possible entry points):

1. **Scan library** (`scanLibrary` enrichment phase) — force frame-fetch for videos with no cover
2. **Reconcile completion** (`reconcileLibrary` end) — collect `matched` videos with no poster, async frame-fetch in background
3. **Batch completion completion** (`libraryFetchJavdbAll` end) — async frame-fetch in background
4. **Single video re-frame** on detail page (`videoGeneratePreviews`) — manual user trigger

**Do NOT trigger** when:
- Video has a source cover (`posterSource` is `javdb`/`javbus`/`javlibrary`) — don't overwrite
- Video has a manually-assigned cover (`posterSource === 'manual'`) — don't overwrite
- Video already has ffmpeg frame cache (`posterPathFfmpeg` exists) — reuse, don't re-fetch

#### A.2 Frame Selection Strategy (precise)

Use **ffmpeg `thumbnail` filter** (implemented in v2.0.2), parameters:

```bash
ffmpeg -y -i <video.path> \
  -vf "thumbnail=n=<N>,scale=480:-1" \
  -frames:v 1 \
  -q:v 2 \
  <cover.jpg>
```

**Adaptive `n` (sample frame count)** (implemented in v2.0.2):

| Video duration `dur` | Sample frames `n` |
|---|---|
| `dur < 30s` | 100 (minimum guarantee) |
| `30s ≤ dur < 6000s (100 min)` | `floor(dur / 30)`, ~one frame every 30 seconds |
| `dur ≥ 6000s` | 200 (cap, avoid slowing scans on long videos) |

**Output specs**:
- Width 480px (`-1` height keeps aspect ratio)
- JPEG q=2 (high quality ≈ qscale 2~5)
- Typical file size 30~80 KB

#### A.3 Fallback on Failure (precise)

Handle failures in this order:

| Failure | Detection | Fallback |
|---|---|---|
| ffmpeg unavailable | `await ffmpegAvailable(settings)` returns `null` | Skip frame-fetch, use placeholder cover; log `frameLog`; no error thrown |
| Frame-fetch command failed | `spawn` close code !== 0 | Skip this video; don't retry; next scan / reconcile / completion will try again |
| Video file inaccessible | `fs.stat` throws `ENOENT` / `EACCES` | Skip this video; log |
| Frame-fetch timeout | ffmpeg single run exceeds 30 seconds | `child.kill('SIGKILL')`; skip; don't block concurrency pool |
| Cache directory write fails | `fs.writeFile` / `fs.mkdir` throws | Skip; log |

**Key constraints**:
- Frame-fetch failure **never blocks** the main flow (scan / reconcile / completion continues)
- Frame-fetch failure **does NOT permanently mark the video as failed** — will be retried on the **next scan / reconcile** (natural retry mechanism)
- `windowsHide: true` on `spawn` to prevent black console windows on Windows

#### A.4 Concurrency & Timeout (precise)

- **Concurrency**: reuses `settings.scanConcurrency` (default 4, max 8) — shared pool with ffprobe tech detection
- **Single-run timeout**: kill ffmpeg subprocess after 30 seconds
- **Batch cap**: auto frame-fetch triggered by a single scan / reconcile / completion run, max 200 videos per library; extras wait for next run
- **Priority**: scan > reconcile > completion-triggered frame-fetch; user-clicked "re-frame" executes immediately (not through async queue)

#### A.5 Cache & Persistence (precise)

- **Cache dir**: `<video.id>.jpg` under `posters/` (implemented in v2.0.1)
- **Persisted fields**:
  - `video.posterPath` = local path of frame-generated cover
  - `video.posterSource = 'ffmpeg'`
  - `video.posterPathFfmpeg` = same as `posterPath` (saved separately from source covers, detail page can switch freely)
  - `video.previewPaths` = 15 preview image local paths (`generatePreviewSet` generates them as a bonus)
- **Reuse**: when `videoSwitchPoster` switches to ffmpeg, prefer reusing `posterPathFfmpeg` (avoid re-frame)

#### A.6 Visual Indicators (precise)

- **List / card badge**: ffmpeg-frame cover shows a purple `Frame` chip at the top-left of EntryCard and ListView (implemented in v2.0.2, purple `bg-violet-500/90` + film icon)
- **Detail page toggle button**: keep the design rolled back in v2.0.3 — no "Source image / FFmpeg Screenshot" toggle chips on detail page post-v2.0.3; if reintroduced in future, add near the "Re-frame" button

---

### Requirement B: Auto-Categorize Uncategorized Videos by Source Genres (brand new)

#### B.1 Trigger Conditions (precise)

Videos that satisfy **ALL** of the following enter auto-categorization flow:

| Condition | Description |
|---|---|
| Video did **not** match an md / Excel sheet entry during `reconcileLibrary` | Still fall into the "Uncategorized" branch (keep compatibility) |
| `video.javdbDetail` (or javbusDetail / javlibraryDetail) **is non-empty** | Metadata fetch succeeded |
| `video.javdbDetail.genres` (or corresponding field) **is a non-empty array** | At least 1 genre |
| `video.javdbDetail.source` is recorded | Used to determine category prefix |

#### B.2 Genre Source & Priority (precise)

**Single source scenario** (90% of current cases):

- **Use `javdbDetail.genres` as categorization basis** (v2.0.0+ already normalizes javbus / javlibrary fetched data into `javdbDetail.genres`)
- Whichever source's data ended up in `javdbDetail`, that source's genres are used

**Multi-source scenario** (v2.0.0+ auto fallback: javdb→javbus→javlibrary):

- Only genres from the **source that actually succeeded** end up in `javdbDetail.genres`
- No multi-source conflict (each fetch takes data from the first successful source only)

**Conflict rule**: multiple genres per video is normal (a title can be both "HD" and "Subtitled") — **no priority ordering, include all**

#### B.3 Categorization Logic (precise)

**Step 1: Generate auto-category name**

Generate **one unique** auto-category identifier per video:

```
Format: 【{source}】{genre1}·{genre2}·...
Example 1: 【JavBus】HD·Subtitled
Example 2: 【JavDB】Code verified·Solo
Example 3: 【JavLibrary】Western·HD
```

> Notes:
> - `{source}` = `javdb` / `javbus` / `javlibrary` (from `video.javdbDetail.source`)
> - `{genre}` from `video.javdbDetail.genres` (in array order)
> - Same-genre videos fall into the same category

**Step 2: Display in UI sidebar "Categories" list**

- In `entries` from reconcile, add a new kind: `kind: 'auto-categorized'`
- Sidebar category list inserts an "Auto-Categorized" group above "Uncategorized"; each `{source}+{genres}` combination shows under it (e.g., "【JavBus】HD·Subtitled - 8 titles")
- Sort: descending by "video count in that category", largest first

```
All
├─ Favorites
├─ Domestic
├─ Orgy (12)
├─ ...
├─ ─── Auto-Categorized ───
├─ 【JavBus】HD·Subtitled (8)
├─ 【JavBus】Subtitled·Exclusive (5)
├─ ...
└─ Unlisted (3)
```

**Step 3: Does the video show in both "Uncategorized" AND "Auto-Categorized"?**

- **No**. Once auto-categorized, **remove from "Uncategorized"**
- "Uncategorized" only keeps videos with **truly no metadata** (not in sheet AND no source fetched)

#### B.4 Data Structure (precise)

New `DisplayEntry` variant (`src/shared/types.ts`):

```typescript
/** Auto-categorized: category inferred from source genres (no md / Excel entry) */
interface AutoCategoryEntry {
  kind: 'auto-categorized'
  /** Auto-category key, e.g. "javbus:HD·Subtitled" */
  autoCategoryKey: string
  /** User-visible category name, e.g. "【JavBus】HD·Subtitled" */
  autoCategoryName: string
  /** Source (JavDB / JavBus / JavLibrary) */
  source: 'javdb' | 'javbus' | 'javlibrary'
  /** Video's genres (from javdbDetail.genres) */
  genres: string[]
  category: string          // same as autoCategoryName
  order: number             // auto-categorized fixed at 9000 (before uncategorized at 9999)
  code: string              // video code
  title: string
  description: string
  tags: string[]
  tagCategories?: Record<string, string[]>
  score?: number
  video: Video
}
```

**reconcileLibrary changes**:

- Current: videos with metadata but no sheet entry → fall into "Uncategorized"
- After:
  - Has `javdbDetail.genres` (non-empty) → generate auto-category, **fall into auto-category** (also **remove from "Uncategorized"**)
  - No `javdbDetail.genres` → fall into "Uncategorized" (keep current behavior)

**Video persistent fields** (optional, not mandatory; can be calculated during reconcile):

- `video.autoCategoryKey?: string` — auto-category key (still recognizable after restart)
- `video.autoCategoryName?: string` — auto-category display name

> **Reasons NOT to persist**: when genres change, autoCategory changes; persisting would leave stale categories after re-fetch. Reconcile recalculates each run.
> **Reasons TO persist**: avoids redundant per-reconcile calculation (O(n) → O(1)); follows the same reconcile path as sheet categories. **Final decision**: persist `autoCategoryKey` (lightweight; reconcile updates when it detects genre change).

#### B.5 UI Display (precise)

**Sidebar "Categories" list (Browse view)**:

(See Step 2 above for layout)

**List page / detail page behavior**:

- Click sidebar auto-category → show only videos in that auto-category
- Detail page "source" badge keeps v2.0.3 state (no JavLibrary blue; "no badge = JavDB" returns)
- Detail page "Genres" field normally shows `javdbDetail.genres` list (chips like "HD", "Subtitled")

**Priority between auto-categorization and sheet (md/Excel)**:

- If user later adds an entry for this code in md / Excel, next reconcile:
  - reconcile prioritizes the sheet entry → falls into user-configured category
  - removed from auto-categorization (because `entry.kind` becomes `matched`)

#### B.6 Edge Cases & Compatibility

- **Empty genres**: `javdbDetail.genres = []` → fall into "Uncategorized" (same behavior as "no metadata at all")
- **Stale metadata**: `javdbDetail` missing / no source → fall into "Uncategorized"
- **Domestic videos**: `video.domestic === true` → not participate in auto-categorization (keep in "Domestic" group)
- **Duplicate categorization**: multiple videos with exactly the same genres → fall into the same auto-category (dedupe)
- **Empty category**: all videos in an auto-category deleted / re-reconciled → category auto-removes from sidebar (no residue)
- **Sidebar performance**: auto-category count capped at 50; if exceeded, keep top 50 by "video count" descending; remaining videos fall into "Uncategorized" with a toast "auto-categorization cap reached at 50"

#### B.7 User Control (optional)

Settings → General → new "Auto-Categorize" toggle (default ON):
- **ON**: reconcile performs auto-categorization
- **OFF**: all "not in sheet" videos fall into "Uncategorized" (v2.0.3 behavior)

**Storage**: `settings.autoCategorize: boolean` (DEFAULT `true`)

---

## 4. Acceptance Criteria

### Requirement A (Frame)

- [ ] A1. After library scan completes (with coverless videos), all coverless videos have non-empty `posterPath` and `posterSource === 'ffmpeg'`
- [ ] A2. When ffmpeg is unavailable (uninstalled / wrong path), scan still completes normally, videos show placeholder, no error thrown
- [ ] A3. Frames have actual content (manual spot-check of 10 videos, no black / completely static / solid-color frames)
- [ ] A4. After successful frame-fetch, card has purple `Frame` chip at top-left
- [ ] A5. 1000 coverless videos scanned in < 5 minutes (thumbnail filter 30s frame cap 200, avg 5-15s/video)
- [ ] A6. Failed frame videos **auto-retry** on next scan / reconcile (not permanently marked as failed)
- [ ] A7. Concurrency = `settings.scanConcurrency` (default 4), adjustable via settings

### Requirement B (Categorization)

- [ ] B1. Library without md/Excel sheet, videos with metadata all fall into auto-categories (not stay in "Uncategorized")
- [ ] B2. Auto-category name format correct: `【{Source}】{genres}`, e.g., `【JavBus】HD·Subtitled`
- [ ] B3. Sidebar category list shows auto-category items under "Auto-Categorized" group
- [ ] B4. "Auto-Categorize toggle" OFF → behavior reverts to v2.0.3 (all non-sheet videos → "Uncategorized")
- [ ] B5. Video's javdbDetail.genres updated → next reconcile auto-category updates accordingly
- [ ] B6. Videos in auto-category do **NOT** appear duplicated in "Uncategorized"
- [ ] B7. Auto-category count > 50 → keep top 50 by "video count" descending

---

## 5. Out of Scope

This requirement does **NOT** include:

- **Manual** category assignment per video by user (future: add "Move to category…" operation on detail page)
- Merge / rename of auto-categories by user (future: right-click menu "Merge into… / Rename")
- Multi-source genre merge & dedupe (currently no multi-source conflict — take single source; revisit if real multi-source fetching is supported)
- **Search** support for auto-categories (search "javbus HD" inside a video to hit auto-category → not supported for now; start with sidebar navigation + filter)
- Adjusting the position of the "Uncategorized" button mentioned in screenshot 2 (keep current layout)

---

## 6. Implementation Phasing

| Batch | Content | Effort | Risk |
|---|---|---|---|
| **v2.1.0** | All Requirement A detail implementation (concurrency, timeout, failure fallback, cache strategy, visual indicator) + align with existing v2.0.1/v2.0.2 behavior | Medium | Low (v2.0.1/v2.0.2 already exist, fill in details) |
| **v2.1.0 same batch** | Requirement B.1 ~ B.5 core (trigger, categorization logic, UI display) + acceptance B1-B6 | Medium | Medium (reconcile flow changes, proceed with caution) |
| **v2.1.1** | Requirement B.6 edge cases + B.7 auto-category cap + "Auto-Categorize toggle" setting item | Small | Low |

**Estimated code changes for first batch**:
- `src/main/lib/images.ts`: frame parameter confirmation, concurrency pool, timeout
- `src/main/lib/scanner.ts`: scan enrichment phase completion
- `src/main/lib/reconcile.ts`: add auto-categorization logic during reconcile
- `src/shared/types.ts`: `DisplayEntry` add `auto-categorized` kind
- `src/renderer/src/components/Sidebar.tsx`: sidebar "Auto-Categorized" group
- `src/renderer/src/components/EntryCard.tsx`: render for auto-categorized kind
- `src/main/lib/ipc.ts`: frame fallback at end of batch completion

---

## 7. Pending Review / User Confirmation

1. **A.5 frame batch cap 200** — reasonable? 1000-video library will run multiple rounds, acceptable?
2. **A.6 retry strategy** — "auto-retry on next scan / reconcile" enough? Need a "manual retry" button too?
3. **B.3 mutual exclusion between auto-categorization and "Uncategorized"** — videos satisfying auto-categorization **removed from "Uncategorized"** (no duplicate display). Acceptable?
4. **B.4 Video persists `autoCategoryKey`** — yes / no? Recommend "yes" (lightweight + stable across reconciles)
5. **B.7 sidebar auto-category cap 50** — reasonable? Need "expand all + scroll"?
6. **"Auto-Categorize toggle" default ON** — acceptable? Need a more aggressive default (OFF) so users opt-in?
7. **Requirement A: should detail page restore "Source image / FFmpeg Screenshot" toggle button** — rolled back after v2.0.3, but Requirement B auto-categories combined with A's dual-cover strategy might need it in future

---

> **This document is the final development-task input**: pending user confirmation / modification, then freeze.
> After freezing: split into v2.1.0 / v2.1.1 issue list, implement in dependency order.
