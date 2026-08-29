import type { IntroDoc, IntroItem } from '../../shared/types'
// SheetJS：读取 xlsx。xlsx 解析是主进程侧依赖（electron-builder 打进 app.asar）。
import * as XLSX from 'xlsx'

/**
 * 解析「收藏整理」Excel 片单（替代/并存 md 简介）。
 *
 * 期望结构（sheet「片单」）：
 *   表头：编号 | 品番 | 分类 | 推荐评分 | 简介 | 主题 | 角色 | 服装 | 体型 | 行为 | 玩法 | 场景 | 剧情 | 其他
 *   数据行：从第 2 行开始；「分类」即分类分组名；「品番」即番号；
 *           「推荐评分」为 0-10 数值；「主题/角色/服装/体型/行为/玩法/场景/剧情/其他」
 *           为逗号/顿号分隔的结构化标签（映射为 IntroItem.tagCategories）。
 * 产出与 `parseIntroMd` 完全同构的 IntroDoc，reconcileLibrary 无需区分数据源。
 */

function splitTags(v: unknown): string[] {
  if (v == null) return []
  const s = String(v).trim()
  if (!s) return []
  // 兼容逗号、顿号、中文分号、空格、换行分隔
  return s
    .split(/[,，、;；\n\r\t ]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function toScore(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) return undefined
  return Math.min(10, Math.max(0, n))
}

/**
 * 解析 Excel 片单文件。
 * @returns IntroDoc；文件缺失/无有效数据时返回 null（由调用方回退 md）
 */
export async function parseIntroExcel(filePath: string): Promise<IntroDoc | null> {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.readFile(filePath)
  } catch (e) {
    console.error(`[excel] 读取失败 ${filePath}:`, (e as Error)?.message || e)
    return null
  }
  // 兼容不同 sheet 名（片单 / 收藏 / Sheet1 ...）：取第一个有「品番」列的
  const sheetNames = wb.SheetNames
  let ws: XLSX.WorkSheet | undefined
  let sheetName = ''
  for (const name of sheetNames) {
    const candidate = wb.Sheets[name]
    if (!candidate) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(candidate, { header: 1 })
    if (rows.length > 0 && String(rows[0]?.[1] ?? '').includes('品番')) {
      ws = candidate
      sheetName = name
      break
    }
  }
  if (!ws) {
    console.error(`[excel] ${filePath} 未找到含「品番」列的工作表（sheets=${sheetNames.join(',')}）`)
    return null
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][]
  const header = rows[0] ?? []
  if (rows.length < 2) return null

  // 列索引：按表头名定位（容错表头顺序变化）
  const colIndex = (key: string): number => {
    const i = header.findIndex((h) => String(h ?? '').trim() === key)
    return i >= 0 ? i : -1
  }
  const ci = {
    code: colIndex('品番'),
    category: colIndex('分类'),
    score: colIndex('推荐评分'),
    desc: colIndex('简介')
  }
  // 结构化标签列：品番之后的所有列（编号/品番之间也可能有编号列）
  const tagCols: { name: string; idx: number }[] = []
  for (let i = Math.max(1, ci.code + 1); i < header.length; i++) {
    const name = String(header[i] ?? '').trim()
    if (!name || name === '编号') continue
    tagCols.push({ name, idx: i })
  }

  const entries: Array<{ category: string; item: IntroItem }> = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.length === 0) continue
    const code = String(row[ci.code] ?? '').trim()
    if (!code) continue
    // 跳过汇总/统计行（无品番）
    if (!/[A-Za-z]{2,}/.test(code)) continue

    const category = String(row[ci.category] ?? '').trim() || '未分类'
    const score = toScore(row[ci.score])
    const description = String(row[ci.desc] ?? '').trim()
    const tagCategories: Record<string, string[]> = {}
    const allTags: string[] = []
    for (const tc of tagCols) {
      if (tc.idx >= row.length) continue
      const tags = splitTags(row[tc.idx])
      if (tags.length > 0) {
        tagCategories[tc.name] = tags
        allTags.push(...tags)
      }
    }
    const raw = `**品番**：${code}\n**推荐评分**：${score ?? ''}\n**简介**：${description}\n${Object.entries(tagCategories)
      .map(([k, v]) => `**${k}**：${v.join('，')}`)
      .join('\n')}`

    entries.push({
      category,
      item: {
        code,
        description,
        tags: [...new Set(allTags)], // 平铺去重
        tagCategories,
        score,
        raw
      }
    })
  }

  if (entries.length === 0) return null

  // 分组（保持首次出现顺序）
  const categories: IntroDoc['categories'] = []
  const seen = new Map<string, number>()
  for (const e of entries) {
    let order = seen.get(e.category)
    if (order === undefined) {
      order = categories.length
      seen.set(e.category, order)
      categories.push({ name: e.category, order, items: [] })
    }
    categories[order].items.push(e.item)
  }

  console.log(`[excel] ${sheetName} 解析完成：${entries.length} 部 / ${categories.length} 类`)
  return { categories, totalCount: entries.length }
}

/** 供 UI 提示的解析信息（调试/日志） */
export function excelSheetNames(filePath: string): string[] {
  try {
    const wb = XLSX.readFile(filePath)
    return wb.SheetNames
  } catch {
    return []
  }
}

export function isExcelFile(p: string): boolean {
  return /\.(xlsx|xls)$/i.test(p)
}
