import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Settings, Video } from '../../shared/types'
import { updateVideo } from './repo'

/** 点击视频：用可配置播放器或系统默认程序打开，并记录播放时间 */
export async function openVideo(video: Video, settings: Settings): Promise<{ ok: boolean; method: string }> {
  const player = settings.playerPath.trim()
  if (player) {
    try {
      await fs.access(player)
      const child = spawn(player, [video.path], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      await updateVideo(video.id, { lastPlayedAt: Date.now() })
      return { ok: true, method: 'custom' }
    } catch {
      // 指定播放器不可用，回退系统默认
    }
  }
  await shell.openPath(video.path)
  await updateVideo(video.id, { lastPlayedAt: Date.now() })
  return { ok: true, method: 'system' }
}
