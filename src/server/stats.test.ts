// ============================================================
//  学习统计的验收测试
//
//  每一条都对着一个「算错了页面就在骗人」的地方：
//    1. 连续天数：昨天断了就归零；只有今天有记录就是 1
//    2. 每日柱状图：没学习的日子照样占着横轴的位置
//    3. 留存率：全是新卡首次露面时显示「—」（null），不是 100%，也不崩
//    4. 分桶是划分：按次数分的两段加起来 == 当天评分次数；
//       按张数另算，等于 COUNT(DISTINCT card_id)
//    5. 几千张卡 + 0 条流水：读 cards 的面板照常出数，读 reviews 的给空状态
//    6. 预测：逾期的卡进「逾期」那根柱子，不进今天那根
// ============================================================

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db, initSchema, setSetting, useDatabase } from './db.js';
import { createCard, createPlan, listCards, rateCard } from './study.js';
import { statsOverview } from './stats.js';
import { recentDays } from './time.js';

const TZ = 'Asia/Shanghai';

/** 北京时间 2026-08-08 10:00 */
const T0 = new Date('2026-08-08T02:00:00.000Z');
const TODAY = '2026-08-08';

function daysAfter(base: Date, d: number): Date {
    return new Date(base.getTime() + d * 86400_000);
}

let conn: Database.Database;

beforeEach(() => {
    conn = new Database(':memory:');
    initSchema(conn);
    useDatabase(conn);
    setSetting('timezone', TZ);
});

afterEach(() => {
    conn.close();
});

function makePlan(cardCount: number, name = '测试计划', dailyNewLimit = 1000) {
    const plan = createPlan({ name, dailyNewLimit });
    for (let i = 1; i <= cardCount; i++) createCard(plan.id, `问题 ${i}`, `答案 ${i}`, T0);
    return plan;
}

/**
 * 直接往 reviews 里塞一行。
 *
 * 测试要造「三个月前学过」这类历史，走 rateCard 得把时钟一路推过去、
 * 卡片状态也会跟着变，反而说不清测的是什么。统计只读这张表，直接造更清楚。
 */
function insertReview(input: {
    cardId: number; planId: number; rating: number; day: string;
    stateBefore?: string; durationMs?: number;
}) {
    db().prepare(
        `INSERT INTO reviews (card_id, plan_id, rating, reviewed_at, review_day, duration_ms,
                              state_before, state_after, due_after, stability_after, difficulty_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'review', ?, 10, 5)`,
    ).run(
        input.cardId, input.planId, input.rating,
        `${input.day}T02:00:00.000Z`, input.day,
        input.durationMs ?? 0,
        input.stateBefore ?? 'review',
        `${input.day}T02:00:00.000Z`,
    );
}

// ------------------------------------------------------------

describe('连续学习天数', () => {
    it('只有今天有记录 → 1 天', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];
        insertReview({ cardId: card.id, planId: plan.id, rating: 3, day: TODAY });

        expect(statsOverview(plan.id, T0, TZ).streakDays).toBe(1);
    });

    it('今天没学但昨天学了 → 仍然算 1 天（不是每天凌晨清零）', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];
        insertReview({ cardId: card.id, planId: plan.id, rating: 3, day: '2026-08-07' });

        expect(statsOverview(plan.id, T0, TZ).streakDays).toBe(1);
    });

    it('昨天空着就断：今天 + 前天有记录，也只算 1 天', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];
        insertReview({ cardId: card.id, planId: plan.id, rating: 3, day: TODAY });
        insertReview({ cardId: card.id, planId: plan.id, rating: 3, day: '2026-08-06' });
        // 8-07 故意空着

        expect(statsOverview(plan.id, T0, TZ).streakDays).toBe(1);
    });

    it('连着五天就是 5；再往前空一天不算进去', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];
        ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'].forEach((day) => {
            insertReview({ cardId: card.id, planId: plan.id, rating: 3, day });
        });
        // 8-02 有记录，但 8-03 是空的 —— 连不上
        insertReview({ cardId: card.id, planId: plan.id, rating: 3, day: '2026-08-02' });

        expect(statsOverview(plan.id, T0, TZ).streakDays).toBe(5);
    });

    it('今天和昨天都没学 → 0，不管更早连过多少天', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];
        ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'].forEach((day) => {
            insertReview({ cardId: card.id, planId: plan.id, rating: 3, day });
        });

        expect(statsOverview(plan.id, T0, TZ).streakDays).toBe(0);
    });
});

