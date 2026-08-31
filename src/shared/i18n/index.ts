/**
 * 轻量 i18n 基础设施 —— 不引入 react-i18next 以节省包体。
 *
 * 使用方式：
 *   import { t, setLocale, getLocale, SUPPORTED_LOCALES, type Locale } from './i18n'
 *   t('sidebar.all')  // 根据当前语言返回对应翻译
 *   setLocale('en-US')
 *
 * 渲染层通过 App.tsx 的 I18nProvider 订阅 settings.language 变化。
 * 主进程直接读 settings.language（无 React，用同步函数）。
 */

import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

export type Locale = 'zh-CN' | 'en-US'

export const SUPPORTED_LOCALES: { value: Locale; label: string }[] = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' }
]

type Dict = Record<string, string>

const dicts: Record<Locale, Dict> = {
  'zh-CN': zhCN as unknown as Dict,
  'en-US': enUS as unknown as Dict
}

let currentLocale: Locale = 'zh-CN'
const listeners = new Set<(loc: Locale) => void>()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(loc: Locale): void {
  if (currentLocale === loc) return
  currentLocale = loc
  for (const fn of listeners) fn(loc)
}

export function subscribeLocale(fn: (loc: Locale) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 取翻译。key 不存在时 fallback 到 zh-CN，再不行直接返回 key 本身。
 * 支持简单插值：t('greeting', { name: '小明' }) → "你好，小明"
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = dicts[currentLocale]
  const fallback = dicts['zh-CN']
  let str = dict[key] ?? fallback[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return str
}

/** 主进程同步版本（不需要 React Context） */
export function tMain(key: string, vars?: Record<string, string | number>, loc?: Locale): string {
  const dict = dicts[loc ?? currentLocale]
  const fallback = dicts['zh-CN']
  let str = dict[key] ?? fallback[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return str
}
