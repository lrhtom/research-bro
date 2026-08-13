// ============================================================
//  记忆卡：学习计划 / 卡片 / 今日队列 / 进度与统计
//
//  三条容易做错的规矩，全部落在这个文件里：
//    1. 进度分母 = 今日已完成 + 队列剩余（不是每日上限）
//    2. 一张卡算一个单位（评了四次也还是一张）
//    3. 今天任何时刻按过「重来」的卡，只进 relearned 桶，不进别的桶
//  四个桶之和必须精确等于完成数；按次数的统计单独给，明确标成「次」。
// ============================================================

import { db, getSetting, nowIso } from './db.js';
import { calendarDay, endOfDay, normalizeTimeZone } from './time.js';
import { emptyCard, previewIntervals, schedule, type SchedulerCard } from './fsrs.js';
import type {
    Bucket, Buckets, Card, CardState, Plan, PlanStats, PlanWithStats,
    Progress, Rating, RatingTimes, SessionResult, StudyState,
} from '../shared/types.js';

// ---------- 行类型 ----------

interface PlanRow {
    id: number;
    name: string;
    description: string;
    daily_new_limit: number;
    favorite: number;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

interface CardRow {
    id: number;
    plan_id: number;
    front: string;
    back: string;
    state: CardState;
    stability: number;
    difficulty: number;
    due: string;
    last_review: string | null;
    reps: number;
    lapses: number;
    elapsed_days: number;
    scheduled_days: number;
    learning_steps: number;
    favorite: number;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

// ---------- 时区 ----------

/** 全站一个时区设置。前端首次加载时会把浏览器时区报上来。 */
export function timeZone(): string {
    return normalizeTimeZone(getSetting('timezone'));
}

// ---------- 映射 ----------

function toPlan(r: PlanRow): Plan {
    return {
        id: r.id,
        name: r.name,
        description: r.description,
        dailyNewLimit: r.daily_new_limit,
        favorite: r.favorite === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/**
 * 列表排序：先收藏、再自定义顺序。
 * SQLite 里布尔就是 0/1，所以 favorite DESC 正好把收藏的顶上去。
 */
const PLAN_ORDER = 'ORDER BY favorite DESC, sort_order ASC, id ASC';

function toCard(r: CardRow): Card {
    return {
        id: r.id,
        planId: r.plan_id,
        front: r.front,
        back: r.back,
        state: r.state,
        stability: r.stability,
        difficulty: r.difficulty,
        due: r.due,
        lastReview: r.last_review,
        reps: r.reps,
        lapses: r.lapses,
        favorite: r.favorite === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function toScheduler(r: CardRow): SchedulerCard {
    return {
        state: r.state,
        stability: r.stability,
        difficulty: r.difficulty,
        due: new Date(r.due),
        last_review: r.last_review ? new Date(r.last_review) : null,
        reps: r.reps,
        lapses: r.lapses,
        elapsed_days: r.elapsed_days,
        scheduled_days: r.scheduled_days,
        learning_steps: r.learning_steps,
    };
}

// ---------- 计划 ----------

export function listPlans(now = new Date()): PlanWithStats[] {
    const rows = db().prepare(`SELECT * FROM plans ${PLAN_ORDER}`).all() as PlanRow[];
    return rows.map((r) => ({ ...toPlan(r), stats: planStats(r.id, now) }));
}

export function getPlan(id: number): Plan | null {
    const row = db().prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    return row ? toPlan(row) : null;
}

export function createPlan(input: {
    name: string;
    description?: string;
    dailyNewLimit?: number;
    /** 不传就排到最前（手动新建时想立刻看到它）；批量灌种子数据时按文件序显式指定 */
    sortOrder?: number;
}): Plan {
    const ts = nowIso();
    const min = db().prepare('SELECT MIN(sort_order) AS m FROM plans').get() as { m: number | null };
    const info = db().prepare(
        `INSERT INTO plans (name, description, daily_new_limit, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
        input.name.trim().slice(0, 200) || '未命名计划',
        (input.description ?? '').slice(0, 2000),
        clampLimit(input.dailyNewLimit),
        input.sortOrder ?? (min.m ?? 0) - 1,
        ts, ts,
    );
    return getPlan(Number(info.lastInsertRowid))!;
}

export function updatePlan(
    id: number,
    patch: { name?: string; description?: string; dailyNewLimit?: number; favorite?: boolean },
): Plan | null {
    const cur = db().prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    if (!cur) return null;

    db().prepare(
        `UPDATE plans SET name = ?, description = ?, daily_new_limit = ?, favorite = ?, updated_at = ?
         WHERE id = ?`,
    ).run(
        patch.name === undefined ? cur.name : (patch.name.trim().slice(0, 200) || '未命名计划'),
        patch.description === undefined ? cur.description : patch.description.slice(0, 2000),
        patch.dailyNewLimit === undefined ? cur.daily_new_limit : clampLimit(patch.dailyNewLimit),
        patch.favorite === undefined ? cur.favorite : (patch.favorite ? 1 : 0),
        nowIso(),
        id,
    );
    return getPlan(id);
}

/** 切换收藏。返回切换后的状态；计划不存在返回 null。 */
export function toggleFavorite(id: number): Plan | null {
    const cur = db().prepare('SELECT favorite FROM plans WHERE id = ?').get(id) as
        | { favorite: number }
        | undefined;
    if (!cur) return null;
    return updatePlan(id, { favorite: cur.favorite !== 1 });
}

export function deletePlan(id: number): boolean {
    // cards / reviews 都是 ON DELETE CASCADE，跟着一起走
    return db().prepare('DELETE FROM plans WHERE id = ?').run(id).changes > 0;
}

function clampLimit(v: number | undefined): number {
    if (v === undefined || !Number.isFinite(v)) return 20;
    return Math.max(0, Math.min(9999, Math.floor(v)));
}

// ---------- 卡片 ----------

/**
 * 管理页的卡片列表：收藏的排最前，其余按自定义顺序。
 *
 * 只有这一个查询这么排。学习队列走的是 nextCard 那条按 due 排的路 ——
 * 收藏不参与调度，否则这些卡的复习间隔会长期偏离 FSRS 的安排。
 */
export function listCards(planId: number): Card[] {
    const rows = db().prepare(
        'SELECT * FROM cards WHERE plan_id = ? ORDER BY favorite DESC, sort_order ASC, id ASC',
    ).all(planId) as CardRow[];
    return rows.map(toCard);
}

/** 切换收藏。卡片不存在返回 null，路由层据此回 404。 */
export function toggleCardFavorite(cardId: number): Card | null {
    const cur = db().prepare('SELECT favorite FROM cards WHERE id = ?').get(cardId) as
        | { favorite: number }
        | undefined;
    if (!cur) return null;

    db().prepare('UPDATE cards SET favorite = ?, updated_at = ? WHERE id = ?')
        .run(cur.favorite === 1 ? 0 : 1, nowIso(), cardId);
    return toCard(db().prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as CardRow);
}

export function createCard(planId: number, front: string, back: string, now = new Date()): Card {
    const fresh = emptyCard(now);
    const ts = nowIso();
    const max = db().prepare(
        'SELECT MAX(sort_order) AS m FROM cards WHERE plan_id = ?',
    ).get(planId) as { m: number | null };

    const info = db().prepare(
        `INSERT INTO cards (plan_id, front, back, state, stability, difficulty, due, last_review,
                            reps, lapses, elapsed_days, scheduled_days, learning_steps,
                            sort_order, created_at, updated_at)
         VALUES (@plan_id, @front, @back, @state, @stability, @difficulty, @due, NULL,
                 0, 0, @elapsed_days, @scheduled_days, @learning_steps,
                 @sort_order, @created_at, @updated_at)`,
    ).run({
        plan_id: planId,
        front: front.slice(0, 20000),
        back: back.slice(0, 200000),
        state: fresh.state,
        stability: fresh.stability,
        difficulty: fresh.difficulty,
        due: fresh.due.toISOString(),
        elapsed_days: fresh.elapsed_days,
        scheduled_days: fresh.scheduled_days,
        learning_steps: fresh.learning_steps,
        sort_order: (max.m ?? 0) + 1,
        created_at: ts,
        updated_at: ts,
    });

    return toCard(db().prepare('SELECT * FROM cards WHERE id = ?').get(Number(info.lastInsertRowid)) as CardRow);
}

export function updateCard(id: number, patch: { front?: string; back?: string }): Card | null {
    const cur = db().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!cur) return null;
    db().prepare('UPDATE cards SET front = ?, back = ?, updated_at = ? WHERE id = ?').run(
        patch.front === undefined ? cur.front : patch.front.slice(0, 20000),
        patch.back === undefined ? cur.back : patch.back.slice(0, 200000),
        nowIso(),
        id,
    );
    return toCard(db().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow);
}

export function deleteCard(id: number): boolean {
    return db().prepare('DELETE FROM cards WHERE id = ?').run(id).changes > 0;
}

/** 把卡片的学习进度清零，重新当新卡（不删卡，也不删历史流水） */
export function resetCard(id: number, now = new Date()): Card | null {
    const cur = db().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!cur) return null;
    const fresh = emptyCard(now);
    db().prepare(
        `UPDATE cards SET state = ?, stability = ?, difficulty = ?, due = ?, last_review = NULL,
                          reps = 0, lapses = 0, elapsed_days = ?, scheduled_days = ?,
                          learning_steps = ?, updated_at = ?
         WHERE id = ?`,
    ).run(
        fresh.state, fresh.stability, fresh.difficulty, fresh.due.toISOString(),
        fresh.elapsed_days, fresh.scheduled_days, fresh.learning_steps, nowIso(), id,
    );
    return toCard(db().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow);
}

/** 批量导入。返回真正插进去的张数。 */
export function importCards(
    planId: number,
    items: Array<{ front: string; back: string }>,
    now = new Date(),
): number {
    const run = db().transaction((list: Array<{ front: string; back: string }>) => {
        list.forEach((c) => createCard(planId, c.front, c.back, now));
        return list.length;
    });
    return run(items);
}

// ---------- 今日队列 ----------

/**
 * 今日队列。
 *
 * 到期卡：due 落在今天结束之前的全部卡片，**不设上限** —— 那是已经欠下的债。
 *   这里用「今天之内」而不是字面意义的 due <= now：
 *   一是按天算的间隔本来就该整天到期（昨天 10:00 学的、间隔 1 天，今天 09:00 也算到期）；
 *   二是评「重来」之后卡片会排到 1 分钟后，只有把今天之内的都算进队列，
 *      它才能在同一次学习里回来。
 *
 * 新卡：按 daily_new_limit 减去今天已经引入的数量封顶。
 *
 * 顺序：真正逾期的（due <= now）→ 新卡 → 今天稍后的学习步骤。
 *   学习步骤排最后，是为了让刚评过「重来」的卡不至于立刻又蹦到眼前。
 */
export function queueCards(planId: number, now = new Date(), tz = timeZone()): CardRow[] {
    const dayEnd = endOfDay(now, tz).toISOString();
    const nowIsoStr = now.toISOString();
    const day = calendarDay(now, tz);

    const dueRows = db().prepare(
        `SELECT * FROM cards
         WHERE plan_id = ? AND state != 'new' AND due < ?
         ORDER BY due ASC, id ASC`,
    ).all(planId, dayEnd) as CardRow[];

    const overdue = dueRows.filter((c) => c.due <= nowIsoStr);
    const laterToday = dueRows.filter((c) => c.due > nowIsoStr);

    const plan = db().prepare('SELECT daily_new_limit FROM plans WHERE id = ?').get(planId) as
        | { daily_new_limit: number }
        | undefined;
    const limit = plan?.daily_new_limit ?? 20;
    const introduced = newIntroducedToday(planId, day);
    const room = Math.max(0, limit - introduced);

    const newRows = room === 0 ? [] : db().prepare(
        `SELECT * FROM cards
         WHERE plan_id = ? AND state = 'new'
         ORDER BY sort_order ASC, id ASC
         LIMIT ?`,
    ).all(planId, room) as CardRow[];

    return [...overdue, ...newRows, ...laterToday];
}

/** 库里还剩几张没碰过的新卡 */
function newCardsLeft(planId: number): number {
    const row = db().prepare(
        `SELECT COUNT(*) AS n FROM cards WHERE plan_id = ? AND state = 'new'`,
    ).get(planId) as { n: number };
    return row.n;
}

/** 今天已经引入了几张新卡（按卡去重，不是按次） */
function newIntroducedToday(planId: number, day: string): number {
    const row = db().prepare(
        `SELECT COUNT(DISTINCT card_id) AS n FROM reviews
         WHERE plan_id = ? AND review_day = ? AND state_before = 'new'`,
    ).get(planId, day) as { n: number };
    return row.n;
}

/**
 * 今天已经学完的卡数。
 *
 * 「学完」= 今天评过分，并且现在的 due 已经越过今天 —— 也就是它已经离开今日队列。
 * 按卡去重：评了四次也还是一张卡（规矩 2）。
 */
function finishedToday(planId: number, day: string, dayEnd: string): number {
    const row = db().prepare(
        `SELECT COUNT(*) AS n FROM cards c
         WHERE c.plan_id = ? AND c.due >= ?
           AND EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = c.id AND r.review_day = ?)`,
    ).get(planId, dayEnd, day) as { n: number };
    return row.n;
}

// ---------- 进度 ----------

export function progress(planId: number, now = new Date(), tz = timeZone()): Progress {
    const day = calendarDay(now, tz);
    const dayEnd = endOfDay(now, tz).toISOString();

    const finished = finishedToday(planId, day, dayEnd);
    const remaining = queueCards(planId, now, tz).length;

    const plan = db().prepare('SELECT daily_new_limit FROM plans WHERE id = ?').get(planId) as
        | { daily_new_limit: number }
        | undefined;

    const limit = plan?.daily_new_limit ?? 20;
    const introduced = newIntroducedToday(planId, day);

    return {
        finished,
        remaining,
        // 规矩 1：分母是「已完成 + 还剩」，不是每日上限。
        // 这样进度条一定填得满，目标也一定够得着。
        total: finished + remaining,
        newIntroduced: introduced,
        // 同一条规矩，用在新卡这一行上：上限 100 而牌组里只剩 1 张新卡时，
        // 今天最多也就是 1 张 —— 分母写 100 只是个够不着的数字。
        newTarget: Math.min(limit, introduced + newCardsLeft(planId)),
        dailyNewLimit: limit,
        day,
    };
}

/** 学习界面每一步要的东西。当前卡与进度来自同一次计算，不会对不上。 */
export function studyState(planId: number, now = new Date(), tz = timeZone()): StudyState {
    const queue = queueCards(planId, now, tz);
    const head = queue[0];

    return {
        planId,
        card: head
            ? {
                id: head.id,
                front: head.front,
                back: head.back,
                state: head.state,
                reps: head.reps,
                lapses: head.lapses,
            }
            : null,
        intervals: head ? previewIso(head, now) : null,
        progress: progress(planId, now, tz),
    };
}

function previewIso(row: CardRow, now: Date): Record<Rating, string> {
    const p = previewIntervals(toScheduler(row), now);
    return {
        1: p[1].toISOString(),
        2: p[2].toISOString(),
        3: p[3].toISOString(),
        4: p[4].toISOString(),
    };
}

// ---------- 评分 ----------

export class StudyError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

/**
 * 提交一次评分。
 *
 * 客户端只送 {cardId, rating}；新的 stability / difficulty / due / state 全在这里算，
 * 客户端无从插手 —— 这是「调度器」和「意见箱」的区别。
 *
 * 整个过程包在一个事务里：要么卡片状态和流水一起落库，要么都不落。
 * 落库是同步完成的，所以此刻关掉页面也不会丢这一次评分。
 */
export function rateCard(
    planId: number,
    cardId: number,
    rating: Rating,
    durationMs = 0,
    now = new Date(),
    tz = timeZone(),
): StudyState {
    const apply = db().transaction(() => {
        const row = db().prepare(
            'SELECT * FROM cards WHERE id = ? AND plan_id = ?',
        ).get(cardId, planId) as CardRow | undefined;
        if (!row) throw new StudyError('卡片不存在', 404);

        const next = schedule(toScheduler(row), rating, now);

        db().prepare(
            `UPDATE cards SET state = ?, stability = ?, difficulty = ?, due = ?, last_review = ?,
                              reps = ?, lapses = ?, elapsed_days = ?, scheduled_days = ?,
                              learning_steps = ?, updated_at = ?
             WHERE id = ?`,
        ).run(
            next.state, next.stability, next.difficulty, next.due.toISOString(),
            (next.last_review ?? now).toISOString(),
            next.reps, next.lapses, next.elapsed_days, next.scheduled_days,
            next.learning_steps, nowIso(), cardId,
        );

        db().prepare(
            `INSERT INTO reviews (card_id, plan_id, rating, reviewed_at, review_day, duration_ms,
                                  state_before, state_after, due_after, stability_after, difficulty_after)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            cardId, planId, rating, now.toISOString(), calendarDay(now, tz),
            Math.max(0, Math.min(3600_000, Math.floor(durationMs))),
            row.state, next.state, next.due.toISOString(), next.stability, next.difficulty,
        );
    });

    apply();
    return studyState(planId, now, tz);
}

// ---------- 结果统计 ----------

/**
 * 今天的成绩单。
 *
 * 桶的判定（规矩 3）：今天只要按过一次「重来」，这张卡就只进 relearned，
 * 别的桶一律不进；没按过「重来」的，看今天最后一次评分落到 hard/good/easy。
 * 于是四个桶互斥且穷尽，加起来正好等于完成数。
 */
export function sessionResult(planId: number, now = new Date(), tz = timeZone()): SessionResult {
    const day = calendarDay(now, tz);
    const dayEnd = endOfDay(now, tz).toISOString();

    const rows = db().prepare(
        `SELECT c.id, c.front, c.state, c.due,
                MAX(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS had_again,
                (SELECT r2.rating FROM reviews r2
                  WHERE r2.card_id = c.id AND r2.review_day = @day
                  ORDER BY r2.reviewed_at DESC, r2.id DESC LIMIT 1) AS last_rating
         FROM cards c
         JOIN reviews r ON r.card_id = c.id AND r.review_day = @day
         WHERE c.plan_id = @plan AND c.due >= @dayEnd
         GROUP BY c.id
         ORDER BY c.due ASC, c.id ASC`,
    ).all({ plan: planId, day, dayEnd }) as Array<{
        id: number; front: string; state: CardState; due: string;
        had_again: number; last_rating: Rating;
    }>;

    const buckets: Buckets = { relearned: 0, hard: 0, good: 0, easy: 0 };
    const cards = rows.map((r) => {
        const bucket: Bucket = r.had_again
            ? 'relearned'
            : r.last_rating === 4 ? 'easy' : r.last_rating === 2 ? 'hard' : 'good';
        buckets[bucket]++;
        return { id: r.id, front: r.front, state: r.state, due: r.due, bucket };
    });

    // 按「次」统计，跟按「张」统计的桶分开列 —— 两种口径混在一行数字里最容易骗人
    const timeRows = db().prepare(
        'SELECT rating, COUNT(*) AS n FROM reviews WHERE plan_id = ? AND review_day = ? GROUP BY rating',
    ).all(planId, day) as Array<{ rating: Rating; n: number }>;
    const times: RatingTimes = { 1: 0, 2: 0, 3: 0, 4: 0 };
    timeRows.forEach((t) => { times[t.rating] = t.n; });

    const dur = db().prepare(
        'SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM reviews WHERE plan_id = ? AND review_day = ?',
    ).get(planId, day) as { ms: number };

    return {
        planId,
        day,
        finished: cards.length,
        buckets,
        times,
        totalTimes: times[1] + times[2] + times[3] + times[4],
        durationMs: dur.ms,
        cards,
    };
}

// ---------- 计划列表上的小统计 ----------

export function planStats(planId: number, now = new Date(), tz = timeZone()): PlanStats {
    const day = calendarDay(now, tz);
    const dayEnd = endOfDay(now, tz).toISOString();

    const counts = db().prepare(
        `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(state = 'new'), 0) AS news,
             COALESCE(SUM(state IN ('learning', 'relearning')), 0) AS learning,
             COALESCE(SUM(state = 'review'), 0) AS review,
             COALESCE(SUM(state = 'review' AND due >= @dayEnd), 0) AS mastered
         FROM cards WHERE plan_id = @plan`,
    ).get({ plan: planId, dayEnd }) as {
        total: number; news: number; learning: number; review: number; mastered: number;
    };

    const finished = finishedToday(planId, day, dayEnd);
    const remaining = queueCards(planId, now, tz).length;

    return {
        totalCards: counts.total,
        newCards: counts.news,
        learningCards: counts.learning,
        reviewCards: counts.review,
        remaining,
        finished,
        total: finished + remaining,
        mastery: counts.total > 0 ? counts.mastered / counts.total : 0,
    };
}
