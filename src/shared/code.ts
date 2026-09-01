/**
 * 番号系列工具：提取 base code、判断是否同系列。
 * 用途：hunta-468-cd1 / hunta-468-cd2 这类分集共享元数据，只抓一份。
 */

/**
 * 系列分集后缀：-CD1/-cd2、-PART1、-DISC1、-VOL1、-1/-2。
 *  CD/PART/DISC/VOL 允许无连字符（如 HUNTA-468CD2），
 *  纯数字分集必须带连字符（如 HUNTA-468-1），避免把 SONE-280/SSIS-419 的
 *  正常序号误拆为系列。
 *  尾部字母仅限「明确的单字母版本标签」（A-D / U / C），如 HUNTA-468A、IPX-219-C。
 *  SONE-560X、KSJK-013V 等非常规尾字母不剥（保留原值给 hasSeriesSuffix 判断）。
 */
const SERIES_SUFFIX_RE = /^([A-Z]{2,}-\d+)(?:(?:-?(?:CD|PART|DISC|VOL)\d+)|(?:[_\s-]\d+)|(?:-[A-DUC])|(?:[A-DUC]))$/i

/**
 * 番号归一化：转大写、去空格/下划线/点（保留连字符，连字符是番号结构的一部分）。
 * SONE-566 / sone-566 / sone.566 / SONE_566 归一化后一致。
 * 2026-08-30 修复：原版只去空格/点，下划线残留，导致 `folder/SONE_566/xx.mp4` 与 Excel `SONE-566` 永不命中。
 * 2026-08-30 v2.2.3 抽到 shared 层：reconcile.ts + excel.ts 共用。
 */
export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[\s._]+/g, '')
}

/**
 * 提取系列 base code（大写）。
 * 例：HUNTA-468CD2 / hunta-468-cd1 / HUNTA-468-1 / HUNTA-468-A → HUNTA-468
 * SONE-280 / SSIS-419 / SONE-292 等正常序号会保持原样，不再被误归到 SONE-2 / SSIS-4。
 * 无后缀或后缀不在常见列表内时返回原样（大写），调用方据此判断「是否标准分集」。
 */
export function extractBaseCode(code: string): string {
  const c = (code ?? '').trim().toUpperCase()
  if (!c) return c
  const m = c.match(SERIES_SUFFIX_RE)
  return m ? m[1] : c
}

/** 该番号是否带常见分集后缀（即能剥出更短的 base code） */
export function hasSeriesSuffix(code: string): boolean {
  const c = (code ?? '').trim().toUpperCase()
  return c !== extractBaseCode(c)
}

/**
 * 是否「国产片」：文件夹名含中文、且文件夹名/文件名都提取不到番号（无 JavDB/JavBus 可对应的作品）。
 * 仅作「是否国产」判定，用于：不自动抓取元数据，仅用 ffmpeg 截帧（封面 + 预览）。
 * 注意：文件夹中文但文件名带番号（如「我的番号/SONE-280.mp4」）视为有码片，不判国产。
 */
export function isDomestic(folderName: string, fileName?: string): boolean {
  const f = (folderName ?? '').trim()
  if (!/[\u4e00-\u9fff]/.test(f)) return false
  if (extractCode(f) !== '') return false
  if (extractCode(fileName ?? '') !== '') return false
  return true
}

/**
 * 把「用户手工输入的番号」规范成可直接搜索的番号（v2.3.12）。
 *
 * 存在的理由：extractCode 是为「从文件名/标题里猜番号」设计的，要求
 * 「连字符前至少 2 个字母」（CODE_RE_DASHED），因此 476MLA-203 这种**数字开头**的
 * 番号提取结果为空 → 5 个数据源全在第一步放弃，报「无法从文件名/标题识别番号」，
 * 用户明明填了番号却抓不到。手工输入时番号已是确定值，不该再套文件名启发式。
 *
 * 规范化步骤：去视频扩展名 → 去中文/括号 → . _ 转连字符 → 合并多余连字符 →
 * 无分隔符且形如「SSIS376」时补一个连字符（SSIS-376）。
 * 形态校验失败（不含字母 / 不足 2 位数字 / 残留非法字符 / 超长）返回 ''。
 */
