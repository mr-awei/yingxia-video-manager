import type { JavdbDetail, Settings } from '../../shared/types'
import { getDispatcher } from './proxy'
import { extractBaseCode } from '../../shared/code'
import { extractCode, cacheRemoteImage } from './javdb'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** JavBus 当前可用域名（社区维护镜像，seedmm.bond 为 2026-08 有效镜像；javbus.com 备选） */
const DEFAULT_BASE = 'https://www.seedmm.bond'

// age=verified cookie 内存缓存：POST 一次年龄确认管 30 天
let ageCookie: { value: string; until: number } | null = null

function base(): string {
  // 后续可扩展：Settings 里配自定义域名（如用户自己的镜像）
  return DEFAULT_BASE
}

async function getText(url: string, settings: Settings, cookie?: string): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8',
    Referer: base() + '/'
  }
  if (cookie) headers.Cookie = cookie
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, dispatcher: getDispatcher(settings) })
    if (!res.ok) {
      console.log(`[javbus] HTTP ${res.status} ${url}`)
      return ''
    }
    return await res.text()
  } catch (e) {
    // 底层网络层错误（DNS/TLS/连接拒绝/超时）。原 fetch 抛 "fetch failed" 没有任何细节，
    // 包装成更可读的格式：URL + 错误码 + 错误消息
    const err = e as NodeJS.ErrnoException
    const detail = `${err?.code || err?.name || 'UNKNOWN'} ${err?.message || e}`
    console.log(`[javbus] fetch failed ${url} :: ${detail}`)
    throw new Error(`JavBus fetch failed: ${url} → ${detail}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 绕过 JavBus 年龄验证：POST /doc/driver-verify 表单（勾选「我已經成年」提交）
 * 服务器返回 Set-Cookie: age=verified（30 天有效）。内存缓存避免每次重复 POST。
 */
export async function ensureJavBusAgeCookie(settings: Settings): Promise<string | null> {
  const b = base()
  if (ageCookie && ageCookie.until > Date.now()) return ageCookie.value
  try {
    const res = await fetch(`${b}/doc/driver-verify?referer=${encodeURIComponent(b + '/')}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: b + '/',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'Submit=%E7%A2%BA%E8%AA%8D', // 確認
      redirect: 'manual',
      dispatcher: getDispatcher(settings)
    })
    // 兼容不同 Node 版本：getSetCookie() 返回全部 Set-Cookie，get() 可能只返回第一个
    const allCookies: string[] =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [(res.headers.get('set-cookie') || '')].filter(Boolean)
    const joined = allCookies.join('; ')
    if (!/age=verified/.test(joined)) {
      console.log('[javbus] age verify: no age=verified in set-cookie', allCookies)
      return null
    }
    const sess = (joined.match(/PHPSESSID=[^;]+/) || [''])[0]
    const cookie = [sess, 'age=verified'].filter(Boolean).join('; ')
    console.log('[javbus] age cookie ok:', cookie.split(';')[0] + '; age=verified')
    ageCookie = { value: cookie, until: Date.now() + 29 * 24 * 3600 * 1000 }
    return cookie
  } catch (e) {
    console.log('[javbus] age verify failed:', (e as Error)?.message || e)
    return null
  }
}

/** 搜索番号，返回详情页完整 URL（movie-box href，无尾斜杠）；找不到返回 null */
async function searchDetailUrl(code: string, settings: Settings, cookie: string): Promise<string | null> {
  const html = await getText(`${base()}/search/${encodeURIComponent(code)}&type=1`, settings, cookie)
  const m = html.match(/class="movie-box"[^>]*href="([^"]+)"/)
  console.log(`[javbus] search ${code} ${m ? `hit ${m[1]}` : `no match (htmlLen=${html.length})`}`)
  return m ? m[1] : null
}

/**
 * 解析 JavBus 详情页 HTML。
 * JavBus 的 star 区即女优列表（无 ♀/♂ 符号，star 页都是女优），直接作为 actresses。
 */
