/**
 * 首页骨架屏：Hero 占位 + 五行 Row 骨架。
 * 与 HomeView 真实布局同尺寸（Hero 300px、Row 卡片 w-56/w-36 + aspect），
 * 数据加载完成后无缝替换为真实内容，避免「黑屏几秒 → 大空隙」的视觉断层。
 */
export default function HomeSkeleton({
  aspect = 'landscape',
  label
}: {
  aspect?: 'portrait' | 'landscape'
  label?: string
}) {
  const ROWS = ['随机推荐', '最近添加', '评分最高', '最近播放', '我的收藏']
  const cardW = aspect === 'landscape' ? 'w-56' : 'w-36'
  const cardH = aspect === 'landscape' ? 'aspect-video' : 'aspect-[2/3]'
  return (
    <div className="h-full overflow-auto thin-scroll p-5">
      {label ? <div className="text-white/40 text-xs mb-3">{label}</div> : null}

      {/* Hero 占位：与真实 Hero 同高 300px */}
      <div className="rounded-2xl mb-7 h-[300px] bg-white/[0.04] ring-1 ring-white/5 overflow-hidden relative">
        <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-white/[0.02] via-white/[0.07] to-white/[0.02] bg-[length:200%_100%]" />
      </div>

      {/* 五行 Row 骨架 */}
      {ROWS.map((t) => (
        <section key={t} className="mb-6" aria-hidden="true">
          <div className="flex items-center justify-between mb-2.5 px-0.5">
            <div className="h-4 w-24 rounded bg-white/[0.07] animate-pulse" />
            <div className="h-3 w-14 rounded bg-white/[0.05] animate-pulse" />
          </div>
          <div className="flex gap-3 overflow-hidden pb-2 -mx-1 px-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className={`${cardW} shrink-0`}>
                <div
                  className={`${cardH} w-full rounded-xl bg-white/[0.05] animate-pulse`}
                  style={{ animationDelay: `${(i % 4) * 120}ms` }}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
