import type { JavdbDetail, Settings } from '../../shared/types'
import { extractCode, cacheRemoteImage } from './javdb'
import { extractBaseCode, normalizeManualCode } from '../../shared/code'

/**
 * javapi —— 自托管本地 JAV 聚合 API（https://github.com/a1850976305/javapi）
 * 元数据来自 JavDB API + 8 个视频站，自己机器/服务器上跑，免费、无 Cloudflare / IP 风控。
 * 启动：AUTH_API_KEYS=my-secret-key go run ./cmd/api（默认监听 127.0.0.1:8080）。
 *
 * 与 javdb.ts / javbus.ts / javinfo.ts 的约定一致：失败返回 null（不抛异常），onError 收集原因；
 * 封面/截图抓取后本地缓存，返回的 detail.cover / samples 均为本地路径。
 */

const DEFAULT_URL = 'http://127.0.0.1:8080'

/**
 * javapi 首次查询需要聚合 8 个上游视频站，实测耗时约 90s（之后 5 分钟内存缓存秒回）。
 * 超时必须 > 聚合耗时，否则请求被客户端 abort（"This operation was aborted"）。
 * 120s：90s 聚合 + 30s 余量。
 */
const JAVAPI_TIMEOUT_MS = 120_000

/** 本地 javapi 已配置（URL + Key 都填了才算） */
export function hasJavapiConfig(settings: Settings): boolean {
  return !!(settings.javapiKey && settings.javapiKey.trim()) && !!(settings.javapiUrl && settings.javapiUrl.trim())
}

/** javapi 响应里 `movie` 的形状（只声明用到的字段，其余忽略） */
interface JavapiMovie {
  id?: string | null
  number?: string | null
  title?: string | null
  origin_title?: string | null
  thumb_url?: string | null
  cover_url?: string | null
  duration?: number | null
  score?: number | null
  release_date?: string | null
  preview_images?: string[] | null
  summary?: string | null
  actors?: string[] | null
  tags?: string[] | null
  director_name?: string | null
  maker_name?: string | null
  publisher_name?: string | null
  series_name?: string | null
}

interface JavapiResponse {
  code?: string | null
  movie?: JavapiMovie | null
}

/** 请求本地 javapi /api/v1/search（带超时），非 2xx / 无结果返回 null，错误详情进 onError */
async function lookupMovie(
  code: string,
  settings: Settings,
  onError?: (m: string) => void
): Promise<JavapiMovie | null> {
  const base = (settings.javapiUrl || DEFAULT_URL).trim().replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), JAVAPI_TIMEOUT_MS)
  try {
    // 本地服务直连，不走代理（本机回环不存在风控问题）
    const res = await fetch(`${base}/api/v1/search?code=${encodeURIComponent(code)}`, {
      headers: {
        'X-API-Key': settings.javapiKey.trim(),
        Accept: 'application/json'
      },
      signal: ctrl.signal
    })
    if (res.status === 401) {
      onError?.('本地 Javapi API key 无效（HTTP 401）')
      return null
    }
    if (res.status === 400) {
      onError?.(`本地 Javapi 请求参数错误（HTTP 400）：${code}`)
      return null
    }
    if (res.status === 502) {
      onError?.('本地 Javapi 所有上游数据源均失败（HTTP 502）')
      return null
    }
    if (!res.ok) {
      onError?.(`本地 Javapi HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as JavapiResponse
    if (!data?.movie) {
      // 无结果正常静默（与 javdb/javbus 约定一致，不触发批量失败计数）
      return null
    }
    console.log(`[javapi] ${code} title=${(data.movie.title || '').slice(0, 40)}`)
    return data.movie
  } catch (e) {
    // 本地服务未启动 / 端口不对 / 超时（首次聚合约 90s，超时为 120s）
    onError?.(
      `本地 Javapi 连接失败（${base}）：${(e as Error)?.message || e}` +
        ((e as Error)?.name === 'AbortError' ? '（首次查询需聚合约 90 秒，请耐心等待）' : '')
    )
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 按番号请求本地 javapi 详情（JavDB API 元数据），并把封面/预览图下载到本地缓存。
 * 返回的 detail.cover / samples 均为本地绝对路径。
 * 未配置 / 无结果 / 服务未启动 → null（不抛异常）。
 */
export async function fetchJavapiDetail(
  code: string,
  settings: Settings,
  onError?: (m: string) => void,
  /** v2.3.12：true = code 是用户手工输入的番号（已是确定值）。
   *  自动提取失败时直接采用它，不再套「从文件名猜番号」的启发式——
   *  否则 476MLA-203 这类数字开头的番号会被判为「无法识别番号」。 */
  manual = false
): Promise<JavdbDetail | null> {
  if (!hasJavapiConfig(settings)) {
    onError?.('未配置本地 Javapi（设置 → 数据源 → Javapi URL / Key）')
    return null
  }
  // 与其他源一致：先提取番号，再剥 -CD/-PART/-A 等后缀（HUNTA-468CD2 → HUNTA-468）
  const autoCode = extractBaseCode(extractCode(code)) || extractCode(code)
  const codeNorm = autoCode || (manual ? normalizeManualCode(code) : '')
  if (!codeNorm) {
    onError?.('无法从文件名/标题识别番号')
    return null
  }
  const m = await lookupMovie(codeNorm, settings, onError)
  if (!m) return null

  const dvdId = (m.number || codeNorm).toUpperCase()
  const title = m.title || m.origin_title || dvdId

  const detail: JavdbDetail = {
    uid: m.id || dvdId,
    code: dvdId,
    title,
    cover: m.cover_url || m.thumb_url || undefined,
    date: m.release_date || undefined,
    duration: m.duration != null ? String(m.duration) : undefined,
    director: m.director_name || undefined,
    studio: m.maker_name || undefined,
    series: m.series_name || undefined,
    rating: m.score != null ? String(m.score) : undefined,
    genres: (m.tags || []).filter(Boolean),
    actors: m.actors || [],
    actresses: m.actors || [],
    samples: (m.preview_images || []).filter((u): u is string => !!u),
    parseVer: 2,
    source: 'javapi',
    fetchedAt: Date.now()
  }

  // 本地化封面 + 预览图（并行，失败的跳过，绝不把远程 URL 写回）
  // javapi 封面来自 javdb 图床，referer 传 javdb.com 更稳
  const referer = 'https://javdb.com'
  const tasks: Promise<string | null>[] = []
  if (detail.cover) {
    tasks.push(cacheRemoteImage(detail.cover, `javapi-cover-${dvdId}`, settings, referer))
  } else {
    tasks.push(Promise.resolve(null))
  }
  detail.samples.forEach((u, i) => {
    tasks.push(cacheRemoteImage(u, `javapi-sample-${dvdId}-${i}`, settings, referer))
  })
  const results = await Promise.all(tasks)
  const [coverLocal, ...sampleLocals] = results
  return {
    ...detail,
    cover: coverLocal || undefined,
    samples: sampleLocals.filter((p): p is string => !!p)
  }
}
