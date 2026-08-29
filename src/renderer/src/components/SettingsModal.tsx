import { useEffect, useState, type ReactNode } from 'react'
import type { Settings, ProxyMode, SortKey } from '../../../shared/types'
import type { UpdateCheckResult } from '../../../shared/api-types'
import { api } from '../lib/api'
import Icon from './Icon'
import type { IconName } from './Icon'

interface Props {
  open: boolean
  settings: Settings
  onClose: () => void
  onSave: (patch: Partial<Settings>) => void
  /** 隐私锁等操作直接走主进程后，用于刷新外部 settings 状态 */
  onSaved?: () => void
}

type Category =
  | 'general'
  | 'network'
  | 'appearance'
  | 'privacy'
  | 'storage'
  | 'update'
  | 'danger'

const CATEGORIES: { id: Category; label: string; icon: IconName }[] = [
  { id: 'general', label: '通用', icon: 'sliders' },
  { id: 'network', label: '网络', icon: 'globe' },
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'privacy', label: '隐私与安全', icon: 'shield' },
  { id: 'storage', label: '数据与存储', icon: 'database' },
  { id: 'update', label: '更新', icon: 'refresh' },
  { id: 'danger', label: '危险操作', icon: 'alert' }
]

const PROXY_MODES: { value: ProxyMode; label: string }[] = [
  { value: 'none', label: '关闭（直连）' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' },
  { value: 'system', label: '系统代理（自动）' }
]

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'title', label: '标题（A→Z）' },
  { value: 'added', label: '最近添加' },
  { value: 'lastPlayed', label: '最近播放' },
  { value: 'score', label: '评分' },
  { value: 'year', label: '年份' },
  { value: 'random', label: '随机' }
]

/** 把旧版单一 javdbProxy 字符串迁移到新的多协议代理结构，并对数值兜底 */
function normalizeProxy(s: Settings): Settings {
  const anyS = s as Settings & { javdbProxy?: string }
  let next: Settings = { ...s }
  if (!next.proxyMode) {
    const raw = anyS.javdbProxy
    if (raw) {
      try {
        const u = new URL(raw)
        next = {
          ...next,
          proxyMode: (u.protocol.replace(':', '') === 'https' ? 'https' : 'http') as ProxyMode,
          proxyHost: u.hostname,
          proxyPort: u.port,
          proxyUser: decodeURIComponent(u.username || ''),
          proxyPass: decodeURIComponent(u.password || '')
        }
      } catch {
        next = { ...next, proxyMode: 'none' }
      }
    } else {
      next = { ...next, proxyMode: 'none' }
    }
  }
  return {
    ...next,
    proxyHost: next.proxyHost ?? '',
    proxyPort: next.proxyPort ?? '',
    proxyUser: next.proxyUser ?? '',
    proxyPass: next.proxyPass ?? '',
    fetchConcurrency: Number(next.fetchConcurrency) || 2,
    fetchIntervalMs: Number(next.fetchIntervalMs) || 600,
    autoRescan: !!next.autoRescan,
    dataSource: next.dataSource ?? 'auto'
  }
}

