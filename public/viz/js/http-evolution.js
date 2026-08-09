// ============================================================
//  演示：HTTP/1.0 → 1.1 → 2 → 3 的队头阻塞
//  五条时间轴跑同一批资源，把「多路复用」四个字画出来。
//  模型只算时延（RTT + 服务端处理），不模拟带宽争抢 —— 小资源场景下时延就是瓶颈。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const HE = {};

HE.PROTOCOLS = [
    { id: 'h10', name: 'HTTP/1.0', sub: '每个请求都要重新握手', color: '#ef4444' },
    { id: 'h11', name: 'HTTP/1.1 Keep-Alive', sub: '连接复用 + 6 条并行连接', color: '#f59e0b' },
    { id: 'pipe', name: 'HTTP/1.1 Pipelining', sub: '一次发完，但响应必须按序回', color: '#a855f7' },
    { id: 'h2', name: 'HTTP/2', sub: '单连接多路复用', color: '#3b82f6' },
    { id: 'h3', name: 'HTTP/3 (QUIC)', sub: '流之间彼此独立', color: '#10b981' },
];

/**
 * opt = { n, rtt, serverMs, slowIdx, slowFactor, conns, loss }
 * 返回 { [protoId]: { bars:[{i,start,end,stalled}], total } }
 */
