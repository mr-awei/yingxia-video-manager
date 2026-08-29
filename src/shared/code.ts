/**
 * 番号系列工具：提取 base code、判断是否同系列。
 * 用途：hunta-468-cd1 / hunta-468-cd2 这类分集共享元数据，只抓一份。
 */

/**
 * 系列分集后缀：-CD1/-cd2、-PART1、-DISC1、-VOL1、-1/-2。
 *  CD/PART/DISC/VOL 允许无连字符（如 HUNTA-468CD2），
 *  纯数字分集必须带连字符（如 HUNTA-468-1），避免把 SONE-280/SSIS-419 的
 *  正常序号误拆为系列。
 *  尾部字母仅限「明确的单字母版本标签」（A-D / U / C），如 HUNTA-468A、IPX-219-C。
 *  SONE-560X、KSJK-013V 等非常规尾字母不剥（保留原值给 hasSeriesSuffix 判断）。
 */
const SERIES_SUFFIX_RE = /^([A-Z]{2,}-\d+)(?:(?:-?(?:CD|PART|DISC|VOL)\d+)|(?:-\d+)|(?:-[A-DUC])|(?:[A-DUC]))$/i

/**
 * 番号归一化：转大写、去空格/下划线/点（保留连字符，连字符是番号结构的一部分）。
 * SONE-566 / sone-566 / sone.566 / SONE_566 归一化后一致。
 * 2026-08-30 修复：原版只去空格/点，下划线残留，导致 `folder/SONE_566/xx.mp4` 与 Excel `SONE-566` 永不命中。
 * 2026-08-30 v2.2.3 抽到 shared 层：reconcile.ts + excel.ts 共用。
 */
export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[\s._]+/g, '')
}

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
 *  先剥离中文字符/全角/括号/广告前缀，避免「【中文字幕】KSJK013」污染搜索词。
 *
 *  针对域名前缀 2026-08-30 修复：
 *  1) 先按 `@` 切多段（hdd800.com@JUR-031 → ['hdd800.com', 'JUR-031']）
 *  2) 每段去方括号包裹（[hdd800.com@]DASS-733 → DASS-733）
 *  3) 含「-/_」的合法番号形态（dashes）段排序靠前，抑制 hdd800.com 这种「纯字母+数字紧凑无分隔符」误命中
 *  4) 段越长也越靠前
 *  5) plain fallback: [A-Z]{2,}[A-Z]+\d{2,} 要求「字母+额外字母+≥2 数字」整段匹配，过滤 hdd800/KSJK013-AB 等纯字母+纯数字形态 */
// 2026-08-29 合并朋友分支：正则兼容无分隔符番号（KSJK013 / MIDE123 等「字母+数字」连写）—— // 优先匹配带分隔符（SONE-560），否则匹配「≥2 字母 + 含 ≥2 位数字」的连续串；
const CODE_RE_DASHED = /\b([A-Z]{2,}[-_][A-Z0-9]+)\b/
const CODE_RE_PLAIN = /\b([A-Z]{2,}[A-Z]+\d{2,})\b/

export function extractCode(input: string): string {
  const t = (input ?? '').trim()
  if (!t) return ''
  // 1) 去掉中文/全角/括号等非 ASCII 部分
  const ascii = t.replace(/[^\x21-\x7E]+/g, ' ')
  // 2) 按 @ 切多段（处理域名前缀 hdd800.com@ / b8s2048.org@ / 44x.mejuy-），去前导空格
  const atSplit = ascii.split('@').map(s => s.trim()).filter(s => s.length > 0)
  // 3) 每段去方括号包裹（兼容 [hhd800.com@] 这种整体包方括号的情况）
  const debracket = (s: string) => s.replace(/^\[([^\]]+)\]$/, '$1')
  const allCands = atSplit.length > 1 ? atSplit.map(debracket) : [ascii.replace(/^\[([^\]]+)\]$/, '$1')]
  // 4) 排序：含 dashes 的段靠前 + 段更长也靠前（让含合法番号的段优先匹配）
  const sortedCands = [...allCands].sort((a, b) => {
    const aD = /[-_]/.test(a) ? 0 : 1
    const bD = /[-_]/.test(b) ? 0 : 1
    return aD - bD || b.length - a.length
  })
  const tryNorm = (s: string): string => {
    const mm = s.match(/^([A-Z]{2,})(?:-)?(\d+)/)
    return mm ? `${mm[1]}-${mm[2]}` : s
  }
  // 5) 优先在 @ 后候选里尝试 dashed → plain
  for (const cand of sortedCands) {
    const U = cand.toUpperCase()
    const dm = U.match(CODE_RE_DASHED)
    if (dm) return tryNorm(dm[1].replace(/_/g, '-'))
    const pm = U.match(CODE_RE_PLAIN)
    if (pm) return tryNorm(pm[1].replace(/_/g, '-'))
  }
  // 6) fallback: 整段（无 @ 时也走这条）
  const F = ascii.replace(/^\[([^\]]+)\]$/, '$1').toUpperCase()
  const dm = F.match(CODE_RE_DASHED)
  if (dm) return tryNorm(dm[1].replace(/_/g, '-'))
  const pm = F.match(CODE_RE_PLAIN)
  if (pm) return tryNorm(pm[1].replace(/_/g, '-'))
  return ''
}