// ============================================================
//  学习统计
//
//  只读。这个文件一行 UPDATE / INSERT 都没有。
//
//  五条「算错了页面就在骗人」的规矩，逐条落在下面的查询里：
//
//   1. 一次评分 ≠ 一张卡。reviews 一行 = 点了一次评分按钮；一张卡评三次
//      「重来」再评一次「良好」，是 4 行流水、1 张卡。所以字段名分成
//      xxxTaps（次）和 xxxCards（张），前端也必须把单位写在标签上。
//
//   2. 日历日一律用 reviews.review_day 这一列，**绝不**拿 reviewed_at
//      自己再换算一遍 —— 那一列写入时就是按用户时区算好的，
//      在服务端时区里重算会把 23:55 和 00:05 挪到错误的日子里去。
//
//   3. 分桶必须是划分。每次评分的 state_before 只有一个值，
//      所以「新卡首次露面 / 其余」按次数分桶天然互斥且穷尽；
//      按张数分桶做不到这一点（同一张卡同一天可以既是新卡又是复习），
//      所以柱状图一律画次数，张数只在提示框里单独列。
//
//   4. 分母必须够得着。今日进度的分母是「已完成 + 队列剩余」，
//      不是 daily_new_limit（见 study.ts）—— 这里干脆不画今日进度条。
//
//   5. 留存率排除新卡。一张卡的第一次评分是「初次见面」，不是记忆测试，
//      所以任何留存 / 正确率都先滤掉 state_before = 'new'。
//      样本为 0 时返回 null，前端显示「—」，绝不显示 100%，也绝不除零。
//
//  还有一件事：有些计划有几千张带着 stability / due 的卡，
//  但 reviews 表一行都没有（历史是从别的软件导进来的）。
//  凡是读 cards 的面板照常出数，凡是读 reviews 的面板出空状态。
// ============================================================

import { db } from './db.js';
import { calendarDay, dayBounds, recentDays, startOfDay, startOfPrevDay } from './time.js';
import { timeZone } from './study.js';
import type {
    CalendarCell, CardTotals, DailyVolume, ForecastBucket, Leech,
    Retention, StatsOverview, StrengthBucket,
} from '../shared/types.js';

/** 活动日历的跨度：26 周 */
const CALENDAR_WEEKS = 26;
const CALENDAR_DAYS = CALENDAR_WEEKS * 7;
/** 每日柱状图与留存 / 时长的窗口 */
const WINDOW_DAYS = 30;
/** 负载预测往后看多少天 */
const FORECAST_DAYS = 30;
/** 复习榜取前几名 */
const LEECH_LIMIT = 20;

/**
 * 计划筛选。null = 全部计划。
 *
 * 写成 `@plan IS NULL OR ... = @plan` 是为了让「全部」和「某一个」共用
 * 同一条预编译语句 —— 两份 SQL 拼字符串迟早会改漏一处。
 */
type PlanFilter = number | null;

// ---------- 卡片面板（不依赖复习流水，永远出得了数） ----------

function cardTotals(plan: PlanFilter): CardTotals {
    const r = db().prepare(
        `SELECT
             COUNT(*)                                              AS total,
             COALESCE(SUM(state = 'new'), 0)                       AS news,
             COALESCE(SUM(state IN ('learning', 'relearning')), 0) AS learning,
             COALESCE(SUM(state = 'review'), 0)                    AS review
         FROM cards
         WHERE (@plan IS NULL OR plan_id = @plan)`,
    ).get({ plan }) as { total: number; news: number; learning: number; review: number };

    return { total: r.total, new: r.news, learning: r.learning, review: r.review };
}

/**
 * 未来负载。
 *
 * 逾期的定义是「到期日落在今天之前」，不是「due < 此刻」——
 * 今天上午 9 点到期、现在下午 3 点的卡仍然算今天的活，画在今天那根柱子上。
 *
 * 新卡不算在内：它们的 due 是创建时间，全都躺在过去，
 * 一并算进去会让「逾期」这根柱子直接冲到几千，而它们真正的闸门是
 * 每日新卡上限，跟到期日没关系。
 */
