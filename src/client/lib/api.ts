// 客户端调后端的一层薄封装。所有请求都是同源的本机接口，没有鉴权。

import type {
    AssistantShortcut, AssistantStep, AssistantTodo,
    Card, Plan, PlanWithStats, Rating, SessionResult, SpeakingReport, SpeakingSession,
    SpeakingSessionFull, SpeakingSessionSummary, SpeakingTurn, StatsOverview, StudyState,
    TableFull, TableSummary,
} from '../../shared/types';
import type { Modifiers } from '../../shared/speaking';
import type { ImportedDeck } from '../../shared/card-import';

async function json<T>(res: Response): Promise<T> {
    if (!res.ok) {
        let msg = `请求失败（${res.status}）`;
        try {
            const body = await res.json();
            if (body?.error) msg = body.error;
        } catch { /* 响应不是 JSON，用默认文案 */ }
        throw new Error(msg);
    }
    return res.json() as Promise<T>;
}

function post<T>(url: string, body: unknown, init: RequestInit = {}): Promise<T> {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...init,
    }).then(json<T>);
}

// ---------- 三线表 ----------

export async function apiListTables(): Promise<TableSummary[]> {
    return (await json<{ tables: TableSummary[] }>(await fetch('/api/tables'))).tables;
}

export async function apiGetTable(id: string): Promise<TableFull> {
    return (await json<{ table: TableFull }>(await fetch(`/api/tables/${encodeURIComponent(id)}`))).table;
}

export async function apiCreateTable(name?: string, html?: string): Promise<TableFull> {
    return (await post<{ table: TableFull }>('/api/tables', { name, html })).table;
}

