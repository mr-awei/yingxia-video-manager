# 影匣（YingXia）

本地视频影库管理工具。把本地视频文件夹 + 一份简介 `md` 文件，自动生成「海报墙」式影库：悬停看简介、点击看详情、一键用本地播放器打开，并能对账文件夹与简介的差异。

> 面向个人影库管理，纯本地、无云端上传。

## ✨ 功能亮点

- **海报墙浏览**：按简介 `md` 的分类（如多人 / 单体 / 系列）展示影片，支持大图沉浸 / 标准 / 高密度三种密度。
- **悬停即看**：鼠标悬停显示简介、番号、演员、标签等结构化信息。
- **详情页**：海报、演职员、标签筛选、系列分集联动、随机推荐。
- **本地播放**：一键调用系统默认播放器打开影片。
- **简介 md 对账**：自动比对文件夹里的视频与 `md` 中的条目，列出「未收录」视频，一键复制番号。
- **元数据补齐**：对缺封面的影片，自动从 JavDB / JavBus 等数据源抓取封面与信息（可配置数据源与代理）。
- **运行环境自适应**：优先复用系统已装的 `ffmpeg`，检测到后自动释放内置捆绑版，节省磁盘。
- **隐私护盾**：一键打码所有封面（适合屏幕共享）。
- **统计面板**：总文件大小、最大的十大文件、按标签 / 演员 / 工作室的筛选与统计。
- **开机自启 / 最小化到托盘 / 隐私默认开启 / 扫描并发数**等设置项。

## 🧱 技术栈

- Electron + electron-vite
- React 18 + TypeScript
- Tailwind CSS
- electron-builder（Windows NSIS 安装包）

## 🚀 开发

```bash
npm install
npm run dev        # 启动开发版（自动打开 DevTools）
```

构建与打包：

```bash
npm run build      # 仅构建
npm run pack       # 清理 + 构建 + electron-builder 打安装包（输出到 release/）
```

> 开发版会默认弹出开发者工具；打包版可用 `Ctrl+Shift+I` 打开控制台。

## 📦 安装包签名（可选）

默认打包出来的安装包是**未签名**的。若想消除 SmartScreen / 杀软拦截提示，可用自签名证书：

```powershell
# 1. 生成自签名证书（首次执行，会导出 build/yingxia-sign.pfx）
powershell -ExecutionPolicy Bypass -File scripts/gen-cert.ps1

# 2. 把证书 Thumbprint 填入 scripts/sign.cmd 的 TP= 变量

# 3. 打包后用脚本签名（需 Windows SDK 的 signtool.exe）
scripts\sign.cmd
```

> 自签名证书只解决「发布者未知」提示，仍可能被 SmartScreen 拦截；如需完全信任需购买代码签名证书，或把 pfx 导入「受信任的根证书颁发机构」。

## 📄 许可证

[MIT](./LICENSE)
