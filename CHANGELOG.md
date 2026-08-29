# 更新日志（Changelog）

## v2.2.6（2026-08-30）

**数据源采集：完整流程可见 + 顺序可调（用户反馈"javapi/javinfo 失败应继续试其他源"）**

### 1. P0：fetchDetailSmart auto 模式错误信息完整化
- v2.2.4 把 `fetchDetailSmart` 抽到独立模块时**漏修一处**——`errors` 数组（javapi 跳过 / javinfo 跳过的提示）没合并到 return error。同时**没在 ipc.ts 删掉旧的 `fetchMovieDetail`**（v2.2.4 漏改），导致用户点「补齐信息」走 `fetchMovieDetail`、批量补齐走 `fetchDetailSmart`，**两套逻辑不一致**。
- 表现：用户的 SONE-560_1 点「补齐信息」只显示「未配置本地 Javapi，跳过；未配置 Javinfo key，跳过」——看起来像只跑了 javapi 就停了。实际上 javdb/javbus/javlibrary 也跑了但「无结果」（不是异常），所以 `errors` 数组里没反映。
- v2.2.6 修复：
  - `fetchDetailSmart` auto 模式用 `srcResults[]` 记录每个源的状态（`hit` / `skipped` / `no-result` / `network-failed`），最后拼成 `javapi=跳过(...); javinfo=跳过(...); javdb=无结果; javbus=无结果; javlibrary=无结果` 这种完整 summary
  - `ipc.ts fetchMovieDetail` 删掉（保留 wrapper，内部调 `fetchDetailSmart`），保证两套入口行为一致
  - `ipc.ts` 清理掉 6 个不再直接用的 per-source import（fetchJavapiDetail / fetchJavinfoDetail / fetchJavdbDetail / fetchJavBusDetail / fetchJavLibraryDetail / hasJavapiConfig / hasJavinfoKey）

### 2. P0：SettingsModal 加 customSourceOrder 拖拽排序 UI
- v2.2.0 时加了 `Settings.customSourceOrder` 字段，v2.2.4 抽到 javdb-smart.ts 的 fetchDetailSmart 也读了，**但 UI 没暴露调整入口**——只能选 auto/单源。
- v2.2.6 暴露 UI：dataSource=auto 时显示 5 个源的可拖拽列表
  - 拖拽 ⠿ 调整顺序（HTML5 drag-and-drop）
  - 点 ↑↓ 按钮也行
  - 「恢复推荐」一键还原默认顺序
  - 每个源展示「信息全面度 + 风控 + 成本」三维度评估
  - 底部说明抓取逻辑：按顺序逐个尝试，任一源命中即停；任一源连续 3 部网络失败自动跳过本轮；JavBus 连续 3 部失败停止整批；所有源都失败 → 走 ffmpeg 截帧兜底
- 字段已存在 Shared types，store 持久化天然支持

### 3. 数据层未做（留给 v2.2.7）
- 「文档定义标签优先、其他数据源标签折叠成备用」还没做。当前 v.tags 是文档 tags + 数据源 genres 合并去重。
- v2.2.7 计划：Video 加 `tagCategories` + `backupTags` 字段；reconcile if (doc) 分支写 tagCategories；backfillFromDetail 把 detail.genres 写 backupTags 不合并；详情页 UI 折叠显示。

---

## v2.2.5（2026-08-30）

**控制台大量 ENOENT 报错修复（用户反馈"控制台大量报错"）**

v2.2.4 升级时 installer 清掉了 posters 目录里的旧 .jpg（`<video.id>_preview_X.jpg` ffmpeg 截帧命名），但 data.json 里的 `video.previewPaths` 还指向这些不存在的文件。hover 视频 / 打开详情页时，渲染 15 张 preview 触发 15 次 `lm://` 协议 ENOENT，main 进程 console.warn 刷屏。

实测：22 部 video / 共 330 个 dead preview 路径在控制台刷屏。

### 1. P0：`lm` 协议 ENOENT 静默
- `src/main/index.ts`：ENOENT 时 `console.debug`（生产不可见、dev 模式可见），其他错误仍 console.warn
- 仍返回 404，让渲染端 `<img onError>` 走占位图
- 刷屏瞬间消失

### 2. P0：reconcile 自动清理 dead previewPaths
- `src/main/lib/reconcile.ts` 新加 `cleanupDeadPreviewPaths()`，每次 reconcile 完成后扫一遍所有 video
- `fs.existsSync` 检查，删掉不存在的条目
- 全删完的 `previewPaths = undefined`（让 UI 走「无预览」分支，不再尝试加载）
- 改动合并进 `changes` 数组，由末尾 `applyVideoChanges` 一次性落盘
- 不刷屏、不弹窗：这是修复性的清理，不是用户该被打扰的事件

