import type { JavdbDetail, Settings } from '../../shared/types'
import { getDispatcher } from './proxy'
import { extractCode, cacheRemoteImage } from './javdb'
import { extractBaseCode } from '../../shared/code'

/**
 * javinfo.dev —— JAV 元数据聚合 API（https://javinfo.dev，服务端 https://api.javinfo.dev）
 * 优点：不用自己爬 HTML，没有 Cloudflare / IP 风控问题（风控由它服务端扛）。
 * 额度：免费 50 次查询、5 req/min；付费 $0.75/千次 /movie。
 * 接入：app.javinfo.dev 注册拿 key，请求头 `x-javinfo-key` 携带。
 *
 * 与 javdb.ts / javbus.ts 的约定一致：失败返回 null（不抛异常），onError 收集原因；
 * 封面/截图抓取后本地缓存，返回的 detail.cover / samples 均为本地路径。
 */

const BASE = 'https://api.javinfo.dev'

/** 无 key 时快速短路（不消耗免费额度、不产生无意义请求） */
export function hasJavinfoKey(settings: Settings): boolean {
  return !!(settings.javinfoKey && settings.javinfoKey.trim())
}

/** javinfo 响应里 `result` 的 base 形状（只声明用到的字段，其余忽略） */
interface JavinfoResult {
  contentId?: string | null
  dvdId?: string | null
  titleEn?: string | null
  titleJa?: string | null
  commentEn?: string | null
  commentJa?: string | null
  runtimeMins?: number | null
  releaseDate?: string | null
  makers?: string[] | null
  label?: string | null
  series?: string | null
  categories?: string[] | null
  actresses?: string[] | null
  actors?: string[] | null
  directors?: string[] | null
  authors?: string[] | null
  jacketFullUrl?: string | null
  jacketThumbUrl?: string | null
  site?: string | null
  serviceCode?: string | null
  extra?: {
    score?: number | null
    voteCount?: number | null
    galleryFull?: string[] | null
    galleryThumb?: string[] | null
    sampleImages?: string[] | null
    description?: string | null
    [k: string]: unknown
  } | null
}

interface JavinfoResponse {
  q: string
  source: string
  result: JavinfoResult | null
}

/** 请求 javinfo /movie（带超时 + 代理出口），非 2xx / 无结果返回 null，错误详情进 onError */
async function lookupMovie(
  code: string,
  settings: Settings,
  onError?: (m: string) => void
): Promise<JavinfoResult | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(`${BASE}/movie`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-javinfo-key': settings.javinfoKey.trim(),
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
      },
      body: JSON.stringify({ q: code }),
      signal: ctrl.signal,
      dispatcher: getDispatcher(settings)
    })
    if (res.status === 401) {
      onError?.(`Javinfo API key 无效（HTTP 401）`)
      return null
    }
    if (res.status === 402) {
      onError?.('Javinfo 余额不足（HTTP 402），已降级其他数据源')
      return null
    }
    if (res.status === 404) {
      onError?.(`Javinfo 无结果：${code}`)
      return null
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after')
      onError?.(`Javinfo 限流（HTTP 429）${retryAfter ? `，Retry-After ${retryAfter}s` : ''}`)
      return null
    }
    if (!res.ok) {
      onError?.(`Javinfo HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as JavinfoResponse
    if (!data?.result) {
      onError?.(`Javinfo 未匹配到详情页：${code}`)
      return null
    }
    console.log(
      `[javinfo] ${code} source=${data.source} title=${(data.result.titleEn || data.result.titleJa || '').slice(0, 40)} balance-header=${res.headers.get('x-balance-remaining') || '?'}`
    )
    return data.result
  } catch (e) {
    // 网络层错误（DNS/TLS/超时/连接拒绝）
    onError?.(`Javinfo 请求失败：${(e as Error)?.message || e}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 按番号抓取 javinfo 详情（聚合 DMM/FANZA → JavDB → MissAV → Javdatabase → JavLibrary），
 * 并把封面/预览图下载到本地缓存。返回的 detail.cover / samples 均为本地绝对路径。
 * 无 key / 无结果 / 网络失败 → null（不抛异常）。
 */
export async function fetchJavinfoDetail(
  code: string,
  settings: Settings,
  onError?: (m: string) => void
): Promise<JavdbDetail | null> {
  if (!hasJavinfoKey(settings)) {
    onError?.('未配置 javinfo API key（设置 → 数据源 → Javinfo Key 填写）')
    return null
  }
  // 与 javdb/javbus 一致：先提取番号，再剥 -CD/-PART/-A 等后缀（HUNTA-468CD2 → HUNTA-468）
  const codeNorm = extractBaseCode(extractCode(code)) || extractCode(code)
  if (!codeNorm) {
    onError?.('无法从文件名/标题识别番号')
    return null
  }
  const r = await lookupMovie(codeNorm, settings, onError)
  if (!r) return null

  const dvdId = (r.dvdId || codeNorm).toUpperCase()
  const title = r.titleEn || r.titleJa || dvdId
  const genres = (r.categories || []).filter(Boolean)
  const actresses = r.actresses || []
  // javinfo 不区分男女优（actresses 即演员表），全部归入 actresses，actors 保持同名列表兼容
  const actors = r.actors || [...actresses]

  // 预览图：优先全尺寸 galleryFull → javdatabase 的 sampleImages → 缩略图
  const gallery = r.extra?.galleryFull || r.extra?.sampleImages || r.extra?.galleryThumb || []
  const samples = gallery.filter((u): u is string => !!u)

  const detail: JavdbDetail = {
    uid: r.contentId || dvdId,
    code: dvdId,
    title,
    cover: r.jacketFullUrl || r.jacketThumbUrl || undefined,
    date: r.releaseDate || undefined,
    // javdb/javbus 的 duration 都是字符串（javbus 为纯数字），统一给纯数字分钟
    duration: r.runtimeMins != null ? String(r.runtimeMins) : undefined,
    director: (r.directors || [])[0] || undefined,
    studio: (r.makers || [])[0] || undefined,
    series: r.series || undefined,
    rating: r.extra?.score != null ? String(r.extra.score) : undefined,
    genres,
    actors,
    actresses,
    samples,
    parseVer: 2,
    source: 'javinfo',
    fetchedAt: Date.now()
  }

  // 本地化封面 + 预览图（并行，失败的跳过，绝不把远程 URL 写回）
  const tasks: Promise<string | null>[] = []
  if (detail.cover) {
    tasks.push(cacheRemoteImage(detail.cover, `javinfo-cover-${dvdId}`, settings, BASE))
  } else {
    tasks.push(Promise.resolve(null))
  }
  detail.samples.forEach((u, i) => {
    tasks.push(cacheRemoteImage(u, `javinfo-sample-${dvdId}-${i}`, settings, BASE))
  })
  const results = await Promise.all(tasks)
  const [coverLocal, ...sampleLocals] = results
  return {
    ...detail,
    cover: coverLocal || undefined,
    samples: sampleLocals.filter((p): p is string => !!p)
  }
}
