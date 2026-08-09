// ============================================================
//  记忆卡的验收测试
//
//  覆盖需求里点名的六条，外加几条同样容易做错的：
//    1. 新卡评「良好」排到将来，今天不再出现在队列里
//    2. 评「重来」的卡当场返回；最终通过后只计一次，且只进 relearned 桶
//    3. 四个桶之和 == 今天学完的卡数
//    4. 任意时刻 分母 == 已完成 + 剩余（而不是每日上限）
//    5. 中途「重载」后进度与队列位置不变（换个连接重新读库也一样）
//    6. 23:55 与 00:05 评的卡分属不同日历日
// ============================================================

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initSchema, setSetting, useDatabase } from './db.js';
import { calendarDay, endOfDay, startOfDay } from './time.js';
import {
    createCard, createPlan, listCards, listPlans, planStats, progress, queueCards,
    rateCard, sessionResult, studyState, toggleFavorite, updatePlan,
} from './study.js';
import type { Rating } from '../shared/types.js';

const TZ = 'Asia/Shanghai';

/** 北京时间 2026-08-08 10:00 */
const T0 = new Date('2026-08-08T02:00:00.000Z');

function minutesAfter(base: Date, m: number): Date {
    return new Date(base.getTime() + m * 60_000);
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

function makePlan(cardCount: number, dailyNewLimit = 20) {
    const plan = createPlan({ name: '测试计划', dailyNewLimit });
    for (let i = 1; i <= cardCount; i++) {
        createCard(plan.id, `问题 ${i}`, `**答案 ${i}**`, T0);
    }
    return plan;
}

// ------------------------------------------------------------

describe('调度：新卡评「良好」', () => {
    it('排到将来，并且今天不再出现在队列里', () => {
        const plan = makePlan(3);
        const card = listCards(plan.id)[0];

        expect(queueCards(plan.id, T0, TZ).map((c) => c.id)).toContain(card.id);

        rateCard(plan.id, card.id, 3, 0, T0, TZ);

        const after = listCards(plan.id).find((c) => c.id === card.id)!;
        // 排到了将来
        expect(new Date(after.due).getTime()).toBeGreaterThan(T0.getTime());
        // 而且越过了今天
        expect(new Date(after.due).getTime()).toBeGreaterThanOrEqual(endOfDay(T0, TZ).getTime());
        expect(after.state).toBe('review');

        // 今天的队列里不再有它 —— 当天稍后再看也一样
        expect(queueCards(plan.id, T0, TZ).map((c) => c.id)).not.toContain(card.id);
        const laterToday = new Date(endOfDay(T0, TZ).getTime() - 60_000);
        expect(queueCards(plan.id, laterToday, TZ).map((c) => c.id)).not.toContain(card.id);
    });
});

describe('调度：评「重来」', () => {
    it('当场回到队列，最终通过后只计一次且只进 relearned 桶', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];

        // 连着忘三次
        let t = T0;
        for (let i = 0; i < 3; i++) {
            rateCard(plan.id, card.id, 1, 1000, t, TZ);
            // 每次评完都还在今天的队列里
            expect(queueCards(plan.id, t, TZ).map((c) => c.id)).toContain(card.id);
            expect(progress(plan.id, t, TZ).finished).toBe(0);
            t = minutesAfter(t, 2);
        }

        // 最后一次评「良好」，毕业
        rateCard(plan.id, card.id, 3, 1000, t, TZ);

        const res = sessionResult(plan.id, t, TZ);
        // 一张卡就是一张卡：评了四次，也只算 1 张学完
        expect(res.finished).toBe(1);
        expect(res.buckets).toEqual({ relearned: 1, hard: 0, good: 0, easy: 0 });
        // 按「次」统计另算：3 次重来 + 1 次良好
        expect(res.times).toEqual({ 1: 3, 2: 0, 3: 1, 4: 0 });
        expect(res.totalTimes).toBe(4);
    });

    it('复习态的卡忘掉后进入重新学习，同一天内还能再遇到', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];

        rateCard(plan.id, card.id, 3, 0, T0, TZ);      // 毕业成 review
        const due = new Date(listCards(plan.id)[0].due);

        // 到期那天打开，评「重来」
        const day2 = new Date(due.getTime() + 3600_000);
        rateCard(plan.id, card.id, 1, 0, day2, TZ);

        const after = listCards(plan.id)[0];
        expect(after.state).toBe('relearning');
        expect(after.lapses).toBe(1);
        // 10 分钟后再来 —— 还在当天队列里
        expect(queueCards(plan.id, day2, TZ).map((c) => c.id)).toContain(card.id);
    });
});

