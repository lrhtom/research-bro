// ============================================================
//  演示：TCP 拥塞控制（Reno）
//  慢启动 / 拥塞避免 / 快重传 / 快恢复 —— 就是那张 cwnd 锯齿图。
//  模型按「每个 RTT 一轮」离散推进，是教科书画法，不是逐 ACK 的精确实现。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const CC = {};

/**
 * 按轮（RTT）推进 Reno 拥塞控制。
 * events: { [round]: 'timeout' | 'dupack' }
 * 返回每一轮的 { round, cwnd, ssthresh, phase, event }
 *
 * 规则（教科书 Reno）：
 *   慢启动   cwnd 每轮翻倍，到达 ssthresh 转入拥塞避免
 *   拥塞避免 cwnd 每轮 +1（加性增）
 *   超时     ssthresh = cwnd/2，cwnd = 1，回到慢启动
 *   三次重复ACK 快重传 → 快恢复：ssthresh = cwnd/2，cwnd = ssthresh + 3
 *              下一轮回落到 ssthresh，进入拥塞避免
 */
CC.simulate = function (rounds, initSsthresh, events) {
    const out = [];
    let cwnd = 1;
    let ssthresh = initSsthresh;
    let phase = 'ss';

    for (let r = 0; r < rounds; r++) {
        const ev = events[r] || null;

        if (ev === 'timeout') {
            ssthresh = Math.max(Math.floor(cwnd / 2), 2);
            cwnd = 1;
            phase = 'ss';
        } else if (ev === 'dupack') {
            ssthresh = Math.max(Math.floor(cwnd / 2), 2);
            cwnd = ssthresh + 3;      // 快恢复：膨胀 3 个，因为已有 3 个包离开了网络
            phase = 'fr';
        } else if (r > 0) {
            // 第 0 轮记录的是初始状态（cwnd=1），从第 1 轮起才开始增长
            if (phase === 'fr') {
                cwnd = ssthresh;      // 快恢复结束，回落到新的 ssthresh
                phase = 'ca';
            } else if (phase === 'ss') {
                if (cwnd >= ssthresh) { phase = 'ca'; cwnd = cwnd + 1; }
                else { cwnd = Math.min(cwnd * 2, ssthresh); }
            } else {
                cwnd = cwnd + 1;
            }
        }

        out.push({ round: r, cwnd, ssthresh, phase, event: ev });
    }
    return out;
};

CC.PHASES = {
    ss: { name: '慢启动', en: 'Slow Start', color: '#4f46e5' },
    ca: { name: '拥塞避免', en: 'Congestion Avoidance', color: '#10b981' },
    fr: { name: '快恢复', en: 'Fast Recovery', color: '#f59e0b' },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CC;
if (typeof window !== 'undefined') window.CCModel = CC;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const state = { rounds: 26, ssthresh: 16, events: {}, series: [] };

function defaults() {
    state.rounds = 26;
    state.ssthresh = 16;
    state.events = { 9: 'dupack', 17: 'timeout' };  // 一张图里四个阶段全齐
}

function rebuild() { state.series = CC.simulate(state.rounds, state.ssthresh, state.events); }

// ---------- cwnd 锯齿图 ----------

function buildChart() {
    const W = 800, H = 340, PL = 46, PR = 16, PT = 26, PB = 52;
    const iw = W - PL - PR, ih = H - PT - PB;
    const s = state.series;
    const maxY = Math.max(4, Math.max.apply(null, s.map((p) => Math.max(p.cwnd, p.ssthresh))) + 2);

    const x = (r) => PL + (r / Math.max(state.rounds - 1, 1)) * iw;
    const y = (v) => PT + ih - (v / maxY) * ih;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'cc-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'cwnd 变化曲线',
    });

    // 网格
    const stepY = Viz.niceStep(maxY, 5);
    for (let v = 0; v <= maxY; v += stepY) {
        root.appendChild(svg('line', { x1: PL, x2: W - PR, y1: y(v), y2: y(v), stroke: '#eef0f3' }));
        root.appendChild(T({ x: PL - 8, y: y(v) + 4, class: 'axis-label', 'text-anchor': 'end' }, String(v)));
    }
    root.appendChild(T({ x: 4, y: 14, class: 'axis-title' }, 'cwnd（MSS）'));
    root.appendChild(T({ x: PL + iw / 2, y: H - 8, class: 'axis-title', 'text-anchor': 'middle' },
        '传输轮次（每轮 = 1 个 RTT）'));

    // ssthresh 阶梯线
    let sd = '';
    s.forEach((p, i) => {
        const x0 = x(i), x1 = x(Math.min(i + 1, state.rounds - 1));
        sd += (i ? 'L' : 'M') + x0 + ' ' + y(p.ssthresh) + 'L' + x1 + ' ' + y(p.ssthresh);
    });
    root.appendChild(svg('path', { d: sd, class: 'cc-ssthresh', fill: 'none' }));

    // cwnd 折线：按阶段分段着色
    for (let i = 1; i < s.length; i++) {
        const p0 = s[i - 1], p1 = s[i];
        root.appendChild(svg('line', {
            x1: x(i - 1), y1: y(p0.cwnd), x2: x(i), y2: y(p1.cwnd),
            stroke: CC.PHASES[p1.phase].color, 'stroke-width': 2.6,
            'stroke-linecap': 'round',
        }));
    }

    // 点 + 事件标记；每个点可点击，用来加/删事件
    s.forEach((p, i) => {
        root.appendChild(svg('circle', {
            cx: x(i), cy: y(p.cwnd), r: 3.4, fill: CC.PHASES[p.phase].color,
            stroke: '#fff', 'stroke-width': 1.2,
        }));
        if (p.event) {
            const isTo = p.event === 'timeout';
            root.appendChild(svg('line', {
                x1: x(i), x2: x(i), y1: PT - 6, y2: PT + ih,
                class: isTo ? 'cc-ev-timeout' : 'cc-ev-dup',
            }));
            root.appendChild(T({
                x: x(i), y: PT - 10, 'text-anchor': 'middle',
                class: isTo ? 'cc-ev-label-to' : 'cc-ev-label-dup',
            }, isTo ? '超时' : '3×重复ACK'));
        }
        // 透明大热区，方便点
        const hit = svg('rect', {
            x: x(i) - 9, y: PT, width: 18, height: ih, fill: 'transparent',
            class: 'cc-hit', style: 'cursor:pointer',
        });
        hit.addEventListener('click', () => cycleEvent(i));
        const tip = svg('title');
        tip.textContent = `第 ${i} 轮：cwnd=${p.cwnd}, ssthresh=${p.ssthresh}, ${CC.PHASES[p.phase].name}`
            + '（点击可在 无事件 → 三次重复ACK → 超时 之间切换）';
        hit.appendChild(tip);
        root.appendChild(hit);
    });

    // X 轴刻度
    for (let r = 0; r < state.rounds; r += Math.ceil(state.rounds / 13)) {
        root.appendChild(T({ x: x(r), y: PT + ih + 16, class: 'axis-label', 'text-anchor': 'middle' }, String(r)));
    }
    return root;
}

