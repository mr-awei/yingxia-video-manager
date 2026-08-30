import type { JavdbDetail, Settings } from '../../shared/types'
import { getDispatcher } from './proxy'
import { extractBaseCode } from '../../shared/code'
import { extractCode, cacheRemoteImage } from './javdb'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** JavLibrary 主站（英文界面；cn 前缀是中文界面，页面结构一致） */
const BASE = 'https://www.javlibrary.com'

/** 年龄确认 cookie（JavLibrary 首次访问需点确认，会下发 age_check=1；一次有效长缓存） */
let ageCheckCookie: string | null = null

function base(): string {
  return BASE
}

async function getText(url: string, settings: Settings): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8',
    Referer: base() + '/cn/'
  }
  if (ageCheckCookie) headers.Cookie = ageCheckCookie
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(url, {
      headers,
      signal: ctrl.signal,
      dispatcher: getDispatcher(settings)
    })
    if (!res.ok) return ''
    const html = await res.text()
    // 捕获 age_check cookie 供后续请求复用
    const setCookies = res.headers.getSetCookie?.() ?? []
    for (const c of setCookies) {
      if (/age_check=1/i.test(c)) ageCheckCookie = c.split(';')[0]
    }
    return html
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 按番号搜索，返回详情页完整 URL（/cn/?v=xxxxx）；找不到返回 null */
async function searchDetailUrl(code: string, settings: Settings): Promise<string | null> {
  const html = await getText(`${base()}/cn/vl_searchbyid.php?keyword=${encodeURIComponent(code)}`, settings)
  if (!html) return null
  // JavLibrary 搜索可能直接 302 到详情页（搜索结果唯一时）——从文本里找 ?v= 链接
  const m = html.match(/href="\/cn\/\?v=([A-Za-z0-9]+)"/)
  return m ? `${base()}/cn/?v=${m[1]}` : null
}

function pick(html: string, re: RegExp): string {
  const m = html.match(re)
  return m ? m[1].trim() : ''
}

function pickAll(html: string, re: RegExp): string[] {
  const out: string[] = []
  const g = html.matchAll(re)
  for (const m of g) {
    const v = m[1]?.trim()
    if (v) out.push(v)
  }
  return [...new Set(out)]
}

/**
 * 解析 JavLibrary 详情页 HTML 为 JavdbDetail（字段对齐 javdb/javbus，便于下游统一消费）。
 */
export function parseJavLibraryDetailHtml(html: string, code: string): JavdbDetail {
  // 标题（<div class="video_title"><h3><a>...）
  const title = pick(html, /<h3[^>]*>([\s\S]*?)<\/h3>/) || code
  const cleanTitle = title.replace(/<[^>]+>/g, '').trim()
  // 封面（<img id="video_jacket_img" ... src="...">）
  const cover = pick(html, /id="video_jacket_img"[^>]*src="([^"]+)"/) || pick(html, /id="video_jacket_img"[^>]*src='([^']+)'/)
  // 发行日期（<td class="header">发行日期</td><td><span class="date">2026-01-01</span>）
  const date = pick(html, /发行日期<\/td>\s*<td[^>]*>\s*<a[^>]*class="date"[^>]*>([^<]+)<\/a>/)
    || pick(html, /class="date">([^<]+)<\/a>/)
  // 导演 / 制作商 / 发行商 / 系列（<td class="header">导演</td><td><span class="director">...）
  const director = pick(html, /导演<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.replace(/<[^>]+>/g, '')?.trim() || undefined
  const studio = pick(html, /制作商<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.replace(/<[^>]+>/g, '')?.trim() || undefined
  const label = pick(html, /发行商<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.replace(/<[^>]+>/g, '')?.trim() || undefined
  const series = pick(html, /系列<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.replace(/<[^>]+>/g, '')?.trim() || undefined
  // 评分（<div id="video_review"><span class="score">8.5</span> 或 <span class="score">）
  const rating = pick(html, /<span class="score"[^>]*>([^<]+)<\/span>/)
  // 演员（<div id="video_cast"><span class="cast"><a ...>NAME</a>）
  const actors = pickAll(html, /<span class="cast"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/)
  // 类别（<span class="genre"><a ...>TAG</a>）
  const genres = pickAll(html, /<span class="genre"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/)
  // 截图（<div id="video_pics"> 内 <img src>）
  const samples = pickAll(html, /<div id="video_pics">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?<\/div>/)?.length
    ? pickAll(html, /<div id="video_pics">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?<\/div>/)
    : []

  return {
    uid: code,
    code,
    title: cleanTitle,
    cover: cover || undefined,
    date: date || undefined,
    director: director || undefined,
    studio: (studio || label) || undefined,
    series: series || undefined,
    rating: rating || undefined,
    genres,
    actors,
    actresses: actors, // JavLibrary 无 ♀/♂ 区分，全部视作演员
    samples,
    parseVer: 1,
    source: 'javlibrary',
    fetchedAt: Date.now()
  }
}

/** 按番号抓取 JavLibrary 详情（搜索 → 详情页 → 解析 → 本地化封面/截图） */
export async function fetchJavLibraryDetail(
  code: string,
  settings: Settings,
  _onError?: (m: string) => void
): Promise<JavdbDetail | null> {
  // 与 javbus 一致：先归一番号（KSJK013 → KSJK-013 → base code）
  const codeNorm = extractBaseCode(extractCode(code)) || extractCode(code)
  if (!codeNorm) return null
  const detailUrl = await searchDetailUrl(codeNorm, settings)
  if (!detailUrl) {
    // 「搜索无结果」正常静默（同 javdb/javbus 约定）
    return null
  }
  const html = await getText(detailUrl, settings)
  if (!html) return null
  let detail: JavdbDetail
  try {
    detail = parseJavLibraryDetailHtml(html, codeNorm)
  } catch {
    return null
  }

  // 本地化图片（封面 + 截图），失败跳过
  const tasks: Promise<string | null>[] = []
  if (detail.cover) {
    tasks.push(cacheRemoteImage(detail.cover, `javlibrary-cover-${codeNorm}`, settings, base()))
  } else {
    tasks.push(Promise.resolve(null))
  }
  detail.samples.slice(0, 20).forEach((url, i) => {
    tasks.push(cacheRemoteImage(url, `javlibrary-sample-${codeNorm}-${i}`, settings, base()))
  })
  const results = await Promise.all(tasks)
  const [coverLocal, ...sampleLocals] = results
  return {
    ...detail,
    cover: coverLocal ?? detail.cover,
    samples: sampleLocals.filter((x): x is string => !!x)
  }
}