describe('每日学习量', () => {
    it('没学习的日子照样出现在横轴上（30 天一天都不少）', () => {
        const plan = makePlan(2);
        const [c1, c2] = listCards(plan.id);
        insertReview({ cardId: c1.id, planId: plan.id, rating: 3, day: TODAY });
        insertReview({ cardId: c2.id, planId: plan.id, rating: 3, day: '2026-07-25' });

        const s = statsOverview(plan.id, T0, TZ);

        expect(s.daily).toHaveLength(30);
        expect(s.daily[s.daily.length - 1].day).toBe(TODAY);
        expect(s.daily[0].day).toBe(s.windowStart);

        // 日期严格连续、不重复、不跳
        const days = s.daily.map((d) => d.day);
        expect(days).toEqual(recentDays(30, T0, TZ));
        expect(new Set(days).size).toBe(30);

        // 两条记录之间那些空日必须在，而且是「0 次」而不是被删掉
        const gap = s.daily.filter((d) => d.day > '2026-07-25' && d.day < TODAY);
        expect(gap.length).toBe(13);
        expect(gap.every((d) => d.newTaps === 0 && d.repeatTaps === 0)).toBe(true);
        // 空日的留存率是 null，不是 0 —— 那天没有任何样本
        expect(gap.every((d) => d.retention === null)).toBe(true);
    });

    it('活动日历同样按 26 周补满，没有一天被跳过', () => {
        const plan = makePlan(1);
        insertReview({ cardId: listCards(plan.id)[0].id, planId: plan.id, rating: 3, day: TODAY });

        const s = statsOverview(plan.id, T0, TZ);
        expect(s.calendar).toHaveLength(26 * 7);
        expect(s.calendar.map((c) => c.day)).toEqual(recentDays(26 * 7, T0, TZ));
        expect(s.calendar[s.calendar.length - 1]).toMatchObject({ day: TODAY, taps: 1 });
    });
});

describe('留存率', () => {
    it('全是新卡首次露面时显示「—」（null），不是 100%，也不除零', () => {
        const plan = makePlan(3);
        listCards(plan.id).forEach((c) => {
            // 三张卡各评一次「良好」，但都是第一次见 → 一条样本都不算数
            insertReview({ cardId: c.id, planId: plan.id, rating: 3, day: TODAY, stateBefore: 'new' });
        });

        const s = statsOverview(plan.id, T0, TZ);
        expect(s.hasReviews).toBe(true);
        expect(s.retention30.eligibleTaps).toBe(0);
        expect(s.retention30.rate).toBeNull();
        expect(Number.isNaN(s.retention30.rate as unknown as number)).toBe(false);

        // 当天那一格同样是 null
        expect(s.daily[s.daily.length - 1].retention).toBeNull();
        // 但「次数」照常统计得到
        expect(s.todayTaps).toBe(3);
        expect(s.daily[s.daily.length - 1].newTaps).toBe(3);
    });

    it('完全没有复习记录时也是 null，不崩', () => {
        const plan = makePlan(5);
        const s = statsOverview(plan.id, T0, TZ);
        expect(s.retention30).toEqual({ eligibleTaps: 0, recalledTaps: 0, rate: null });
    });

    it('只统计非新卡的评分：rating >= 2 算记住了', () => {
        const plan = makePlan(4);
        const cards = listCards(plan.id);
        // 新卡首次露面：一次「重来」—— 不该被算进分母
        insertReview({ cardId: cards[0].id, planId: plan.id, rating: 1, day: TODAY, stateBefore: 'new' });
        // 真正的记忆测试：3 次记住、1 次忘掉
        insertReview({ cardId: cards[1].id, planId: plan.id, rating: 3, day: TODAY });
        insertReview({ cardId: cards[2].id, planId: plan.id, rating: 2, day: TODAY });
        insertReview({ cardId: cards[3].id, planId: plan.id, rating: 4, day: TODAY });
        insertReview({ cardId: cards[1].id, planId: plan.id, rating: 1, day: TODAY });

        const s = statsOverview(plan.id, T0, TZ);
        expect(s.retention30.eligibleTaps).toBe(4);      // 不含那次新卡
        expect(s.retention30.recalledTaps).toBe(3);
        expect(s.retention30.rate).toBeCloseTo(0.75);
    });

    it('30 天窗口之外的记录不参与计算', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];
        // 60 天前忘了一次，窗口内记住一次 → 窗口内应该是 100%
        insertReview({ cardId: card.id, planId: plan.id, rating: 1, day: '2026-06-09' });
        insertReview({ cardId: card.id, planId: plan.id, rating: 3, day: TODAY });

        const s = statsOverview(plan.id, T0, TZ);
        expect(s.retention30.eligibleTaps).toBe(1);
        expect(s.retention30.rate).toBe(1);
    });
});