function forecast(plan: PlanFilter, now: Date, tz: string): ForecastBucket[] {
    const bounds = dayBounds(FORECAST_DAYS, now, tz).map((d) => d.toISOString());

    // 第一行是「逾期」桶：下界用空串，任何非空字符串都 >= 它。
    const rows: Array<[number, string, string]> = [[-1, '', bounds[0]]];
    for (let i = 0; i < FORECAST_DAYS; i++) rows.push([i, bounds[i], bounds[i + 1]]);

    const values = rows.map(() => '(?, ?, ?)').join(', ');
    const params: unknown[] = [];
    rows.forEach(([idx, lo, hi]) => params.push(idx, lo, hi));
    params.push(plan, plan);

    const counted = db().prepare(
        `WITH bounds(idx, lo, hi) AS (VALUES ${values})
         SELECT b.idx AS idx, COUNT(c.id) AS n
         FROM bounds b
         LEFT JOIN cards c
                ON c.due >= b.lo AND c.due < b.hi
               AND c.state != 'new'
               AND (? IS NULL OR c.plan_id = ?)
         GROUP BY b.idx
         ORDER BY b.idx`,
    ).all(...params) as Array<{ idx: number; n: number }>;

    const byIdx = new Map(counted.map((r) => [r.idx, r.n]));
    const days = bounds.slice(0, FORECAST_DAYS).map((iso) => calendarDay(new Date(iso), tz));

    return [
        { overdue: true, day: '', count: byIdx.get(-1) ?? 0 },
        ...days.map((day, i) => ({ overdue: false, day, count: byIdx.get(i) ?? 0 })),
    ];
}

/** 记忆强度：stability（这份记忆还能撑几天）的分布。新卡没有强度可言，排除。 */
function strength(plan: PlanFilter): StrengthBucket[] {
    const r = db().prepare(
        `SELECT
             COALESCE(SUM(stability <   1),                     0) AS b0,
             COALESCE(SUM(stability >=  1 AND stability <   7),  0) AS b1,
             COALESCE(SUM(stability >=  7 AND stability <  30),  0) AS b2,
             COALESCE(SUM(stability >= 30 AND stability <  90),  0) AS b3,
             COALESCE(SUM(stability >= 90 AND stability < 365),  0) AS b4,
             COALESCE(SUM(stability >= 365),                     0) AS b5
         FROM cards
         WHERE state != 'new' AND (@plan IS NULL OR plan_id = @plan)`,
    ).get({ plan }) as Record<string, number>;

    return [
        { label: '不到 1 天', count: r.b0 },
        { label: '1–7 天', count: r.b1 },
        { label: '7–30 天', count: r.b2 },
        { label: '30–90 天', count: r.b3 },
        { label: '90 天–1 年', count: r.b4 },
        { label: '1 年以上', count: r.b5 },
    ];
}

/**
 * 老忘的卡。
 *
 * 只收 lapses > 0 的 —— 一张从没忘过的卡出现在「总是记不住」榜里毫无意义，
 * 而不加这个条件时，一个全对的牌组会随机顶 20 张上来充数。
 */
function leeches(plan: PlanFilter): Leech[] {
    const rows = db().prepare(
        `SELECT c.id, c.plan_id, p.name AS plan_name, c.front, c.back,
                c.lapses, c.difficulty, c.stability, c.due, c.state
         FROM cards c
         JOIN plans p ON p.id = c.plan_id
         WHERE c.lapses > 0 AND (@plan IS NULL OR c.plan_id = @plan)
         ORDER BY c.lapses DESC, c.difficulty DESC, c.id ASC
         LIMIT ${LEECH_LIMIT}`,
    ).all({ plan }) as Array<{
        id: number; plan_id: number; plan_name: string; front: string; back: string;
        lapses: number; difficulty: number; stability: number; due: string; state: Leech['state'];
    }>;

    return rows.map((r) => ({
        id: r.id,
        planId: r.plan_id,
        planName: r.plan_name,
        front: r.front,
        back: r.back,
        lapses: r.lapses,
        difficulty: r.difficulty,
        stability: r.stability,
        due: r.due,
        state: r.state,
    }));
}

