// ============================================================
//  英语口语场景练习的 HTTP 接口
//
//  一条铁规矩：**系统提示词只在这里拼**。
//  客户端提交的永远只有 {场景, 勾了哪些干扰项, 目标词, 说了什么}，
//  它没有任何途径把自己写的 system prompt 送进模型 ——
//  否则那些「不许纠错、不许出戏、不许评价发音」的约束一句都不作数。
//
//  整场练习只有两种对话调用：
//    · POST /speaking/sessions/:id/turn   流式的角色扮演回合
//    · POST /speaking/sessions/:id/report 收尾时一次性的总结
//  没有「每轮偷偷评估一次」的第三种 —— 那会让实时对话既加钱又加延迟。
// ============================================================

import { Router } from 'express';
import {
    addTurn, createSession, deleteSession, finishSession, generateReport,
    getSessionFull, listSessions, listTurns, recentScenarioLabels, rememberScenario,
    requireSession, SpeakingError, unusedTargetWords,
} from './speaking.js';
import {
    checkScenarioPrompt, openingPrompt, randomScenarioPrompt, turnPrompt, unusedWordsNudge,
} from './speaking-prompts.js';
import {
    chat, chatNonEmpty, chatStream, extractJson, llmStatus, testLlmConnection,
    shouldRetryLlm, sleepBeforeRetry, LLM_ATTEMPTS, LLM_PRESETS, LlmError,
} from './llm.js';
import {
    createModel, deleteModel, listModels, setActive as setActiveModel,
    testModelConfig, testStoredModel, updateModel,
} from './llm-models.js';
import {
    createScenario, deleteScenario, listScenarios, updateScenario,
} from './speaking-scenarios.js';
import type { ChatMessage } from './llm.js';
import type { SpeakingTurn } from '../shared/types.js';

export const speakingRouter: Router = Router();

function idOf(raw: string): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new SpeakingError('会话 id 不合法');
    return id;
}

/** 快收尾的判定：AI 已经说了这么多轮，就该开始往没用过的目标词上带 */
const NUDGE_AFTER_TURNS = 6;

/** 把库里的对话轮转成喂给模型的消息列表 */
function toMessages(turns: SpeakingTurn[]): ChatMessage[] {
    return turns.map((t) => ({
        role: t.role === 'user' ? 'user' as const : 'assistant' as const,
        content: t.content,
    }));
}

// ---------- 大模型配置 ----------
//
// 单机单人应用，没有账号体系，配置就直接存本机 SQLite 的 settings 表，
// 页面上填完即时生效、不用重启。
//
// API Key 只进不出：这三个接口一律只回打码提示（sk-…a1b2），
// 明文那一份除了发给模型之外不离开服务端。

/** 前端进入页面先问一下：没配就在页面上直接引导去配，而不是让每个按钮都 503 */
speakingRouter.get('/speaking/status', (_req, res) => {
    res.json({ ...llmStatus(), presets: LLM_PRESETS, models: listModels() });
});

// ---------- 模型档案 ----------
//
// 存好几套连接方式（别名 + 模型名 + 地址 + key），点一下切换。
// 别名给人看、模型名给接口看，两个都要 —— 见 llm-models.ts 顶部的说明。
// 明文 key 只进不出，这几个接口一律只回打码后的样子。

speakingRouter.get('/speaking/models', (_req, res) => {
    res.json({ models: listModels(), status: llmStatus() });
});

speakingRouter.post('/speaking/models', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const model = createModel({
        alias: b.alias, model: b.model, baseUrl: b.baseUrl, apiKey: b.apiKey,
    });
    res.status(201).json({ model, models: listModels(), status: llmStatus() });
});

speakingRouter.patch('/speaking/models/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // 只把请求里真出现过的键传下去：没传 apiKey = 不动原来那把
    const patch: Record<string, unknown> = {};
    for (const k of ['alias', 'model', 'baseUrl', 'apiKey']) if (k in b) patch[k] = b[k];

    const model = updateModel(idOf(req.params.id), patch);
    if (!model) { res.status(404).json({ error: '这套模型配置不存在' }); return; }
    res.json({ model, models: listModels(), status: llmStatus() });
});

speakingRouter.delete('/speaking/models/:id', (req, res) => {
    if (!deleteModel(idOf(req.params.id))) {
        res.status(404).json({ error: '这套模型配置不存在' }); return;
    }
    res.json({ ok: true, models: listModels(), status: llmStatus() });
});

