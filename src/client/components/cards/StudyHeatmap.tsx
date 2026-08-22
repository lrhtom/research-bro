// 学习活动热力图 —— 照搬 aIELTS 那套「按月分块」的画法。
//
// 跟 GitHub 那种连续 53 周的图有一个关键差别：**格子按自然月分块**，
// 每个月自己起一列、月初空出星期几的位置，块与块之间留 8px。
// 这样月份标签能对准它真正管的那几列 —— 连续网格里一个月只能标在
// 「大概那一带」，看图的人得自己数。代价是块内会有前置空格。
//
// 深浅按**学习时长**分档，不是按评分次数：一天点 200 下「简单」不到三分钟，
// 跟啃 20 张难卡半小时不是一回事，用次数着色会把这两天画成一样深。
//
// 提示框走 createPortal 挂到 body 上：热力图外面那层有 overflow-x: auto
// （窄屏要横向滚），提示框留在里面会被裁掉半截。
//
// ---- 提示框跟着鼠标走，但位置不进 React state ----
// 位置每帧都在变，塞进 state 的话每次 mousemove 都会重渲染 441 个格子，
// 鼠标一划就卡。所以分成两路：
//   · 内容（哪一天、学了多久）进 state —— 只在跨格子时变，一秒撑死几次
//   · 位置直接写 DOM 的 transform —— 不经过 React，也不触发布局
// 用 transform 而不是 left/top：后者每帧都要重新布局，前者只走合成。

import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CalendarCell } from '../../../shared/types';

/** 一天学多久算一档。跟图例上写的字一一对应。 */
const LEVELS = [5, 10, 30] as const; // 分钟

function levelOf(ms: number): 0 | 1 | 2 | 3 | 4 {
    if (ms <= 0) return 0;
    const min = ms / 60000;
    if (min >= LEVELS[2]) return 4;
    if (min >= LEVELS[1]) return 3;
    if (min >= LEVELS[0]) return 2;
    return 1;
}

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 「3天 11小时 52秒」这种长格式，给顶部那句总计用 */
function longDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const parts: string[] = [];
    if (d) parts.push(`${d} 天`);
    if (h) parts.push(`${h} 小时`);
    if (m) parts.push(`${m} 分`);
    // 秒只在总量很小的时候才有意义；但一个都不显示会让「刚学了一会儿」变成空字符串
    if (sec && !d) parts.push(`${sec} 秒`);
    return parts.length ? parts.join(' ') : '0 秒';
}

/** 提示框里那句「学习 12 分 30 秒」 */
function midDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return sec ? `${m} 分 ${sec} 秒` : `${m} 分`;
}

/** 提示框里显示什么。坐标不在这儿 —— 位置走 ref 直接写 DOM，不进 state */
interface Tip {
    day: string;
    cell: CalendarCell | null;
}

/** 网格里的一格。inRange=false 是月初用来占位的空格，不可悬停。 */
interface Cell {
    cell?: CalendarCell;
    inRange: boolean;
}

interface MonthBlock {
    label: string;
    /** 每一列是一周（周日→周六 7 行） */
    weeks: Cell[][];
}

/**
 * 把一年的日历切成按月分块的网格。
 *
 * 每个月单独起块，块内第一列前面按「这个月 1 号是星期几」补空格；
 * 月末不足一周的也补满 7 格，否则最后一列会短一截、底边参差。
 */
function buildMonths(calendar: CalendarCell[]): MonthBlock[] {
    const out: MonthBlock[] = [];
    let curMonth = -1;
    let weeks: Cell[][] = [];
    let week: Cell[] = [];

    const flushWeek = () => {
        if (week.length === 0) return;
        while (week.length < 7) week.push({ inRange: false });
        weeks.push(week);
        week = [];
    };

    calendar.forEach((c) => {
        // 直接从 'YYYY-MM-DD' 造本地日期。用 new Date('2026-08-22') 会被当成 UTC，
        // 在东八区会整体前移一天，星期几全错
        const [y, m, d] = c.day.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        const month = date.getMonth();

        if (month !== curMonth) {
            if (curMonth !== -1) {
                flushWeek();
                out.push({ label: MONTHS[curMonth], weeks });
            }
            curMonth = month;
            weeks = [];
            week = [];
            for (let i = 0; i < date.getDay(); i += 1) week.push({ inRange: false });
        }

        week.push({ cell: c, inRange: true });
        if (week.length === 7) flushWeek();
    });

    if (curMonth !== -1) {
        flushWeek();
        out.push({ label: MONTHS[curMonth], weeks });
    }
    return out;
}

interface Props {
    calendar: CalendarCell[];
    /** 这一年的总时长 */
    yearMs: number;
    /** 有学习记录的天数 */
    activeDays: number;
    /** 连续学习天数 */
    streak: number;
}

/** 把光标坐标转成提示框的 transform：跟随光标，并抬到它上方 */
function tipTransform(x: number, y: number): string {
    return `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, calc(-100% - 12px))`;
}

