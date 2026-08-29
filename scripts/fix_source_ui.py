p = r'src/renderer/src/components/SettingsModal.tsx'
t = open(p, encoding='utf-8').read()

# 数据源 Card 头部（找 SegmentedControl onChange 后插入排序区块）
needle = """                    onChange={(v) => setDraft({ ...draft, dataSource: v as 'auto' | 'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary' })}
                  />"""
repl = """                    onChange={(v) => setDraft({ ...draft, dataSource: v as 'auto' | 'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary' })}
                  />
                  {draft.dataSource === 'auto' ? (
                    <div className="mt-4 rounded-xl bg-ink-900/60 ring-1 ring-white/5 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-white/80 text-[13px] font-medium">自定义优先级（1 = 最优先）</div>
                        <button
                          type="button"
                          className="text-[11px] text-white/50 hover:text-white transition-colors"
                          onClick={() => setDraft({ ...draft, customSourceOrder: undefined })}
                        >
                          重置为推荐顺序
                        </button>
                      </div>
                      <div className="text-white/40 text-[11px] mb-2">
                        推荐顺序：Javapi → Javinfo → JavDB → JavBus → JavLibrary（按信息全面度 / 获取难度 / 风控排序）。可点 ↑↓ 调整任意顺序。
                      </div>
                      <div className="flex flex-col gap-1">
                        {(() => {
                          const DEFAULT_ORDER = ['javapi', 'javinfo', 'javdb', 'javbus', 'javlibrary'] as const
                          const order: string[] =
                            draft.customSourceOrder && draft.customSourceOrder.length === 5
                              ? [...draft.customSourceOrder]
                              : [...DEFAULT_ORDER]
                          const LABEL: Record<string, string> = {
                            javapi: 'Javapi',
                            javinfo: 'Javinfo',
                            javdb: 'JavDB',
                            javbus: 'JavBus',
                            javlibrary: 'JavLibrary'
                          }
                          const move = (i: number, dir: -1 | 1) => {
                            const j = i + dir
                            if (j < 0 || j >= order.length) return
                            const next = [...order]
                            ;[next[i], next[j]] = [next[j], next[i]]
                            setDraft({
                              ...draft,
                              customSourceOrder: next as Array<'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary'>
                            })
                          }
                          return order.map((src, i) => (
                            <div key={src} className="flex items-center gap-2 px-2 py-1 rounded-lg bg-ink-800/70 ring-1 ring-white/5">
                              <span className="w-5 h-5 rounded-md bg-brand/20 text-brand text-[10px] font-bold flex items-center justify-center shrink-0 tabular-nums">
                                {i + 1}
                              </span>
                              <span className="text-white/85 text-[12px] flex-1">{LABEL[src] ?? src}</span>
                              <button
                                type="button"
                                disabled={i === 0}
                                className="w-6 h-6 rounded-md bg-ink-700 hover:bg-ink-600 text-white/70 hover:text-white flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                                onClick={() => move(i, -1)}
                                title="上移（更优先）"
                              >
                                <Icon name="chevronUp" size={12} />
                              </button>
                              <button
                                type="button"
                                disabled={i === order.length - 1}
                                className="w-6 h-6 rounded-md bg-ink-700 hover:bg-ink-600 text-white/70 hover:text-white flex items-center justify-center disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                                onClick={() => move(i, 1)}
                                title="下移（更靠后）"
                              >
                                <Icon name="chevronDown" size={12} />
                              </button>
                            </div>
                          ))
                        })()}
                      </div>
                    </div>
                  ) : null}"""
if needle not in t:
    print('NEEDLE NOT FOUND')
else:
    t = t.replace(needle, repl)
    # 确认 Icon 有 chevronUp/chevronDown
    open(p, 'w', encoding='utf-8').write(t)
    print('OK')