describe('四个桶', () => {
    it('互斥且穷尽：相加正好等于学完的卡数', () => {
        const plan = makePlan(6, 100);
        const cards = listCards(plan.id);
        let t = T0;

        // 一张 Easy、一张 Good、一张 Hard→Good、一张 Again→Good、两张原样不动
        rateCard(plan.id, cards[0].id, 4, 0, t, TZ);
        rateCard(plan.id, cards[1].id, 3, 0, t, TZ);

        rateCard(plan.id, cards[2].id, 2, 0, t, TZ);   // Hard：还留在今天
        t = minutesAfter(t, 5);
        rateCard(plan.id, cards[2].id, 3, 0, t, TZ);   // 再 Good 毕业

        rateCard(plan.id, cards[3].id, 1, 0, t, TZ);   // Again
        t = minutesAfter(t, 5);
        rateCard(plan.id, cards[3].id, 3, 0, t, TZ);   // 再 Good 毕业

        const res = sessionResult(plan.id, t, TZ);
        const sum = res.buckets.relearned + res.buckets.hard + res.buckets.good + res.buckets.easy;

        expect(res.finished).toBe(4);
        expect(sum).toBe(res.finished);
        // Hard 过但没 Again 过的，按今天最后一次评分归类 → good
        expect(res.buckets).toEqual({ relearned: 1, hard: 0, good: 2, easy: 1 });
    });

    it('先 Good 再被 Again，仍然只进 relearned', () => {
        const plan = makePlan(1);
        const card = listCards(plan.id)[0];

        rateCard(plan.id, card.id, 2, 0, T0, TZ);              // Hard，留在今天
        const t1 = minutesAfter(T0, 3);
        rateCard(plan.id, card.id, 1, 0, t1, TZ);              // 忘了
        const t2 = minutesAfter(T0, 6);
        rateCard(plan.id, card.id, 4, 0, t2, TZ);              // 最后评 Easy

        const res = sessionResult(plan.id, t2, TZ);
        expect(res.finished).toBe(1);
        // 最后一次是 Easy，但今天忘过 → 只进 relearned
        expect(res.buckets).toEqual({ relearned: 1, hard: 0, good: 0, easy: 0 });
    });
});

describe('进度分母', () => {
    it('是「已完成 + 剩余」，不是每日上限', () => {
        // 上限 100，但牌组统共只拿得出 5 张
        const plan = makePlan(5, 100);

        const p = progress(plan.id, T0, TZ);
        expect(p.dailyNewLimit).toBe(100);
        expect(p.total).toBe(5);            // ← 不是 100
        expect(p.finished).toBe(0);
        expect(p.remaining).toBe(5);
    });

    it('新卡的分母也够得着：上限 100 但只剩 5 张新卡时，目标就是 5', () => {
        // 界面上写「今日新卡 0/100」而牌组里根本没有 100 张新卡，
        // 那个分数就永远填不满 —— 看着像一天都没学
        const plan = makePlan(5, 100);

        const p = progress(plan.id, T0, TZ);
        expect(p.newTarget).toBe(5);        // ← 不是 100
        expect(p.newIntroduced).toBe(0);
    });

    it('新卡够多时，分母仍然是每日上限', () => {
        const plan = makePlan(50, 10);
        expect(progress(plan.id, T0, TZ).newTarget).toBe(10);
    });

    it('新卡学光之后分母收成「已引入」，分数正好走到满', () => {
        const plan = makePlan(3, 100);

        let t = T0;
        for (let i = 0; i < 3; i++) {
            const state = studyState(plan.id, t, TZ);
            rateCard(plan.id, state.card!.id, 3, 0, t, TZ);
            t = minutesAfter(t, 1);
        }

        const p = progress(plan.id, t, TZ);
        expect(p.newIntroduced).toBe(3);
        expect(p.newTarget).toBe(3);        // 分子分母相等 —— 今天的新卡目标达成
    });

    it('一张新卡都没有的计划，新卡目标是 0（界面据此整段不显示）', () => {
        const plan = createPlan({ name: '空计划', dailyNewLimit: 100 });
        expect(progress(plan.id, T0, TZ).newTarget).toBe(0);
    });

    it('整场学习的每一步都满足 分母 == 已完成 + 剩余', () => {
        const plan = makePlan(8, 100);
        // 固定的评分序列，保证可复现
        const script: Rating[] = [3, 1, 4, 2, 3, 1, 3, 4, 3, 3, 3, 3, 3, 3];

        let t = T0;
        let step = 0;
        for (;;) {
            const state = studyState(plan.id, t, TZ);
            const p = state.progress;

            // 结构上的恒等式
            expect(p.total).toBe(p.finished + p.remaining);
            // 而且 remaining 确实等于此刻队列的长度（不是缓存下来的旧值）
            expect(p.remaining).toBe(queueCards(plan.id, t, TZ).length);
            // 分母绝不会退回到「每日上限」
            expect(p.total).toBeLessThanOrEqual(8);

            if (!state.card) break;
            expect(step).toBeLessThan(script.length);

            rateCard(plan.id, state.card.id, script[step % script.length], 500, t, TZ);
            step++;
            t = minutesAfter(t, 2);
        }

        const final = progress(plan.id, t, TZ);
        expect(final.remaining).toBe(0);
        expect(final.finished).toBe(8);
        expect(final.total).toBe(8);

        const res = sessionResult(plan.id, t, TZ);
        const sum = res.buckets.relearned + res.buckets.hard + res.buckets.good + res.buckets.easy;
        expect(sum).toBe(8);
    });

    it('新卡受每日上限限制，到期卡不受限制', () => {
        const plan = makePlan(30, 5);

        // 一开始只放 5 张新卡出来
        expect(queueCards(plan.id, T0, TZ).length).toBe(5);

        let t = T0;
        for (let i = 0; i < 5; i++) {
            const state = studyState(plan.id, t, TZ);
            rateCard(plan.id, state.card!.id, 3, 0, t, TZ);
            t = minutesAfter(t, 1);
        }
        // 上限用完，今天不再放新卡
        expect(queueCards(plan.id, t, TZ).length).toBe(0);
        expect(progress(plan.id, t, TZ).newIntroduced).toBe(5);

        // 到了这 5 张的到期日，它们全部回来 —— 不受「每日 5 张」限制，
        // 因为上限只管新卡；同时当天还能再放 5 张新卡
        const dueDay = new Date(listCards(plan.id)[0].due);
        const q = queueCards(plan.id, new Date(dueDay.getTime() + 3600_000), TZ);
        expect(q.filter((c) => c.state !== 'new').length).toBe(5);
        expect(q.filter((c) => c.state === 'new').length).toBe(5);
    });
});

