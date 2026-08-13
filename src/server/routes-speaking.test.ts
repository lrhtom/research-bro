// ============================================================
//  口语对话接口：AI 空回复时自己重试
//
//  这一份走真正的 HTTP + SSE，不是直接调函数 —— 要钉死的是**协议**：
//  重试时服务端必须先发一条 retry 事件，客户端据此把上一次吐出来的
//  半截清掉。少了那条事件，重试的正文会接在上一次的空白后面，
//  逐句朗读还会把那半截当成一句念出去。
// ============================================================

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 每次调 chatStream 吐什么；一个元素一次调用。空串 = 这一次什么都不吐。 */
let streamScript: string[] = [];
let streamCalls = 0;

vi.mock('./llm.js', async () => {
    const actual = await vi.importActual<typeof import('./llm.js')>('./llm.js');
    return {
        ...actual,
        llmConfigured: () => true,
        llmStatus: () => ({ configured: true, model: 'fake', baseUrl: 'fake', keyHint: '', fromEnv: false }),
        chat: async () => 'unused',
        chatNonEmpty: async () => 'Hello there, how can I help?',
        // 测试里不要真的退避，否则每个用例白等一秒多
        sleepBeforeRetry: async () => {},
        // eslint-disable-next-line require-yield
        chatStream: async function* () {
            const body = streamScript[streamCalls] ?? '';
            streamCalls += 1;
            for (const piece of body.match(/.{1,8}/g) ?? []) yield piece;
        },
    };
});

import { initSchema, useDatabase } from './db.js';
import { createApp } from './index.js';
import { createSession } from './speaking.js';

let server: Server;
let base = '';

beforeEach(async () => {
    const db = new Database(':memory:');
    initSchema(db);
    useDatabase(db);
    streamScript = [];
    streamCalls = 0;

    server = createApp().listen(0);
    await new Promise<void>((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    await new Promise<void>((r) => { server.close(() => r()); });
});

function newSession(): number {
    return createSession({
        scenario: 'You are a letting agent showing a flat.',
        label: '看房',
        preset: '',
        modifiers: {},
        targetWords: 'deposit',
    }).id;
}

/** 收完整条 SSE 流，把每个事件解析出来 */
async function readTurn(id: number, said: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${base}/api/speaking/sessions/${id}/turn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: said, source: 'typed' }),
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    return text
        .split('\n\n')
        .map((block) => block.split('\n').find((l) => l.startsWith('data:')))
        .filter((l): l is string => Boolean(l))
        .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>);
}

describe('一轮对话：AI 没出声就自己重来', () => {
    it('第一次空 → 发一条 retry，第二次的内容照常落库', async () => {
        streamScript = ['', 'The deposit is five hundred pounds.'];
        const id = newSession();

        const events = await readTurn(id, 'How much is the deposit?');

        // 客户端能看到「正在重来」，而不是一句冷冰冰的错误
        expect(events.filter((e) => e.retry !== undefined)).toEqual([{ retry: 1 }]);

        const deltas = events.filter((e) => e.delta).map((e) => e.delta).join('');
        expect(deltas).toBe('The deposit is five hundred pounds.');

        const done = events.find((e) => e.done) as { turn?: { content: string }; error?: string };
        expect(done.error).toBeUndefined();
        expect(done.turn?.content).toBe('The deposit is five hundred pounds.');
        expect(streamCalls).toBe(2);
    });

    it('只吐空白也算没出声 —— 一样重来，而且 retry 事件在正文之前', async () => {
        streamScript = ['   \n ', 'Right, follow me.'];
        const id = newSession();

        const events = await readTurn(id, 'Shall we go up?');

        const retryAt = events.findIndex((e) => e.retry !== undefined);
        const firstRealDelta = events.findIndex((e) => String(e.delta ?? '').trim() !== '');
        expect(retryAt).toBeGreaterThanOrEqual(0);
        // 顺序不能反：客户端先清屏，正文才能干净地重新流进去
        expect(retryAt).toBeLessThan(firstRealDelta);
    });

    it('连着三次都空 —— 停手报错，不无限重试，也不存空回合', async () => {
        streamScript = ['', '', ''];
        const id = newSession();

        const events = await readTurn(id, 'Hello?');
        const done = events.find((e) => e.done) as { error?: string; turn?: unknown };

        expect(done.error).toMatch(/没出声/);
        expect(done.turn).toBeUndefined();
        expect(streamCalls).toBe(3);

        // 学习者那句要留着（他确实说了），AI 那句不能凭空造一条空的出来
        const { listTurns } = await import('./speaking.js');
        const turns = listTurns(id);
        expect(turns.map((t) => t.role)).toEqual(['user']);
    });

    it('第一次就有内容时一次都不重试', async () => {
        streamScript = ['All good.'];
        const id = newSession();

        const events = await readTurn(id, 'Anything else?');

        expect(events.some((e) => e.retry !== undefined)).toBe(false);
        expect(streamCalls).toBe(1);
    });
});