export function parseJavBusDetailHtml(html: string, fallbackCode: string): JavdbDetail {
  // 封面 + 完整标题：<img src="/pics/cover/xxx.jpg" title="完整标题">
  const coverMatch =
    html.match(/<img[^>]+src="(\/pics\/cover\/[^"]+)"[^>]+title="([^"]*)"/) ||
    html.match(/<img[^>]+title="([^"]*)"[^>]+src="(\/pics\/cover\/[^"]+)"/)
  const cover = coverMatch ? coverMatch[1] : undefined
  const title = coverMatch
    ? coverMatch[2]
    : (html.match(/<title>([^<]+)/) || ['', ''])[1].replace(/ - JavBus$/, '').trim()

  // info 行：每行 <p><span class="header">KEY:</span> VALUE</p>
  const meta: Record<string, string> = {}
  const headerRe = /<span class="header">([^<]+):<\/span>\s*([\s\S]*?)<\/p>/g
  let hm: RegExpExecArray | null
  while ((hm = headerRe.exec(html)) !== null) {
    const key = hm[1].trim()
    const val = hm[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    if (key && val && !['識別碼', '標籤'].includes(key)) meta[key] = val
  }

  // 类别：<a href="/genre/xxx">名称</a>
  const genres: string[] = []
  const genreRe = /href="[^"]*\/genre\/[^"]*"[^>]*>([^<]+)<\/a>/g
  let gm: RegExpExecArray | null
  while ((gm = genreRe.exec(html)) !== null) {
    const name = gm[1].trim()
    if (name && !genres.includes(name)) genres.push(name)
  }

  // 女优：<div class="star-name"><a href="..." title="山岸逢花">山岸逢花</a></div>
  const actresses: string[] = []
  const starRe = /class="star-name"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g
  let sm: RegExpExecArray | null
  while ((sm = starRe.exec(html)) !== null) {
    const name = sm[1].trim()
    if (name && !actresses.includes(name)) actresses.push(name)
  }

  // 截图：<a class="sample-box" href="https://...">（DMM 图床绝对 URL）
  const samples: string[] = []
  const sampleRe = /class="sample-box"[^>]*href="([^"]+)"/g
  let xm: RegExpExecArray | null
  while ((xm = sampleRe.exec(html)) !== null) samples.push(xm[1])

  // 長度 "200分鐘" → "200"
  const durationRaw = meta['長度'] || ''
  const duration = (durationRaw.match(/\d+/) || [''])[0] || durationRaw

  return {
    uid: '',
    code: (meta['識別碼'] || fallbackCode).toUpperCase(),
    title,
    cover,
    date: meta['發行日期'],
    duration,
    director: meta['導演'],
    studio: meta['製作商'],
    series: meta['系列'],
    rating: undefined,
    genres,
    actors: actresses,
    actresses,
    samples,
    parseVer: 2,
    source: 'javbus',
    fetchedAt: Date.now()
  }
}

/**
 * 按番号抓取 JavBus 详情（自动绕过年龄验证），并把封面/截图下载到本地缓存。
 * 失败返回 null（不抛异常）。
 */
export async function fetchJavBusDetail(
  code: string,
  settings: Settings,
  onError?: (m: string) => void
): Promise<JavdbDetail | null> {
  // 先 extractCode 提取番号（可能拿到 HUNTA-468CD2），再 extractBaseCode 剥后缀得 HUNTA-468。
  // JavBus 上没有 HUNTA-468CD2，只有 HUNTA-468，必须剥后缀。
  const codeNorm = extractBaseCode(extractCode(code)) || extractCode(code)
  if (!codeNorm) {
    // 「无法识别番号」属正常结果（数据源确实无对应），不触发 onError——
    // 让批量对账把「无结果」与「网络失败」区分开（网络失败才累计停止）。
    return null
  }
  const cookie = await ensureJavBusAgeCookie(settings)
  if (!cookie) {
    onError?.('JavBus 年龄验证失败（无法获取 age=verified cookie）')
    return null
  }
  const detailUrl = await searchDetailUrl(codeNorm, settings, cookie)
  if (!detailUrl) {
    // 「搜索无结果」正常静默（同「无法识别番号」）
    return null
  }
  const html = await getText(detailUrl, settings, cookie)
  console.log(`[javbus] detail ${codeNorm} htmlLen=${html.length}`)
  if (!html || /driver-verify/.test(html)) {
    console.log('[javbus] detail blocked by driver-verify')
    onError?.('JavBus 详情页被年龄验证拦截')
    return null
  }
  const detail = parseJavBusDetailHtml(html, codeNorm)
  const b = base()
  // v2.2.14-fix：DMM 图床 (pics.dmm.co.jp) 防盗链 — 必须用 **JavBus 详情页 URL** 当 Referer，
  // 站点根路径 https://www.seedmm.bond/ 会被 DMM 拒掉 → 所有 sample 返回 null → samples=[]
  // 封面是站点自己的相对路径，用根 Referer 没问题；但 samples 是 DMM 绝对 URL，必须 detailUrl
  const tasks: Promise<string | null>[] = []
  if (detail.cover) {
    const abs = detail.cover.startsWith('http') ? detail.cover : b + detail.cover
    tasks.push(cacheRemoteImage(abs, `javbus-cover-${codeNorm}`, settings, detailUrl))
  } else {
    tasks.push(Promise.resolve(null))
  }
  const samplesTotal = detail.samples.length
  detail.samples.forEach((u, i) => {
    tasks.push(cacheRemoteImage(u, `javbus-sample-${codeNorm}-${i}`, settings, detailUrl))
  })
  const results = await Promise.all(tasks)
  const [coverLocal, ...sampleLocals] = results
  console.log(`[javbus] ${codeNorm} cover=${coverLocal ? 'OK' : 'null'} samples=${sampleLocals.filter(Boolean).length}/${samplesTotal}`)
  return {
    ...detail,
    cover: coverLocal || undefined,
    // v2.2.14：保留解析出的原始总数，供前端区分「本来就没图」与「下载失败」
    samplesTotal,
    samples: sampleLocals.filter((p): p is string => !!p)
  }
}
