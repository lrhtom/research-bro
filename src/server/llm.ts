// ============================================================
//  大模型客户端
//
//  只走 OpenAI 兼容的 /chat/completions —— DeepSeek、OpenAI、OpenRouter、
//  硅基流动、通义、本地 Ollama 全都是这一套，换供应商只改配置，不改代码。
//
//  配置从两处读，**settings 表优先，环境变量兜底**：
//    · settings 表：在「英语口语练习」页面上直接填，存本机 SQLite，
//      改完即时生效，不用重启服务（这是单机单人应用，本来就没有多租户）
//    · 环境变量：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，
//      适合不想把 key 写进库文件、或者用 Docker 注入的场景
//
//  API key 只进不出：读配置的接口永远只返回一个打码提示（sk-…a1b2）和
//  「有没有配」这个布尔值，明文那一份除了发给模型之外不离开服务端。
//
//  这里只做文本。**没有语音接口，也永远不要加** ——
//  口语练习的输入是浏览器语音识别猜出来的文字，模型从头到尾没听过任何声音。
// ============================================================

import { getSetting, setSetting } from './db.js';
import { activeModel, normUrl, shapeRequestBody } from './llm-models.js';

const DEFAULT_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

/** settings 表里的键名 */
const K_BASE = 'llm_base_url';
const K_KEY = 'llm_api_key';
const K_MODEL = 'llm_model';

