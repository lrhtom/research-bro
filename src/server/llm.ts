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

/** settings 表优先，环境变量兜底 */
function readConfig(): LlmConfig {
    return {
        baseUrl: (getSetting(K_BASE) || process.env.LLM_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
        apiKey: getSetting(K_KEY) || process.env.LLM_API_KEY || '',
        model: getSetting(K_MODEL) || process.env.LLM_MODEL || DEFAULT_MODEL,
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
}

export function llmStatus(): LlmPublicConfig {
    const c = readConfig();
    return {
        configured: c.apiKey !== '',
        baseUrl: c.baseUrl,
        model: c.model,
        keyHint: maskKey(c.apiKey),
        fromEnv: !getSetting(K_KEY) && !!process.env.LLM_API_KEY,
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
        const url = patch.baseUrl.trim().replace(/\/+$/, '');
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
            '还没有配置大模型：在「英语口语练习」页面顶部的「大模型配置」里填上接口地址、API Key 和模型名即可。',
            503,
        );
    }
    return c;
}

/**
 * 用当前配置打一次最小的调用，验证能不能通。
 * 返回模型实际回的那点字，便于确认「连上的确实是我想要的那个模型」。
 */
export async function testLlmConnection(): Promise<{ ok: true; model: string; sample: string }> {
    const c = readConfig();
    const sample = await chat(
        [{ role: 'user', content: 'Reply with exactly: OK' }],
        { temperature: 0, maxTokens: 16 },
    );
    return { ok: true, model: c.model, sample: sample.slice(0, 80) };
}

async function post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const c = requireConfig();
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${c.apiKey}`,
        },
        body: JSON.stringify({ model: c.model, ...(body as object) }),
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