describe('中途退出', () => {
    it('每次评分立即落库；换个连接重新读，进度与队列位置一模一样', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-')), 'test.db');
        try {
            const first = new Database(file);
            initSchema(first);
            useDatabase(first);
            setSetting('timezone', TZ);

            const plan = makePlan(6, 100);
            let t = T0;
            for (let i = 0; i < 3; i++) {
                const s = studyState(plan.id, t, TZ);
                rateCard(plan.id, s.card!.id, 3, 700, t, TZ);
                t = minutesAfter(t, 2);
            }

            const before = studyState(plan.id, t, TZ);
            // 模拟「关掉标签页」：连接直接断掉，没有任何收尾保存
            first.close();

            // 重新打开（相当于刷新页面重新问服务端）
            const second = new Database(file);
            useDatabase(second);
            const after = studyState(plan.id, t, TZ);

            expect(after.card?.id).toBe(before.card?.id);      // 队列位置不变
            expect(after.progress).toEqual(before.progress);    // 进度不变
            expect(after.progress.finished).toBe(3);
            expect(after.progress.remaining).toBe(3);

            second.close();
        } finally {
            fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
    });
});

describe('日历日边界', () => {
    it('23:55 与 00:05 分属不同日历日', () => {
        // 北京时间 2026-08-08 23:55 与 2026-08-09 00:05
        const late = new Date('2026-08-08T15:55:00.000Z');
        const early = new Date('2026-08-08T16:05:00.000Z');

        expect(calendarDay(late, TZ)).toBe('2026-08-08');
        expect(calendarDay(early, TZ)).toBe('2026-08-09');
        // 只差 10 分钟 —— 滚动 24 小时窗口会把它们算成同一天
        expect(early.getTime() - late.getTime()).toBe(10 * 60_000);
    });

    it('两次评分因此落在不同的日子，成绩单互不干扰', () => {
        const plan = makePlan(2, 100);
        const [c1, c2] = listCards(plan.id);

        const late = new Date('2026-08-08T15:55:00.000Z');    // 8 日 23:55
        const early = new Date('2026-08-08T16:05:00.000Z');   // 9 日 00:05

        rateCard(plan.id, c1.id, 3, 0, late, TZ);
        rateCard(plan.id, c2.id, 3, 0, early, TZ);

        const day8 = sessionResult(plan.id, late, TZ);
        const day9 = sessionResult(plan.id, early, TZ);

        expect(day8.day).toBe('2026-08-08');
        expect(day9.day).toBe('2026-08-09');
        expect(day8.finished).toBe(1);
        expect(day9.finished).toBe(1);
        expect(day8.cards[0].id).toBe(c1.id);
        expect(day9.cards[0].id).toBe(c2.id);
    });

    it('日历日的起止点算得对（含跨夏令时的时区）', () => {
        expect(startOfDay(T0, TZ).toISOString()).toBe('2026-08-07T16:00:00.000Z');
        expect(endOfDay(T0, TZ).toISOString()).toBe('2026-08-08T16:00:00.000Z');

        // 纽约 2026-03-08 是夏令时开始那天，只有 23 小时
        const ny = 'America/New_York';
        const dstDay = new Date('2026-03-08T12:00:00.000Z');
        const s = startOfDay(dstDay, ny);
        const e = endOfDay(dstDay, ny);
        expect(calendarDay(s, ny)).toBe('2026-03-08');
        expect((e.getTime() - s.getTime()) / 3600_000).toBe(23);
    });
});