### 3. v2.2.5 仍未做（留给 patch 2）
- 不补 ffmpeg 重新截帧：hover 已有 javbus 抓的 cover 顶着用，preview 帧下次手动点"重新生成预览"时再生成
- 让 v2.2.5 保持最小变更，降低风险

---

## v2.2.4（2026-08-30）

**核心修复（用户反馈："代码有问题导致我收录了说没收录 + 弹窗不能藏起问题 + 万一没 Excel 怎么办"）**

### 1. P0：修 `parseIntroExcel` 中文路径读取（用户 84 部全部"未收录"根因）
- v2.2.3 用的 `XLSX.readFile(filePath)` 在 Windows 中文路径下**静默失败**——SheetJS v0.18.5 mjs 的 `readFileSync` 对非 ASCII 路径处理不当，会抛 `Cannot access file E:/新建文件夹/收藏整理_2026.xlsx`。
- 改成 `await fs.readFile(filePath)` + `XLSX.read(buf, { type: 'buffer' })`，绕开 xlsx mjs readFileSync 中文路径 bug。
- 实测：`E:\新建文件夹\收藏整理_2026.xlsx`（35KB / 74 部片单）buffer 解析成功 → keyMatches 76/76 命中。
- 同步修 `excelSheetNames`（同样用 buffer）。

### 2. P0：恢复「片单加载失败」弹窗（不再静默吞错）
- v2.2.3 的 `autoFindIntroExcel` 在 `parseIntroExcel` 返回 null 时**静默 catch**，让用户以为"片单不存在"——实际可能是片单存在但读取失败。
- v2.2.4 改造：
  - `readIntroDoc` 返回 `IntroLookupResult`（含 `doc` 和 `error`），区分 `not-configured` / `parse-failed` / `auto-find-failed`。
  - `autoFindIntroExcel` 同样返回结构化结果，记录 triedPaths。
  - `reconcileLibrary` 通过 onProgress 顺路把 `introError` 推到 renderer，弹 Toast 提示（title / message / 已尝试的路径列表），**不自动消失**让用户看到。
- 用户友好优先：找不到 → 告诉用户"在哪找不到"；找到了但解析失败 → 告诉用户"哪个文件坏了"。

### 3. P1：无 Excel 片单兜底：自动后台抓元数据
- 用户原话："万一哪天用户真没有excel怎么办"。
- reconcile `else` 分支：遍历时收集 `needFetchAfter`（没 javdbDetail 且非国产片）。
- 7 天内抓过且失败的跳过（`video.lastMetaFetchAt` 字段），抓到的写回 `video.javdbDetail` 让 UI 立刻按 genres 自动归类。
- 用 `settings.scanConcurrency` 控制并发（默认 2），与 scanLibrary 行为一致。
- `fetchDetailSmart` 抽到独立模块 `javdb-smart.ts`（避免 ipc ↔ reconcile 循环依赖）。

### 4. 技术债
- `MovieDetailResult` / `SmartFetchState` / `fetchDetailSmart` 从 ipc.ts 抽出到 `javdb-smart.ts`，让 reconcile.ts 也能调（无循环依赖）。
- Video 类型加 `lastMetaFetchAt?: number`（兜底抓取 7 天去重用）。

---

## v2.2.3（2026-08-30）

**核心修复（用户反馈"问题依旧存在 + 两个截帧角标 + 标签两份 + 控制台大量报错"）**

### 1. P0：library 未配 Excel 片单时自动扫描库根目录（最关键）
- `reconcile.ts` 加 `autoFindIntroExcel(folderPath)`：当 `library.introExcelPath` 未设时，**自动扫描库根目录一层**找 `.xlsx/.xls`（按文件名排序取第一个能解析品番列的）。
- 用户友好：用户把 `收藏整理_2026.xlsx` 放到 library 根目录即可，无需手动配 `introExcelPath`。
- 多个 xlsx 时按 zh 排序取第一个；console.log 提示「自动使用库根 Excel 片单」。

