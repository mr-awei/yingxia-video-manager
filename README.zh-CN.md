# 影匣 YingXia

<div align="center">
  <a href="README.md">English</a>
  <span> · </span>
  <strong><a href="README.zh-CN.md">中文</a></strong>
</div>

<br />

## 本地视频海报墙管理工具 · Excel 片单驱动的私人影库

**核心原则：纯本地、不采集、不传输。**

影匣是一款 Windows 桌面应用，能把本地视频文件夹变成精美的海报墙影库。搭配一份 Excel 片单（你的个人目录）后，应用会自动整理、分类并补全元数据——所有元数据始终保存在你自己的电脑上。

> ⚠️ 本工具仅用于管理用户**本地自有**的成人视频收藏，不传播、不上传、不分享任何内容。

---

## 产品亮点

- **Excel 片单驱动**：Excel 片单是分类、评分、标签、简介的唯一权威来源。随时与文件夹对账，发现未收录或未分类的影片。
- **海报墙浏览**：三种密度（沉浸 / 标准 / 紧凑），悬停卡片快速查看信息，虚拟滚动支撑大库流畅浏览。
- **智能元数据补齐**：自动识别番号，从可配置数据源（JavDB、JavBus、JavLibrary、Javapi、Javinfo）抓取元数据，自动降级；支持可拖拽、可暂停/继续/停止的批量抓取进度面板。
- **系列分集**：同一番号多文件（如 `SONE-560_1.mp4`、`SONE-560_2.mp4`）在列表页合并为一张卡片，详情页展示分集并可切换。
- **本地优先封面**：优先使用数据源封面；缺封面时通过智能 ffmpeg 截帧兜底，自动跳过黑屏、白屏、模糊、重复画面。
- **双语界面**：应用内完整支持中文（zh-CN）与英文（en-US），包括提示词、更新日志、规范文档。
- **隐私护盾**：一键模糊所有封面，删除锁需 SHA-256 校验，零上传。
- **网络代理**：可配置 HTTP / HTTPS / SOCKS5 代理，同时覆盖 Node.js 请求与 Chromium 网络栈。
- **统计与发现**：按标签 / 系列 / 自定义字段筛选，查看总量、最大文件、随机推荐与收藏。
- **系统集成**：Windows NSIS 安装包、开机自启、最小化到托盘、更新检查、GitHub / Gitee 双端发布。

---

## 技术栈

- **桌面端**：Electron 31 + electron-vite
- **前端**：React 18 + TypeScript + Tailwind CSS
- **构建打包**：electron-builder（Windows NSIS 安装包）
- **数据**：本地 JSON + Excel（xlsx）解析
- **媒体**：ffmpeg / ffprobe（系统已装或兜底）

---

## 开发

```bash
npm install
npm run dev        # 启动开发版（自动打开 DevTools）
npm run build      # 构建渲染进程 + 主进程 + preload
npm run typecheck  # TypeScript 类型检查
npm run pack       # 清理 + 构建 + electron-builder 打安装包
```

---

## 数据隐私声明

1. **零上传**：应用不向任何服务器上传任何用户数据——包括影片列表、标签、评分、路径、文件名。
2. **本地存储**：所有数据存在 `%APPDATA%\local-video-manager\data.json`，可随时备份或删除。
3. **匿名网络请求**：仅在用户主动配置封面/数据源后，应用才会向该服务请求数据；请求不携带任何用户标识（匿名 User-Agent，不发 Cookie）。
4. **可离线使用**：完全切断网络后，除了可选的云端抓取功能外，所有核心功能（扫描、浏览、详情、播放、对账）均可正常使用。

---

## 许可证

MIT
