import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { JavdbDetail, Settings, Video } from '../../shared/types'
import { extractBaseCode } from '../../shared/code'
import { postersCacheDir } from './images'
import { getDispatcher } from './proxy'

export interface JavdbResult {
  uid: string
  code: string
  title: string
  posterUrl: string
}

const BASE = 'https://javdb.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// 代理出口统一由 src/main/lib/proxy.ts 提供（getDispatcher），支持 http/https/socks4/socks5/system。

/** 番号提取：支持带分隔符（SONE-560 / IPZZ-586 / FSDSS-322）与无分隔符（KSJK013 / ALDN606）。
 *  先剥离中文/全角/广告前缀（【中文字幕】KSJK013 → KSJK-013），再提取第一个番号 token。 */
const CODE_RE = /\b[A-Z]{2,}(?:[-_]\d+|\d+)(?:[A-Z0-9]{0,6})?\b/

/**
 * 从任意输入字符串（title / 文件名 / 整段描述）中提取第一个番号；
 * 找不到则返回原始输入大写。保证 javdb 搜索只带番号、不带描述。
 */
export function extractCode(input: string): string {
  const t = (input ?? '').trim()
  // 去掉中文/全角/括号等非 ASCII（避免「【中文字幕】KSJK013」污染搜索词）
  const ascii = t.replace(/[^\x21-\x7E]+/g, ' ')
  const m = ascii.toUpperCase().match(CODE_RE)
  if (!m) return t.toUpperCase()
  const norm = m[0].replace(/_/g, '-')
  // 归一为标准「字母-数字」形态：KSJK013 → KSJK-013；SONE-560CD2 → SONE-560
  const mm = norm.match(/^([A-Z]{2,})(?:-)?(\d+)/)
  return mm ? `${mm[1]}-${mm[2]}` : norm
}

/** 单个搜索结果条目：<a href="/v/UID" class="box" title="..."> ... <img ... src="POSTER"> ... <strong>CODE</strong> ... </a> */
const ITEM_RE =
  /<a href="\/v\/([A-Za-z0-9]+)" class="box"[^>]*>[\s\S]*?<img[^>]*src="(https?:\/\/[^"]+)"[\s\S]*?<div class="video-title"><strong>([^<]+)<\/strong>/g

