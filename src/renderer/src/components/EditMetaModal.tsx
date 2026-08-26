import { useEffect, useRef, useState } from 'react'
import type { Video } from '../../../shared/types'
import { posterUrl, placeholderGradient, titleInitial } from '../lib/util'
import Icon from './Icon'

interface Props {
  video: Video | null
  onClose: () => void
  onSave: (id: string, patch: Partial<Video>) => void
  onFetchJavdb: (id: string) => Promise<Video | null>
}

export default function EditMetaModal({ video, onClose, onSave, onFetchJavdb }: Props) {
  const [title, setTitle] = useState('')
  const [year, setYear] = useState('')
  const [rating, setRating] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [description, setDescription] = useState('')
  const [manualPoster, setManualPoster] = useState('')
  const [javdbPoster, setJavdbPoster] = useState<string | null>(null)
  const [javdbBusy, setJavdbBusy] = useState(false)
  const [saveToast, setSaveToast] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!video) return
    setTitle(video.title)
    setYear(video.year ? String(video.year) : '')
    setRating(video.rating != null ? String(video.rating) : '')
    setTags([...video.tags])
    setTagInput('')
    setDescription(video.description ?? '')
    setManualPoster(video.posterSource === 'manual' ? video.posterPath ?? '' : '')
    setJavdbPoster(video.posterSource === 'javdb' ? video.posterPath ?? null : null)
    setJavdbBusy(false)
    setSaveToast(null)
    // 自动聚焦标题
    setTimeout(() => titleRef.current?.focus(), 50)
  }, [video])

  if (!video) return null

  const previewUrl =
    manualPoster || javdbPoster || video.posterPath
      ? posterUrl(manualPoster || javdbPoster || video.posterPath)
      : null

  function addTag() {
    const v = tagInput.trim()
    if (!v) return
    if (tags.includes(v)) {
      setTagInput('')
      return
    }
    setTags([...tags, v])
    setTagInput('')
  }
  function removeTag(t: string) {
    setTags(tags.filter((x) => x !== t))
  }

  async function handleJavdb() {
    setJavdbBusy(true)
    try {
      const updated = await onFetchJavdb(video!.id)
      if (updated?.posterPath) {
        setManualPoster('')
        setJavdbPoster(updated.posterPath)
      }
    } finally {
      setJavdbBusy(false)
    }
  }

  function handleSave() {
    // 简介与标签以「简介 md 文件」为权威来源，这里不写回，避免被下次对账覆盖
    const patch: Partial<Video> = {
      title: title.trim() || video!.title,
      year: year ? Number(year) : undefined,
      rating: rating ? Number(rating) : undefined,
      tags
    }
    if (manualPoster.trim()) {
      patch.posterPath = manualPoster.trim()
      patch.posterSource = 'manual'
    } else if (javdbPoster) {
      patch.posterPath = javdbPoster
      patch.posterSource = 'javdb'
    }
    onSave(video!.id, patch)
    setSaveToast('已保存')
    setTimeout(() => onClose(), 600)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-ink-900 rounded-2xl w-[920px] max-w-[96vw] max-h-[92vh] overflow-hidden ring-1 ring-white/10 shadow-2xl shadow-black/60 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部标题栏（Notion / Linear 风格：图标 + 标题 + 文件名面包屑） */}
        <div className="relative px-7 py-5 border-b border-white/5 bg-gradient-to-r from-ink-850/80 to-ink-900">
          <div className="flex items-center gap-3 pr-10">
            <div className="w-10 h-10 rounded-xl bg-brand/15 ring-1 ring-brand/30 flex items-center justify-center text-brand">
              <Icon name="pencil" size={17} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-white font-semibold text-[15px] tracking-tight">编辑影片信息</div>
              <div className="text-white/40 text-xs mt-0.5 truncate flex items-center gap-1.5">
                <Icon name="film" size={11} />
                {video.fileName}
              </div>
            </div>
          </div>
          <button
            className="absolute top-4 right-4 no-drag w-9 h-9 rounded-lg text-white/50 hover:text-white hover:bg-white/10 ring-1 ring-white/5 flex items-center justify-center transition-all"
            onClick={onClose}
            title="关闭（ESC）"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-auto thin-scroll">
          <div className="grid grid-cols-[220px_1fr]">
            {/* 左侧封面区 - sticky 滚动时固定可见 */}
            <div className="bg-gradient-to-b from-ink-850/40 to-ink-900/40 border-r border-white/5 p-6">
              <div className="sticky top-0 space-y-4">
                <div className="aspect-[2/3] w-full rounded-xl overflow-hidden bg-ink-800 ring-1 ring-white/10 shadow-2xl shadow-black/40">
                  {previewUrl ? (
                    <img src={previewUrl} alt="poster" className="h-full w-full object-cover poster-img" />
                  ) : (
                    <div
                      className="h-full w-full flex items-center justify-center text-5xl font-bold text-white/80"
                      style={{ background: placeholderGradient(title || video.fileName) }}
                    >
                      {titleInitial(title || video.fileName)}
                    </div>
                  )}
                </div>
                <button
                  className="no-drag w-full px-3.5 py-2.5 rounded-lg bg-brand/90 hover:bg-brand text-white text-sm font-medium disabled:opacity-50 transition-all shadow-md shadow-brand/20"
                  onClick={handleJavdb}
                  disabled={javdbBusy}
                >
                  {javdbBusy ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                      抓取中…
                    </span>
                  ) : '从 JavDB 获取封面'}
                </button>
                {javdbPoster ? (
                  <div className="inline-flex items-center justify-center gap-1 w-full text-emerald-400 text-[11px] font-medium">
                    ✓ 已从 JavDB 抓取
                  </div>
                ) : null}
                <div className="pt-4 border-t border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-1 h-3 rounded-full bg-brand" />
                    <div className="text-white/70 text-[12px] font-medium">自定义封面</div>
                  </div>
                  <input
                    className="w-full bg-ink-800/60 text-white text-xs rounded-lg px-3 py-2 outline-none focus:ring-2 ring-brand/40 focus:bg-ink-800 transition-all border border-white/5 placeholder-white/30"
                    placeholder="D:\posters\foo.jpg"
                    value={manualPoster}
                    onChange={(e) => setManualPoster(e.target.value)}
                  />
                  <div className="text-white/35 text-[10px] mt-1.5 leading-relaxed">
                    指定后优先于 JavDB 抓取
                  </div>
                </div>
              </div>
            </div>

            {/* 右侧表单（大厂风格：更大 padding、focus 边框发光） */}
            <div className="px-7 py-6 space-y-5">
              <FieldGroup label="标题">
                <input
                  ref={titleRef}
                  className="w-full bg-ink-800/60 text-white text-sm rounded-lg px-3.5 py-2.5 outline-none focus:ring-2 ring-brand/50 focus:bg-ink-800 transition-all border border-white/5 focus:border-brand/40"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
              </FieldGroup>

              <div className="grid grid-cols-2 gap-4">
                <FieldGroup label="年份">
                  <input
                    className="w-full bg-ink-800/60 text-white text-sm rounded-lg px-3.5 py-2.5 outline-none focus:ring-2 ring-brand/50 focus:bg-ink-800 transition-all border border-white/5 focus:border-brand/40"
                    value={year}
                    inputMode="numeric"
                    onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))}
                    placeholder="2024"
                  />
                </FieldGroup>
                <FieldGroup label="我的评分" hint="0 - 10">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-brand font-bold">
                      ★
                    </span>
                    <input
                      className="w-full bg-ink-800/60 text-white text-sm rounded-lg pl-9 pr-3.5 py-2.5 outline-none focus:ring-2 ring-brand/50 focus:bg-ink-800 transition-all border border-white/5 focus:border-brand/40"
                      value={rating}
                      inputMode="decimal"
                      onChange={(e) => setRating(e.target.value.replace(/[^\d.]/g, ''))}
                      placeholder="9.60"
                    />
                  </div>
                </FieldGroup>
              </div>

              <FieldGroup
                label="标签"
                hint={tags.length > 0 ? `${tags.length} 个 · 回车或逗号添加` : '回车或逗号添加'}
              >
                <div className="bg-ink-800/60 rounded-lg px-2.5 py-2 min-h-[44px] focus-within:ring-2 ring-brand/50 focus-within:bg-ink-800 transition-all border border-white/5 focus-within:border-brand/40">
                  <div className="flex flex-wrap gap-1.5 mb-1">
                    {tags.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-md bg-brand/15 text-brand text-xs font-medium ring-1 ring-brand/20"
                      >
                        {t}
                        <button
                          onClick={() => removeTag(t)}
                          className="hover:bg-brand/30 hover:text-white w-4 h-4 rounded flex items-center justify-center text-brand/70 transition-colors"
                          title="移除"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                  <input
                    className="w-full bg-transparent text-white text-sm outline-none placeholder-white/30"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault()
                        addTag()
                      } else if (e.key === 'Backspace' && !tagInput && tags.length) {
                        setTags(tags.slice(0, -1))
                      }
                    }}
                    placeholder={tags.length ? '' : '例如：剧情、收藏、片商…'}
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                label="简介"
                hint={`${description.length} 字 · 简介 md 优先，本地编辑可叠加`}
              >
                <textarea
                  className="w-full bg-ink-800/60 text-white/95 text-[13px] rounded-lg px-3.5 py-3 outline-none focus:ring-2 ring-brand/50 focus:bg-ink-800 transition-all border border-white/5 focus:border-brand/40 resize-none leading-relaxed"
                  rows={7}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="暂无简介（可在简介 md 中补充）"
                />
              </FieldGroup>
            </div>
          </div>
        </div>

        {/* 底部操作栏（与内容主体明确分离，提示更紧凑） */}
        <div className="flex items-center justify-between gap-3 px-7 py-4 border-t border-white/5 bg-ink-900/60">
          <div className="flex items-center gap-1.5 text-xs text-white/40">
            <Icon name="info" size={12} className="shrink-0" />
            <span>
              简介 md <span className="text-white/60">优先于</span> 本地编辑
            </span>
          </div>
          <div className="flex items-center gap-2">
            {saveToast ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-400 text-xs">
                ✓ {saveToast}
              </span>
            ) : null}
            <button
              className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-white/80 text-sm transition-colors border border-white/5"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="px-5 py-2 rounded-lg bg-brand hover:brightness-110 text-white text-sm font-semibold transition-all shadow-md shadow-brand/30"
              onClick={handleSave}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FieldGroup({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="text-white/80 text-xs font-medium">{label}</div>
        {hint ? <div className="text-white/30 text-[10px]">{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}
