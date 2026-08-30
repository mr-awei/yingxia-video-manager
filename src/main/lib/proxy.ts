import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import { session } from 'electron'
import type { ProxyMode, Settings } from '../../shared/types'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export { UA }

/**
 * 按 Settings 构建 undici Dispatcher（代理出口）。
 * - none：不走代理，返回 undefined
 * - system：读取 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量（undici EnvHttpProxyAgent）
 * - http / https：标准 CONNECT 代理（ProxyAgent）
 * - socks4 / socks5：用 socks 包建立隧道，再交给 undici Agent 的自定义 connect
 * 结果按配置缓存，避免每次请求都 new 一个 Agent。
 */
let cacheKey = ''
let cacheDispatcher: Dispatcher | undefined = undefined

export function getDispatcher(settings: Settings): Dispatcher | undefined {
  const mode: ProxyMode = settings.proxyMode ?? 'none'
  const key = `${mode}|${settings.proxyHost ?? ''}|${settings.proxyPort ?? ''}|${settings.proxyUser ?? ''}|${settings.proxyPass ?? ''}`
  if (key === cacheKey) return cacheDispatcher
  cacheKey = key
  cacheDispatcher = buildDispatcher(mode, settings)
  return cacheDispatcher
}

function buildDispatcher(mode: ProxyMode, s: Settings): Dispatcher | undefined {
  if (mode === 'none') return undefined
  if (mode === 'system') return new EnvHttpProxyAgent()

  if (mode === 'http' || mode === 'https') {
    const proto = mode === 'https' ? 'https' : 'http'
    let auth = ''
    if (s.proxyUser) {
      auth = `${encodeURIComponent(s.proxyUser)}:${encodeURIComponent(s.proxyPass)}@`
    }
    const url = `${proto}://${auth}${s.proxyHost}:${s.proxyPort}`
    return new ProxyAgent(url)
  }

  // socks4 / socks5
  const type = mode === 'socks4' ? 4 : 5
  return new Agent({
    // 参数用 any：undici 的 AgentConnectOptions 与 socks 返回值类型不完全对齐，运行时行为正确
    connect: async (opts: any) => {
      const { socket } = await SocksClient.createConnection({
        proxy: {
          host: s.proxyHost,
          port: Number(s.proxyPort),
          type,
          userId: s.proxyUser || undefined,
          password: s.proxyPass || undefined
        },
        command: 'connect',
        destination: { host: opts.hostname, port: Number(opts.port) }
      })
      return socket
    }
  })
}

/** 仅用于测试连接：返回当前代理配置下能否连通目标（默认 javdb.com） */
export async function testProxyConnectivity(
  settings: Settings,
  target = 'https://javdb.com'
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const dispatcher = getDispatcher(settings)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      dispatcher,
      headers: { 'User-Agent': UA, Accept: 'text/html' }
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把代理配置同步到 Electron Chromium session —— 这样 net.fetch（主进程）和渲染进程
 * 的图片请求也会走代理，与 Node.js fetch + undici dispatcher 保持一致。
 * 必须在 app.whenReady() 之后调用（session.defaultSession 此时才可用）。
 */
export function applyProxyToSession(settings: Settings): void {
  try {
    const mode: ProxyMode = settings.proxyMode ?? 'none'
    if (mode === 'none') {
      session.defaultSession.setProxy({ mode: 'direct' })
      return
    }
    if (mode === 'system') {
      session.defaultSession.setProxy({ mode: 'system' })
      return
    }
    if (mode === 'http' || mode === 'https') {
      const proto = mode === 'https' ? 'https' : 'http'
      let auth = ''
      if (settings.proxyUser) {
        auth = `${encodeURIComponent(settings.proxyUser)}:${encodeURIComponent(settings.proxyPass)}@`
      }
      const url = `${proto}://${auth}${settings.proxyHost}:${settings.proxyPort}`
      session.defaultSession.setProxy({ proxyRules: url })
      return
    }
    // socks4 / socks5：Chromium 只支持 socks5，把 socks4 也映射过去
    const socksProto = mode === 'socks5' ? 'socks5' : 'socks5'
    let auth = ''
    if (settings.proxyUser) {
      auth = `${encodeURIComponent(settings.proxyUser)}:${encodeURIComponent(settings.proxyPass)}@`
    }
    const url = `${socksProto}://${auth}${settings.proxyHost}:${settings.proxyPort}`
    session.defaultSession.setProxy({ proxyRules: url })
  } catch {
    /* session 可能尚未 ready，静默跳过；下次 applyRuntimeSettings 会再试 */
  }
}
