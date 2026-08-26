/**
 * 番号系列工具：提取 base code、判断是否同系列。
 * 用途：hunta-468-cd1 / hunta-468-cd2 这类分集共享元数据，只抓一份。
 */

/** 常见分集后缀：-CD1/-cd2、-PART1、-DISC1、-1/-2、-A/-B（连字符可有可无，如 HUNTA-468CD2） */
const SERIES_SUFFIX_RE = /^([A-Z]{2,}-\d+?)(?:-?(?:CD|PART|DISC|VOL)\d+|-?\d+|-?[A-Z])$/i

/**
 * 提取系列 base code（大写）。
 * 例：HUNTA-468CD2 / hunta-468-cd1 / HUNTA-468-1 / HUNTA-468-A → HUNTA-468
 * 无后缀或后缀不在常见列表内时返回原样（大写），调用方据此判断「是否标准分集」。
 */
export function extractBaseCode(code: string): string {
  const c = (code ?? '').trim().toUpperCase()
  if (!c) return c
  const m = c.match(SERIES_SUFFIX_RE)
  return m ? m[1] : c
}

/** 该番号是否带常见分集后缀（即能剥出更短的 base code） */
export function hasSeriesSuffix(code: string): boolean {
  const c = (code ?? '').trim().toUpperCase()
  return c !== extractBaseCode(c)
}

/** 从任意字符串（文件名/标题/整段描述）提取第一个番号；找不到返回空串。
 *  与 main 侧 javdb.ts 的 extractCode 语义不同：此处「提取不到」返回 ''，
 *  避免把无番号的文件名整段复制出去。 */
const CODE_RE = /\b([A-Z]{2,}[-_][A-Z0-9]+)\b/
export function extractCode(input: string): string {
  const t = (input ?? '').trim()
  if (!t) return ''
  const m = t.toUpperCase().match(CODE_RE)
  return m ? m[1].replace('_', '-') : ''
}
