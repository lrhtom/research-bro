// ============================================================
//  学习统计：总体进度与状态
//
//  这一页只读，不改任何数据。
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
import AppShell from '@/components/AppShell';
import { FLASHCARD_SECTIONS } from '@/lib/nav';
import Loading from '@/components/Loading';
import { ActivityCalendar, DailyVolumeChart, ForecastChart, StrengthChart } from '@/components/cards/StatsCharts';
import { apiStats } from '@/lib/api';
import { dateText, durationText, STATE_LABELS, untilText } from '@/lib/format';
import type { StatsOverview } from '../../shared/types';

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

export default function StatsPage() {
    const [search, setSearch] = useSearchParams();
    const raw = search.get('plan');
    const planId = raw && raw !== 'all' && Number.isFinite(Number(raw)) ? Number(raw) : null;

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

    useEffect(() => {
        document.title = '学习统计 · 记忆卡';
        void load();
    }, [load]);

    const retentionText = useMemo(() => {
        if (!data) return '—';
        // 分母为 0 就是「—」：既不是 100%，也不能拿去除
        return data.retention30.rate === null ? '—' : `${(data.retention30.rate * 100).toFixed(0)}%`;
    }, [data]);

    if (error) {
        return (
            <AppShell title="学习统计" subtitle="Study Statistics" sections={FLASHCARD_SECTIONS}>
                <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/tools/flashcards">← 返回学习计划列表</Link></p>
            </AppShell>
        );
    }

    if (!data) {
        return (
            <AppShell title="学习统计" subtitle="Study Statistics" sections={FLASHCARD_SECTIONS}>
                <Loading block text="正在把这些天的复习流水算成图表…" />
            </AppShell>
        );
    }

    const c = data.cards;
    const currentPlan = data.plans.find((p) => p.id === data.planId);
    const scopeName = currentPlan ? currentPlan.name : '全部计划';

    return (
        <AppShell
            title="学习统计"
            subtitle={`Study Statistics · ${scopeName}`}
            sections={FLASHCARD_SECTIONS}
            actions={currentPlan && (
                <Link className="u-btn" to={`/tools/flashcards/${currentPlan.id}`}>
                    <i className="fas fa-pen-to-square" /> 管理这个计划的卡片
                </Link>
            )}
        >
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
                    <span className="count">最近 26 周</span>
                </div>
                {data.hasReviews
                    ? <ActivityCalendar cells={data.calendar} />
                    : <EmptyPanel />}

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

                {/* ---------- 第四行：预测 + 记忆强度 ---------- */}
                <div className="fc-two-col">
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
                </div>

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
            </div>
        </AppShell>
    );
}
