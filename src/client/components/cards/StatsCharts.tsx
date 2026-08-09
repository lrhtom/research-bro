// ============================================================
//  统计页的四张图
//
//  全部是手写 SVG —— 站里本来就没有图表库，为四张图引一个进来
//  等于往项目里塞第二套设计语言（配色、字号、间距全是它的）。
//
//  提示框用原生 <title>：鼠标停上去浏览器自己弹，不需要 JS、不需要定位、
//  在触屏上长按也有，比自己写一套 tooltip 稳当得多。
//
//  两条画图上的规矩：
//   · 柱子一律画**次数**（一次评分 = 一根柱子的一格），因为每次评分的
//     state_before 只有一个值，分段才互斥；张数只在提示框里单列并标「张」。
//   · 没有学习的日子必须占住横轴的位置 —— 直接跳过会让停学两周
//     在图上变成一条连续的曲线。
// ============================================================

import type { CalendarCell, DailyVolume, ForecastBucket, StrengthBucket } from '../../../shared/types';

// 配色沿用 flashcards.css 里已有的那几支
const C_NEW = '#3b82f6';        // 新卡
const C_REPEAT = '#6366f1';     // 复习
const C_RETENTION = '#10b981';  // 留存率
const C_OVERDUE = '#ef4444';    // 逾期
const C_DUE = '#6366f1';        // 未来到期
const C_AXIS = '#9ca3af';
const C_GRID = '#e9eaf0';

/** 日历格子的五档颜色，从「没学」到「学得最多」 */
const HEAT = ['#eef0f4', '#c7d2fe', '#a5b4fc', '#818cf8', '#4f46e5'];

// ---------- 小工具 ----------

/**
 * 把 YYYY-MM-DD 当成一个**纯日期**解析，不带时区含义。
 *
 * 这些字符串是服务端在用户时区下算好的日历日（reviews.review_day），
 * 到了前端只用来排格子和显示，绝不能再拿本地时区解释一遍 ——
 * `new Date('2026-08-08')` 会按 UTC 午夜算，在东八区显示成 8 月 8 日没错，
 * 在西半球就变成 8 月 7 日了。
 */
function parts(day: string): { y: number; m: number; d: number } {
    const [y, m, d] = day.split('-').map(Number);
    return { y, m, d };
}

