// 打包前清理脚本：显式删除 out / release，避免 vite/electron-builder 在沙箱下
// 触发 safe-delete（trash 重定向）拦截报错。用法：node scripts/clean.mjs
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
for (const dir of ['out', 'release']) {
  const target = path.join(root, dir)
  rmSync(target, { recursive: true, force: true })
  console.log(`cleaned ${dir}/`)
}