// ---------- 流水面板（没有 reviews 就该出空状态） ----------

function hasReviews(plan: PlanFilter): boolean {
    const r = db().prepare(
        `SELECT EXISTS (
             SELECT 1 FROM reviews WHERE (@plan IS NULL OR plan_id = @plan)
         ) AS n`,
    ).get({ plan }) as { n: number };
    return r.n === 1;
}

/** 今天：次数与张数一起取，但分成两个字段返回，前端各自标单位 */
function today(plan: PlanFilter, day: string): { taps: number; cards: number } {
    const r = db().prepare(
        `SELECT COUNT(*) AS taps, COUNT(DISTINCT card_id) AS cards
         FROM reviews
         WHERE review_day = @day AND (@plan IS NULL OR plan_id = @plan)`,
    ).get({ plan, day }) as { taps: number; cards: number };
    return r;
}

/**
 * 连续学习天数。
 *
 * 以今天结尾；今天还没学的话允许以昨天结尾（不然每天凌晨起来都看到 0，
 * 那不是数据的意思）。往回走，碰到第一个没有任何评分的日子就断。
 */
function streak(plan: PlanFilter, now: Date, tz: string): number {
    const rows = db().prepare(
        `SELECT DISTINCT review_day AS day
         FROM reviews
         WHERE (@plan IS NULL OR plan_id = @plan)
         ORDER BY review_day DESC
         LIMIT 3700`,
    ).all({ plan }) as Array<{ day: string }>;

    const seen = new Set(rows.map((r) => r.day));
    if (seen.size === 0) return 0;

    let cursor = startOfDay(now, tz);
    if (!seen.has(calendarDay(cursor, tz))) {
        cursor = startOfPrevDay(cursor, tz);
        if (!seen.has(calendarDay(cursor, tz))) return 0;
    }

    let n = 0;
    while (seen.has(calendarDay(cursor, tz))) {
        n++;
        cursor = startOfPrevDay(cursor, tz);
    }
    return n;
}

/**
 * 留存率：记得住的比例。
 *
 * 规矩 5：先滤掉 state_before = 'new' —— 第一次见到一张卡时按的那一下
 * 反映的是「这张卡难不难」，不是「你记住了没有」。
 * 分母为 0 就返回 null，界面上显示「—」。
 */
function retention(plan: PlanFilter, from: string, to: string): Retention {
    const r = db().prepare(
        `SELECT COUNT(*) AS eligible, COALESCE(SUM(rating >= 2), 0) AS recalled
         FROM reviews
         WHERE review_day >= @from AND review_day <= @to
           AND state_before != 'new'
           AND (@plan IS NULL OR plan_id = @plan)`,
    ).get({ plan, from, to }) as { eligible: number; recalled: number };

    return {
        eligibleTaps: r.eligible,
        recalledTaps: r.recalled,
        rate: r.eligible > 0 ? r.recalled / r.eligible : null,
    };
}

function studiedMs(plan: PlanFilter, from: string, to: string): number {
    const r = db().prepare(
        `SELECT COALESCE(SUM(duration_ms), 0) AS ms
         FROM reviews
         WHERE review_day >= @from AND review_day <= @to
           AND (@plan IS NULL OR plan_id = @plan)`,
    ).get({ plan, from, to }) as { ms: number };
    return r.ms;
}

/**
 * 活动日历。
 *
 * 有评分的日子才有行，所以在 JS 里按完整日期序列补零 ——
 * 缺的那些日子必须以「0 次」的形式出现在格子里，
 * 直接跳过会让中间停学的两周在图上凭空消失。
 */