### 2. P0：reconcile.ts 双重 push（用户截图「未收录 84 + 未分类 79」根因）
- `reconcile.ts` else 分支（L260）补 `used.add(f)`：未配 Excel 时按文件维度只产出 1 条 entry。
- 之前每个 filePath 同时进入「未分类」和「未收录」两条 entry，`code` 完全相同 → `HomeView key={e.code}` 重复 key 警告（`MKMP-542`、`juy-703`）→ 详情页 seriesMembers 出现两次相同 chip。

### 3. P0：EntryCard 双「截帧」徽标
- `EntryCard.tsx` 删 `bg-violet-500/90` 重复 chip（v2.0.2 + v2.1.0 合并遗留），保留 `bg-fuchsia-500/90` 带 film 图标版。
- 顺手把数据源徽标改为单 IIFE 来源（防未来再加源时 paste 复制出错）。

### 4. P0：EntryCard 双「JavLibrary」徽标（靛 + 天蓝重叠）
- `EntryCard.tsx` 删链外 `bg-sky-500/90` 残留块，保留链内 `bg-indigo-500/90` 标准版。
- 顺手加 `posterSource === 'manual'` 时显示绿色「设为封面」chip（之前没有）。

### 5. P0：撤销 v2.2.2 的 `keyMatches` 字母后缀拒绝（最阴险 bug）
- v2.2.2 把 `keyMatches` 后缀检查改成 `/[A-Z0-9]/`，**严重过度修改**——把 `JUR-031.mp4` 归一后的 `M`（来自 MP4）误判为「另一番号字母」拒绝，导致**正常文件都匹配不上**。
- v2.2.3 改回只拒绝数字后缀：`/[0-9]/.test(after)`。`JUR-031.mp4` ↔ `JUR-031` ✅。
- 系列分集合并（`SONE-566AB` → `SONE-566`）改由 `extractBaseCode/hasSeriesSuffix` 在抓取源显式处理，不要在文件名 keyMatches 上做强约束。

### 6. P1：parseIntroExcel 同 code 多行不去重
- 解析循环内加 `seenCodes = new Set<string>()`（用归一 key），跳过重复并 warn。
- 同步把 `normalizeCode` 从 reconcile.ts 抽到 `src/shared/code.ts` 共享（reconcile + excel 两处共用）。

### 7. P1：HomeView key 防御性加固
- `HomeView.tsx:94` `key={e.code}` → `key={e.video?.id ?? \`code:${e.code}\`}`，未来再出重复 code 也不会 crash。

**回归测试**：14/14 用户截图文件名 → Excel 命中；normalize/autoFindIntroExcel/keyMatches v2.2.3 全部通过。

## v2.2.2（2026-08-30）

**Bug 修复（用户反馈"未收录 84 个"）**
- **`extractCode` 域名前缀误提取**（P0，github 项目根因）：`hdd800.com@JUR-031.mp4` 之前被错误识别成 `HDD-800`。修复：内部改造为先按 `@` 切多段 → 去方括号包裹 → 含 dashes 的合法番号形态段排序靠前 → plain fallback 用 `[A-Z]{2,}[A-Z]+\d{2,}`（要求额外字母，过滤纯字母+纯数字紧凑形态如 `HDD800`）。**覆盖测试 44/44 通过**（含 `b8s2048.org@EBOD-835`、`[hhd800.com@]DASS-733-C`、`44x.mejuy-703-2` 等用户截图实拍文件名）。
- **`javdb.ts` 的 extractCode 语义漂移**（P0）：与 code.ts 并行两套，访问 `m[0]` 而非 `m[1]`，独立归一逻辑。统一为从 `src/shared/code.ts` re-export，确保 main/renderer 两侧同语义（缓存前缀 `javdb-cover-SONE-560CD2` 与实际 `javdb-cover-SONE-560.jpg` 不匹配导致老缓存删不掉的 bug 同时修复）。

**其他 P1 解析增强**（按 Agent 全量排查报告逐条修）
- `reconcile.normalizeCode`：下划线归一（`SONE_566` → `SONE566`，与 `SONE-566` 命中）。
- `reconcile.keyMatches`：后缀字母也拒绝（防 `SONE-566AB` 误合并到 `SONE-566`；分集合并改由 `extractBaseCode/hasSeriesSuffix` 显式处理）。
- `rename.cleanVideoFileName`：先 `.toUpperCase()` 入参再匹配（`sone-566-uc.mp4` / `ALDN606.mp4` 之前返回 null 现能正确改名）；"无需改名"判定改为按大写比较（用户原大写即无需改）。
- `code.extractBaseCode` (`SERIES_SUFFIX_RE`)：尾部字母限制 `[A-DUC]`（之前 `[A-Z]` 太宽，把 `SONE-560X` / `KSJK-013V` 错剥成 `SONE-560` / `KSJK-013`）。
- `excel`：`品番` 列扫描从仅 B 列改为扫整个表头（用户把品番放 D/F 列之前会全部静默归入"未分类"）。

