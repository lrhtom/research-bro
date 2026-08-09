// ============================================================
//  AI 悬浮球的 HTTP 接口
//
//  四组东西：待办 CRUD、快捷方式 CRUD、翻译、对话。
//
//  对话那一条是全站唯一一个「会自己动手」的接口，所以边界写死在这里：
//    · 系统提示词只在服务端拼（同 routes-speaking.ts 的规矩）
//    · 助手能调的工具就是下面 switch 里那几个，全部落在本站自己的两张
//      小表和一份站内地图上 —— 它读不到三线表、记忆卡、口语记录，
//      更没有读文件、发请求、执行命令这一类的东西
//    · navigate 只是**告诉前端跳哪一页**，而且 path 必须是站内真实存在的
//      页面（isKnownPath 校验），模型编一个路径出来会被直接丢掉
// ============================================================

import { Router } from 'express';
import {
    AssistantError, clearDoneTodos, createShortcut, createTodo, deleteShortcut, deleteTodo,
    isKnownPath, listShortcuts, listTodos, searchSite, updateShortcut, updateTodo,
} from './assistant.js';
import {
    chatSystemPrompt, formatPages, normalizeProfile, observationsBlock,
    supportedLangs, toolSystemPrompt, translatePrompt,
    type PageContext,
} from './assistant-prompts.js';
import { chat, chatStream, extractJson, llmConfigured, LlmError } from './llm.js';
import type { ChatMessage } from './llm.js';
import type { AssistantStep } from '../shared/types.js';

export const assistantRouter: Router = Router();

/** 工具循环最多跑几步。每一步都是一次完整的模型调用，跑飞了就是白烧钱。 */
const MAX_TOOL_STEPS = 4;
/** 带进上下文的历史消息条数。悬浮球是随口问的地方，不需要记住半小时前的事。 */
const MAX_HISTORY = 16;
/** 单条消息进上下文时的截断长度 */
const MAX_MESSAGE_CHARS = 4000;
/** 页面摘要最多带几个元素 */
const MAX_PAGE_ELEMENTS = 40;

function idOf(raw: string): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new AssistantError('id 不合法');
    return id;
}

// ---------- 状态 ----------

/** 面板一打开先问一下：没配大模型就在面板里直接引导去配，而不是等他打完字才 503 */
assistantRouter.get('/assistant/status', (_req, res) => {
    res.json({ llmConfigured: llmConfigured(), langs: supportedLangs() });
});

// ---------- 待办 ----------

assistantRouter.get('/assistant/todos', (_req, res) => {
    res.json({ todos: listTodos() });
});

assistantRouter.post('/assistant/todos', (req, res) => {
    const text = String((req.body ?? {}).text ?? '');
    res.status(201).json({ todo: createTodo(text) });
});

assistantRouter.put('/assistant/todos/:id', (req, res) => {
    const b = (req.body ?? {}) as { text?: unknown; done?: unknown };
    res.json({
        todo: updateTodo(idOf(req.params.id), {
            text: typeof b.text === 'string' ? b.text : undefined,
            done: typeof b.done === 'boolean' ? b.done : undefined,
        }),
    });
});

assistantRouter.delete('/assistant/todos/:id', (req, res) => {
    res.json({ ok: deleteTodo(idOf(req.params.id)) });
});

assistantRouter.post('/assistant/todos/clear-done', (_req, res) => {
    res.json({ removed: clearDoneTodos() });
});

// ---------- 快捷方式 ----------

assistantRouter.get('/assistant/shortcuts', (_req, res) => {
    res.json({ shortcuts: listShortcuts() });
});

assistantRouter.post('/assistant/shortcuts', (req, res) => {
    const b = (req.body ?? {}) as { title?: unknown; url?: unknown; openInNewTab?: unknown };
    res.status(201).json({
        shortcut: createShortcut({
            title: String(b.title ?? ''),
            url: String(b.url ?? ''),
            openInNewTab: typeof b.openInNewTab === 'boolean' ? b.openInNewTab : undefined,
        }),
    });
});

