import { app, BrowserWindow, Menu, protocol, Tray, nativeImage, type NativeImage } from 'electron'
import path from 'node:path'
import { promises as fs, appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerIpc, runUpdateCheck } from './lib/ipc'
import { runtime, applyRuntimeSettings } from './lib/runtime'
import { tMain, setLocale as setMainLocale, subscribeLocale, type Locale } from '../shared/i18n'

// 数据目录固定为 %APPDATA%\local-video-manager（换回旧版目录，避免 productName「影匣」
// 造成的中文目录名；必须在任何 app.getPath('userData') 调用之前设置）
app.setPath('userData', path.join(app.getPath('appData'), 'local-video-manager'))

// ------------------------------------------------------------------
// 单实例锁 + 升级绕过（P0 重要修复）
//
// 旧问题：用户不退出影匣直接覆盖安装 → 旧进程仍持有 requestSingleInstanceLock
// → 新 exe 启动时 !app.requestSingleInstanceLock() === true → 直接 app.quit()
// → 用户始终看到旧进程的 UI、功能、文案；只有手动关进程 + 删 AppData 才"看起来好"
// （删 AppData 本身没用，有用的是卸载时旧进程被杀）。
//
// 修复：在 AppData 里写一个 .last-version 标记记录上次启动版本。
//       当前版本 ≠ 上次版本 → 说明是升级安装 → 绕过单实例锁让新版直接启动。
//       旧实例还在跑没关系：它的窗口会被新 BrowserWindow 覆盖，用户看到的是新版 UI；
//       旧进程下次用户关掉或重启系统就清掉。
// ------------------------------------------------------------------
const VERSION_MARKER = path.join(app.getPath('userData'), '.last-version')

function isUpgradeFromOldVersion(): boolean {
  try {
    if (!existsSync(VERSION_MARKER)) return false
    const last = readFileSync(VERSION_MARKER, 'utf8').trim()
    return last !== '' && last !== app.getVersion()
  } catch {
    return false
  }
}

if (isUpgradeFromOldVersion()) {
  console.log(`[main] 检测到版本升级：上次启动 != 当前 ${app.getVersion()} → 绕过单实例锁让新版启动`)
  // 不调 requestSingleInstanceLock → 新版进程照常走完整启动流程；旧进程继续跑但被新版窗口盖住
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.show()
      win.focus()
    }
  })
}

const POSTER_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif'
}

// 必须在 app ready 之前注册特权协议，否则 lm:// 无法在渲染进程加载本地图片
protocol.registerSchemesAsPrivileged([
  { scheme: 'lm', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
])

/** 把渲染进程的 console / 崩溃日志落盘，方便排查 */
function attachRendererLog(win: BrowserWindow): void {
  let logDir: string
  let logFile: string
  try {
    logDir = path.join(app.getPath('userData'))
    logFile = path.join(logDir, 'renderer-console.log')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(logFile, `\n===== session ${new Date().toISOString()} =====\n`)
  } catch {
    return
  }
  const write = (label: string, payload: string) => {
    try { appendFileSync(logFile, `[${new Date().toISOString()}] ${label} ${payload}\n`) } catch { /* 忽略 */ }
  }
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const payload = JSON.stringify({ level, message, line, sourceId })
    write('console', payload)
  })
  win.webContents.on('render-process-gone', (_e, details) => write('render-gone', JSON.stringify(details)))
  win.webContents.on('preload-error', (_e, p, err) => write('preload-error', `${p}: ${err?.message}`))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => write('did-fail-load', `${code} ${desc} ${url}`))
}

/**
 * v2.2.9：把 main 进程自己的 console.log/error 落盘到 logs/main.log，
 * 否则 dev 模式 main 输出在 terminal 滚动看不到、生产包彻底看不到。
 * 跟 renderer console 不同（renderer console 由 attachRendererLog 接 webContents.console-message），
 * main 自己的 console.log 要劫持 console 对象写入。
 */
let mainLogFile = ''
function attachMainLog(): void {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    mkdirSync(logDir, { recursive: true })
    mainLogFile = path.join(logDir, 'main.log')
    appendFileSync(mainLogFile, `\n===== main process session ${new Date().toISOString()} =====\n`)
  } catch {
    return
  }
  const writeAndCall = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()))
      .join(' ')
    try { appendFileSync(mainLogFile, `[${new Date().toISOString()}] ${line}\n`) } catch { /* 忽略 */ }
    orig.apply(console, args)
  }
  console.log = writeAndCall(console.log) as typeof console.log
  console.error = writeAndCall(console.error) as typeof console.error
  console.warn = writeAndCall(console.warn) as typeof console.warn
}


