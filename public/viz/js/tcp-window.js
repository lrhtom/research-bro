// ============================================================
//  演示：TCP 滑动窗口 + 流量控制
//  发送窗口四个指针怎么滑、接收方处理不过来时窗口怎么缩、
//  零窗口怎么死锁、坚持定时器怎么救。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const WIN = {};

/**
 * 按 RTT 轮推进。每轮：
 *   1) 发送方发出 min(可用窗口, 待发数据) 个段
 *   2) 上一轮发出的段到达接收方，进缓冲区
 *   3) 接收方应用层消费 consumeRate 个段
 *   4) 接收方回 ACK，捎带新的接收窗口 rwnd = 缓冲区剩余空间
 *
 * 返回每轮快照，字段对应 TCP 的四个指针。
 */
WIN.simulate = function (opt) {
    const rounds = opt.rounds, bufSize = opt.bufSize;
    const consume = opt.consumeRate, total = opt.totalData;

    let sentBytes = 0;       // LastByteSent
    let ackedBytes = 0;      // LastByteAcked
    let buffered = 0;        // 接收缓冲区已占用
    let rwnd = bufSize;
    let inFlightPrev = 0;
    let zeroWindowSince = -1;
    const out = [];

    for (let r = 0; r < rounds; r++) {
        const usable = Math.max(0, Math.min(rwnd - (sentBytes - ackedBytes), total - sentBytes));
        let probe = false;

        // 零窗口：发送方停下，只能靠坚持定时器发探测报文
        if (rwnd === 0 && total - sentBytes > 0) {
            if (zeroWindowSince < 0) zeroWindowSince = r;
            probe = true;
        } else if (rwnd > 0) {
            zeroWindowSince = -1;
        }

        const justSent = probe ? 0 : usable;
        sentBytes += justSent;

        // 上一轮发出的数据这一轮到达
        const arrived = Math.min(inFlightPrev, bufSize - buffered);
        buffered += arrived;
        ackedBytes += arrived;

        // 应用层读走
        const consumed = Math.min(consume, buffered);
        buffered -= consumed;

        rwnd = bufSize - buffered;

        out.push({
            round: r,
            sent: sentBytes, acked: ackedBytes,
            inFlight: sentBytes - ackedBytes,
            usable: Math.max(0, rwnd - (sentBytes - ackedBytes)),
            buffered, rwnd, consumed, justSent, probe,
            zeroWindow: rwnd === 0,
            done: ackedBytes >= total,
        });
        inFlightPrev = justSent;
        if (ackedBytes >= total) break;
    }
    return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = WIN;
if (typeof window !== 'undefined') window.WINModel = WIN;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const state = { bufSize: 10, consumeRate: 2, totalData: 40, rounds: 30, cur: 0, series: [] };

function rebuild() {
    state.series = WIN.simulate({
        rounds: state.rounds, bufSize: state.bufSize,
        consumeRate: state.consumeRate, totalData: state.totalData,
    });
    if (state.cur >= state.series.length) state.cur = state.series.length - 1;
}

// ---------- 字节流条：四个指针 ----------

function buildStrip() {
    const p = state.series[state.cur];
    const W = 800, H = 132, PL = 12, PR = 12, PT = 34;
    const iw = W - PL - PR;
    const total = state.totalData;
    const x = (b) => PL + (b / total) * iw;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'win-svg', preserveAspectRatio: 'xMidYMid meet' });
    const barY = PT + 18, barH = 30;

    root.appendChild(T({ x: PL, y: 16, class: 'win-cap' }, '发送方的字节流'));

    // 底槽
    root.appendChild(svg('rect', { x: PL, y: barY, width: iw, height: barH, rx: 5, fill: '#f1f3f6' }));
    // 已确认
    root.appendChild(svg('rect', { x: PL, y: barY, width: x(p.acked) - PL, height: barH, rx: 5, class: 'win-acked' }));
    // 已发送未确认（在途）
    root.appendChild(svg('rect', {
        x: x(p.acked), y: barY, width: Math.max(0, x(p.sent) - x(p.acked)), height: barH, class: 'win-inflight',
    }));
    // 可发送（窗口剩余额度）
    root.appendChild(svg('rect', {
        x: x(p.sent), y: barY, width: Math.max(0, x(p.sent + p.usable) - x(p.sent)), height: barH, class: 'win-usable',
    }));

    // 发送窗口范围框
    const winEnd = Math.min(p.acked + p.rwnd, total);
    root.appendChild(svg('rect', {
        x: x(p.acked), y: barY - 6, width: Math.max(2, x(winEnd) - x(p.acked)), height: barH + 12,
        rx: 5, class: 'win-frame',
    }));
    root.appendChild(T({
        x: (x(p.acked) + x(winEnd)) / 2, y: barY - 11, 'text-anchor': 'middle', class: 'win-frame-label',
    }, `发送窗口 = min(cwnd, rwnd) = ${p.rwnd}`));

    // 指针标注
    const ptr = (bx, label, cls) => {
        root.appendChild(svg('line', { x1: bx, x2: bx, y1: barY + barH, y2: barY + barH + 12, class: 'win-ptr' }));
        root.appendChild(T({ x: bx, y: barY + barH + 25, 'text-anchor': 'middle', class: cls || 'win-ptr-label' }, label));
    };
    ptr(x(p.acked), 'LastByteAcked');
    ptr(x(p.sent), 'LastByteSent');

    return root;
}