**P2**
- `scanner.cleanTitle`：清理中文方括号【】、中文圆括号（）。
- `reconcile` 未配置 Excel 分支：去掉扩展名后再写入 `code` 字段（之前 UI 卡片显示 `xxx.mp4`）。

**测试**：回归测试 61/61 通过（44 个 extractCode + 17 个 normalizeCode/keyMatches）。

## v2.2.1（2026-08-30）

**数据源自定义优先级（1-5）**
- 设置 → 数据源 → 「自定义优先级」区块（仅 auto 模式显示）：5 个源可点 ↑↓ 调整任意顺序（谁 1 谁 2 谁 3 谁 4 谁 5 你说了算）；
- 「重置为推荐顺序」一键恢复默认：Javapi → Javinfo → JavDB → JavBus → JavLibrary（按信息全面度 / 获取难度 / 风控排序）；
- 批量抓取（fetchDetailSmart）auto 链按该顺序降级，连续网络失败自动跳过当前源；
- 持久化到 `settings.customSourceOrder`。

**markdown 残留彻底清除（含注释与文案）**
- 复查全仓并修复 20+ 处注释/文案残留：excel.ts、App.tsx、EditMetaModal（4 处）、ReconcileDialog（2 处）、about.ts（3 处）、api-types.ts（3 处）、ipc.ts、reconcile.ts（4 处）、types.ts（4 处）——全部改为 Excel 表述；
- 保留：`CHANGELOG.md`（项目更新日志）、`通用评分与简介规范.md`（资源文档），非片单用途。

**CI 修复（GitHub Actions 构建失败）**
- `electron-builder.yml` 增加 `win.certificateFile: build/yingxia-sign.pfx`；
- `release.yml` 命令简化为 `npx electron-builder --win`，证书密码改走 `CSC_KEY_PASSWORD` 环境变量（`secrets.CERT_PASSWORD`），不再用会触发 ENOENT 的 `-c.win.certificateFile=...` 写法。

## v2.2.0（2026-08-30）

**全面删除 markdown 片单支持**（用户要求一处不留，已全仓清理）
- 删除 `src/main/lib/parser.ts`（md 解析器）、`mdWatcher.ts`（md 监听）、`src/renderer/src/components/OnboardMdModal.tsx`（新建 md 向导）三个整文件；
- 删除 IPC：`specGet`（读取内置规范）、`libraryExportCodes`（导出番号清单）、`onMdChanged`（md 变更事件），含 `shared/ipc.ts` 常量 + `preload/index.ts` 暴露 + `shared/api-types.ts` 类型 + `ipc.ts` handler；
- `Library.introMdPath` 字段移除；`Settings.library.introExcelPath` 改为唯一的片单权威来源；
- `LibraryModal` 去掉「简介 md 文件」整块选项 + 「还没有 md？按内置规范让 AI 帮你生成 →」按钮 + `onOnboard` prop；
- `dialogSelectFile` 通用文件选择器默认 filter 改为 Excel（`xlsx`/`xls`），title/buttonLabel 支持调用方覆盖；
- `reconcile.ts` 删除 md 兜底分支，仅使用 Excel 片单；
- 资源 `通用评分与简介规范.md` 仍在 `extraResources` 中保留（项目文档，非片单），未删除；`CHANGELOG.md` 同理保留。

**数据源推荐顺序（已确认 v2.1.0 即为该顺序）**
- 顺序：Javapi → Javinfo → JavDB → JavBus → JavLibrary；
- 推荐依据：① Javapi（本地聚合 8 源 + JavDB API，信息最全、无 Cloudflare/IP 风控、免费，但需自托管）；② Javinfo（javinfo.dev 聚合，免风控，按量计费）；③ JavDB（原始最准，但有 Cloudflare 风控）；④ JavBus（备用源，含年龄验证绕过）；⑤ JavLibrary（兜底源，与 javdb/javbus 数据重叠度高）；
- 用户可手动指定单一源（设置 → 数据源 → 手动选项）。自定义 1-5 优先级拖拽留 v2.3.0。

