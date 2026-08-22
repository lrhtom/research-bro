// 单张卡的遗忘曲线 + 四档手动调整 + 进度清零。
//
// 三件事都围绕同一个问题：这张卡什么时候会被忘掉，以及我想不想改它。
//
// ---- 为什么曲线不在前端算 ----
// 采样点、四档预览全部由服务端送来（GET /api/cards/:id/curve）。
// 全站只有 src/server/fsrs.ts 懂 FSRS，把幂函数抄一份到前端的话，
// 界面上画的线和真正的排期就有了两个来源 —— 而它们对不上的时候看不出来，
// 因为两边都"看着挺像那么回事"。
//
// ---- 为什么用手写 SVG 而不是图表库 ----
// 要画的东西就是一条单调递减的线加两个点。引一个图表库进来（哪怕按需加载）
// 是几百 KB 换几十行代码，不划算。mermaid 已经是本项目唯一一个够格
// 被动态 import 的重依赖了。
//
// ---- 四档按钮为什么不计入统计 ----
// 见 server/study.ts 的 adjustCard：reviews 表是进度与统计的唯一依据，
// 在管理页拨曲线不是"复习"，写进去就会让统计报出你没做过的学习量。
// 界面上必须把这件事说出来，否则用户会以为点了就算今天学过了。

import { useCallback, useEffect, useState } from 'react';
import { apiAdjustCard, apiCardCurve, apiResetCard } from '@/lib/api';
import { dateText, untilText } from '@/lib/format';
import { RATING_LABELS, type Card, type CardCurve, type Rating } from '../../../shared/types';

const RATINGS: Rating[] = [1, 2, 3, 4];

/** 画布尺寸。用 viewBox 自适应宽度，高度固定。 */
const W = 560;
const H = 190;
const PAD = { l: 38, r: 14, t: 14, b: 26 };

/** 把「天数 / 可记忆性」映射到 SVG 坐标 */
function makeScale(maxDay: number) {
    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    // y 轴从 50% 画到 100%：低于 50% 的部分对复习安排没有参考价值，
    // 全画出来只会把真正要看的 90% 那一段压扁
    const yMin = 0.5;
    return {
        x: (d: number) => PAD.l + (Math.max(0, Math.min(maxDay, d)) / maxDay) * iw,
        y: (r: number) => PAD.t + (1 - (Math.max(yMin, r) - yMin) / (1 - yMin)) * ih,
        yMin,
    };
}

function pct(r: number): string {
    return `${(r * 100).toFixed(0)}%`;
}

/** 天数说人话：不足一天说小时/分钟 */
function daysText(d: number): string {
    if (d < 1 / 1440) return '马上';
    if (d < 1 / 24) return `${Math.round(d * 1440)} 分钟`;
    if (d < 1) return `${Math.round(d * 24)} 小时`;
    if (d < 30) return `${d < 10 ? d.toFixed(1) : Math.round(d)} 天`;
    if (d < 365) return `${(d / 30).toFixed(1)} 个月`;
    return `${(d / 365).toFixed(1)} 年`;
}

interface Props {
    card: Card;
    /** 调整或清零之后把新卡片回传给页面，好让左边列表和详情一起刷新 */
    onCardChanged: (card: Card) => void;
}

