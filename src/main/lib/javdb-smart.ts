/**
 * 批量智能抓取（Javapi → Javinfo → JavDB → JavBus → JavLibrary）。
 * v2.2.4 抽到独立模块：原在 ipc.ts 内，reconcile.ts 需要在「无片单兜底」分支
 * 直接调它来抓 javdbDetail，不能反向 import ipc.ts（会循环依赖）。
 *
 * 数据源顺序：Javapi（本地免费）→ Javinfo（免风控）→ JavDB → JavBus → JavLibrary。
 * 任一源连续**网络失败** N 部 → 本轮自动禁用该源（不再浪费请求）；
 * 「搜索无结果 / 无法识别番号」属正常结果（该番号数据源确实没有），**不计数、不触发停止**——
 * 只有真正的网络/会话异常（请求失败、超时、年龄验证失败等）才累计失败次数，
 * 避免「IP 没被封、只是数据源没这个番号」时批量被误停；JavBus 作为最后兜底，连续网络失败即停止整批。
 */
import { fetchJavapiDetail, hasJavapiConfig } from './javapi'
import { fetchJavinfoDetail, hasJavinfoKey } from './javinfo'
import { fetchJavdbDetail, searchJavdb, cacheRemoteImage } from './javdb'
import { fetchJavBusDetail } from './javbus'
import { fetchJavLibraryDetail } from './javlibrary'
import { extractBaseCode, extractCode } from '../../shared/code'
import type { JavdbDetail, Settings, Video } from '../../shared/types'

export interface MovieDetailResult {
  detail: JavdbDetail | null
  /** 命中来源（success 时） */
  source?: 'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary'
  /** 全部失败时的原因描述 */
  error?: string
}

export interface SmartFetchState {
  /** Javapi 已被连续失败禁用（本轮不再尝试，本地服务可能没起） */
  javapiDisabled: boolean
  javapiFails: number
  /** Javinfo 已被连续失败禁用（本轮不再尝试，保留免费额度） */
  javinfoDisabled: boolean
  javinfoFails: number
  /** JavDB 已被连续失败禁用（本轮不再尝试） */
  javdbDisabled: boolean
  javdbFails: number
  javbusFails: number
  /** 全部停止 */
  stop: boolean
  /** 用户暂停 */
  paused: boolean
}

const JAVAPI_CONSECUTIVE_LIMIT = 3
const JAVINFO_CONSECUTIVE_LIMIT = 3
const JAVDB_CONSECUTIVE_LIMIT = 3
const JAVBUS_CONSECUTIVE_LIMIT = 3

