import { useState } from 'react'
import type { ReconcileResult, RenamePreviewItem } from '../../../shared/types'
import { extractCode } from '../../../shared/code'

interface Props {
  open: boolean
  result: ReconcileResult | null
  mdPath?: string
  onClose: () => void
  onOpenFile: (path: string) => void
  /** 在系统文件管理器中显示并选中文件（用于改名） */
  onRevealInFolder?: (path: string) => void
  /** 预览可清理广告的文件名 */
  onPreviewRenames: () => Promise<RenamePreviewItem[]>
  /** 执行改名 */
  onApplyRenames: (
    items: { path: string; newName: string }[]
  ) => Promise<{ ok: number; failed: { path: string; reason: string }[] }>
}

export default function ReconcileDialog({
  open,
  result,
  mdPath,
  onClose,
  onOpenFile,
  onRevealInFolder,
  onPreviewRenames,
  onApplyRenames
}: Props) {
  const [previews, setPreviews] = useState<RenamePreviewItem[] | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState<{ ok: number; failed: number } | null>(null)
  const [copied, setCopied] = useState(false)

  if (!open || !result) return null

  const missing = result.entries.filter((e) => e.kind === 'missing')
  const unlisted = result.unlisted
  const hasAny = missing.length > 0 || unlisted.length > 0

  async function handlePreview() {
    setApplyResult(null)
    setPreviews(null)
    const items = await onPreviewRenames()
    setPreviews(items)
  }

  async function handleApply() {
    if (!previews || previews.length === 0) return
    setApplying(true)
    try {
      const r = await onApplyRenames(previews)
      setApplyResult({ ok: r.ok, failed: r.failed.length })
      setPreviews(null)
    } finally {
      setApplying(false)
    }
  }

  /** 一键复制所有未收录视频的番号（中文逗号间隔） */
  async function handleCopyUnlistedCodes() {
    const codes = unlisted
      .map((u) => extractCode(u.fileName))
      .filter((c): c is string => !!c)
    // 中文逗号间隔（用户习惯），自动去重
    const text = [...new Set(codes)].join('，')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      /* 剪贴板不可用时静默 */
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-ink-800 rounded-xl w-[620px] max-w-[94vw] max-h-[86vh] flex flex-col overflow-hidden shadow-card animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 pb-3 border-b border-white/5">
          <div className="text-white font-semibold text-lg">对账提醒</div>
          <div className="text-white/50 text-xs mt-1">
            简介 md 与视频文件夹不一致，请及时处理。
            {mdPath ? (
              <button
                className="ml-1 text-brand hover:underline"
                onClick={() => onOpenFile(mdPath)}
              >
                打开简介文件
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5 thin-scroll">
          {!hasAny ? (
            <div className="text-white/60 text-sm py-8 text-center">本次对账完全一致 🎉</div>
          ) : null}

          {missing.length > 0 ? (
            <div className="mb-6">
              <div className="text-red-400 text-sm font-medium mb-2">
                ⚠ 简介存在，但视频文件缺失（{missing.length}）—— 请去下载视频，或从简介中删除
              </div>
              <div className="flex flex-wrap gap-1.5">
                {missing.map((m) => (
                  <button
                    key={`${m.category}-${m.code}`}
                    className="px-2 py-1 rounded bg-red-600/20 hover:bg-red-600/40 text-white/90 text-xs"
                    title={m.description}
                    onClick={() => mdPath && onOpenFile(mdPath)}
                  >
                    {m.code}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {unlisted.length > 0 ? (
            <div>
              <div className="text-amber-400 text-sm font-medium mb-2">
                ⚠ 文件夹中有文件，但未收录进简介（{unlisted.length}）—— 请更新简介文件
                {onRevealInFolder ? (
                  <span className="text-white/40 text-xs ml-2">点击文件名 → 在文件管理器中打开并选中（方便改名）</span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {unlisted.map((u) => (
                  <button
                    key={u.path}
                    className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/40 text-white/90 text-xs"
                    title={`${u.path}\n点击：在文件管理器中显示并选中`}
                    onClick={() => onRevealInFolder?.(u.path)}
                  >
                    {u.fileName}
                  </button>
                ))}
              </div>

              {/* 一键清理文件名广告 */}
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <button
                  className="px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-medium"
                  onClick={handlePreview}
                  disabled={applying}
                >
                  🧹 一键清理文件名广告
                </button>

                {/* 一键复制所有未收录番号（中文逗号间隔） */}
                <button
                  className="px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/15 text-white/90 text-xs font-medium ring-1 ring-white/10 transition-colors"
                  onClick={handleCopyUnlistedCodes}
                  title="复制所有未收录视频的番号，中文逗号间隔（方便粘贴到简介 md / 搜索）"
                >
                  {copied ? '✓ 已复制' : '📋 复制所有未收录番号'}
                </button>
              </div>
              {copied ? (
                <div className="text-emerald-400 text-[11px] mt-1.5">
                  ✓ 已复制 {unlisted.length} 个文件的番号到剪贴板（中文逗号间隔）
                </div>
              ) : null}

              {applyResult ? (
                <div className="mt-2 text-xs">
                  <span className="text-brand">改名成功 {applyResult.ok} 个</span>
                  {applyResult.failed > 0 ? (
                    <span className="text-amber-400 ml-2">失败 {applyResult.failed} 个</span>
                  ) : null}
                  <span className="text-white/40 ml-2">重新扫描后生效</span>
                </div>
              ) : null}

              {previews !== null ? (
                <div className="mt-3">
                  {previews.length === 0 ? (
                    <div className="text-white/50 text-xs">没有发现可清理的广告文件名 🎉</div>
                  ) : (
                    <>
                      <div className="text-white/80 text-xs mb-2">
                        以下 {previews.length} 个文件将被重命名：
                      </div>
                      <div className="max-h-40 overflow-auto thin-scroll rounded bg-black/20 p-2 space-y-1">
                        {previews.map((p) => (
                          <div key={p.path} className="text-[11px] leading-relaxed">
                            <span className="text-white/40 line-through">{p.oldName}</span>
                            <span className="text-brand mx-1">→</span>
                            <span className="text-white/90">{p.newName}</span>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2 mt-2">
                        <button
                          className="px-3 py-1 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-medium"
                          onClick={handleApply}
                          disabled={applying}
                        >
                          {applying ? '改名中…' : `确认改名 ${previews.length} 个`}
                        </button>
                        <button
                          className="px-3 py-1 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-xs"
                          onClick={() => setPreviews(null)}
                        >
                          取消
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-white/5">
          <button
            className="px-4 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
            onClick={onClose}
          >
            我知道了
          </button>
        </div>
      </div>
    </div>
  )
}
