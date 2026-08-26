import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // 同时打到 console，主进程会捕获并落盘
    console.error('[ErrorBoundary]', error?.message, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      const e = this.state.error
      return (
        <div className="h-full w-full flex items-center justify-center p-8 bg-ink-900 text-white overflow-auto">
          <div className="max-w-3xl w-full">
            <div className="text-red-400 text-xl font-semibold mb-3">⚠ 渲染层崩溃</div>
            <div className="text-white/90 text-sm font-mono mb-3 break-all">
              {e.message || String(e)}
            </div>
            {e.stack ? (
              <pre className="text-white/60 text-xs whitespace-pre-wrap break-all bg-ink-800 rounded-lg p-3 max-h-96 overflow-auto">
                {e.stack}
              </pre>
            ) : null}
            <div className="text-white/40 text-xs mt-3">
              详细信息已写入 %APPDATA%\local-video-manager\renderer-console.log，可发给 AI 排查。
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
