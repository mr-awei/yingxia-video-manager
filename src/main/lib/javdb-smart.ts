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
import { fetchJavdbDetail } from './javdb'
import { fetchJavBusDetail } from './javbus'
import { fetchJavLibraryDetail } from './javlibrary'
import type { JavdbDetail, Settings } from '../../shared/types'

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
    stop: false
  }
}

export async function fetchDetailSmart(
  code: string,
  settings: Settings,
  state: SmartFetchState
): Promise<MovieDetailResult> {
  const mode = settings.dataSource ?? 'auto'
  const errors: string[] = []
  const onError = (m: string) => errors.push(m)
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
  // ---- auto：按自定义/推荐优先级降级 ----
  // 推荐顺序（信息全面度 / 获取难度 / 风控）：Javapi → Javinfo → JavDB → JavBus → JavLibrary
  // 用户可在设置里自定义 1-5 优先级（customSourceOrder）
  const DEFAULT_SOURCE_ORDER: Array<'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary'> = [
    'javapi',
    'javinfo',
    'javdb',
    'javbus',
    'javlibrary'
  ]
  const order =
    settings.customSourceOrder && settings.customSourceOrder.length === 5
      ? settings.customSourceOrder
      : DEFAULT_SOURCE_ORDER
  const javdbErrs: string[] = []
  const javbusErrs: string[] = []
  for (const src of order) {
    if (state.stop) break
    if (src === 'javapi') {
      if (hasJavapiConfig(settings) && !state.javapiDisabled) {
        const errs: string[] = []
        try {
          const javapi = await fetchJavapiDetail(code, settings, (m) => errs.push(m))
          if (javapi) {
            state.javapiFails = 0
            return { detail: javapi, source: 'javapi' }
          }
        } catch (e) {
          errs.push(`Javapi 异常：${(e as Error)?.message || e}`)
        }
        if (errs.length > 0) {
          state.javapiFails++
          if (state.javapiFails >= JAVAPI_CONSECUTIVE_LIMIT) {
            state.javapiDisabled = true
            console.log(`[batch] Javapi 连续网络失败 ${state.javapiFails} 部，本轮自动跳过`)
          }
        }
      } else if (!hasJavapiConfig(settings)) {
        errors.push('未配置本地 Javapi，跳过')
      }
    } else if (src === 'javinfo') {
      if (hasJavinfoKey(settings) && !state.javinfoDisabled) {
        const errs: string[] = []
        try {
          const javinfo = await fetchJavinfoDetail(code, settings, (m) => errs.push(m))
          if (javinfo) {
            state.javinfoFails = 0
            return { detail: javinfo, source: 'javinfo' }
          }
        } catch (e) {
          errs.push(`Javinfo 异常：${(e as Error)?.message || e}`)
        }
        if (errs.length > 0) {
          state.javinfoFails++
          if (state.javinfoFails >= JAVINFO_CONSECUTIVE_LIMIT) {
            state.javinfoDisabled = true
            console.log(`[batch] Javinfo 连续网络失败 ${state.javinfoFails} 部，本轮自动跳过`)
          }
        }
      } else if (!hasJavinfoKey(settings)) {
        errors.push('未配置 Javinfo key，跳过')
      }
    } else if (src === 'javdb') {
      if (!state.javdbDisabled) {
        try {
          const javdb = await fetchJavdbDetail(code, settings, (m) => javdbErrs.push(m))
          if (javdb) {
            state.javdbFails = 0
            return { detail: javdb, source: 'javdb' }
          }
        } catch (e) {
          javdbErrs.push(`JavDB 异常：${(e as Error)?.message || e}`)
        }
        if (javdbErrs.length > 0) {
          state.javdbFails++
          if (state.javdbFails >= JAVDB_CONSECUTIVE_LIMIT) {
            state.javdbDisabled = true
            console.log(`[batch] JavDB 连续网络失败 ${state.javdbFails} 部，本轮自动跳过`)
          }
        }
      }
    } else if (src === 'javbus') {
      try {
        const javbus = await fetchJavBusDetail(code, settings, (m) => javbusErrs.push(m))
        if (javbus) {
          state.javbusFails = 0
          return { detail: javbus, source: 'javbus' }
        }
      } catch (e) {
        javbusErrs.push(`JavBus 异常：${(e as Error)?.message || e}`)
      }
      if (javbusErrs.length > 0) {
        state.javbusFails++
        if (state.javbusFails >= JAVBUS_CONSECUTIVE_LIMIT) {
          state.stop = true
          javbusErrs.push(`JavBus 连续网络失败 ${state.javbusFails} 部，已自动停止`)
        }
      }
    } else {
      // javlibrary：不计数（数据与 javdb/javbus 重叠度高，纯兜底，静默）
      try {
        const javlibrary = await fetchJavLibraryDetail(code, settings)
        if (javlibrary) return { detail: javlibrary, source: 'javlibrary' }
      } catch {
        /* 静默 */
      }
    }
  }
  const allErrs = [...javdbErrs, ...javbusErrs]
  return { detail: null, error: allErrs.length ? allErrs.join('；') : '未知原因' }
}
