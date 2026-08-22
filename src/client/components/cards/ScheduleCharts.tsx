// 排期分布 + 遗忘曲线 —— 从 aIELTS 的 UserAnalytics 迁过来的两张图。
//
// 两张图**同一份数据**（StatsOverview.scheduled：从今天起第 d 天有几张卡到期），
// 只是看法不同：
//   · 排期分布 = 直接画它，回答「哪几天会扎堆」
//   · 遗忘曲线 = 把它累减成存活曲线，回答「这副牌的记忆还能撑多久」
// 拆成两个接口字段是多余的，所以后端只给一份，累减在前端做。
//
// 为什么存活曲线叫「遗忘曲线」：FSRS 把每张卡的到期日排在它记忆掉到 90% 的
// 那一刻，所以「还没到期的卡数」就是「还在 90% 线之上的卡数」。
// 它跟单张卡详情页里那条曲线不是一回事 —— 那条是一张卡的可记忆性随时间衰减，
// 这条是整副牌里「还记得住的张数」随时间减少。
//
// X 轴标签按**索引**等距采样，不是按天数等距。所以刻度会是
// 0 / 40 / 80 / 131 / 184… 这种不等距的数 —— 这是故意的：
// 数据点在近期密、远期疏，按天数等距的话前面几百个点会挤成一团。

import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ScheduledBucket } from '../../../shared/types';

const W = 760;
const H = 220;
const PAD = { l: 48, r: 16, t: 16, b: 36 };
const GW = W - PAD.l - PAD.r;
const GH = H - PAD.t - PAD.b;

const CURVE = '#f97316';

