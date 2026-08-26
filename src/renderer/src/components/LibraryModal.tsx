import { useEffect, useState } from 'react'
import type { Library } from '../../../shared/types'
import { api } from '../lib/api'

interface Props {
  open: boolean
  library: Library | null
  onClose: () => void
  onSave: (patch: Partial<Library>) => void
  onRemove: () => void
}

export default function LibraryModal({ open, library, onClose, onSave, onRemove }: Props) {
  const [name, setName] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [introMdPath, setIntroMdPath] = useState('')

  useEffect(() => {
    if (open) {
      setName(library?.name ?? '')
      setFolderPath(library?.folderPath ?? '')
      setIntroMdPath(library?.introMdPath ?? '')
    }
  }, [open, library])

  if (!open) return null

  const inputCls =
    'w-full bg-ink-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 ring-brand/50'

  async function pickFolder() {
    const p = await api.dialogSelectFolder()
    if (p) setFolderPath(p)
  }
  async function pickMd() {
    const p = await api.dialogSelectFile()
    if (p) setIntroMdPath(p)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-ink-800 rounded-xl w-[560px] max-w-[92vw] p-5 shadow-card animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white font-semibold text-lg mb-4">媒体库设置</div>

        <label className="block mb-4">
          <div className="text-white/80 text-sm mb-1">名称</div>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="block mb-4">
          <div className="text-white/80 text-sm mb-1">视频文件夹</div>
          <div className="flex gap-2">
            <input className={inputCls} value={folderPath} onChange={(e) => setFolderPath(e.target.value)} />
            <button
              className="shrink-0 px-3 py-2 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={pickFolder}
            >
              浏览…
            </button>
          </div>
        </label>

        <label className="block mb-5">
          <div className="text-white/80 text-sm mb-1">简介 md 文件</div>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="选择分类/简介/标签的 md 文件（可留空）"
              value={introMdPath}
              onChange={(e) => setIntroMdPath(e.target.value)}
            />
            <button
              className="shrink-0 px-3 py-2 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={pickMd}
            >
              浏览…
            </button>
          </div>
          <div className="text-white/40 text-xs mt-1">
            海报墙按该 md 的分类展示；对账差异会弹窗提醒。
          </div>
        </label>

        <div className="flex justify-between items-center">
          {library ? (
            <button
              className="px-3 py-1.5 rounded-lg bg-red-600/80 hover:bg-red-600 text-white text-sm"
              onClick={onRemove}
            >
              删除媒体库
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              className="px-4 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="px-4 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium"
              onClick={() => onSave({ name: name.trim() || folderPath, folderPath, introMdPath })}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