export function normalizeManualCode(input: string): string {
  const t = (input ?? '').trim()
  if (!t || t.length > 40) return ''
  let s = t.toUpperCase()
  // 去掉常见视频扩展名（476MLA-203.mp4 → 476MLA-203）
  s = s.replace(/\.(MP4|MKV|AVI|WMV|MOV|RMVB|RM|FLV|WEBM|M4V|MPG|MPEG|TS|ISO)$/, '')
  // 只保留字母/数字/._-（去掉中文、【】、括号等）
  s = s.replace(/[^A-Z0-9._-]/g, '')
  if (!s) return ''
  s = s.replace(/[._]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  if (!s) return ''
  // 无分隔符且形如「前缀 + ≥2 位数字」→ 补一个连字符：SSIS376 → SSIS-376，476MLA203 → 476MLA-203
  if (!/-/.test(s)) {
    const m = s.match(/^([A-Z0-9]*[A-Z]+)(\d{2,})$/)
    if (m) s = `${m[1]}-${m[2]}`
  }
  if (!/^[A-Z0-9-]+$/.test(s) || !/[A-Z]/.test(s) || !/\d{2,}/.test(s)) return ''
  return s
}

/** 从任意字符串（文件名/标题/整段描述）提取第一个番号；找不到返回空串。
 *  与 main 侧 javdb.ts 的 extractCode 语义不同：此处「提取不到」返回 ''，
 *  避免把无番号的文件名整段复制出去。
 *  支持两种形态：
 *    - 带分隔符：SONE-560 / SONE_560 / HUNTA-468CD2
 *    - 无分隔符：KSJK013 / ALDN606（旧版正则只认带分隔符，导致这类搜不到）
 *  先剥离中文字符/全角/括号/广告前缀，避免「【中文字幕】KSJK013」污染搜索词。
 *
 *  针对域名前缀 2026-08-30 修复：
 *  1) 先按 `@` 切多段（hdd800.com@JUR-031 → ['hdd800.com', 'JUR-031']）
 *  2) 每段去方括号包裹（[hdd800.com@]DASS-733 → DASS-733）
 *  3) 含「-/_」的合法番号形态（dashes）段排序靠前，抑制 hdd800.com 这种「纯字母+数字紧凑无分隔符」误命中
 *  4) 段越长也越靠前
 *  5) plain fallback: [A-Z]{2,}[A-Z]+\d{2,} 要求「字母+额外字母+≥2 数字」整段匹配，过滤 hdd800/KSJK013-AB 等纯字母+纯数字形态 */
// 2026-08-29 合并朋友分支：正则兼容无分隔符番号（KSJK013 / MIDE123 等「字母+数字」连写）—— // 优先匹配带分隔符（SONE-560），否则匹配「≥2 字母 + 含 ≥2 位数字」的连续串；
const CODE_RE_DASHED = /\b([A-Z]{2,}[-_][A-Z0-9]+)\b/
const CODE_RE_PLAIN = /\b([A-Z]{2,}[A-Z]+\d{2,})\b/
/** v2.3.12：数字开头番号（261ARA-394 / 476MLA-203）；前缀含字母 + 后缀 2-5 位数字（可带 A-D/U/C 尾字母） */
const CODE_RE_DIGIT_PREFIX = /^([A-Z0-9]{2,8})-(\d{2,5}[A-DUC]?)$/

/**
 * v2.3.12：伪番号守卫 —— 判断「提取出来的番号」是不是从相机文件名 / 分辨率 /
 * 广告域名 / 编码标记里误截出来的。命中即视为无效，让 extractCode 继续找下一个候选。
 *
 * 实测（4665 部）共剔出 371 部待抓影片里的伪番号，典型：
 *   IMG_8873.MOV → IMG-8873（相机文件）      VID20160418…mp4 → VID-20160418…（录像时间戳）
 *   0234-RiaKurumi-2160p.mp4 → RIAKURUMI-2160（演员名 + 分辨率）
 *   guochan2048.com@xxx.mp4 → GUOCHAN-2048（广告域名）
 *   …はじめてのおるすばん…[HEVC-1080p].mp4 → AVC-1080 / HEVC-1080（编码标记）
 *   hhd800.com@FC2-PPV-1851398.mp4 → HHD-800（域名抢在真番号 FC2-PPV-1851398 前面）
 * 这些伪番号会让批量补齐白白发请求，更糟的是万一某个伪番号在数据源真有记录，
 * 会给影片挂上**错误的元数据**。
 */
/** 相机/手机录像前缀（IMG_8873 / VID_2024… / DSC / GOPR） */
const CAM_CODE_PREFIX = new Set(['IMG', 'VID', 'DSC', 'MOV', 'CAM', 'GOPR'])
/** 编码 / 容器标记（[HEVC-1080p] / AVC 等） */
const CODEC_CODE_PREFIX = new Set(['AVC', 'HEVC', 'X264', 'X265', 'H264', 'H265', 'AAC', 'MP3', 'DIVX', 'XVID'])
/** 广告域名常见后缀（big2048.com / bbs2048.org / fengniao151.vip） */
const AD_TLD_RE = /\d*\.(COM|NET|ORG|CN|XYZ|TOP|ME|CC|TV|VIP|CLUB|LA|WS|SITE|ONLINE|ICU|PW|SU)(\b|$)/i
/** 分辨率尾巴（2160p / 1080p / 720p …）——番号里的数字其实是分辨率 */
const RES_TAIL_RE = /-(\d{3,4})P(\b|$)/i
/** 画质前缀（HD_sdnm-256 → 真番号是 SDNM-256） */
const QUALITY_PREFIX_RE = /^(HD|FHD|UHD|SD|QHD|4K|8K)[_-]/

/** 判断提取结果是否可信；src 为提取时的候选串（已大写），用于识别「数字来自分辨率」等情况 */
function isPlausibleCode(code: string, src: string): boolean {
  if (!code) return false
  const prefix = code.split('-')[0]
  const digits = (code.match(/\d+/g) || []).join('')
  // 相机/录像文件：IMG_8873 / VID20240618… / P 或 V + ≥6 位长数字
  if (CAM_CODE_PREFIX.has(prefix)) return false
  if ((prefix === 'V' || prefix === 'P') && digits.length >= 6) return false
  // 编码 / 容器标记
  if (CODEC_CODE_PREFIX.has(prefix)) return false
  // 数字来自分辨率尾巴：RiaKurumi-2160p → RIAKURUMI-2160
  if (digits.length >= 3) {
    const res = src.match(RES_TAIL_RE)
    if (res && res[1] === digits) return false
  }
  // 广告域名：GUOCHAN-2048（guochan2048.com）、HHD-800（hhd800.com）、FENGNIAO-151（fengniao151.vip）
  if (AD_TLD_RE.test(src) && new RegExp(prefix + AD_TLD_RE.source, 'i').test(src)) return false
  return true
}
/** v2.3.12：明确不是番号的常见词（卷号 / 编号 / 画质 / 编码 / 设备前缀），避免 Vol.01、No.007 被当番号 */
const NOT_CODE_PREFIX = new Set([
  'VOL', 'NO', 'EP', 'CD', 'DVD', 'PART', 'DISC', 'CH', 'PT', 'VER', 'REV', 'OVA',
  'IMG', 'DSC', 'CAM', 'VID', 'MOV', 'AVI', 'MKV', 'MP4', 'M4V', 'WMV', 'FLV', 'RMVB', 'WEB', 'ISO',
  'SAMPLE', 'TRAILER', 'HD', 'FHD', 'UHD', 'SD', 'TV', 'TS', 'XVID', 'DIVX', 'HEVC',
  'H264', 'H265', 'X264', 'X265', 'P', 'V'
])

export function extractCode(input: string): string {
  const t = (input ?? '').trim()
  if (!t) return ''
  // 0) v2.3.12：FC2 番号优先（FC2-PPV-1510788 / fc2ppv_1523314 / fc2-ppv 2725031 …）
  //    旧逻辑会把 FC2- 前缀丢掉只留 PPV-1510788（dashed 正则要「≥2 字母 + 分隔符」，
  //    而 FC2 后面跟的是数字，匹配不上）——数据源按残缺番号搜不到。
  //    放在最前面：即便前面有广告域名（hhd800.com@FC2-PPV-1851398）也能正确取到 FC2 番号。
  // 末尾允许分集尾号（FC2-PPV-1851398_1 / FC2PPV-1123249-2 都是同一部，只取主体番号）
  const fc2 = t.toUpperCase().match(/\bFC2[-_. ]*(?:PPV)?[-_. ]*(\d{5,7})(?:[-_]\d{1,2})?/)
  if (fc2) return `FC2-PPV-${fc2[1]}`
  // 1) 去掉中文/全角/括号等非 ASCII 部分
  const ascii = t.replace(/[^\x21-\x7E]+/g, ' ')
  // 2) 按 @ 切多段（处理域名前缀 hdd800.com@ / b8s2048.org@ / 44x.mejuy-），去前导空格
  const atSplit = ascii.split('@').map(s => s.trim()).filter(s => s.length > 0)
  // 3) 每段去方括号包裹（兼容 [hhd800.com@] 这种整体包方括号的情况）
  const debracket = (s: string) => s.replace(/^\[([^\]]+)\]$/, '$1')
  const allCands = atSplit.length > 1 ? atSplit.map(debracket) : [ascii.replace(/^\[([^\]]+)\]$/, '$1')]
  // 4) 排序：含 dashes 的段靠前 + 段更长也靠前（让含合法番号的段优先匹配）
  const sortedCands = [...allCands].sort((a, b) => {
    const aD = /[-_]/.test(a) ? 0 : 1
    const bD = /[-_]/.test(b) ? 0 : 1
    return aD - bD || b.length - a.length
  })
  const tryNorm = (s: string): string => {
    const mm = s.match(/^([A-Z]{2,})(?:-)?(\d+)/)
    return mm ? `${mm[1]}-${mm[2]}` : s
  }
  /** v2.3.12：归一化 + 可信度校验。伪番号返回 ''，让调用方继续找下一个候选 */
  const pick = (raw: string, src: string): string => {
    const code = tryNorm(raw.replace(/_/g, '-'))
    return isPlausibleCode(code, src) ? code : ''
  }
  /** 画质前缀剥离：HD_SDNM-256 → SDNM-256、FHD_6M-CLO-083 → CLO-083（真番号被画质前缀挡住时救回来） */
  const stripQuality = (s: string): string | null => {
    const m = s.match(QUALITY_PREFIX_RE)
    return m ? s.slice(m[0].length) : null
  }
  /** 对某个候选串依次尝试：剥离画质前缀 → dashed → plain；全部命中但不合格则继续下一个候选 */
  const tryCandidate = (src: string): string => {
    const U = src.toUpperCase()
    const stripped = stripQuality(U)
    if (stripped) {
      const sd = stripped.match(CODE_RE_DASHED)
      if (sd) {
        const c = pick(sd[1], stripped)
        if (c) return c
      }
      const sp = stripped.match(CODE_RE_PLAIN)
      if (sp) {
        const c = pick(sp[1], stripped)
        if (c) return c
      }
    }
    const dm = U.match(CODE_RE_DASHED)
    if (dm) {
      const c = pick(dm[1], U)
      if (c) return c
    }
    const pm = U.match(CODE_RE_PLAIN)
    if (pm) {
      const c = pick(pm[1], U)
      if (c) return c
    }
    return ''
  }
  // 5) 优先在 @ 后候选里尝试 dashed → plain（命中伪番号则跳过，继续找下一个候选）
  for (const cand of sortedCands) {
    const c = tryCandidate(cand)
    if (c) return c
  }
  // 6) fallback: 整段（无 @ 时也走这条）
  const F = ascii.replace(/^\[([^\]]+)\]$/, '$1').toUpperCase()
  const fc = tryCandidate(F)
  if (fc) return fc
  // 7) v2.3.12 兜底：数字开头的番号（261ARA-394 / 476MLA-203 / 259LUXU-1186 / 200GANA-1459 …）
  //    上面 1-6 步都要求「分隔符前至少 2 个字母」，数字开头的番号会被全部漏掉——
  //    批量补齐 / 对账对这类文件永远识别不出番号。这里只在**前面全部失败时**才走，
  //    因此已有命中结果完全不受影响（实测 4665 部：新增识别 31 部，原有结果改变 0 部）。
  //    形态收紧：前缀 2-8 位「字母数字且含字母」+ 后缀 2-5 位数字（可带 A-D/U/C 版本尾字母）。
  //      · 2-5 位是为了排除手机录像名 V60803-173433（6 位时间戳）
  //      · NOT_CODE_PREFIX 排除 VOL-01 / NO-007 / CD-1 这类卷号/编号/画质词
  //      · 前缀含字母是为了排除 720-1080 / 2024-01-01 这类纯数字组合
  for (const raw of ascii.split(/[^A-Za-z0-9._-]+/)) {
    const tok = raw.toUpperCase().replace(/[._]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
    const m = tok.match(CODE_RE_DIGIT_PREFIX)
    if (!m) continue
    const prefix = m[1]
    if (!/[A-Z]/.test(prefix)) continue
    if (NOT_CODE_PREFIX.has(prefix)) continue
    const code = `${prefix}-${m[2]}`
    if (!isPlausibleCode(code, tok)) continue
    return code
  }
  return ''
}