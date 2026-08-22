// ============================================================
//  OJ · HTTP 接口
//
//  原来这一层是 Electron 的 ipcMain.handle，一个通道名对一个函数。
//  搬到 HTTP 之后拆成两类：
//
//    · 普通请求 —— 题库、测试点、提交、设置，都是一来一回的 REST
//    · 长任务   —— 出题和判题都要跑几分钟。接口只负责**发起**，
//                  立刻返回一个 id，进度全部走 GET /api/oj/events 那条 SSE
//
//  「发起」和「进度」分开是关键：HTTP 请求不该挂住几分钟等一道题出完 ——
//  中间任何一跳超时都会让前端以为失败了，而任务其实还在后台好好跑着。
// ============================================================

import { Router } from 'express';
import type { OjDifficultyChoice, OjLanguageId } from '../shared/oj.js';
import { OJ_LANGUAGES } from '../shared/oj.js';
import { llmConfigured, llmStatus } from './llm.js';
import { addOjClient } from './oj-events.js';
import { cancelGeneration, listActiveJobs, startGeneration } from './oj-generate.js';
import { judgeSubmission, languageAvailable } from './oj-judge.js';
import { testPython } from './oj-python.js';
import {
    deleteProblem,
    getOjSettings,
    getProblem,
    getSampleCases,
    getSubmission,
    getTestCase,
    insertSubmission,
    listAllTags,
    listProblems,
    listSubmissions,
    listTestCaseMetas,
    saveOjSettings,
    toggleFavorite,
} from './oj-store.js';

export const ojRouter: Router = Router();

/** 带状态码的错误。index.ts 的统一错误出口认得它，会照实透出去。 */
export class OjError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

/** 路径参数是字符串。非法 id 一律当成不存在，不去区分「格式不对」和「没这条」。 */
function toId(raw: string): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function toInt(raw: unknown, def: number): number {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.floor(n) : def;
}

// ---------------- 进度流 ----------------

ojRouter.get('/oj/events', (req, res) => {
    const unsubscribe = addOjClient(res);
    // 这里挂 res 的 close 而不是 req 的：SSE 是个不结束的响应，
    // res 关掉才真的意味着对面走了
    res.on('close', unsubscribe);
    // 故意不 res.end() —— 这条响应就是要一直开着
    void req;
});

// ---------------- 设置 ----------------

ojRouter.get('/oj/settings', (_req, res) => {
    res.json({
        settings: getOjSettings(),
        // 模型配置是全站共用的，这里只读出来给页面显示「配没配好」，
        // 改它在「大模型档案」那个面板里做
        llm: llmStatus(),
        languages: OJ_LANGUAGES,
    });
});

ojRouter.patch('/oj/settings', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { pythonPath?: string; genConcurrency?: number } = {};
    // 只把请求里真出现过的键传下去 —— 「没传」不等于「要清空」
    if ('pythonPath' in body) patch.pythonPath = String(body.pythonPath ?? '');
    if ('genConcurrency' in body) patch.genConcurrency = toInt(body.genConcurrency, 3);
    res.json({ settings: saveOjSettings(patch) });
});

ojRouter.post('/oj/settings/test-python', async (_req, res, next) => {
    try {
        // testPython 自己永不抛，ok:false 也是 200 —— 这不是接口错误，
        // 是「你填的这个 Python 用不了」这条**结果**，前端要照常渲染它
        res.json(await testPython(getOjSettings().pythonPath));
    } catch (e) {
        next(e);
    }
});

// ---------------- 题库 ----------------

// 固定段必须写在 /:id 前面，否则 tags 会被当成一个题目 id
ojRouter.get('/oj/problems/tags', (_req, res) => {
    res.json({ tags: listAllTags() });
});

ojRouter.get('/oj/problems', (req, res) => {
    const q = req.query;
    res.json(listProblems({
        ...(typeof q.search === 'string' && q.search ? { search: q.search } : {}),
        ...(typeof q.tag === 'string' && q.tag ? { tag: q.tag } : {}),
        ...(q.favoriteOnly === '1' || q.favoriteOnly === 'true' ? { favoriteOnly: true } : {}),
        page: toInt(q.page, 1),
        pageSize: toInt(q.pageSize, 20),
    }));
});

ojRouter.get('/oj/problems/:id', (req, res) => {
    const id = toId(req.params.id);
    const problem = id === null ? null : getProblem(id);
    if (!problem || id === null) { res.status(404).json({ error: '题目不存在' }); return; }
    // 样例跟题面一起给：详情页一打开就要渲染它们，分两次请求只是多一次来回
    res.json({ problem, samples: getSampleCases(id) });
});

