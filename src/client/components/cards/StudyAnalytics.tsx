// ============================================================
//  学习统计：总体进度与状态
//
//  这一块原来是独立页面 /tools/flashcards/stats，现在整块搬进了个人中心
//  （/me）—— 「你在这个站里攒下了什么」本来就是个人中心要回答的问题，
//  而学习数据是这个站里唯一持续累积的东西。旧路由保留并重定向过去，
//  免得书签和站内搜索指向一个 404。
//
//  它是组件不是页面：外面那层 AppShell 由 ProfilePage 提供。
//
//  这一块只读，不改任何数据。
//
//  页面上所有数字的单位都写在标签里，因为「次」和「张」在这里必然同时出现：
//    · 今天复习 47 次  = 点了 47 下评分按钮
//    · 今天碰过 19 张  = COUNT(DISTINCT card_id)
//  两个数字挨着放而不标单位，看的人一定会以为自己学完了 47 张卡。
//
//  另外三处容易骗人的地方，界面上都用脚注写明白了：
//    · 留存率排除新卡的首次露面（那不是记忆测试）；没有样本时显示「—」
//    · 未来负载不含新卡（新卡由每日上限控制，不是靠到期日排队）
//    · 有些计划是从别的软件导进来的，卡片数据齐全但一条复习流水都没有 ——
//      这时读 cards 的面板照常出数，读 reviews 的面板一律给空状态而不是 0
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Loading from '@/components/Loading';
import { DailyVolumeChart, ForecastChart, StrengthChart } from '@/components/cards/StatsCharts';
import StudyHeatmap from '@/components/cards/StudyHeatmap';
import { ForgettingCurveChart, ReviewScheduleChart } from '@/components/cards/ScheduleCharts';
import { apiStats } from '@/lib/api';
import { dateText, durationText, STATE_LABELS, untilText } from '@/lib/format';
import type { StatsOverview } from '../../../shared/types';

/** 学习分析的四组页签。分组按「这几张图回答同一个问题」来，不是按图的类型。 */
type ATab = 'overview' | 'volume' | 'schedule' | 'memory';

const ANALYTICS_TABS: Array<{ key: ATab; label: string; icon: string }> = [
    { key: 'overview', label: '总览', icon: 'fa-table-cells-large' },
    { key: 'volume', label: '学习量', icon: 'fa-chart-column' },
    { key: 'schedule', label: '排期', icon: 'fa-calendar-check' },
    { key: 'memory', label: '记忆质量', icon: 'fa-dumbbell' },
];

/** 复习流水缺席时的统一说法。措辞刻意不说「0」—— 没有记录和学了 0 次不是一回事。 */
const NO_HISTORY = '这个计划还没有复习记录 —— 统计从你的下一次学习开始积累。';

function EmptyPanel({ text = NO_HISTORY }: { text?: string }) {
    return <p className="fc-empty">{text}</p>;
}

/** 数字磁贴。value 已经是格式化好的字符串（可能是「—」）。 */
function Tile({ value, label, note, tone }: {
    value: string; label: string; note?: React.ReactNode; tone?: 'muted';
}) {
    return (
        <li className={'fc-tile' + (tone === 'muted' ? ' is-muted' : '')}>
            <b>{value}</b>
            <span className="fc-tile-label">{label}</span>
            {note && <span className="fc-tile-note">{note}</span>}
        </li>
    );
}