/** 第 d 天对应的日期，用来在提示框里写清「那天是几号」 */
function dateFromOffset(days: number): string {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function dayText(days: number): string {
    if (days === 0) return '今天';
    if (days === 1) return '明天';
    return `${days} 天后`;
}

// ---------- 共用的提示框 ----------
//
// 跟热力图那个同一套路：内容进 state（只在跨点时变），位置直接写 DOM。
// 这两张图各有几百个 <circle>，位置进 state 的话每次 mousemove 都会
// 把它们全部重渲染。

interface TipState { lines: string[] }

function tipTransform(x: number, y: number): string {
    return `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, calc(-100% - 12px))`;
}

function useChartTip() {
    const [tip, setTip] = useState<TipState | null>(null);
    const ref = useRef<HTMLDivElement | null>(null);
    const pos = useRef({ x: 0, y: 0 });

    const place = useCallback((x: number, y: number) => {
        pos.current = { x, y };
        if (ref.current) ref.current.style.transform = tipTransform(x, y);
    }, []);

    const show = useCallback((x: number, y: number, lines: string[]) => {
        place(x, y);
        setTip({ lines });
    }, [place]);

    const hide = useCallback(() => setTip(null), []);

    const node = tip && createPortal(
        <div
            className="hm-tip"
            ref={ref}
            style={{ transform: tipTransform(pos.current.x, pos.current.y) }}
        >
            <span className="hm-tip-date">{tip.lines[0]}</span>
            {tip.lines.slice(1).map((l) => <span key={l} className="hm-tip-line">{l}</span>)}
        </div>,
        document.body,
    );

    return { node, show, hide, place };
}

/** Y 轴四等分的刻度值 */
function yTicks(max: number): number[] {
    return Array.from({ length: 5 }, (_, i) => Math.round((max / 4) * i));
}

/** X 轴按索引等距取 8 个标签 —— 见文件头的说明 */
function xLabels<T>(data: T[], xOf: (d: T) => number, textOf: (d: T) => string) {
    const n = Math.min(8, data.length);
    const out: Array<{ key: number; x: number; text: string }> = [];
    for (let i = 0; i < n; i += 1) {
        const idx = Math.round((i / (n - 1 || 1)) * (data.length - 1));
        out.push({ key: idx, x: xOf(data[idx]), text: textOf(data[idx]) });
    }
    return out;
}

// ---------- 遗忘曲线 ----------

interface CurvePoint { day: number; cards: number }

/**
 * 把到期分布累减成存活曲线。
 *
 * 只在数值**变化时**才落一个点：连着几十天没有卡到期的话，那一段是水平的，
 * 每天塞一个点只会让 SVG 多出几百个重叠圆圈，形状一模一样。
 */
function toSurvival(scheduled: ScheduledBucket[]): CurvePoint[] {
    if (scheduled.length === 0) return [];
    const total = scheduled.reduce((a, b) => a + b.count, 0);
    if (total === 0) return [];

    const byDay = new Map(scheduled.map((s) => [s.days, s.count]));
    const maxDay = scheduled[scheduled.length - 1].days;

    const out: CurvePoint[] = [];
    let remaining = total;
    let last = -1;
    for (let d = 0; d <= maxDay; d += 1) {
        remaining -= byDay.get(d) ?? 0;
        if (remaining !== last) {
            out.push({ day: d, cards: remaining });
            last = remaining;
        }
        if (remaining <= 0) break;
    }
    return out;
}

export function ForgettingCurveChart({ scheduled }: { scheduled: ScheduledBucket[] }) {
    const data = useMemo(() => toSurvival(scheduled), [scheduled]);
    const { node, show, hide, place } = useChartTip();

    if (data.length < 2) {
        return <p className="u-empty">已排期的卡还太少，画不出曲线。</p>;
    }

    const maxCards = Math.max(...data.map((d) => d.cards), 1);
    const maxDay = data[data.length - 1].day || 1;
    const x = (day: number) => PAD.l + (day / maxDay) * GW;
    const y = (cards: number) => PAD.t + GH - (cards / maxCards) * GH;

    const pts = data.map((d) => `${x(d.day).toFixed(1)},${y(d.cards).toFixed(1)}`);
    const area = `M ${pts[0]} L ${pts.join(' L ')} `
        + `L ${x(maxDay).toFixed(1)},${(PAD.t + GH).toFixed(1)} `
        + `L ${PAD.l},${(PAD.t + GH).toFixed(1)} Z`;

    return (
        <>
            <svg className="sc-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
                <defs>
                    <linearGradient id="scForgetGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CURVE} stopOpacity="0.22" />
                        <stop offset="100%" stopColor={CURVE} stopOpacity="0.02" />
                    </linearGradient>
                </defs>

                {yTicks(maxCards).map((v) => (
                    <g key={v}>
                        <line className="sc-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
                        <text className="sc-axis" x={PAD.l - 6} y={y(v) + 4} textAnchor="end">{v}</text>
                    </g>
                ))}

                <path d={area} fill="url(#scForgetGrad)" />
                <polyline
                    points={pts.join(' ')}
                    fill="none"
                    stroke={CURVE}
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />

                {/* 命中区比可见圆点大一圈：3.5px 的点太小，鼠标很难压准 */}
                {data.map((d) => (
                    <circle
                        key={`hit-${d.day}`}
                        cx={x(d.day)} cy={y(d.cards)} r="8"
                        fill="transparent"
                        onMouseEnter={(ev) => show(ev.clientX, ev.clientY, [
                            `${dayText(d.day)} · ${dateFromOffset(d.day)}`,
                            `还有 ${d.cards} 张没到期`,
                        ])}
                        onMouseMove={(ev) => place(ev.clientX, ev.clientY)}
                        onMouseLeave={hide}
                    />
                ))}
                {data.map((d) => (
                    <circle
                        key={`dot-${d.day}`}
                        className="sc-dot"
                        cx={x(d.day)} cy={y(d.cards)} r="3.5"
                        stroke={CURVE}
                    />
                ))}

                {xLabels(data, (d) => x(d.day), (d) => `第 ${d.day} 天`).map((l) => (
                    <text key={l.key} className="sc-axis" x={l.x} y={H - 4} textAnchor="middle">{l.text}</text>
                ))}
            </svg>
            {node}
        </>
    );
}

// ---------- 排期分布 ----------

type Mode = 'line' | 'bar';

export function ReviewScheduleChart({ scheduled }: { scheduled: ScheduledBucket[] }) {
    const [mode, setMode] = useState<Mode>('line');
    const { node, show, hide, place } = useChartTip();

    if (scheduled.length === 0) {
        return <p className="u-empty">还没有已排期的卡片。</p>;
    }

    const maxCount = Math.max(...scheduled.map((d) => d.count), 1);
    const n = scheduled.length;
    // 横轴按**索引**均分而不是按天数：远期的点稀疏，按天数摆的话
    // 右边会空出一大片，而那正是数据最少、最不需要空间的地方
    const x = (i: number) => PAD.l + (n > 1 ? (i / (n - 1)) * GW : GW / 2);
    const y = (c: number) => PAD.t + GH - (c / maxCount) * GH;

    const pts = scheduled.map((d, i) => `${x(i).toFixed(1)},${y(d.count).toFixed(1)}`);
    const area = `M ${pts[0]} L ${pts.join(' L ')} `
        + `L ${(PAD.l + GW).toFixed(1)},${(PAD.t + GH).toFixed(1)} `
        + `L ${PAD.l},${(PAD.t + GH).toFixed(1)} Z`;

    // 柱子最细也要看得见：几百根柱子平分下来不足 1px 的话，整张图会变成一片灰
    const barW = Math.max(1, GW / n - 1);

    const tipFor = (d: ScheduledBucket) => [
        `${dayText(d.days)} · ${dateFromOffset(d.days)}`,
        `${d.count} 张到期`,
    ];

    return (
        <>
            <div className="sc-head">
                <div className="sc-toggle" role="group" aria-label="图表样式">
                    <button
                        type="button"
                        className={'sc-toggle-btn' + (mode === 'line' ? ' is-on' : '')}
                        aria-pressed={mode === 'line'}
                        title="折线"
                        onClick={() => setMode('line')}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className={'sc-toggle-btn' + (mode === 'bar' ? ' is-on' : '')}
                        aria-pressed={mode === 'bar'}
                        title="柱状"
                        onClick={() => setMode('bar')}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="20" x2="18" y2="10" />
                            <line x1="12" y1="20" x2="12" y2="4" />
                            <line x1="6" y1="20" x2="6" y2="14" />
                        </svg>
                    </button>
                </div>
            </div>

            <svg className="sc-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
                <defs>
                    <linearGradient id="scSchedGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
                    </linearGradient>
                </defs>

                {yTicks(maxCount).map((v) => (
                    <g key={v}>
                        <line className="sc-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
                        <text className="sc-axis" x={PAD.l - 6} y={y(v) + 4} textAnchor="end">{v}</text>
                    </g>
                ))}

                {mode === 'line' ? (
                    <>
                        <path d={area} fill="url(#scSchedGrad)" />
                        <polyline
                            className="sc-line"
                            points={pts.join(' ')}
                            fill="none"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        {scheduled.map((d, i) => (
                            <circle
                                key={`hit-${d.days}`}
                                cx={x(i)} cy={y(d.count)} r="7"
                                fill="transparent"
                                onMouseEnter={(ev) => show(ev.clientX, ev.clientY, tipFor(d))}
                                onMouseMove={(ev) => place(ev.clientX, ev.clientY)}
                                onMouseLeave={hide}
                            />
                        ))}
                        {scheduled.map((d, i) => (
                            <circle
                                key={`dot-${d.days}`}
                                className="sc-dot is-accent"
                                cx={x(i)} cy={y(d.count)} r="3"
                            />
                        ))}
                    </>
                ) : (
                    scheduled.map((d, i) => (
                        <rect
                            key={d.days}
                            className="sc-bar"
                            x={x(i) - barW / 2}
                            y={y(d.count)}
                            width={barW}
                            height={Math.max(0, PAD.t + GH - y(d.count))}
                            onMouseEnter={(ev) => show(ev.clientX, ev.clientY, tipFor(d))}
                            onMouseMove={(ev) => place(ev.clientX, ev.clientY)}
                            onMouseLeave={hide}
                        />
                    ))
                )}

                {xLabels(
                    scheduled.map((d, i) => ({ d, i })),
                    (o) => x(o.i),
                    (o) => (o.d.days === 0 ? '今天' : `${o.d.days} 天后`),
                ).map((l) => (
                    <text key={l.key} className="sc-axis" x={l.x} y={H - 4} textAnchor="middle">{l.text}</text>
                ))}
            </svg>
            {node}
        </>
    );
}