/** 切换当前使用的那一套。口语练习和 AI 悬浮球共用它。 */
speakingRouter.post('/speaking/models/:id/activate', (req, res) => {
    if (!setActiveModel(idOf(req.params.id))) {
        res.status(404).json({ error: '这套模型配置不存在' }); return;
    }
    res.json({ ok: true, models: listModels(), status: llmStatus() });
});

/**
 * 单独测一套（**不切换**当前在用的那个）。
 *
 * 想知道「哪一套还能用」不该逼你先切过去、测完再切回来 ——
 * 切换是有副作用的：口语练习、AI 助手、AI 出题会立刻跟着换。
 *
 * 测试失败是一条**结果**不是接口错误，所以一律 200 + status 字段，
 * 前端照常渲染那一行的状态点。
 */
speakingRouter.post('/speaking/models/:id/test', async (req, res, next) => {
    try {
        res.json(await testStoredModel(idOf(req.params.id)));
    } catch (e) { next(e); }
});

/**
 * 测一份**还没存下来**的配置。
 *
 * 添加模型的弹窗里要能先测再存 —— 不然只能「存了再测，不行再改」，
 * 而错的那一套已经躺在列表里了。
 */
speakingRouter.post('/speaking/models/test-config', async (req, res, next) => {
    try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        res.json(await testModelConfig({
            baseUrl: String(b.baseUrl ?? ''),
            apiKey: String(b.apiKey ?? ''),
            model: String(b.model ?? ''),
        }));
    } catch (e) { next(e); }
});

/** 用当前选中的那套档案打一次最小调用，确认是不是真的能通 */
speakingRouter.post('/speaking/config/test', async (_req, res, next) => {
    try {
        res.json(await testLlmConnection());
    } catch (e) { next(e); }
});

// ---------- 场景 ----------

/**
 * 自己写的场景过一遍内容审核。
 *
 * 开始练习前审一次，存进「我的场景」时也审一次 —— 抽出来共用，
 * 免得两条路的判定标准不一样。
 */
async function moderateScenario(scenario: string): Promise<{ valid: boolean; reason: string }> {
    if (!scenario) return { valid: false, reason: '场景描述不能为空' };
    if (scenario.length > 2000) return { valid: false, reason: '场景描述太长了（上限 2000 字）' };

    const text = await chat([
        { role: 'system', content: checkScenarioPrompt() },
        { role: 'user', content: scenario },
    ], { temperature: 0.1, maxTokens: 200 });

    const parsed = extractJson<{ valid?: unknown; reason?: unknown }>(text);
    if (parsed) return { valid: Boolean(parsed.valid), reason: String(parsed.reason ?? '') };

    // 模型没给出规规矩矩的 JSON：宁可放行也不要卡住用户，
    // 但明显的拒绝词还是拦一下
    const bad = /\bfalse\b|nsfw|illegal|inappropriate|hate speech/i.test(text);
    return { valid: !bad, reason: bad ? '这个场景不适合用来练习，换一个吧' : '' };
}

speakingRouter.post('/speaking/check-scenario', async (req, res, next) => {
    try {
        res.json(await moderateScenario(String((req.body ?? {}).scenario ?? '').trim()));
    } catch (e) { next(e); }
});

// ---------- 我的场景 ----------
//
// 内置场景在 shared/speaking.ts 里写死；这里是自己存的那些。
// 审核只在存的时候做一次：存进来之后文本不会变，每次开练重审是白花钱。

speakingRouter.get('/speaking/scenarios', (_req, res) => {
    res.json({ scenarios: listScenarios() });
});

speakingRouter.post('/speaking/scenarios', async (req, res, next) => {
    try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const scenario = String(b.scenario ?? '').trim();

        const verdict = await moderateScenario(scenario);
        if (!verdict.valid) {
            res.status(422).json({ error: verdict.reason || '这个场景不适合用来练习，换一个吧' });
            return;
        }

        res.status(201).json({
            scenario: createScenario({ label: b.label, scenario }),
            scenarios: listScenarios(),
        });
    } catch (e) { next(e); }
});

speakingRouter.patch('/speaking/scenarios/:id', async (req, res, next) => {
    try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        // 正文变了就要重审 —— 改名不用
        if ('scenario' in b) {
            const verdict = await moderateScenario(String(b.scenario ?? '').trim());
            if (!verdict.valid) {
                res.status(422).json({ error: verdict.reason || '这个场景不适合用来练习，换一个吧' });
                return;
            }
        }
        const patch: Record<string, unknown> = {};
        for (const k of ['label', 'scenario']) if (k in b) patch[k] = b[k];

        const saved = updateScenario(idOf(req.params.id), patch);
        if (!saved) { res.status(404).json({ error: '这个场景不存在' }); return; }
        res.json({ scenario: saved, scenarios: listScenarios() });
    } catch (e) { next(e); }
});

