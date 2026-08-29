/**
 * 番号系列工具：提取 base code、判断是否同系列。
 * 用途：hunta-468-cd1 / hunta-468-cd2 这类分集共享元数据，只抓一份。
 */

/** 常见分集后缀：-CD1/-cd2、-PART1、-DISC1、-VOL1、-1/-2、-A/-B。
 *  CD/PART/DISC/VOL 允许无连字符（如 HUNTA-468CD2），
 *  纯数字分集必须带连字符（如 HUNTA-468-1），避免把 SONE-280/SSIS-419 的
 *  正常序号误拆为系列。
 */
const SERIES_SUFFIX_RE = /^([A-Z]{2,}-\d+)(?:(?:-?(?:CD|PART|DISC|VOL)\d+)|(?:-\d+)|(?:-?[A-Z]))$/i

/**
 * 提取系列 base code（大写）。
 * 例：HUNTA-468CD2 / hunta-468-cd1 / HUNTA-468-1 / HUNTA-468-A → HUNTA-468
 * SONE-280 / SSIS-419 / SONE-292 等正常序号会保持原样，不再被误归到 SONE-2 / SSIS-4。
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

/**
 * 是否「国产片」：文件夹名含中文、且文件夹名/文件名都提取不到番号（无 JavDB/JavBus 可对应的作品）。
 * 仅作「是否国产」判定，用于：不自动抓取元数据，仅用 ffmpeg 截帧（封面 + 预览）。
 * 注意：文件夹中文但文件名带番号（如「我的番号/SONE-280.mp4」）视为有码片，不判国产。
 */
export function isDomestic(folderName: string, fileName?: string): boolean {
  const f = (folderName ?? '').trim()
  if (!/[\u4e00-\u9fff]/.test(f)) return false
  if (extractCode(f) !== '') return false
  if (extractCode(fileName ?? '') !== '') return false
  return true
}

/** 从任意字符串（文件名/标题/整段描述）提取第一个番号；找不到返回空串。
 *  与 main 侧 javdb.ts 的 extractCode 语义不同：此处「提取不到」返回 ''，
 *  避免把无番号的文件名整段复制出去。
 *  支持两种形态：
 *    - 带分隔符：SONE-560 / SONE_560 / HUNTA-468CD2
 *    - 无分隔符：KSJK013 / ALDN606（旧版正则只认带分隔符，导致这类搜不到）
 *  先剥离中文字符/全角/括号/广告前缀，避免「【中文字幕】KSJK013」污染搜索词。 */
// 2026-08-29 合并朋友分支：正则兼容无分隔符番号（KSJK013 / MIDE123 等「字母+数字」连写）——
// 优先匹配带分隔符（SONE-560），否则匹配「≥2 字母 + 含 ≥2 位数字」的连续串；
// 纯英文单词（HELLO）、纯数字、中文标题均不命中 → 返回 ''（只提非中文番号）。
const CODE_RE = /\b([A-Z]{2,}(?:[-_][A-Z0-9]+|[A-Z0-9]*\d{2,}))\b/

export function extractCode(input: string): string {
  const t = (input ?? '').trim()
  if (!t) return ''
  // 1) 去掉中文/全角/括号等非 ASCII 部分（保留字母数字连字符下划线点）
  const ascii = t.replace(/[^\x21-\x7E]+/g, ' ')
  // 2) 从 ASCII 段中提取第一个番号形态 token（KSJK013 / SONE-560 / ALDN606）
  const m = ascii.toUpperCase().match(CODE_RE)
  if (!m) return ''
  const norm = m[1].replace(/_/g, '-')
  // 3) 归一为「字母-数字」标准形态（SONE-560CD2 → SONE-560；KSJK013 → KSJK-013）
  const mm = norm.match(/^([A-Z]{2,})(?:-)?(\d+)/)
  if (mm) return `${mm[1]}-${mm[2]}`
  return norm
}