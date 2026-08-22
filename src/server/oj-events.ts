// ============================================================
//  OJ · 进度广播
//
//  出题和判题都是「发起之后跑很久，中间要不断报进度」的活儿。
//  原来在 Electron 里这是 webContents.send 一句话的事；搬到 HTTP 上之后
//  换成一条长连的 SSE：前端开着 GET /api/oj/events 不关，
//  服务端往里写事件。
//
//  为什么不用轮询：出题一跑就是几分钟，逐个计划的状态一秒能变好几次，
//  轮询要么慢半拍要么把接口打烂。也没必要上 WebSocket ——
//  这里的数据是**单向**的（服务端→浏览器），SSE 正好，
//  而且浏览器自带断线重连。
//
//  为什么是一条共用的流、而不是每个任务一条：同时开着的任务本来就没几个，
//  前端还要在「题库」页看到别处正在生成的题。一条流全站共用，
//  谁关心哪条自己按 jobId / submissionId 过滤。
// ============================================================

import type { Response } from 'express';
import type { OjEvent, OjGenProgressEvent, OjJudgeProgressEvent } from '../shared/oj.js';

/** 还连着的订阅者 */
const clients = new Set<Response>();

/**
 * 心跳间隔。
 *
 * 一条几分钟不说话的连接，会被中间的代理（以及某些浏览器的空闲回收）
 * 悄悄掐掉，而掐掉这件事两头都没有通知 —— 表现是"进度条走到一半不动了，
 * 刷新一下又好了"。每 25 秒发一个 SSE 注释帧把管子撑着。
 */
const HEARTBEAT_MS = 25_000;

let heartbeat: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
        for (const res of clients) {
            // 冒号开头是 SSE 的注释帧，客户端会忽略它，只用来保活
            try { res.write(': ping\n\n'); } catch { drop(res); }
        }
    }, HEARTBEAT_MS);
    // 这个定时器不该拦着进程退出
    heartbeat.unref?.();
}

function stopHeartbeatIfIdle(): void {
    if (clients.size === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
    }
}

function drop(res: Response): void {
    clients.delete(res);
    stopHeartbeatIfIdle();
}

/** 接一个新的订阅者。返回退订函数，路由在连接关闭时调它。 */
export function addOjClient(res: Response): () => void {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx 之类的反代默认会缓冲响应，缓冲之后 SSE 就不"流"了
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // 先推一帧，让前端的 onopen 有确定的落点：
    // 光靠 flushHeaders 在某些代理下要等第一个数据帧才真的把头发出去
    res.write(': connected\n\n');

    clients.add(res);
    startHeartbeat();

    return () => drop(res);
}

/**
 * 广播一条事件给所有订阅者。
 *
 * 写失败（对端已经走了但 close 还没冒出来）就把它摘掉，绝不抛出去 ——
 * 调用方是出题/判题的主流程，广播失败不该影响正在跑的任务。
 */
export function broadcastOj(event: OjEvent): void {
    if (clients.size === 0) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
        try {
            res.write(frame);
        } catch {
            drop(res);
        }
    }
}

export function emitGenEvent(event: OjGenProgressEvent): void {
    broadcastOj({ kind: 'gen', event });
}

export function emitJudgeEvent(event: OjJudgeProgressEvent): void {
    broadcastOj({ kind: 'judge', event });
}
