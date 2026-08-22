// ============================================================
//  间隔重复调度 —— 全站唯一的调度入口
//
//  公式、权重、状态机全部交给官方的 ts-fsrs，这里只做两件事：
//    1. 数据库行 ↔ ts-fsrs 的 Card 结构 之间翻译
//    2. 固定一组参数
//  不自己实现任何公式，不"简化"状态机。
//
//  参数为什么这么选（两条验收要求其实是互相拉扯的）：
//    · learning_steps: ['1m']
//        只有一个学习步。新卡评 Good 会直接从这一步毕业进入 Review，
//        间隔按天算 —— 满足「新卡评 Good 后今天不再出现在队列里」。
//        评 Again 则退回这一步，1 分钟后重来 —— 满足「Again 当场返回」。
//        用 ts-fsrs 的默认 ['1m','10m'] 的话，新卡评 Good 只会走到第二步，
//        10 分钟后还在今天的队列里，第一条验收就过不了。
//    · relearning_steps: ['10m']
//        复习卡忘掉之后 10 分钟内再来一次，同一次学习里能收尾。
//    · enable_fuzz: false
//        关掉间隔的随机抖动。抖动对真实记忆有好处，但会让验收测试不可复现；
//        本地单人使用，这点收益不值得拿确定性去换。
// ============================================================

import {
    createEmptyCard,
    forgetting_curve,
    fsrs,
    generatorParameters,
    Rating as FsrsRating,
    State as FsrsState,
    type Card as FsrsCard,
    type Grade,
} from 'ts-fsrs';
import type { CardState, Rating } from '../shared/types.js';

// 参数单独拎出来：遗忘曲线要用到里面的权重 w，不能只留在 fsrs() 的调用里
const params = generatorParameters({
    enable_fuzz: false,
    learning_steps: ['1m'],
    relearning_steps: ['10m'],
});

const scheduler = fsrs(params);

/** 调度器眼里的一张卡。字段与数据库 cards 表一一对应。 */
export interface SchedulerCard {
    state: CardState;
    stability: number;
    difficulty: number;
    due: Date;
    last_review: Date | null;
    reps: number;
    lapses: number;
    elapsed_days: number;
    scheduled_days: number;
    learning_steps: number;
}

const STATE_TO_NAME: Record<number, CardState> = {
    [FsrsState.New]: 'new',
    [FsrsState.Learning]: 'learning',
    [FsrsState.Review]: 'review',
    [FsrsState.Relearning]: 'relearning',
};

const NAME_TO_STATE: Record<CardState, FsrsState> = {
    new: FsrsState.New,
    learning: FsrsState.Learning,
    review: FsrsState.Review,
    relearning: FsrsState.Relearning,
};

// Grade 是 ts-fsrs 里「排除 Manual 之后的四档」，正好对应我们只认的 1..4
const RATING_TO_FSRS: Record<Rating, Grade> = {
    1: FsrsRating.Again,
    2: FsrsRating.Hard,
    3: FsrsRating.Good,
    4: FsrsRating.Easy,
};

function toFsrs(card: SchedulerCard): FsrsCard {
    return {
        due: card.due,
        stability: card.stability,
        difficulty: card.difficulty,
        elapsed_days: card.elapsed_days,
        scheduled_days: card.scheduled_days,
        learning_steps: card.learning_steps,
        reps: card.reps,
        lapses: card.lapses,
        state: NAME_TO_STATE[card.state],
        last_review: card.last_review ?? undefined,
    };
}

function fromFsrs(card: FsrsCard): SchedulerCard {
    return {
        state: STATE_TO_NAME[card.state],
        stability: card.stability,
        difficulty: card.difficulty,
        due: card.due,
        last_review: card.last_review ?? null,
        reps: card.reps,
        lapses: card.lapses,
        elapsed_days: card.elapsed_days,
        scheduled_days: card.scheduled_days,
        learning_steps: card.learning_steps ?? 0,
    };
}

/** 一张从没学过的新卡 */
export function emptyCard(now: Date): SchedulerCard {
    return fromFsrs(createEmptyCard(now));
}

/**
 * 唯一的调度调用点。
 * 客户端只能提交 {card_id, rating}，新的 stability / due / state 全由这里算出来 ——
 * 这就是「调度器」和「意见箱」的区别。
 */
export function schedule(card: SchedulerCard, rating: Rating, now: Date): SchedulerCard {
    const result = scheduler.next(toFsrs(card), now, RATING_TO_FSRS[rating]);
    return fromFsrs(result.card);
}

/** 四档评分各自会排到什么时候，用来在按钮上显示「良好 · 3 天后」 */
export function previewIntervals(card: SchedulerCard, now: Date): Record<Rating, Date> {
    const log = scheduler.repeat(toFsrs(card), now);
    return {
        1: log[FsrsRating.Again].card.due,
        2: log[FsrsRating.Hard].card.due,
        3: log[FsrsRating.Good].card.due,
        4: log[FsrsRating.Easy].card.due,
    };
}

export function isValidRating(v: unknown): v is Rating {
    return v === 1 || v === 2 || v === 3 || v === 4;
}

// ---------- 遗忘曲线 ----------
//
// 曲线也走库的 forgetting_curve()，不自己写幂函数 —— 跟调度同一条规矩：
// 公式一概不碰。自己实现的话，哪天 ts-fsrs 升级换了衰减模型（FSRS-5 → 6
// 的 decay 就变过），画出来的曲线会跟真正的排期悄悄对不上，
// 而这种偏差在界面上看不出来。

/**
 * 距上次复习 elapsedDays 天时，这张卡还记得住的概率（0..1）。
 *
 * 注意基准是**上次复习**，不是现在：FSRS 的记忆模型就是从上次复习那一刻
 * 开始衰减的，拿「现在」当原点会把曲线整条平移。
 */
export function retentionAt(stability: number, elapsedDays: number): number {
    if (!(stability > 0)) return 0;
    return forgetting_curve(params.w, Math.max(0, elapsedDays), stability);
}

/** 采样一条遗忘曲线，返回 [{d: 天, r: 0..1}]。d 同样以上次复习为原点。 */
export function sampleCurve(stability: number, spanDays: number, samples = 48):
Array<{ d: number; r: number }> {
    const out: Array<{ d: number; r: number }> = [];
    const span = Math.max(1, spanDays);
    for (let i = 0; i <= samples; i += 1) {
        const d = (span * i) / samples;
        out.push({ d, r: retentionAt(stability, d) });
    }
    return out;
}