/** 周一 = 0 … 周日 = 6。用 UTC 是因为上面那条：这是纯日期，不是时刻。 */
function weekdayIndex(day: string): number {
    const { y, m, d } = parts(day);
    return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function shortDate(day: string): string {
    const { m, d } = parts(day);
    return `${m}月${d}日`;
}

function pct(v: number | null): string {
    return v === null ? '—' : `${(v * 100).toFixed(0)}%`;
}

/** 纵轴上界：给个好看的整数，别让柱子顶到天花板 */
function niceMax(values: number[]): number {
    const raw = Math.max(1, ...values);
    const step = Math.pow(10, Math.floor(Math.log10(raw)));
    return Math.ceil(raw / step) * step;
}

// ---------- 活动日历 ----------

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const GUTTER = 26;      // 左边写星期
const TOPBAR = 15;      // 上面写月份

export function ActivityCalendar({ cells }: { cells: CalendarCell[] }) {
    if (cells.length === 0) return null;

    // 按周分列：碰到周一就开新的一列，第一列可能不满（从周中开始）
    const columns: CalendarCell[][] = [];
    cells.forEach((c) => {
        if (columns.length === 0 || weekdayIndex(c.day) === 0) columns.push([]);
        columns[columns.length - 1].push(c);
    });

    const max = Math.max(1, ...cells.map((c) => c.taps));
    const width = GUTTER + columns.length * STEP;
    const height = TOPBAR + 7 * STEP;

    // 月份标签：某一列里出现了新的月份就在这一列上方标一次
    const months: Array<{ x: number; text: string }> = [];
    let lastMonth = -1;
    columns.forEach((col, i) => {
        const { m } = parts(col[0].day);
        if (m !== lastMonth) {
            lastMonth = m;
            months.push({ x: GUTTER + i * STEP, text: `${m}月` });
        }
    });

    return (
        <div className="fc-chart-wrap">
            <svg className="fc-chart" viewBox={`0 0 ${width} ${height}`} role="img"
                 aria-label={`最近 ${Math.ceil(cells.length / 7)} 周的学习活动日历`}>
                {months.map((mo) => (
                    <text key={mo.text + mo.x} x={mo.x} y={10} fontSize={9} fill={C_AXIS}>{mo.text}</text>
                ))}
                {['一', '三', '五', '日'].map((label, i) => (
                    <text key={label} x={0} y={TOPBAR + (i * 2) * STEP + CELL - 1} fontSize={9} fill={C_AXIS}>
                        {label}
                    </text>
                ))}

                {columns.map((col, ci) => col.map((c) => {
                    // 0 次就是最浅那一档；有学习的按占最大值的比例分四档
                    const level = c.taps === 0 ? 0 : Math.min(4, Math.ceil((c.taps / max) * 4));
                    return (
                        <rect
                            key={c.day}
                            x={GUTTER + ci * STEP}
                            y={TOPBAR + weekdayIndex(c.day) * STEP}
                            width={CELL}
                            height={CELL}
                            rx={2}
                            fill={HEAT[level]}
                        >
                            <title>
                                {shortDate(c.day)}　复习 {c.taps} 次
                                {c.newCards > 0 ? `　其中引入新卡 ${c.newCards} 张` : ''}
                            </title>
                        </rect>
                    );
                }))}
            </svg>

            <div className="fc-heat-legend">
                <span>少</span>
                {HEAT.map((c) => <i key={c} style={{ background: c }} />)}
                <span>多</span>
            </div>
        </div>
    );
}

// ---------- 每日学习量 ----------

const DV_W = 620;
const DV_H = 200;
const DV_PAD = { top: 12, right: 40, bottom: 26, left: 36 };

export function DailyVolumeChart({ days }: { days: DailyVolume[] }) {
    const plotW = DV_W - DV_PAD.left - DV_PAD.right;
    const plotH = DV_H - DV_PAD.top - DV_PAD.bottom;
    const slot = plotW / days.length;
    const barW = Math.max(3, slot - 3);

    const max = niceMax(days.map((d) => d.newTaps + d.repeatTaps));
    const y = (v: number) => DV_PAD.top + plotH - (v / max) * plotH;
    const cx = (i: number) => DV_PAD.left + i * slot + slot / 2;

    // 留存率折线只连**相邻两天都有样本**的点。
    // 中间断掉的地方就让它断着 —— 一口气连过去等于把停学的两周画成连续曲线。
    const segments: Array<Array<{ x: number; y: number }>> = [];
    days.forEach((d, i) => {
        if (d.retention === null) { segments.push([]); return; }
        const point = { x: cx(i), y: DV_PAD.top + plotH - d.retention * plotH };
        const last = segments[segments.length - 1];
        if (!last || last.length === 0) segments.push([point]);
        else last.push(point);
    });

    return (
        <div className="fc-chart-wrap">
            <svg className="fc-chart" viewBox={`0 0 ${DV_W} ${DV_H}`} role="img"
                 aria-label="最近 30 天每日评分次数与当日留存率">
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                    <g key={f}>
                        <line
                            x1={DV_PAD.left} x2={DV_W - DV_PAD.right}
                            y1={DV_PAD.top + plotH * f} y2={DV_PAD.top + plotH * f}
                            stroke={C_GRID} strokeWidth={1}
                        />
                        <text x={DV_PAD.left - 5} y={DV_PAD.top + plotH * f + 3}
                              fontSize={9} fill={C_AXIS} textAnchor="end">
                            {Math.round(max * (1 - f))}
                        </text>
                        <text x={DV_W - DV_PAD.right + 5} y={DV_PAD.top + plotH * f + 3}
                              fontSize={9} fill={C_RETENTION}>
                            {Math.round(100 * (1 - f))}%
                        </text>
                    </g>
                ))}

                {days.map((d, i) => {
                    const total = d.newTaps + d.repeatTaps;
                    const x = DV_PAD.left + i * slot + (slot - barW) / 2;
                    return (
                        <g key={d.day}>
                            {d.repeatTaps > 0 && (
                                <rect x={x} y={y(d.repeatTaps)} width={barW}
                                      height={DV_PAD.top + plotH - y(d.repeatTaps)} fill={C_REPEAT} rx={1} />
                            )}
                            {d.newTaps > 0 && (
                                <rect x={x} y={y(total)} width={barW}
                                      height={y(d.repeatTaps) - y(total)} fill={C_NEW} rx={1} />
                            )}
                            {/* 透明的整槽热区盖在柱子上层，这样 0 次的空日也停得住鼠标 ——
                                「这天没学」本身就是要查的信息 */}
                            <rect x={DV_PAD.left + i * slot} y={DV_PAD.top} width={slot} height={plotH} fill="transparent">
                                <title>
                                    {shortDate(d.day)}
                                    {total === 0
                                        ? '　没有学习'
                                        : `　共 ${total} 次（新卡 ${d.newTaps} 次 / 复习 ${d.repeatTaps} 次）`
                                          + `　碰过 ${d.cards} 张，其中新引入 ${d.newCards} 张`
                                          + `　当日留存 ${pct(d.retention)}`}
                                </title>
                            </rect>
                        </g>
                    );
                })}

                {segments.filter((s) => s.length > 1).map((s) => (
                    <polyline
                        key={s[0].x}
                        points={s.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none" stroke={C_RETENTION} strokeWidth={1.6}
                        strokeLinejoin="round" strokeLinecap="round"
                    />
                ))}
                {segments.flat().map((p) => (
                    <circle key={p.x} cx={p.x} cy={p.y} r={1.9} fill={C_RETENTION} />
                ))}

                <line x1={DV_PAD.left} x2={DV_W - DV_PAD.right}
                      y1={DV_PAD.top + plotH} y2={DV_PAD.top + plotH} stroke={C_AXIS} strokeWidth={1} />

                {days.map((d, i) => (
                    // 每 5 天标一次日期，全标会糊成一团
                    (i % 5 === 0 || i === days.length - 1) && (
                        <text key={d.day} x={cx(i)} y={DV_H - 9} fontSize={9} fill={C_AXIS} textAnchor="middle">
                            {shortDate(d.day)}
                        </text>
                    )
                ))}
            </svg>

            <ul className="fc-legend">
                <li><i style={{ background: C_NEW }} />新卡首次露面（次）</li>
                <li><i style={{ background: C_REPEAT }} />复习（次）</li>
                <li><i className="line" style={{ background: C_RETENTION }} />当日留存率（右轴）</li>
            </ul>
        </div>
    );
}