export function createSmartFetchState(): SmartFetchState {
  return {
    javapiDisabled: false,
    javapiFails: 0,
    javinfoDisabled: false,
    javinfoFails: 0,
    javdbDisabled: false,
    javdbFails: 0,
    javbusFails: 0,
    stop: false,
    paused: false
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** 如果用户点了暂停，则在此处轮询直到恢复或停止 */
export async function waitIfPaused(state: SmartFetchState): Promise<void> {
  while (state.paused && !state.stop) {
    await wait(200)
  }
}

/**
 * 按 settings.customSourceOrder 依次降级抓取**海报**（只下载封面图，不写 detail）。
 * v2.2.8 修复：原 fetchJavdbPosterForVideo 只硬走 JavDB search，不读用户自定义顺序——
 * 用户把 JavDB 排后面或 JavDB 被风控时，海报抓取仍硬试 JavDB 而失败。
 *
 * 各源返回约定：
 * - javdb.searchJavdb → { posterUrl }（远程 URL，需 cacheRemoteImage）
 * - javbus/javlibrary/javinfo/javapi fetchXxxDetail → detail.cover（内部已下载到本地）
 * 命中第一个有 cover 的源即返回本地路径。
 */
export async function fetchPosterSmart(video: Video, settings: Settings): Promise<string | null> {
  const rawCode = extractCode(video.title || video.folderName || video.fileName || '')
  const code = extractBaseCode(rawCode) || rawCode
  if (!code) return null
  const order =
    settings.customSourceOrder && settings.customSourceOrder.length === 5
      ? settings.customSourceOrder
      : DEFAULT_SOURCE_ORDER
  for (const src of order) {
    try {
      if (src === 'javdb') {
        const hit = await searchJavdb(code, settings)
        if (hit?.posterUrl) {
          const local = await cacheRemoteImage(hit.posterUrl, `javdb-${hit.code.replace(/[^A-Za-z0-9]/g, '')}`, settings)
          if (local) return local
        }
      } else if (src === 'javbus') {
        const d = await fetchJavBusDetail(code, settings)
        if (d?.cover) return d.cover // fetchJavBusDetail 内部已下载到本地
      } else if (src === 'javlibrary') {
        const d = await fetchJavLibraryDetail(code, settings)
        if (d?.cover) return d.cover
      } else if (src === 'javinfo') {
        if (hasJavinfoKey(settings)) {
          const d = await fetchJavinfoDetail(code, settings)
          if (d?.cover) return d.cover
        }
      } else if (src === 'javapi') {
        if (hasJavapiConfig(settings)) {
          const d = await fetchJavapiDetail(code, settings)
          if (d?.cover) return d.cover
        }
      }
    } catch {
      /* 单源失败继续下一个 */
    }
  }
  return null
}

export const DEFAULT_SOURCE_ORDER: Array<'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary'> = [
  'javapi',
  'javinfo',
  'javdb',
  'javbus',
  'javlibrary'
]

/** v2.2.10：抓取事件回调（每次源尝试推一条），供 UI 实时展示"javdb 失败 → 降级 javbus" */
export interface SmartFetchEvent {
  code: string
  src: 'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary'
  status: 'trying' | 'hit' | 'skipped' | 'no-result' | 'network-failed'
  detail?: string
}

export async function fetchDetailSmart(
  rawInput: string,
  settings: Settings,
  state: SmartFetchState,
  onEvent?: (e: SmartFetchEvent) => void
): Promise<MovieDetailResult> {
  // v2.2.14：入口统一清洗搜索番号 — 之前三处调用方（ipc 单点/批量补齐、reconcile 兜底）
  // 都直接把 v.title / folderName / fileName 原样当 code 传，遇到 SONE-560_1 / 【中文字幕】SONE-280
  // 这种脏字符串时，JavDB/JavBus 搜不到。fetchPosterSmart 已经做对了，这里在 fetchDetailSmart
  // 入口统一 extractCode → extractBaseCode，所有调用方自动受益。
  const rawCode = extractCode(rawInput)
  const code = extractBaseCode(rawCode) || rawCode || rawInput.trim()
  const mode = settings.dataSource ?? 'auto'
  const errors: string[] = []
  const onError = (m: string) => errors.push(m)
  const ev = (e: Omit<SmartFetchEvent, 'code'>) => onEvent?.({ code, ...e })
  if (mode === 'javapi') {
    try {
      const javapi = await fetchJavapiDetail(code, settings, onError)
      if (javapi) return { detail: javapi, source: 'javapi' }
    } catch (e) {
      errors.push(`Javapi 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'Javapi 未返回结果' }
  }
  if (mode === 'javinfo') {
    try {
      const javinfo = await fetchJavinfoDetail(code, settings, onError)
      if (javinfo) return { detail: javinfo, source: 'javinfo' }
    } catch (e) {
      errors.push(`Javinfo 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'Javinfo 未返回结果' }
  }
  if (mode === 'javdb') {
    const errs: string[] = []
    try {
      const javdb = await fetchJavdbDetail(code, settings, (m) => errs.push(m))
      if (javdb) return { detail: javdb, source: 'javdb' }
    } catch (e) {
      errs.push(`JavDB 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errs.length ? errs.join('；') : 'JavDB 未返回结果' }
  }
  if (mode === 'javbus') {
    const errs: string[] = []
    try {
      const javbus = await fetchJavBusDetail(code, settings, (m) => errs.push(m))
      if (javbus) return { detail: javbus, source: 'javbus' }
    } catch (e) {
      errs.push(`JavBus 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errs.length ? errs.join('；') : 'JavBus 未返回结果' }
  }
  if (mode === 'javlibrary') {
    const errs: string[] = []
    try {
      const javlibrary = await fetchJavLibraryDetail(code, settings, (m) => errs.push(m))
      if (javlibrary) return { detail: javlibrary, source: 'javlibrary' }
    } catch (e) {
      errs.push(`JavLibrary 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errs.length ? errs.join('；') : 'JavLibrary 未返回结果' }
  }
  // ---- auto：按自定义/推荐优先级降级 ----
  // 推荐顺序（信息全面度 / 获取难度 / 风控）：Javapi → Javinfo → JavDB → JavBus → JavLibrary
  // 用户可在设置里自定义 1-5 优先级（customSourceOrder）；DEFAULT_SOURCE_ORDER 已在模块底部 export
  const order =
    settings.customSourceOrder && settings.customSourceOrder.length === 5
      ? settings.customSourceOrder
      : DEFAULT_SOURCE_ORDER
  // v2.2.9：每次抓取开头打印当前生效的顺序 + 番号，让用户能在 userData/logs/main.log 里
  // 直接看到"这次跑的是 javdb→javbus→..."而不是猜（之前的 [search]/[javbus] log 滚动太快看不清顺序）
  console.log(`[smart] ${code} order=${order.join('→')}`)
  // v2.2.6 修复：完整记录每个源的结果（"跳过" / "无结果" / "抓到了" / "网络失败"），
  // 让用户清楚看到 5 个源都跑了哪些、为什么最终失败。errors 数组合并到最终的 return error。
  const srcResults: Array<{ src: string; status: 'hit' | 'skipped' | 'no-result' | 'network-failed'; detail?: string }> = []
  for (const src of order) {
    if (state.stop) break
    await waitIfPaused(state)
    if (state.stop) break
    if (src === 'javapi') {
      if (hasJavapiConfig(settings) && !state.javapiDisabled) {
        const errs: string[] = []
        ev({ src, status: 'trying' })
        try {
          const javapi = await fetchJavapiDetail(code, settings, (m) => errs.push(m))
          if (javapi) {
            state.javapiFails = 0
            srcResults.push({ src, status: 'hit' })
            ev({ src, status: 'hit' })
            console.log(`[smart] ${code} HIT ${src}`)  // v2.2.9：每次命中打 log
            return { detail: javapi, source: 'javapi' }
          }
          srcResults.push({ src, status: 'no-result' })
          ev({ src, status: 'no-result' })
        } catch (e) {
          const d = (e as Error)?.message || String(e)
          srcResults.push({ src, status: 'network-failed', detail: d })
          ev({ src, status: 'network-failed', detail: d })
        }
        if (errs.length > 0) {
          state.javapiFails++
          if (state.javapiFails >= JAVAPI_CONSECUTIVE_LIMIT) {
            state.javapiDisabled = true
            console.log(`[batch] Javapi 连续网络失败 ${state.javapiFails} 部，本轮自动跳过`)
          }
        }
      } else {
        const d = 'javapi-not-configured'
        srcResults.push({ src, status: 'skipped', detail: d })
        ev({ src, status: 'skipped', detail: d })
      }
    } else if (src === 'javinfo') {
      if (hasJavinfoKey(settings) && !state.javinfoDisabled) {
        const errs: string[] = []
        ev({ src, status: 'trying' })
        try {
          const javinfo = await fetchJavinfoDetail(code, settings, (m) => errs.push(m))
          if (javinfo) {
            state.javinfoFails = 0
            srcResults.push({ src, status: 'hit' })
            ev({ src, status: 'hit' })
            console.log(`[smart] ${code} HIT ${src}`)
            return { detail: javinfo, source: 'javinfo' }
          }
          srcResults.push({ src, status: 'no-result' })
          ev({ src, status: 'no-result' })
        } catch (e) {
          const d = (e as Error)?.message || String(e)
          srcResults.push({ src, status: 'network-failed', detail: d })
          ev({ src, status: 'network-failed', detail: d })
        }
        if (errs.length > 0) {
          state.javinfoFails++
          if (state.javinfoFails >= JAVINFO_CONSECUTIVE_LIMIT) {
            state.javinfoDisabled = true
            console.log(`[batch] Javinfo 连续网络失败 ${state.javinfoFails} 部，本轮自动跳过`)
          }
        }
      } else {
        const d = 'javinfo-not-configured'
        srcResults.push({ src, status: 'skipped', detail: d })
        ev({ src, status: 'skipped', detail: d })
      }
    } else if (src === 'javdb') {
      if (!state.javdbDisabled) {
        const errs: string[] = []
        ev({ src, status: 'trying' })
        try {
          const javdb = await fetchJavdbDetail(code, settings, (m) => errs.push(m))
          if (javdb) {
            state.javdbFails = 0
            srcResults.push({ src, status: 'hit' })
            ev({ src, status: 'hit' })
            console.log(`[smart] ${code} HIT ${src}`)
            return { detail: javdb, source: 'javdb' }
          }
          srcResults.push({ src, status: 'no-result' })
          ev({ src, status: 'no-result' })
        } catch (e) {
          const d = (e as Error)?.message || String(e)
          srcResults.push({ src, status: 'network-failed', detail: d })
          ev({ src, status: 'network-failed', detail: d })
        }
        if (errs.length > 0) {
          state.javdbFails++
          if (state.javdbFails >= JAVDB_CONSECUTIVE_LIMIT) {
            state.javdbDisabled = true
            console.log(`[batch] JavDB 连续网络失败 ${state.javdbFails} 部，本轮自动跳过`)
          }
        }
      } else {
        const d = 'javdb-disabled'
        srcResults.push({ src, status: 'skipped', detail: d })
        ev({ src, status: 'skipped', detail: d })
      }
    } else if (src === 'javbus') {
      const errs: string[] = []
      ev({ src, status: 'trying' })
      try {
        const javbus = await fetchJavBusDetail(code, settings, (m) => errs.push(m))
        if (javbus) {
          state.javbusFails = 0
          srcResults.push({ src, status: 'hit' })
          ev({ src, status: 'hit' })
          console.log(`[smart] ${code} HIT ${src}`)
          return { detail: javbus, source: 'javbus' }
        }
        srcResults.push({ src, status: 'no-result' })
        ev({ src, status: 'no-result' })
      } catch (e) {
        const d = (e as Error)?.message || String(e)
        srcResults.push({ src, status: 'network-failed', detail: d })
        ev({ src, status: 'network-failed', detail: d })
      }
      if (errs.length > 0) {
        state.javbusFails++
        if (state.javbusFails >= JAVBUS_CONSECUTIVE_LIMIT) {
          state.stop = true
          srcResults.push({ src, status: 'network-failed', detail: `javbus-stopped:${state.javbusFails}` })
        }
      }
    } else {
      // javlibrary：不计数（数据与 javdb/javbus 重叠度高，纯兜底，静默）
      ev({ src, status: 'trying' })
      try {
        const javlibrary = await fetchJavLibraryDetail(code, settings)
        if (javlibrary) {
          srcResults.push({ src, status: 'hit' })
          ev({ src, status: 'hit' })
          console.log(`[smart] ${code} HIT ${src}`)
          return { detail: javlibrary, source: 'javlibrary' }
        }
        srcResults.push({ src, status: 'no-result' })
        ev({ src, status: 'no-result' })
      } catch {
        srcResults.push({ src, status: 'network-failed' })
        ev({ src, status: 'network-failed' })
      }
    }
  }
  // v2.2.6 修：完整 5 源结果拼成错误消息（用户能看到"5 个源全试了"而不是只看到跳过提示）
  const STATUS_LABEL: Record<typeof srcResults[number]['status'], string> = {
    hit: '命中',
    skipped: '跳过',
    'no-result': '无结果',
    'network-failed': '网络失败'
  }
  const summary = srcResults
    .map((r) => {
      const label = STATUS_LABEL[r.status]
      return r.detail ? `${r.src}=${label}(${r.detail})` : `${r.src}=${label}`
    })
    .join('；')
  // v2.2.9：所有源都失败时打印完整 summary（让 userData/logs/main.log 里有清晰抓取记录）
  console.log(`[smart] ${code} FAILED: ${summary}`)
  return { detail: null, error: summary || '未知原因' }
}