export default function ForgettingCurve({ card, onCardChanged }: Props) {
    const [curve, setCurve] = useState<CardCurve | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<Rating | 'reset' | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const load = useCallback(async (cardId: number) => {
        setLoading(true);
        try {
            setCurve(await apiCardCurve(cardId));
            setErr(null);
        } catch (e) {
            setErr(e instanceof Error ? e.message : '曲线没取到');
        } finally {
            setLoading(false);
        }
    }, []);

    // 换卡就重取。依赖里放 card.id 而不是 card —— 点收藏也会换 card 对象，
    // 那种改动跟曲线无关，没必要多打一次接口
    useEffect(() => { void load(card.id); }, [card.id, load]);

    const adjust = async (r: Rating) => {
        if (busy) return;
        setBusy(r);
        try {
            const { card: next, curve: nextCurve } = await apiAdjustCard(card.id, r);
            setCurve(nextCurve);
            onCardChanged(next);
            setErr(null);
        } catch (e) {
            setErr(e instanceof Error ? e.message : '没调上');
        } finally {
            setBusy(null);
        }
    };

    const reset = async () => {
        if (busy) return;
        if (!window.confirm('把这张卡的进度清零、重新当新卡？\n（历史复习流水保留，统计不受影响）')) return;
        setBusy('reset');
        try {
            const next = await apiResetCard(card.id);
            onCardChanged(next);
            await load(card.id);
        } catch (e) {
            setErr(e instanceof Error ? e.message : '清零失败');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="fc-curve">
            <div className="fc-curve-head">
                <h4><i className="fas fa-chart-line" /> 遗忘曲线</h4>
                {curve?.hasCurve && (
                    <span className="fc-curve-now">
                        此刻还记得住 <b className="u-num">{pct(curve.now.r)}</b>
                    </span>
                )}
            </div>

            {loading && <div className="fc-curve-skeleton" aria-label="载入中" />}

            {!loading && curve && (
                curve.hasCurve
                    ? <CurveChart curve={curve} />
                    : (
                        <p className="fc-curve-empty">
                            这张卡还没复习过，<b>画不出曲线</b> ——
                            遗忘曲线是从「上次复习」那一刻开始衰减的，没有起点就没有曲线。
                            下面四档评一次就有了。
                        </p>
                    )
            )}

            {err && <p className="fc-curve-err"><i className="fas fa-circle-exclamation" /> {err}</p>}

            <div className="fc-curve-controls">
                <p className="fc-curve-hint">
                    <i className="fas fa-circle-info" />
                    点一档就<b>直接改这张卡的排期</b>，跟在学习页评分算出来的完全一样。
                    但它<b>不计入今日进度与统计</b> —— 在这儿拨曲线不是复习，
                    记进去就等于报了你没做过的学习量。
                </p>

                <div className="fc-curve-rates">
                    {RATINGS.map((r) => (
                        <button
                            key={r}
                            type="button"
                            className={'fc-curve-rate fc-rate-' + r}
                            disabled={busy !== null}
                            onClick={() => void adjust(r)}
                            title={`按「${RATING_LABELS[r]}」重排这张卡`}
                        >
                            <b>{RATING_LABELS[r]}</b>
                            <small>
                                {busy === r
                                    ? '…'
                                    : curve
                                        ? daysText(curve.previews[r].days) + '后'
                                        : '—'}
                            </small>
                        </button>
                    ))}
                </div>

                <button
                    type="button"
                    className="fc-curve-reset"
                    disabled={busy !== null}
                    onClick={() => void reset()}
                >
                    <i className="fas fa-rotate-left" />
                    {busy === 'reset' ? '清零中…' : '进度清零，重新当新卡'}
                </button>
            </div>
        </div>
    );
}

/** 曲线本体。纯展示，不碰数据。 */
function CurveChart({ curve }: { curve: CardCurve }) {
    const maxDay = Math.max(
        curve.points[curve.points.length - 1]?.d ?? 1,
        curve.now.d,
        curve.dueAt.d,
        1,
    );
    const s = makeScale(maxDay);

    const path = curve.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${s.x(p.d).toFixed(1)},${s.y(p.r).toFixed(1)}`)
        .join(' ');
    // 填充区：曲线下方到底边，给一点体积感
    const area = `${path} L${s.x(maxDay).toFixed(1)},${(H - PAD.b).toFixed(1)} `
        + `L${s.x(0).toFixed(1)},${(H - PAD.b).toFixed(1)} Z`;

    const overdue = curve.now.d > curve.dueAt.d;

    return (
        <>
            <svg
                className="fc-curve-svg"
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label={
                    `遗忘曲线：距上次复习 ${daysText(curve.now.d)}，`
                    + `此刻可记忆性 ${pct(curve.now.r)}，`
                    + `到期点在 ${daysText(curve.dueAt.d)} 处、${pct(curve.dueAt.r)}`
                }
            >
                {/* 横向刻度线 + 百分比标签 */}
                {[1, 0.9, 0.8, 0.7, 0.6, 0.5].map((r) => (
                    <g key={r}>
                        <line
                            className={r === 0.9 ? 'fc-curve-grid is-target' : 'fc-curve-grid'}
                            x1={PAD.l} x2={W - PAD.r} y1={s.y(r)} y2={s.y(r)}
                        />
                        <text className="fc-curve-axis" x={PAD.l - 6} y={s.y(r) + 3} textAnchor="end">
                            {pct(r)}
                        </text>
                    </g>
                ))}

                <path className="fc-curve-area" d={area} />
                <path className="fc-curve-line" d={path} />

                {/* 到期竖线：FSRS 就是把到期日排在记忆掉到 90% 的那一刻 */}
                <line
                    className="fc-curve-due"
                    x1={s.x(curve.dueAt.d)} x2={s.x(curve.dueAt.d)}
                    y1={PAD.t} y2={H - PAD.b}
                />
                <text
                    className="fc-curve-tag"
                    x={s.x(curve.dueAt.d)} y={PAD.t + 9}
                    textAnchor={curve.dueAt.d / maxDay > 0.75 ? 'end' : 'start'}
                    dx={curve.dueAt.d / maxDay > 0.75 ? -4 : 4}
                >
                    到期 · {pct(curve.dueAt.r)}
                </text>

                {/* 此刻的位置 */}
                <circle
                    className={'fc-curve-dot' + (overdue ? ' is-overdue' : '')}
                    cx={s.x(curve.now.d)} cy={s.y(curve.now.r)} r={4.5}
                />

                {/* 底部两端的天数标注 */}
                <text className="fc-curve-axis" x={PAD.l} y={H - 8} textAnchor="start">上次复习</text>
                <text className="fc-curve-axis" x={W - PAD.r} y={H - 8} textAnchor="end">
                    {daysText(maxDay)}后
                </text>
            </svg>

            <dl className="fc-curve-facts">
                <div>
                    <dt>距上次复习</dt>
                    <dd className="u-num">{daysText(curve.now.d)}</dd>
                </div>
                <div>
                    {/* 逾期不能用 untilText —— 它对过期的一律回「现在」，
                        配上「已逾期」的标签就成了「已逾期 现在」。逾期自己算天数 */}
                    <dt>到期</dt>
                    <dd className={'u-num' + (overdue ? ' fc-curve-overdue' : '')}>
                        {overdue
                            ? `逾期 ${daysText(curve.now.d - curve.dueAt.d)}`
                            : untilText(curve.due)}
                    </dd>
                </div>
                <div>
                    <dt>到期日</dt>
                    <dd>{dateText(curve.due)}</dd>
                </div>
                <div>
                    {/* 稳定度的定义就是「掉到 90% 要多久」，跟上面那条 90% 参考线是同一件事 */}
                    <dt>稳定度</dt>
                    <dd className="u-num">{daysText(curve.stability)}</dd>
                </div>
            </dl>
        </>
    );
}