export default function StudyAnalytics() {
    const [search, setSearch] = useSearchParams();
    const raw = search.get('plan');
    const planId = raw && raw !== 'all' && Number.isFinite(Number(raw)) ? Number(raw) : null;

    const [tab, setTab] = useState<ATab>('overview');
    const [data, setData] = useState<StatsOverview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setData(await apiStats(planId));
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载失败');
        } finally {
            setLoading(false);
        }
    }, [planId]);

    // 不设 document.title —— 这已经不是页面了，标题归 ProfilePage。
    // 留着的话切到「学习统计」那一栏，浏览器标签会变成「学习统计 · 记忆卡」，
    // 而地址栏还是 /me，收藏下来对不上
    useEffect(() => { void load(); }, [load]);

    const retentionText = useMemo(() => {
        if (!data) return '—';
        // 分母为 0 就是「—」：既不是 100%，也不能拿去除
        return data.retention30.rate === null ? '—' : `${(data.retention30.rate * 100).toFixed(0)}%`;
    }, [data]);

    if (error) {
        return (
            <>
                <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/tools/flashcards">← 返回学习计划列表</Link></p>
            </>
        );
    }

    if (!data) {
        return <Loading block text="正在把这些天的复习流水算成图表…" />;
    }

    const c = data.cards;
    const currentPlan = data.plans.find((p) => p.id === data.planId);

    return (
        <>
            {currentPlan && (
                <p className="fc-muted fc-note">
                    <Link to={`/tools/flashcards/${currentPlan.id}`}>
                        <i className="fas fa-pen-to-square" /> 管理「{currentPlan.name}」的卡片
                    </Link>
                </p>
            )}
            <div className={loading ? 'is-loading' : undefined}>

                {/* ---------- 计划选择器 ---------- */}
                <div className="fc-scope">
                    <span className="fc-scope-label"><i className="fas fa-filter" /> 统计范围</span>
                    <div className="fc-scope-tabs">
                        <button
                            type="button"
                            className={'fc-chip' + (data.planId === null ? ' on' : '')}
                            onClick={() => setSearch({})}
                        >
                            全部计划
                        </button>
                        {data.plans.map((p) => (
                            <button
                                key={p.id}
                                type="button"
                                className={'fc-chip' + (data.planId === p.id ? ' on' : '')}
                                onClick={() => setSearch({ plan: String(p.id) })}
                            >
                                {p.name}
                            </button>
                        ))}
                    </div>
                </div>

                <p className="fc-muted fc-note">
                    「今天」是 <b>{data.day}</b>（{data.timeZone} 的日历日）；带「近 30 天」的数字统计
                    <b> {data.windowStart}</b> 至 <b>{data.day}</b>。
                </p>

                {/* 页签。原来是一路滚到底的七节，实测要滚四五屏才看得完 ——
                    分成四组之后每一组一屏内看得完，而且分组本身就是解释：
                    哪几张图该放在一起看，是有讲究的。
                    统计范围留在页签**外面**：它对四组都生效，跟着页签走的话
                    每换一次页签就要重选一次。 */}
                <div className="fc-atabs" role="tablist">
                    {ANALYTICS_TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            role="tab"
                            aria-selected={tab === t.key}
                            className={'fc-atab' + (tab === t.key ? ' is-on' : '')}
                            onClick={() => setTab(t.key)}
                        >
                            <i className={'fas ' + t.icon} />
                            <span>{t.label}</span>
                        </button>
                    ))}
                </div>

                {tab === 'overview' && (
                    <>
                {/* ---------- 第一行：五块数字 ---------- */}
                <ul className="fc-tiles">
                    <Tile
                        value={String(c.total)}
                        label="卡片总数（张）"
                        note={<>新卡 {c.new} · 学习中 {c.learning} · 复习 {c.review}</>}
                    />
                    <Tile
                        value={data.hasReviews ? String(data.todayTaps) : '—'}
                        label="今日复习（次）"
                        tone={data.hasReviews ? undefined : 'muted'}
                        note={data.hasReviews
                            ? <>今天碰过 <b>{data.todayCards}</b> 张（按卡去重）</>
                            : '还没有复习记录'}
                    />
                    <Tile
                        value={data.hasReviews ? String(data.streakDays) : '—'}
                        label="连续学习（天）"
                        tone={data.hasReviews ? undefined : 'muted'}
                        note={data.hasReviews
                            ? (data.streakDays > 0 ? '中间断一天就归零' : '今天和昨天都没学，已经断了')
                            : '还没有复习记录'}
                    />
                    <Tile
                        value={retentionText}
                        label="近 30 天留存率"
                        tone={data.retention30.rate === null ? 'muted' : undefined}
                        note={data.retention30.rate === null
                            ? '还没有可用于判断记忆的样本'
                            : <>{data.retention30.recalledTaps} / {data.retention30.eligibleTaps} 次记住了</>}
                    />
                    <Tile
                        value={data.hasReviews ? durationText(data.durationMs30) : '—'}
                        label="近 30 天学习时长"
                        tone={data.hasReviews ? undefined : 'muted'}
                        note={data.hasReviews ? '所有评分停留时间之和' : '还没有复习记录'}
                    />
                </ul>

                <p className="fc-muted fc-note fc-footnote">
                    <i className="fas fa-circle-info" />{' '}
                    <b>「次」和「张」不是一回事</b>：一张卡评三次「重来」再评一次「良好」，
                    算 <b>4 次</b>、<b>1 张</b>。两个口径不能相加，所以上面每个数字都带着自己的单位。
                    留存率的分母<b>不含新卡第一次露面</b> —— 初次见面按的那一下反映的是这张卡难不难，
                    不是你记住了没有。
                </p>

                {/* ---------- 第二行：活动日历 ---------- */}
                <div className="section-head">
                    <h2><i className="fas fa-calendar-days" /> 学习活动</h2>
                    <span className="count">最近一年</span>
                </div>
                {data.hasReviews
                    ? (
                        <StudyHeatmap
                            calendar={data.calendar}
                            yearMs={data.yearDurationMs}
                            activeDays={data.activeDays}
                            streak={data.streakDays}
                        />
                    )
                    : <EmptyPanel />}

                    </>
                )}

                {tab === 'volume' && (
                    <>
                {/* ---------- 第三行：每日学习量 ---------- */}
                <div className="section-head">
                    <h2><i className="fas fa-chart-column" /> 每日学习量与留存率</h2>
                    <span className="count">最近 30 天 · 柱子的单位是「次」</span>
                </div>
                {data.hasReviews ? (
                    <>
                        <DailyVolumeChart days={data.daily} />
                        <p className="fc-muted fc-note fc-footnote">
                            没有学习的日子<b>照样占着横轴的位置</b>，留存率折线也在那里断开 ——
                            把空日抹掉的话，停学两周会画成一条连续上升的曲线。
                        </p>
                    </>
                ) : <EmptyPanel />}

                    </>
                )}

                {tab === 'schedule' && (
                    <>
                <section>
                    <div className="section-head">
                        <h2><i className="fas fa-gauge-high" /> 未来负载</h2>
                        <span className="count">逾期 + 未来 30 天</span>
                    </div>
                    <ForecastChart buckets={data.forecast} />
                    <p className="fc-muted fc-note fc-footnote">
                        这张图回答的是「明天会有多难」。逾期的卡全部堆在最左边那一根里，
                        不会混进今天的柱子。<b>不含新卡</b> —— 新卡什么时候出现由每日新卡上限决定，
                        跟到期日无关，算进来只会让「逾期」那根柱子毫无意义地冲到几千。
                    </p>
                </section>
                {/* ---------- 排期分布与遗忘曲线（长周期）---------- */}
                <div className="section-head">
                    <h2><i className="fas fa-calendar-check" /> 复习排期</h2>
                    <span className="count">
                        {data.scheduled.length > 0
                            ? `未来 ${data.scheduled[data.scheduled.length - 1].days} 天`
                            : '暂无'}
                    </span>
                </div>
                <p className="fc-muted fc-note">
                    上面那张「未来负载」只看 30 天，回答的是<b>明天会有多难</b>；
                    这一张铺满整个跨度，回答的是<b>这副牌的排期结构长什么样</b> ——
                    哪几天会扎堆、远期是不是已经排稀了。逾期的卡并进「今天」这一根。
                </p>
                <ReviewScheduleChart scheduled={data.scheduled} />

                <div className="section-head">
                    <h2><i className="fas fa-chart-area" /> 遗忘曲线</h2>
                    <span className="count">整副牌</span>
                </div>
                <p className="fc-muted fc-note">
                    假如<b>从今天起再也不复习</b>，还记得住的卡会怎么一路掉下去。
                    FSRS 把每张卡的到期日排在它记忆掉到 <b>90%</b> 的那一刻，
                    所以「还没到期的张数」就是「还在 90% 线之上的张数」。
                </p>
                <ForgettingCurveChart scheduled={data.scheduled} />
                <p className="fc-muted fc-note fc-footnote">
                    <i className="fas fa-circle-info" />{' '}
                    这跟卡片详情页里那条曲线<b>不是一回事</b>：那条画的是<b>一张卡</b>的
                    可记忆性随时间衰减，这条画的是<b>整副牌</b>里还记得住的张数随时间减少。
                    曲线只在数值变化时落点，所以中间那些长长的水平段是「这几十天没有卡到期」，
                    不是数据缺失。
                </p>


                    </>
                )}

                {tab === 'memory' && (
                    <>
                <section>
                    <div className="section-head">
                        <h2><i className="fas fa-dumbbell" /> 记忆强度</h2>
                        <span className="count">已开始学的 {c.total - c.new} 张</span>
                    </div>
                    {c.total - c.new > 0 ? (
                        <>
                            <StrengthChart buckets={data.strength} />
                            <p className="fc-muted fc-note fc-footnote">
                                横轴是这份记忆还能保持多久（FSRS 的 stability）。
                                落在 <b>90 天以上</b> 两档的，基本可以算学会了。
                            </p>
                        </>
                    ) : <EmptyPanel text="还没有开始学的卡片 —— 学过一轮之后这里就有分布了。" />}
                </section>
                {/* ---------- 第五行：老忘的卡 ---------- */}
                <div className="section-head">
                    <h2><i className="fas fa-arrow-rotate-left" /> 总是记不住的卡</h2>
                    <span className="count">按忘记次数排前 {data.leeches.length} 张</span>
                </div>
                <p className="fc-muted fc-note">
                    这些卡该改的是<b>背面写法</b>，不是加大重复力度 ——
                    一张反复忘的卡通常是答案太长、太绕，或者一张卡塞了好几个知识点。
                </p>
                {data.leeches.length === 0 ? (
                    <EmptyPanel text="还没有忘记过的卡片。" />
                ) : (
                    <table className="fc-table">
                        <thead>
                            <tr>
                                <th>正面</th>
                                <th>背面</th>
                                {data.planId === null && <th>所属计划</th>}
                                <th>忘记（次）</th>
                                <th>难度</th>
                                <th>强度</th>
                                <th>下次到期</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.leeches.map((l) => (
                                <tr key={l.id}>
                                    <td>{l.front.slice(0, 60)}</td>
                                    <td className="fc-muted">{l.back.replace(/\s+/g, ' ').slice(0, 70) || '（空）'}</td>
                                    {data.planId === null && (
                                        <td>
                                            <Link to={`/tools/flashcards/${l.planId}`}>{l.planName}</Link>
                                        </td>
                                    )}
                                    <td><b>{l.lapses}</b></td>
                                    <td>{l.difficulty.toFixed(1)}</td>
                                    <td>{l.stability < 1
                                        ? `${(l.stability * 24).toFixed(1)} 小时`
                                        : `${l.stability.toFixed(1)} 天`}</td>
                                    <td>
                                        {l.state === 'new'
                                            ? <span className="fc-muted">已重置为新卡</span>
                                            : <>{untilText(l.due)}<span className="fc-muted"> · {dateText(l.due)}</span></>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <p className="fc-muted fc-note fc-footnote">
                    只列忘记次数<b>大于 0</b> 的卡。难度与强度是 FSRS 的两个内部量：
                    难度 1–10（越大越难），强度是这份记忆预计还能保持的天数。
                    状态说明见「{STATE_LABELS.review}／{STATE_LABELS.relearning}」。
                </p>
                    </>
                )}

            </div>
        </>
    );
}
