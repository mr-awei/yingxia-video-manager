import type { IntroCategory, IntroDoc, IntroItem } from '../../shared/types'

/**
 * 解析「简介 md」文件。
 *
 * 支持两种标签格式：
 *  1) 旧格式（单行）：**1. SONE-560**：简介…… **风格**：群P/大乱交/后宫 **剧情优秀**
 *  2) 新格式（结构化分类，独立标签块）：
 *       **1. SONE-560**：简介……
 *       **标签**：
 *       - **主题**：群P、大乱交、后宫、豪华共演
 *       - **角色**：多女优、S1全明星
 *       - **场景**：别墅、泳池、沙滩
 *     解析产出 tagCategories = { 主题: [...], 角色: [...], 场景: [...] }，
 *     tags 为所有分类标签的平铺去重。
 *
 * 分类用 `#### N、分类名`（H1~H6 标题）。空白行、汇总行（如「文档总计」）自动跳过。
 */

const CAT_RE = /^(#{1,6})\s*(.+?)\s*$/
// 条目行：** 1. SONE-560 **：...   番号取首个「字母数字-字母数字」token
const ITEM_RE = /^\*\*\s*(?:\d+[\.、]\s*)?([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*)\s*\*\*\s*[:：]([\s\S]*)$/
// **标签**：块开始
const TAG_BLOCK_RE = /^\*\*\s*标签\s*\*\*\s*[:：]\s*$/
// - **类别**：标签1、标签2、标签3
const TAG_LINE_RE = /^[-*]\s*\*\*([^*]+)\*\*\s*[:：]\s*(.+)$/

export function parseIntroMd(content: string): IntroDoc {
  const lines = content.split(/\r?\n/)
  const categories: IntroCategory[] = []
  let current: IntroCategory | null = null
  let lastItem: IntroItem | null = null
  let collectingTags = false
  let order = 0
  let total = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      collectingTags = false
      continue
    }

    const catMatch = trimmed.match(CAT_RE)
    if (catMatch) {
      const name = catMatch[2].replace(/^\d+[\.、]\s*/, '').trim() || '未命名分类'
      current = { name, order: order++, items: [] }
      categories.push(current)
      collectingTags = false
      lastItem = null
      continue
    }

    const itemMatch = trimmed.match(ITEM_RE)
    if (itemMatch) {
      const code = itemMatch[1]
      const { description, tags, tagCategories } = splitDescTags(itemMatch[2])
      const item: IntroItem = { code, description, tags, tagCategories, raw: trimmed }
      if (!current) {
        current = { name: '未分类', order: order++, items: [] }
        categories.push(current)
      }
      current.items.push(item)
      lastItem = item
      collectingTags = true // 条目后可能紧跟 **标签**： 块
      total++
      continue
    }

    // **标签**：块开始（下一行开始是 - **类别**：...）
    if (lastItem && TAG_BLOCK_RE.test(trimmed)) {
      collectingTags = true
      continue
    }

    // - **类别**：标签列表（特殊行：**推荐评分**：9.60 / 10 → 独立 score 字段，不混入标签）
    const tagLine = trimmed.match(TAG_LINE_RE)
    if (collectingTags && lastItem && tagLine) {
      const cat = tagLine[1].trim()
      if (cat === '推荐评分') {
        const m = tagLine[2].match(/(\d+(?:\.\d+)?)/)
        if (m) lastItem.score = parseFloat(m[1])
        continue
      }
      const list = tagLine[2]
        .split(/[、,，\/]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
      if (cat && list.length > 0) {
        lastItem.tagCategories = lastItem.tagCategories ?? {}
        const prev = lastItem.tagCategories[cat] ?? []
        lastItem.tagCategories[cat] = [...prev, ...list]
        // 平铺去重到 tags
        for (const t of list) {
          if (!lastItem.tags.includes(t)) lastItem.tags.push(t)
        }
      }
      continue
    }

    // 其他内容行：结束标签收集
    collectingTags = false
    lastItem = null
  }

  // 过滤空分类（文档标题 / 分隔装饰行会被当成分类，但没有任何条目，不应展示）
  return { categories: categories.filter((c) => c.items.length > 0), totalCount: total }
}

/**
 * 把条目正文（条目行内剩余部分）拆成「简介」和「标签」。
 * 兼容旧格式 `**风格**：...`；新格式的 `**标签**：` 块由 parseIntroMd 跨行解析。
 */
function splitDescTags(rest: string): {
  description: string
  tags: string[]
  tagCategories: Record<string, string[]>
} {
  let description = rest
  let tagPart = ''
  const idx = rest.indexOf('风格')
  if (idx >= 0) {
    description = rest.slice(0, idx)
    tagPart = rest.slice(idx + '风格'.length)
    tagPart = tagPart.replace(/^\**\s*[:：]?\s*/, '')
  }
  description = description.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
  const raw = tagPart
    .replace(/\*\*/g, ' ')
    .split(/[\/、\s]+/)
    .map((t) => t.trim())
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((t) => t.length > 0 && t !== '风格')
  const seen = new Set<string>()
  const tags: string[] = []
  for (const t of raw) {
    if (!seen.has(t)) {
      seen.add(t)
      tags.push(t)
    }
  }
  return { description, tags, tagCategories: {} }
}
