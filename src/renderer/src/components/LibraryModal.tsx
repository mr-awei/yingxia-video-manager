import { useEffect, useState } from 'react'
import type { Library } from '../../../shared/types'
import { api } from '../lib/api'
import Icon from './Icon'

interface Props {
  open: boolean
  /** null = 新建媒体库；非 null = 编辑已有媒体库 */
  library: Library | null
  onClose: () => void
  /** 保存（新建/更新）；返回是否成功 */
  onSave: (patch: Partial<Library>) => Promise<boolean>
  onRemove: () => void
}

export default function LibraryModal({ open, library, onClose, onSave, onRemove }: Props) {
  const [name, setName] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [introExcelPath, setIntroExcelPath] = useState('')
  const [saving, setSaving] = useState(false)

  const adding = !library

  useEffect(() => {
    if (open) {
      setName(library?.name ?? '')
      setFolderPath(library?.folderPath ?? '')
      setIntroExcelPath(library?.introExcelPath ?? '')
      setSaving(false)
    }
  }, [open, library])

  if (!open) return null

  const inputCls =
    'w-full bg-ink-700 text-white text-sm rounded-lg px-3 py-2 outline-none focus:ring-2 ring-brand/50'

  async function pickFolder() {
    const p = await api.dialogSelectFolder()
    if (p) {
      setFolderPath(p)
      if (!name) setName(p.split(/[\\/]/).pop() || p)
    }
  }
  async function pickExcel() {
    const p = await api.dialogSelectFile()
    if (p && /\.(xlsx|xls)$/i.test(p)) setIntroExcelPath(p)
  }

  async function save() {
    if (saving) return
    // 新建模式必须有视频文件夹；编辑模式至少要有名称或文件夹
    if (!folderPath.trim()) return
    setSaving(true)
    try {
      const ok = await onSave({ name: name.trim() || folderPath, folderPath, introExcelPath })
      if (!ok) setSaving(false)
      // 成功时弹窗由 App 层关闭
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-ink-800 rounded-xl w-[620px] max-w-[92vw] max-h-[90vh] overflow-auto p-5 shadow-card animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="text-white font-semibold text-lg">
            {adding ? '添加媒体库' : '媒体库设置'}
          </div>
          <button
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-ink-700 hover:bg-ink-600 text-white/60"
            onClick={onClose}
            title="关闭"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* 引导说明：告诉用户这两步分别是什么 */}
        {adding ? (
          <div className="mb-5 rounded-xl bg-ink-900/60 border border-white/5 p-3.5 space-y-2">
            <div className="text-white/85 text-[13px] font-medium">只需两步，就能把影片变成海报墙：</div>
            <div className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-md bg-brand/20 text-brand text-[11px] font-bold flex items-center justify-center shrink-0 mt-px">1</span>
              <div>
                <div className="text-white/90 text-[13px]">
                  选择视频文件夹
                  <span className="text-white/40 ml-1.5">（必选）</span>
                </div>
                <div className="text-white/45 text-[12px] leading-relaxed mt-0.5">
                  你的影片存在哪个文件夹，影匣就扫描哪里，自动识别文件夹和子文件夹里的所有视频文件。
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-md bg-brand/20 text-brand text-[11px] font-bold flex items-center justify-center shrink-0 mt-px">2</span>
              <div>
                <div className="text-white/90 text-[13px]">
                  选择 Excel 片单文件
                  <span className="text-white/40 ml-1.5">（可选）</span>
                </div>
                <div className="text-white/45 text-[12px] leading-relaxed mt-0.5">
                  一个含每部影片「品番 / 分类 / 简介 / 标签 / 评分」的 Excel 文件。选了它，海报墙就能按分类浏览、悬停看简介；不选也可以，只是没有分类和简介。
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <label className="block mb-4">
          <div className="text-white/80 text-sm mb-1">名称</div>
          <input
            className={inputCls}
            placeholder={adding ? '留空则自动使用文件夹名' : ''}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {adding ? (
            <div className="text-white/40 text-xs mt-1">给这个媒体库起个名字，方便区分多个库。</div>
          ) : null}
        </label>

        <label className="block mb-4">
          <div className="text-white/80 text-sm mb-1">
            视频文件夹
            {adding ? <span className="text-white/40 ml-1.5 text-xs">（必选）</span> : null}
          </div>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="点击右侧「浏览…」选择影片所在文件夹"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
            />
            <button
              className="shrink-0 px-3 py-2 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={pickFolder}
            >
              浏览…
            </button>
          </div>
          <div className="text-white/40 text-xs mt-1">
            影匣会扫描该文件夹及其子文件夹中的视频文件（mp4 / mkv / avi / wmv 等），生成海报墙。
          </div>
        </label>

        <label className="block mb-5">
          <div className="text-white/80 text-sm mb-1">
            Excel 片单文件
            <span className="text-white/40 ml-1.5 text-xs">（可选）</span>
          </div>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="选择「收藏整理_2026.xlsx」这类片单（品番/分类/评分/简介/标签）"
              value={introExcelPath}
              onChange={(e) => setIntroExcelPath(e.target.value)}
            />
            <button
              className="shrink-0 px-3 py-2 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={pickExcel}
            >
              浏览…
            </button>
          </div>
          <div className="text-white/40 text-xs mt-1">
            海报墙按该 Excel 的分类/简介/标签/评分展示，对账差异会弹窗提醒。Excel 需含「品番」列（如 收藏整理_2026.xlsx 的「片单」工作表）。
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
            <span className="text-white/35 text-[11px]">
              {folderPath.trim() ? '' : '请先选择视频文件夹'}
            </span>
          )}
          <div className="flex gap-2">
            <button
              className="px-4 py-1.5 rounded-lg bg-ink-700 hover:bg-ink-600 text-white text-sm"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="px-4 py-1.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={save}
              disabled={!folderPath.trim() || saving}
            >
              {saving ? '保存中…' : adding ? '添加并扫描' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
