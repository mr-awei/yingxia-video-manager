import { useEffect, useState } from 'react'
import type { Library } from '../../../shared/types'
import { api } from '../lib/api'
import Icon from './Icon'

/** 内置规范里的「提示词」（新用户直接复制发给 AI） */
const PROMPT_TEXT = `请根据我提供的番号，按照以下要求生成作品简介和标签：

1. 先查询该番号的准确信息（女优、剧情、时长、类型等）。
2. 用中文撰写详细简介，风格参考下方「简介模版」。
3. 简介要包含：主要女优、核心设定、关键过程、高潮/特色玩法，语言流畅有画面感。
4. 简介结束后，必须参考文档「四、完整分类标签系统」进行打标签（主题、角色、服装、体型、行為、玩法、其他、场景等，可多选，用顿号分隔）。
5. 最后给出推荐评分（满分10分，保留两位小数），并简要说明评分依据。
6. 如果我一次提供多个番号，请逐一处理，保持格式统一。

【简介模版请参考下方三个代表性例子】`

interface Props {
  open: boolean
  library: Library | null
  onClose: () => void
  /** 打开外部链接（如 Grok 官网） */
  onOpenExternal: (url: string) => void
  /** 用系统程序打开完整规范 md 文件 */
  onOpenSpec: (path: string) => void
  /** 关闭向导并打开「库设置」，让用户选择刚生成的 md 文件 */
  onOpenLibrarySettings: () => void
}

