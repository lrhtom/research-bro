// ============================================================
//  大模型档案：存好几套，点一下切换
//
//  一行 = 一套完整的连接方式（别名 + 模型名 + 地址 + key），不是只存一个
//  模型名 —— 换供应商时地址和 key 都得跟着换。
//
//  别名与模型名分开是这套东西的关键：
//    · alias 「便宜的那个」  —— 给人看的，列表上显示它
//    · model 「deepseek-chat」—— 给接口看的，发请求用它
//  只留模型名，列表就是一串认不出谁是谁的 id；只留别名，请求发不出去。
//
//  API key 只进不出：这里之外的任何地方都只拿得到打码后的样子。
// ============================================================

import { db, getSetting, nowIso, setSetting } from './db.js';

/** 当前选中的那一套，存 settings 里（值是 llm_models.id 的字符串） */
const K_ACTIVE = 'llm_active_model_id';

/** 旧版单套配置的三个键。留着做兜底与一次性迁移。 */
const K_BASE = 'llm_base_url';
const K_KEY = 'llm_api_key';
const K_MODEL = 'llm_model';

interface ModelRecord {
    id: number;
    alias: string;
    model: string;
    base_url: string;
    api_key: string;
    created_at: string;
    updated_at: string;
}

/** 对外的样子：**不含明文 key** */
export interface LlmModelView {
    id: number;
    alias: string;
    model: string;
    baseUrl: string;
    /** 打码后的 key，只够确认「填的是不是我以为的那把」 */
    keyHint: string;
    hasKey: boolean;
    active: boolean;
}

/** 内部用的完整配置，带明文 key —— 只在发请求时取 */
export interface LlmModelSecret {
    id: number;
    alias: string;
    model: string;
    baseUrl: string;
    apiKey: string;
}

function maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 10) return '•'.repeat(key.length);
    return `${key.slice(0, 4)}${'•'.repeat(6)}${key.slice(-4)}`;
}

/**
 * 把用户填的接口地址收拾成「可以往后面接 /chat/completions 的那一段」。
 *
 * 为什么要收拾：各家文档给的地址形态不一样 —— OpenAI 的文档写的是完整的
 * `https://api.openai.com/v1/chat/completions`，DeepSeek 写的是
 * `https://api.deepseek.com/v1`。人当然是**照着文档复制**的，
 * 而我们发请求时又要自己接一段 `/chat/completions`，于是照抄 OpenAI 文档
 * 的那一份就会拼成 `/v1/chat/completions/chat/completions`，
 * 换来一个看不懂的 404：
 *
 *     Invalid URL (POST /v1/chat/completions/chat/completions)
 *
 * 这种错完全没道理让用户自己去猜。两种写法都收下，结果一样。
 *
 * 顺带也吃掉末尾的斜杠和 `/completions`（有人只删一半）。
 */
export function normUrl(raw: string): string {
    let u = raw.trim();
    // 反复剥：/chat/completions/ 这种「带尾斜杠的完整路径」要两步才干净
    for (;;) {
        const before = u;
        u = u.replace(/\/+$/, '');
        u = u.replace(/\/chat\/completions$/i, '');
        u = u.replace(/\/completions$/i, '');
        if (u === before) return u;
    }
}

/**
 * 这个模型是不是 OpenAI 那一家的「推理模型」（gpt-5.x 和 o 系列）。
 *
 * 它们的请求体跟别的模型有两处不兼容，踩中任何一处都是 400：
 *   · `max_tokens` 不认，要写 `max_completion_tokens`
 *   · `temperature` 只接受默认值 1，给别的数直接报错
 *
 * 按**模型名**判而不是按地址判：同一个 api.openai.com 底下
 * gpt-4o-mini 和 gpt-5.6-sol 的规矩就不一样；而第三方中转站
 * （OpenRouter 之类）也会用 openai/gpt-5… 这样的名字转发同一批模型。
 */
function isReasoningModel(model: string): boolean {
    const m = model.toLowerCase();
    // 去掉供应商前缀：openrouter 那种 "openai/gpt-5.6-sol" 也要认出来
    const bare = m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m;
    return /^gpt-5/.test(bare) || /^o[1-9]($|[-.])/.test(bare);
}