assistantRouter.put('/assistant/shortcuts/:id', (req, res) => {
    const b = (req.body ?? {}) as { title?: unknown; url?: unknown; openInNewTab?: unknown };
    res.json({
        shortcut: updateShortcut(idOf(req.params.id), {
            title: typeof b.title === 'string' ? b.title : undefined,
            url: typeof b.url === 'string' ? b.url : undefined,
            openInNewTab: typeof b.openInNewTab === 'boolean' ? b.openInNewTab : undefined,
        }),
    });
});

assistantRouter.delete('/assistant/shortcuts/:id', (req, res) => {
    res.json({ ok: deleteShortcut(idOf(req.params.id)) });
});

// ---------- 翻译 ----------

/** 单个英文词（允许连字符和撇号）才配近义词；整句给「近义句」没有意义 */
function isSingleWord(text: string): boolean {
    return /^[\p{L}][\p{L}'-]*$/u.test(text.trim());
}

assistantRouter.post('/assistant/translate', async (req, res, next) => {
    try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const text = String(b.text ?? '').trim();
        if (!text) throw new AssistantError('没有要翻译的内容');
        if (text.length > 5000) throw new AssistantError('一次最多翻 5000 字');

        const from = String(b.from ?? 'auto');
        const to = String(b.to ?? 'en');
        const wantSynonyms = isSingleWord(text);

        const raw = await chat([
            { role: 'system', content: translatePrompt(from, to, wantSynonyms) },
            { role: 'user', content: text },
        ], { temperature: 0.2, maxTokens: 1500 });

        const parsed = extractJson<{ text?: unknown; synonyms?: unknown }>(raw);
        // 模型偶尔会忘了包 JSON 直接吐译文 —— 那份也能用，别为了格式把结果扔了
        const translated = String(parsed?.text ?? raw).trim();
        if (!translated) throw new LlmError('模型没有返回译文');

        const synonyms = Array.isArray(parsed?.synonyms)
            ? parsed.synonyms.map((s) => String(s).trim()).filter(Boolean).slice(0, 8)
            : [];

        res.json({ text: translated, synonyms });
    } catch (e) { next(e); }
});

// ---------- 对话 ----------

interface ToolAction {
    action?: unknown;
    reason?: unknown;
    query?: unknown;
    path?: unknown;
    text?: unknown;
    id?: unknown;
    title?: unknown;
    url?: unknown;
}

/** 一次工具调用的结果：喂回模型的全文 + 给人看的一句摘要 */
interface ToolResult {
    observation: string;
    summary: string;
    ok: boolean;
    /** 只有 navigate 会填 */
    navigateTo?: string;
}

