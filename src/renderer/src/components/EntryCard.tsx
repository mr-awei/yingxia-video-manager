import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DisplayEntry, Video } from '../../../shared/types'
import { posterUrl, placeholderGradient, titleInitial, titleSecondary, formatDuration } from '../lib/util'
import { useFrameFallback } from '../lib/frameFallback'
import { api } from '../lib/api'
import HoverDetail from './HoverDetail'
import Icon from './Icon'

interface Props {
  entry: DisplayEntry
  onOpen: (entry: DisplayEntry) => void
  onEdit: (v: Video) => void
  onOpenMissing: (entry: DisplayEntry) => void
  /** 收藏切换（持久化到视频记录） */
  onToggleFlag?: (id: string, key: 'favorite') => void
  /** 点击标签 → 一键筛选该标签全部影片 */
  onPickTag?: (tag: string) => void
  /** 从磁盘删除视频文件（弹二次确认、可能连带删所在目录） */
  onDelete?: (v: Video) => void
  /** 卡片宽高比：portrait 竖屏(2:3) / landscape 横屏(16:9) */
  aspect?: 'portrait' | 'landscape'
}

/** 把 DisplayEntry 组装成 Video 视图，供 HoverDetail / 预览面板复用 */
function hoverVideo(entry: DisplayEntry): Video {
  return {
    id: entry.video?.id ?? entry.code,
    libraryId: '',
    path: entry.video?.path ?? '',
    fileName: entry.code,
    title: entry.title,
    description: entry.description,
    tags: entry.tags,
    posterPath: entry.video?.posterPath,
    posterSource: entry.video?.posterSource,
    year: entry.video?.year,
    rating: entry.video?.rating,
    durationSec: entry.video?.durationSec,
    addedAt: 0
  }
}

/** Netflix 式悬浮预览面板：宽 360，高度动态；小图 96 宽 */
const PANEL_W = 360