export async function apiSaveTable(
    id: string,
    patch: { name?: string; html?: string },
    opts: { keepalive?: boolean } = {},
): Promise<TableFull> {
    const res = await fetch(`/api/tables/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        // 关页面时最后一次抢救性保存要带 keepalive，否则请求会随页面一起被取消
        keepalive: opts.keepalive,
    });
    return (await json<{ table: TableFull }>(res)).table;
}

export async function apiDeleteTable(id: string): Promise<void> {
    await json<{ ok: true }>(await fetch(`/api/tables/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export interface RestoreResult {
    ok: true;
    mode: 'merge' | 'replace';
    count: number;
    firstId: string;
    warnings: string[];
}

export function apiRestoreBackup(
    tables: Array<{ name: string; html: string }>,
    mode: 'merge' | 'replace',
): Promise<RestoreResult> {
    return post<RestoreResult>('/api/backup', { tables, mode });
}

// ---------- 设置 ----------

export async function apiGetSettings(): Promise<Record<string, string>> {
    return (await json<{ settings: Record<string, string> }>(await fetch('/api/settings'))).settings;
}

export async function apiSetSetting(key: string, value: string): Promise<void> {
    await post('/api/settings', { key, value }).catch(() => { /* 设置存不上不影响干活，静默 */ });
}

/**
 * 跟 apiSetSetting 的区别只有一个：这个会把失败抛出来。
 * 个人中心那种「点了保存就得知道成没成」的地方用它 ——
 * 静默失败会让人以为改好了，下次刷新才发现名字还是旧的。
 */
export function apiSetSettingStrict(key: string, value: string): Promise<{ ok: true; key: string; value: string }> {
    return post('/api/settings', { key, value });
}

// ---------- 记忆卡：计划 ----------

export async function apiListPlans(): Promise<{ plans: PlanWithStats[]; timeZone: string }> {
    return json<{ plans: PlanWithStats[]; timeZone: string }>(await fetch('/api/plans'));
}

export async function apiCreatePlan(input: {
    name: string; description?: string; dailyNewLimit?: number;
}): Promise<Plan> {
    return (await post<{ plan: Plan }>('/api/plans', input)).plan;
}

/** 切换收藏。收藏的计划在列表里排到最前面。 */
export async function apiToggleFavorite(id: number): Promise<Plan> {
    return (await post<{ plan: Plan }>(`/api/plans/${id}/favorite`, {})).plan;
}

export async function apiUpdatePlan(id: number, patch: {
    name?: string; description?: string; dailyNewLimit?: number; favorite?: boolean;
}): Promise<Plan> {
    const res = await fetch(`/api/plans/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    return (await json<{ plan: Plan }>(res)).plan;
}

export async function apiDeletePlan(id: number): Promise<void> {
    await json<{ ok: true }>(await fetch(`/api/plans/${id}`, { method: 'DELETE' }));
}

// ---------- 记忆卡：卡片 ----------

export async function apiListCards(planId: number): Promise<Card[]> {
    return (await json<{ cards: Card[] }>(await fetch(`/api/plans/${planId}/cards`))).cards;
}

export async function apiCreateCard(planId: number, front: string, back: string): Promise<Card> {
    return (await post<{ card: Card }>(`/api/plans/${planId}/cards`, { front, back })).card;
}

export async function apiUpdateCard(cardId: number, patch: { front?: string; back?: string }): Promise<Card> {
    const res = await fetch(`/api/cards/${cardId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    return (await json<{ card: Card }>(res)).card;
}

export async function apiDeleteCard(cardId: number): Promise<void> {
    await json<{ ok: true }>(await fetch(`/api/cards/${cardId}`, { method: 'DELETE' }));
}

export async function apiResetCard(cardId: number): Promise<Card> {
    return (await post<{ card: Card }>(`/api/cards/${cardId}/reset`, {})).card;
}

// ---------- 记忆卡：导入 ----------

export function apiImportIntoPlan(
    planId: number,
    deck: ImportedDeck | unknown,
): Promise<{ ok: true; count: number; warnings: string[] }> {
    return post(`/api/plans/${planId}/import`, deck);
}

export function apiImportAsNewPlan(
    deck: ImportedDeck | unknown,
): Promise<{ ok: true; plan: Plan; count: number; warnings: string[] }> {
    return post('/api/plans/import', deck);
}

// ---------- 记忆卡：学习 ----------

export async function apiStudyState(planId: number): Promise<StudyState> {
    return json<StudyState>(await fetch(`/api/plans/${planId}/study`));
}

/** 只送 cardId 和 rating —— 新状态由服务端算，客户端无从插手 */
export function apiRate(
    planId: number,
    cardId: number,
    rating: Rating,
    durationMs: number,
): Promise<StudyState> {
    return post<StudyState>(`/api/plans/${planId}/review`, { cardId, rating, durationMs });
}

export async function apiSessionResult(planId: number): Promise<SessionResult> {
    return json<SessionResult>(await fetch(`/api/plans/${planId}/result`));
}

// ---------- 记忆卡：统计 ----------

/** planId 传 null 就是「全部计划」 */
export async function apiStats(planId: number | null): Promise<StatsOverview> {
    const q = planId === null ? '' : `?plan=${planId}`;
    return json<StatsOverview>(await fetch(`/api/stats${q}`));
}

// ---------- 英语口语场景练习 ----------
//
// 注意这里发上去的永远只有结构化数据（场景、干扰项、目标词、说了什么）。
// 系统提示词一律由服务端拼装 —— 客户端连提交一份的字段都没有。

export interface LlmConfigView {
    configured: boolean;
    baseUrl: string;
    model: string;
    /** 打码后的 key，只用来确认「填的是哪一把」；明文永远不会下发 */
    keyHint: string;
    /** key 来自环境变量，页面上改不动 */
    fromEnv: boolean;
    presets: ReadonlyArray<{ key: string; label: string; baseUrl: string; model: string }>;
}

export async function apiSpeakingStatus(): Promise<LlmConfigView> {
    return json(await fetch('/api/speaking/status'));
}

/** 不传 apiKey 就是「不动原来那把」，只改地址或模型 */
export async function apiSaveLlmConfig(patch: {
    baseUrl?: string; model?: string; apiKey?: string;
}): Promise<Omit<LlmConfigView, 'presets'>> {
    const res = await fetch('/api/speaking/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    return json(res);
}

export function apiTestLlm(): Promise<{ ok: true; model: string; sample: string }> {
    return post('/api/speaking/config/test', {});
}

export function apiCheckScenario(scenario: string): Promise<{ valid: boolean; reason: string }> {
    return post('/api/speaking/check-scenario', { scenario });
}

export function apiRandomScenario(): Promise<{ scenario: string; label: string }> {
    return post('/api/speaking/random-scenario', {});
}

export async function apiListSpeakingSessions(): Promise<SpeakingSessionSummary[]> {
    return (await json<{ sessions: SpeakingSessionSummary[] }>(
        await fetch('/api/speaking/sessions'),
    )).sessions;
}

export async function apiCreateSpeakingSession(input: {
    scenario: string;
    label?: string;
    preset?: string;
    modifiers: Modifiers;
    targetWords?: string;
}): Promise<SpeakingSession> {
    return (await post<{ session: SpeakingSession }>('/api/speaking/sessions', input)).session;
}

export async function apiGetSpeakingSession(id: number): Promise<SpeakingSessionFull> {
    return (await json<{ session: SpeakingSessionFull }>(
        await fetch(`/api/speaking/sessions/${id}`),
    )).session;
}

export async function apiDeleteSpeakingSession(id: number): Promise<void> {
    await json<{ ok: true }>(await fetch(`/api/speaking/sessions/${id}`, { method: 'DELETE' }));
}

export async function apiSpeakingOpening(id: number): Promise<SpeakingTurn> {
    return (await post<{ turn: SpeakingTurn }>(`/api/speaking/sessions/${id}/opening`, {})).turn;
}

export function apiFinishSpeakingSession(id: number): Promise<{ session: SpeakingSession }> {
    return post(`/api/speaking/sessions/${id}/finish`, {});
}

export async function apiSpeakingReport(
    id: number,
    regenerate = false,
): Promise<{ report: SpeakingReport; reused: boolean }> {
    return post(`/api/speaking/sessions/${id}/report`, { regenerate });
}

/**
 * 说一句，流式收 AI 的回复。
 *
 * 每来一片就回调一次 onDelta，客户端据此逐句朗读 ——
 * 等整段回完再念，每轮要白等好几秒。
 */
export async function apiSpeakingTurn(
    id: number,
    content: string,
    source: 'typed' | 'speech',
    onDelta: (piece: string) => void,
    signal?: AbortSignal,
): Promise<{ turn: SpeakingTurn | null; error?: string }> {
    const res = await fetch(`/api/speaking/sessions/${id}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, source }),
        signal,
    });

    if (!res.ok) {
        // 流还没开起来就失败了，这时是普通的 JSON 错误响应
        let msg = `请求失败（${res.status}）`;
        try {
            const body = await res.json();
            if (body?.error) msg = body.error;
        } catch { /* 不是 JSON，用默认文案 */ }
        throw new Error(msg);
    }
    if (!res.body) throw new Error('服务端没有返回流');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let turn: SpeakingTurn | null = null;
    let error: string | undefined;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';       // 最后一段可能不完整，留到下一轮

        for (const part of parts) {
            for (const line of part.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                    const evt = JSON.parse(line.slice(5).trim()) as {
                        delta?: string; done?: boolean; turn?: SpeakingTurn; error?: string;
                    };
                    if (evt.delta) onDelta(evt.delta);
                    if (evt.done) { turn = evt.turn ?? null; error = evt.error; }
                } catch { /* 半个 JSON，跳过 */ }
            }
        }
    }
    return { turn, error };
}

// ---------- AI 悬浮球 ----------

export interface AssistantStatus {
    llmConfigured: boolean;
    langs: string[];
}

export function apiAssistantStatus(): Promise<AssistantStatus> {
    return fetch('/api/assistant/status').then(json<AssistantStatus>);
}

// 待办

export async function apiListTodos(): Promise<AssistantTodo[]> {
    return (await json<{ todos: AssistantTodo[] }>(await fetch('/api/assistant/todos'))).todos;
}

export async function apiCreateTodo(text: string): Promise<AssistantTodo> {
    return (await post<{ todo: AssistantTodo }>('/api/assistant/todos', { text })).todo;
}

export async function apiUpdateTodo(
    id: number,
    patch: { text?: string; done?: boolean },
): Promise<AssistantTodo> {
    const res = await fetch(`/api/assistant/todos/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    return (await json<{ todo: AssistantTodo }>(res)).todo;
}

export async function apiDeleteTodo(id: number): Promise<void> {
    await json<{ ok: boolean }>(await fetch(`/api/assistant/todos/${id}`, { method: 'DELETE' }));
}

export function apiClearDoneTodos(): Promise<{ removed: number }> {
    return post('/api/assistant/todos/clear-done', {});
}

// 快捷方式

export async function apiListShortcuts(): Promise<AssistantShortcut[]> {
    return (await json<{ shortcuts: AssistantShortcut[] }>(
        await fetch('/api/assistant/shortcuts'),
    )).shortcuts;
}

export async function apiCreateShortcut(input: {
    title: string; url: string; openInNewTab?: boolean;
}): Promise<AssistantShortcut> {
    return (await post<{ shortcut: AssistantShortcut }>('/api/assistant/shortcuts', input)).shortcut;
}

export async function apiUpdateShortcut(
    id: number,
    patch: { title?: string; url?: string; openInNewTab?: boolean },
): Promise<AssistantShortcut> {
    const res = await fetch(`/api/assistant/shortcuts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    return (await json<{ shortcut: AssistantShortcut }>(res)).shortcut;
}

export async function apiDeleteShortcut(id: number): Promise<void> {
    await json<{ ok: boolean }>(await fetch(`/api/assistant/shortcuts/${id}`, { method: 'DELETE' }));
}

// 翻译

export function apiTranslate(input: {
    text: string; from: string; to: string;
}): Promise<{ text: string; synonyms: string[] }> {
    return post('/api/assistant/translate', input);
}

// 对话（流式）

export interface AssistantPageContext {
    path: string;
    title: string;
    elements: Array<{ tag: string; text: string; label: string }>;
}

export interface AssistantChatHandlers {
    onStep(step: AssistantStep): void;
    onDelta(text: string): void;
    /** 助手决定跳页面。真正的跳转由调用方执行 —— 这一层不认识 router。 */
    onNavigate(path: string): void;
}

/**
 * 跟助手说一句，流式收回复。
 *
 * 事件有四种：step（思考步骤）、navigate（要跳页面）、delta（正文增量）、
 * error。done 之后流就结束了。
 */
export async function apiAssistantChat(
    input: {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        profile: { name: string; role: string; goal: string; style: string };
        page: AssistantPageContext | null;
        /** false = 关掉站内工具，纯聊天（省一次决策调用） */
        tools: boolean;
    },
    handlers: AssistantChatHandlers,
    signal?: AbortSignal,
): Promise<{ error?: string }> {
    const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal,
    });

    if (!res.ok) {
        let msg = `请求失败（${res.status}）`;
        try {
            const body = await res.json();
            if (body?.error) msg = body.error;
        } catch { /* 不是 JSON，用默认文案 */ }
        throw new Error(msg);
    }
    if (!res.body) throw new Error('服务端没有返回流');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let error: string | undefined;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';       // 最后一段可能不完整，留到下一轮

        for (const part of parts) {
            for (const line of part.split('\n')) {
                if (!line.startsWith('data:')) continue;
                try {
                    const evt = JSON.parse(line.slice(5).trim()) as {
                        type?: string; step?: AssistantStep; text?: string;
                        path?: string; message?: string;
                    };
                    if (evt.type === 'step' && evt.step) handlers.onStep(evt.step);
                    else if (evt.type === 'delta' && evt.text) handlers.onDelta(evt.text);
                    else if (evt.type === 'navigate' && evt.path) handlers.onNavigate(evt.path);
                    else if (evt.type === 'error') error = evt.message ?? '出错了';
                } catch { /* 半个 JSON，跳过 */ }
            }
        }
    }
    return { error };
}
