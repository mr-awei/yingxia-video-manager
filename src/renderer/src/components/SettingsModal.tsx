import { useEffect, useState, type ReactNode } from 'react'
import type { Settings, ProxyMode, SortKey } from '../../../shared/types'
import { api } from '../lib/api'

interface Props {
  open: boolean
  settings: Settings
  onClose: () => void
  onSave: (patch: Partial<Settings>) => void
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block mb-4">
      <div className="text-white/80 text-sm mb-1">{label}</div>
      {children}
      {hint ? <div className="text-white/40 text-xs mt-1">{hint}</div> : null}
    </label>
  )
}

function Toggle({
  on,
  onChange
}: {
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${on ? 'bg-brand' : 'bg-ink-600'}`}
      title={on ? '已开启' : '已关闭'}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-4' : 'translate-x-1'}`}
      />
    </button>
  )
}

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

const PROXY_MODES: { value: ProxyMode; label: string }[] = [
  { value: 'none', label: '关闭（直连）' },
  { value: 'http', label: 'HTTP' },
  { value: 'https', label: 'HTTPS' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'socks4', label: 'SOCKS4' },
  { value: 'system', label: '系统代理（自动）' }
]

export default function SettingsModal({ open, settings, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<Settings>(settings)
  const [dataDir, setDataDir] = useState('')
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

  useEffect(() => {
    if (open) {
      // 兼容旧设置值：theme 'dark'/'light' 归一化到新皮肤体系
      const t = settings.theme as string
      const base: Settings = {
        ...settings,
        theme: (t === 'dark' ? 'cinema' : t === 'light' ? 'light' : t) as Settings['theme'],
        posterDensity: (settings.posterDensity ?? 'standard') as Settings['posterDensity']
      }
      setDraft(normalizeProxy(base))
      setTestResult(null)
      setClearMsg('')
      void api.appInfo().then((i) => setDataDir(i.dataDir))
      // ffmpeg 状态检测（系统优先；检测到系统版主进程自动删捆绑版释放磁盘）
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
    'w-full bg-ink-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 ring-brand/50'
  const needHost = draft.proxyMode === 'http' || draft.proxyMode === 'https' || draft.proxyMode === 'socks4' || draft.proxyMode === 'socks5'
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-ink-800 rounded-xl w-[540px] max-w-[92vw] max-h-[88vh] overflow-auto p-5 shadow-card animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white font-semibold text-lg mb-4">设置</div>

        <Field label="外部播放器路径" hint="留空则使用系统默认程序打开。可填写 VLC / PotPlayer / mpv 等 exe 路径。">
          <input
            className={inputCls}
            placeholder="例如 C:\Program Files\VideoLAN\VLC\vlc.exe"
            value={draft.playerPath}
            onChange={(e) => setDraft({ ...draft, playerPath: e.target.value })}
          />
        </Field>

        {/* ---------- ffmpeg 运行环境（状态 + 教程） ---------- */}
        <div className="mb-5 p-3 rounded-lg bg-ink-850/60 border border-white/5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-white/90 text-sm font-semibold">ffmpeg 运行环境</div>
            <button
              type="button"
              className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/70 text-xs transition-colors"
              onClick={() => {
                setFfmpegChecking(true)
                api
                  .ffmpegStatus()
                  .then(setFfmpegStatus)
                  .catch(() => setFfmpegStatus({ source: 'missing' }))
                  .finally(() => setFfmpegChecking(false))
              }}
              disabled={ffmpegChecking}
            >
              {ffmpegChecking ? '检测中…' : '重新检测'}
            </button>
          </div>

          {/* 状态徽标 */}
          {ffmpegStatus ? (
            <div className="mb-3 flex items-start gap-2 text-xs leading-relaxed">
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
                  ? '✓ 手动指定'
                  : ffmpegStatus.source === 'system'
                    ? '✓ 系统 ffmpeg'
                    : ffmpegStatus.source === 'bundled'
                      ? '内置捆绑版'
                      : '✕ 未检测到'}
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

          {/* 教程折叠 */}
          <button
            type="button"
            className="text-brand/90 hover:text-brand text-xs mb-2 flex items-center gap-1"
            onClick={() => setShowFfmpegTutorial((v) => !v)}
          >
            {showFfmpegTutorial ? '▾' : '▸'} 如何安装 / 配置 ffmpeg（新电脑推荐）
          </button>
          {showFfmpegTutorial ? (
            <div className="mb-3 rounded-lg bg-black/25 border border-white/5 p-3 text-[12px] text-white/60 leading-relaxed space-y-2">
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

          <Field label="ffmpeg 路径（可选）" hint="留空则按：系统 ffmpeg → 内置捆绑版 顺序自动查找。">
            <input
              className={inputCls}
              placeholder="例如 D:\tools\ffmpeg\bin\ffmpeg.exe"
              value={draft.ffmpegPath}
              onChange={(e) => setDraft({ ...draft, ffmpegPath: e.target.value })}
            />
          </Field>
        </div>

        {/* ---------- 代理 ---------- */}
        <div className="mb-5 p-3 rounded-lg bg-ink-850/60 border border-white/5">
          <div className="text-white/90 text-sm font-semibold mb-3">代理设置</div>

          <div className="mb-3">
            <div className="text-white/60 text-xs mb-1">代理模式</div>
            <select
              className={inputCls}
              value={draft.proxyMode}
              onChange={(e) => setDraft({ ...draft, proxyMode: e.target.value as ProxyMode })}
            >
              {PROXY_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {needHost ? (
            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <div className="text-white/60 text-xs mb-1">主机</div>
                <input
                  className={inputCls}
                  placeholder="127.0.0.1"
                  value={draft.proxyHost}
                  onChange={(e) => setDraft({ ...draft, proxyHost: e.target.value })}
                />
              </div>
              <div className="w-24">
                <div className="text-white/60 text-xs mb-1">端口</div>
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
            <div className="flex gap-2 mb-3">
              <div className="flex-1">
                <div className="text-white/60 text-xs mb-1">用户名（可选）</div>
                <input
                  className={inputCls}
                  placeholder="留空则无认证"
                  value={draft.proxyUser}
                  onChange={(e) => setDraft({ ...draft, proxyUser: e.target.value })}
                />
              </div>
              <div className="flex-1">
                <div className="text-white/60 text-xs mb-1">密码（可选）</div>
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
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm disabled:opacity-50"
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
            <div className="text-white/40 text-xs mt-2">自动读取系统代理（HTTP_PROXY / HTTPS_PROXY 环境变量）。</div>
          ) : null}
        </div>

        <Field label="JavDB Cookie（可选）" hint="抓取 javdb.com 封面时附带。一般网络留空即可；若搜索被要求登录，可在浏览器登录 javdb.com 后复制 Cookie 填入。">
          <input
            className={inputCls}
            placeholder="留空即可；格式如 token=xxx; ..."
            value={draft.javdbCookie ?? ''}
            onChange={(e) => setDraft({ ...draft, javdbCookie: e.target.value })}
          />
        </Field>

        <Field label="数据源" hint="auto 自动降级（JavDB → JavBus，连续失败自动切换）；手动指定可单独调试某个源。">
          <select
            className={inputCls}
            value={draft.dataSource}
            onChange={(e) => setDraft({ ...draft, dataSource: e.target.value as 'auto' | 'javdb' | 'javbus' })}
          >
            <option value="auto">自动（JavDB → JavBus 降级）</option>
            <option value="javdb">仅 JavDB</option>
            <option value="javbus">仅 JavBus</option>
          </select>
        </Field>

        {/* ---------- 抓取参数 ---------- */}
        <div className="mb-5 p-3 rounded-lg bg-ink-850/60 border border-white/5">
          <div className="text-white/90 text-sm font-semibold mb-3">JavDB 批量抓取</div>
          <div className="flex gap-2">
            <div className="flex-1">
              <div className="text-white/60 text-xs mb-1">并发数（1-8）</div>
              <input
                className={inputCls}
                type="number"
                min={1}
                max={8}
                value={draft.fetchConcurrency}
                onChange={(e) =>
                  setDraft({ ...draft, fetchConcurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })
                }
              />
            </div>
            <div className="flex-1">
              <div className="text-white/60 text-xs mb-1">间隔（毫秒）</div>
              <input
                className={inputCls}
                type="number"
                min={0}
                step={100}
                value={draft.fetchIntervalMs}
                onChange={(e) => setDraft({ ...draft, fetchIntervalMs: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
          </div>
          <div className="text-white/40 text-xs mt-2">并发越高抓取越快，但更易触发 javdb 风控；间隔用于限速兜底。</div>
        </div>

        {/* ---------- 自动重扫 ---------- */}
        <div className="flex items-center justify-between mb-5 p-3 rounded-lg bg-ink-850/60 border border-white/5">
          <div>
            <div className="text-white/80 text-sm">启动时自动重扫</div>
            <div className="text-white/40 text-xs mt-0.5">每次打开软件自动对账所有媒体库（MD 驱动）。</div>
          </div>
          <Toggle on={!!draft.autoRescan} onChange={(v) => setDraft({ ...draft, autoRescan: v })} />
        </div>

        {/* ---------- 数据与缓存 ---------- */}
        <div className="mb-5 p-3 rounded-lg bg-ink-850/60 border border-white/5">
          <div className="text-white/90 text-sm font-semibold mb-3">数据与缓存</div>
          <div className="text-white/60 text-xs mb-2 break-all">数据目录：{dataDir || '…'}</div>
          <div className="flex gap-2">
            <button
              className="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={() => dataDir && api.openPath(dataDir)}
              disabled={!dataDir}
            >
              打开数据目录
            </button>
            <button
              className="px-3 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={clearCache}
            >
              清理海报缓存
            </button>
          </div>
          {clearMsg ? <div className="text-white/60 text-xs mt-2">{clearMsg}</div> : null}
        </div>

        <Field label="皮肤">
          <div className="flex flex-wrap gap-2">
            {([
              ['cinema', '🎬 影院沉浸'],
              ['light', '☀ 现代明亮'],
              ['magazine', '📰 杂志艺术'],
              ['glass', '🫧 玻璃拟态'],
              ['system', '🖥 跟随系统']
            ] as const).map(([t, label]) => (
              <button
                key={t}
                className={`px-3 py-1.5 rounded-lg text-sm ${
                  draft.theme === t ? 'bg-brand text-white' : 'bg-ink-700 text-white/70'
                }`}
                onClick={() => setDraft({ ...draft, theme: t })}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="海报风格">
          <div className="flex gap-2">
            {([
              ['large', '🖼 大图沉浸'],
              ['standard', '▦ 标准'],
              ['compact', '▤ 高密度']
            ] as const).map(([d, label]) => (
              <button
                key={d}
                className={`px-3 py-1.5 rounded-lg text-sm ${
                  draft.posterDensity === d ? 'bg-brand text-white' : 'bg-ink-700 text-white/70'
                }`}
                onClick={() => setDraft({ ...draft, posterDensity: d })}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>

        {/* ---------- 启动行为 ---------- */}
        <div className="mb-5 p-3 rounded-lg bg-ink-850/60 border border-white/5">
          <div className="text-white/90 text-sm font-semibold mb-3">启动行为</div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-white/80 text-sm">开机自启</div>
                <div className="text-white/35 text-xs mt-0.5">随系统启动自动运行影匣</div>
              </div>
              <Toggle on={draft.launchAtLogin} onChange={(v) => setDraft({ ...draft, launchAtLogin: v })} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-white/80 text-sm">启动时自动对账</div>
                <div className="text-white/35 text-xs mt-0.5">打开应用后自动扫描当前库</div>
              </div>
              <Toggle on={draft.scanOnStartup} onChange={(v) => setDraft({ ...draft, scanOnStartup: v })} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-white/80 text-sm">最小化到托盘</div>
                <div className="text-white/35 text-xs mt-0.5">关闭窗口时最小化到系统托盘，不退出</div>
              </div>
              <Toggle on={draft.minimizeToTray} onChange={(v) => setDraft({ ...draft, minimizeToTray: v })} />
            </div>
          </div>
        </div>

        {/* ---------- 浏览与隐私 ---------- */}
        <Field label="默认排序方式" hint="打开库时列表/卡片墙的初始排序。">
          <select
            className={inputCls}
            value={draft.defaultSort}
            onChange={(e) => setDraft({ ...draft, defaultSort: e.target.value as SortKey })}
          >
            <option value="title">标题（A→Z）</option>
            <option value="added">最近添加</option>
            <option value="lastPlayed">最近播放</option>
            <option value="score">评分</option>
            <option value="year">年份</option>
            <option value="random">随机</option>
          </select>
        </Field>

        <Field label="扫描并发数" hint="扫描库时 ffprobe 探测 / 截帧的并行任务数，越大越快。">
          <select
            className={inputCls}
            value={draft.scanConcurrency}
            onChange={(e) => setDraft({ ...draft, scanConcurrency: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n} 并发
              </option>
            ))}
          </select>
        </Field>

        <Field label="隐私护盾默认开启" hint="开启后应用启动时自动进入隐私模式（海报模糊打码）。">
          <Toggle on={draft.privacyDefaultOn} onChange={(v) => setDraft({ ...draft, privacyDefaultOn: v })} />
        </Field>

        {/* ---------- 危险操作 ---------- */}
        <div className="mb-5 p-3 rounded-lg border border-red-500/25 bg-red-500/5">
          <div className="text-red-400 text-sm font-semibold mb-3">⚠ 危险操作</div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/30 text-red-400 text-xs font-medium ring-1 ring-red-500/30 transition-colors"
              onClick={async () => {
                if (!window.confirm('确定要卸载「影匣」吗？卸载后应用及其数据将被移除。')) return
                if (!window.confirm('再次确认：卸载将删除应用与全部本地数据（海报缓存、媒体库配置）。')) return
                const r = await api.appUninstall()
                if (!r.ok) {
                  window.alert(r.error ?? '卸载失败')
                }
                // 卸载程序启动后本应用会被系统关闭
              }}
            >
              🗑 卸载影匣
            </button>
            <span className="text-white/35 text-xs">调用系统卸载程序，二次确认后执行</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-2">
          <button
            className="px-4 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="px-4 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium"
            onClick={() => onSave(draft)}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