describe('分桶必须是划分', () => {
    it('按次数分的两段加起来 == 当天评分次数；张数另算 == COUNT(DISTINCT card_id)', () => {
        const plan = makePlan(3, '真的学一遍');
        const cards = listCards(plan.id);

        // 走真实评分路径：第一张忘两次再良好，另外两张一次过
        let t = T0;
        rateCard(plan.id, cards[0].id, 1, 500, t, TZ);
        t = new Date(t.getTime() + 120_000);
        rateCard(plan.id, cards[0].id, 1, 500, t, TZ);
        t = new Date(t.getTime() + 120_000);
        rateCard(plan.id, cards[0].id, 3, 500, t, TZ);
        rateCard(plan.id, cards[1].id, 3, 500, t, TZ);
        rateCard(plan.id, cards[2].id, 4, 500, t, TZ);

        const s = statsOverview(plan.id, t, TZ);
        const day = s.daily[s.daily.length - 1];

        // 每次评分的 state_before 只有一个值，所以两段互斥且穷尽
        expect(day.newTaps + day.repeatTaps).toBe(s.todayTaps);
        expect(s.todayTaps).toBe(5);

        // 张数是另一个口径：3 张卡（第一张评了三次也还是一张）
        expect(day.cards).toBe(3);
        expect(s.todayCards).toBe(3);
        expect(day.newCards).toBe(3);

        // 两个口径不能相等纯属巧合的情况要排除：这里 5 次 ≠ 3 张
        expect(s.todayTaps).not.toBe(s.todayCards);
    });

    it('日历格子里的「次」与「张」也是两个独立口径', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];
        insertReview({ cardId: card.id, planId: plan.id, rating: 1, day: TODAY, stateBefore: 'new' });
        insertReview({ cardId: card.id, planId: plan.id, rating: 3, day: TODAY, stateBefore: 'learning' });

        const cell = statsOverview(plan.id, T0, TZ).calendar.at(-1)!;
        expect(cell.taps).toBe(2);        // 两次点击
        expect(cell.newCards).toBe(1);    // 一张新卡
    });
});