function numArg(raw: unknown): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function runTool(act: ToolAction): ToolResult {
    const name = String(act.action ?? '').trim();

    switch (name) {
        case 'search_site': {
            const q = String(act.query ?? '').trim();
            const pages = searchSite(q);
            return {
                observation: `search_site("${q}")：\n${formatPages(pages)}`,
                summary: pages.length ? `站内检索「${q}」→ ${pages.length} 个结果` : `站内检索「${q}」→ 没找到`,
                ok: pages.length > 0,
            };
        }

        case 'navigate': {
            const path = String(act.path ?? '').trim();
            // 模型编出来的路径在这里被挡掉。挡掉之后照实告诉它，
            // 它下一步通常会改用 search_site 去找真的那一页。
            if (!isKnownPath(path)) {
                return {
                    observation: `navigate("${path}") 失败：站内没有这个页面。先用 search_site 查到真实路径再跳。`,
                    summary: `拒绝跳转到不存在的页面 ${path}`,
                    ok: false,
                };
            }
            return {
                observation: `navigate("${path}")：已让浏览器跳过去。`,
                summary: `跳转到 ${path}`,
                ok: true,
                navigateTo: path,
            };
        }

        case 'list_todos': {
            const todos = listTodos();
            const body = todos.length === 0
                ? '（一条待办都没有）'
                : todos.map((t) => `#${t.id} [${t.done ? '已完成' : '待办'}] ${t.text}`).join('\n');
            return {
                observation: `list_todos：\n${body}`,
                summary: `读到 ${todos.length} 条待办`,
                ok: true,
            };
        }

        case 'add_todo': {
            const todo = createTodo(String(act.text ?? ''));
            return {
                observation: `add_todo：已新建 #${todo.id}「${todo.text}」`,
                summary: `新建待办「${todo.text}」`,
                ok: true,
            };
        }

        case 'toggle_todo': {
            const id = numArg(act.id);
            if (id === null) return { observation: 'toggle_todo 失败：id 不合法', summary: 'id 不合法', ok: false };
            const todos = listTodos();
            const cur = todos.find((t) => t.id === id);
            if (!cur) return { observation: `toggle_todo 失败：没有 #${id} 这条待办`, summary: `#${id} 不存在`, ok: false };
            const next = updateTodo(id, { done: !cur.done });
            return {
                observation: `toggle_todo：#${id}「${next.text}」现在是${next.done ? '已完成' : '未完成'}`,
                summary: `把「${next.text}」标成${next.done ? '已完成' : '未完成'}`,
                ok: true,
            };
        }

        case 'delete_todo': {
            const id = numArg(act.id);
            if (id === null) return { observation: 'delete_todo 失败：id 不合法', summary: 'id 不合法', ok: false };
            const gone = deleteTodo(id);
            return {
                observation: gone ? `delete_todo：#${id} 已删除` : `delete_todo：没有 #${id} 这条待办`,
                summary: gone ? `删除待办 #${id}` : `#${id} 不存在`,
                ok: gone,
            };
        }

        case 'list_shortcuts': {
            const list = listShortcuts();
            const body = list.length === 0
                ? '（没有快捷方式）'
                : list.map((s) => `#${s.id} ${s.title} → ${s.url}`).join('\n');
            return { observation: `list_shortcuts：\n${body}`, summary: `读到 ${list.length} 条快捷方式`, ok: true };
        }

        case 'add_shortcut': {
            const sc = createShortcut({ title: String(act.title ?? ''), url: String(act.url ?? '') });
            return {
                observation: `add_shortcut：已新建 #${sc.id}「${sc.title}」→ ${sc.url}`,
                summary: `新建快捷方式「${sc.title}」`,
                ok: true,
            };
        }

        default:
            return {
                observation: `未知动作 "${name}"。只能用提示词里列出的那几个。`,
                summary: `未知动作 ${name}`,
                ok: false,
            };
    }
}

/** 把客户端送来的消息裁成能进上下文的样子 */
function normalizeHistory(raw: unknown): ChatMessage[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((m): m is { role: unknown; content: unknown } => !!m && typeof m === 'object')
        .map((m) => ({
            role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: String(m.content ?? '').slice(0, MAX_MESSAGE_CHARS),
        }))
        .filter((m) => m.content.trim() !== '')
        .slice(-MAX_HISTORY);
}

