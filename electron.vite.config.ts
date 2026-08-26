import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // 关闭 vite 自动清空 out（清空动作在沙箱下触发 safe-delete 拦截），由 pack 脚本显式清理
      emptyOutDir: false,
      rollupOptions: {
        // 主进程依赖 Node 内置模块与 electron，保持外部化（electron-vite 默认已处理）
        external: ['electron']
      }
    }
  },
  preload: {
    build: {
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        // 强制 CJS 输出为 .js（避免 ESM preload + contextBridge 的兼容性问题，
        // 导致渲染进程的 window.api 暴露失败）
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      emptyOutDir: false,
      rollupOptions: {
        // 渲染进程打包进浏览器环境，不外部化 react
      }
    },
    plugins: [react()]
  }
})
