import { memo, useMemo, useState, type ReactNode } from 'react'
import type { Library } from '../../../shared/types'
import Icon, { type IconName } from './Icon'

export interface TagInfo {
  tag: string
  count: number
  category: string
}

export interface SectionInfo {
  name: string
  order: number
  count: number
}

export interface MetaFacet {
  name: string
  count: number
}

export type ViewName = 'home' | 'browse'
export type SmartFilter = 'all' | 'favorite' | 'recent' | 'unrated' | 'nocover'

interface Props {
  view: ViewName
  smart: SmartFilter
  onNav: (view: ViewName, smart?: SmartFilter) => void

  libraries: Library[]
  libraryId: string
  onLibrary: (id: string) => void
  onEditLibrary: () => void
  onAddLibrary: () => void

  /** 我的清单计数 */
  favoriteCount: number
  recentCount: number

  /** 筛选：分类 */
  sections: SectionInfo[]
  selectedCategory: string | null
  onToggleCategory: (cat: string) => void
  onClearCategory: () => void

  /** 筛选：标签 */
  tags: TagInfo[]
  categories: string[]
  selected: Set<string>
  onToggle: (tag: string) => void
  onClear: () => void

  /** 筛选：演员/片商/系列 */
  actorFacets: MetaFacet[]
  studioFacets: MetaFacet[]
  seriesFacets: MetaFacet[]
  selectedActors: Set<string>
  selectedStudios: Set<string>
  selectedSeries: Set<string>
  onToggleActor: (v: string) => void
  onToggleStudio: (v: string) => void
  onToggleSeries: (v: string) => void
  onClearActors: () => void
  onClearStudios: () => void
  onClearSeries: () => void
  onClearMetaFilters: () => void

  collapsed: boolean
  onToggleCollapsed: () => void

  onOpenStats: () => void
  onOpenAbout: () => void
  onOpenSettings: () => void
}

const PER_CAT_LIMIT = 10

