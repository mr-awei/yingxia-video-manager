/**
 * 运行时设置（不持久化，跟随 Settings 变化即时生效）。
 * 独立模块避免 ipc.ts ↔ index.ts 循环依赖。
 */
import { app } from 'electron'
import type { Settings } from '../../shared/types'

export const runtime = {
  /** 最小化到托盘（关窗隐藏不退出） */
  minimizeToTray: false
}

/** 应用 Settings 变更到运行时：开机自启 / 最小化到托盘 */
export function applyRuntimeSettings(s: Settings): void {
  runtime.minimizeToTray = !!s.minimizeToTray
  try {
    app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin })
  } catch {
    /* 平台不支持时静默 */
  }
}