HE.simulate = function (opt) {
    const n = opt.n, rtt = opt.rtt, conns = opt.conns;
    const cost = [];
    for (let i = 0; i < n; i++) {
        cost.push(i === opt.slowIdx ? opt.serverMs * opt.slowFactor : opt.serverMs);
    }
    const out = {};

    // --- HTTP/1.0：每个请求一条新连接（握手 1 RTT），conns 条并行 ---
    {
        const free = new Array(conns).fill(0);
        const bars = [];
        for (let i = 0; i < n; i++) {
            const k = free.indexOf(Math.min.apply(null, free));
            const start = free[k];
            const end = start + rtt + rtt + cost[i];   // 握手 + 请求往返 + 处理
            free[k] = end;
            bars.push({ i, start, end });
        }
        out.h10 = { bars, total: Math.max.apply(null, bars.map((b) => b.end)) };
    }

    // --- HTTP/1.1 Keep-Alive：每条连接只握一次手，之后串行复用 ---
    {
        const free = new Array(conns).fill(rtt);       // 建连成本一次性付
        const bars = [];
        for (let i = 0; i < n; i++) {
            const k = free.indexOf(Math.min.apply(null, free));
            const start = free[k];
            const end = start + rtt + cost[i];
            free[k] = end;
            bars.push({ i, start, end });
        }
        out.h11 = { bars, total: Math.max.apply(null, bars.map((b) => b.end)) };
    }

    // --- HTTP/1.1 Pipelining：一条连接、请求一次发完，但响应必须严格按序 ---
    {
        const bars = [];
        let clock = rtt + rtt / 2;                     // 建连 + 把所有请求推出去
        for (let i = 0; i < n; i++) {
            const start = rtt;                          // 请求早就发出去了
            clock += cost[i];                           // 响应只能一个接一个回
            bars.push({ i, start, end: clock, stalled: i > opt.slowIdx });
        }
        out.pipe = { bars, total: clock };
    }

    // --- HTTP/2：单连接多路复用，所有流并行 ---
    {
        const base = rtt + rtt / 2;                     // 建连 + 发请求
        // TCP 层队头阻塞：任何一个包丢了，整条连接的所有流一起等重传
        const stall = opt.loss ? rtt : 0;
        const bars = [];
        for (let i = 0; i < n; i++) {
            bars.push({ i, start: base, end: base + cost[i] + stall, stalled: opt.loss });
        }
        out.h2 = { bars, total: Math.max.apply(null, bars.map((b) => b.end)) };
    }

    // --- HTTP/3：QUIC 流独立，丢包只影响自己那条流 ---
    {
        const base = rtt;                               // QUIC 握手更快（1-RTT，含加密）
        const bars = [];
        for (let i = 0; i < n; i++) {
            const stall = (opt.loss && i === opt.slowIdx) ? rtt : 0;
            bars.push({ i, start: base, end: base + cost[i] + stall, stalled: stall > 0 });
        }
        out.h3 = { bars, total: Math.max.apply(null, bars.map((b) => b.end)) };
    }

    return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = HE;
if (typeof window !== 'undefined') window.HEModel = HE;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;
const state = { n: 12, rtt: 60, serverMs: 40, slowIdx: 2, slowFactor: 5, conns: 6, loss: false, sim: null };

function rebuild() {
    state.sim = HE.simulate(state);
    state.maxT = Math.max.apply(null, HE.PROTOCOLS.map((p) => state.sim[p.id].total)) * 1.04;
}

function buildTrack(proto) {
    const r = state.sim[proto.id];
    const n = state.n;
    const LANE = 15, GAP = 2, PL = 26, PR = 60, PT = 22, PB = 6;
    const W = 800, iw = W - PL - PR;
    const H = PT + n * (LANE + GAP) + PB;
    const x = (t) => PL + (t / state.maxT) * iw;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'he-svg', preserveAspectRatio: 'xMidYMid meet' });

    root.appendChild(T({ x: 0, y: 11, class: 'he-name', fill: proto.color }, proto.name));
    root.appendChild(T({ x: 172, y: 11, class: 'he-sub' }, proto.sub));
    root.appendChild(T({ x: W, y: 11, 'text-anchor': 'end', class: 'he-total', fill: proto.color },
        Viz.fmtMs(r.total)));

    r.bars.forEach((b) => {
        const y = PT + b.i * (LANE + GAP);
        root.appendChild(svg('rect', { x: PL, y, width: iw, height: LANE, rx: 3, fill: '#f6f7f9' }));
        root.appendChild(svg('rect', {
            x: x(b.start), y: y + 1, width: Math.max(2, x(b.end) - x(b.start)), height: LANE - 2, rx: 2.5,
            fill: proto.color, opacity: b.stalled ? 0.42 : 0.92,
        }));
        if (b.i === state.slowIdx) {
            root.appendChild(T({ x: x(b.end) + 4, y: y + LANE - 3.5, class: 'he-slow' }, '慢资源'));
        }
        root.appendChild(T({ x: PL - 5, y: y + LANE - 3.5, 'text-anchor': 'end', class: 'he-idx' }, String(b.i + 1)));
    });
    return root;
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rebuild();
    rootEl.innerHTML = '';
    const s = state.sim;

    rootEl.appendChild(Viz.card('fa-sliders', '场景：一个网页要加载一批资源',
        `${state.n} 个资源、RTT ${state.rtt}ms、服务端处理 ${state.serverMs}ms，`
        + `其中<b>第 ${state.slowIdx + 1} 个特别慢</b>（${state.slowFactor} 倍耗时）—— 用它来暴露队头阻塞。`,
        h('div.controls', null,
            Viz.slider({ label: '资源数', min: 3, max: 14, step: 1, value: state.n, fmt: (v) => v + ' 个',
                onInput: (v) => { state.n = v; state.slowIdx = Math.min(state.slowIdx, v - 1); render(); } }),
            Viz.slider({ label: 'RTT', min: 10, max: 200, step: 5, value: state.rtt, fmt: (v) => v + ' ms',
                onInput: (v) => { state.rtt = v; render(); } }),
            Viz.slider({ label: '慢资源倍数', min: 1, max: 10, step: 1, value: state.slowFactor, fmt: (v) => '×' + v,
                onInput: (v) => { state.slowFactor = v; render(); } }),
            h('div.ctl-btns', null,
                h('button.mini' + (state.loss ? '.primary' : ''), {
                    onclick: () => { state.loss = !state.loss; render(); },
                }, state.loss ? '✓ 已模拟丢包' : '模拟一个包丢失')
            )
        )
    ));

    const tracks = Viz.card('fa-bars-staggered', '五条时间轴，同一批资源',
        '横条 = 这个资源从发出请求到收完的时间。<b>越靠左结束越好。</b>'
        + '半透明的条表示<b>它其实早就好了，只是被别人堵住了</b>。');
    HE.PROTOCOLS.forEach((p) => tracks.appendChild(h('div.he-track', null, buildTrack(p))));
    rootEl.appendChild(tracks);

    // 总耗时对比
    rootEl.appendChild(Viz.card('fa-stopwatch', '总加载时间', null,
        Viz.cmpGrid([
            { h: 'HTTP/1.0', v: Viz.fmtMs(s.h10.total), d: '每次都重新握手', cls: 'cmp-bad' },
            { h: 'HTTP/1.1', v: Viz.fmtMs(s.h11.total), d: '连接复用 + 6 并发', cls: 'cmp-save' },
            { h: 'HTTP/2', v: Viz.fmtMs(s.h2.total), d: '单连接多路复用', cls: 'cmp-ok' },
            { h: 'HTTP/3', v: Viz.fmtMs(s.h3.total), d: 'QUIC 流独立', cls: 'cmp-ok' },
        ])
    ));

    // 三种队头阻塞
    rootEl.appendChild(Viz.card('fa-ban', '「队头阻塞」其实有两层，别答混了',
        '这是这个题目最容易失分的地方 —— 很多人只知道 H2 解决了队头阻塞，'
        + '却说不清它解决的是<b>哪一层</b>的，也说不清 H3 又多解决了什么。',
        Viz.flowList([
            {
                t: '① 应用层队头阻塞：HTTP/1.1 Pipelining 的死穴',
                f: '请求可以一次全发出去，但 HTTP/1.1 规定\n响应必须按请求顺序返回',
                r: '看紫色那条轨：第 3 个资源慢，后面全部干等',
                hi: '正因为这个坑（外加代理实现混乱），<b>Pipelining 在浏览器里从来没被真正启用过</b>，'
                    + '这也是面试常考的冷知识。HTTP/2 的多路复用就是来解决它的。',
            },
            {
                t: '② HTTP/2 的解法：把请求拆成带 Stream ID 的帧，交错发送',
                f: 'Stream 1: HEADERS DATA ─┐\nStream 3: HEADERS DATA ─┼→ 同一条 TCP 连接上交错传输\nStream 5: HEADERS DATA ─┘',
                r: '响应可以乱序返回，应用层队头阻塞消失（蓝色那条轨全部并行）',
            },
            {
                t: '③ 传输层队头阻塞：HTTP/2 没解决、也解决不了的部分',
                f: 'TCP 必须按序交付给上层\n→ 任何一个 TCP 段丢了，它后面所有段都得在内核缓冲区里等重传',
                r: '点上面的「模拟一个包丢失」看蓝色轨：所有流一起被拖慢',
                hi: '这是 <b>TCP 的语义决定的</b>，在 TCP 之上做什么都没用 —— '
                    + '而且 H2 只用<b>一条</b>连接，反而比 H1.1 的六条连接更怕丢包（鸡蛋全在一个篮子里）。',
            },
            {
                t: '④ HTTP/3 的解法：干脆不用 TCP',
                f: 'QUIC 基于 UDP 自己实现可靠传输\n每条 Stream 独立编号、独立重传、独立交付',
                r: '丢包只卡住它自己那条流，其余流照常（绿色轨只有一条变淡）',
            },
        ])
    ));

    // 各版本关键特性
    rootEl.appendChild(Viz.card('fa-list-check', '各版本到底加了什么', null,
        Viz.qa([
            { q: 'HTTP/1.0 → 1.1', a: '<b>Keep-Alive 默认开启</b>（连接复用，省掉每次握手的 1 RTT）、'
                + '<b>Host 头</b>（一个 IP 托管多个域名，虚拟主机的基础）、断点续传（Range）、'
                + '缓存控制更完善（Cache-Control / ETag）、Pipelining（但没人用）。' },
            { q: 'HTTP/1.1 → 2', a: '<b>二进制分帧</b>（不再是文本协议，解析更快更不易出错）、'
                + '<b>多路复用</b>（一条连接跑多个 Stream，解决应用层队头阻塞）、'
                + '<b>HPACK 头部压缩</b>（静态表 + 动态表 + 哈夫曼，Cookie 这类重复头开销骤降）、'
                + '<b>Server Push</b>（已被主流浏览器废弃，实际收益不如预期）、流优先级。' },
            { q: 'HTTP/2 → 3', a: '<b>换用 QUIC（基于 UDP）</b>，彻底消除传输层队头阻塞；'
                + '<b>握手更快</b>（TLS 1.3 内置，1-RTT 建连，重连 0-RTT，而 H2 要 TCP 3 次握手 + TLS 握手）；'
                + '<b>连接迁移</b>（用 Connection ID 而非四元组标识连接，从 WiFi 切到 4G 不断连）；'
                + '头部压缩换成 QPACK（避免 HPACK 在乱序下的依赖问题）。' },
            { q: '为什么 HTTP/1.1 时代要做「域名分片」和「雪碧图」？', a: '因为浏览器对<b>同一域名</b>只开 6 条左右的并发连接。'
                + '把资源拆到多个子域名能骗到更多连接数，把小图拼成雪碧图能减少请求数。'
                + '<b>到了 HTTP/2 这两个优化反而有害</b> —— 多域名会破坏单连接多路复用、雪碧图会让缓存粒度变粗。' },
        ])
    ));

    rootEl.appendChild(Viz.card('fa-circle-info', '关于这个演示',
        '模型只计算<b>时延</b>（RTT + 服务端处理时间），不模拟带宽争抢和 TCP 慢启动。'
        + '在「资源多、体积小」的典型网页场景里时延就是主要瓶颈，这个简化不影响结论；'
        + '但如果资源很大、带宽吃紧，HTTP/2 相对 1.1 的优势会比图上显示的小。'));
}

Viz.register({
    id: 'http-evolution',
    cat: 'net',
    title: 'HTTP 演进与队头阻塞',
    subtitle: '1.0 / 1.1 / 2 / 3 五轨对比',
    icon: 'fa-bars-staggered',
    blurb: '「多路复用」到底解决了哪一层的队头阻塞，H3 又多解决了什么',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.n = 12; state.rtt = 60; state.serverMs = 40; state.slowIdx = 2;
        state.slowFactor = 5; state.conns = 6; state.loss = false;
        render();
    },
    unmount() { rootEl = null; },
});

})();