function formatBytes(n?: number): string {
  if (n == null || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function urgencyMeta(u?: UpdateCheckResult['urgency']) {
  switch (u) {
    case 'mandatory':
      return { label: '强制更新', color: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/30', icon: 'alert' as IconName }
    case 'critical':
      return { label: '重要更新', color: 'text-amber-400', bg: 'bg-amber-500/15', border: 'border-amber-500/30', icon: 'alert' as IconName }
    case 'recommended':
      return { label: '推荐更新', color: 'text-sky-400', bg: 'bg-sky-500/15', border: 'border-sky-500/30', icon: 'info' as IconName }
    default:
      return { label: '普通更新', color: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', icon: 'check' as IconName }
  }
}

/* ---------------- UI primitives ---------------- */

function SidebarItem({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean
  icon: IconName
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
        active
          ? 'bg-brand/15 text-brand'
          : 'text-white/55 hover:text-white hover:bg-white/5'
      }`}
    >
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </button>
  )
}

function SectionHeader({
  icon,
  title,
  description
}: {
  icon: IconName
  title: string
  description?: string
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-1">
        <Icon name={icon} size={18} className="text-brand" />
        <h2 className="text-white text-lg font-semibold">{title}</h2>
      </div>
      {description ? <p className="text-white/45 text-sm">{description}</p> : null}
    </div>
  )
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-ink-850/30 border border-white/5 rounded-xl p-4 mb-5 ${className}`}>
      {children}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <label className="block text-white/80 text-sm mb-1.5">{label}</label>
      {children}
      {hint ? <div className="text-white/40 text-xs mt-1.5 leading-relaxed">{hint}</div> : null}
    </div>
  )
}

function FieldRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b border-white/5 last:border-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-white/90 text-sm">{label}</div>
        {hint ? <div className="text-white/40 text-xs mt-0.5">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-200 ${
        on ? 'bg-brand' : 'bg-ink-600'
      }`}
      title={on ? '已开启' : '已关闭'}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          on ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex p-1 bg-ink-900/50 border border-white/10 rounded-lg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded-md text-sm transition-all ${
            value === o.value
              ? 'bg-ink-700 text-white shadow-sm'
              : 'text-white/50 hover:text-white/80'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Select<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="relative">
      <select
        className="w-full appearance-none bg-ink-900/50 border border-white/10 rounded-lg pl-3 pr-9 py-2 text-sm text-white focus:outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40 transition-colors cursor-pointer"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40">
        <Icon name="chevronDown" size={14} />
      </div>
    </div>
  )
}

/* ---------------- theme preview card ---------------- */

type ThemeOption = { value: Settings['theme']; label: string; tagline: string }

const THEME_OPTIONS: ThemeOption[] = [
  { value: 'cinema', label: '深邃影院', tagline: '沉静的蓝黑电影感' },
  { value: 'light', label: '现代明亮', tagline: '清爽的浅色界面' },
  { value: 'magazine', label: '杂志艺术', tagline: '衬线排版与暖调强调' },
  { value: 'glass', label: '玻璃拟态', tagline: '半透明毛玻璃霓虹' },
  { value: 'system', label: '跟随系统', tagline: '自动适配系统明暗' }
]

function ThemePreview({ theme }: { theme: Settings['theme'] }) {
  const previews: Record<Settings['theme'], ReactNode> = {
    cinema: (
      <div
        className="w-full h-full rounded-t-lg overflow-hidden relative"
        style={{
          background: 'radial-gradient(1200px 800px at 20% -10%, #1b2a45 0%, #0a0c12 60%)'
        }}
      >
        <div className="absolute top-2 left-3 right-3 h-2 rounded-full bg-white/8" />
        <div className="absolute top-6 left-3 w-10 h-12 rounded bg-white/10 border border-white/5" />
        <div className="absolute top-6 left-[54px] w-10 h-12 rounded bg-white/10 border border-white/5" />
        <div className="absolute bottom-2 right-3 w-5 h-5 rounded-full bg-[rgb(251,114,153)]/40" />
      </div>
    ),
    light: (
      <div
        className="w-full h-full rounded-t-lg overflow-hidden relative"
        style={{ background: 'radial-gradient(1200px 800px at 20% -10%, #ffffff 0%, #f2f4f8 65%)' }}
      >
        <div className="absolute top-2 left-3 right-3 h-2 rounded-full bg-black/6" />
        <div className="absolute top-6 left-3 w-10 h-12 rounded bg-white border border-black/6 shadow-sm" />
        <div className="absolute top-6 left-[54px] w-10 h-12 rounded bg-white border border-black/6 shadow-sm" />
        <div className="absolute bottom-2 right-3 w-5 h-5 rounded-full bg-[rgb(236,72,127)]/25" />
      </div>
    ),
    magazine: (
      <div
        className="w-full h-full rounded-t-lg overflow-hidden relative"
        style={{ background: 'radial-gradient(1100px 700px at 85% -12%, #4a1a2e 0%, #110c0e 55%)' }}
      >
        <div className="absolute top-2 left-3 right-3 h-2 rounded-full bg-white/8" />
        <div className="absolute top-6 left-3 w-10 h-12 rounded-sm bg-white/8 border border-white/5" />
        <div className="absolute top-6 left-[54px] w-10 h-12 rounded-sm bg-white/8 border border-white/5" />
        <div className="absolute top-1/2 left-[54px] w-[1px] h-6 bg-[rgb(251,114,153)]" />
        <div className="absolute bottom-2 right-3 w-5 h-5 rounded-full bg-[rgb(251,114,153)]/40" />
      </div>
    ),
    glass: (
      <div
        className="w-full h-full rounded-t-lg overflow-hidden relative"
        style={{ background: 'radial-gradient(1200px 900px at 25% -10%, #3d2e6e 0%, #1a1830 45%, #0b0c14 100%)' }}
      >
        <div className="absolute top-2 left-3 right-3 h-2 rounded-full bg-white/8 backdrop-blur-sm" />
        <div className="absolute top-6 left-3 w-10 h-12 rounded-[10px] bg-white/10 border border-white/15 backdrop-blur-md" />
        <div className="absolute top-6 left-[54px] w-10 h-12 rounded-[10px] bg-white/10 border border-white/15 backdrop-blur-md" />
        <div className="absolute bottom-2 right-3 w-5 h-5 rounded-full bg-[rgb(167,139,250)]/40" />
      </div>
    ),
    system: (
      <div className="w-full h-full rounded-t-lg overflow-hidden relative flex">
        <div
          className="w-1/2 h-full relative"
          style={{ background: 'radial-gradient(1200px 800px at 20% -10%, #ffffff 0%, #f2f4f8 65%)' }}
        >
          <div className="absolute top-2 left-2 right-1 h-2 rounded-full bg-black/6" />
          <div className="absolute top-6 left-2 w-7 h-9 rounded bg-white border border-black/6 shadow-sm" />
        </div>
        <div
          className="w-1/2 h-full relative"
          style={{
            background: 'radial-gradient(1200px 800px at 20% -10%, #1b2a45 0%, #0a0c12 60%)'
          }}
        >
          <div className="absolute top-2 left-1 right-2 h-2 rounded-full bg-white/8" />
          <div className="absolute top-6 right-2 w-7 h-9 rounded bg-white/10 border border-white/5" />
        </div>
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded bg-black/70 text-white text-[8px] font-medium">
          Auto
        </div>
      </div>
    )
  }
  return previews[theme]
}

function ThemeCard({
  option,
  selected,
  onClick
}: {
  option: ThemeOption
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative w-full text-left rounded-xl border overflow-hidden transition-all cursor-pointer ${
        selected
          ? 'ring-2 ring-brand border-brand/60 bg-ink-800'
          : 'border-white/10 bg-ink-850/30 hover:border-white/25 hover:bg-ink-800/50'
      }`}
    >
      <div className="h-24 w-full">
        <ThemePreview theme={option.value} />
      </div>
      <div className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-white/90 text-sm font-medium">{option.label}</span>
          {selected ? (
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand text-white">
              <Icon name="check" size={12} />
            </span>
          ) : (
            <span className="w-5 h-5 rounded-full border border-white/20 group-hover:border-white/40" />
          )}
        </div>
        <p className="text-white/40 text-xs mt-0.5">{option.tagline}</p>
      </div>
    </button>
  )
}