function calendar(plan: PlanFilter, days: string[]): CalendarCell[] {
    const rows = db().prepare(
        `SELECT review_day AS day,
                COUNT(*) AS taps,
                COUNT(DISTINCT CASE WHEN state_before = 'new' THEN card_id END) AS new_cards
         FROM reviews
         WHERE review_day >= @from AND review_day <= @to
           AND (@plan IS NULL OR plan_id = @plan)
         GROUP BY review_day`,
    ).all({ plan, from: days[0], to: days[days.length - 1] }) as Array<{
        day: string; taps: number; new_cards: number;
    }>;

    const byDay = new Map(rows.map((r) => [r.day, r]));
    return days.map((day) => {
        const hit = byDay.get(day);
        return { day, taps: hit?.taps ?? 0, newCards: hit?.new_cards ?? 0 };
    });
}

/**
 * 每日学习量。
 *
 * 柱子画的是**次数**（newTaps + repeatTaps）：每次评分的 state_before
 * 只有一个值，两根分段天然互斥且穷尽，加起来正好是当天的评分次数。
 * 张数（newCards / cards）另算，只在提示框里单列，绝不跟次数堆进同一根柱子。
 *
 * 同样按完整日期序列补零 —— 没学习的日子要在横轴上留出空位。
 */
function daily(plan: PlanFilter, days: string[]): DailyVolume[] {
    const rows = db().prepare(
        `SELECT review_day AS day,
                COALESCE(SUM(state_before =  'new'), 0) AS new_taps,
                COALESCE(SUM(state_before != 'new'), 0) AS repeat_taps,
                COUNT(DISTINCT CASE WHEN state_before = 'new' THEN card_id END) AS new_cards,
                COUNT(DISTINCT card_id) AS cards,
                COALESCE(SUM(state_before != 'new' AND rating >= 2), 0) AS recalled
         FROM reviews
         WHERE review_day >= @from AND review_day <= @to
           AND (@plan IS NULL OR plan_id = @plan)
         GROUP BY review_day`,
    ).all({ plan, from: days[0], to: days[days.length - 1] }) as Array<{
        day: string; new_taps: number; repeat_taps: number;
        new_cards: number; cards: number; recalled: number;
    }>;

    const byDay = new Map(rows.map((r) => [r.day, r]));
    return days.map((day) => {
        const r = byDay.get(day);
        if (!r) {
            return { day, newTaps: 0, repeatTaps: 0, newCards: 0, cards: 0, retention: null };
        }
        return {
            day,
            newTaps: r.new_taps,
            repeatTaps: r.repeat_taps,
            newCards: r.new_cards,
            cards: r.cards,
            // 分母同样排除新卡（规矩 5）；当天没有可复习的样本就是 null，不是 0% 也不是 100%
            retention: r.repeat_taps > 0 ? r.recalled / r.repeat_taps : null,
        };
    });
}

// ---------- 总装 ----------

export function statsOverview(
    plan: PlanFilter,
    now = new Date(),
    tz = timeZone(),
): StatsOverview {
    const day = calendarDay(now, tz);
    const windowDays = recentDays(WINDOW_DAYS, now, tz);
    const calendarDays = recentDays(CALENDAR_DAYS, now, tz);
    const windowStart = windowDays[0];

    const t = today(plan, day);
    const plans = db().prepare(
        'SELECT id, name FROM plans ORDER BY favorite DESC, sort_order ASC, id ASC',
    ).all() as Array<{ id: number; name: string }>;

    return {
        planId: plan,
        plans,
        timeZone: tz,
        day,
        windowStart,

        cards: cardTotals(plan),

        todayTaps: t.taps,
        todayCards: t.cards,

        streakDays: streak(plan, now, tz),
        retention30: retention(plan, windowStart, day),
        durationMs30: studiedMs(plan, windowStart, day),

        calendar: calendar(plan, calendarDays),
        daily: daily(plan, windowDays),
        forecast: forecast(plan, now, tz),
        strength: strength(plan),
        leeches: leeches(plan),

        hasReviews: hasReviews(plan),
    };
}
