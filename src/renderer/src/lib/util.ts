/** lm:// URL 结果缓存（同一路径只编码一次，大库滚动时避免重复 base64） */
const posterUrlCache = new Map<string, string>()

/**
 * 把本地绝对路径构造成 lm:// 协议 URL（主进程 lm:// 协议处理器返回图片）；远程 URL 直接透传。
 * @param version 封面缓存失效版本号：手动设为封面后文件内容变了但路径不变，
 *                传一个自增版本号让 URL 带 ?v=N，强制 Chromium 重新请求（主进程只解析 pathname，query 被忽略）
 */
export function posterUrl(posterPath?: string, version?: number | string): string | null {
  if (!posterPath) return null
  if (/^https?:\/\//.test(posterPath)) return posterPath
  const cacheKey = version != null ? `${posterPath}\u0000v${version}` : posterPath
  const cached = posterUrlCache.get(cacheKey)
  if (cached) return cached
  const bytes = new TextEncoder().encode(posterPath)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  const b64 = btoa(bin)
  const url = `lm://poster/${encodeURIComponent(b64)}${version != null ? `?v=${version}` : ''}`
  if (posterUrlCache.size > 5000) posterUrlCache.clear() // 防无限增长
  posterUrlCache.set(cacheKey, url)
  return url
}

/**
 * 解析一个条目的最佳封面路径（与 EntryCard 展示优先级一致）。
 * 优先级：手动设的封面(manual) > javdbDetail.cover(本地真实海报) > 非截帧来源的 posterPath >
 * ffmpeg 截帧 posterPath。用于相关推荐等场景，避免"列表有真实海报、相关推荐只看 posterPath 显示占位"的不一致。
 */
export function resolveEntryPoster(v?: { posterPath?: string; posterSource?: string; javdbDetail?: { cover?: string } }): string | null {
  if (!v) return null
  const manualPoster = v.posterSource === 'manual' && v.posterPath ? v.posterPath : null
  const detailCover = v.javdbDetail?.cover && !/^https?:\/\//.test(v.javdbDetail.cover) ? v.javdbDetail.cover : null
  const realPoster =
    v.posterPath &&
    v.posterSource &&
    v.posterSource !== 'ffmpeg' &&
    v.posterSource !== 'placeholder' &&
    v.posterSource !== 'manual'
      ? v.posterPath
      : null
  return manualPoster ?? detailCover ?? realPoster ?? v.posterPath ?? null
}

export function formatSize(bytes?: number): string {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function formatDuration(sec?: number): string {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}小时${m}分`
  return `${m}分钟`
}

/** 取标题首字符作为占位图大字符 */
export function titleInitial(title: string): string {
  return (title ?? '').trim().charAt(0).toUpperCase() || '?'
}

/** 取番号次要文本（去连字符/下划线，前 10 字符）用于占位图小字 */
export function titleSecondary(code: string): string {
  const c = (code ?? '').trim().toUpperCase().replace(/[-_.\s]/g, '')
  return c.slice(0, 10) || '?'
}

/**
 * 大厂风格多层渐变占位背景（参考 Netflix/Disney+/Apple TV 卡片占位）。
 * 三层叠加：左上径向高光 + 右下径向阴影 + 主对角渐变，立体感强。
 */
export function placeholderGradient(code: string): string {
  let h = 0
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360
  // 邻近色相家族：主色 h、微移 h2（+40°）做自然过渡、补色 h3（+220°）做暗角
  const h2 = (h + 40) % 360
  const h3 = (h + 220) % 360
  // 大厂风格（参考 Netflix/TMDB/Disney+ 卡片占位）：
  // 甜点区 = 色相清晰（饱和度 40-48%）+ 中低亮度（15-36%）→ 不刺眼、不显脏
  // 主渐变同家族邻近色（h → h2），自然不生硬；左上高光亮于主色、右下暗角压场
  return (
    `radial-gradient(ellipse 90% 70% at 30% 18%, hsla(${h2},48%,36%,0.6), transparent 62%),` +
    `radial-gradient(ellipse 110% 90% at 80% 95%, hsla(${h3},42%,12%,0.65), transparent 60%),` +
    `linear-gradient(150deg, hsl(${h},44%,22%), hsl(${h2},46%,15%))`
  )
}