function normalizePageContext(raw: unknown): PageContext | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    const path = String(p.path ?? '').slice(0, 200);
    if (!path) return null;

    const elements = Array.isArray(p.elements) ? p.elements : [];
    return {
        path,
        title: String(p.title ?? '').slice(0, 200),
        elements: elements
            .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
            .slice(0, MAX_PAGE_ELEMENTS)
            .map((e) => ({
                tag: String(e.tag ?? 'div').slice(0, 20),
                text: String(e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
                label: String(e.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
            })),
    };
}

/**
 * 对话（SSE）。
 *
 * 两段式：先跑工具循环（每步一次非流式调用，只让模型吐一个 JSON 动作），
 * 循环结束后把观察结果拼进上下文，再流式生成正式回复。
 *
 * 为什么第一步也要过一次模型，而不是像原版那样用关键词判断要不要用工具：
 * 关键词表永远漏，「记一下明天交作业」里一个工具词都没有，却明明该建待办。
 * 让模型自己第一步就回 answer 才是可靠的判断，代价是一次几十 token 的调用。
 * 不想要这个代价的人可以在面板上把「站内操作」关掉，走 tools=false。
 */
assistantRouter.post('/assistant/chat', async (req, res, next) => {
    let opened = false;

    const send = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const history = normalizeHistory(b.messages);
        if (history.length === 0) throw new AssistantError('没有要发送的内容');

        const profile = normalizeProfile(b.profile);
        const page = normalizePageContext(b.page);
        const useTools = b.tools !== false;

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        opened = true;

        // 客户端真断开了才取消上游 —— 挂在 req 的 close 上会在请求体读完时
        // 立刻触发，每一轮都自己把自己 abort 掉（口语那边踩过这个坑）
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });

        const observations: string[] = [];
        let navigateTo: string | null = null;

        if (useTools) {
            for (let step = 1; step <= MAX_TOOL_STEPS; step += 1) {
                send({ type: 'step', step: { kind: 'thinking', step } satisfies AssistantStep });

                const decision = await chat([
                    { role: 'system', content: toolSystemPrompt(MAX_TOOL_STEPS - step + 1) },
                    ...history,
                    {
                        role: 'user',
                        content: observations.length
                            ? `已有观察结果：\n${observations.join('\n---\n')}\n\n下一个动作（只输出 JSON）：`
                            : '下一个动作（只输出 JSON）：',
                    },
                ], { temperature: 0, maxTokens: 300, signal: ac.signal });

                const act = extractJson<ToolAction>(decision);
                const name = String(act?.action ?? '').trim();

                // 解析不出动作就当它想直接回答 —— 卡在这里反复重试只会更贵
                if (!act || !name || name === 'answer' || name === 'final') break;

                send({
                    type: 'step',
                    step: {
                        kind: 'action', step, action: name,
                        reason: String(act.reason ?? '').slice(0, 200),
                    } satisfies AssistantStep,
                });

                let result: ToolResult;
                try {
                    result = runTool(act);
                } catch (toolError) {
                    // 工具自己抛的错（比如待办内容为空）也要喂回去，模型据此改参数重试
                    const msg = toolError instanceof Error ? toolError.message : '工具执行失败';
                    result = { observation: `${name} 失败：${msg}`, summary: msg, ok: false };
                }

                observations.push(result.observation);
                if (result.navigateTo) {
                    navigateTo = result.navigateTo;
                    send({ type: 'navigate', path: result.navigateTo });
                }

                send({
                    type: 'step',
                    step: { kind: 'observation', step, summary: result.summary, ok: result.ok } satisfies AssistantStep,
                });
            }
        }

        const messages: ChatMessage[] = [
            { role: 'system', content: chatSystemPrompt(profile, page) + observationsBlock(observations) },
            ...history,
        ];

        let full = '';
        for await (const piece of chatStream(messages, {
            temperature: 0.7, maxTokens: 1600, signal: ac.signal,
        })) {
            full += piece;
            send({ type: 'delta', text: piece });
        }

        if (!full.trim()) {
            send({ type: 'error', message: '模型没有返回内容' });
        }
        send({ type: 'done', navigateTo });
        res.end();
    } catch (e) {
        // 头已经发出去就改不了状态码了，只能把错误当成一条 SSE 事件推下去
        if (opened) {
            const msg = e instanceof Error ? e.message : '服务端错误';
            send({ type: 'error', message: msg });
            send({ type: 'done', navigateTo: null });
            res.end();
            return;
        }
        next(e);
    }
});