/** 注册 lm:// 协议，让渲染进程安全加载本地图片（海报/侧车图/手动图） */
function registerLocalMedia(): void {
  protocol.handle('lm', async (request) => {
    try {
      const url = new URL(request.url)
      const encoded = url.pathname.slice(1)
      const real = Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf-8')
      const ext = path.extname(real).toLowerCase()
      if (!POSTER_MIME[ext]) {
        console.warn('[lm] 不支持的扩展名, ext=' + JSON.stringify(ext) + ' path=' + real)
        return new Response('forbidden', { status: 403 })
      }
      const data = await fs.readFile(real)
      return new Response(data, {
        // no-store：封面文件可能被手动设为封面覆盖（路径不变内容变），禁止 Chromium 缓存，
        // 配合渲染端 lm:// URL 的 ?v= 版本号，保证封面立即生效
        headers: { 'Content-Type': POSTER_MIME[ext], 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
      })
    } catch (e) {
      // v2.2.5 修复：ENOENT 是高频场景（poster/预览帧常被清理、data.json 残留旧路径），
      // 之前 console.warn 刷屏「控制台大量报错」。改成 console.debug（生产不可见、dev 模式可见），
      // 仍然返回 404，让渲染端 img onError 走占位图占位。
      const msg = (e as Error).message ?? String(e)
      if (msg.startsWith('ENOENT')) {
        console.debug('[lm] 文件不存在（已静默）:', msg)
      } else {
        console.warn('[lm] 读取失败:', msg)
      }
      return new Response('not found', { status: 404 })
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  attachRendererLog(win)

  // 调试快捷键：Ctrl+Shift+I 切换开发者工具（打包版也可用，便于排查）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      e.preventDefault()
      win.webContents.toggleDevTools()
    }
  })

  // 最小化到托盘：关闭窗口时隐藏到系统托盘而不是退出
  win.on('close', (e) => {
    if (runtime.minimizeToTray && !forceQuit) {
      e.preventDefault()
      win.hide()
      ensureTray()
    }
  })

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  if (!app.isPackaged) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ========== 系统托盘（最小化到托盘） ==========
let tray: Tray | null = null
let forceQuit = false

function trayIcon(): NativeImage {
  // 优先 extraResources 里的图标，退回 electron 默认
  const p = path.join(process.resourcesPath, 'icon.png')
  try {
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  } catch {
    /* 图标缺失 */
  }
  return nativeImage.createEmpty()
}

function ensureTray(): void {
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip(tMain('tray.tooltip'))
  const rebuildMenu = () => {
    if (!tray) return
    tray.setToolTip(tMain('tray.tooltip'))
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: tMain('tray.show'), click: () => showMainWindow() },
        { type: 'separator' },
        { label: tMain('tray.quit'), click: () => { forceQuit = true; app.quit() } }
      ])
    )
  }
  rebuildMenu()
  tray.on('double-click', () => showMainWindow())
  // 订阅语言变化，实时更新托盘文案
  subscribeLocale(() => rebuildMenu())
}

function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.show()
    win.focus()
  }
}

/** 其他窗口全关时：托盘模式不退出，否则正常退出 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !runtime.minimizeToTray) {
    forceQuit = true
    app.quit()
  }
})

app.whenReady().then(() => {
  // 隐藏默认应用菜单（打包后才出现 File/Edit/View/Window/Help，应用内无窗口菜单，无需保留）
  Menu.setApplicationMenu(null)

  // v2.2.9：把 main 进程自己的 console.log/error/warn 落盘到 logs/main.log
  // （之前只在 terminal / 用户看不到；现在 dev 模式 + 生产包都能在 userData/logs/main.log 看完整抓取过程）
  attachMainLog()

  registerLocalMedia()
  registerIpc()

  // 启动时应用用户设置的界面语言
  void (async () => {
    try {
      const { getSettings } = await import('./lib/repo')
      const s = await getSettings()
      setMainLocale((s.language ?? 'zh-CN') as Locale)
    } catch {
      /* 静默：保持默认中文 */
    }
  })()

  createWindow()

  // 成功启动后写版本标记 → 下次启动时用于判断"是不是升级安装"
  // （升级安装时旧进程还活着持有单实例锁，新实例会因此被提前 app.quit()，
  //  这个标记让新版在启动早期就能检测到升级并绕过锁）
  try {
    writeFileSync(VERSION_MARKER, app.getVersion())
  } catch {
    /* 首次启动 AppData 目录不存在会抛 ENOENT，正常，下次启动时再写 */
  }

  // 自动检查更新：按设置里的「频率」在启动时检测一次，之后每 30 分钟复查（仅当距上次检测超过设定间隔才真正联网）
  void (async () => {
    const FREQ_MS: Record<string, number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000
    }
    const maybeCheck = async () => {
      try {
        const { getSettings } = await import('./lib/repo')
        const s = await getSettings()
        const freq = s.autoUpdateFrequency ?? 'off'
        if (freq === 'off') return
        const interval = FREQ_MS[freq]
        if (!interval) return
        const last = s.lastUpdateCheck ?? 0
        if (Date.now() - last < interval) return
        await runUpdateCheck()
      } catch {
        /* 静默：网络/解析失败不影响启动 */
      }
    }
    await maybeCheck()
    setInterval(maybeCheck, 30 * 60 * 1000)
  })()

  // 启动时应用运行时设置（开机自启 / 最小化到托盘）
  void (async () => {
    try {
      const { getSettings } = await import('./lib/repo')
      applyRuntimeSettings(await getSettings())
    } catch {
      /* 静默 */
    }
  })()

  // 启动时静默检测 ffmpeg 环境：系统已装则复用系统版并删除捆绑版（释放 62MB 磁盘），
  // 失败/删除无权限时静默忽略，不阻塞启动（检测详情可在设置页查看）
  void (async () => {
    try {
      const { getSettings } = await import('./lib/repo')
      const { detectFfmpeg } = await import('./lib/ffmpegEnv')
      await detectFfmpeg(await getSettings())
    } catch {
      /* 静默 */
    }
  })()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