/* ---------------- main component ---------------- */

export default function SettingsModal({ open, settings, onClose, onSave, onSaved }: Props) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [activeCategory, setActiveCategory] = useState<Category>('general')
  const [dataDir, setDataDir] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [clearMsg, setClearMsg] = useState('')
  const [ffmpegStatus, setFfmpegStatus] = useState<{
    source: 'custom' | 'system' | 'bundled' | 'missing'
    path?: string
    bundledRemoved?: boolean
    note?: string
  } | null>(null)
  const [ffmpegChecking, setFfmpegChecking] = useState(false)
  const [showFfmpegTutorial, setShowFfmpegTutorial] = useState(false)
  const [lockPwd, setLockPwd] = useState('')
  const [lockPwd2, setLockPwd2] = useState('')
  const [lockMsg, setLockMsg] = useState('')
  const [updateRes, setUpdateRes] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (open) setUpdateRes(null)
  }, [open])

  useEffect(() => {
    if (open) {
      const t = settings.theme as string
      const base: Settings = {
        ...settings,
        theme: (t === 'dark' ? 'cinema' : t === 'light' ? 'light' : t) as Settings['theme'],
        posterDensity: (settings.posterDensity ?? 'standard') as Settings['posterDensity']
      }
      setDraft(normalizeProxy(base))
      setActiveCategory('general')
      setTestResult(null)
      setClearMsg('')
      void api.appInfo().then((i) => { setDataDir(i.dataDir); setAppVersion(i.version) })
      setFfmpegChecking(true)
      api
        .ffmpegStatus()
        .then(setFfmpegStatus)
        .catch(() => setFfmpegStatus({ source: 'missing' }))
        .finally(() => setFfmpegChecking(false))
    }
  }, [open, settings])

  if (!open) return null

  const inputCls =
    'w-full bg-ink-900/50 text-white text-sm rounded-lg px-3 py-2 outline-none border border-white/10 focus:border-brand/60 focus:ring-1 focus:ring-brand/40 transition-colors placeholder:text-white/25'
  const needHost =
    draft.proxyMode === 'http' ||
    draft.proxyMode === 'https' ||
    draft.proxyMode === 'socks4' ||
    draft.proxyMode === 'socks5'
  const needAuth = needHost

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.proxyTest(draft)
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: String(e).slice(0, 200) })
    } finally {
      setTesting(false)
    }
  }

  const clearCache = async () => {
    if (!window.confirm('确认清空海报缓存？已下载的封面会删除，下次打开重新抓取。')) return
    const r = await api.cacheClear()
    setClearMsg(r.ok ? `已清理 ${r.removed} 个缓存文件` : '清理失败')
  }

  const checkFfmpeg = () => {
    setFfmpegChecking(true)
    api
      .ffmpegStatus()
      .then(setFfmpegStatus)
      .catch(() => setFfmpegStatus({ source: 'missing' }))
      .finally(() => setFfmpegChecking(false))
  }

  const checkUpdate = async () => {
    setChecking(true)
    try {
      const r = await api.updateCheck()
      setUpdateRes(r)
    } catch {
      setUpdateRes({
        source: draft.updateSource ?? 'gitee',
        currentVersion: '',
        latestVersion: '',
        hasUpdate: false,
        releaseUrl: '',
        error: '检查更新失败'
      })
    } finally {
      setChecking(false)
    }
  }

  /** 切换检查更新源并立即重试（源切换立即保存，主进程按已保存的源检查） */
  const switchSourceAndRetry = async () => {
    const next: 'github' | 'gitee' = (draft.updateSource ?? 'gitee') === 'gitee' ? 'github' : 'gitee'
    setDraft({ ...draft, updateSource: next })
    try {
      await api.settingsSet({ updateSource: next })
    } catch {
      /* 保存失败也照常重试 */
    }
    await checkUpdate()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-ink-800 rounded-2xl w-[900px] max-w-[94vw] h-[84vh] max-h-[760px] overflow-hidden shadow-2xl flex animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ---------------- sidebar ---------------- */}
        <aside className="w-[210px] flex-shrink-0 border-r border-white/5 bg-ink-850/30 flex flex-col">
          <div className="flex items-center px-4 py-4 border-b border-white/5">
            <span className="text-white font-semibold text-base">设置</span>
          </div>
          <nav className="flex-1 overflow-y-auto p-3 space-y-1">
            {CATEGORIES.map((c) => (
              <SidebarItem
                key={c.id}
                active={activeCategory === c.id}
                icon={c.icon}
                label={c.label}
                onClick={() => setActiveCategory(c.id)}
              />
            ))}
          </nav>
        </aside>

        {/* ---------------- content ---------------- */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-white/90 font-semibold text-base">
                {CATEGORIES.find((c) => c.id === activeCategory)?.label}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="关闭"
            >
              <Icon name="x" size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
            {/* ===== 通用 ===== */}
            {activeCategory === 'general' && (
              <section className="animate-fadeIn">
                <SectionHeader icon="sliders" title="通用" description="播放器、ffmpeg 与启动行为" />

                <Card>
                  <Field
                    label="外部播放器路径"
                    hint="留空则使用系统默认程序打开。可填写 VLC / PotPlayer / mpv 等 exe 路径。"
                  >
                    <input
                      className={inputCls}
                      placeholder="例如 C:\\Program Files\\VideoLAN\\VLC\\vlc.exe"
                      value={draft.playerPath ?? ''}
                      onChange={(e) => setDraft({ ...draft, playerPath: e.target.value })}
                    />
                  </Field>
                </Card>

                <Card>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Icon name="film" size={16} className="text-white/70" />
                      <span className="text-white/90 text-sm font-medium">ffmpeg 运行环境</span>
                    </div>
                    <button
                      type="button"
                      className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-xs transition-colors cursor-pointer disabled:opacity-50"
                      onClick={checkFfmpeg}
                      disabled={ffmpegChecking}
                    >
                      {ffmpegChecking ? '检测中…' : '重新检测'}
                    </button>
                  </div>

                  {ffmpegStatus ? (
                    <div className="mb-4 flex items-start gap-2 text-xs leading-relaxed">
                      <span
                        className={`shrink-0 mt-0.5 px-2 py-0.5 rounded-md font-medium ${
                          ffmpegStatus.source === 'missing'
                            ? 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30'
                            : ffmpegStatus.source === 'bundled'
                              ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30'
                              : 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                        }`}
                      >
                        {ffmpegStatus.source === 'custom'
                          ? '手动指定'
                          : ffmpegStatus.source === 'system'
                            ? '系统 ffmpeg'
                            : ffmpegStatus.source === 'bundled'
                              ? '内置捆绑版'
                              : '未检测到'}
                      </span>
                      <span className="text-white/60">
                        {ffmpegStatus.source === 'missing'
                          ? ffmpegStatus.note ?? '未检测到 ffmpeg'
                          : `当前使用：${ffmpegStatus.path}`}
                        {ffmpegStatus.bundledRemoved ? (
                          <span className="text-emerald-400/80">（已删除捆绑版，释放 62MB）</span>
                        ) : null}
                      </span>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="text-brand/90 hover:text-brand text-xs mb-3 flex items-center gap-1 cursor-pointer"
                    onClick={() => setShowFfmpegTutorial((v) => !v)}
                  >
                    <Icon name={showFfmpegTutorial ? 'chevronDown' : 'chevronRight'} size={12} />
                    如何安装 / 配置 ffmpeg（新电脑推荐）
                  </button>

                  {showFfmpegTutorial ? (
                    <div className="mb-4 rounded-lg bg-black/25 border border-white/5 p-3 text-[12px] text-white/60 leading-relaxed space-y-2">
                      <div className="flex items-start gap-2">
                        <span className="text-brand font-semibold shrink-0">①</span>
                        <span>
                          本应用已<b className="text-white/80">捆绑内置 ffmpeg</b>（约 62MB），新电脑装完即可用视频封面截帧，无需任何操作。
                        </span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-brand font-semibold shrink-0">②</span>
                        <span>
                          若你的电脑<b className="text-white/80">已装 ffmpeg</b>（PATH 或常见目录可检测到），应用会自动<b className="text-white/80">完全复用系统版</b>，并删除捆绑版释放磁盘。
                        </span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-brand font-semibold shrink-0">③</span>
                        <span>
                          如需<b className="text-white/80">手动指定</b>：下载 gyan.dev 的
                          <span className="text-white/80"> ffmpeg-release-essentials.zip </span>
                          → 解压到任意目录 → 在下方填入
                          <span className="text-white/80"> bin\ffmpeg.exe </span>
                          的完整路径。手动指定优先于系统与捆绑版。
                        </span>
                      </div>
                    </div>
                  ) : null}

                  <Field
                    label="ffmpeg 路径（可选）"
                    hint="留空则按：系统 ffmpeg → 内置捆绑版 顺序自动查找。"
                  >
                    <input
                      className={inputCls}
                      placeholder="例如 D:\\tools\\ffmpeg\\bin\\ffmpeg.exe"
                      value={draft.ffmpegPath ?? ''}
                      onChange={(e) => setDraft({ ...draft, ffmpegPath: e.target.value })}
                    />
                  </Field>
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="zap" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">启动行为</div>
                  </div>
                  <div className="text-white/40 text-xs mb-2">配置影匣如何随系统启动与关闭</div>
                  <FieldRow label="开机自启" hint="随系统启动自动运行影匣">
                    <Toggle on={!!draft.launchAtLogin} onChange={(v) => setDraft({ ...draft, launchAtLogin: v })} />
                  </FieldRow>
                  <FieldRow label="启动时自动对账" hint="打开应用后自动扫描当前库">
                    <Toggle on={!!draft.scanOnStartup} onChange={(v) => setDraft({ ...draft, scanOnStartup: v })} />
                  </FieldRow>
                  <FieldRow label="最小化到托盘" hint="关闭窗口时最小化到系统托盘，不退出">
                    <Toggle on={!!draft.minimizeToTray} onChange={(v) => setDraft({ ...draft, minimizeToTray: v })} />
                  </FieldRow>
                </Card>
              </section>
            )}

            {/* ===== 网络 ===== */}
            {activeCategory === 'network' && (
              <section className="animate-fadeIn">
                <SectionHeader icon="globe" title="网络" description="代理、数据源与 JavDB 抓取参数" />

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="globe" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">代理设置</div>
                  </div>
                  <div className="text-white/40 text-xs mb-4">配置访问 JavDB / JavBus 时使用的网络代理</div>

                  <Field label="代理模式">
                    <Select
                      value={draft.proxyMode ?? 'none'}
                      options={PROXY_MODES}
                      onChange={(v) => setDraft({ ...draft, proxyMode: v as ProxyMode })}
                    />
                  </Field>

                  {needHost ? (
                    <div className="flex gap-3 mb-4">
                      <div className="flex-[2]">
                        <label className="block text-white/60 text-xs mb-1.5">主机</label>
                        <input
                          className={inputCls}
                          placeholder="127.0.0.1"
                          value={draft.proxyHost}
                          onChange={(e) => setDraft({ ...draft, proxyHost: e.target.value })}
                        />
                      </div>
                      <div className="w-28">
                        <label className="block text-white/60 text-xs mb-1.5">端口</label>
                        <input
                          className={inputCls}
                          placeholder="7890"
                          value={draft.proxyPort}
                          onChange={(e) => setDraft({ ...draft, proxyPort: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : null}

                  {needAuth ? (
                    <div className="flex gap-3 mb-4">
                      <div className="flex-1">
                        <label className="block text-white/60 text-xs mb-1.5">用户名（可选）</label>
                        <input
                          className={inputCls}
                          placeholder="留空则无认证"
                          value={draft.proxyUser}
                          onChange={(e) => setDraft({ ...draft, proxyUser: e.target.value })}
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-white/60 text-xs mb-1.5">密码（可选）</label>
                        <input
                          className={inputCls}
                          type="password"
                          placeholder="留空则无认证"
                          value={draft.proxyPass}
                          onChange={(e) => setDraft({ ...draft, proxyPass: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : null}

                  {draft.proxyMode !== 'none' ? (
                    <div className="flex items-center gap-3">
                      <button
                        className="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm cursor-pointer disabled:opacity-50 transition-colors"
                        onClick={runTest}
                        disabled={testing}
                      >
                        {testing ? '测试中…' : '测试连接'}
                      </button>
                      {testResult ? (
                        <span className={`text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                          {testResult.ok
                            ? `连通成功（HTTP ${testResult.status}）`
                            : `连接失败：${testResult.error ?? '未知错误'}`}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {draft.proxyMode === 'system' ? (
                    <div className="text-white/40 text-xs mt-3">
                      自动读取系统代理（HTTP_PROXY / HTTPS_PROXY 环境变量）。
                    </div>
                  ) : null}
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="cookie" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">JavDB Cookie</div>
                  </div>
                  <Field
                    label="Cookie（可选）"
                    hint="抓取 javdb.com 封面时附带。一般网络留空即可；若搜索被要求登录，可在浏览器登录 javdb.com 后复制 Cookie 填入。"
                  >
                    <input
                      className={inputCls}
                      placeholder="留空即可；格式如 token=xxx; ..."
                      value={draft.javdbCookie ?? ''}
                      onChange={(e) => setDraft({ ...draft, javdbCookie: e.target.value })}
                    />
                  </Field>
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="database" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">数据源</div>
                  </div>
                  <div className="text-white/40 text-xs mb-3">auto 自动降级（JavDB → JavBus → JavLibrary，连续失败自动切换）；手动指定可单独调试某个源。</div>
                  <SegmentedControl
                    value={draft.dataSource ?? 'auto'}
                    options={[
                      { value: 'auto', label: '自动' },
                      { value: 'javdb', label: 'JavDB' },
                      { value: 'javbus', label: 'JavBus' },
                      { value: 'javlibrary', label: 'JavLibrary' }
                    ]}
                    onChange={(v) => setDraft({ ...draft, dataSource: v as 'auto' | 'javdb' | 'javbus' | 'javlibrary' })}
                  />
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="download" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">JavDB 批量抓取</div>
                  </div>
                  <div className="text-white/40 text-xs mb-3">并发越高抓取越快，但更易触发 javdb 风控；间隔用于限速兜底。</div>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block text-white/60 text-xs mb-1.5">并发数（1-8）</label>
                      <input
                        className={inputCls}
                        type="number"
                        min={1}
                        max={8}
                        value={draft.fetchConcurrency}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            fetchConcurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1))
                          })
                        }
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-white/60 text-xs mb-1.5">间隔（毫秒）</label>
                      <input
                        className={inputCls}
                        type="number"
                        min={0}
                        step={100}
                        value={draft.fetchIntervalMs}
                        onChange={(e) =>
                          setDraft({ ...draft, fetchIntervalMs: Math.max(0, Number(e.target.value) || 0) })
                        }
                      />
                    </div>
                  </div>
                </Card>
              </section>
            )}

            {/* ===== 外观 ===== */}
            {activeCategory === 'appearance' && (
              <section className="animate-fadeIn">
                <SectionHeader icon="palette" title="外观" description="主题、海报墙密度与默认排序" />

                <Card>
                  <div className="text-white/90 text-sm font-medium mb-1">皮肤</div>
                  <div className="text-white/40 text-xs mb-3">选择影匣的整体视觉风格，应用后会立即生效</div>
                  <div className="grid grid-cols-3 gap-3">
                    {THEME_OPTIONS.map((o) => (
                      <ThemeCard
                        key={o.value}
                        option={o}
                        selected={draft.theme === o.value}
                        onClick={() => setDraft({ ...draft, theme: o.value })}
                      />
                    ))}
                  </div>
                </Card>

                <Card>
                  <div className="text-white/90 text-sm font-medium mb-1">海报风格</div>
                  <div className="text-white/40 text-xs mb-3">海报墙单屏显示的视频数量与卡片大小</div>
                  <SegmentedControl
                    value={draft.posterDensity ?? 'standard'}
                    options={[
                      { value: 'large', label: '大图沉浸' },
                      { value: 'standard', label: '标准' },
                      { value: 'compact', label: '高密度' }
                    ]}
                    onChange={(v) => setDraft({ ...draft, posterDensity: v as Settings['posterDensity'] })}
                  />
                </Card>

                <Card>
                  <div className="text-white/90 text-sm font-medium mb-1">默认排序方式</div>
                  <div className="text-white/40 text-xs mb-3">打开库时列表/卡片墙的初始排序</div>
                  <Select
                    value={draft.defaultSort ?? 'added'}
                    options={SORT_OPTIONS}
                    onChange={(v) => setDraft({ ...draft, defaultSort: v as SortKey })}
                  />
                </Card>
              </section>
            )}

            {/* ===== 隐私与安全 ===== */}
            {activeCategory === 'privacy' && (
              <section className="animate-fadeIn">
                <SectionHeader icon="shield" title="隐私与安全" description="访问控制与隐私护盾" />

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="shield" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">隐私护盾</div>
                  </div>
                  <div className="text-white/40 text-xs mb-2">开启后，海报墙与详情页的封面会被模糊打码，防止他人窥视。</div>
                  <FieldRow label="默认开启" hint="开启后应用启动时自动进入隐私模式（海报模糊打码）。">
                    <div className="flex items-center gap-2">
                      <Icon name="shield" size={14} className="text-white/40" />
                      <Toggle
                        on={!!draft.privacyDefaultOn}
                        onChange={(v) => setDraft({ ...draft, privacyDefaultOn: v })}
                      />
                    </div>
                  </FieldRow>
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="lock" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">隐私锁</div>
                  </div>
                  <div className="text-white/40 text-xs mb-3">
                    给软件上锁后，每次打开需输入密码；密码错误 5 次自动退出。密码以 SHA-256 哈希存储，不保存明文。
                  </div>
                  <FieldRow label="当前状态" hint={settings.lockHash ? '已上锁' : '未上锁'}>
                    <span
                      className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                        settings.lockHash ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400'
                      }`}
                    >
                      {settings.lockHash ? '已上锁' : '未上锁'}
                    </span>
                  </FieldRow>
                  <Field label="密码" hint={settings.lockHash ? '输入新密码即修改；留空则解除锁' : '设置你的锁屏密码'}>
                    <input
                      type="password"
                      className={inputCls}
                      placeholder="输入密码"
                      value={lockPwd}
                      onChange={(e) => {
                        setLockPwd(e.target.value)
                        setLockMsg('')
                      }}
                    />
                  </Field>
                  {!settings.lockHash ? (
                    <div className="mb-3">
                      <input
                        type="password"
                        className={inputCls}
                        placeholder="再次输入确认"
                        value={lockPwd2}
                        onChange={(e) => setLockPwd2(e.target.value)}
                      />
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    {settings.lockHash ? (
                      <button
                        type="button"
                        className="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm transition-colors cursor-pointer"
                        onClick={async () => {
                          await api.lockSet(lockPwd)
                          setLockPwd('')
                          setLockMsg(lockPwd ? '已修改密码' : '已解除锁')
                          onSaved?.()
                        }}
                      >
                        {lockPwd ? '修改密码' : '解除锁'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium transition-colors cursor-pointer disabled:opacity-50"
                        disabled={!lockPwd || lockPwd !== lockPwd2}
                        onClick={async () => {
                          await api.lockSet(lockPwd)
                          setLockPwd('')
                          setLockPwd2('')
                          setLockMsg('已设置锁')
                          onSaved?.()
                        }}
                      >
                        设置锁
                      </button>
                    )}
                  </div>
                  {lockMsg ? <div className="text-white/60 text-xs mt-2">{lockMsg}</div> : null}
                </Card>
              </section>
            )}

            {/* ===== 数据与存储 ===== */}
            {activeCategory === 'storage' && (
              <section className="animate-fadeIn">
                <SectionHeader icon="database" title="数据与存储" description="扫描性能、数据目录与缓存" />

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="refresh" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">扫描</div>
                  </div>
                  <FieldRow label="启动时自动重扫" hint="每次打开软件自动对账所有媒体库（MD 驱动）。">
                    <Toggle on={!!draft.autoRescan} onChange={(v) => setDraft({ ...draft, autoRescan: v })} />
                  </FieldRow>
                  <FieldRow label="扫描并发数" hint="扫描库时 ffprobe 探测 / 截帧的并行任务数，越大越快。">
                    <Select
                      value={String(draft.scanConcurrency ?? 2)}
                      options={['1', '2', '3', '4', '6', '8'].map((n) => ({ value: n, label: `${n} 并发` }))}
                      onChange={(v) => setDraft({ ...draft, scanConcurrency: Number(v) })}
                    />
                  </FieldRow>
                  <FieldRow label="跳过小体积文件" hint="扫描时过滤小于该体积（MB）的视频，避免广告样片/短视频混入主列表；0 = 不过滤。">
                    <input
                      className={`${inputCls} w-24`}
                      type="number"
                      min={0}
                      value={draft.scanMinSizeMB ?? 100}
                      onChange={(e) =>
                        setDraft({ ...draft, scanMinSizeMB: Math.max(0, Number(e.target.value) || 0) })
                      }
                    />
                  </FieldRow>
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="folder" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">数据与缓存</div>
                  </div>
                  <div className="text-white/40 text-xs mb-3 break-all">{dataDir || '…'}</div>
                  <div className="flex gap-2">
                    <button
                      className="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm cursor-pointer transition-colors disabled:opacity-50"
                      onClick={() => dataDir && api.openPath(dataDir)}
                      disabled={!dataDir}
                    >
                      打开数据目录
                    </button>
                    <button
                      className="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm cursor-pointer transition-colors"
                      onClick={clearCache}
                    >
                      清理海报缓存
                    </button>
                  </div>
                  {clearMsg ? <div className="text-white/60 text-xs mt-2">{clearMsg}</div> : null}
                </Card>
              </section>
            )}

            {/* ===== 更新 ===== */}
            {activeCategory === 'update' && (
              <section className="animate-fadeIn">
                <SectionHeader icon="refresh" title="更新" description="软件更新、检查源与自动更新频率" />

                {/* 待处理更新横幅：只在 pendingUpdate.version 严格大于当前应用版本时显示，避免升级后残留显示 */}
                {settings.pendingUpdate && appVersion && (() => {
                  const parse = (v: string) => v.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0)
                  const pa = parse(settings.pendingUpdate.version)
                  const ca = parse(appVersion)
                  const n = Math.max(pa.length, ca.length)
                  let newer = false
                  for (let i = 0; i < n; i++) {
                    const x = pa[i] ?? 0
                    const y = ca[i] ?? 0
                    if (x > y) { newer = true; break }
                    if (x < y) { newer = false; break }
                  }
                  return newer
                })() ? (
                  (() => {
                    const meta = urgencyMeta(settings.pendingUpdate.urgency)
                    return (
                      <div className={`mb-5 rounded-xl border p-3.5 flex items-center gap-3 ${meta.bg} ${meta.border}`}>
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${meta.bg}`}>
                          <Icon name={meta.icon} size={18} className={meta.color} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-white text-sm font-medium">发现新版本 v{settings.pendingUpdate.version}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${meta.bg} ${meta.color}`}>{meta.label}</span>
                          </div>
                          <div className="text-white/45 text-[11px] truncate">
                            {settings.pendingUpdate.publishedAt
                              ? `发布于 ${new Date(settings.pendingUpdate.publishedAt).toLocaleDateString('zh-CN')}`
                              : '可前往发布页下载'}
                            {settings.pendingUpdate.assetName
                              ? ` · ${settings.pendingUpdate.assetName}${settings.pendingUpdate.assetSize ? ` (${formatBytes(settings.pendingUpdate.assetSize)})` : ''}`
                              : ''}
                          </div>
                        </div>
                        <button
                          className={`shrink-0 h-8 px-3 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${meta.bg} ${meta.color} hover:brightness-110`}
                          onClick={() => settings.pendingUpdate?.url && api.openExternal(settings.pendingUpdate.url)}
                        >
                          前往下载
                        </button>
                      </div>
                    )
                  })()
                ) : null}

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="refresh" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">手动检查更新</div>
                  </div>
                  <div className="text-white/40 text-xs mb-3">点击立即向所选源查询是否有新版本。自动更新也会按下方频率在后台检测。</div>
                  <div className="flex items-center gap-3">
                    <button
                      className="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
                      onClick={checkUpdate}
                      disabled={checking}
                    >
                      <Icon name="refresh" size={13} className={checking ? 'animate-spin' : ''} />
                      {checking ? '检查中…' : '检查更新'}
                    </button>
                    {updateRes && !updateRes.hasUpdate && !updateRes.error ? (
                      <span className="text-xs text-emerald-400">已是最新版本</span>
                    ) : null}                  </div>
                  {updateRes ? (
                    (() => {
                      const meta = urgencyMeta(updateRes.urgency)
                      // 「已是最新」且无错：按钮旁已显示内联文字，不重复渲染整块
                      if (!updateRes.hasUpdate && !updateRes.error) return null
                      return (
                        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            {updateRes.error ? (
                              <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">检查失败</span>
                            ) : (
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${meta.bg} ${meta.color}`}>{meta.label}</span>
                            )}
                            {!updateRes.error && updateRes.hasUpdate && updateRes.confidence ? (
                              <span className="text-white/35 text-[11px]">
                                判定置信度：
                                {updateRes.confidence === 'full'
                                  ? '完整（版本+安装包均匹配）'
                                  : updateRes.confidence === 'partial'
                                    ? '部分（版本较新但未找到安装包）'
                                    : '无法判定'}
                              </span>
                            ) : null}
                          </div>
                          {updateRes.hasUpdate && !updateRes.error ? (
                            <div className="space-y-1.5 mt-2">
                              <div className="flex items-center gap-2">
                                <span className="text-white text-sm font-medium">v{updateRes.latestVersion}</span>
                                {updateRes.isPrerelease ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">预发布</span>
                                ) : null}
                                {updateRes.isDraft ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">草稿</span>
                                ) : null}
                              </div>
                              {updateRes.publishedAt ? (
                                <div className="text-white/50 text-xs">发布时间：{new Date(updateRes.publishedAt).toLocaleString('zh-CN', { hour12: false })}</div>
                              ) : null}
                              {updateRes.assetMatched && updateRes.asset ? (
                                <div className="text-white/70 text-xs">
                                  匹配资源：{updateRes.asset.name}（{formatBytes(updateRes.asset.size)}）
                                  {updateRes.checksumAsset ? ` · 校验：${updateRes.checksumAsset.name}` : ''}
                                </div>
                              ) : !updateRes.error ? (
                                <div className="text-amber-400/90 text-xs">未找到 Windows 安装包资源，仅版本号较新</div>
                              ) : null}
                              {updateRes.minimumVersion ? (
                                <div className="text-red-400/90 text-xs">最低要求版本：v{updateRes.minimumVersion}（当前 v{updateRes.currentVersion}）</div>
                              ) : null}
                              {updateRes.notes ? (
                                <div className="text-white/40 text-xs line-clamp-3 whitespace-pre-line">{updateRes.notes}</div>
                              ) : null}
                              <div className="flex items-center gap-3 pt-1">
                                {updateRes.asset?.downloadUrl ? (
                                  <button
                                    className="text-brand hover:underline text-xs"
                                    onClick={() => api.openExternal(updateRes.asset!.downloadUrl)}
                                  >
                                    直接下载安装包 →
                                  </button>
                                ) : null}
                                <button
                                  className="text-white/50 hover:text-white/80 hover:underline text-xs"
                                  onClick={() => api.openExternal(updateRes.releaseUrl)}
                                >
                                  查看发布页 →
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {updateRes.error ? (
                            <div className="mt-2 space-y-1.5">
                              <div className="text-red-400/90 text-xs break-all">{updateRes.error}</div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <button
                                  className="px-2 py-1 rounded-md bg-brand/15 hover:bg-brand/30 text-brand text-[11px] font-medium ring-1 ring-brand/30 transition-colors cursor-pointer flex items-center gap-1"
                                  onClick={switchSourceAndRetry}
                                  disabled={checking}
                                >
                                  <Icon name="globe" size={11} />
                                  切换至 {(draft.updateSource ?? 'gitee') === 'gitee' ? 'GitHub' : 'Gitee'} 重试
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {updateRes.fallback && !updateRes.error ? (
                            <div className="text-amber-400/80 text-xs mt-1">
                              首选源不可用，已自动回退到 {updateRes.source === 'gitee' ? 'Gitee' : 'GitHub'} 检查
                            </div>
                          ) : null}
                        </div>
                      )
                    })()
                  ) : null}
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="clock" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">自动更新频率</div>
                  </div>
                  <div className="text-white/40 text-xs mb-3">设置后，影匣会按此频率在启动时（及运行中）自动检测更新；检测到新版本会在此页与「设置」入口提示。</div>
                  <SegmentedControl
                    value={draft.autoUpdateFrequency ?? 'off'}
                    options={[
                      { value: 'off', label: '关闭' },
                      { value: 'daily', label: '每天' },
                      { value: 'weekly', label: '每周' },
                      { value: 'monthly', label: '每月' }
                    ]}
                    onChange={(v) => setDraft({ ...draft, autoUpdateFrequency: v as 'off' | 'daily' | 'weekly' | 'monthly' })}
                  />
                  {draft.autoUpdateFrequency && draft.autoUpdateFrequency !== 'off' && settings.lastUpdateCheck ? (
                    <div className="text-white/35 text-[11px] mt-2">
                      上次自动检测：{new Date(settings.lastUpdateCheck).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                  ) : null}
                </Card>

                <Card>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="globe" size={16} className="text-white/70" />
                    <div className="text-white/90 text-sm font-medium">检查更新源</div>
                  </div>
                  <div className="text-white/40 text-xs mb-3">选择「检查更新」时使用的软件源（GitHub / Gitee）。首选源失败时自动回退到另一源重试；大陆网络建议 Gitee。</div>
                  <SegmentedControl
                    value={draft.updateSource ?? 'gitee'}
                    options={[
                      { value: 'github', label: 'GitHub' },
                      { value: 'gitee', label: 'Gitee' }
                    ]}
                    onChange={(v) => setDraft({ ...draft, updateSource: v as 'github' | 'gitee' })}
                  />
                </Card>
              </section>
            )}

            {/* ===== 危险操作 ===== */}
            {activeCategory === 'danger' && (
              <section className="animate-fadeIn">
                <SectionHeader icon="alert" title="危险操作" description="这些操作不可逆，请谨慎处理" />

                <Card className="border-red-500/20 bg-red-500/[0.04]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-red-400 text-sm font-semibold mb-1">卸载影匣</div>
                      <div className="text-white/40 text-xs leading-relaxed max-w-md">
                        调用系统卸载程序，二次确认后删除应用与全部本地数据（海报缓存、媒体库配置）。此操作无法撤销。
                      </div>
                    </div>
                    <button
                      className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/30 text-red-400 text-xs font-medium ring-1 ring-red-500/30 transition-colors cursor-pointer shrink-0"
                      onClick={async () => {
                        if (!window.confirm('确定要卸载「影匣」吗？卸载后应用及其数据将被移除。')) return
                        if (!window.confirm('再次确认：卸载将删除应用与全部本地数据（海报缓存、媒体库配置）。')) return
                        const r = await api.appUninstall()
                        if (!r.ok) {
                          window.alert(r.error ?? '卸载失败')
                        }
                      }}
                    >
                      <span className="flex items-center gap-1.5">
                        <Icon name="trash" size={14} />
                        卸载影匣
                      </span>
                    </button>
                  </div>
                </Card>
              </section>
            )}
          </div>

          {/* ---------------- footer ---------------- */}
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-white/5 bg-ink-850/20">
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm cursor-pointer transition-colors"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium cursor-pointer transition-colors flex items-center gap-1.5"
              onClick={() => onSave(draft)}
            >
              <Icon name="save" size={15} />
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
