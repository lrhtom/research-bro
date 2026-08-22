// 客户端调后端的一层薄封装。所有请求都是同源的本机接口，没有鉴权。

import type {
    AssistantShortcut, AssistantStep, AssistantTodo,
    Card, CardCurve, Note, Plan, PlanWithStats, Rating, SessionResult, SpeakingReport,
    SpeakingSession, SpeakingSessionFull, SpeakingSessionSummary, SpeakingTurn, StatsOverview,
    StudyState, TableFull, TableSummary,
} from '../../shared/types';
import type { Modifiers } from '../../shared/speaking';
import type { ImportedDeck } from '../../shared/card-import';
import type {
    OjGenJobSnapshot, OjGenerateParams, OjJudgeSubmitParams, OjLanguageInfo, OjProblem,
    OjProblemListItem, OjProblemQuery, OjSettings, OjSubmission, OjSubmissionQuery,
    OjTestCase, OjTestCaseMeta,
} from '../../shared/oj';

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

function patch<T>(url: string, body: unknown): Promise<T> {
    return fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

// ---------- 记事本 ----------
//
// 只有这五个。搜索没有接口（前端对拉全的列表自己过滤），
// 标签没有接口（它就是笔记上的一个数组），草稿也没有接口（存浏览器本地）。

export async function apiListNotes(): Promise<Note[]> {
    return (await json<{ notes: Note[] }>(await fetch('/api/notes'))).notes;
}

export async function apiGetNote(id: number): Promise<Note> {
    return (await json<{ note: Note }>(await fetch(`/api/notes/${id}`))).note;
}

export async function apiCreateNote(
    body: { title?: string; tags?: string[]; content?: string },
): Promise<Note> {
    return (await post<{ note: Note }>('/api/notes', body)).note;
}

/** PATCH：只发改过的字段，没带的键服务端一律不动 */
export async function apiUpdateNote(
    id: number,
    body: { title?: string; tags?: string[]; content?: string },
): Promise<Note> {
    return (await patch<{ note: Note }>(`/api/notes/${id}`, body)).note;
}

export async function apiDeleteNote(id: number): Promise<void> {
    await json<{ ok: true }>(await fetch(`/api/notes/${id}`, { method: 'DELETE' }));
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

/** 取一张卡的遗忘曲线与四档预览。曲线全在服务端算，前端只负责画。 */
export async function apiCardCurve(cardId: number): Promise<CardCurve> {
    return (await json<{ curve: CardCurve }>(await fetch(`/api/cards/${cardId}/curve`))).curve;
}

/**
 * 在管理页手动评一档，拨动这张卡的遗忘曲线。
 *
 * 注意它跟 apiRate 不是一回事：这个**不计入今日进度与统计**，
 * 只改这张卡自己的排期。正常复习请走学习页。
 */
export async function apiAdjustCard(cardId: number, rating: Rating): Promise<{
    card: Card; curve: CardCurve;
}> {
    return post<{ card: Card; curve: CardCurve }>(`/api/cards/${cardId}/adjust`, { rating });
}

/** 切换收藏。收藏的卡片在管理页排最前，但不影响学习时的出卡顺序。 */
export async function apiToggleCardFavorite(cardId: number): Promise<Card> {
    return (await post<{ card: Card }>(`/api/cards/${cardId}/favorite`, {})).card;
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
    /** 当前这套档案的别名与 id；走环境变量兜底时没有档案，两个都是空 */
    alias?: string;
    activeId?: number;
    presets: ReadonlyArray<{ key: string; label: string; baseUrl: string; model: string }>;
    models: LlmModel[];
}

/**
 * 一套存下来的模型档案。
 *
 * `alias` 是自己起的名字（列表上显示的就是它），`model` 是接口真正认的
 * 那个字符串 —— 两个都要：只留模型名认不出谁是谁，只留别名发不出请求。
 */
export interface LlmModel {
    id: number;
    alias: string;
    model: string;
    baseUrl: string;
    /** 打码后的 key；明文永远不会下发 */
    keyHint: string;
    hasKey: boolean;
    active: boolean;
}

interface ModelsReply {
    models: LlmModel[];
    status: Omit<LlmConfigView, 'presets' | 'models'>;
}

export async function apiSpeakingStatus(): Promise<LlmConfigView> {
    return json(await fetch('/api/speaking/status'));
}

export function apiListLlmModels(): Promise<ModelsReply> {
    return fetch('/api/speaking/models').then(json<ModelsReply>);
}

export function apiCreateLlmModel(body: {
    alias: string; model: string; baseUrl: string; apiKey?: string;
}): Promise<ModelsReply> {
    return post('/api/speaking/models', body);
}

/** 不传 apiKey 就是「不动原来那把」—— 页面不回显明文，得允许只改别名 */
export function apiUpdateLlmModel(id: number, body: {
    alias?: string; model?: string; baseUrl?: string; apiKey?: string;
}): Promise<ModelsReply> {
    return patch(`/api/speaking/models/${id}`, body);
}

export async function apiDeleteLlmModel(id: number): Promise<ModelsReply> {
    return json(await fetch(`/api/speaking/models/${id}`, { method: 'DELETE' }));
}

export function apiActivateLlmModel(id: number): Promise<ModelsReply> {
    return post(`/api/speaking/models/${id}/activate`, {});
}

/**
 * 单独测一套模型的结果。
 *
 * 分档而不是只给 ok/fail：「key 不对」「被限流」「连不上」要分开说 ——
 * 三种情况你要做的事完全不一样。
 */
export interface LlmTestResult {
    status: 'ok' | 'auth' | 'ratelimited' | 'unconfigured' | 'reqerror' | 'error';
    http: number | null;
    sample: string | null;
    message: string;
}

/** 测某一套已存下来的，**不切换**当前在用的那个 */
export function apiTestLlmModel(id: number): Promise<LlmTestResult> {
    return post(`/api/speaking/models/${id}/test`, {});
}

/** 测一份还没存下来的配置（添加模型的弹窗里「先测再存」用） */
export function apiTestLlmConfig(body: {
    baseUrl: string; apiKey: string; model: string;
}): Promise<LlmTestResult> {
    return post('/api/speaking/models/test-config', body);
}

export function apiTestLlm(): Promise<{ ok: true; model: string; sample: string }> {
    return post('/api/speaking/config/test', {});
}

// ---------- 我的场景 ----------

export interface SavedScenario {
    id: number;
    label: string;
    scenario: string;
    updatedAt: string;
}

export async function apiListScenarios(): Promise<SavedScenario[]> {
    return (await json<{ scenarios: SavedScenario[] }>(
        await fetch('/api/speaking/scenarios'),
    )).scenarios;
}

/** 存的时候过一遍内容审核，没过会抛错 —— 之后每次开练就不用再审了 */
export function apiSaveScenario(
    body: { label: string; scenario: string },
): Promise<{ scenario: SavedScenario; scenarios: SavedScenario[] }> {
    return post('/api/speaking/scenarios', body);
}

export async function apiUpdateScenario(
    id: number,
    body: { label?: string; scenario?: string },
): Promise<SavedScenario[]> {
    return (await patch<{ scenarios: SavedScenario[] }>(`/api/speaking/scenarios/${id}`, body)).scenarios;
}

export async function apiDeleteScenario(id: number): Promise<SavedScenario[]> {
    return (await json<{ scenarios: SavedScenario[] }>(
        await fetch(`/api/speaking/scenarios/${id}`, { method: 'DELETE' }),
    )).scenarios;
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

export interface SpeakingTurnHandlers {
    /** 每来一片就回调一次，调用方据此逐句朗读 —— 等整段回完再念，每轮要白等好几秒 */
    onDelta(piece: string): void;
    /**
     * 服务端这一次没拿到内容、正在重来。
     *
     * 调用方必须把已经收到的半截**全部丢掉**（显示的文字 + 朗读队列）：
     * 上一次可能吐了几个空白字符出来，不清掉的话重试的正文会接在它后面。
     */
    onRetry?(attempt: number): void;
}

/**
 * 说一句，流式收 AI 的回复。
 *
 * 空回复不会直接变成错误 —— 服务端会自己重来（见 routes-speaking.ts），
 * 每重来一次这里就回调一次 onRetry。
 */
export async function apiSpeakingTurn(
    id: number,
    content: string,
    source: 'typed' | 'speech',
    handlers: SpeakingTurnHandlers,
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
                        delta?: string; retry?: number; done?: boolean;
                        turn?: SpeakingTurn; error?: string;
                    };
                    if (evt.delta) handlers.onDelta(evt.delta);
                    if (evt.retry) handlers.onRetry?.(evt.retry);
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

// ---------- 算法题库（OJ） ----------
//
// 出题和判题都是长任务：这两个接口只负责**发起**，立刻返回一个 id，
// 进度全部走 /api/oj/events 那条 SSE（见 lib/oj-stream.ts）。

export async function apiOjSettings(): Promise<{
    settings: OjSettings;
    llm: LlmConfigView;
    languages: OjLanguageInfo[];
}> {
    return json(await fetch('/api/oj/settings'));
}

export async function apiOjSaveSettings(p: Partial<OjSettings>): Promise<OjSettings> {
    return (await patch<{ settings: OjSettings }>('/api/oj/settings', p)).settings;
}

export function apiOjTestPython(): Promise<{ ok: boolean; message: string }> {
    return post('/api/oj/settings/test-python', {});
}

export async function apiOjProblems(q: OjProblemQuery = {}): Promise<{
    items: OjProblemListItem[]; total: number;
}> {
    const sp = new URLSearchParams();
    if (q.search) sp.set('search', q.search);
    if (q.tag) sp.set('tag', q.tag);
    if (q.favoriteOnly) sp.set('favoriteOnly', '1');
    if (q.page) sp.set('page', String(q.page));
    if (q.pageSize) sp.set('pageSize', String(q.pageSize));
    return json(await fetch(`/api/oj/problems?${sp.toString()}`));
}

export async function apiOjTags(): Promise<Array<{ tag: string; count: number }>> {
    return (await json<{ tags: Array<{ tag: string; count: number }> }>(
        await fetch('/api/oj/problems/tags'),
    )).tags;
}

export async function apiOjProblem(id: number): Promise<{ problem: OjProblem; samples: OjTestCase[] }> {
    return json(await fetch(`/api/oj/problems/${id}`));
}

export async function apiOjDeleteProblem(id: number): Promise<void> {
    await json<{ ok: true }>(await fetch(`/api/oj/problems/${id}`, { method: 'DELETE' }));
}

export async function apiOjToggleFavorite(id: number): Promise<boolean> {
    return (await post<{ favorite: boolean }>(`/api/oj/problems/${id}/favorite`, {})).favorite;
}

export async function apiOjTestcases(problemId: number): Promise<OjTestCaseMeta[]> {
    return (await json<{ cases: OjTestCaseMeta[] }>(
        await fetch(`/api/oj/problems/${problemId}/testcases`),
    )).cases;
}

export async function apiOjTestcase(id: number): Promise<OjTestCase> {
    return (await json<{ case: OjTestCase }>(await fetch(`/api/oj/testcases/${id}`))).case;
}

export function apiOjGenerate(p: OjGenerateParams): Promise<{ jobId: string }> {
    return post('/api/oj/generate', p);
}

export function apiOjCancelGenerate(jobId: string): Promise<{ cancelled: boolean }> {
    return post(`/api/oj/generate/${encodeURIComponent(jobId)}/cancel`, {});
}

export async function apiOjJobs(): Promise<OjGenJobSnapshot[]> {
    return (await json<{ jobs: OjGenJobSnapshot[] }>(await fetch('/api/oj/generate/jobs'))).jobs;
}

export function apiOjJudge(p: OjJudgeSubmitParams): Promise<{ submissionId: number }> {
    return post('/api/oj/judge', p);
}

export async function apiOjSubmissions(q: OjSubmissionQuery = {}): Promise<{
    items: OjSubmission[]; total: number;
}> {
    const sp = new URLSearchParams();
    if (q.problemId) sp.set('problemId', String(q.problemId));
    if (q.page) sp.set('page', String(q.page));
    if (q.pageSize) sp.set('pageSize', String(q.pageSize));
    return json(await fetch(`/api/oj/submissions?${sp.toString()}`));
}

export async function apiOjSubmission(id: number): Promise<OjSubmission> {
    return (await json<{ submission: OjSubmission }>(await fetch(`/api/oj/submissions/${id}`))).submission;
}
