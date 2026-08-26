import type { Video } from '../../../shared/types'
import { formatDuration } from '../lib/util'

export default function HoverDetail({ video }: { video: Video }) {
  return (
    // min-w-0 让 flex 子项能收缩到 0；break-words 让超长 token 断行
    <div className="pointer-events-none min-w-0 max-w-full break-words">
      <div className="text-sm font-semibold text-white leading-tight truncate min-w-0">{video.title}</div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-white/70 mt-1 min-w-0">
        {video.year && <span className="shrink-0">{video.year}</span>}
        {video.rating != null && (
          <span className="text-brand font-bold text-[13px] leading-none shrink-0">★ {video.rating.toFixed(2)}</span>
        )}
        {video.durationSec ? <span className="shrink-0">{formatDuration(video.durationSec)}</span> : null}
      </div>

      {video.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 min-w-0">
          {video.tags.slice(0, 6).map((t) => (
            <span
              key={t}
              className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-white/80 max-w-full min-w-0 break-words"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}