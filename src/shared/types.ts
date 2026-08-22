// 前后端共用的数据形状。只放类型，不放实现 ——
// 这样客户端 import 它不会把 better-sqlite3 之类的原生模块拖进浏览器包里。

import type { Modifiers, TargetWord } from './speaking.js';

// ---------- 三线表 ----------

export interface TableFull {
    id: string;
    name: string;
    html: string;
    caption: string;
    rows: number;
    cols: number;
    updatedAt: string;
}

export interface TableSummary {
    id: string;
    name: string;
    caption: string;
    rows: number;
    cols: number;
    bytes: number;
    updatedAt: string;
}

// ---------- 记忆卡 ----------

export type CardState = 'new' | 'learning' | 'review' | 'relearning';

/** 评分只有四档，别的值一律拒收 */
export type Rating = 1 | 2 | 3 | 4;

export const RATING_LABELS: Record<Rating, string> = {
    1: '重来',
    2: '困难',
    3: '良好',
    4: '简单',
};

/** 一张卡今天的归属桶。忘过一次就只进 relearned，不再进别的桶。 */
export type Bucket = 'relearned' | 'hard' | 'good' | 'easy';

export const BUCKET_LABELS: Record<Bucket, string> = {
    relearned: '重新学会',
    hard: '困难',
    good: '良好',
    easy: '简单',
};

export interface Plan {
    id: number;
    name: string;
    description: string;
    dailyNewLimit: number;
    /** 收藏的计划在列表里排到最前面 */
    favorite: boolean;
    createdAt: string;
    updatedAt: string;
}

/** 计划列表里每张卡片上显示的那一小撮数字 */
export interface PlanStats {
    totalCards: number;
    newCards: number;
    learningCards: number;
    reviewCards: number;
    /** 今日队列里还剩几张（到期 + 今天还能引入的新卡） */
    remaining: number;
    /** 今天已经学完几张 */
    finished: number;
    /** 今日进度分母 = finished + remaining */
    total: number;
    /** 掌握度：已进入 review 状态且到期日在今天之后的卡片占比 0..1 */
    mastery: number;
}

export interface PlanWithStats extends Plan {
    stats: PlanStats;
}

export interface Card {
    id: number;
    planId: number;
    front: string;
    /** Markdown，前端渲染 */
    back: string;
    state: CardState;
    stability: number;
    difficulty: number;
    due: string;
    lastReview: string | null;
    reps: number;
    lapses: number;
    /** 收藏。只影响管理页的排序与筛选，不参与 FSRS 调度 */
    favorite: boolean;
    createdAt: string;
    updatedAt: string;
}

/** 遗忘曲线上的一个采样点。d = 距上次复习的天数，r = 那一刻还记得住的概率 0..1 */
export interface CurvePoint {
    d: number;
    r: number;
}

/** 四档评分各自会把这张卡排到哪儿，用来标在按钮上 */
export interface RatingPreview {
    /** 排到的时刻，ISO */
    due: string;
    /** 距现在多少天（可能是小数，学习步是分钟级的） */
    days: number;
}

/**
 * 单张卡的记忆曲线视图。
 *
 * 全部由服务端算好送来 —— 前端不碰 FSRS 公式，理由跟调度一样：
 * 全站只有 src/server/fsrs.ts 一个地方懂这套算法。
 */
export interface CardCurve {
    cardId: number;
    /** 新卡没有曲线可画（从没复习过，没有衰减起点） */
    hasCurve: boolean;
    stability: number;
    difficulty: number;
    state: CardState;
    /** 上次复习，ISO；从没复习过是 null */
    lastReview: string | null;
    due: string;
    /** 曲线采样点 */
    points: CurvePoint[];
    /** 「现在」落在曲线的哪一点 */
    now: CurvePoint;
    /** 到期那一刻落在曲线的哪一点（正常应该贴着 90%） */
    dueAt: CurvePoint;
    /** 四档评分的预览 */
    previews: Record<Rating, RatingPreview>;
}

/** 学习界面每一步要的东西：当前卡 + 进度。两者永远来自同一次服务端计算，不会对不上。 */
export interface StudyState {
    planId: number;
    /** 队列空了就是 null，此时前端切到结果页 */
    card: Pick<Card, 'id' | 'front' | 'back' | 'state' | 'reps' | 'lapses'> | null;
    /** 四档评分各自会把这张卡排到什么时候（ISO），用来在按钮上显示「良好 · 3 天后」 */
    intervals: Record<Rating, string> | null;
    progress: Progress;
}