// ---------- 未来负载预测 ----------

// 这张图在两栏布局里只占半幅（约 340px 宽），viewBox 太宽的话
// 缩放比一压，9px 的轴标签会小到看不清 —— 所以画布做窄、字号做大。
const FC_W = 360;
const FC_H = 192;
const FC_PAD = { top: 12, right: 8, bottom: 34, left: 32 };

export function ForecastChart({ buckets }: { buckets: ForecastBucket[] }) {
    const plotW = FC_W - FC_PAD.left - FC_PAD.right;
    const plotH = FC_H - FC_PAD.top - FC_PAD.bottom;
    const slot = plotW / buckets.length;
    const barW = Math.max(3, slot - 3);
    const max = niceMax(buckets.map((b) => b.count));
    const y = (v: number) => FC_PAD.top + plotH - (v / max) * plotH;

    return (
        <div className="fc-chart-wrap">
            <svg className="fc-chart" viewBox={`0 0 ${FC_W} ${FC_H}`} role="img"
                 aria-label="逾期与未来 30 天的到期卡片数">
                {[0, 0.5, 1].map((f) => (
                    <g key={f}>
                        <line x1={FC_PAD.left} x2={FC_W - FC_PAD.right}
                              y1={FC_PAD.top + plotH * f} y2={FC_PAD.top + plotH * f}
                              stroke={C_GRID} strokeWidth={1} />
                        <text x={FC_PAD.left - 4} y={FC_PAD.top + plotH * f + 3}
                              fontSize={9} fill={C_AXIS} textAnchor="end">
                            {Math.round(max * (1 - f))}
                        </text>
                    </g>
                ))}

                {buckets.map((b, i) => {
                    const x = FC_PAD.left + i * slot + (slot - barW) / 2;
                    const label = b.overdue ? '已逾期' : i === 1 ? `今天（${shortDate(b.day)}）` : shortDate(b.day);
                    return (
                        <g key={b.overdue ? 'overdue' : b.day}>
                            {b.count > 0 && (
                                <rect x={x} y={y(b.count)} width={barW} height={FC_PAD.top + plotH - y(b.count)}
                                      fill={b.overdue ? C_OVERDUE : C_DUE} rx={1} />
                            )}
                            <rect x={FC_PAD.left + i * slot} y={FC_PAD.top} width={slot} height={plotH} fill="transparent">
                                <title>{label}　{b.count} 张到期</title>
                            </rect>
                        </g>
                    );
                })}

                {/* 逾期那根不属于时间轴，用一条竖线跟未来 30 天隔开 */}
                <line x1={FC_PAD.left + slot} x2={FC_PAD.left + slot}
                      y1={FC_PAD.top} y2={FC_PAD.top + plotH}
                      stroke={C_OVERDUE} strokeWidth={1} strokeDasharray="3 3" opacity={0.5} />

                <line x1={FC_PAD.left} x2={FC_W - FC_PAD.right}
                      y1={FC_PAD.top + plotH} y2={FC_PAD.top + plotH} stroke={C_AXIS} strokeWidth={1} />

                {/* 「逾期」这一格不在时间轴上，标签单独放在下面一行 ——
                    跟「今天」挤在同一行会直接叠成一团看不出是两个字 */}
                <text x={FC_PAD.left + slot / 2} y={FC_H - 4} fontSize={10} fill={C_OVERDUE} textAnchor="middle">
                    逾期
                </text>
                {buckets.map((b, i) => (
                    !b.overdue && (i - 1) % 7 === 0 && (
                        <text key={b.day} x={FC_PAD.left + i * slot + slot / 2} y={FC_H - 18}
                              fontSize={10} fill={C_AXIS} textAnchor="middle">
                            {i === 1 ? '今天' : shortDate(b.day)}
                        </text>
                    )
                ))}
            </svg>
        </div>
    );
}

// ---------- 记忆强度 ----------

/** 后两档（90 天以上）算是基本学会了 */
const LEARNED_FROM = 4;

export function StrengthChart({ buckets }: { buckets: StrengthBucket[] }) {
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const total = buckets.reduce((a, b) => a + b.count, 0);

    return (
        <ul className="fc-strength">
            {buckets.map((b, i) => (
                <li key={b.label} className={i >= LEARNED_FROM ? 'is-learned' : ''}>
                    <span className="fc-strength-label">{b.label}</span>
                    <span className="fc-strength-track">
                        <span
                            className="fc-strength-fill"
                            style={{ width: `${(b.count / max) * 100}%` }}
                            title={`${b.label}：${b.count} 张`}
                        />
                    </span>
                    <span className="fc-strength-num">
                        {b.count}
                        <small>{total > 0 ? ` · ${((b.count / total) * 100).toFixed(0)}%` : ''}</small>
                    </span>
                </li>
            ))}
        </ul>
    );
}
