/* 诊断脚本：复现应用 fetchJavBusDetail 的完整流程（driver-verify → search → detail → DMM 图床） */
import { fetch, Agent } from 'undici'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const BASE = 'https://www.seedmm.bond'

const dispatcher = new Agent({ connect: { timeout: 15000 } })

// 1. 年龄验证（与应用 ensureJavBusAgeCookie 完全一致）
const verifyUrl = `${BASE}/doc/driver-verify?referer=${encodeURIComponent(BASE + '/')}`
console.log('[1] POST driver-verify (Submit=確認, 应用同款请求)...')
const vr = await fetch(verifyUrl, {
  method: 'POST',
  headers: { 'User-Agent': UA, Referer: BASE + '/', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'Submit=%E7%A2%BA%E8%AA%8D',
  redirect: 'manual',
  dispatcher
})
const setCookies =
  typeof vr.headers.getSetCookie === 'function' ? vr.headers.getSetCookie() : [vr.headers.get('set-cookie') || '']
console.log('    status:', vr.status, ' set-cookie:', JSON.stringify(setCookies))
const joined = setCookies.join('; ')
if (!/age=verified/.test(joined)) {
  console.log('    !! 未拿到 age=verified —— 年龄验证失败（应用会在这里 return null）')
} else {
  const sess = (joined.match(/PHPSESSID=[^;]+/) || [''])[0]
  const cookie = [sess, 'age=verified'].filter(Boolean).join('; ')
  console.log('    cookie ok:', cookie.split(';')[0] + '; age=verified')

  // 2. 搜索（与应用 searchDetailUrl 一致）
  console.log('[2] GET /search/MIDV-284&type=1 ...')
  const sr = await fetch(`${BASE}/search/MIDV-284&type=1`, {
    headers: { 'User-Agent': UA, Referer: BASE + '/', Cookie: cookie },
    dispatcher
  })
  const sh = await sr.text()
  console.log('    status:', sr.status, ' len:', sh.length, ' title:', (sh.match(/<title>([^<]+)/) || ['', '?'])[1])
  const box = sh.match(/class="movie-box"[^>]*href="([^"]+)"/)
  console.log('    movie-box:', box ? box[1] : '(无 → 搜索被验证页拦截)')

  if (box) {
    // 3. 详情页
    console.log('[3] GET 详情页', box[1], '...')
    const dr = await fetch(box[1], {
      headers: { 'User-Agent': UA, Referer: BASE + '/', Cookie: cookie },
      dispatcher
    })
    const dh = await dr.text()
    console.log('    status:', dr.status, ' len:', dh.length, ' title:', (dh.match(/<title>([^<]+)/) || ['', '?'])[1])
    const samples = [...dh.matchAll(/class="sample-box"[^>]*href="([^"]+)"/g)].map((m) => m[1])
    console.log('    sample-box 数量:', samples.length)
    samples.slice(0, 3).forEach((u) => console.log('      -', u))

    // 4. DMM 图床防盗链测试（对比 Referer 策略）
    if (samples.length > 0) {
      const url = samples[0]
      console.log('[4] 测试 DMM 图床 Referer 策略:', url)
      for (const [label, ref] of [
        ['详情页 URL', box[1]],
        ['站点根路径', BASE + '/'],
        ['无 Referer', ''],
        ['DMM 自身', 'https://www.dmm.co.jp/']
      ]) {
        try {
          const headers = { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
          if (ref) headers.Referer = ref
          const ir = await fetch(url, { headers, dispatcher })
          const buf = Buffer.from(await ir.arrayBuffer())
          console.log(`    ${label.padEnd(8)} → HTTP ${ir.status} ${buf.length}B ${ir.headers.get('content-type') ?? ''}`)
        } catch (e) {
          console.log(`    ${label.padEnd(8)} → 异常 ${e?.message ?? e}`)
        }
      }
    }
  }
}
console.log('[done]')