**新功能：隐私锁删除密码验证**
- 设置 → 隐私与安全 → 已有「当前状态：已上锁/未上锁」+ 密码输入区（SHA-256 + 随机 salt 哈希存储，明文不落盘）；
- 开启锁后，删除视频（详情页/卡片/文件列表「删除文件」按钮 → 二次确认 → 走 confirmDelete）和删除媒体库（库设置 → 删除）时，会先弹密码框（window.prompt）要求输入密码；
- 密码错误或取消则中止删除；连续验证失败不影响下次。

## v2.1.0（2026-08-29）

**合并朋友分支（github.com/z1006670445/yingxia-video-manager）**
- **新增数据源 Javapi（本地自托管聚合 API）**：settings 配置地址 + Key，免费、无 Cloudflare/IP 风控；auto 降级链最优先；
- **新增数据源 Javinfo（javinfo.dev 聚合 API）**：注册拿 Key，免风控；auto 链第二顺位；
- **设为封面 / 预览帧设为封面**：详情页预览帧可设为封面（posterSource=manual 最高优先级），封面替换前 ffprobe 验证图片有效性（坏图不替换 + 删坏图走截帧兜底）；coverVersion 机制让封面即时刷新；
- **渲染进程侧截帧兜底（frameFallback）**：列表/详情显示时按需 ffmpeg 截帧（与主进程扫描截帧互补）；ListThumb 缩略图组件（blur 背景 + 帧标识）；
- **首页全库随机**：多库合并洗牌，单库自动隐藏；收藏/详情不再刷新随机；
- **打包输出移到工作区外**（~/yingxia-release/<时间戳>），根治 app.asar 被占用；
- 徽标体系扩展：Javapi（青）/ Javinfo（绿）/ JavLibrary（靛）/ JavBus（黄）/ 截帧（品红）。

**新功能**
- **无封面视频自动归类（需求 B）**：媒体库未配置 md / Excel 片单时，所有文件原先一律归入「未分类」。现在：
  - **有数据源元数据**（javdbDetail.genres 非空，如 JavBus 抓到的「高清」「字幕」）的视频，按 genres 自动归类为「【JavBus】高清·字幕」这类自动分类（order 9000，位于用户分类之后、未收录之前）；
  - **无元数据**的视频仍归「未分类」（行为不变）；
  - 侧栏「分类」里自动归类项用独立分组「⚡ 自动归类」显示（紫色分隔标题，与用户分类区分）；
  - 同一 genres 组合的多部视频自动归入同一分类，点击即可筛选查看。

**优化（需求 A）**
- **截帧超时兜底**：ffmpeg 单次截帧（thumbnail 封面 / 预览图）超过 30 秒强制 kill，防止长视频或异常文件卡死扫描/对账/补齐流程；
- **截帧批次上限**：单轮对账 / 单轮批量补齐后台截帧最多处理 200 部，其余留待下轮，避免长时间占满并发池拖慢操作。

**说明**
- 自动归类在每次对账时按 javdbDetail.genres 实时计算，数据源元数据更新后归类自动跟随变化；
- 若视频后续在 md / Excel 片单中新增条目，下次对账会优先按片单分类展示，自动归类自动让位。

## v2.0.3（2026-08-29）

**回滚 / 修复**
- **回滚详情页 UI 改动**：恢复 v1.9.0 时确认的详情页布局（`git checkout a08dbd0 -- VideoDetail.tsx`），撤销 v2.0.0/v2.0.2 引入的"ffmpeg 截帧切换 chips"和"JavLibrary 蓝色徽标"（这两项是导致红框标注的大片空白 + 视觉割裂的根源）。
- **修复详情页右栏大片空白**：右栏加 `flex flex-col` 让内容垂直排列，底部新增「文件信息」卡片（文件名 / 添加于 / 上次播放 / 时长 / 完整路径），通过 `mt-auto` 推到右栏底，填满 grid 拉伸后的剩余高度，**消除红框区域的空白**。

**新功能**
- **首次启动强制弹出「用户须知」**：新增 `UserNoticeModal` 组件（正式法律文书风格），涵盖：
  - 软件性质声明（仅本地管理工具，不提供/不存储/不传播任何片源内容）
  - 用户行为规范
  - 详细法律条文（**《刑法》第三百六十三条【制作、复制、出版、贩卖、传播淫秽物品牟利罪】**、**第三百六十四条【传播淫秽物品罪】**、《治安管理处罚法》第六十八条、《网络安全法》第十二条、《未成年人保护法》第五十一条、《民法典》第一千零一十九条）
  - 未成年人特别保护、免责声明
  - 复选框「我已阅读并同意，下次启动不再显示」——勾选后写入 `settings.noticeDismissed=true` 永久不再弹；未勾选关闭则下次启动再次弹出
  - **不可 ESC 关闭、不可背景点击关闭**（合规要求：必须主动确认才能继续使用）