/** 常见供应商的现成配置，前端拿去做「一键填好」 */
export const LLM_PRESETS = [
    { key: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { key: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { key: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
    { key: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    { key: 'dashscope', label: '阿里通义', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { key: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { key: 'ollama', label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
] as const;

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export class LlmError extends Error {
    constructor(message: string, readonly status = 502) {
        super(message);
    }
}

interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/**
 * 按 **模型档案 → 旧的单套 settings → 环境变量** 的顺序取当前配置。
 *
 * 档案表（llm_models）是现在的主路：存好几套、点一下切换。
 * 后两级留着不是历史包袱，各有各的用处：
 *   · 旧 settings —— 老库升上来时还没建过档案，第一次读会被自动迁移过去
 *   · 环境变量  —— 有人特意不想让 key 落库（Docker 注入那种），一套都不建
 */
function readConfig(): LlmConfig {
    const m = activeModel();
    if (m && m.apiKey) {
        // 再收拾一次而不是信库里那一份：老库里可能存着带 /chat/completions 的地址
        // （normUrl 是后来才开始剥它的），环境变量那一路也从没经过 createModel
        return { baseUrl: normUrl(m.baseUrl), apiKey: m.apiKey, model: m.model };
    }
    return {
        baseUrl: normUrl(m?.baseUrl || getSetting(K_BASE) || process.env.LLM_BASE_URL || DEFAULT_BASE),
        apiKey: getSetting(K_KEY) || process.env.LLM_API_KEY || '',
        model: m?.model || getSetting(K_MODEL) || process.env.LLM_MODEL || DEFAULT_MODEL,
    };
}

/** 有没有配好。没配好时前端要给一句人话，而不是让每个按钮都 502。 */
export function llmConfigured(): boolean {
    return readConfig().apiKey !== '';
}

/**
 * 打码：只留头尾各 4 个字符。
 *
 * 页面上要能看出「填的是不是我以为的那把 key」，但完整的 key 绝不回传 ——
 * 它一旦出现在响应体里，就会躺在浏览器缓存、开发者工具和任何抓包工具里。
 */
function maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 10) return '•'.repeat(key.length);
    return `${key.slice(0, 4)}${'•'.repeat(6)}${key.slice(-4)}`;
}

export interface LlmPublicConfig {
    configured: boolean;
    baseUrl: string;
    model: string;
    /** 打码后的 key，仅用于确认「填的是哪一把」；明文永不下发 */
    keyHint: string;
    /** true = key 来自环境变量而不是页面上填的，页面要提示改不动 */
    fromEnv: boolean;
    /** 当前这套档案的别名与 id。走环境变量兜底时没有档案，两个都是空。 */
    alias?: string;
    activeId?: number;
}

export function llmStatus(): LlmPublicConfig {
    const c = readConfig();
    const m = activeModel();
    const usingProfile = !!m && !!m.apiKey;
    return {
        configured: c.apiKey !== '',
        baseUrl: c.baseUrl,
        model: c.model,
        keyHint: maskKey(c.apiKey),
        // 档案里自带 key 时就不是环境变量那一路了，别再提示「页面上改不动」
        fromEnv: !usingProfile && !getSetting(K_KEY) && !!process.env.LLM_API_KEY,
        ...(usingProfile ? { alias: m.alias, activeId: m.id } : {}),
    };
}

/**
 * 保存配置。
 *
 * apiKey 传 undefined = 不动原来那把（页面上不回显明文，所以「不改 key
 * 只改模型」必须是可能的）；传空串 = 明确要清掉。
 */
export function saveLlmConfig(patch: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
}): LlmPublicConfig {
    if (patch.baseUrl !== undefined) {
        // 跟档案那一路走同一个收拾函数：照着 OpenAI 文档粘一整条
        // /v1/chat/completions 进来也认（见 llm-models.ts 的 normUrl）
        const url = normUrl(patch.baseUrl);
        if (url && !/^https?:\/\//i.test(url)) {
            throw new LlmError('接口地址要以 http:// 或 https:// 开头', 400);
        }
        setSetting(K_BASE, url);
    }
    if (patch.model !== undefined) setSetting(K_MODEL, patch.model.trim().slice(0, 200));
    if (patch.apiKey !== undefined) setSetting(K_KEY, patch.apiKey.trim().slice(0, 400));
    return llmStatus();
}

function requireConfig(): LlmConfig {
    const c = readConfig();
    if (!c.apiKey) {
        throw new LlmError(
            '还没有配置大模型：去「个人中心 → AI 配置」加一套（接口地址 + API Key + 模型名）就能用了，全站共用同一套。',
            503,
        );
    }
    return c;
}

/**
 * 用当前配置打一次最小调用，验证能不能通。
 * 返回模型实际回的那点字，便于确认「连上的确实是我想要的那个模型」。
 */
export async function testLlmConnection(): Promise<{ ok: true; model: string; sample: string }> {
    const c = readConfig();
    // 给得比「回一个 OK」需要的宽：推理模型（gpt-5.x / o 系列）会先花掉
    // 一部分额度在内部思考上，额度卡太死会连通了却一个字都不吐
    const sample = await chat(
        [{ role: 'user', content: 'Reply with exactly: OK' }],
        { temperature: 0, maxTokens: 256 },
    );
    return { ok: true, model: c.model, sample: sample.slice(0, 80) };
}

async function post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const c = requireConfig();
    const payload = shapeRequestBody(c.model, { model: c.model, ...(body as object) });

    const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmError(
            `大模型接口返回 ${res.status}${text ? `：${text.slice(0, 300)}` : ''}`,
            res.status === 401 || res.status === 403 ? 503 : 502,
        );
    }
    return res;
}

/** 一次要完整回答。用于审核、开场白、随机场景、总结报告。 */
export async function chat(
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
    const res = await post({
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2000,
        stream: false,
    }, opts.signal);

    const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new LlmError('大模型返回的结构不对，没有 choices[0].message.content');
    return text.trim();
}

/**
 * 空回复算失败，重试。
 *
 * 模型偶尔会返回一个内容为空的 choice —— 温度高、被安全策略截断、
 * 上游负载抖动都会这样，下一次同样的请求往往就好了。
 * 以前这种情况直接把「AI 没有返回内容」摔到用户脸上，
 * 但用户什么都没做错，能自己重试的事不该让他重来一遍。
 *
 * 不重试的两种情况见 shouldRetryLlm：配置错（重试多少次都一样）
 * 和客户端主动取消（人已经走了）。
 */
export async function chatNonEmpty(
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
    attempts = LLM_ATTEMPTS,
): Promise<string> {
    let lastError: unknown = null;

    for (let i = 1; i <= attempts; i += 1) {
        // 每一轮开头都要重新看一眼有没有被取消。
        //
        // 光在 catch 里看是不够的：取消可能发生在两次尝试之间的等待里
        // （sleepBeforeRetry 一被 abort 就提前返回），那一路没有任何异常抛出，
        // 不在这里拦一下就会对着一个已经没人听的请求继续补刀。
        if (opts.signal?.aborted) throw new LlmError('请求已取消', 499);

        try {
            const text = (await chat(messages, opts)).trim();
            if (text) return text;
            lastError = new LlmError('大模型返回了空内容');
        } catch (e) {
            if (!shouldRetryLlm(e, opts.signal)) throw e;
            lastError = e;
        }
        if (i < attempts) await sleepBeforeRetry(i, opts.signal);
    }

    throw lastError instanceof LlmError
        ? lastError
        : new LlmError(`大模型连续 ${attempts} 次没有返回有效内容，稍后再试或换一个模型`);
}

/** 默认重试次数（含第一次）。再多就是在硬撑一个坏掉的上游，白等还烧钱。 */
export const LLM_ATTEMPTS = 3;

/**
 * 这个错误值不值得重试。
 *
 * 不值得的两类：
 *   · 客户端已经断开 —— 人都走了，重试是给空气说话
 *   · 503（没配 key / 配错了）—— 换十次也是同一个结果，直接让用户去改配置
 */
export function shouldRetryLlm(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return false;
    if (error instanceof Error && error.name === 'AbortError') return false;
    if (error instanceof LlmError && error.status === 503) return false;
    return true;
}

/** 退避一下再重来。抖动的上游隔几百毫秒往往就恢复了，贴着重试只会连着撞。 */
export async function sleepBeforeRetry(attempt: number, signal?: AbortSignal): Promise<void> {
    const ms = Math.min(400 * attempt, 1200);
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}

/**
 * 流式回答，逐段吐出文本增量。
 *
 * 对话轮必须流式：客户端拿到第一句就能开始朗读，
 * 等整段回完再念，一次来回要多等好几秒，实时对话就散了。
 */
export async function* chatStream(
    messages: ChatMessage[],
    opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): AsyncGenerator<string> {
    const res = await post({
        messages,
        temperature: opts.temperature ?? 0.75,
        max_tokens: opts.maxTokens ?? 800,
        stream: true,
    }, opts.signal);

    if (!res.body) throw new LlmError('大模型没有返回流式响应体');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE 以空行分隔事件；最后一段可能不完整，留在 buffer 里等下一批
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';

            for (const part of parts) {
                for (const line of part.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        const json = JSON.parse(payload) as {
                            choices?: Array<{ delta?: { content?: string } }>;
                        };
                        const piece = json.choices?.[0]?.delta?.content;
                        if (piece) yield piece;
                    } catch {
                        // 半个 JSON，跳过；下一轮完整的那条会补上
                    }
                }
            }
        }
    } finally {
        reader.cancel().catch(() => { /* 客户端断开是常态，不用管 */ });
    }
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 模型经常会在 JSON 外面裹一层 ```json 围栏或者加一句客套话，
 * 所以先扒围栏，再退化成「取第一个 { 到最后一个 }」。
 */
export function extractJson<T>(text: string): T | null {
    const fenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    const candidates = [fenced.trim()];

    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(fenced.slice(start, end + 1));

    for (const c of candidates) {
        try {
            return JSON.parse(c) as T;
        } catch {
            // 试下一种
        }
    }
    return null;
}
