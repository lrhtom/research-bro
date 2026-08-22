// ============================================================
//  OJ · 进度流（浏览器这一侧）
//
//  服务端把出题与判题的进度推在一条 SSE 上（GET /api/oj/events）。
//  这里做两件事：
//
//    1. **全站只开一条连接**，不管几个组件在听。
//       每个组件各开一条的话，一个页面上光「题目详情 + 判题面板 +
//       生成进度」就是三条长连接，服务端要广播三份，浏览器还有
//       每域名 6 条的并发上限 —— 开着开着页面里别的请求就发不出去了。
//    2. 最后一个订阅者走掉就把连接关掉，别让一条没人听的流一直占着。
//
//  EventSource 自带断线重连，所以这里不用自己写重连逻辑。
//  也正因为它会自动重连，才更要在没人听的时候主动 close() ——
//  否则关掉的标签页背后还挂着一条会自己复活的连接。
// ============================================================

import type { OjEvent, OjGenProgressEvent, OjJudgeProgressEvent } from '../../shared/oj';

type Handler = (e: OjEvent) => void;

const handlers = new Set<Handler>();
let source: EventSource | null = null;

function ensureOpen(): void {
    if (source) return;

    const es = new EventSource('/api/oj/events');
    es.onmessage = (ev) => {
        let parsed: OjEvent;
        try {
            parsed = JSON.parse(ev.data) as OjEvent;
        } catch {
            return;   // 半截帧，丢掉；下一帧完整的会补上
        }
        // 复制一份再遍历：处理函数里退订是常事（比如判题 done 之后就不听了），
        // 直接遍历原集合会在迭代中改结构
        for (const h of [...handlers]) {
            try {
                h(parsed);
            } catch (err) {
                // 一个订阅者出错不能连累别的
                console.error('[oj] 进度处理函数出错', err);
            }
        }
    };
    es.onerror = () => {
        // 不做任何事：EventSource 自己会重连。
        // 这里如果 close() 掉，反而把它唯一的自愈能力关掉了。
    };
    source = es;
}

function closeIfIdle(): void {
    if (handlers.size === 0 && source) {
        source.close();
        source = null;
    }
}

/** 订阅全部 OJ 事件。返回退订函数。 */
export function subscribeOj(handler: Handler): () => void {
    handlers.add(handler);
    ensureOpen();
    return () => {
        handlers.delete(handler);
        closeIfIdle();
    };
}

/** 只听出题事件的便捷版 */
export function subscribeOjGen(handler: (e: OjGenProgressEvent) => void): () => void {
    return subscribeOj((e) => { if (e.kind === 'gen') handler(e.event); });
}

/** 只听判题事件的便捷版 */
export function subscribeOjJudge(handler: (e: OjJudgeProgressEvent) => void): () => void {
    return subscribeOj((e) => { if (e.kind === 'judge') handler(e.event); });
}