export interface Progress {
    /** 今天已学完的卡数（一张卡算一个单位，不管中途评了几次） */
    finished: number;
    /** 今日队列里还剩几张 */
    remaining: number;
    /** 分母 = finished + remaining。不是每日上限。 */
    total: number;
    /** 今天已经引入了几张新卡 */
    newIntroduced: number;
    /**
     * 今天**实际拿得出**多少张新卡 = min(每日上限, 已引入 + 库里还剩的新卡)。
     *
     * 界面上要跟 newIntroduced 配成分数的是这个，不是 dailyNewLimit ——
     * 理由跟 total 那条一模一样（规矩 1）：上限 100 但牌组里只剩 1 张新卡时，
     * 显示「0/100」是个永远够不着的目标。
     */
    newTarget: number;
    /** 计划设置里那个上限本身。改设置用，不拿来当分母。 */
    dailyNewLimit: number;
    /** 今天的日历日 YYYY-MM-DD（用户时区） */
    day: string;
}

/** 四个桶。互斥且穷尽：加起来必须正好等于 finished。 */
export type Buckets = Record<Bucket, number>;

/** 按「次」统计的点击数，跟按「张」统计的桶分开显示，避免两种口径混在一行数字里 */
export type RatingTimes = Record<Rating, number>;

export interface SessionResult {
    planId: number;
    day: string;
    /** 今天学完的卡数 */
    finished: number;
    buckets: Buckets;
    /** 今天一共点了多少次评分（一张卡可能被点很多次） */
    times: RatingTimes;
    totalTimes: number;
    /** 今天花在评分上的总时长（毫秒） */
    durationMs: number;
    /** 今天学完的每张卡的下次到期时间 */
    cards: Array<{
        id: number;
        front: string;
        state: CardState;
        due: string;
        bucket: Bucket;
    }>;
}

// ---------- 学习统计 ----------
//
// 两条贯穿始终的口径，字段名里直接写死，免得看的人猜：
//   · 带 Taps 的是「次」—— reviews 表一行就是一次评分点击
//   · 带 Cards 的是「张」—— COUNT(DISTINCT card_id)
// 两种口径不能相加，也绝不放进同一根柱子里。

/** 从 cards 表算出来的，跟有没有复习流水无关 */
export interface CardTotals {
    total: number;
    new: number;
    /** learning + relearning 合并 */
    learning: number;
    review: number;
}

/** 留存率。没有可用样本时 rate 是 null，界面上显示「—」而不是 100% */
export interface Retention {
    /** 分母：state_before != 'new' 的评分次数 */
    eligibleTaps: number;
    /** 分子：其中 rating >= 2 的次数 */
    recalledTaps: number;
    rate: number | null;
}

export interface CalendarCell {
    day: string;
    taps: number;
    /** 当天首次露面的卡片数（state_before = 'new'，按卡去重） */
    newCards: number;
    /** 当天碰过的卡片数（按卡去重）。跟 taps 是两个口径，绝不混着显示 */
    cards: number;
    /**
     * 当天的学习时长。
     *
     * 热力图的深浅按它分档，而不是按评分次数：次数多不等于学得久
     * —— 一天点 200 下「简单」不到三分钟，跟啃 20 张难卡半小时不是一回事。
     */
    durationMs: number;
}

export interface DailyVolume {
    day: string;
    /** 新卡首次露面的评分次数 */
    newTaps: number;
    /** 其余的评分次数 */
    repeatTaps: number;
    /** 当天引入的新卡张数（按卡去重） */
    newCards: number;
    /** 当天碰过的卡片张数（按卡去重） */
    cards: number;
    /** 当天留存率，分母是 repeatTaps。没有可复习的样本就是 null */
    retention: number | null;
}

export interface ForecastBucket {
    /** 已经逾期的那一根柱子 */
    overdue: boolean;
    /** overdue 那根是空串 */
    day: string;
    count: number;
}

/**
 * 到期日分布的一格：从今天起第 days 天，有 count 张卡到期。
 *
 * 只含已排期的卡（不含新卡）。逾期的并进 days = 0 —— 它们现在就该复习。
 * 两张图共用这一份数据：排期分布图直接画它，遗忘曲线在前端把它累减成存活曲线。
 */
export interface ScheduledBucket {
    days: number;
    count: number;
}

export interface StrengthBucket {
    label: string;
    count: number;
}

export interface Leech {
    id: number;
    planId: number;
    planName: string;
    front: string;
    back: string;
    lapses: number;
    difficulty: number;
    stability: number;
    due: string;
    state: CardState;
}

export interface StatsOverview {
    /** null = 全部计划 */
    planId: number | null;
    /** 选择器用的轻量计划列表（不带统计，省得为了画个下拉框把全站数据都算一遍） */
    plans: Array<{ id: number; name: string }>;
    timeZone: string;
    /** 今天的日历日（用户时区） */
    day: string;
    /** 30 天窗口的第一天，闭区间 [windowStart, day] */
    windowStart: string;

    cards: CardTotals;

    /** 今天的评分次数（次） */
    todayTaps: number;
    /** 今天碰过的卡片数（张，按卡去重） */
    todayCards: number;

    /** 连续学习天数：以今天或昨天结尾，中间断一天就归零 */
    streakDays: number;
    retention30: Retention;
    durationMs30: number;

