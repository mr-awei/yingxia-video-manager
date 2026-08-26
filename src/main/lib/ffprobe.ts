import { execFile } from 'node:child_process'
import type { Settings, TechInfo } from '../../shared/types'
import { resolveFfprobeExe } from './ffmpegEnv'

/**
 * 用 ffprobe 读取本地视频技术参数（分辨率/编码/码率/帧率/时长）。
 * 失败（文件缺失/损坏/ffprobe 不可用）一律返回 null，由调用方降级跳过。
 */
export async function probeVideo(videoPath: string, settings: Settings): Promise<TechInfo | null> {
  try {
    const ffprobe = (await resolveFfprobeExe(settings)) || 'ffprobe'
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        ffprobe,
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath],
        { maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
        (err, out) => (err ? reject(err) : resolve(out))
      )
    })
    const data = JSON.parse(stdout) as {
      streams?: Array<Record<string, any>>
      format?: Record<string, any>
    }
    const streams = data.streams ?? []
    const videoStream = streams.find((s) => s.codec_type === 'video')
    const audioStream = streams.find((s) => s.codec_type === 'audio')
    const fmt = data.format ?? {}
    const info: TechInfo = {}
    if (videoStream?.width) info.width = Number(videoStream.width)
    if (videoStream?.height) info.height = Number(videoStream.height)
    if (videoStream?.codec_name) info.videoCodec = String(videoStream.codec_name)
    if (videoStream?.avg_frame_rate) {
      const [n, d] = String(videoStream.avg_frame_rate).split('/').map(Number)
      if (n && d) info.fps = Math.round((n / d) * 100) / 100
    }
    if (audioStream?.codec_name) info.audioCodec = String(audioStream.codec_name)
    const br = videoStream?.bit_rate ?? fmt.bit_rate
    if (br) info.bitrateKbps = Math.round(Number(br) / 1000)
    if (fmt.duration) info.durationSec = Math.round(Number(fmt.duration))
    return Object.keys(info).length > 0 ? info : null
  } catch {
    return null
  }
}