export default function StudyHeatmap({ calendar, yearMs, activeDays, streak }: Props) {
    const [tip, setTip] = useState<Tip | null>(null);
    const tipRef = useRef<HTMLDivElement | null>(null);
    const posRef = useRef({ x: 0, y: 0 });
    const gridRef = useRef<HTMLDivElement | null>(null);

    const months = useMemo(() => buildMonths(calendar), [calendar]);

    /** 直接写 DOM，不走 state —— 见文件头的说明 */
    const place = useCallback((x: number, y: number) => {
        // 夹在网格范围内：光标滑到边缘时提示框不该飞出图外
        const box = gridRef.current?.getBoundingClientRect();
        const cx = box ? Math.min(Math.max(x, box.left), box.right) : x;
        const cy = box ? Math.min(Math.max(y, box.top), box.bottom) : y;
        posRef.current = { x: cx, y: cy };
        if (tipRef.current) tipRef.current.style.transform = tipTransform(cx, cy);
    }, []);

    const onMove = useCallback((ev: React.MouseEvent<HTMLDivElement>) => {
        const el = ev.target as HTMLElement;
        // 月与月之间那 8px 是 gap，不是元素 —— 光标划过去时没有任何格子的
        // mouseenter 会触发。不在这儿主动清掉的话，提示框会挂着上一天的数据
        // 停在空白处，看着像那块空白也有学习记录
        if (!el.classList?.contains('hm-day')) {
            setTip((cur) => (cur ? null : cur));
            return;
        }
        place(ev.clientX, ev.clientY);
    }, [place]);

    return (
        <div className="hm">
            <div className="hm-topbar">
                <span className="hm-title">
                    过去一年学习总时长：<b>{longDuration(yearMs)}</b>
                </span>
                <div className="hm-topbar-right">
                    <span className="hm-stat">累计学习 {activeDays} 天</span>
                    <span className="hm-divider" />
                    <span className="hm-stat">连续 {streak} 天</span>
                    <span className="hm-divider" />
                    <span className="hm-stat">最近一年</span>
                </div>
            </div>

            <div className="hm-body">
                <div className="hm-graph">
                    <div
                        className="hm-grid"
                        ref={gridRef}
                        onMouseMove={onMove}
                        onMouseLeave={() => setTip(null)}
                    >
                        {months.map((mb) => (
                            <div key={mb.label + mb.weeks.length} className="hm-month">
                                <div
                                    className="hm-cells"
                                    style={{ gridTemplateColumns: `repeat(${mb.weeks.length}, 10px)` }}
                                >
                                    {/* 行在外层、列在内层：CSS grid 默认按行铺，
                                        这样第 row 行的那 N 个格子才会横着排成一行 */}
                                    {[0, 1, 2, 3, 4, 5, 6].map((row) => mb.weeks.map((week, col) => {
                                        const c = week[row];
                                        if (!c || !c.inRange || !c.cell) {
                                            return <div key={`${col}-${row}`} className="hm-dot hm-empty" />;
                                        }
                                        const cell = c.cell;
                                        return (
                                            <div
                                                key={`${col}-${row}`}
                                                className={`hm-day hm-dot hm-lvl-${levelOf(cell.durationMs)}`}
                                                onMouseEnter={(ev) => {
                                                    // 内容进 state，位置照旧直接写 DOM ——
                                                    // 从没有提示框到有的那一下，也要落在光标上而不是格子中心
                                                    place(ev.clientX, ev.clientY);
                                                    setTip({ day: cell.day, cell });
                                                }}
                                            />
                                        );
                                    }))}
                                </div>
                                <div className="hm-xlabel">{mb.label}</div>
                            </div>
                        ))}
                    </div>

                    <div className="hm-legend">
                        <span>少</span>
                        <div className="hm-dot hm-lvl-0" />
                        <span>{LEVELS[0]}分钟</span>
                        <div className="hm-dot hm-lvl-1" />
                        <span>{LEVELS[1]}分钟</span>
                        <div className="hm-dot hm-lvl-2" />
                        <span>{LEVELS[2]}分钟</span>
                        <div className="hm-dot hm-lvl-3" />
                        <div className="hm-dot hm-lvl-4" />
                        <span>{LEVELS[2]}分钟+</span>
                    </div>
                </div>
            </div>

            {tip && createPortal(
                <div
                    className="hm-tip"
                    ref={tipRef}
                    // 初次挂载时先落在光标当前位置，之后由 place() 接管
                    style={{ transform: tipTransform(posRef.current.x, posRef.current.y) }}
                >
                    <span className="hm-tip-date">{tip.day}</span>
                    {!tip.cell || tip.cell.taps === 0 ? (
                        <span className="hm-tip-line">没有学习记录</span>
                    ) : (
                        <>
                            <span className="hm-tip-line">学习 {midDuration(tip.cell.durationMs)}</span>
                            {/* 次和张分两行写，各自标单位 —— 这两个口径在本站从不并排放同一行 */}
                            <span className="hm-tip-line">复习 {tip.cell.taps} 次</span>
                            <span className="hm-tip-line">碰过 {tip.cell.cards} 张</span>
                            {tip.cell.newCards > 0 && (
                                <span className="hm-tip-line">新卡 {tip.cell.newCards} 张</span>
                            )}
                        </>
                    )}
                </div>,
                document.body,
            )}
        </div>
    );
}