speakingRouter.delete('/speaking/scenarios/:id', (req, res) => {
    if (!deleteScenario(idOf(req.params.id))) {
        res.status(404).json({ error: '这个场景不存在' }); return;
    }
    res.json({ ok: true, scenarios: listScenarios() });
});

/** 随便来一个场景，避开最近用过的 */
speakingRouter.post('/speaking/random-scenario', async (_req, res, next) => {
    try {
        // 空回复由 chatNonEmpty 兜；这里还要多兜一层「回了字但抠不出 scenario」——
        // 温度 0.9 下模型偶尔会把 JSON 写崩，同样是再来一次就好的事
        let scenario = '';
        let label = '';

        for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt += 1) {
            const text = await chatNonEmpty([
                { role: 'system', content: randomScenarioPrompt(recentScenarioLabels()) },
            ], { temperature: 0.9, maxTokens: 400 });

            const parsed = extractJson<{ scenario?: unknown; label?: unknown }>(text);
            scenario = String(parsed?.scenario ?? '').trim();
            if (scenario) {
                label = String(parsed?.label ?? '').trim() || scenario.slice(0, 20);
                break;
            }
            if (attempt < LLM_ATTEMPTS) await sleepBeforeRetry(attempt);
        }

        if (!scenario) throw new LlmError('没能生成场景，稍后再试一次');

        rememberScenario(label);
        res.json({ scenario, label });
    } catch (e) { next(e); }
});

// ---------- 会话 ----------

speakingRouter.get('/speaking/sessions', (_req, res) => {
    res.json({ sessions: listSessions() });
});

speakingRouter.post('/speaking/sessions', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const session = createSession({
        scenario: String(b.scenario ?? ''),
        label: String(b.label ?? ''),
        preset: String(b.preset ?? ''),
        modifiers: b.modifiers as never,
        targetWords: (typeof b.targetWords === 'string' ? b.targetWords : undefined),
    });
    res.status(201).json({ session });
});

speakingRouter.get('/speaking/sessions/:id', (req, res) => {
    const full = getSessionFull(idOf(req.params.id));
    if (!full) { res.status(404).json({ error: '这场练习不存在' }); return; }
    res.json({ session: full });
});

speakingRouter.delete('/speaking/sessions/:id', (req, res) => {
    if (!deleteSession(idOf(req.params.id))) {
        res.status(404).json({ error: '这场练习不存在' });
        return;
    }
    res.json({ ok: true });
});

speakingRouter.post('/speaking/sessions/:id/finish', (req, res) => {
    res.json({ session: finishSession(idOf(req.params.id)) });
});

// ---------- 开场白 ----------