// ---------- 接收缓冲区 ----------

function buildReceiver() {
    const p = state.series[state.cur];
    const W = 800, H = 108, PL = 12, PR = 12;
    const iw = W - PL - PR;
    const x = (b) => PL + (b / state.bufSize) * iw;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'win-svg', preserveAspectRatio: 'xMidYMid meet' });
    root.appendChild(T({ x: PL, y: 16, class: 'win-cap' }, `接收方缓冲区（容量 ${state.bufSize}）`));

    const barY = 30, barH = 34;
    root.appendChild(svg('rect', { x: PL, y: barY, width: iw, height: barH, rx: 5, fill: '#f1f3f6' }));
    root.appendChild(svg('rect', {
        x: PL, y: barY, width: Math.max(0, x(p.buffered) - PL), height: barH, rx: 5,
        class: p.zeroWindow ? 'win-buf-full' : 'win-buf',
    }));
    root.appendChild(svg('rect', {
        x: x(p.buffered), y: barY, width: Math.max(0, x(state.bufSize) - x(p.buffered)), height: barH,
        class: 'win-buf-free',
    }));

    root.appendChild(T({ x: PL + 8, y: barY + 22, class: 'win-in-bar' },
        `已缓存 ${p.buffered}`));
    root.appendChild(T({
        x: W - PR - 8, y: barY + 22, 'text-anchor': 'end',
        class: p.zeroWindow ? 'win-in-bar-warn' : 'win-in-bar',
    }, p.zeroWindow ? 'rwnd = 0　窗口已满！' : `剩余 rwnd = ${p.rwnd}`));

    root.appendChild(T({ x: PL, y: barY + barH + 22, class: 'win-note' },
        `这一轮应用层读走了 ${p.consumed} 个段` + (p.probe ? '　·　发送方已停发，正在发零窗口探测报文' : '')));
    return root;
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rebuild();
    rootEl.innerHTML = '';
    const p = state.series[state.cur];
    const anyZero = state.series.some((s) => s.zeroWindow);

    rootEl.appendChild(Viz.card('fa-arrows-left-right-to-line', '滑动窗口：四个指针在动',
        '拖下面的「时间轴」一轮一轮走，看窗口怎么向右滑。'
        + '<b>发送窗口 = min(拥塞窗口 cwnd, 接收窗口 rwnd)</b>，这里只演示 rwnd 这一侧（流量控制）。',
        Viz.legend([
            { cls: 'k-acked', text: '已确认（窗口左边界推进）' },
            { cls: 'k-inflight', text: '已发送未确认（在途）' },
            { cls: 'k-usable', text: '可用窗口（还能再发这么多）' },
        ]),
        buildStrip(), buildReceiver()));

    // 时间轴 + 控制
    const scrub = h('input', {
        type: 'range', min: '0', max: String(state.series.length - 1), step: '1',
        value: String(state.cur), class: 'win-scrub',
        oninput: (e) => { state.cur = Number(e.target.value); render(); },
    });

    rootEl.appendChild(Viz.card('fa-sliders', '调参数看现象',
        `当前第 <b>${p.round}</b> 轮 / 共 ${state.series.length} 轮。`
        + '把「接收方处理速度」调到 0，几轮之内就能看到<b>零窗口</b>。',
        h('label.ctl.ctl-wide', null, h('span.ctl-name', { text: '时间轴（RTT 轮次）' }), scrub,
            h('b.ctl-val', { text: `第 ${p.round} 轮` })),
        h('div.controls', null,
            Viz.slider({
                label: '接收缓冲区', min: 4, max: 24, step: 1, value: state.bufSize,
                fmt: (v) => v + ' 段', onInput: (v) => { state.bufSize = v; state.cur = 0; render(); },
            }),
            Viz.slider({
                label: '接收方处理速度', min: 0, max: 8, step: 1, value: state.consumeRate,
                fmt: (v) => v + ' 段/轮', onInput: (v) => { state.consumeRate = v; state.cur = 0; render(); },
            }),
            Viz.slider({
                label: '待发数据总量', min: 10, max: 80, step: 5, value: state.totalData,
                fmt: (v) => v + ' 段', onInput: (v) => { state.totalData = v; state.cur = 0; render(); },
            })
        )
    ));

    // 状态数值
    rootEl.appendChild(Viz.card('fa-gauge-high', '这一轮的关键数值', null,
        Viz.cmpGrid([
            { h: '已发送未确认', v: String(p.inFlight), d: 'LastByteSent − LastByteAcked', cls: 'cmp-save' },
            { h: '可用窗口', v: String(p.usable), d: 'rwnd − 在途字节', cls: p.usable === 0 ? 'cmp-bad' : 'cmp-ok' },
            { h: '接收窗口 rwnd', v: String(p.rwnd), d: '接收方缓冲区剩余', cls: p.rwnd === 0 ? 'cmp-bad' : 'cmp-ok' },
        ])
    ));

    if (anyZero) {
        rootEl.appendChild(Viz.card('fa-triangle-exclamation', '零窗口死锁：一个经典追问',
            '接收方处理不过来 → 缓冲区满 → 回 <code>rwnd = 0</code> → 发送方停发。'
            + '等接收方腾出空间，它会发一个「窗口更新」报文告诉发送方可以继续了 —— '
            + '<b>但这个报文本身不携带数据，是不可靠的，一旦丢失，双方就互相干等：'
            + '发送方等窗口更新，接收方等数据。这就是零窗口死锁。</b>',
            Viz.flowList([
                {
                    t: '解法：坚持定时器（Persist Timer）',
                    f: '发送方收到 rwnd=0 后启动定时器\n定时器到期 → 发一个只含 1 字节的窗口探测报文',
                    r: '强迫接收方回一个 ACK，把最新的 rwnd 带回来',
                },
                {
                    t: '顺带一提：糊涂窗口综合症（Silly Window Syndrome）',
                    f: '接收方每腾出 1 字节就通告一次 → 发送方每次只发 1 字节\n开销比数据还大',
                    r: 'Clark 方案（接收方攒够半个缓冲区或一个 MSS 才通告）+ Nagle 算法（发送方攒够再发）',
                },
            ])
        ));
    }

    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        {
            q: '流量控制和拥塞控制的区别？',
            a: '流量控制是<b>端到端</b>的，防止发送方压垮<b>接收方</b>，靠接收方通告的 rwnd；'
                + '拥塞控制是<b>全局</b>的，防止压垮<b>中间网络</b>，靠发送方自己维护的 cwnd。'
                + '实际发送窗口取两者较小值。',
        },
        {
            q: 'TCP 靠什么保证可靠传输？',
            a: '① 序号 + 确认应答　② 超时重传　③ 滑动窗口（含流量控制）　④ 拥塞控制　'
                + '⑤ 校验和　⑥ 接收方对乱序包重排、对重复包去重。'
                + '面试时按这六条报，比只说「三次握手」得分高得多。',
        },
        {
            q: '窗口越大越好吗？',
            a: '不是。窗口受限于接收缓冲区、网络带宽时延积（BDP）。窗口大于 BDP 只会让数据堆在路由器队列里，'
                + '徒增排队时延（bufferbloat），并不提升吞吐。理想窗口 ≈ 带宽 × RTT。',
        },
    ])));
}

Viz.register({
    id: 'tcp-window',
    cat: 'net',
    title: 'TCP 滑动窗口',
    subtitle: '窗口滑动 / 流量控制 / 零窗口',
    icon: 'fa-arrows-left-right-to-line',
    blurb: '四个指针怎么滑，接收方处理不过来时会发生什么',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.bufSize = 10; state.consumeRate = 2; state.totalData = 40; state.cur = 0;
        render();
    },
    unmount() { rootEl = null; },
});

})();
