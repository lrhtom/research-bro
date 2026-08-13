// 记忆卡的 HTTP 接口
//
// 关键约束：评分接口只接受 {cardId, rating}。
// stability / difficulty / due / state 一律由服务端算出来再返回，
// 客户端连提交的机会都没有 —— 这是「调度器」和「意见箱」的区别。

import { Router } from 'express';
import {
    createCard, createPlan, deleteCard, deletePlan, getPlan, importCards,
    listCards, listPlans, planStats, rateCard, resetCard, sessionResult, toggleCardFavorite,
    studyState, StudyError, timeZone, toggleFavorite, updateCard, updatePlan,
} from './study.js';
import { statsOverview } from './stats.js';
import { isValidRating } from './fsrs.js';
import { normalizeDeck } from '../shared/card-import.js';

export const cardsRouter: Router = Router();

function planIdOf(raw: string): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new StudyError('计划 id 不合法');
    return id;
}

function requirePlan(raw: string): number {
    const id = planIdOf(raw);
    if (!getPlan(id)) throw new StudyError('学习计划不存在', 404);
    return id;
}

// ---------- 学习计划 ----------

cardsRouter.get('/plans', (_req, res) => {
    res.json({ plans: listPlans(), timeZone: timeZone() });
});

cardsRouter.post('/plans', (req, res) => {
    const b = (req.body ?? {}) as { name?: string; description?: string; dailyNewLimit?: number };
    if (!b.name || !b.name.trim()) { res.status(400).json({ error: '计划名不能为空' }); return; }
    res.status(201).json({ plan: createPlan({
        name: b.name, description: b.description, dailyNewLimit: b.dailyNewLimit,
    }) });
});

cardsRouter.get('/plans/:id', (req, res) => {
    const id = requirePlan(req.params.id);
    res.json({ plan: getPlan(id), stats: planStats(id) });
});

cardsRouter.put('/plans/:id', (req, res) => {
    const id = requirePlan(req.params.id);
    const b = (req.body ?? {}) as {
        name?: string; description?: string; dailyNewLimit?: number; favorite?: boolean;
    };
    res.json({ plan: updatePlan(id, b) });
});

/** 切换收藏。收藏的计划在列表里排到最前面。 */
cardsRouter.post('/plans/:id/favorite', (req, res) => {
    const id = requirePlan(req.params.id);
    res.json({ plan: toggleFavorite(id) });
});

cardsRouter.delete('/plans/:id', (req, res) => {
    const id = planIdOf(req.params.id);
    if (!deletePlan(id)) { res.status(404).json({ error: '学习计划不存在' }); return; }
    res.json({ ok: true });
});

// ---------- 卡片增删改 ----------

cardsRouter.get('/plans/:id/cards', (req, res) => {
    const id = requirePlan(req.params.id);
    res.json({ cards: listCards(id) });
});

cardsRouter.post('/plans/:id/cards', (req, res) => {
    const id = requirePlan(req.params.id);
    const b = (req.body ?? {}) as { front?: string; back?: string };
    if (!b.front || !b.front.trim()) { res.status(400).json({ error: '正面内容不能为空' }); return; }
    res.status(201).json({ card: createCard(id, b.front, b.back ?? '') });
});

cardsRouter.put('/cards/:cardId', (req, res) => {
    const b = (req.body ?? {}) as { front?: string; back?: string };
    const card = updateCard(Number(req.params.cardId), b);
    if (!card) { res.status(404).json({ error: '卡片不存在' }); return; }
    res.json({ card });
});

cardsRouter.delete('/cards/:cardId', (req, res) => {
    if (!deleteCard(Number(req.params.cardId))) {
        res.status(404).json({ error: '卡片不存在' });
        return;
    }
    res.json({ ok: true });
});

/** 把一张卡的学习进度清零，重新当新卡（历史流水保留） */
cardsRouter.post('/cards/:cardId/reset', (req, res) => {
    const card = resetCard(Number(req.params.cardId));
    if (!card) { res.status(404).json({ error: '卡片不存在' }); return; }
    res.json({ card });
});

/**
 * 切换收藏。
 *
 * 收藏只改管理页的排序和筛选，**不动任何调度字段** ——
 * 所以这里不像评分那样要重算 due/stability，就是翻一个 0/1。
 */
cardsRouter.post('/cards/:cardId/favorite', (req, res) => {
    const card = toggleCardFavorite(Number(req.params.cardId));
    if (!card) { res.status(404).json({ error: '卡片不存在' }); return; }
    res.json({ card });
});

// ---------- JSON 导入 ----------

/** 导入到已有计划 */
cardsRouter.post('/plans/:id/import', (req, res) => {
    const id = requirePlan(req.params.id);
    const parsed = normalizeDeck((req.body ?? {}) as unknown);
    if (!parsed.ok || !parsed.deck) {
        res.status(400).json({ error: parsed.error, warnings: parsed.warnings });
        return;
    }
    const count = importCards(id, parsed.deck.cards);
    res.json({ ok: true, count, warnings: parsed.warnings });
});

/** 一步到位：从 JSON 直接建一个新计划并灌进去 */
cardsRouter.post('/plans/import', (req, res) => {
    const parsed = normalizeDeck((req.body ?? {}) as unknown);
    if (!parsed.ok || !parsed.deck) {
        res.status(400).json({ error: parsed.error, warnings: parsed.warnings });
        return;
    }
    const { name, description, dailyNewLimit, cards } = parsed.deck;
    const plan = createPlan({
        name: name ?? `导入的计划 ${new Date().toLocaleDateString('zh-CN')}`,
        description,
        dailyNewLimit,
    });
    const count = importCards(plan.id, cards);
    res.status(201).json({ ok: true, plan, count, warnings: parsed.warnings });
});

// ---------- 学习 ----------

/** 当前该学哪张 + 进度。刷新页面重新拉一次，进度与队列位置都跟服务端一致。 */
cardsRouter.get('/plans/:id/study', (req, res) => {
    const id = requirePlan(req.params.id);
    res.json(studyState(id));
});

/**
 * 提交一次评分。
 * 立即落库 —— 此刻关掉标签页，已评过的卡一张都不会丢。
 */
cardsRouter.post('/plans/:id/review', (req, res) => {
    const id = requirePlan(req.params.id);
    const b = (req.body ?? {}) as { cardId?: unknown; rating?: unknown; durationMs?: unknown };

    const cardId = Number(b.cardId);
    if (!Number.isInteger(cardId) || cardId <= 0) {
        res.status(400).json({ error: 'cardId 不合法' });
        return;
    }
    if (!isValidRating(b.rating)) {
        res.status(400).json({ error: 'rating 只能是 1(重来) / 2(困难) / 3(良好) / 4(简单)' });
        return;
    }
    const durationMs = Number.isFinite(Number(b.durationMs)) ? Number(b.durationMs) : 0;

    res.json(rateCard(id, cardId, b.rating, durationMs));
});

/** 今天的成绩单 */
cardsRouter.get('/plans/:id/result', (req, res) => {
    const id = requirePlan(req.params.id);
    res.json(sessionResult(id));
});

// ---------- 学习统计 ----------

/**
 * 总体学习进度与状态。只读接口，一行都不写库。
 *
 * `?plan=<id>` 只看一个计划，不传（或传 all）看全部。
 */
cardsRouter.get('/stats', (req, res) => {
    const raw = req.query.plan;
    let plan: number | null = null;
    if (typeof raw === 'string' && raw !== '' && raw !== 'all') {
        plan = requirePlan(raw);
    }
    res.json(statsOverview(plan));
});