describe('有卡片没流水的计划（从别的软件导进来的历史）', () => {
    /** 3876 张卡，全都有 stability / due / reps，但 reviews 表一行都没有 */
    function importedPlan() {
        const plan = createPlan({ name: '导入的历史', dailyNewLimit: 20 });
        const insert = db().prepare(
            `INSERT INTO cards (plan_id, front, back, state, stability, difficulty, due, last_review,
                                reps, lapses, elapsed_days, scheduled_days, learning_steps,
                                sort_order, created_at, updated_at)
             VALUES (?, ?, '', 'review', ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`,
        );
        const ts = T0.toISOString();
        const run = db().transaction(() => {
            for (let i = 0; i < 3876; i++) {
                // 强度散布到六个档位里，到期日散布在逾期～未来 40 天
                const stability = [0.5, 3, 15, 60, 200, 500][i % 6];
                const due = daysAfter(T0, (i % 45) - 5).toISOString();
                insert.run(plan.id, `词 ${i}`, stability, 5, due, ts, 3, i % 7 === 0 ? 2 : 0, i, ts, ts);
            }
        });
        run();
        return plan;
    }

    it('读 cards 的面板全都照常出数', () => {
        const plan = importedPlan();
        const s = statsOverview(plan.id, T0, TZ);

        // 卡片总数
        expect(s.cards.total).toBe(3876);
        expect(s.cards.new).toBe(0);
        expect(s.cards.review).toBe(3876);

        // 记忆强度：六档加起来正好是非新卡的张数，一张都不许漏
        const strengthSum = s.strength.reduce((a, b) => a + b.count, 0);
        expect(strengthSum).toBe(3876);
        expect(s.strength.every((b) => b.count > 0)).toBe(true);

        // 未来负载：31 根柱子（逾期 + 30 天），而且确实有数
        expect(s.forecast).toHaveLength(31);
        expect(s.forecast.reduce((a, b) => a + b.count, 0)).toBeGreaterThan(0);
        expect(s.forecast[0].overdue).toBe(true);
        expect(s.forecast[0].count).toBeGreaterThan(0);

        // 老忘的卡：只收 lapses > 0 的，最多 20 张
        expect(s.leeches).toHaveLength(20);
        expect(s.leeches.every((l) => l.lapses > 0)).toBe(true);
    });

    it('读 reviews 的面板一律是空状态，不是 0，也不是 NaN', () => {
        const plan = importedPlan();
        const s = statsOverview(plan.id, T0, TZ);

        expect(s.hasReviews).toBe(false);          // ← 界面据此显示空状态文案
        expect(s.retention30.rate).toBeNull();     // 不是 100%，也不是 0
        expect(s.streakDays).toBe(0);
        expect(s.todayTaps).toBe(0);
        expect(s.durationMs30).toBe(0);

        // 图表的骨架还在（横轴该有多少天就有多少天），只是每天都是 0
        expect(s.daily).toHaveLength(30);
        expect(s.daily.every((d) => d.newTaps === 0 && d.repeatTaps === 0)).toBe(true);
        expect(s.daily.every((d) => d.retention === null)).toBe(true);
        expect(s.calendar.every((c) => c.taps === 0)).toBe(true);
    });

    it('没有任何卡片的空计划也不会崩', () => {
        const plan = createPlan({ name: '空计划' });
        const s = statsOverview(plan.id, T0, TZ);

        expect(s.cards).toEqual({ total: 0, new: 0, learning: 0, review: 0 });
        expect(s.strength.reduce((a, b) => a + b.count, 0)).toBe(0);
        expect(s.forecast.every((f) => f.count === 0)).toBe(true);
        expect(s.leeches).toEqual([]);
        expect(s.retention30.rate).toBeNull();
    });
});

describe('未来负载预测', () => {
    it('逾期的卡进「逾期」那根柱子，不进今天那根', () => {
        const plan = createPlan({ name: '到期分布' });
        const insert = db().prepare(
            `INSERT INTO cards (plan_id, front, back, state, stability, difficulty, due, last_review,
                                reps, lapses, elapsed_days, scheduled_days, learning_steps,
                                sort_order, created_at, updated_at)
             VALUES (?, ?, '', 'review', 10, 5, ?, ?, 1, 0, 0, 0, 0, 0, ?, ?)`,
        );
        const ts = T0.toISOString();

        // 三张昨天就该复习的（逾期）
        for (let i = 0; i < 3; i++) insert.run(plan.id, `逾期 ${i}`, daysAfter(T0, -1).toISOString(), ts, ts, ts);
        // 两张今天到期：一张今天凌晨（已经过了钟点，但仍是今天的活），一张今天稍晚
        insert.run(plan.id, '今天早上', '2026-08-07T16:30:00.000Z', ts, ts, ts);   // 北京时间 8-08 00:30
        insert.run(plan.id, '今天晚上', '2026-08-08T13:00:00.000Z', ts, ts, ts);   // 北京时间 8-08 21:00
        // 一张明天
        insert.run(plan.id, '明天', daysAfter(T0, 1).toISOString(), ts, ts, ts);

        const f = statsOverview(plan.id, T0, TZ).forecast;

        expect(f[0].overdue).toBe(true);
        expect(f[0].count).toBe(3);          // ← 三张逾期的，全在这一根里
        expect(f[1].day).toBe(TODAY);
        expect(f[1].count).toBe(2);          // ← 今天那根只有今天到期的两张
        expect(f[2].count).toBe(1);
        expect(f.slice(3).every((b) => b.count === 0)).toBe(true);
    });

    it('新卡不算进负载 —— 它们的到期日是创建时间，会把「逾期」撑爆', () => {
        // 新卡的 due 就是创建时刻，全落在「今天早些时候」
        const plan = makePlan(50);
        const f = statsOverview(plan.id, T0, TZ).forecast;

        expect(f.reduce((a, b) => a + b.count, 0)).toBe(0);
        // 卡片面板照样看得到这 50 张
        expect(statsOverview(plan.id, T0, TZ).cards).toMatchObject({ total: 50, new: 50 });
    });
});

