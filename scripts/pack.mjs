/**
 * 打包入口（npm run pack 第二步，build 之后调用）。
 *
 * 每次打包自动在 release/ 下新建一个带时间戳的全新输出目录：
 *   release/2026-08-29-2156/影匣 Setup 1.9.3.exe
 * 旧目录永不复用 → 彻底规避 win-unpacked\resources\app.asar
 * 被进程/杀软锁住无法删除导致的打包失败（ERR_ELECTRON_BUILDER_CANNOT_EXECUTE）。
 */
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const pad = (n) => String(n).padStart(2, '0')
const d = new Date()
const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
const out = path.join('release', stamp)
mkdirSync(out, { recursive: true })
console.log(`[pack] 输出目录：${out}`)

// 用绝对路径传给 electron-builder，避免相对路径歧义
const absOut = path.resolve(out)
execSync(`npx electron-builder --config.directories.output="${absOut}"`, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  }
})
