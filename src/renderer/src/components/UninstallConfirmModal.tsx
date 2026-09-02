import { useEffect, useState } from 'react'
import Icon from './Icon'
import { t } from '../../../shared/i18n'

interface Props {
  open: boolean
  busy: boolean
  /** keepUser=true 保留用户数据；false 卸载时删除（仍受安全校验） */
  onConfirm: (keepUser: boolean) => void
  onCancel: () => void
}

/**
 * 卸载确认弹窗（整合「确认卸载」与「是否保留用户数据」于同一流程）。
 * 设计沿用 ConfirmDeleteModal 的差异化风格：左侧红色色条、icon、单焦点决策。
 */
export default function UninstallConfirmModal({ open, busy, onConfirm, onCancel }: Props) {
  const [keepUser, setKeepUser] = useState(true)

  useEffect(() => {
    if (open) setKeepUser(true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-modal-backdrop"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-2xl bg-ink-850 ring-1 ring-white/10 shadow-2xl shadow-black/60 animate-modal-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧大色条：承担视觉重量 */}
        <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-red-500 to-rose-400" aria-hidden="true" />

        <div className="p-6 pl-7">
          {/* 标题区 */}
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-red-500/15 text-red-400 flex items-center justify-center shrink-0">
              <Icon name="trash" size={20} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-white text-lg font-semibold leading-tight">
                {t('settings.uninstallApp')}
              </h2>
              <p className="text-white/50 text-xs mt-1">
                {t('settings.uninstallModalDesc')}
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label={t('app.close')}
            >
              <Icon name="x" size={15} />
            </button>
          </div>

          {/* 保留用户数据复选框（整合进同一弹窗） */}
          <label className="flex items-start gap-3 rounded-xl bg-white/[0.04] ring-1 ring-white/8 p-3.5 mb-4 cursor-pointer hover:bg-white/[0.06] transition-colors">
            <input
              type="checkbox"
              checked={keepUser}
              onChange={(e) => setKeepUser(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-red-500"
            />
            <div className="min-w-0">
              <div className="text-white text-sm font-medium">{t('settings.keepUserData')}</div>
              <div className="text-white/45 text-xs mt-0.5 leading-relaxed">
                {t('settings.keepUserDataHint')}
              </div>
            </div>
          </label>

          {/* 警告条 */}
          <div className="flex items-start gap-2 text-white/45 text-xs mb-5">
            <Icon name="info" size={12} className="mt-0.5 shrink-0 text-white/40" />
            <div className="leading-relaxed">{t('settings.uninstallModalWarn')}</div>
          </div>

          {/* 操作按钮 */}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="h-9 px-4 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/8 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {t('delete.cancel')}
            </button>
            <button
              type="button"
              onClick={() => onConfirm(keepUser)}
              disabled={busy}
              className="h-9 px-5 rounded-lg text-sm font-semibold bg-red-500 hover:brightness-110 shadow-lg shadow-red-500/40 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {busy ? (
                <>
                  <Icon name="refresh" size={13} className="animate-spin" />
                  {t('delete.processing')}
                </>
              ) : (
                t('settings.uninstallApp')
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
