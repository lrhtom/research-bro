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
    chat, chatStream, extractJson, llmStatus, saveLlmConfig, testLlmConnection,
    LLM_PRESETS, LlmError,
} from './llm.js';
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
    res.json({ ...llmStatus(), presets: LLM_PRESETS });
});

speakingRouter.put('/speaking/config', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    res.json(saveLlmConfig({
        baseUrl: typeof b.baseUrl === 'string' ? b.baseUrl : undefined,
        model: typeof b.model === 'string' ? b.model : undefined,
        // 没传 apiKey = 不动原来那把（页面不回显明文，得允许「只改模型」）
        apiKey: typeof b.apiKey === 'string' ? b.apiKey : undefined,
    }));
});

/** 用当前配置打一次最小调用，确认是不是真的能通 */
speakingRouter.post('/speaking/config/test', async (_req, res, next) => {
    try {
        res.json(await testLlmConnection());
    } catch (e) { next(e); }
});

// ---------- 场景 ----------

/** 自己写的场景先过一遍内容审核 */
speakingRouter.post('/speaking/check-scenario', async (req, res, next) => {
    try {
        const scenario = String((req.body ?? {}).scenario ?? '').trim();
        if (!scenario) { res.json({ valid: false, reason: '场景描述不能为空' }); return; }
        if (scenario.length > 2000) { res.json({ valid: false, reason: '场景描述太长了（上限 2000 字）' }); return; }

        const text = await chat([
            { role: 'system', content: checkScenarioPrompt() },
            { role: 'user', content: scenario },
        ], { temperature: 0.1, maxTokens: 200 });

        const parsed = extractJson<{ valid?: unknown; reason?: unknown }>(text);
        if (parsed) {
            res.json({ valid: Boolean(parsed.valid), reason: String(parsed.reason ?? '') });
            return;
        }
        // 模型没给出规规矩矩的 JSON：宁可放行也不要卡住用户，
        // 但明显的拒绝词还是拦一下
        const bad = /\bfalse\b|nsfw|illegal|inappropriate|hate speech/i.test(text);
        res.json({ valid: !bad, reason: bad ? '这个场景不适合用来练习，换一个吧' : '' });
    } catch (e) { next(e); }
});

/** 随便来一个场景，避开最近用过的 */
speakingRouter.post('/speaking/random-scenario', async (_req, res, next) => {
    try {
        const text = await chat([
            { role: 'system', content: randomScenarioPrompt(recentScenarioLabels()) },
        ], { temperature: 0.9, maxTokens: 400 });

        const parsed = extractJson<{ scenario?: unknown; label?: unknown }>(text);
        const scenario = String(parsed?.scenario ?? '').trim();
        if (!scenario) throw new LlmError('没能生成场景，请重试');

        const label = String(parsed?.label ?? '').trim() || scenario.slice(0, 20);
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

        const text = await chat([
            {
                role: 'system',
                content: openingPrompt(session.scenario, session.modifiers, session.targetWords),
            },
            { role: 'user', content: 'Please start the conversation.' },
        ], { temperature: 0.85, maxTokens: 300 });

        const opening = text.replace(/^["'\s]+|["'\s]+$/g, '');
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

        let full = '';
        for await (const piece of chatStream(messages, { temperature: 0.8, maxTokens: 400, signal: ac.signal })) {
            full += piece;
            res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`);
        }

        const reply = full.trim();
        if (reply) {
            const turn = addTurn(id, 'assistant', reply, 'ai');
            res.write(`data: ${JSON.stringify({ done: true, turn })}\n\n`);
        } else {
            res.write(`data: ${JSON.stringify({ done: true, error: 'AI 没有返回内容' })}\n\n`);
        }
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