/**
 * 按模型把请求体调整成它认识的样子。
 *
 * 目前只有一处分叉：OpenAI 的推理模型（gpt-5.x / o 系列）不认 max_tokens、
 * 也不让改 temperature。不适配的话它们**一个字都发不出去**，
 * 而报错是 400 加一句英文，看不出要改哪儿。
 *
 * 放在这个文件而不是 llm.ts：llm.ts 已经在 import 这里的 normUrl，
 * 反过来再 import 就成了循环依赖。这里是「关于模型本身的知识」，
 * 跟 normUrl 是一类东西，本来就该住在一起。
 */
export function shapeRequestBody(
    model: string,
    body: Record<string, unknown>,
): Record<string, unknown> {
    if (!isReasoningModel(model)) return body;

    const { max_tokens: maxTokens, temperature, ...rest } = body;
    void temperature;   // 整个丢掉：只接受默认值 1，显式传 1 也可能被挑刺
    return {
        ...rest,
        ...(maxTokens === undefined ? {} : { max_completion_tokens: maxTokens }),
    };
}

/**
 * 一次性迁移：把旧的单套配置搬进这张表。
 *
 * 只在**表是空的、且旧配置里确实有 key** 时做一次。
 * 环境变量里的 key 不搬 —— 那些人特意不想让 key 落库，搬进来是帮倒忙。
 * 旧的三个 settings 键不删，仍然作为兜底（见 activeModel）。
 */
function ensureMigrated(): void {
    const n = db().prepare('SELECT COUNT(*) AS c FROM llm_models').get() as { c: number };
    if (n.c > 0) return;

    const key = getSetting(K_KEY);
    if (!key) return;

    const created = createModel({
        alias: '原有配置',
        model: getSetting(K_MODEL) || 'deepseek-chat',
        baseUrl: getSetting(K_BASE) || 'https://api.deepseek.com/v1',
        apiKey: key,
    });
    setActive(created.id);
}

/**
 * 把库里那些还带着 /chat/completions 的地址就地收拾干净。
 *
 * normUrl 是后来才开始剥这一段的，在那之前存进去的地址原样躺着。
 * 发请求那一路已经在读的时候又收拾了一遍，所以功能上没问题 ——
 * 但**列表上显示的**还是没收拾的那一份，于是「页面显示的地址」和
 * 「实际请求的地址」对不上，排查问题时会把人带进沟里。
 *
 * 幂等：已经干净的行 WHERE 条件就命不中，反复跑无副作用。
 */
function normalizeStoredUrls(): void {
    const rows = db().prepare('SELECT id, base_url FROM llm_models').all() as
        Array<{ id: number; base_url: string }>;
    const stmt = db().prepare('UPDATE llm_models SET base_url = ? WHERE id = ?');
    for (const r of rows) {
        const clean = normUrl(r.base_url);
        if (clean !== r.base_url) stmt.run(clean, r.id);
    }
}

export function listModels(): LlmModelView[] {
    ensureMigrated();
    normalizeStoredUrls();
    const activeId = Number(getSetting(K_ACTIVE)) || 0;
    const rows = db().prepare('SELECT * FROM llm_models ORDER BY id ASC').all() as ModelRecord[];
    return rows.map((r) => ({
        id: r.id,
        alias: r.alias,
        model: r.model,
        baseUrl: r.base_url,
        keyHint: maskKey(r.api_key),
        hasKey: r.api_key !== '',
        active: r.id === activeId,
    }));
}

/**
 * 当前该用哪一套。返回 null 表示一套都没有，调用方去走旧的 settings / 环境变量兜底。
 *
 * 选中的那一套被删掉时不报错，自动退回列表里的第一套 ——
 * 「删掉一个没在用的模型，结果整个应用不能用了」是最没道理的坏法。
 */
export function activeModel(): LlmModelSecret | null {
    ensureMigrated();
    const id = Number(getSetting(K_ACTIVE)) || 0;
    const row = (id
        ? db().prepare('SELECT * FROM llm_models WHERE id = ?').get(id) as ModelRecord | undefined
        : undefined)
        ?? db().prepare('SELECT * FROM llm_models ORDER BY id ASC LIMIT 1').get() as ModelRecord | undefined;

    if (!row) return null;
    return {
        id: row.id,
        alias: row.alias,
        model: row.model,
        baseUrl: normUrl(row.base_url),
        apiKey: row.api_key,
    };
}

