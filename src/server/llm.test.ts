// ============================================================
//  大模型客户端：空回复重试
//
//  这一份只测 chatNonEmpty 那条路。真正要钉死的是三件事：
//    1. 模型返回空内容 → 自己再来一次，用户看不到失败
//    2. 重试有上限，不会对着一个坏掉的上游一直撞
//    3. 该放弃的时候放弃：客户端断开、以及「根本没配 key」这种
//       重试一百次也不会变的错
// ============================================================

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initSchema, useDatabase } from './db.js';
import { chatNonEmpty, shouldRetryLlm, LlmError, LLM_ATTEMPTS } from './llm.js';

/** 造一个 /chat/completions 的成功响应 */
function reply(content: string): Response {
    return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

const realFetch = globalThis.fetch;

beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    useDatabase(db);
    // requireConfig 认这个；不配的话每次调用都会先被 503 挡下来
    process.env.LLM_API_KEY = 'test-key';
});

afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.LLM_API_KEY;
    vi.restoreAllMocks();
});

describe('chatNonEmpty：空回复自己重试', () => {
    it('第一次空、第二次有内容 —— 调用方只看到那份内容', async () => {
        const bodies = ['', '   ', 'Right, so the deposit is £500.'];
        let calls = 0;
        globalThis.fetch = vi.fn(async () => reply(bodies[calls++] ?? '')) as typeof fetch;

        const text = await chatNonEmpty([{ role: 'user', content: 'hi' }]);

        expect(text).toBe('Right, so the deposit is £500.');
        // 前两次空的都被自己吞掉了，用户那边一次错都没看见
        expect(calls).toBe(3);
    });

    it('只有空白字符也算空 —— 不能把一串空格当成回答交出去', async () => {
        let calls = 0;
        globalThis.fetch = vi.fn(async () => reply(calls++ === 0 ? '\n\n  \t ' : 'ok')) as typeof fetch;

        expect(await chatNonEmpty([{ role: 'user', content: 'hi' }])).toBe('ok');
        expect(calls).toBe(2);
    });

    it('一直空 —— 撞满上限就抛错，不会无限重试', async () => {
        let calls = 0;
        globalThis.fetch = vi.fn(async () => { calls += 1; return reply(''); }) as typeof fetch;

        await expect(chatNonEmpty([{ role: 'user', content: 'hi' }])).rejects.toThrow(LlmError);
        expect(calls).toBe(LLM_ATTEMPTS);
    });

    it('attempts 可以自己压低 —— 报告那种贵的调用不该按默认次数烧', async () => {
        let calls = 0;
        globalThis.fetch = vi.fn(async () => { calls += 1; return reply(''); }) as typeof fetch;

        await expect(chatNonEmpty([{ role: 'user', content: 'hi' }], {}, 2)).rejects.toThrow();
        expect(calls).toBe(2);
    });

    it('上游 500 也重试 —— 抖一下而已，下一次多半就好了', async () => {
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
            calls += 1;
            return calls === 1 ? new Response('upstream boom', { status: 500 }) : reply('fine');
        }) as typeof fetch;

        expect(await chatNonEmpty([{ role: 'user', content: 'hi' }])).toBe('fine');
        expect(calls).toBe(2);
    });

    it('没配 key 直接抛，一次都不重试 —— 重试解决不了配置问题', async () => {
        delete process.env.LLM_API_KEY;
        let calls = 0;
        globalThis.fetch = vi.fn(async () => { calls += 1; return reply('never'); }) as typeof fetch;

        await expect(chatNonEmpty([{ role: 'user', content: 'hi' }])).rejects.toThrow(/还没有配置大模型/);
        expect(calls).toBe(0);
    });

    it('客户端断开就停手，不再补刀', async () => {
        const ac = new AbortController();
        let calls = 0;
        globalThis.fetch = vi.fn(async () => {
            calls += 1;
            ac.abort();
            return reply('');
        }) as typeof fetch;

        await expect(
            chatNonEmpty([{ role: 'user', content: 'hi' }], { signal: ac.signal }),
        ).rejects.toThrow();
        expect(calls).toBe(1);
    });
});

describe('shouldRetryLlm：什么错值得再来一次', () => {
    it('普通上游错误值得', () => {
        expect(shouldRetryLlm(new LlmError('大模型接口返回 502', 502))).toBe(true);
        expect(shouldRetryLlm(new Error('socket hang up'))).toBe(true);
    });

    it('没配置（503）不值得 —— 换十次也是同一个结果', () => {
        expect(shouldRetryLlm(new LlmError('还没有配置大模型', 503))).toBe(false);
    });

    it('已经取消的不值得', () => {
        const ac = new AbortController();
        ac.abort();
        expect(shouldRetryLlm(new Error('boom'), ac.signal)).toBe(false);

        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        expect(shouldRetryLlm(abortErr)).toBe(false);
    });
});