ojRouter.delete('/oj/problems/:id', (req, res) => {
    const id = toId(req.params.id);
    if (id === null || !deleteProblem(id)) { res.status(404).json({ error: '题目不存在' }); return; }
    res.json({ ok: true });
});

ojRouter.post('/oj/problems/:id/favorite', (req, res) => {
    const id = toId(req.params.id);
    const next = id === null ? null : toggleFavorite(id);
    if (next === null) { res.status(404).json({ error: '题目不存在' }); return; }
    res.json({ favorite: next });
});

ojRouter.get('/oj/problems/:id/testcases', (req, res) => {
    const id = toId(req.params.id);
    if (id === null) { res.status(404).json({ error: '题目不存在' }); return; }
    res.json({ cases: listTestCaseMetas(id) });
});

/** 单个测试点的完整数据。列表只给预览，点开某一个才走这里。 */
ojRouter.get('/oj/testcases/:id', (req, res) => {
    const id = toId(req.params.id);
    const tc = id === null ? null : getTestCase(id);
    if (!tc) { res.status(404).json({ error: '测试点不存在' }); return; }
    res.json({ case: tc });
});

// ---------------- 出题 ----------------

const VALID_DIFFICULTY_CHOICES: readonly OjDifficultyChoice[] = ['自动', '简单', '中等', '困难'];

ojRouter.post('/oj/generate', (req, res, next) => {
    try {
        // 先在这儿拦一道「没配模型」。
        //
        // 不拦的话按钮点下去会正常返回 jobId，几秒后任务在后台失败，
        // 用户看到的是一条跑了一半又红掉的进度 —— 而真正要做的事
        // （去配个模型）藏在日志里。当场 503 才说得清楚。
        if (!llmConfigured()) {
            throw new OjError(
                '还没配置大模型：在「英语口语练习」页顶部的「AI 模型」面板里添加一套配置（接口地址 + API Key + 模型名）就能用了，全站共用同一套。',
                503,
            );
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const prompt = String(body.prompt ?? '').trim().slice(0, 4000);
        const tags = Array.isArray(body.tags)
            ? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10)
            : [];
        const rawDifficulty = String(body.difficulty ?? '自动') as OjDifficultyChoice;
        const difficulty: OjDifficultyChoice = VALID_DIFFICULTY_CHOICES.includes(rawDifficulty)
            ? rawDifficulty
            : '自动';

        if (!prompt && tags.length === 0) {
            throw new OjError('至少写一句想出什么样的题，或者选几个算法标签');
        }

        res.status(202).json(startGeneration({ prompt, tags, difficulty }));
    } catch (e) {
        next(e);
    }
});

ojRouter.post('/oj/generate/:jobId/cancel', (req, res) => {
    // 取消一个已经结束或不存在的任务不算错 —— 结果都是「它没在跑」，
    // 前端为此弹一个红条毫无意义
    res.json({ cancelled: cancelGeneration(String(req.params.jobId)) });
});

ojRouter.get('/oj/generate/jobs', (_req, res) => {
    res.json({ jobs: listActiveJobs() });
});

// ---------------- 判题 ----------------

ojRouter.post('/oj/judge', (req, res, next) => {
    try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const problemId = toInt(body.problemId, 0);
        const language = String(body.language ?? 'python') as OjLanguageId;
        const code = String(body.code ?? '');

        if (!getProblem(problemId)) throw new OjError('题目不存在', 404);
        if (!languageAvailable(language)) throw new OjError('这个语言还没支持');
        if (!code.trim()) throw new OjError('代码是空的，没什么可评测的');

        const submissionId = insertSubmission({ problemId, language, code });

        // 不 await：判题要排队、还要逐点跑，可能几十秒。
        // 立刻把 submissionId 给前端，它拿这个 id 去 SSE 上认自己的进度。
        void judgeSubmission(submissionId, { problemId, language, code });

        res.status(202).json({ submissionId });
    } catch (e) {
        next(e);
    }
});

// ---------------- 提交记录 ----------------

ojRouter.get('/oj/submissions', (req, res) => {
    const q = req.query;
    const problemId = toInt(q.problemId, 0);
    res.json(listSubmissions({
        ...(problemId > 0 ? { problemId } : {}),
        page: toInt(q.page, 1),
        pageSize: toInt(q.pageSize, 20),
    }));
});

ojRouter.get('/oj/submissions/:id', (req, res) => {
    const id = toId(req.params.id);
    const submission = id === null ? null : getSubmission(id);
    if (!submission) { res.status(404).json({ error: '提交不存在' }); return; }
    res.json({ submission });
});