/** 外层可折叠段（导航 / 媒体库 / 我的 / 筛选） */
function Section({
  title,
  icon,
  count,
  onClear,
  children,
  defaultOpen = true,
  active
}: {
  title: string
  icon: IconName
  count?: number
  onClear?: () => void
  children: ReactNode
  defaultOpen?: boolean
  active?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-white/5 last:border-b-0">
      <button
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-ink-800/40 transition-colors"
        onClick={() => setOpen((o) => !o)}
        title={open ? '收起此段' : '展开此段'}
      >
        <div className={`flex items-center gap-1.5 font-semibold text-[12px] ${active ? 'text-brand' : 'text-white/90'}`}>
          <Icon name={icon} size={12} className={active ? 'text-brand' : 'text-brand/80'} />
          <span>{title}</span>
          {count ? (
            <span className="px-1.5 rounded-full bg-brand/15 text-brand text-[10px] font-bold">{count}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5">
          {onClear && count ? (
            <button
              className="no-drag h-5 px-1.5 rounded text-[10px] text-white/50 hover:text-white hover:bg-ink-700 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                onClear()
              }}
              title="清除此段筛选"
            >
              清除
            </button>
          ) : null}
          <Icon
            name="chevronDown"
            size={14}
            className={`text-white/40 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
          />
        </div>
      </button>
      {open ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  )
}

/** 元信息 facet 单组（演员 / 片商 / 系列） */
function FacetGroup({
  title,
  icon,
  facets,
  selected,
  onToggle,
  onClear
}: {
  title: string
  icon: IconName
  facets: MetaFacet[]
  selected: Set<string>
  onToggle: (v: string) => void
  onClear: () => void
}) {
  const [closed, setClosed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const show = expanded ? facets : facets.slice(0, PER_CAT_LIMIT)
  const selCount = selected.size
  return (
    <div className="mb-2.5 last:mb-0">
      <button
        className="w-full flex items-center justify-between py-1 px-0.5 rounded hover:bg-ink-800/60 transition-colors"
        onClick={() => setClosed((c) => !c)}
        title={closed ? '展开' : '收起'}
      >
        <span className="flex items-center gap-1 text-white/55 text-[11px] font-medium tracking-wide">
          <Icon name="chevronDown" size={11} className={`transition-transform duration-200 ${closed ? '-rotate-90' : ''}`} />
          <Icon name={icon} size={11} className="opacity-70" />
          <span>{title}</span>
          {selCount > 0 ? (
            <span className="px-1.5 rounded-full bg-brand/15 text-brand text-[10px] font-bold">{selCount}</span>
          ) : null}
        </span>
        <div className="flex items-center gap-1">
          {selCount > 0 ? (
            <button
              className="no-drag h-5 px-1.5 rounded text-[10px] text-white/50 hover:text-white hover:bg-ink-700 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                onClear()
              }}
            >
              清除
            </button>
          ) : null}
          <Icon name={closed ? 'chevronRight' : 'chevronDown'} size={11} className="text-white/30" />
        </div>
      </button>
      {!closed ? (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {facets.length === 0 ? (
            <span className="text-white/30 text-[11px]">暂无</span>
          ) : (
            show.map((f) => {
              const sel = selected.has(f.name)
              return (
                <button
                  key={f.name}
                  onClick={() => onToggle(f.name)}
                  className={`h-6 px-1.5 rounded-md text-[11px] flex items-center gap-1 transition-all max-w-full ${
                    sel
                      ? 'bg-brand text-white shadow-sm shadow-brand/30 font-medium'
                      : 'bg-white/6 hover:bg-white/12 text-white/75 hover:text-white'
                  }`}
                  title={f.name}
                >
                  {sel ? <Icon name="check" size={10} className="shrink-0" /> : null}
                  <span className="max-w-[100px] truncate">{f.name}</span>
                  <span className={sel ? 'opacity-75 text-[10px]' : 'opacity-50 text-[10px]'}>{f.count}</span>
                </button>
              )
            })
          )}
          {facets.length > PER_CAT_LIMIT ? (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="h-6 px-1.5 rounded-md text-[11px] bg-white/5 hover:bg-white/10 text-white/50"
            >
              {expanded ? '收起' : `+${facets.length - PER_CAT_LIMIT}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  badge
}: {
  icon: IconName
  label: string
  active?: boolean
  onClick: () => void
  badge?: number
}) {
  return (
    <button
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] transition-colors ${
        active ? 'bg-brand/15 text-brand font-medium' : 'text-white/75 hover:bg-ink-700 hover:text-white'
      }`}
      onClick={onClick}
    >
      <Icon name={icon} size={15} className={active ? 'text-brand' : 'text-white/55'} />
      <span className="flex-1 text-left truncate">{label}</span>
      {badge ? <span className="text-[10px] text-white/40 tabular-nums">{badge}</span> : null}
    </button>
  )
}

function SidebarInner(props: Props) {
  const {
    view, smart, onNav, libraries, libraryId, onLibrary, onEditLibrary, onAddLibrary,
    favoriteCount, recentCount,
    sections, selectedCategory, onToggleCategory, onClearCategory,
    tags, categories, selected, onToggle, onClear,
    actorFacets, studioFacets, seriesFacets,
    selectedActors, selectedStudios, selectedSeries,
    onToggleActor, onToggleStudio, onToggleSeries,
    onClearActors, onClearStudios, onClearSeries, onClearMetaFilters,
    collapsed, onToggleCollapsed,
    onOpenStats, onOpenAbout, onOpenSettings
  } = props

  const [collapsedTagCats, setCollapsedTagCats] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const grouped = useMemo(() => {
    const map = new Map<string, TagInfo[]>()
    for (const cat of categories) map.set(cat, [])
    for (const t of tags) {
      const list = map.get(t.category) ?? []
      list.push(t)
      map.set(t.category, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.count - a.count)
    return map
  }, [tags, categories])

  const totalSelected = selected.size
  const metaSelectedCount = selectedActors.size + selectedStudios.size + selectedSeries.size

  if (collapsed) {
    return (
      <aside className="w-12 shrink-0 border-r border-white/5 bg-ink-850/80 flex flex-col items-center py-3">
        <button
          className="no-drag w-8 h-8 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-ink-700 transition-colors"
          onClick={onToggleCollapsed}
          title="展开侧栏"
        >
          <Icon name="chevronRight" size={16} />
        </button>
        <div className="mt-2 flex flex-col items-center gap-1">
          <button className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${view === 'home' ? 'bg-brand/20 text-brand' : 'text-white/60 hover:text-white hover:bg-ink-700'}`} onClick={() => onNav('home')} title="首页">
            <Icon name="home" size={16} />
          </button>
          <button className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${view === 'browse' && smart === 'all' ? 'bg-brand/20 text-brand' : 'text-white/60 hover:text-white hover:bg-ink-700'}`} onClick={() => onNav('browse', 'all')} title="全部影片">
            <Icon name="grid" size={16} />
          </button>
          {favoriteCount > 0 ? (
            <button className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${view === 'browse' && smart === 'favorite' ? 'bg-brand/20 text-brand' : 'text-white/60 hover:text-white hover:bg-ink-700'}`} onClick={() => onNav('browse', 'favorite')} title="收藏">
              <Icon name="heart" size={16} />
            </button>
          ) : null}
        </div>
        <div className="mt-3 text-[10px] text-white/40 [writing-mode:vertical-rl] tracking-widest">筛选</div>
        <div className="mt-auto flex flex-col items-center gap-1 pt-2 border-t border-white/5 w-full">
          <button className="w-8 h-8 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-ink-700 transition-colors" onClick={onOpenStats} title="统计看板">
            <Icon name="chart" size={15} />
          </button>
          <button className="w-8 h-8 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-ink-700 transition-colors" onClick={onOpenAbout} title="关于">
            <Icon name="info" size={15} />
          </button>
          <button className="w-8 h-8 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-ink-700 transition-colors" onClick={onOpenSettings} title="设置">
            <Icon name="sliders" size={15} />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="w-[240px] shrink-0 border-r border-white/5 bg-ink-850/80 flex flex-col overflow-hidden">
      {/* 顶部条 */}
      <div className="h-10 shrink-0 flex items-center justify-between px-3 border-b border-white/5">
        <div className="flex items-center gap-1.5 text-white/90 font-semibold text-[12px]">
          <Icon name="layers" size={12} className="text-brand" />
          导航
        </div>
        <button
          className="no-drag w-6 h-6 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-ink-700 transition-colors"
          onClick={onToggleCollapsed}
          title="收起侧栏"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-auto thin-scroll">
        {/* 导航 */}
        <div className="px-2 py-2 flex flex-col gap-0.5">
          <NavItem icon="home" label="首页" active={view === 'home'} onClick={() => onNav('home')} />
          <NavItem
            icon="grid"
            label="全部影片"
            active={view === 'browse' && smart === 'all'}
            onClick={() => onNav('browse', 'all')}
          />
        </div>

        {/* 媒体库 */}
        <Section title="媒体库" icon="folder" active={false}>
          <div className="flex flex-col gap-0.5">
            {libraries.length === 0 ? (
              <div className="text-white/35 text-[11px] py-1 px-1">还没有媒体库</div>
            ) : (
              libraries.map((l) => {
                const sel = l.id === libraryId
                return (
                  <div
                    key={l.id}
                    className={`group/lib flex items-center gap-1 rounded-lg transition-colors ${
                      sel ? 'bg-brand/15' : 'hover:bg-ink-700'
                    }`}
                  >
                    <button
                      className={`flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
                        sel ? 'text-brand font-medium' : 'text-white/80 hover:text-white'
                      }`}
                      onClick={() => onLibrary(l.id)}
                      title={l.name}
                    >
                      <Icon name="film" size={13} className={sel ? 'text-brand shrink-0' : 'text-white/45 shrink-0'} />
                      <span className="truncate">{l.name}</span>
                    </button>
                    {sel ? (
                      <button
                        className="no-drag w-6 h-6 mr-1 rounded flex items-center justify-center text-white/45 hover:text-white hover:bg-ink-600 transition-colors shrink-0"
                        onClick={onEditLibrary}
                        title="库设置"
                      >
                        <Icon name="sliders" size={12} />
                      </button>
                    ) : null}
                  </div>
                )
              })
            )}
            <button
              className="mt-1 flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[13px] text-brand hover:bg-brand/10 transition-colors"
              onClick={onAddLibrary}
            >
              <Icon name="plus" size={13} />
              添加媒体库
            </button>
          </div>
        </Section>

        {/* 我的清单 */}
        <Section title="我的清单" icon="heart">
          <div className="flex flex-col gap-0.5">
            <NavItem icon="heart" label="收藏" badge={favoriteCount} active={view === 'browse' && smart === 'favorite'} onClick={() => onNav('browse', 'favorite')} />
            <NavItem icon="clock" label="最近播放" badge={recentCount} active={view === 'browse' && smart === 'recent'} onClick={() => onNav('browse', 'recent')} />
            <NavItem icon="alert" label="未评分" active={view === 'browse' && smart === 'unrated'} onClick={() => onNav('browse', 'unrated')} />
            <NavItem icon="image" label="缺封面" active={view === 'browse' && smart === 'nocover'} onClick={() => onNav('browse', 'nocover')} />
          </div>
        </Section>

        {/* 筛选：分类 */}
        <Section title="分类" icon="folder" count={selectedCategory ? 1 : 0} onClear={onClearCategory} active={!!selectedCategory}>
          {sections.length === 0 ? (
            <div className="text-white/35 text-[11px] py-1">暂无分类</div>
          ) : (
            <div className="flex flex-col gap-0.5 max-h-[180px] overflow-auto thin-scroll -mr-1 pr-1">
              {sections.map((s) => {
                const sel = selectedCategory === s.name
                const empty = s.count === 0
                return (
                  <button
                    key={s.name}
                    onClick={() => onToggleCategory(s.name)}
                    disabled={empty && !sel}
                    className={`flex items-center justify-between gap-1.5 px-1.5 py-1 rounded-md text-[12px] transition-colors text-left ${
                      sel ? 'bg-brand text-white font-medium' : empty ? 'text-white/30 cursor-not-allowed' : 'hover:bg-ink-700 text-white/80 hover:text-white'
                    }`}
                    title={s.name}
                  >
                    {sel ? <Icon name="check" size={10} className="shrink-0" /> : <Icon name="folder" size={10} className="shrink-0 opacity-50" />}
                    <span className="flex-1 min-w-0 truncate">{s.name}</span>
                    <span className={sel ? 'text-[10px] opacity-80 tabular-nums' : 'text-[10px] text-white/40 tabular-nums'}>{s.count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </Section>

        {/* 筛选：标签 */}
        <Section title="标签" icon="tag" count={totalSelected} onClear={onClear} active={totalSelected > 0}>
          {tags.length === 0 ? <div className="text-white/35 text-xs py-2 text-center">暂无标签</div> : null}
          {categories.map((cat) => {
            const list = grouped.get(cat) ?? []
            if (list.length === 0) return null
            const catClosed = !!collapsedTagCats[cat]
            const isExpanded = !!expanded[cat]
            const show = isExpanded ? list : list.slice(0, PER_CAT_LIMIT)
            return (
              <div key={cat} className="mb-2.5 last:mb-0 group/cat">
                <button
                  className="w-full flex items-center justify-between py-1 rounded px-0.5 hover:bg-ink-800/60 transition-colors"
                  onClick={() => setCollapsedTagCats((p) => ({ ...p, [cat]: !p[cat] }))}
                  title={catClosed ? '展开此分类' : '收起此分类'}
                >
                  <span className="flex items-center gap-1 text-white/55 text-[11px] font-medium tracking-wide">
                    <Icon name="chevronDown" size={11} className={`transition-transform duration-200 ${catClosed ? '-rotate-90' : ''}`} />
                    {cat}
                  </span>
                  <span className="text-white/35 text-[10px] tabular-nums">{list.length}</span>
                </button>
                {!catClosed ? (
                  <div className="flex flex-wrap gap-1 mt-0.5 animate-fadeIn-fast">
                    {show.map((t) => {
                      const sel = selected.has(t.tag)
                      const zero = t.count === 0 && !sel
                      return (
                        <button
                          key={t.tag}
                          onClick={() => onToggle(t.tag)}
                          disabled={zero}
                          className={`h-6 px-1.5 rounded-md text-[11px] flex items-center gap-1 transition-all max-w-full ${
                            sel ? 'bg-brand text-white shadow-sm shadow-brand/30 font-medium' : zero ? 'bg-white/3 text-white/30 cursor-not-allowed' : 'bg-white/6 hover:bg-white/12 text-white/75 hover:text-white'
                          }`}
                          title={t.tag}
                        >
                          {sel ? <Icon name="check" size={10} className="shrink-0" /> : null}
                          <span className="max-w-[100px] truncate">{t.tag}</span>
                          <span className={sel ? 'opacity-75 text-[10px]' : 'opacity-50 text-[10px]'}>{t.count}</span>
                        </button>
                      )
                    })}
                    {list.length > PER_CAT_LIMIT ? (
                      <button onClick={() => setExpanded((p) => ({ ...p, [cat]: !p[cat] }))} className="h-6 px-1.5 rounded-md text-[11px] bg-white/5 hover:bg-white/10 text-white/50">
                        {isExpanded ? '收起' : `+${list.length - PER_CAT_LIMIT}`}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </Section>

        {/* 女演员 / 片商 / 系列 */}
        <Section title="女演员 / 片商 / 系列" icon="users" count={metaSelectedCount} onClear={onClearMetaFilters} active={metaSelectedCount > 0}>
          <FacetGroup title="女演员" icon="users" facets={actorFacets} selected={selectedActors} onToggle={onToggleActor} onClear={onClearActors} />
          <FacetGroup title="片商" icon="building" facets={studioFacets} selected={selectedStudios} onToggle={onToggleStudio} onClear={onClearStudios} />
          <FacetGroup title="系列" icon="layers" facets={seriesFacets} selected={selectedSeries} onToggle={onToggleSeries} onClear={onClearSeries} />
        </Section>
      </div>

      {/* 底部固定：统计 / 关于 / 设置 */}
      <div className="shrink-0 border-t border-white/5 px-2 py-2 flex items-center gap-1.5">
        <button className="flex-1 h-8 rounded-lg flex items-center justify-center gap-1.5 bg-ink-700 hover:bg-ink-600 text-white/80 text-xs font-medium transition-colors" onClick={onOpenStats} title="统计看板">
          <Icon name="chart" size={14} />
          统计
        </button>
        <button className="w-8 h-8 rounded-lg flex items-center justify-center bg-ink-700 hover:bg-ink-600 text-white/80 transition-colors" onClick={onOpenAbout} title="关于">
          <Icon name="info" size={14} />
        </button>
        <button className="w-8 h-8 rounded-lg flex items-center justify-center bg-ink-700 hover:bg-ink-600 text-white/80 transition-colors" onClick={onOpenSettings} title="设置">
          <Icon name="sliders" size={14} />
        </button>
      </div>
    </aside>
  )
}

export default memo(SidebarInner)