describe('老库升级', () => {
    it('已有数据的旧库能补上 favorite 列，且不丢数据', () => {
        // 手工造一个「加 favorite 之前」的库：plans 表没有这一列
        const old = new Database(':memory:');
        old.exec(`
            CREATE TABLE plans (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT    NOT NULL,
                description     TEXT    NOT NULL DEFAULT '',
                daily_new_limit INTEGER NOT NULL DEFAULT 20,
                sort_order      INTEGER NOT NULL DEFAULT 0,
                created_at      TEXT    NOT NULL,
                updated_at      TEXT    NOT NULL
            );
            INSERT INTO plans (name, sort_order, created_at, updated_at)
            VALUES ('老计划', 3, '2026-01-01', '2026-01-01');
        `);
        expect(
            (old.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>)
                .some((c) => c.name === 'favorite'),
        ).toBe(false);

        // 跑一遍 initSchema —— 这正是服务启动时做的事
        initSchema(old);
        useDatabase(old);

        const cols = (old.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>)
            .map((c) => c.name);
        expect(cols).toContain('favorite');

        // 依赖 favorite 的那个索引也得建起来（之前它写在 schema.sql 里，
        // 会在补列之前执行，老库上直接 no such column 把服务启动搞挂）
        const indexes = (old.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>)
            .map((i) => i.name);
        expect(indexes).toContain('idx_plans_order');

        // 原有数据还在，且默认未收藏
        const plans = listPlans(T0);
        expect(plans).toHaveLength(1);
        expect(plans[0].name).toBe('老计划');
        expect(plans[0].favorite).toBe(false);

        // 再跑一次要幂等
        expect(() => initSchema(old)).not.toThrow();

        old.close();
    });
});

describe('收藏', () => {
    it('收藏的计划排到最前面，未收藏的保持原有顺序', () => {
        // 显式给 sortOrder，模拟种子数据那种「按主线顺序排」的情况
        const a = createPlan({ name: 'A', sortOrder: 0 });
        const b = createPlan({ name: 'B', sortOrder: 1 });
        const c = createPlan({ name: 'C', sortOrder: 2 });

        expect(listPlans(T0).map((p) => p.name)).toEqual(['A', 'B', 'C']);

        // 收藏最后一个
        toggleFavorite(c.id);
        expect(listPlans(T0).map((p) => p.name)).toEqual(['C', 'A', 'B']);

        // 再收藏中间那个 —— 两个收藏项之间仍按 sortOrder 排，不是按收藏时间
        toggleFavorite(b.id);
        expect(listPlans(T0).map((p) => p.name)).toEqual(['B', 'C', 'A']);

        // 取消收藏，回到原位
        toggleFavorite(c.id);
        expect(listPlans(T0).map((p) => p.name)).toEqual(['B', 'A', 'C']);
    });

    it('新建的计划默认不收藏；toggle 会来回翻转', () => {
        const p = createPlan({ name: '默认' });
        expect(p.favorite).toBe(false);

        expect(toggleFavorite(p.id)!.favorite).toBe(true);
        expect(toggleFavorite(p.id)!.favorite).toBe(false);
        expect(toggleFavorite(99999)).toBeNull();
    });

    it('改别的字段不会顺手把收藏状态弄丢', () => {
        const p = createPlan({ name: '原名', dailyNewLimit: 7 });
        toggleFavorite(p.id);

        const after = updatePlan(p.id, { name: '改名了' })!;
        expect(after.name).toBe('改名了');
        expect(after.favorite).toBe(true);        // 没传 favorite 就该保持原样
        expect(after.dailyNewLimit).toBe(7);
    });
});

describe('计划之间互相独立', () => {
    it('两个计划的队列与进度互不影响', () => {
        const a = makePlan(3, 100);
        const b = createPlan({ name: '第二个计划', dailyNewLimit: 100 });
        createCard(b.id, 'B1', '', T0);
        createCard(b.id, 'B2', '', T0);

        const cardA = listCards(a.id)[0];
        rateCard(a.id, cardA.id, 3, 0, T0, TZ);

        expect(progress(a.id, T0, TZ)).toMatchObject({ finished: 1, remaining: 2, total: 3 });
        expect(progress(b.id, T0, TZ)).toMatchObject({ finished: 0, remaining: 2, total: 2 });

        expect(planStats(a.id, T0, TZ).totalCards).toBe(3);
        expect(planStats(b.id, T0, TZ).totalCards).toBe(2);
    });
});