function EntryCardInner({ entry, onOpen, onEdit, onOpenMissing, onToggleFlag, onPickTag, onDelete, aspect = 'portrait' }: Props) {
  const [imgError, setImgError] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const isMissing = entry.kind === 'missing'
  const v0 = entry.video
  // 真实封面优先于 ffmpeg 截帧：
  // ① 抓详情缓存的本地海报（javdbDetail.cover）→ ② 非截帧来源的 posterPath → ③ ffmpeg 截帧 posterPath
  const detailCover = v0?.javdbDetail?.cover && !/^https?:\/\//.test(v0.javdbDetail.cover) ? v0.javdbDetail.cover : null
  const realPoster =
    v0?.posterPath && v0.posterSource && v0.posterSource !== 'ffmpeg' && v0.posterSource !== 'placeholder'
      ? v0.posterPath
      : null
  const poster = detailCover ?? realPoster ?? v0?.posterPath ?? null
  const originalSrc = poster ? posterUrl(poster) : null
  const hasValidSrc = originalSrc && !imgError ? originalSrc : null
  const { fallbackPoster } = useFrameFallback(entry.video, hasValidSrc)
  const src = hasValidSrc ?? fallbackPoster
  const showPoster = !!src
  // 「截帧」标识：仅当实际展示的是视频画面一帧（新截帧兜底，或 posterPath 为 ffmpeg 截帧且无真实封面）
  const isFrameFallback = src
    ? src === fallbackPoster || (!detailCover && !realPoster && v0?.posterSource === 'ffmpeg')
    : false
  const score = entry.score ?? entry.video?.rating
  const v = hoverVideo(entry)
  const isFavorite = !!entry.video?.favorite
  const vid = entry.video?.id

  // ---------- 悬浮预览（Netflix 式：350ms dwell 延迟打开，移出 200ms 延迟关） ----------
  const clearOpenTimer = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])
  const scheduleOpen = useCallback(() => {
    clearOpenTimer()
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      const el = cardRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      // 优先右侧；放不下则左侧；再兜底贴边
      let x = r.right + 10
      if (x + PANEL_W > vw) x = r.left - PANEL_W - 10
      x = Math.max(8, Math.min(x, vw - PANEL_W - 8))
      const y = Math.min(Math.max(r.top, 8), vh - 220 - 8)
      setPreview({ x, y })
    }, 350)
  }, [clearOpenTimer])
  const scheduleClose = useCallback(() => {
    clearOpenTimer()
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setPreview(null), 200)
  }, [clearOpenTimer])
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  // 预览打开期间：滚动即关闭（虚拟墙滚动会改变卡片位置，面板不跟随）
  useEffect(() => {
    if (!preview) return
    const onScroll = () => setPreview(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null)
    }
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [preview])

  // 组件实例复用（虚拟墙无 key）：切换视频时重置封面加载失败状态，避免旧错误状态影响新封面显示
  useEffect(() => {
    setImgError(false)
  }, [entry.video?.id])

  // 卸载清理 timer
  useEffect(() => {
    return () => {
      clearOpenTimer()
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [clearOpenTimer])

  // 右键菜单：点击外部 / ESC 关闭
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  return (
    <div
      ref={cardRef}
      className={`entry-card entry-${aspect} group relative rounded-xl overflow-hidden cursor-pointer bg-ink-800 ring-1 ring-white/5 w-full min-w-0 ${
        isMissing ? 'opacity-80' : ''
      }`}
      onClick={() => (isMissing ? onOpenMissing(entry) : onOpen(entry))}
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - 190),
          y: Math.min(e.clientY, window.innerHeight - 190)
        })
      }}
    >
      <div className={`${aspect === 'landscape' ? 'aspect-video' : 'aspect-[2/3]'} w-full relative`}>
        {showPoster ? (
          <div className="absolute inset-0 poster-img">
            {/* 模糊铺底：横竖屏封面都能完整显示，四周裁切处由模糊同图填充，不露黑边 */}
            <img
              src={src}
              alt=""
              aria-hidden
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full scale-110 object-cover blur-lg opacity-40"
            />
            <img
              src={src}
              alt={entry.title}
              loading="lazy"
              decoding="async"
              onError={() => setImgError(true)}
              className="absolute inset-0 h-full w-full object-contain poster-img transition-transform duration-500 group-hover:scale-[1.04]"
            />
          </div>
        ) : (
          <PlaceholderCard code={entry.code} />
        )}

        {/* 顶部徽标 */}
        <div className="absolute top-2 left-2 flex items-center gap-1">
          {isMissing ? (
            <span className="px-1.5 py-0.5 rounded-md bg-red-600/90 backdrop-blur-sm text-[10px] text-white font-medium flex items-center gap-1">
              <Icon name="alert" size={10} />
              缺失
            </span>
          ) : null}
          {isFavorite ? (
            <span className="px-1.5 py-0.5 rounded-md bg-brand/90 backdrop-blur-sm text-[10px] text-white font-medium flex items-center gap-1">
              <Icon name="heart" size={10} className="fill-current" />
            </span>
          ) : null}
          {/* 截帧封面标识：无真实封面，展示的是视频里截取的一帧画面 */}
          {isFrameFallback && !isMissing ? (
            <span
              className="px-1.5 py-0.5 rounded-md bg-fuchsia-500/90 backdrop-blur-sm text-[10px] text-white font-bold flex items-center gap-1"
              title="无真实封面，截取视频画面一帧作为封面"
            >
              <Icon name="film" size={10} className="fill-current" />
              截帧
            </span>
          ) : null}
          {/* 数据来源角标：仅 Javapi / JavBus / Javinfo 显示（无角标 = JavDB） */}
          {entry.video?.javdbDetail?.source === 'javapi' ? (
            <span className="px-1.5 py-0.5 rounded-md bg-sky-500/90 backdrop-blur-sm text-[10px] text-black font-bold">
              Javapi
            </span>
          ) : entry.video?.javdbDetail?.source === 'javbus' ? (
            <span className="px-1.5 py-0.5 rounded-md bg-amber-500/90 backdrop-blur-sm text-[10px] text-black font-bold">
              JavBus
            </span>
          ) : entry.video?.javdbDetail?.source === 'javinfo' ? (
            <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/90 backdrop-blur-sm text-[10px] text-black font-bold">
              Javinfo
            </span>
          ) : null}
        </div>

        {/* 悬停快捷操作（右上）—— 高对比白底，避免在暗色海报上灰掉看不见 */}
        {!isMissing && entry.video ? (
          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
            <button
              className="w-7 h-7 rounded-lg bg-white/95 text-slate-900 hover:bg-brand hover:text-white flex items-center justify-center no-drag shadow-md shadow-black/25 ring-1 ring-black/10 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                void api.videoOpen(entry.video!.id)
              }}
              title="播放"
            >
              <Icon name="play" size={12} className="fill-current" />
            </button>
            {onToggleFlag && vid ? (
              <>
                <button
                  className={`w-7 h-7 rounded-lg flex items-center justify-center no-drag shadow-md shadow-black/25 ring-1 ring-black/10 transition-colors ${
                    isFavorite
                      ? 'bg-brand text-white'
                      : 'bg-white/95 text-slate-900 hover:bg-brand hover:text-white'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleFlag(vid, 'favorite')
                  }}
                  title={isFavorite ? '取消收藏' : '收藏'}
                >
                  <Icon name="heart" size={12} className={isFavorite ? 'fill-current' : ''} />
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {/* 底部名字条 + 评分 */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-2 pb-1.5 pt-8">
          <div className="flex items-end justify-between gap-1.5 min-w-0">
            <div className="card-title text-[13px] font-medium text-white truncate leading-tight min-w-0 flex-1">
              {entry.code}
            </div>
            {score != null ? (
              <span className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-black/50 backdrop-blur-sm ring-1 ring-white/10">
                <Icon name="star" size={10} className="text-brand fill-brand" />
                <span className="card-title text-[11px] font-bold text-white tabular-nums leading-none">
                  {score.toFixed(2)}
                </span>
              </span>
            ) : null}
          </div>
        </div>

        {/* hover 快速信息蒙层（标题/评分/标签紧凑版） */}
        <div className="card-hover absolute inset-0 overflow-hidden bg-gradient-to-t from-black/95 via-black/65 to-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-[250ms] p-3 flex flex-col justify-end">
          <HoverDetail video={v} />
        </div>

        {/* hover 快捷编辑 —— 与高对比操作按钮保持一致 */}
        {!isMissing && entry.video ? (
          <button
            className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity no-drag z-20 w-7 h-7 rounded-lg bg-white/95 text-slate-900 hover:bg-brand hover:text-white flex items-center justify-center shadow-md shadow-black/25 ring-1 ring-black/10 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(entry.video!)
            }}
            title="编辑"
          >
            <Icon name="pencil" size={12} />
          </button>
        ) : null}
      </div>

      {/* Netflix 式悬浮预览面板（portal 到 body，不被滚动容器裁剪） */}
      {preview && !isMissing
        ? createPortal(
            <div
              className="fixed z-[70] w-[360px] rounded-xl bg-ink-800 ring-1 ring-white/10 shadow-2xl shadow-black/50 overflow-hidden animate-fadeIn-fast cursor-pointer"
              style={{ left: preview.x, top: preview.y }}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
              onClick={(e) => {
                e.stopPropagation()
                setPreview(null)
                onOpen(entry)
              }}
            >
              {/* 上：封面 + 标题 + 元信息 + 标签（标签填满右信息区空白） */}
              <div className="flex gap-3 p-3 pb-2.5">
                <div className={`${aspect === 'landscape' ? 'w-32 h-[72px]' : 'w-24 h-36'} shrink-0 rounded-lg overflow-hidden bg-ink-700 ring-1 ring-white/5 relative`}>
                  {src ? (
                    <img src={src} alt={entry.title} className="h-full w-full object-contain poster-img" />
                  ) : (
                    <div
                      className="h-full w-full flex items-center justify-center text-xl font-bold text-white/70"
                      style={{ background: placeholderGradient(entry.code) }}
                    >
                      <PlaceholderCard code={entry.code} compact />
                    </div>
                  )}
                  {isFrameFallback ? (
                    <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/70 text-white text-[9px] font-bold flex items-center gap-0.5">
                      <Icon name="film" size={8} className="fill-current" />
                      帧
                    </span>
                  ) : null}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-white leading-snug break-words line-clamp-2">
                    {v.title}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-white/60 mt-1">
                    {score != null ? (
                      <span className="flex items-center gap-0.5 text-brand font-bold">
                        <Icon name="star" size={10} className="fill-brand" />
                        {score.toFixed(2)}
                      </span>
                    ) : null}
                    {v.year ? <span>{v.year}</span> : null}
                    {v.durationSec ? <span>{formatDuration(v.durationSec)}</span> : null}
                  </div>

                  {/* 标签 chips：填充右信息区下方空白（用户建议的位置）；点击标签一键筛选 */}
                  {v.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-2 max-h-[64px] overflow-hidden">
                      {v.tags.slice(0, 8).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setPreview(null)
                            onPickTag?.(t)
                          }}
                          title={`筛选「${t}」`}
                          className="px-1.5 py-0.5 rounded bg-white/8 ring-1 ring-white/5 text-[10px] text-white/70 max-w-full min-w-0 break-words hover:bg-brand/25 hover:text-brand hover:ring-brand/30 transition-colors"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* 下：简介 */}
              {v.description ? (
                <div className="px-3 pb-3">
                  <p className="text-xs text-white/70 leading-relaxed break-all [overflow-wrap:anywhere] line-clamp-5 border-t border-white/5 pt-2.5">
                    {v.description}
                  </p>
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}

      {/* 右键菜单（portal 到 body） */}
      {menu
        ? createPortal(
            <div
              className="fixed z-[80] min-w-[180px] rounded-xl bg-ink-800 ring-1 ring-white/10 shadow-xl shadow-black/40 py-1.5 text-sm overflow-hidden animate-fadeIn-fast"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {!isMissing && entry.video ? (
                <>
                  <MenuItem
                    icon="play"
                    label="播放"
                    onClick={() => {
                      setMenu(null)
                      void api.videoOpen(entry.video!.id)
                    }}
                  />
                  <MenuItem
                    icon="pencil"
                    label="编辑"
                    onClick={() => {
                      setMenu(null)
                      onEdit(entry.video!)
                    }}
                  />
                  <MenuItem
                    icon="folderOpen"
                    label="打开文件位置"
                    onClick={() => {
                      setMenu(null)
                      void api.shellRevealInFolder(entry.video!.path)
                    }}
                  />
                  {onDelete ? (
                    <MenuItem
                      icon="trash"
                      label="删除文件"
                      danger
                      onClick={() => {
                        setMenu(null)
                        onDelete(entry.video!)
                      }}
                    />
                  ) : null}
                  <div className="my-1 border-t border-white/5" />
                </>
              ) : (
                <MenuItem
                  icon="folderOpen"
                  label="打开简介"
                  onClick={() => {
                    setMenu(null)
                    onOpenMissing(entry)
                  }}
                />
              )}
              <MenuItem
                icon="copy"
                label="复制番号"
                onClick={() => {
                  setMenu(null)
                  api.copyText(entry.code)
                }}
              />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger
}: {
  icon: 'play' | 'pencil' | 'folderOpen' | 'copy' | 'trash'
  label: string
  onClick: () => void
  /** 危险操作样式（红色） */
  danger?: boolean
}) {
  return (
    <button
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors ${
        danger
          ? 'text-red-400/90 hover:bg-red-500/15 hover:text-red-300'
          : 'text-white/90 hover:bg-ink-700 hover:text-white'
      }`}
      onClick={onClick}
    >
      <Icon name={icon} size={14} className={danger ? 'text-red-400/70' : 'text-white/50'} />
      {label}
    </button>
  )
}

