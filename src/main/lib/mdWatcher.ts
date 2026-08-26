import { watch, type FSWatcher } from 'node:fs'
import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { Library } from '../../shared/types'

/**
 * 监听每个媒体库的「简介 md」文件变化。
 * 文件被修改后 debounce 500ms，推送 mdChanged 事件给渲染层（由渲染层触发重新对账）。
 */
const watchers = new Map<string, FSWatcher>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(libraryId: string): void {
  if (timers.has(libraryId)) clearTimeout(timers.get(libraryId)!)
  timers.set(
    libraryId,
    setTimeout(() => {
      timers.delete(libraryId)
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(IPC.mdChanged, libraryId)
      }
    }, 500)
  )
}

export function watchLibraryMd(lib: Library): void {
  unwatchLibraryMd(lib.id)
  if (!lib.introMdPath) return
  try {
    const w = watch(lib.introMdPath, () => emit(lib.id))
    watchers.set(lib.id, w)
  } catch {
    // 文件暂不存在等情况，忽略（库更新时会重新尝试）
  }
}

export function unwatchLibraryMd(id: string): void {
  const w = watchers.get(id)
  if (w) {
    w.close()
    watchers.delete(id)
  }
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
}

/** 同步当前所有库的监听（启动时调用） */
export async function syncMdWatchers(listLibraries: () => Promise<Library[]>): Promise<void> {
  const libs = await listLibraries()
  for (const lib of libs) watchLibraryMd(lib)
}