## v2.0.2（2026-08-29）

**优化**
- **截帧质量提升**： 与  改用 ffmpeg 官方  滤镜（自动分析 N 帧后选最具代表性的一帧）——避免黑场/静帧/淡入淡出等暗帧问题。 按视频时长自适应（100 帧起步，最长 200 帧）。
- **列表页 / 网格卡片「截帧」紫色徽标**：ffmpeg 截帧生成的封面在 EntryCard 和 ListView（缩略图列表）左上加紫色  chip 标识，一眼分辨是数据源图还是 ffmpeg 截帧（顺带补了 JavLibrary 蓝色 chip）。
- **说明**：升级前已截的旧暗帧不会自动重新截——详情页「重新截帧」按钮可逐个升级；批量升级可在首页扫描库完成后用 javdb 信息批量补齐流程触发。

## v2.0.1（2026-08-29）（2026-08-29）

**优化**
- **无封面自动 FFmpeg 截帧兜底**：多个数据源（JavDB/JavBus/JavLibrary）都抓不到数据的视频，不再只显示灰色占位图——以下三条路径都会对无封面视频自动截帧显示真实画面（随机时间点截 1 张封面 + 15 张预览图）：
  - **扫描富集**：扫描媒体库时，对无海报视频强制截帧兜底（不再受 `imagePriority` 是否含 ffmpeg 限制）；
  - **对账完成**：自动/手动对账结束后，后台对仍无海报的视频异步截帧（不阻塞对账返回）；
  - **批量补齐完成**：「补齐信息」批量结束后，后台对仍无海报的视频异步截帧（不阻塞补齐返回）。
  - 截帧封面独立保存在 `posterPathFfmpeg`，与数据源图并存，仍可通过详情页「数据源图 / FFmpeg 截图」自由切换。

## v2.0.0（2026-08-29）

**新功能 · 大版本**
- **片单改为 Excel 格式（替代 md）**：新增 `src/main/lib/excel.ts` 解析器，支持直接选择「收藏整理_2026.xlsx」这类片单文件（需含「品番」列，如「片单」工作表）。Excel 的分列结构（编号/品番/分类/推荐评分/简介/主题/角色/服装/体型/行为/玩法/场景/剧情/其他）完整映射到现有对账体系（分类 → 分类分组、品番 → 番号、推荐评分 → 评分、各标签列 → 结构化标签）。媒体库设置中可分别配置「md 简介」与「Excel 片单」，**Excel 优先、md 兜底**。md 完全保留兼容。
- **搜索只提取非中文番号**：`extractCode` 全面增强——支持无分隔符番号（`KSJK013` → `KSJK-013`，旧版只认 `SONE-560` 这种带分隔符的，导致无分隔符片名搜不到），并先剥离中文/全角/广告前缀（`【中文字幕】KSJK013` 不再污染搜索词）。javdb / javbus / javlibrary 三源共用同一增强逻辑。
- **扫描支持"只扫大于 X MB"**：设置 → 数据与存储 →「跳过小体积文件」（默认 100MB，0 = 不过滤）。扫描与对账都会跳过小于阈值的文件，广告样片/短视频不再混入主列表。
- **新增 JavLibrary 数据源**：设置 → 网络 → 数据源 新增 JavLibrary；手动模式可单独指定该源调试；auto 模式降级链变为 JavDB → JavBus → JavLibrary。
- **封面/预览图双缓存 + 自由切换**：详情页封面下方新增「数据源图 / FFmpeg 截图」切换按钮。数据源（javdb/javbus/javlibrary）抓取的封面与 FFmpeg 随机截帧封面**独立保存**（`posterPathFfmpeg`），可随时来回切换，不再互相覆盖；FFmpeg 截图不存在时点击会自动生成。

**修复**
- **批量补齐不再误停**：`fetchDetailSmart` 之前把「搜索无结果」（数据源确实没这个番号，正常情况）也计为连续失败，导致 IP 没被封也自动停止/切源。现在只有真正的网络/会话异常（请求失败、超时、年龄验证失败）才累计失败次数；「无结果/无法识别番号」静默不计。javbus 的「搜索无结果」提示同步改为静默。
- 批量补齐按用户设置的间隔执行（`fetchIntervalMs`，不再有额外固定延时叠加）。