describe('计划筛选', () => {
    it('传 null 是全部计划；传 id 只看那一个', () => {
        const a = makePlan(2, 'A 计划');
        const b = makePlan(3, 'B 计划');

        insertReview({ cardId: listCards(a.id)[0].id, planId: a.id, rating: 3, day: TODAY, durationMs: 1000 });
        insertReview({ cardId: listCards(b.id)[0].id, planId: b.id, rating: 3, day: TODAY, durationMs: 2000 });
        insertReview({ cardId: listCards(b.id)[1].id, planId: b.id, rating: 1, day: TODAY, durationMs: 3000 });

        const all = statsOverview(null, T0, TZ);
        expect(all.planId).toBeNull();
        expect(all.cards.total).toBe(5);
        expect(all.todayTaps).toBe(3);
        expect(all.durationMs30).toBe(6000);
        // 选择器里的顺序跟计划列表页完全一致（先收藏、再 sort_order）——
        // 手动新建的计划排到最前面，所以后建的 B 在前
        expect(all.plans.map((p) => p.name)).toEqual(['B 计划', 'A 计划']);

        const onlyA = statsOverview(a.id, T0, TZ);
        expect(onlyA.cards.total).toBe(2);
        expect(onlyA.todayTaps).toBe(1);
        expect(onlyA.durationMs30).toBe(1000);
        expect(onlyA.retention30.rate).toBe(1);

        const onlyB = statsOverview(b.id, T0, TZ);
        expect(onlyB.todayTaps).toBe(2);
        expect(onlyB.retention30.rate).toBeCloseTo(0.5);
    });

    it('一个计划有流水、另一个没有：各自的 hasReviews 互不影响', () => {
        const a = makePlan(1, '学过的');
        const b = makePlan(1, '没学过的');
        insertReview({ cardId: listCards(a.id)[0].id, planId: a.id, rating: 3, day: TODAY });

        expect(statsOverview(a.id, T0, TZ).hasReviews).toBe(true);
        expect(statsOverview(b.id, T0, TZ).hasReviews).toBe(false);
        expect(statsOverview(null, T0, TZ).hasReviews).toBe(true);
    });
});

describe('日历日边界', () => {
    it('用的是 review_day 这一列，不拿 reviewed_at 重新换算', () => {
        const plan = makePlan(2);
        const [c1, c2] = listCards(plan.id);

        // 同一个 UTC 时刻附近的两次评分，review_day 分属两天 ——
        // 服务端要照抄这一列，不能按自己的时区重算
        rateCard(plan.id, c1.id, 3, 0, new Date('2026-08-08T15:55:00.000Z'), TZ);  // 北京 8-08 23:55
        rateCard(plan.id, c2.id, 3, 0, new Date('2026-08-08T16:05:00.000Z'), TZ);  // 北京 8-09 00:05

        const late = statsOverview(plan.id, new Date('2026-08-08T15:56:00.000Z'), TZ);
        const early = statsOverview(plan.id, new Date('2026-08-08T16:06:00.000Z'), TZ);

        expect(late.day).toBe('2026-08-08');
        expect(late.todayTaps).toBe(1);
        expect(early.day).toBe('2026-08-09');
        expect(early.todayTaps).toBe(1);

        // 两天都有记录 → 连续 2 天
        expect(early.streakDays).toBe(2);
    });

    it('跨夏令时的时区里，30 天窗口还是 30 个不重复的日子', () => {
        const plan = makePlan(1);
        const ny = 'America/New_York';
        // 2026-03-08 是纽约夏令时开始那天，只有 23 小时
        const s = statsOverview(plan.id, new Date('2026-03-15T16:00:00.000Z'), ny);

        expect(s.daily).toHaveLength(30);
        expect(new Set(s.daily.map((d) => d.day)).size).toBe(30);
        expect(s.daily.at(-1)!.day).toBe('2026-03-15');
        expect(s.daily.some((d) => d.day === '2026-03-08')).toBe(true);
    });
});
