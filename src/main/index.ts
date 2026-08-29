import { app, BrowserWindow, Menu, protocol, Tray, nativeImage, type NativeImage } from 'electron'
import path from 'node:path'
import { promises as fs, appendFileSync, mkdirSync } from 'node:fs'
import { registerIpc, runUpdateCheck } from './lib/ipc'
import { runtime, applyRuntimeSettings } from './lib/runtime'

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
      console.warn('[lm] 读取失败:', (e as Error).message)
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
  tray.setToolTip('影匣')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示影匣', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { forceQuit = true; app.quit() } }
    ])
  )
  tray.on('double-click', () => showMainWindow())
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

  registerLocalMedia()
  registerIpc()
  createWindow()

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