export default function OnboardMdModal({
  open,
  library,
  onClose,
  onOpenExternal,
  onOpenSpec,
  onOpenLibrarySettings
}: Props) {
  const [codes, setCodes] = useState<string[]>([])
  const [loadingCodes, setLoadingCodes] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportedPath, setExportedPath] = useState('')
  const [specPath, setSpecPath] = useState('')
  const [copied, setCopied] = useState<'prompt' | 'codes' | 'full' | null>(null)

  // 打开向导时自动加载番号 + 规范路径（无需用户先点第一步）
  useEffect(() => {
    if (!open || !library) return
    setCodes([])
    setExportedPath('')
    setCopied(null)
    setLoadingCodes(true)
    void (async () => {
      try {
        const [r, sp] = await Promise.all([
          api.libraryGetCodes(library.id),
          api.specGet()
        ])
        setCodes(r.codes)
        if (sp.path) setSpecPath(sp.path)
      } finally {
        setLoadingCodes(false)
      }
    })()
  }, [open, library?.id])

  /** 把已加载的番号拼进提示词，生成可一键发给 AI 的完整提示词 */
  function buildFullPrompt() {
    if (codes.length === 0) return PROMPT_TEXT
    return `${PROMPT_TEXT}

下面是本次需要处理的番号列表，请严格按上方规范逐一处理，每个番号输出一段：

${codes.join('，')}`
  }

  function copy(text: string, which: 'prompt' | 'codes' | 'full', revealPath?: string) {
    void api.copyText(text)
    setCopied(which)
    if (revealPath) void api.shellRevealInFolder(revealPath)
    window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1600)
  }

  /** 导出番号清单（弹保存对话框；txt 兼容旧版，xlsx 生成 Excel 工作簿） */
  async function handleExport(format: 'txt' | 'xlsx') {
    if (!library) return
    setExporting(true)
    try {
      const r = await api.libraryExportCodes(library.id, format)
      if (r.ok && r.path) setExportedPath(r.path)
    } finally {
      setExporting(false)
    }
  }

  async function handleCopyFullPrompt() {
    // 兜底：specPath 还没异步拿到时主动取一次，确保 reveal 总能执行
    let reveal = specPath
    if (!reveal) {
      try {
        const r = await api.specGet()
        if (r.path) {
          setSpecPath(r.path)
          reveal = r.path
        }
      } catch {
        // ignore
      }
    }
    void api.copyText(buildFullPrompt())
    setCopied('full')
    if (reveal) void api.shellRevealInFolder(reveal)
    window.setTimeout(() => setCopied((c) => (c === 'full' ? null : c)), 1600)
  }

  if (!open || !library) return null

  const codesText = codes.join('，')

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="bg-ink-800 rounded-2xl w-[680px] max-w-[96vw] max-h-[88vh] flex flex-col shadow-card animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-brand/15 ring-1 ring-brand/30 flex items-center justify-center">
              <Icon name="sparkles" size={18} className="text-brand" />
            </div>
            <div>
              <div className="text-white font-semibold text-base">新建简介文件向导</div>
              <div className="text-white/40 text-xs">库「{library.name}」还没有简介 md 文件</div>
            </div>
          </div>
          <button
            className="w-8 h-8 rounded-lg hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors"
            onClick={onClose}
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* 内容（可滚动） */}
        <div className="px-6 py-5 overflow-y-auto space-y-5">
          <p className="text-white/70 text-sm leading-relaxed">
            影匣按「简介 md 文件」来分类影片、展示简介与标签。向导打开时已自动扫描本库的番号，可直接一键复制。
            规范全文已内置在本软件中，无需自行准备。
          </p>

          {/* ① 加载番号（自动） */}
          <section className="rounded-xl bg-ink-900/60 ring-1 ring-white/8 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">1</span>
              <h3 className="text-white font-semibold text-sm">加载番号（自动）</h3>
            </div>
            <p className="text-white/55 text-[13px] leading-relaxed mb-3">
              已自动扫描本库全部视频的「番号」（以中文逗号分隔）。可直接一键复制发给 AI，或导出为 txt / Excel 文件。
            </p>

            {loadingCodes ? (
              <div className="text-white/50 text-[13px]">扫描中…</div>
            ) : codes.length > 0 ? (
              <>
                <div className="text-emerald-400 text-[13px] mb-2">
                  已加载 {codes.length} 个番号
                </div>
                <textarea
                  readOnly
                  value={codesText}
                  className="w-full h-32 bg-ink-800 text-white/80 text-[12px] font-mono rounded-lg p-2.5 outline-none ring-1 ring-white/10 resize-none"
                />
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  <button
                    className="text-[12px] text-brand hover:text-brand-hover inline-flex items-center gap-1"
                    onClick={() => copy(codesText, 'codes')}
                  >
                    <Icon name="copy" size={13} />
                    {copied === 'codes' ? '✓ 已复制' : '一键复制（中文逗号）'}
                  </button>
                  <button
                    className="text-[12px] text-white/50 hover:text-white inline-flex items-center gap-1 disabled:opacity-50"
                    onClick={() => handleExport('txt')}
                    disabled={exporting}
                  >
                    <Icon name="download" size={13} />
                    {exporting ? '导出中…' : '导出 txt'}
                  </button>
                  <button
                    className="text-[12px] text-emerald-400/90 hover:text-emerald-400 inline-flex items-center gap-1 disabled:opacity-50"
                    onClick={() => handleExport('xlsx')}
                    disabled={exporting}
                  >
                    <Icon name="download" size={13} />
                    {exporting ? '导出中…' : '导出 Excel'}
                  </button>
                  {exportedPath ? (
                    <span className="text-white/35 text-[11px] truncate flex-1 min-w-[120px]">
                      已保存：{exportedPath}
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="text-amber-400 text-[13px]">
                本库下未找到任何视频文件，无法提取番号。
              </div>
            )}
          </section>

          {/* ② 按文档说明操作 */}
          <section className="rounded-xl bg-ink-900/60 ring-1 ring-white/8 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">2</span>
              <h3 className="text-white font-semibold text-sm">按规范生成 md 文件</h3>
            </div>
            <p className="text-white/55 text-[13px] leading-relaxed mb-3">
              下方「完整提示词」已自动包含第 1 步的全部番号。把提示词和规范文件一并发给 AI（推荐 Grok）即可。
            </p>

            <div className="rounded-lg bg-ink-800 ring-1 ring-white/10 p-3 mb-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-white/70 text-[12px] font-medium">
                  完整提示词（含番号，直接复制）
                </span>
                <button
                  className="text-[12px] text-brand hover:text-brand-hover inline-flex items-center gap-1"
                  onClick={() => copy(buildFullPrompt(), 'prompt')}
                >
                  {copied === 'prompt' ? '✓ 已复制' : '复制提示词'}
                </button>
              </div>
              <pre className="whitespace-pre-wrap text-white/80 text-[12px] leading-relaxed font-mono max-h-48 overflow-y-auto">
                {buildFullPrompt()}
              </pre>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                className="text-[12px] text-brand hover:text-brand-hover inline-flex items-center gap-1"
                onClick={() => specPath && onOpenSpec(specPath)}
                disabled={!specPath}
              >
                <Icon name="bookmark" size={13} />
                查看完整规范（评分标准 / 简介模版 / 完整标签系统）
              </button>
              <button
                className="text-[12px] text-white/60 hover:text-white inline-flex items-center gap-1"
                onClick={() => specPath && api.shellRevealInFolder(specPath)}
                disabled={!specPath}
              >
                <Icon name="folder" size={13} />
                打开规范文件位置（发给 AI 用）
              </button>
            </div>
          </section>

          {/* ③ 推荐 AI */}
          <section className="rounded-xl bg-ink-900/60 ring-1 ring-white/8 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">3</span>
              <h3 className="text-white font-semibold text-sm">推荐：用 Grok 生成</h3>
            </div>
            <p className="text-white/70 text-[13px] leading-relaxed mb-3">
              当前对成人内容支持最好、且免费的 AI 是 <span className="text-white font-medium">Grok</span>。
              把第 2 步的【完整提示词】和【规范文件】一并发给它即可。
            </p>
            <div className="flex items-center gap-3">
              <button
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-slate-900 text-sm font-semibold hover:bg-white/90 transition-colors"
                onClick={() => onOpenExternal('https://grok.com/')}
              >
                <Icon name="external" size={15} />
                打开 Grok
              </button>
              <span className="text-white/40 text-[12px]">https://grok.com/</span>
            </div>
          </section>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10">
          <button
            className="px-4 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
            onClick={onClose}
          >
            稍后再说
          </button>
          <button
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-white text-slate-900 text-sm font-semibold hover:bg-white/90 transition-colors"
            onClick={handleCopyFullPrompt}
            title="复制完整提示词（含已加载番号），并打开规范文件所在位置"
          >
            <Icon name="copy" size={15} />
            {copied === 'full' ? '✓ 已复制完整提示词' : '复制完整提示词并打开规范位置'}
          </button>
          <button
            className="px-4 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium"
            onClick={onOpenLibrarySettings}
          >
            去设置 md 文件
          </button>
        </div>
      </div>
    </div>
  )
}