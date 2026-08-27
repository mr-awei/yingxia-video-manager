# 影匣（YingXia）

本地视频影库管理工具。选一个视频文件夹，配一份简介 md 文件，自动生成海报墙式影库：悬停看简介，点击看详情，用本地播放器打开视频，还能对账文件夹与简介的差异。

数据只存在本地，不上传云端。

## 功能

- 海报墙浏览：按简介 md 的分类展示影片，支持大图沉浸、标准、高密度三种密度。
- 悬停预览：鼠标悬停显示简介、番号、演员、标签。
- 详情页：海报、演职员、标签筛选、系列分集联动、随机推荐。
- 本地播放：调用系统默认播放器打开影片。
- 简介对账：自动比对文件夹里的视频和 md 里的条目，列出未收录的视频，一键复制番号。
- 元数据补齐：缺封面的影片自动从 JavDB / JavBus 抓取封面与信息，数据源和代理可配置。
- ffmpeg 自适应：优先使用系统已装的 ffmpeg，检测到后自动释放内置捆绑版，节省磁盘。
- 隐私模式：一键打码所有封面，适合屏幕共享。
- 统计面板：总文件大小、最大的十大文件、按标签 / 演员 / 工作室的筛选与统计。
- 设置项：开机自启、最小化到托盘、隐私默认开启、扫描并发数等。

## 技术栈

- Electron + electron-vite
- React 18 + TypeScript
- Tailwind CSS
- electron-builder（Windows NSIS 安装包）

## 开发

```bash
npm install
npm run dev        # 启动开发版（自动打开 DevTools）
```

构建与打包：

```bash
npm run build      # 仅构建
npm run pack       # 清理 + 构建 + electron-builder 打安装包（输出到 release/）
```

开发版默认弹出开发者工具；打包版用 Ctrl+Shift+I 打开控制台。

## 安装包签名（可选）

默认打包出来的安装包未签名。若想消除 SmartScreen / 杀软拦截提示，可用自签名证书：

```powershell
# 1. 生成自签名证书（首次执行，会导出 build/yingxia-sign.pfx）
powershell -ExecutionPolicy Bypass -File scripts/gen-cert.ps1

# 2. 把证书 Thumbprint 填入 scripts/sign.cmd 的 TP= 变量

# 3. 打包后用脚本签名（需 Windows SDK 的 signtool.exe）
scripts\sign.cmd
```

自签名证书只能解决「发布者未知」提示，仍可能被 SmartScreen 拦截；如需完全信任需购买代码签名证书，或把 pfx 导入「受信任的根证书颁发机构」。

## 许可证

[MIT](./LICENSE)