    /** 最近一年（365 天），含没学习的空日 */
    calendar: CalendarCell[];
    /** 日历窗口的第一天，闭区间 [calendarStart, day] */
    calendarStart: string;
    /** 这一年的总学习时长 */
    yearDurationMs: number;
    /** 这一年里有学习记录的天数（累计学习天数） */
    activeDays: number;
    /** 最近 30 天，含没学习的空日 */
    daily: DailyVolume[];
    /** 逾期 + 未来 30 天 */
    forecast: ForecastBucket[];
    /** 完整跨度的到期日分布（可能到几百天）。排期分布图与遗忘曲线共用 */
    scheduled: ScheduledBucket[];
    strength: StrengthBucket[];
    leeches: Leech[];

    /** 当前选择下 reviews 表有没有任何一行。false 时所有流水面板显示空状态 */
    hasReviews: boolean;
}

// ---------- 英语口语场景练习 ----------

/** 这句话是怎么来的。assistant 的行固定是 'ai'。 */
export type TurnSource = 'typed' | 'speech' | 'ai';

export interface SpeakingTurn {
    id: number;
    role: 'assistant' | 'user';
    content: string;
    source: TurnSource;
    seq: number;
    saidAt: string;
}

export interface SpeakingSession {
    id: number;
    /** 喂给模型的英文场景描述 */
    scenario: string;
    /** 界面上显示的中文名字 */
    label: string;
    /** 预设 key；自己写的是空串 */
    preset: string;
    /** 产生这段对话的那一份干扰项设置 —— 没有它，对话读不懂 */
    modifiers: Modifiers;
    targetWords: TargetWord[];
    status: 'active' | 'finished';
    startedAt: string;
    finishedAt: string | null;
    /** 报告生成过才有 */
    report: SpeakingReport | null;
}

export interface SpeakingSessionFull extends SpeakingSession {
    turns: SpeakingTurn[];
}

/** 列表页用的一行，不带完整对话 */
export interface SpeakingSessionSummary extends SpeakingSession {
    turnCount: number;
    userTurnCount: number;
}

// ---------- 报告 ----------
//
// 这份报告的每一条都必须能在学习者自己的原话里找到出处，
// 所以每一条都带一个 quote 字段，且服务端会校验它确实出自对话
// （见 server/speaking.ts 的 sanitizeReport）。
//
// 这里**故意没有**发音 / 语调 / 语速 / 总分 字段。
// 模型只看得到文字，那些数字造不出来 —— 界面上的发音位置渲染
// 「未评估 —— 本模式不做任何音频分析」。

export interface QuotedPoint {
    /** 学习者的原话，逐字 */
    quote: string;
    /** 改写建议（英文） */
    suggestion: string;
    /** 为什么（中文，一句话） */
    why: string;
}

export interface SpeakingReport {
    summary: string;
    taskAchievement: {
        verdict: 'achieved' | 'partial' | 'not-achieved';
        comment: string;
        quote: string;
    };
    vocabulary: QuotedPoint[];
    /** suggestion 字段在语法条目里是修正后的句子 */
    grammar: QuotedPoint[];
    turnTaking: { comment: string; quote: string };
    /** 服务端按原话统计的，不问模型 —— 问模型它会把没说过的词也算成说过 */
    targetWords: Array<TargetWord & { count: number; used: boolean }>;
    nextSteps: string[];
    /** 学习者一句话都没说时为 true，界面显示空状态而不是一份编出来的评价 */
    empty: boolean;
    /** 被服务端校验删掉的条目数（引不出原话，或者含发音类断言） */
    droppedPoints: number;
}

// ---------- AI 悬浮球 ----------

export interface AssistantTodo {
    id: number;
    text: string;
    done: boolean;
    createdAt: string;
}

export interface AssistantShortcut {
    id: number;
    title: string;
    url: string;
    /** 站内路径默认原地跳，外链默认新标签页；建好之后可以逐条改 */
    openInNewTab: boolean;
    createdAt: string;
}

/**
 * 助手工具循环里的一步，原样推给前端画「思考过程」。
 *
 * observation 里只放**给人看的一句摘要**，不放喂回模型的原始 JSON ——
 * 那份可能上千字，塞进 SSE 只会让面板卡住。
 */
export interface AssistantStep {
    kind: 'thinking' | 'action' | 'observation' | 'error';
    /** 第几步，从 1 开始 */
    step: number;
    /** action 时是动作名 */
    action?: string;
    /** 模型自己给的理由 */
    reason?: string;
    /** 一句话摘要 */
    summary?: string;
    ok?: boolean;
}

// ---------- Markdown 记事本 ----------

/**
 * 一条笔记。
 *
 * tags 是笔记自己身上的一个字符串数组，不是关联表 —— 没有标签实体，
 * 也就没有改名和配色。整个标签功能就是「可以拿来筛选的一串字符串」。
 */
export interface Note {
    id: number;
    title: string;
    tags: string[];
    content: string;
    createdAt: string;
    updatedAt: string;
}