export function getModel(id: number): LlmModelView | null {
    return listModels().find((m) => m.id === id) ?? null;
}

export function createModel(input: {
    alias?: unknown; model?: unknown; baseUrl?: unknown; apiKey?: unknown;
}): LlmModelView {
    const model = String(input.model ?? '').trim().slice(0, 200);
    const baseUrl = normUrl(String(input.baseUrl ?? ''));
    if (!model) throw new LlmModelError('模型名不能为空 —— 那是接口真正认的那个字符串');
    if (!baseUrl) throw new LlmModelError('接口地址不能为空');
    if (!/^https?:\/\//i.test(baseUrl)) throw new LlmModelError('接口地址要以 http:// 或 https:// 开头');

    const now = nowIso();
    const info = db().prepare(
        `INSERT INTO llm_models (alias, model, base_url, api_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
        // 别名留空就拿模型名顶上，列表里不至于出现一行空白
        String(input.alias ?? '').trim().slice(0, 60) || model,
        model,
        baseUrl,
        String(input.apiKey ?? '').trim().slice(0, 400),
        now,
        now,
    );

    const id = Number(info.lastInsertRowid);
    // 头一套自动选中：刚填完就能用，不用再点一下「选用」
    if (!getSetting(K_ACTIVE)) setActive(id);
    return getModel(id)!;
}

/**
 * 改一套配置。只改传进来的字段。
 *
 * apiKey 传 undefined = 不动原来那把（页面上不回显明文，「只改别名不改 key」
 * 必须做得到）；传空串 = 明确清掉。
 */
export function updateModel(id: number, patch: {
    alias?: unknown; model?: unknown; baseUrl?: unknown; apiKey?: unknown;
}): LlmModelView | null {
    if (!getModel(id)) return null;

    const sets: string[] = [];
    const args: unknown[] = [];

    if ('alias' in patch) {
        sets.push('alias = ?');
        args.push(String(patch.alias ?? '').trim().slice(0, 60));
    }
    if ('model' in patch) {
        const m = String(patch.model ?? '').trim().slice(0, 200);
        if (!m) throw new LlmModelError('模型名不能为空');
        sets.push('model = ?'); args.push(m);
    }
    if ('baseUrl' in patch) {
        const u = normUrl(String(patch.baseUrl ?? ''));
        if (!/^https?:\/\//i.test(u)) throw new LlmModelError('接口地址要以 http:// 或 https:// 开头');
        sets.push('base_url = ?'); args.push(u);
    }
    if ('apiKey' in patch) {
        sets.push('api_key = ?');
        args.push(String(patch.apiKey ?? '').trim().slice(0, 400));
    }

    if (sets.length) {
        sets.push('updated_at = ?');
        args.push(nowIso());
        db().prepare(`UPDATE llm_models SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }

    // 别名被清空了就退回模型名，避免列表上出现一行没有名字的
    const row = db().prepare('SELECT alias, model FROM llm_models WHERE id = ?').get(id) as
        { alias: string; model: string };
    if (!row.alias) {
        db().prepare('UPDATE llm_models SET alias = ? WHERE id = ?').run(row.model, id);
    }
    return getModel(id);
}

export function deleteModel(id: number): boolean {
    const ok = db().prepare('DELETE FROM llm_models WHERE id = ?').run(id).changes > 0;
    // 删掉的正好是当前选中的那一套：把选中标记也清掉，
    // activeModel() 会自动退到列表里的第一套
    if (ok && Number(getSetting(K_ACTIVE)) === id) setSetting(K_ACTIVE, '');
    return ok;
}

export function setActive(id: number): boolean {
    const exists = db().prepare('SELECT 1 FROM llm_models WHERE id = ?').get(id);
    if (!exists) return false;
    setSetting(K_ACTIVE, String(id));
    return true;
}

export class LlmModelError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

/**
 * 按 id 取出这一套的完整配置（含明文 key）。
 *
 * 只给「单独测这一套」用 —— 别的地方一律走 activeModel()。
 * 明文 key 绝不出这个模块之外，测完就丢。
 */
export function modelSecret(id: number): LlmModelSecret | null {
    const row = db().prepare('SELECT * FROM llm_models WHERE id = ?').get(id) as ModelRecord | undefined;
    if (!row) return null;
    return {
        id: row.id,
        alias: row.alias,
        model: row.model,
        baseUrl: normUrl(row.base_url),
        apiKey: row.api_key,
    };
}

/** 单独测一套模型的结果。分档而不是只给 ok/fail —— 「key 不对」和「连不上」要分开说。 */
export type ModelTestStatus = 'ok' | 'auth' | 'ratelimited' | 'unconfigured' | 'reqerror' | 'error';

export interface ModelTestResult {
    status: ModelTestStatus;
    /** HTTP 状态码，没走到那一步就是 null */
    http: number | null;
    /** 模型实际回了什么（截断），status=ok 时才有 */
    sample: string | null;
    /** 出错时给人看的一句话 */
    message: string;
}

/**
 * 用一套指定的配置打一次最小调用，**不切换当前使用的模型**。
 *
 * 为什么要能单独测：列表里存着好几套，想知道「哪一套还能用」不该逼你
 * 先切过去、测完再切回来 —— 切换本身是有副作用的（口语练习和 AI 助手
 * 立刻就跟着换了）。
 *
 * 永不抛异常：测试失败是一条**结果**，不是接口错误。
 */
export async function testModelConfig(cfg: {
    baseUrl: string; apiKey: string; model: string;
}): Promise<ModelTestResult> {
    const baseUrl = normUrl(cfg.baseUrl);
    if (!baseUrl || !cfg.apiKey) {
        return { status: 'unconfigured', http: null, sample: null, message: '接口地址或 API Key 是空的' };
    }

    // 单独给一个短超时：测连通性没必要等满 30 秒，
    // 一个连不上的地址应该很快告诉你，而不是让你对着转圈的按钮猜
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);

    try {
        // 走跟真实调用同一条整形逻辑：不然测试用 max_tokens 通过了、
        // 真发消息时用 max_completion_tokens 才炸，那这个「测试」就是骗人的
        const body = shapeRequestBody(cfg.model, {
            model: cfg.model,
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
            // 推理模型会把一部分额度花在内部思考上，16 个 token 可能全被吃掉、
            // 正文一个字都不剩，于是「连通了」却显示回了空 —— 给宽一点
            max_tokens: 256,
            temperature: 0,
            stream: false,
        });

        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify(body),
            signal: ac.signal,
        });

        if (!res.ok) {
            const body = (await res.text().catch(() => '')).slice(0, 200);
            if (res.status === 401 || res.status === 403) {
                return { status: 'auth', http: res.status, sample: null, message: `API Key 不对或没有权限（${res.status}）` };
            }
            if (res.status === 429) {
                return { status: 'ratelimited', http: res.status, sample: null, message: '被限流了，过一会儿再试' };
            }
            return {
                status: 'reqerror',
                http: res.status,
                sample: null,
                message: `接口返回 ${res.status}${body ? `：${body}` : ''}`,
            };
        }

        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        const text = data.choices?.[0]?.message?.content;
        if (typeof text !== 'string') {
            return { status: 'error', http: res.status, sample: null, message: '连上了，但返回的结构里没有 choices[0].message.content' };
        }
        // 连上了、也真回了东西 —— 哪怕正文是空的（推理模型把额度花在思考上），
        // 那也是「这套配置能用」，不该报成失败
        const sample = text.trim().slice(0, 60);
        return {
            status: 'ok',
            http: res.status,
            sample: sample || null,
            message: sample ? '连通了' : '连通了（这一次它没吐正文，多半是推理模型把额度用在思考上了）',
        };
    } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
            status: aborted ? 'reqerror' : 'error',
            http: null,
            sample: null,
            message: aborted ? '20 秒还没连上，超时了' : `连不上：${e instanceof Error ? e.message : String(e)}`,
        };
    } finally {
        clearTimeout(timer);
    }
}

/** 测已经存下来的那一套 */
export async function testStoredModel(id: number): Promise<ModelTestResult> {
    const m = modelSecret(id);
    if (!m) return { status: 'error', http: null, sample: null, message: '这套配置不存在' };
    return testModelConfig({ baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model });
}
