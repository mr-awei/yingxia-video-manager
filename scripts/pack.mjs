/**
 * 打包入口（npm run pack 第二步，build 之后调用）。
 *
 * 输出目录放在 WorkBuddy 工作区之外（~/yingxia-release/<时间戳>），
 * WorkBuddy 的索引/监视服务扫描不到 → app.asar 永远不会被占用，
 * 彻底根治 win-unpacked\resources\app.asar 被锁导致无法删除/打包失败。
 */
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const pad = (n) => String(n).padStart(2, '0')
const d = new Date()
const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
// 输出根目录：用户主目录下，绝对在 WorkBuddy 工作区树之外（与项目目录无关）
const outRoot = path.join(os.homedir(), 'yingxia-release')
const out = path.join(outRoot, stamp)
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
