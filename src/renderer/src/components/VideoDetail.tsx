import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DisplayEntry, JavdbDetail, Video } from '../../../shared/types'
import { hasDocTags, primaryTags, NON_TAG_CATEGORY_NAMES } from '../../../shared/types'
import { posterUrl, placeholderGradient, titleInitial, formatSize } from '../lib/util'
import { useFrameFallback } from '../lib/frameFallback'
import { api } from '../lib/api'
import Icon from './Icon'
import { toast } from './Toast'

interface Props {
  video: Video
  onClose: () => void
  onPlay: (v: Video) => void
  /** 抓取成功回调（用于回写 App 展示数据，下次直接命中本地缓存） */
  onDetailFetched?: (videoId: string, detail: JavdbDetail) => void
  /** 截帧/封面更新回调（用于回写 App 列表态，立即刷新封面）。
   *  previewPaths 为空表示不修改原有预览帧；posterSource 默认 'ffmpeg' */
  onPosterFetched?: (videoId: string, posterPath: string, previewPaths?: string[], posterSource?: string) => void
  /** ffprobe 技术参数读取成功回调（回写持久化） */
  onTechInfoFetched?: (videoId: string, tech: Video['techInfo']) => void
  /** 点击演员/片商/系列 → 请求按该维度筛选并回到首页 */
  onPickFilter?: (f: { type: 'actor' | 'studio' | 'series'; value: string }) => void
  /** 点击标签 → 请求按该标签筛选全部影片 */
  onPickTag?: (tag: string) => void
  /** 收藏切换（持久化到视频记录） */
  onToggleFlag?: (id: string, key: 'favorite') => void
  /** 相关推荐条目（同片商/系列/女演员） */
  related?: DisplayEntry[]
  /** 点击相关推荐 → 打开该条目详情 */
  onOpenRelated?: (entry: DisplayEntry) => void
  /** 所属系列 base code（如 HUNTA-468） */
  seriesBase?: string
  /** 同系列全部条目（含当前） */
  seriesMembers?: DisplayEntry[]
  /** 编辑影片信息 */
  onEdit?: (v: Video) => void
  /** 从磁盘删除视频文件（弹二次确认、按需连带删同目录种子文件夹） */
  onDelete?: (v: Video) => void
}

/** 渲染元数据一行（key: value）—— label 左对齐，列宽由最宽 label 自动撑开 */
function MetaRow({
  label,
  value,
  children
}: {
  label: string
  value?: string
  children?: ReactNode
}) {
  if (!value && !children) return null
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3 text-sm items-start">
      <span className="text-white/40 whitespace-nowrap pt-0.5">{label}</span>
      <span className="text-white/90 break-all min-w-0">{children ?? value}</span>
    </div>
  )
}

/** 把 ffprobe 技术参数拼成一行可读文本（分辨率 · 编码 · 码率 · 帧率） */
function formatTech(t?: Video['techInfo']): string | undefined {
  if (!t) return undefined
  const p: string[] = []
  if (t.width && t.height) p.push(`${t.width}×${t.height}`)
  if (t.videoCodec) p.push(t.videoCodec.toUpperCase())
  if (t.bitrateKbps) p.push(`${(t.bitrateKbps / 1000).toFixed(1)} Mbps`)
  if (t.fps) p.push(`${t.fps} fps`)
  if (t.audioCodec) p.push(`音频 ${t.audioCodec.toUpperCase()}`)
  return p.length ? p.join(' · ') : undefined
}

