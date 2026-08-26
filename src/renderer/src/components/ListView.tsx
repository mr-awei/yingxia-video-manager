import { memo } from 'react'
import type { DisplayEntry, Video } from '../../../shared/types'
import { posterUrl, placeholderGradient, titleInitial, formatDuration } from '../lib/util'
import { api } from '../lib/api'
import Icon from './Icon'

interface Props {
  entries: DisplayEntry[]
  onOpen: (e: DisplayEntry) => void
  onEdit: (v: Video) => void
  onOpenMissing: (e: DisplayEntry) => void
  onToggleFlag?: (id: string, key: 'favorite') => void
}

function ListViewInner({ entries, onOpen, onEdit, onOpenMissing, onToggleFlag }: Props) {
  if (entries.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-white/40 text-sm px-6 text-center animate-fadeIn">
        <div className="w-14 h-14 rounded-2xl bg-ink-800 ring-1 ring-white/5 flex items-center justify-center mb-4">
          <Icon name="search" size={26} />
        </div>
        当前筛选条件下没有匹配的影片，试试调整搜索或标签。
      </div>
    )
  }

  return (
    <div className="overflow-auto thin-scroll pr-1 h-full">
      <div className="flex flex-col gap-1.5">
        {entries.map((e) => {
          const v = e.video
          const isMissing = e.kind === 'missing'
          const src = v?.posterPath ? posterUrl(v.posterPath) : null
          const score = e.score ?? v?.rating
          const fav = !!v?.favorite
          return (
            <div
              key={e.code}
              className={`group flex items-center gap-3 px-2.5 py-2 rounded-xl bg-ink-800/50 hover:bg-ink-700/70 ring-1 ring-white/5 transition-colors cursor-pointer ${
                isMissing ? 'opacity-80' : ''
              }`}
              onClick={() => (isMissing ? onOpenMissing(e) : onOpen(e))}
            >
              {/* 缩略图 */}
              <div className="w-11 h-16 shrink-0 rounded-md overflow-hidden bg-ink-900 ring-1 ring-white/10 relative">
                {src ? (
                  <img src={src} alt={e.title} className="h-full w-full object-cover poster-img" loading="lazy" />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-base font-bold text-white/80" style={{ background: placeholderGradient(e.code) }}>
                    {titleInitial(e.code)}
                  </div>
                )}
                {isMissing ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-red-600/70 text-white text-[9px] font-bold">缺失</span>
                ) : null}
              </div>

              {/* 主信息 */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[13px] font-medium text-white truncate">{e.code}</span>
                  {score != null ? (
                    <span className="flex items-center gap-0.5 text-brand text-[12px] font-semibold shrink-0">
                      <Icon name="star" size={11} className="fill-brand" />
                      {score.toFixed(2)}
                    </span>
                  ) : null}
                  {fav ? <Icon name="heart" size={12} className="text-brand fill-current shrink-0" /> : null}
                </div>
                <div className="text-white/45 text-[11px] truncate mt-0.5">
                  {v?.year ? `${v.year} · ` : ''}
                  {v?.javdbDetail?.studio ?? e.category}
                  {v?.durationSec ? ` · ${formatDuration(v.durationSec)}` : ''}
                </div>
              </div>

              {/* 标签预览 */}
              <div className="hidden md:flex items-center gap-1 max-w-[240px] overflow-hidden shrink-0">
                {e.tags.slice(0, 3).map((t) => (
                  <span key={t} className="px-1.5 py-0.5 rounded bg-white/6 text-white/55 text-[10px] truncate max-w-[90px]">
                    {t}
                  </span>
                ))}
              </div>

              {/* 操作 */}
              {!isMissing && v ? (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    className="w-7 h-7 rounded-lg bg-black/40 hover:bg-brand text-white flex items-center justify-center no-drag"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void api.videoOpen(v.id)
                    }}
                    title="播放"
                  >
                    <Icon name="play" size={12} className="fill-current" />
                  </button>
                  {onToggleFlag ? (
                    <>
                      <button
                        className={`w-7 h-7 rounded-lg flex items-center justify-center no-drag ${fav ? 'bg-brand text-white' : 'bg-black/40 hover:bg-brand text-white'}`}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onToggleFlag(v.id, 'favorite')
                        }}
                        title={fav ? '取消收藏' : '收藏'}
                      >
                        <Icon name="heart" size={12} className={fav ? 'fill-current' : ''} />
                      </button>
                    </>
                  ) : null}
                  <button
                    className="w-7 h-7 rounded-lg bg-black/40 hover:bg-ink-600 text-white flex items-center justify-center no-drag"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onEdit(v)
                    }}
                    title="编辑"
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default memo(ListViewInner)