/** AI 先开口。已经开过场就把原来那句还回去，刷新页面不会多出一段。 */
speakingRouter.post('/speaking/sessions/:id/opening', async (req, res, next) => {
    try {
        const id = idOf(req.params.id);
        const session = requireSession(id);

        const existing = listTurns(id);
        if (existing.length > 0) { res.json({ turn: existing[0], reused: true }); return; }

        // 开场白空掉最要命：一进房间对方就是哑的，整场练习根本起不来。
        // chatNonEmpty 会自己重试，实在拿不到才抛错让页面显示「重新开场」。
        const text = await chatNonEmpty([
            {
                role: 'system',
                content: openingPrompt(session.scenario, session.modifiers, session.targetWords),
            },
            { role: 'user', content: 'Please start the conversation.' },
        ], { temperature: 0.85, maxTokens: 300 });

        // 去掉模型爱加的那层引号之后可能又空了，这时候宁可报错也不要存一条空开场
        const opening = text.replace(/^["'\s]+|["'\s]+$/g, '');
        if (!opening) throw new LlmError('开场白生成失败，刷新页面再试一次');

        res.json({ turn: addTurn(id, 'assistant', opening, 'ai'), reused: false });
    } catch (e) { next(e); }
});

// ---------- 一轮对话（流式） ----------

/**
 * 学习者说一句，AI 流式答一句。
 *
 * 用 SSE 而不是等整段回完：客户端拿到第一个句号就能让语音合成开口，
 * 否则每轮都要干等好几秒，实时对话的感觉就没了。
 *
 * 落库时机：用户那句一进来就先存（此刻关掉页面也不丢），
 * AI 那句等流结束、拿到完整文本再存。
 */
speakingRouter.post('/speaking/sessions/:id/turn', async (req, res, next) => {
    let opened = false;
    try {
        const id = idOf(req.params.id);
        const session = requireSession(id);

        const b = (req.body ?? {}) as Record<string, unknown>;
        const said = String(b.content ?? '').trim();
        // 只认这两种来源。'ai' 是给助手行用的，客户端不许自称。
        const source = b.source === 'typed' ? 'typed' as const : 'speech' as const;
        if (!said) throw new SpeakingError('这一轮没有内容');

        addTurn(id, 'user', said, source);

        const turns = listTurns(id);
        const aiTurns = turns.filter((t) => t.role === 'assistant').length;

        // 快收尾了就把话题往还没用过的目标词上带（只加在系统提示词里，AI 不会说出来）
        const nudge = aiTurns >= NUDGE_AFTER_TURNS
            ? unusedWordsNudge(unusedTargetWords(session, turns))
            : '';

        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: turnPrompt(session.scenario, session.modifiers, session.targetWords) + nudge,
            },
            ...toMessages(turns),
        ];

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        opened = true;

        // 客户端真的断开了才取消上游请求。
        //
        // 这里**不能**挂在 req 的 'close' 上：express.json() 已经把请求体读完了，
        // 那个事件此刻立刻就会触发，于是每一轮都会在刚开始流式时把自己 abort 掉，
        // 表现是每次回复都变成 "This operation was aborted"。
        // res 的 'close' 才是「连接没了」，再用 writableEnded 排除掉正常结束的情况。
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });

        // 一句都没吐出来就再来一次。
        //
        // 对话里空回复比别处更难受：练到一半对方突然哑了，这一轮就断了。
        // 而空回复几乎都是一次性的抖动，同样的消息再发一遍通常就有了，
        // 所以这里自己重试，而不是把「AI 没有返回内容」摔给用户。
        //
        // 重试前要给客户端一条 retry 事件：上一次可能已经吐了几个空白字符
        // 过去，客户端得把那半截清掉，否则重试的正文会接在空白后面，
        // 逐句朗读也会把那半截当成一句念出来。
        let reply = '';
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt += 1) {
            let full = '';
            try {
                for await (const piece of chatStream(messages, {
                    temperature: 0.8, maxTokens: 400, signal: ac.signal,
                })) {
                    full += piece;
                    res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
                }
            } catch (e) {
                if (!shouldRetryLlm(e, ac.signal)) throw e;
                lastError = e;
            }

            reply = full.trim();
            if (reply) break;

            if (attempt < LLM_ATTEMPTS) {
                res.write(`data: ${JSON.stringify({ retry: attempt })}\n\n`);
                await sleepBeforeRetry(attempt, ac.signal);
            }
        }

        if (!reply) {
            throw lastError instanceof Error
                ? lastError
                : new LlmError(`AI 连续 ${LLM_ATTEMPTS} 次都没出声，稍后再说一遍，或者换一个模型`);
        }

        const turn = addTurn(id, 'assistant', reply, 'ai');
        res.write(`data: ${JSON.stringify({ done: true, turn })}\n\n`);
        res.end();
    } catch (e) {
        // 头已经发出去了就没法再改状态码，只能把错误当成一条 SSE 事件推下去
        if (opened) {
            const msg = e instanceof Error ? e.message : '服务端错误';
            res.write(`data: ${JSON.stringify({ done: true, error: msg })}\n\n`);
            res.end();
            return;
        }
        next(e);
    }
});

// ---------- 报告 ----------

/**
 * 收尾总结。整场练习的第二次、也是最后一次大模型调用。
 *
 * 生成出来的东西还要过一遍服务端校验（speaking.ts 的 sanitizeReport）：
 * 任何发音 / 语调 / 语速 / 总分类的断言，以及引不出学习者原话的条目，
 * 都会被直接删掉 —— 模型从来没听过用户的声音，那些数字造不出来。
 */
speakingRouter.post('/speaking/sessions/:id/report', async (req, res, next) => {
    try {
        const id = idOf(req.params.id);
        const session = requireSession(id);

        // 已经生成过就直接返回，不重复烧一次调用
        if (session.report && (req.body ?? {}).regenerate !== true) {
            res.json({ report: session.report, reused: true });
            return;
        }
        res.json({ report: await generateReport(id), reused: false });
    } catch (e) { next(e); }
});