export default function VideoDetail({ video, onClose, onPlay, onDetailFetched, onPosterFetched, onTechInfoFetched, onPickFilter, onPickTag, onToggleFlag, related, onOpenRelated, seriesBase, seriesMembers, onEdit, onDelete }: Props) {
  const [detail, setDetail] = useState<Video['javdbDetail']>(video.javdbDetail)
  /** 本地 video 副本：截帧/封面更新后立即反映，不必等父组件重新拉取 */
  const [localVideo, setLocalVideo] = useState<Video>(video)
  /** 封面加载失败（路径失效）时标记，触发截帧兜底 */
  const [coverImgError, setCoverImgError] = useState(false)
  /** 封面缓存失效版本号：手动设封面/重新截帧后 +1，让封面 img 的 lm:// URL 带 ?v= 强制立即刷新；
   *  初始值取自 App 的 coverVersion，重开详情页时与列表端版本一致，避免退回旧缓存 */
  const [posterVersion, setPosterVersion] = useState(video.coverVersion ?? 0)
  useEffect(() => {
    setLocalVideo(video)
    setDetail(video.javdbDetail)
    setCoverImgError(false)
    setPosterVersion(video.coverVersion ?? 0)
  }, [video.id])
  /** 手动「补齐信息」进行中（与截帧互不干扰，各自独立 loading） */
  const [fetching, setFetching] = useState(false)
  /** 手动「重新截帧」进行中 */
  const [framing, setFraming] = useState(false)
  /** 手动补齐：无视缓存强制重抓当前作品（多源 JavDB → JavBus）。
   * 无论数据是否与旧缓存一致，只要拿到新数据就弹窗提示已更新 + 来源；失败弹窗说明原因。 */
  const forceFetch = useCallback(async () => {
    if (fetching) return
    setFetching(true)
    setError(null)
    try {
      if (localVideo.domestic) {
        // 国产片：不抓 JavDB/JavBus，仅用 ffmpeg 重新截帧（封面 + 预览）
        await handleGenerateFrames()
        return
      }
      const res = await api.videoFetchJavdbDetail(video.id)
      if (res?.ok && res.detail) {
        setDetail(res.detail)
        onDetailFetched?.(video.id, res.detail)
        const src = res.source === 'javbus' ? 'JavBus' : res.source === 'javinfo' ? 'Javinfo' : res.source === 'javapi' ? 'Javapi' : 'JavDB'
        toast({ text: `信息已更新（来源：${src}）`, tone: 'ok' })
      } else {
        const reason = res && !res.ok ? res.error : '未知原因'
        toast({ text: `补齐失败：${reason ?? '未知原因'}`, tone: 'err' })
      }
    } catch (e) {
      toast({ text: `补齐失败：${(e as Error)?.message ?? e}`, tone: 'err' })
    } finally {
      setFetching(false)
    }
  }, [localVideo.id, localVideo.domestic, fetching, onDetailFetched, onPosterFetched])
  /** ffmpeg 重新截帧（1 封面 + 预览帧），所有视频（含非国产片）都可用 */
  const handleGenerateFrames = useCallback(async () => {
    if (framing) return
    setFraming(true)
    setError(null)
    try {
      const updated = await api.videoGeneratePreviews(localVideo.id)
      if (updated?.posterPath) {
        setLocalVideo((prev) => ({ ...prev, posterPath: updated.posterPath, posterSource: updated.posterSource ?? 'ffmpeg', previewPaths: updated.previewPaths }))
        setPosterVersion((v) => v + 1)
        onPosterFetched?.(localVideo.id, updated.posterPath, updated.previewPaths, updated.posterSource ?? 'ffmpeg')
        toast({ text: '已用 ffmpeg 重新截帧（封面 + 预览）', tone: 'ok' })
      } else {
        toast({ text: '截帧失败：未检测到 ffmpeg 或无视频流', tone: 'err' })
      }
    } catch (e) {
      toast({ text: `截帧失败：${(e as Error)?.message ?? e}`, tone: 'err' })
    } finally {
      setFraming(false)
    }
  }, [localVideo.id, onPosterFetched, framing])
  /** 截帧预览帧 → 设为封面：复制为 <id>.jpg 并更新本地副本 + 通知父组件 */
  const handleSetPreviewAsCover = useCallback(
    async (previewPath: string) => {
      try {
        const updated = await api.videoSetPreviewAsCover(localVideo.id, previewPath)
        if (updated?.posterPath) {
          setLocalVideo((prev) => ({ ...prev, posterPath: updated.posterPath!, posterSource: updated.posterSource ?? 'manual' }))
          setPosterVersion((v) => v + 1)
          // 透传 previewPaths：避免父组件把已有截帧预览清空；posterSource 也透传（manual），不再硬编码 ffmpeg
          onPosterFetched?.(localVideo.id, updated.posterPath, localVideo.previewPaths, updated.posterSource ?? 'manual')
          toast({ text: '已将该预览帧设为封面', tone: 'ok' })
        } else {
          toast({ text: '设置失败：预览帧无效', tone: 'err' })
        }
      } catch (e) {
        toast({ text: `设置失败：${(e as Error)?.message ?? e}`, tone: 'err' })
      }
    },
    [localVideo.id, onPosterFetched]
  )
  /** ffprobe 技术参数：本地持有，避免依赖父组件回写延迟；首次打开无则自动探测 */
  const [tech, setTech] = useState<Video['techInfo']>(video.techInfo)
  // 若无技术参数，自动用 ffprobe 读取（一次），成功则本地展示 + 回写父组件持久化
  useEffect(() => {
    if (tech) return
    let alive = true
    api
      .videoProbe(video.id)
      .then((updated) => {
        if (!alive) return
        const t = updated?.techInfo
        if (t) {
          setTech(t)
          onTechInfoFetched?.(video.id, t)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // 仅在视频切换时尝试探测，tech 变化不再触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** hover 样本图时显示原尺寸大图 */
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)
  /** 备用来源标签（backupTags）默认折叠为一行；点开才展开全部 */
  const [showBackupTags, setShowBackupTags] = useState(false)
  /** ESC：放大图打开时先关放大图，否则关闭详情页（非组合键，用户要求保留） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (zoomUrl) setZoomUrl(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomUrl, onClose])
  const closeTimer = useRef<number | null>(null)
  const openTimer = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setZoomUrl(null), 180)
  }
  /** 延迟打开：hover 停留 350ms 稳定后才开，避免划过误触 */
  const scheduleOpen = (url: string) => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setZoomUrl(url)
    }, 350)
  }
  const clearOpenTimer = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }
  /** 卸载时清掉两个 timer */
  useEffect(() => {
    return () => {
      if (openTimer.current) clearTimeout(openTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  // 分享：扫描视频文件夹 .torrent → 转磁链 → 复制第一个 → 弹 toast
  const handleShare = useCallback(async () => {
    try {
      const r = await api.videoShareTorrents(video.id)
      if (r.items.length === 0) {
        toast({ text: `视频文件夹下未找到 .torrent 种子文件 ${r.dir}`, tone: 'info', duration: 6000 })
      } else if (r.copied) {
        toast({
          title: '已复制磁链',
          text: `${r.items[0].name}`,
          tone: 'ok',
          action: { label: '复制', onClick: () => void navigator.clipboard?.writeText(r.items[0].magnet) },
          duration: 6000
        })
      } else {
        toast({ text: `找到 ${r.items.length} 个种子，但复制失败`, tone: 'warn', duration: 6000 })
      }
    } catch (e) {
      toast({ text: `分享失败：${(e as Error).message}`, tone: 'err' })
    }
  }, [video.id])

  // 判断缓存的 javdbDetail 是否"陈旧"（含远程 URL，可能是修复前缓存的）—— 这种情况重新抓一次升级成本地路径
  const isStale = (d: Video['javdbDetail']): boolean => {
    if (!d) return true
    if (d.cover && /^https?:\/\//.test(d.cover)) return true
    if (d.samples && d.samples.some((s) => /^https?:\/\//.test(s))) return true
    return false
  }

  // 打开即展示；缓存命中且不陈旧 → 零请求；否则（首次或陈旧）抓一次保存本地，之后直接命中缓存不再请求
  useEffect(() => {
    if (video.domestic) {
      // 国产片：不自动抓取元数据，封面/预览均由 ffmpeg 截帧提供
      setDetail(video.javdbDetail)
      setLoading(false)
      setError(null)
      return
    }
    if (!isStale(video.javdbDetail)) {
      setDetail(video.javdbDetail)
      setLoading(false)
      setError(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    api
      .videoFetchJavdbDetail(video.id)
      .then((res) => {
        if (!alive) return
        if (res?.ok && res.detail) {
          setDetail(res.detail)
          onDetailFetched?.(video.id, res.detail) // 回写 App，下次直接命中缓存
        } else {
          const reason = res && !res.ok ? res.error : '未知原因'
          setError(`未抓到详情：${reason ?? '未知原因'}`)
        }
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(`抓取失败：${(e as Error)?.message ?? e}`)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [video.id])

  const d = detail
  // 只用本地路径：远程 URL 经 posterUrl 透传会让 Chromium 直连 javdb CDN 触发 403 反盗链
  const isLocal = (u?: string) => !!u && !/^https?:\/\//.test(u)
  // 手动设为封面（posterSource='manual'，预览帧设为封面）优先级最高，立即生效且持久；
  // 否则用详情真实封面（d.cover），再退回 posterPath
  const originalCover =
    (localVideo.posterSource === 'manual' && localVideo.posterPath
      ? localVideo.posterPath
      : d?.cover && isLocal(d.cover)
        ? d.cover
        : localVideo.posterPath) || null
  // 无封面/封面加载失败 → ffmpeg 截帧兜底（懒加载）
  const { fallbackPoster, isFrameFallback } = useFrameFallback(
    localVideo,
    originalCover && !coverImgError ? originalCover : null
  )
  const coverSrc = (originalCover && !coverImgError ? originalCover : null) ?? fallbackPoster

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-auto thin-scroll animate-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-5xl max-h-[92vh] overflow-auto thin-scroll bg-ink-850 rounded-2xl ring-1 ring-white/10 shadow-2xl shadow-black/50 animate-modal-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5" onClick={(e) => e.stopPropagation()}>
        {/* 顶部工具条 */}
        <div className="flex items-center justify-between mb-4 sticky top-0 -mx-5 px-5 py-3 bg-ink-850/95 z-10 backdrop-blur-sm border-b border-white/5">
          <button
            className="no-drag h-8 px-3 rounded-lg flex items-center gap-1.5 bg-ink-700 hover:bg-ink-600 text-white text-sm transition-colors"
            onClick={onClose}
          >
            <Icon name="arrowLeft" size={14} />
            返回
          </button>
          <div className="flex items-center gap-2">
            <button
              className="no-drag h-8 px-3 rounded-lg flex items-center gap-1.5 bg-ink-700 hover:bg-ink-600 text-white text-sm transition-colors"
              onClick={handleShare}
              title="扫描视频文件夹下的 .torrent 种子文件，转为磁链并复制到剪贴板"
            >
              <Icon name="copy" size={13} />
              分享
            </button>
            {!video.domestic ? (
              <button
                className="no-drag h-8 px-3 rounded-lg flex items-center gap-1.5 bg-ink-700 hover:bg-ink-600 text-white text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={forceFetch}
                disabled={fetching || framing}
                title="强制重新获取当前作品的全部信息（JavDB → JavBus 多源）"
              >
                <Icon name="refresh" size={13} className={fetching ? 'animate-spin' : ''} />
                {fetching ? '处理中…' : '补齐信息'}
              </button>
            ) : null}
            <button
              className="no-drag h-8 px-3 rounded-lg flex items-center gap-1.5 bg-ink-700 hover:bg-ink-600 text-white text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleGenerateFrames}
              disabled={fetching || framing}
              title="用 ffmpeg 重新截帧（1 封面 + 预览帧），可再挑一帧设为封面"
            >
              <Icon name="film" size={13} className={framing ? 'animate-spin' : ''} />
              {framing ? '截帧中…' : '重新截帧'}
            </button>
            {onToggleFlag ? (
              <>
                <button
                  className={`no-drag h-8 w-9 rounded-lg flex items-center justify-center transition-colors ${
                    video.favorite ? 'bg-brand text-white' : 'bg-ink-700 hover:bg-ink-600 text-white'
                  }`}
                  onClick={() => onToggleFlag(video.id, 'favorite')}
                  title={video.favorite ? '取消收藏' : '收藏'}
                >
                  <Icon name="heart" size={14} className={video.favorite ? 'fill-current' : ''} />
                </button>
              </>
            ) : null}
          </div>
        </div>

        {/* 封面 + 元数据 —— 左栏封面(固定2:3)+简介, 右栏标题/按钮/Meta/标签/文件信息
            封面保持 aspect-[2/3] 海报比例, 不被右栏 self-stretch 撑得过高导致大片模糊背景;
            简介放到封面下方, 让左栏也有足够高度, 两栏视觉均衡. */}
        <div className="grid grid-cols-[260px_1fr] gap-6 mb-6 items-start">
          {/* 左栏：封面(固定 2:3) + 简介(紧跟下方) */}
          <div className="flex flex-col gap-4">
            <div className="aspect-[2/3] w-full rounded-xl overflow-hidden bg-ink-800 ring-1 ring-white/10 relative shrink-0">
            {coverSrc ? (
              <div className="absolute inset-0">
                {/* 模糊铺底：横竖屏封面完整显示，四周裁切处由模糊同图填充 */}
                <img
                  src={posterUrl(coverSrc, posterVersion) ?? ''}
                  alt=""
                  aria-hidden
                  className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl opacity-40"
                />
                <img
                  src={posterUrl(coverSrc, posterVersion) ?? ''}
                  alt={video.title}
                  className="relative h-full w-full object-contain poster-img"
                  onError={() => setCoverImgError(true)}
                />
              </div>
            ) : (
              <div
                className="h-full w-full flex items-center justify-center text-5xl font-bold text-white/80"
                style={{ background: placeholderGradient(video.title) }}
              >
                {titleInitial(video.title)}
              </div>
            )}
          </div>{/* 封面容器结束 */}
            {/* 简介 —— 纯文本段落接封面下方, 用细分隔线和封面区分, 无卡片感 */}
            {video.description ? (
              <div className="text-[13px] text-white/70 leading-[1.8] whitespace-pre-wrap max-h-[280px] overflow-y-auto pt-4 border-t border-white/10">
                {video.description}
              </div>
            ) : null}
          </div>{/* 左栏 flex-col 结束 */}
          <div className="min-w-0 flex flex-col">
            {d ? (
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium mb-2 ${
                  d.source === 'javbus'
                    ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30'
                    : d.source === 'javinfo'
                      ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                      : d.source === 'javapi'
                        ? 'bg-sky-500/15 text-sky-400 ring-1 ring-sky-500/30'
                        : 'bg-brand/15 text-brand ring-1 ring-brand/30'
                }`}
              >
                数据来源 {d.source === 'javbus' ? 'JavBus' : d.source === 'javinfo' ? 'Javinfo' : d.source === 'javapi' ? 'Javapi' : 'JavDB'}
              </span>
            ) : null}
            {/* 截帧封面标识：无真实封面，展示的是视频画面里截的一帧（d.cover 有真实封面时不显示） */}
            {isFrameFallback && !(d?.cover && isLocal(d.cover)) ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium mb-2 bg-fuchsia-500/15 text-fuchsia-400 ring-1 ring-fuchsia-500/30">
                <Icon name="film" size={11} className="fill-current" />
                截帧封面（视频画面一帧，非真实封面）
              </span>
            ) : null}
            {/* 国产片徽章：纯中文文件夹，不抓元数据，仅 ffmpeg 截帧 */}
            {video.domestic ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium mb-2 bg-green-500/15 text-green-400 ring-1 ring-green-500/30">
                🀄 国产片（仅 ffmpeg 截帧）
              </span>
            ) : null}
            {/* 系列徽章：同 base code 多分集共享元数据 */}
            {seriesBase && seriesMembers && seriesMembers.length > 1 ? (
              <div className="mb-3">
                <div className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30 mb-2">
                  📚 属于系列 {seriesBase}（共 {seriesMembers.length} 部）
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {seriesMembers.map((m) => {
                    const isCur = m.video?.id === video.id
                    return (
                      <button
                        key={m.code}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                          isCur
                            ? 'bg-brand text-white'
                            : 'bg-ink-700 hover:bg-ink-600 text-white/80'
                        }`}
                        onClick={() => {
                          if (!isCur && m.video) onOpenRelated?.(m)
                        }}
                        title={isCur ? '当前分集' : `打开 ${m.code}`}
                      >
                        {m.code}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}
            <div className="text-2xl font-semibold text-white mb-1 break-all">
              {video.title}
            </div>
            {d?.title && d.title !== video.title ? (
              <div className="text-white/50 text-sm mb-2 break-all">{d.title}</div>
            ) : (
              <div className="mb-2" />
            )}

            {/* 我的推荐评分（md 权威，替换 javdb 评分） */}
            {video.rating != null ? (
              <div className="flex items-center gap-2.5 mb-3">
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-brand/15 ring-1 ring-brand/30">
                  <Icon name="star" size={16} className="text-brand fill-brand" />
                  <span className="text-brand font-bold text-xl leading-none tabular-nums">
                    {video.rating.toFixed(2)}
                  </span>
                </span>
                <span className="text-white/40 text-xs">我的推荐评分</span>
              </div>
            ) : null}

            {/* 主 CTA 行：参考大厂设计，播放按钮放在内容区（更突出、离标题/元信息更近），
                顶栏只保留次要操作（分享/补齐/收藏）。同时把"编辑/打开文件位置/删除文件"等
                也放这里作为二级按钮组，避免再返回顶栏。 */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <button
                className="h-11 px-7 rounded-xl flex items-center gap-2.5 bg-brand hover:brightness-110 text-white text-sm font-semibold shadow-lg shadow-brand/40 transition-all"
                onClick={() => onPlay(video)}
              >
                <Icon name="play" size={16} className="fill-current" />
                播放
              </button>
              {onEdit ? (
                <button
                  className="h-11 px-4 rounded-xl flex items-center gap-2 bg-ink-700 hover:bg-ink-600 text-white/90 hover:text-white text-sm transition-colors"
                  onClick={() => onEdit(video)}
                  title="编辑影片信息"
                >
                  <Icon name="pencil" size={14} />
                  编辑
                </button>
              ) : null}
              <button
                className="h-11 px-4 rounded-xl flex items-center gap-2 bg-ink-700 hover:bg-ink-600 text-white/90 hover:text-white text-sm transition-colors"
                onClick={() => void api.shellRevealInFolder(video.path)}
                title="在文件管理器中显示并选中该文件"
              >
                <Icon name="folderOpen" size={14} />
                打开文件位置
              </button>
              {onDelete ? (
                <button
                  className="h-11 px-4 rounded-xl flex items-center gap-2 bg-red-500/10 hover:bg-red-500/25 text-red-300 hover:text-red-200 text-sm transition-colors"
                  onClick={() => onDelete(video)}
                  title="从磁盘删除该视频（可能连带删除所在目录）"
                >
                  <Icon name="trash" size={14} />
                  删除文件
                </button>
              ) : null}
            </div>

            <div className="space-y-1.5 mb-4">
              <MetaRow label="番号" value={d?.code ?? video.title} />
              <MetaRow label="日期" value={d?.date} />
              <MetaRow label="时长" value={d?.duration} />
              <MetaRow label="文件大小" value={video.fileSize ? formatSize(video.fileSize) : undefined} />
              <MetaRow label="参数" value={formatTech(tech)} />
              <MetaRow label="导演" value={d?.director} />
              <MetaRow label="片商">
                {d?.studio ? (
                  <button
                    type="button"
                    onClick={() => onPickFilter?.({ type: 'studio', value: d.studio! })}
                    className="text-brand hover:underline underline-offset-2"
                  >
                    {d.studio}
                  </button>
                ) : undefined}
              </MetaRow>
              <MetaRow label="系列">
                {d?.series ? (
                  <button
                    type="button"
                    onClick={() => onPickFilter?.({ type: 'series', value: d.series! })}
                    className="text-brand hover:underline underline-offset-2"
                  >
                    {d.series}
                  </button>
                ) : undefined}
              </MetaRow>
              {/* javdb 评分仅在没有我的评分时兜底显示 */}
              <MetaRow label="评分" value={video.rating != null ? undefined : d?.rating} />
              {/* 
                朋友 v2.3.2 在此处加了一行 <MetaRow label="类别"> 直接展示 d.genres。
                v2.2.13 文档标签分层改造后：
                - 文档标签（tagCategories 结构化 / tags 平铺）在下方统一「标签」MetaRow 里按 brand 色系分组展示；
                - 数据源 genres 在 store.ts schemaVersion 迁移时已剥离进 backupTags，
                  由下方「标签」MetaRow 的「数据源」分类（sky 色系 + 默认折叠 3 个）统一承载；
                - 朋友这行完全冗余，删除避免两处重复展示 genres + MetaRow label 冲突告警。
              */}
              {(() => {
                const female = d?.actresses?.length ? d.actresses : d?.actors ?? []
                return female.length > 0 ? (
                  <MetaRow label="女演员">
                    <div className="flex flex-wrap gap-1.5 min-w-0">
                      {female.map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => onPickFilter?.({ type: 'actor', value: a })}
                          className="px-2 py-0.5 rounded-md bg-white/6 ring-1 ring-white/5 text-white/75 text-xs hover:bg-brand/20 hover:text-brand hover:ring-brand/30 transition-colors"
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </MetaRow>
                ) : null
              })()}
            </div>

            {/* v2.2.13 文档标签分层：
                有结构化 tagCategories → 按分类分组展示主标签；
                无结构化但有文档平铺 tags → 退化一组展示；
                无文档标签 + 有 backupTags → 直接把数据源 tags 作主标签展示（不在「备用」里折叠）。
                按钮样式：文档主标签用 brand 色系；备用数据源标签（展开后）用 info 色系区分来源。 */}
            {(() => {
              const cats = localVideo.tagCategories
              const primary = primaryTags({ tags: localVideo.tags, tagCategories: cats })
              const backup = localVideo.backupTags ?? []
              const hasDoc = hasDocTags({ tags: localVideo.tags, tagCategories: cats })
              // 主标签节点：按分类分组 / 平铺（结构化 vs 退化）
              const primaryNode = (() => {
                if (cats && Object.keys(cats).length > 0) {
                  // 去重 + 过滤空 tag 字符串 + 过滤非标签分类 + key 加索引后缀
                  const seen = new Set<string>()
                  const dedup: [string, string[]][] = []
                  for (const [name, rawList] of Object.entries(cats)) {
                    if (NON_TAG_CATEGORY_NAMES.has(name.trim())) continue  // 跳过简介/评分等元数据分类
                    const list = (rawList ?? []).map(t => t?.trim() ?? '').filter(Boolean)
                    if (!list.length) continue
                    if (seen.has(name)) continue
                    seen.add(name)
                    dedup.push([name, list])
                  }
                  if (!dedup.length) return null
                  return (
                    <div className="space-y-1.5 min-w-0">
                      {dedup.map(([catName, list], idx) => (
                        <div key={`${catName}_${idx}`} className="flex flex-wrap gap-1.5 min-w-0 items-center">
                          <span className="text-[11px] text-white/40 shrink-0 pr-1 min-w-[3.5rem]">{catName}</span>
                          <div className="flex flex-wrap gap-1.5 min-w-0">
                            {list.map((t) => (
                              <button
                                key={`${catName}:${t}`}
                                type="button"
                                onClick={() => onPickTag?.(t)}
                                title={`「${catName}」类 · 筛选「${t}」全部影片`}
                                className="px-2 py-0.5 rounded-md bg-brand/12 ring-1 ring-brand/20 text-brand text-xs hover:bg-brand/25 hover:ring-brand/40 transition-colors"
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                }
                if (primary.length > 0) {
                  return (
                    <div className="flex flex-wrap gap-1.5 min-w-0">
                      {primary.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => onPickTag?.(t)}
                          title={`筛选「${t}」全部影片（文档平铺）`}
                          className="px-2 py-0.5 rounded-md bg-brand/12 ring-1 ring-brand/20 text-brand text-xs hover:bg-brand/25 hover:ring-brand/40 transition-colors"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  )
                }
                return null
              })()

              // 备用数据源标签节点：
              //  - 有文档标签（即上面展示了主标签）→ 折叠为一行，点开才展开（用户要求的折叠备用展示）
              //  - 无文档标签 → 不作为「备用」折叠，而作主标签直接展示（info 色系标识来源）
              const backupNode = (() => {
                if (!backup.length) return null
                if (!hasDoc) {
                  // 无文档：backupTags 就是主标签
                  return (
                    <div className="flex flex-wrap gap-1.5 min-w-0">
                      {backup.map((t) => (
                        <button
                          key={`b:${t}`}
                          type="button"
                          onClick={() => onPickTag?.(t)}
                          title={`筛选「${t}」全部影片（数据源 genres，无文档标签时作为主展示）`}
                          className="px-2 py-0.5 rounded-md bg-sky-500/12 ring-1 ring-sky-400/20 text-sky-300 text-xs hover:bg-sky-500/25 hover:ring-sky-400/40 transition-colors"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  )
                }
                // 有文档：折叠为一行（默认展示前 3 个 + 展开按钮）
                const shown = showBackupTags ? backup : backup.slice(0, 3)
                return (
                  <div className="mt-0.5 min-w-0">
                    <div className="flex flex-wrap gap-1.5 items-center min-w-0">
                      <span className="text-[11px] text-white/35 shrink-0 pr-1 min-w-[3.5rem]">数据源标签</span>
                      <div className="flex flex-wrap gap-1.5 min-w-0">
                        {shown.map((t) => (
                          <button
                            key={`b:${t}`}
                            type="button"
                            onClick={() => onPickTag?.(t)}
                            title={`筛选「${t}」全部影片（数据源 genres 备用）`}
                            className="px-2 py-0.5 rounded-md bg-sky-500/10 ring-1 ring-sky-400/15 text-sky-300/80 text-[11px] hover:bg-sky-500/20 hover:ring-sky-400/35 transition-colors"
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      {backup.length > 3 && !showBackupTags ? (
                        <button
                          type="button"
                          onClick={() => setShowBackupTags(true)}
                          className="text-[11px] text-white/45 hover:text-white/70 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
                        >
                          还有 {backup.length - 3} 个… · 展开
                        </button>
                      ) : showBackupTags ? (
                        <button
                          type="button"
                          onClick={() => setShowBackupTags(false)}
                          className="text-[11px] text-white/45 hover:text-white/70 px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
                        >
                          收起
                        </button>
                      ) : null}
                    </div>
                    <div className="text-[10px] text-white/30 mt-1">
                      文档片单标签（彩色）是权威分类；数据源抓取的 genres（蓝色）仅作备用参考。
                    </div>
                  </div>
                )
              })()

              if (!primaryNode && !backupNode) return null
              return (
                <MetaRow label="标签">
                  <div className="space-y-1.5 min-w-0">
                    {primaryNode}
                    {backupNode}
                  </div>
                </MetaRow>
              )
            })()}

            {loading ? (
              <div className="mt-4 text-white/40 text-xs">正在抓取 javdb 详情…</div>
            ) : null}
            {error ? <div className="mt-4 text-amber-400 text-xs">{error}</div> : null}

            {/* 文件信息 */}
            <div className="pt-3 border-t border-white/5 space-y-1">
              <div className="text-white/40 text-[11px] mb-1.5 flex items-center gap-1.5">
                <Icon name="info" size={11} className="text-white/30" />
                文件信息
              </div>
              <MetaRow label="文件名" value={video.fileName} />
              {video.addedAt ? (
                <MetaRow label="添加于" value={new Date(video.addedAt).toLocaleString('zh-CN')} />
              ) : null}
              {video.lastPlayedAt ? (
                <MetaRow label="上次播放" value={new Date(video.lastPlayedAt).toLocaleString('zh-CN')} />
              ) : null}
              {video.durationSec ? (
                <MetaRow label="时长" value={`${Math.floor(video.durationSec / 60)} 分 ${Math.round(video.durationSec % 60)} 秒`} />
              ) : null}
              {video.path ? <MetaRow label="完整路径" value={video.path} /> : null}
            </div>
          </div>
        </div>

        {/* 关键截图（来自 javdb）—— 过滤掉陈旧远程 URL（已重抓但还没写回的） */}
        {d?.samples && d.samples.filter(isLocal).length > 0 ? (
          <div>
            <div className="text-white/80 font-medium mb-2">
              关键截图（{d.samples.filter(isLocal).length}）
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {d.samples.filter(isLocal).map((url) => (
                <div
                  key={url}
                  className="aspect-video rounded-lg overflow-hidden bg-ink-800 cursor-zoom-in relative"
                  onMouseEnter={() => {
                    cancelClose()
                    scheduleOpen(url)
                  }}
                  onMouseLeave={clearOpenTimer}
                >
                  <img
                    src={posterUrl(url) ?? ''}
                    alt="sample"
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover poster-img transition-transform duration-300 hover:scale-105"
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* ffmpeg 截帧预览帧（封面外的多张预览，本地 previewPaths）；国产片也走这里 */}
        {localVideo.previewPaths && localVideo.previewPaths.length > 0 ? (
          <div className="mb-6">
            <div className="text-white/80 font-medium mb-2 flex items-center gap-1.5">
              <Icon name="film" size={13} className="text-white/40" />
              预览帧（{localVideo.previewPaths.length}）
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {localVideo.previewPaths.map((url, i) => (
                <div
                  key={url}
                  className="aspect-video rounded-lg overflow-hidden bg-ink-800 cursor-zoom-in relative group/preview"
                  onClick={() => setZoomUrl(url)}
                  title="点击放大预览"
                >
                  <img
                    src={posterUrl(url) ?? ''}
                    alt={`preview-${i}`}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover poster-img"
                  />
                  {/* 设为封面：hover 显示，点击把这帧复制为封面 */}
                  <button
                    type="button"
                    className="absolute bottom-1.5 right-1.5 opacity-0 group-hover/preview:opacity-100 transition-opacity px-2 py-1 rounded-md bg-white/95 text-slate-900 hover:bg-brand hover:text-white text-[11px] font-medium flex items-center gap-1 no-drag shadow-md shadow-black/25"
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleSetPreviewAsCover(url)
                    }}
                    title="用这一帧作为封面"
                  >
                    <Icon name="film" size={10} className="fill-current" />
                    设为封面
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 相关推荐（同片商 / 系列 / 女演员） */}
        {related && related.length > 0 ? (
          <div className="mb-6">
            <div className="text-white/80 font-medium mb-2 flex items-center gap-1.5">
              <Icon name="sparkles" size={13} className="text-brand" />
              相关推荐（同片商 / 系列 / 女演员）
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
              {related.map((r) => {
                const rs = r.video?.posterPath ? posterUrl(r.video.posterPath) : null
                return (
                  <button
                    key={r.code}
                    className="group rounded-lg overflow-hidden bg-ink-800 ring-1 ring-white/5 aspect-[2/3] relative hover:ring-brand/50 transition-colors"
                    onClick={() => onOpenRelated?.(r)}
                    title={r.title}
                  >
                    {rs ? (
                      <img src={rs} alt={r.title} className="h-full w-full object-cover poster-img group-hover:scale-105 transition-transform duration-300" loading="lazy" />
                    ) : (
                      <div
                        className="h-full w-full flex items-center justify-center text-2xl font-bold text-white/70"
                        style={{ background: placeholderGradient(r.code) }}
                      >
                        {titleInitial(r.code)}
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1.5 pb-1 pt-5">
                      <div className="text-[11px] text-white truncate">{r.code}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}

      </div>
      </div>

      {/* hover 样本图时显示原尺寸大图（lightbox） */}
      {zoomUrl ? (
        <div
          ref={overlayRef}
          data-zoom-overlay
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-sm p-6 cursor-zoom-out"
          onMouseMove={(e) => {
            // 实时检测光标是否在图片内：不在（图片外灰色区域）就 scheduleClose
            // 在图片内就 cancelClose（保持大图）
            const img = overlayRef.current?.querySelector('img')
            if (!img) return
            const r = img.getBoundingClientRect()
            const outside =
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            if (outside) scheduleClose()
            else cancelClose()
          }}
          onMouseLeave={scheduleClose}
          onClick={(e) => {
            e.stopPropagation()
            setZoomUrl(null)
          }}
        >
          <img
            src={posterUrl(zoomUrl) ?? ''}
            alt="sample-zoom"
            onClick={(e) => e.stopPropagation()}
            className="max-w-[94vw] max-h-[94vh] object-contain rounded-lg shadow-2xl"
          />
        </div>
      ) : null}
    </div>
  )
}