async function getText(url: string, settings: Settings): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: BASE + '/'
  }
  if (settings.javdbCookie.trim()) headers.Cookie = settings.javdbCookie.trim()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(url, {
      headers,
      signal: ctrl.signal,
      dispatcher: getDispatcher(settings)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // JavDB 部分页面是 Big5/GBK（如繁体搜索结果），不是 UTF-8。
    // Node 的 res.text() 默认按 UTF-8 解码，遇到 Big5 中文会全部 mojibake（如「戀情沉賽」乱码）。
    // 修复：读 Content-Type charset → 兜底扫 HTML <meta charset> → 默认 utf-8。
    const buf = await res.arrayBuffer()
    const ct = res.headers.get('content-type') || ''
    const ctCharset = (ct.match(/charset=([\w-]+)/i)?.[1] || '').toLowerCase()
    // 用 UTF-8 偷看前 2KB，找 <meta charset>
    const peek = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 2048))
    const metaMatch =
      peek.match(/<meta[^>]+charset=["']?([\w-]+)/i) ||
      peek.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i)
    const metaCharset = (metaMatch?.[1] || '').toLowerCase()
    let charset = (ctCharset || metaCharset || 'utf-8').toLowerCase()
    if (charset === 'gb2312') charset = 'gbk'
    try {
      return new TextDecoder(charset).decode(buf)
    } catch {
      return new TextDecoder('utf-8').decode(buf)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 按番号搜索 javdb.com，返回第一个番号精确匹配的结果（含海报 URL）。
 * 无匹配或请求失败返回 null。
 */
export async function searchJavdb(
  code: string,
  settings: Settings,
  onError?: (m: string) => void
): Promise<JavdbResult | null> {
  const codeNorm = code.trim().toUpperCase()
  if (!codeNorm) {
    onError?.('番号为空')
    return null
  }
  const url = `${BASE}/search?q=${encodeURIComponent(codeNorm)}&f=all`
  let html: string
  try {
    html = await getText(url, settings)
    console.log(`[search] ${codeNorm} len=${html.length} preview=${html.slice(0, 250).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`[search] ${codeNorm} getText FAILED: ${(e as Error)?.message || e}`)
    onError?.(`JavDB 请求失败：${(e as Error)?.message || e}`)
    return null
  }
  const items: JavdbResult[] = []
  let m: RegExpExecArray | null
  ITEM_RE.lastIndex = 0
  while ((m = ITEM_RE.exec(html)) !== null) {
    const [, uid, posterUrl, strong] = m
    items.push({ uid, code: strong.trim().toUpperCase(), title: '', posterUrl })
  }
  // 精确匹配番号（个别标题里番号在 strong 中带空格/点，做宽容归一）
  const target = codeNorm.replace(/[.\s]/g, '')
  const hit =
    items.find((i) => i.code.replace(/[.\s]/g, '') === target) ??
    items.find((i) => i.code.includes(target)) ??
    items[0]
  if (!hit) {
    onError?.(`JavDB 搜索无结果：${codeNorm}（可能被风控或需 Cookie）`)
    return null
  }
  return { ...hit, title: hit.code }
}

/** 把任意远程图片下载到本地缓存目录（带 javdb Referer，走代理），返回本地路径 */
export async function cacheRemoteImage(
  remoteUrl: string,
  key: string,
  settings: Settings,
  referer: string = BASE
): Promise<string | null> {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, '_')
  const out = path.join(postersCacheDir(), `${safe}.jpg`)
  try {
    await fs.access(out)
    return out // 已有缓存
  } catch {
    /* 需要下载 */
  }
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: referer + '/',
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(remoteUrl, {
      headers,
      signal: ctrl.signal,
      dispatcher: getDispatcher(settings)
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 1000) return null
    await fs.mkdir(postersCacheDir(), { recursive: true })
    await fs.writeFile(out, buf)
    return out
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
/** 把海报下载到本地缓存目录，返回本地路径；失败返回 null */
async function cachePoster(
  code: string,
  posterUrl: string,
  settings: Settings
): Promise<string | null> {
  const safe = code.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  return cacheRemoteImage(posterUrl, `javdb-${safe}`, settings)
}

/** 为某条视频抓取 javdb 封面并缓存，返回本地路径；失败返回 null */
export async function fetchJavdbPosterForVideo(
  video: Video,
  settings: Settings
): Promise<string | null> {
  // 搜索源优先级：番号（title）→ 外文件夹名 → 文件名。
  // 视频文件名通常带字幕组/制作组广告，外文件夹名干净得多。
  // **关键**：先 extractCode 拿到番号（可能是 HUNTA-468CD2 这种连写），再 extractBaseCode
  // 剥常见后缀（-CD/-PART/-DISC/-A/-B 或末尾数字），得到 HUNTA-468。
  // JavDB/JavBus 上没有 HUNTA-468CD2 这个番号，只有 HUNTA-468，必须剥。
  const rawCode = extractCode(video.title || video.folderName || video.fileName || '')
  const code = extractBaseCode(rawCode) || rawCode
  if (!code) return null
  const hit = await searchJavdb(code, settings)
  if (!hit) return null
  return cachePoster(hit.code, hit.posterUrl, settings)
}

// ========== 详情页抓取 ==========

/**
 * 把 javdb 详情页 HTML 解析为结构化元数据。
 * 不发起网络；只做解析。供测试和复用。
 */
export function parseJavdbDetailHtml(html: string, fallbackCode: string): JavdbDetail {
  // 封面：<img ... class="video-cover" ... src="...">
  const coverMatch = html.match(/<img[^>]+class="[^"]*video-cover[^"]*"[^>]+src="([^"]+)"/)
    || html.match(/src="(https?:\/\/[^"]+)"[^>]+class="[^"]*video-cover/)
  const cover = coverMatch ? coverMatch[1] : undefined

  // 完整标题
  const titleMatch = html.match(/<strong[^>]*class="[^"]*current-title[^"]*"[^>]*>([\s\S]*?)<\/strong>/)
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : ''

  // 番号：<strong>SONE-560</strong>（首个独立 strong，通常是页头的番号）
  // 跳过 current-title 和「關於」「熱搜」
  const codeMatch = html.match(/<strong[^>]*>\s*([A-Z]{2,}[-_][A-Z0-9]+)\s*<\/strong>/)
  const code = codeMatch ? codeMatch[1].trim() : fallbackCode

  // 元数据键值对：<strong>KEY:</strong>VALUE ... up to next <strong|</li>|<br
  const meta: Record<string, string> = {}
  const metaRe =
    /<strong[^>]*>([^<]+?)(?:[::]\s*<\/strong>)\s*([\s\S]*?)(?=<strong[^>]*>[^<]+?[::]?\s*<\/strong>|<br\s*\/?|<\/li>)/g
  let mm: RegExpExecArray | null
  while ((mm = metaRe.exec(html)) !== null) {
    const key = mm[1].trim()
    // 去掉 &nbsp; 等 HTML 实体和首尾空白
    const val = mm[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (key && val && !['關於', '熱搜'].includes(key)) meta[key] = val
  }

  // 演员解析（女优 / 男演员）—— 按文档顺序 zip 配对，最稳健的策略。
  // JavDB 详情页中，每个演员 <a href="/actors/UID">NAME</a> 之后会有一个性别符号 ♀/♂，
  // 但物理位置不固定（可能紧跟链接、可能行尾集中、可能被 <span> 包裹）。
  // 1) section 范围：「演員/演员」标签之后 → 下一个 <strong>（下一条元数据）或 2500 字符上限。
    // **不**在第一个 <br> 处截断 —— JavDB 常用 <br> 分隔女优组与男演员组，提前截断会把
    // 后面整组演员与对应符号一起丢掉（旧版的坑）。也不回退到整页扫描（会混入侧栏/底部推荐）。
  // 2) 解码 HTML 实体 ♀/♂（&#9792; &#x2640; / &#9794; &#x2642;），保证符号一定能匹配。
  // 3) UID 放宽匹配（[A-Za-z0-9]+），不要求含数字；类别 slug 不会出现在「演員」行内。
  // 4) **按文档顺序 zip**：把 section 里所有 ♀/♂ 符号与所有演员链接一一对应，第 N 个符号
    // 决定第 N 个演员的性别。这种「按序配对」对符号物理位置完全无关，是最稳健的。
  // 5) 危险兜底已移除：若一个 ♀ 都没解析到，actresses 留空，**绝不**把整组演员当女优。
  const actressSet: string[] = []
  const labelRe = /<strong[^>]*>(?:演員|演员)\s*[:：]?\s*<\/strong>/i
  const labelMatch = labelRe.exec(html)
  if (labelMatch) {
    const sectionStart = labelMatch.index + labelMatch[0].length
    const rest = html.slice(sectionStart)
    // section 范围：演員标签后取大窗口（10000 字符），不再在「下一个 <strong>」处截断——
    // JavDB 在「演員」下常带子标题（<strong>女优</strong> / <strong>男演员</strong>），
    // 旧逻辑在第一个子标题就切了，导致后面真正的演员链接全部丢失。
    // 类别行（href="/actors/<lowercase-slug>"）会在演员行之后，符号只有演员的 ♀/♂，
    // zip 按顺序配对时，类别链接排在最后、分配不到符号，被自动忽略，不会污染结果。
    const cap = 10000
    const sectionEnd = cap
    const section = rest
      .slice(0, sectionEnd)
      .replace(/&#9792;|&#x2640;/g, '♀') // ♀
      .replace(/&#9794;|&#x2642;/g, '♂') // ♂

    // 演员链接（按文档顺序）
    const linkRe = /href="\/actors\/([A-Za-z0-9]+)"[^>]*>([^<]+)<\/a>/g
    const links: string[] = []
    let lm: RegExpExecArray | null
    while ((lm = linkRe.exec(section)) !== null) {
      const name = lm[2].trim()
      if (name) links.push(name)
    }

    // 性别符号（按文档顺序）
    const symbolRe = /[♀♂]/g
    const symbols: string[] = []
    let sm: RegExpExecArray | null
    while ((sm = symbolRe.exec(section)) !== null) symbols.push(sm[0])

    // zip：第 N 个符号决定第 N 个演员
    for (let i = 0; i < links.length && i < symbols.length; i++) {
      if (symbols[i] === '♀' && !actressSet.includes(links[i])) {
        actressSet.push(links[i])
      }
    }
    console.log(
      `[parse] ${fallbackCode} label=${!!labelMatch} sectionLen=${section.length} ` +
      `links=${links.length} symbols=${symbols.length} actresses=[${actressSet.join(',')}]`
    )
  } else {
    console.log(`[parse] ${fallbackCode} label NOT FOUND`)
  }

  // 类别：href="/actors/censored" 等纯小写 slug
  const genres: string[] = []
  const genreRe = /href="\/actors\/([a-z]+)"[^>]*>([^<]+)</g
  let gm: RegExpExecArray | null
  while ((gm = genreRe.exec(html)) !== null) {
    const name = gm[2].trim()
    if (name && !genres.includes(name)) genres.push(name)
  }

  // 关键截图（大图）：samples/<xx>/<UID>_l_<N>.jpg
  const samples: string[] = []
  const seenN = new Set<string>()
  const sampleRe = /https?:\/\/c[0-9]\.jdbstatic\.com\/samples\/[a-z0-9]{2}\/([A-Za-z0-9]+)_l_(\d+)\.jpg/g
  let sm: RegExpExecArray | null
  while ((sm = sampleRe.exec(html)) !== null) {
    const key = `${sm[1]}_${sm[2]}`
    if (seenN.has(key)) continue
    seenN.add(key)
    samples.push(sm[0])
  }

  return {
    uid: '',
    code,
    title,
    cover,
    date: meta['日期'],
    duration: meta['時長'],
    director: meta['導演'],
    studio: meta['片商'],
    series: meta['系列'],
    rating: meta['評分'],
    genres,
    // 对外暴露的「演员」统一为女优。
    // 若解析未命中任何 ♀（页面无性别标记或结构异常），actresses 留空，
    // **绝不**回退到整组演员 —— 那会把男演员全部当成女优（旧版的坑）。
    actors: actressSet,
    actresses: actressSet,
    samples,
    parseVer: 2,
    source: 'javdb',
    fetchedAt: Date.now()
  }
}

/**
 * 按番号抓取 javdb 详情页元数据。先搜索拿到 UID，再拉 /v/<UID> 解析。
 * 抓取后**把封面和所有样本图都下载到本地缓存**，返回的 JavdbDetail 中 cover/samples 都是本地绝对路径
 * —— 渲染层用 lm:// 协议加载，避开 javdb CDN 的反盗链 403，也能被隐私护盾自动模糊。
 */
export async function fetchJavdbDetail(
  code: string,
  settings: Settings,
  onError?: (m: string) => void
): Promise<JavdbDetail | null> {
  const codeNorm = extractCode(code)
  if (!codeNorm) {
    // 「无法识别番号」属正常结果（静默，不算网络失败，避免批量误停）
    return null
  }
  const hit = await searchJavdb(codeNorm, settings, onError)
  if (!hit) return null
  const url = `${BASE}/v/${hit.uid}`
  let html: string
  try {
    html = await getText(url, settings)
  } catch (e) {
    onError?.(`JavDB 详情页请求失败：${(e as Error)?.message || e}`)
    return null
  }
  let detail: JavdbDetail
  try {
    detail = parseJavdbDetailHtml(html, hit.code)
    detail.uid = hit.uid
  } catch {
    return null
  }

  // 把远程图片下载到本地缓存（并行）。失败的跳过。
  const tasks: Promise<string | null>[] = []
  if (detail.cover) {
    tasks.push(cacheRemoteImage(detail.cover, `javdb-cover-${hit.uid}`, settings))
  } else {
    tasks.push(Promise.resolve(null))
  }
  detail.samples.forEach((url, i) => {
    tasks.push(cacheRemoteImage(url, `javdb-sample-${hit.uid}-${i}`, settings))
  })
  // 把远程图片下载到本地缓存（并行）。失败的跳过，绝不把远程 URL 写回 JavdbDetail
  // （远程 URL 经 posterUrl 透传会让 Chromium 直接请求 javdb CDN 触发 403 反盗链）
  const results = await Promise.all(tasks)
  const [coverLocal, ...sampleLocals] = results
  return {
    ...detail,
    cover: coverLocal || undefined,
    samples: sampleLocals.filter((p): p is string => !!p)
  }
}