function cycleEvent(i) {
    const cur = state.events[i];
    if (!cur) state.events[i] = 'dupack';
    else if (cur === 'dupack') state.events[i] = 'timeout';
    else delete state.events[i];
    render();
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rebuild();
    rootEl.innerHTML = '';
    const s = state.series;
    const peak = Math.max.apply(null, s.map((p) => p.cwnd));

    // 图
    const ctl = h('div.controls', null,
        Viz.slider({
            label: '初始 ssthresh', min: 4, max: 40, step: 1, value: state.ssthresh,
            fmt: (v) => v + ' MSS', onInput: (v) => { state.ssthresh = v; render(); },
        }),
        Viz.slider({
            label: '传输轮数', min: 12, max: 40, step: 1, value: state.rounds,
            fmt: (v) => v + ' 轮', onInput: (v) => { state.rounds = v; render(); },
        }),
        h('div.ctl-btns', null,
            h('button.mini', { onclick: () => { state.events = {}; render(); } }, '清空事件'),
            h('button.mini', { onclick: () => { defaults(); render(); } }, '恢复默认'))
    );

    rootEl.appendChild(Viz.card('fa-chart-line', 'cwnd 锯齿图：拥塞控制的全部答案都在这张图里',
        '<b>点击图上任意一轮</b>可以注入事件，在 <i>无 → 三次重复ACK → 超时</i> 之间循环切换，'
        + '立刻能看出两种丢包信号导致的反应完全不同。',
        Viz.legend([
            { cls: 'k-ss', text: '慢启动（指数涨）' },
            { cls: 'k-ca', text: '拥塞避免（线性涨）' },
            { cls: 'k-fr', text: '快恢复' },
            { cls: 'k-thresh', text: 'ssthresh 门限' },
        ]),
        buildChart(), ctl));

    // 关键对比
    rootEl.appendChild(Viz.card('fa-scale-balanced', '两种丢包信号，两种反应',
        '这是拥塞控制最常考的一个点：<b>为什么超时要那么狠，重复 ACK 却可以温和？</b>',
        Viz.cmpGrid([
            { h: '收到 3 个重复 ACK', v: 'cwnd = ssthresh+3', d: '快重传 + 快恢复', cls: 'cmp-ok' },
            { h: '超时（RTO）', v: 'cwnd = 1', d: '一夜回到解放前', cls: 'cmp-bad' },
            { h: '本次峰值 cwnd', v: peak + ' MSS', d: '窗口最大值', cls: 'cmp-save' },
        ]),
        h('p.sec-note', {
            html: '因为<b>信号强度不同</b>。能收到 3 个重复 ACK，说明后续的包还在陆续到达接收方 —— '
                + '网络只是丢了个别包，通路是通的，没必要推倒重来；'
                + '而超时意味着<b>连 ACK 都回不来了</b>，网络可能已经严重拥塞甚至断了，只能从最保守的 cwnd=1 重新试探。',
        })
    ));

    // 四个阶段
    rootEl.appendChild(Viz.card('fa-list-ol', '四个阶段分别在干什么', null,
        Viz.flowList([
            {
                t: '① 慢启动 Slow Start —— 名字骗人，其实涨得最快',
                f: '每收到一个 ACK：cwnd += 1\n每过一个 RTT：cwnd 翻倍（1 → 2 → 4 → 8 …）',
                r: '指数增长，快速试探出网络能吃多少',
                hi: '「慢」指的是<b>起点低</b>（从 1 个 MSS 开始），不是涨得慢。'
                    + '这是最容易被面试官追问的措辞陷阱。',
            },
            {
                t: '② 到达 ssthresh，转入拥塞避免 Congestion Avoidance',
                f: '每过一个 RTT：cwnd += 1',
                r: '线性增长（加性增 AI），小心翼翼地继续探底',
            },
            {
                t: '③ 收到 3 个重复 ACK → 快重传 Fast Retransmit',
                f: 'ssthresh = cwnd / 2\n立即重传丢失的那个报文段，不等 RTO 超时',
                r: '省下一整个超时等待的时间',
            },
            {
                t: '④ 紧接着进入快恢复 Fast Recovery',
                f: 'cwnd = ssthresh + 3\n之后每收到一个重复 ACK：cwnd += 1\n收到新 ACK 后：cwnd = ssthresh，转入拥塞避免',
                r: '不回到 cwnd=1，直接从半程继续（乘性减 MD）',
                hi: '加上那个 <code>+3</code> 是因为收到 3 个重复 ACK 就说明有 3 个包已经离开网络、到达接收方了，'
                    + '窗口可以相应地放宽 3 个。',
            },
            {
                t: '⑤ 如果是超时（RTO）而不是重复 ACK',
                f: 'ssthresh = cwnd / 2\ncwnd = 1\n重新进入慢启动',
                r: '最保守的反应，图上就是那根垂直跌到底的线',
            },
        ])
    ));

    // 面试怎么答
    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        {
            q: '为什么叫「慢」启动？',
            a: '因为<b>初始窗口小</b>（1 个 MSS），不是增长慢。实际上它是指数增长，是四个阶段里涨得最快的。',
        },
        {
            q: 'AIMD 是什么？',
            a: '加性增、乘性减（Additive Increase Multiplicative Decrease）。拥塞避免阶段每 RTT 加 1，'
                + '遇到拥塞时直接砍半。<b>缓慢试探、快速退让</b>，这种不对称是为了让网络快速摆脱拥塞，也是 TCP 公平性的来源。',
        },
        {
            q: '拥塞控制和流量控制的区别？',
            a: '流量控制看的是<b>接收方</b>处理不过来（用接收窗口 rwnd，接收方通过 ACK 告知）；'
                + '拥塞控制看的是<b>网络中间链路</b>堵了（用拥塞窗口 cwnd，发送方自己推测）。'
                + '实际发送窗口 = <code>min(cwnd, rwnd)</code>，两个谁小听谁的。',
        },
        {
            q: 'Reno、NewReno、CUBIC、BBR 有什么区别？',
            a: '这张图画的是 <b>Reno</b>。NewReno 改进了一个 RTT 内丢多个包的处理；'
                + '<b>CUBIC</b>（Linux 默认）用三次函数代替线性增长，高带宽长肥管道下恢复更快；'
                + '<b>BBR</b>（Google）不靠丢包判断拥塞，而是主动测量带宽和 RTT，在有随机丢包的链路上优势明显。',
        },
    ])));

    rootEl.appendChild(Viz.card('fa-circle-info', '关于这个演示',
        '模型按「每个 RTT 一轮」离散推进，这是教科书和面试里画的那张标准图，'
        + '不是逐 ACK 的精确实现（真实内核里 cwnd 是按字节、按每个 ACK 增长的）。'
        + '阶段划分与参数取值遵循 RFC 5681 描述的 TCP Reno。'));
}

Viz.register({
    id: 'tcp-congestion',
    cat: 'net',
    title: 'TCP 拥塞控制',
    subtitle: '慢启动 / 拥塞避免 / 快重传 / 快恢复',
    icon: 'fa-chart-line',
    blurb: 'cwnd 锯齿图 —— 名词人人会背，图没几个人画得出',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        defaults();
        render();
    },
    unmount() { rootEl = null; },
});

})();