export default memo(EntryCardInner)

/** 大厂风格多层占位卡：左上大字 + 下方番号小字 + 斜线纹理 + 底部装订线 */
function PlaceholderCard({ code, compact = false }: { code: string; compact?: boolean }) {
  return (
    <div className="relative h-full w-full overflow-hidden" style={{ background: placeholderGradient(code) }}>
      {/* 细腻纹理：细斜线，比之前更密更淡，模拟纸面质感 */}
      <div
        className="absolute inset-0 opacity-[0.05] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage:
            'repeating-linear-gradient(135deg, transparent, transparent 2px, rgba(255,255,255,0.7) 2px, rgba(255,255,255,0.7) 3px)'
        }}
      />
      {/* 左上角品牌光斑 + 右下暗角（增强立体） */}
      <div className="absolute -top-10 -left-10 w-40 h-40 rounded-full bg-white/10 blur-2xl pointer-events-none" />
      <div className="absolute -bottom-12 -right-12 w-48 h-48 rounded-full bg-black/30 blur-3xl pointer-events-none" />
      <div className="absolute inset-0 flex flex-col items-center justify-center px-2 gap-2">
        {/* 大字母放在玻璃圆底上（Apple TV / App 图标式） */}
        <div
          className={`${compact ? 'w-14 h-14 text-2xl' : 'w-[4.75rem] h-[4.75rem] text-3xl'} rounded-2xl bg-white/25 ring-1 ring-white/40 backdrop-blur-md flex items-center justify-center font-bold text-white leading-none tracking-tight drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] select-none shadow-xl shadow-black/40`}
          style={{ textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}
        >
          {titleInitial(code)}
        </div>
        <div className="text-[10px] font-semibold text-white tracking-[0.12em] uppercase truncate max-w-[88%] text-center drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]">
          {titleSecondary(code)}
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
    </div>
  )
}
