import type { SortKey } from '../../../shared/types'
import Icon from './Icon'
import type { SmartFilter } from './Sidebar'

interface Props {
  libraryName?: string
  categoryLabel: string | null
  smart: SmartFilter
  onSmart: (s: SmartFilter) => void
  resultCount: number
  sort: SortKey
  onSort: (s: SortKey) => void
  desc: boolean
  onToggleDesc: () => void
  groupMode: 'grouped' | 'flat'
  onToggleGroup: () => void
  viewMode: 'grid' | 'list'
  onToggleView: () => void
  onClearAll: () => void
  hasActiveFilters: boolean
  mismatch?: { missing: number; unlisted: number } | null
  onShowReconcile: () => void
}

const SORT_LABELS: Record<SortKey, string> = {
  added: '最近添加',
  title: '名称',
  year: '年份',
  score: '评分',
  lastPlayed: '最近播放',
  random: '随机'
}

const SMARTS: { key: SmartFilter; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'all', label: '全部', icon: 'grid' },
  { key: 'favorite', label: '收藏', icon: 'heart' },
  { key: 'recent', label: '最近播放', icon: 'clock' },
  { key: 'unrated', label: '未评分', icon: 'alert' },
  { key: 'nocover', label: '缺封面', icon: 'image' }
]

export default function BrowseBar(props: Props) {
  const {
    libraryName, categoryLabel, smart, onSmart, resultCount,
    sort, onSort, desc, onToggleDesc, groupMode, onToggleGroup,
    viewMode, onToggleView, onClearAll, hasActiveFilters, mismatch, onShowReconcile
  } = props

  const crumbs: string[] = []
  if (libraryName) crumbs.push(libraryName)
  if (categoryLabel) crumbs.push(categoryLabel)
  const smartLabel = SMARTS.find((s) => s.key === smart)?.label
  if (smart !== 'all' && smartLabel && !categoryLabel) crumbs.push(smartLabel)

  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      {/* 面包屑 */}
      <div className="flex items-center gap-1.5 text-sm min-w-0">
        {crumbs.length === 0 ? (
          <span className="text-white/70 font-medium">全部影片</span>
        ) : (
          crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5 min-w-0">
              {i > 0 ? <Icon name="chevronRight" size={13} className="text-white/30 shrink-0" /> : null}
              <span className={i === crumbs.length - 1 ? 'text-white font-medium truncate' : 'text-white/45 truncate'}>
                {c}
              </span>
            </span>
          ))
        )}
        <span className="text-white/35 text-xs tabular-nums ml-1">· {resultCount} 部</span>
        {mismatch ? (
          <button
            className="ml-2 h-6 px-2 rounded-md flex items-center gap-1 bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30 text-[11px] font-medium hover:bg-amber-500/25 transition-colors"
            onClick={onShowReconcile}
            title="简介与文件夹不一致，点击查看对账"
          >
            <Icon name="alert" size={11} />
            {mismatch.missing + mismatch.unlisted} 处差异
          </button>
        ) : null}
      </div>

      <div className="flex-1" />

      {/* 快捷过滤 chips */}
      <div className="flex items-center gap-1 flex-wrap">
        {SMARTS.map((s) => {
          const active = smart === s.key
          return (
            <button
              key={s.key}
              onClick={() => onSmart(s.key)}
              className={`h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium transition-colors ${
                active
                  ? s.key === 'favorite'
                    ? 'bg-brand text-white'
                    : 'bg-ink-700 text-white ring-1 ring-white/15'
                  : 'bg-ink-800/60 hover:bg-ink-700 text-white/70'
              }`}
              title={s.label}
            >
              <Icon name={s.icon} size={12} className={active ? 'fill-current' : ''} />
              {s.label}
            </button>
          )
        })}
      </div>

      {/* 排序 */}
      <select
        className="h-8 bg-ink-700 text-white text-sm rounded-lg px-2 outline-none ring-1 ring-transparent focus:ring-brand/50 cursor-pointer"
        value={sort}
        onChange={(e) => onSort(e.target.value as SortKey)}
        title="排序方式"
      >
        {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
          <option key={k} value={k}>
            {SORT_LABELS[k]}
          </option>
        ))}
      </select>
      <button
        className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${
          desc ? 'bg-brand/20 text-brand' : 'bg-ink-700 hover:bg-ink-600 text-white/70'
        }`}
        onClick={onToggleDesc}
        title={desc ? '当前降序，点击切升序' : '当前升序，点击切降序'}
      >
        <Icon name="sort" size={14} />
      </button>

      {/* 分组 / 视图 */}
      <button
        className={`h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium transition-colors ${
          groupMode === 'flat' ? 'bg-brand/15 text-brand ring-1 ring-brand/40' : 'bg-ink-700 hover:bg-ink-600 text-white/70'
        }`}
        onClick={onToggleGroup}
        title={groupMode === 'flat' ? '全库混合模式' : '按分类分组'}
      >
        <Icon name={groupMode === 'flat' ? 'list' : 'layers'} size={13} />
        {groupMode === 'flat' ? '全库' : '分组'}
      </button>
      <button
        className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${
          viewMode === 'list' ? 'bg-brand/20 text-brand' : 'bg-ink-700 hover:bg-ink-600 text-white/70'
        }`}
        onClick={onToggleView}
        title={viewMode === 'list' ? '列表视图' : '网格视图'}
      >
        <Icon name={viewMode === 'list' ? 'list' : 'grid'} size={14} />
      </button>

      {hasActiveFilters ? (
        <button
          className="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-medium bg-white/8 hover:bg-white/15 text-white/80 transition-colors"
          onClick={onClearAll}
          title="清除所有筛选"
        >
          <Icon name="x" size={12} />
          清除筛选
        </button>
      ) : null}
    </div>
  )
}
