// ============================================================
//  演示：TCP 三次握手 / 四次挥手 + 状态机
//  重点不是背步骤，是状态迁移，以及 TIME_WAIT / CLOSE_WAIT 到底卡在哪。
// ============================================================

(function () {

// ---------- 一、剧本（纯数据）----------

const HS = {};

// 每一步：from/to（c=客户端 s=服务端）、报文、双方状态、旁白
HS.SCENARIOS = {
    open: {
        name: '三次握手',
        desc: '建立连接。核心目的是<b>双方各自确认「我发的对方能收到、对方发的我能收到」</b>。',
        steps: [
            { c: 'CLOSED', s: 'LISTEN', note: '服务端 listen() 后进入 LISTEN，等着被连。' },
            {
                from: 'c', to: 's', msg: 'SYN', detail: 'SYN=1, seq=x',
                c: 'SYN_SENT', s: 'LISTEN',
                note: '客户端 connect()，发出第一个 SYN，带上自己的初始序号 x。',
            },
            {
                from: 's', to: 'c', msg: 'SYN + ACK', detail: 'SYN=1, ACK=1, seq=y, ack=x+1',
                c: 'SYN_SENT', s: 'SYN_RCVD',
                note: '服务端同意，同时把自己的初始序号 y 发过去，并确认收到了 x。'
                    + '这一步<b>把服务端的 SYN 和对客户端的 ACK 合并成了一个包</b>，所以是三次不是四次。',
            },
            {
                from: 'c', to: 's', msg: 'ACK', detail: 'ACK=1, ack=y+1',
                c: 'ESTABLISHED', s: 'SYN_RCVD',
                note: '客户端确认收到了 y。此时客户端已经可以发数据了。',
            },
            { c: 'ESTABLISHED', s: 'ESTABLISHED', note: '服务端收到 ACK，连接建立完成，双向通道打通。' },
        ],
    },
    twoWay: {
        name: '如果只握两次会怎样',
        desc: '经典追问。答案是<b>会因为「已失效的连接请求」而白白建立连接，浪费服务端资源</b>。',
        steps: [
            { c: 'CLOSED', s: 'LISTEN', note: '假设我们把协议改成两次握手：服务端收到 SYN 就直接建立连接。' },
            {
                from: 'c', to: 's', msg: 'SYN (旧)', detail: 'seq=x　※ 这个包在网络里滞留了很久',
                c: 'CLOSED', s: 'LISTEN', lost: 'delay',
                note: '客户端<b>很久以前</b>发的一个 SYN，因为网络拥堵在某个路由器排了很久的队。'
                    + '客户端早已超时重发并完成了一次连接、又关闭了。',
            },
            {
                from: 'c', to: 's', msg: 'SYN (滞留包终于到达)', detail: 'seq=x',
                c: 'CLOSED', s: 'SYN_RCVD',
                note: '这个过期的 SYN 现在才慢悠悠到达服务端。',
            },
            {
                from: 's', to: 'c', msg: 'SYN + ACK', detail: 'seq=y, ack=x+1',
                c: 'CLOSED', s: 'ESTABLISHED',
                note: '<b>两次握手的话，服务端到这里就认为连接已建立</b>，分配好了缓冲区、TCB 等资源，开始等数据。',
            },
            {
                c: 'CLOSED', s: 'ESTABLISHED', warn: true,
                note: '但客户端根本没有想连接 —— 它会丢弃这个 SYN+ACK，什么也不做。'
                    + '<b>服务端就这样挂着一个永远等不到数据的连接，资源白白浪费。</b>'
                    + '第三次握手的意义就是让客户端有机会说「我不认这个连接」。',
            },
        ],
    },
    close: {
        name: '四次挥手',
        desc: 'TCP 是<b>全双工</b>的，两个方向要分别关闭，所以比握手多一次。',
        steps: [
            { c: 'ESTABLISHED', s: 'ESTABLISHED', note: '双方正常通信中。假设由客户端先关闭（主动关闭方）。' },
            {
                from: 'c', to: 's', msg: 'FIN', detail: 'FIN=1, seq=u',
                c: 'FIN_WAIT_1', s: 'ESTABLISHED',
                note: '客户端 close()，声明「我没有数据要发了」。注意它<b>仍然能收</b>。',
            },
            {
                from: 's', to: 'c', msg: 'ACK', detail: 'ACK=1, ack=u+1',
                c: 'FIN_WAIT_2', s: 'CLOSE_WAIT',
                note: '服务端确认。<b>但服务端可能还有数据没发完</b>，所以此时只回 ACK，不回 FIN。'
                    + '这个中间态就是 <b>CLOSE_WAIT</b>。',
            },
            {
                c: 'FIN_WAIT_2', s: 'CLOSE_WAIT',
                note: '服务端把剩余数据发完（这段时间可长可短）。'
                    + '<b>这就是为什么必须四次：ACK 和 FIN 不能合并，中间隔着「把话说完」的时间。</b>',
            },
            {
                from: 's', to: 'c', msg: 'FIN', detail: 'FIN=1, ACK=1, seq=w, ack=u+1',
                c: 'FIN_WAIT_2', s: 'LAST_ACK',
                note: '服务端也说完了，发 FIN。',
            },
            {
                from: 'c', to: 's', msg: 'ACK', detail: 'ACK=1, ack=w+1',
                c: 'TIME_WAIT', s: 'LAST_ACK',
                note: '客户端确认，进入 <b>TIME_WAIT</b>，开始等 2MSL。',
            },
            {
                c: 'TIME_WAIT', s: 'CLOSED',
                note: '服务端收到 ACK，立即 CLOSED。而客户端还要等满 2MSL。',
            },
            {
                c: 'CLOSED', s: 'CLOSED', done: true,
                note: '2MSL 到期，客户端才真正关闭。整个过程结束。',
            },
        ],
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = HS;
if (typeof window !== 'undefined') window.HSModel = HS;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;
const state = { scenario: 'open', step: 0 };

function steps() { return HS.SCENARIOS[state.scenario].steps; }

// ---------- 时序图 ----------

function buildSeq() {
    const st = steps();
    const W = 800, ROW = 62, PT = 58, PB = 26;
    const H = PT + st.length * ROW + PB;
    const CX = 190, SX = 610;      // 两条生命线的 x

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'seq-svg', preserveAspectRatio: 'xMidYMid meet' });

    // 头部角色
    const head = (x, label, sub) => {
        root.appendChild(svg('rect', { x: x - 82, y: 10, width: 164, height: 34, rx: 8, class: 'seq-actor' }));
        root.appendChild(T({ x, y: 26, 'text-anchor': 'middle', class: 'seq-actor-name' }, label));
        root.appendChild(T({ x, y: 38, 'text-anchor': 'middle', class: 'seq-actor-sub' }, sub));
    };
    head(CX, '客户端', 'Client');
    head(SX, '服务端', 'Server');

    // 生命线
    [CX, SX].forEach((x) => root.appendChild(svg('line', {
        x1: x, x2: x, y1: 44, y2: H - PB + 6, class: 'seq-life',
    })));

    st.forEach((s, i) => {
        const y = PT + i * ROW;
        const active = i <= state.step;
        const g = svg('g', { opacity: active ? 1 : 0.16 });

        // 状态标签（贴在各自生命线旁）
        const stateTag = (x, txt, anchor, dx) => {
            const w = Math.max(txt.length * 7.4 + 14, 56);
            g.appendChild(svg('rect', {
                x: anchor === 'end' ? x - dx - w : x + dx, y: y - 11, width: w, height: 20, rx: 5,
                class: 'seq-state' + (txt === 'TIME_WAIT' || txt === 'CLOSE_WAIT' ? ' seq-state-hl' : ''),
            }));
            g.appendChild(T({
                x: anchor === 'end' ? x - dx - w / 2 : x + dx + w / 2, y: y + 3,
                'text-anchor': 'middle', class: 'seq-state-txt',
            }, txt));
        };
        const prev = i > 0 ? st[i - 1] : null;
        if (!prev || prev.c !== s.c) stateTag(CX, s.c, 'end', 14);
        if (!prev || prev.s !== s.s) stateTag(SX, s.s, 'start', 14);

        // 箭头
        if (s.from) {
            const x1 = s.from === 'c' ? CX : SX;
            const x2 = s.to === 'c' ? CX : SX;
            const dir = x2 > x1 ? 1 : -1;
            const ax1 = x1 + dir * 26, ax2 = x2 - dir * 26;
            const cls = s.lost ? 'seq-arrow-lost' : 'seq-arrow';
            g.appendChild(svg('line', {
                x1: ax1, y1: y + (s.lost ? -4 : 0), x2: ax2, y2: y + (s.lost ? 16 : 0),
                class: cls, 'marker-end': s.lost ? '' : 'url(#seqArrow)',
            }));
            g.appendChild(T({
                x: (ax1 + ax2) / 2, y: y - 8, 'text-anchor': 'middle', class: 'seq-msg',
            }, s.msg));
            g.appendChild(T({
                x: (ax1 + ax2) / 2, y: y + 16, 'text-anchor': 'middle', class: 'seq-detail',
            }, s.detail || ''));
        } else if (s.warn) {
            g.appendChild(svg('rect', { x: CX + 24, y: y - 12, width: SX - CX - 48, height: 22, rx: 5, class: 'seq-warnbox' }));
            g.appendChild(T({ x: (CX + SX) / 2, y: y + 3, 'text-anchor': 'middle', class: 'seq-warntxt' },
                '⚠ 服务端资源被白白占住'));
        } else {
            g.appendChild(svg('line', {
                x1: CX + 26, x2: SX - 26, y1: y, y2: y, class: 'seq-gap',
            }));
        }
        root.appendChild(g);
    });

    // 箭头 marker
    const defs = svg('defs');
    const marker = svg('marker', {
        id: 'seqArrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
        markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    });
    marker.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', fill: '#4f46e5' }));
    defs.appendChild(marker);
    root.insertBefore(defs, root.firstChild);

    return root;
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const sc = HS.SCENARIOS[state.scenario];
    const st = steps();
    const cur = st[Math.min(state.step, st.length - 1)];

    // 场景选择
    rootEl.appendChild(Viz.card('fa-diagram-project', '选一个场景', sc.desc,
        Viz.segmented({
            value: state.scenario,
            options: Object.keys(HS.SCENARIOS).map((k) => ({ v: k, label: HS.SCENARIOS[k].name })),
            onPick: (v) => { state.scenario = v; state.step = 0; render(); },
        })
    ));

    // 时序图
    const nav = h('div.seq-nav', null,
        h('button.mini', {
            onclick: () => { state.step = Math.max(0, state.step - 1); render(); },
        }, '← 上一步'),
        h('span.seq-progress', { text: `${state.step + 1} / ${st.length}` }),
        h('button.mini.primary', {
            onclick: () => { state.step = Math.min(st.length - 1, state.step + 1); render(); },
        }, '下一步 →'),
        h('button.mini', { onclick: () => { state.step = st.length - 1; render(); } }, '全部展开'),
        h('button.mini', { onclick: () => { state.step = 0; render(); } }, '重来')
    );

    rootEl.appendChild(Viz.card('fa-timeline', '时序与状态迁移',
        '灰色的是还没走到的步骤，点「下一步」推进。'
        + '生命线两侧的方块是<b>此刻的 TCP 状态</b>，橙色高亮的是最容易被追问的两个。',
        buildSeq(), nav,
        h('div.seq-note', { html: '<b>第 ' + (state.step + 1) + ' 步：</b>' + cur.note })
    ));

    // 场景专属深挖
    if (state.scenario === 'close') rootEl.appendChild(buildCloseDeep());
    if (state.scenario === 'open') rootEl.appendChild(buildOpenDeep());

    // 面试
    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa(QA[state.scenario])));
}

function buildOpenDeep() {
    return Viz.card('fa-key', '为什么恰好是三次？',
        '标准答案：<b>让通信双方各自确认「自己的发送能力」和「对方的发送能力」都正常</b>，'
        + '三次是达成这个目标的最小次数。',
        Viz.flowList([
            { t: '第 1 次（客户端 → 服务端）', f: '服务端收到 SYN 后能确认：', r: '客户端的「发」正常，服务端的「收」正常' },
            { t: '第 2 次（服务端 → 客户端）', f: '客户端收到 SYN+ACK 后能确认：', r: '自己的「发」和「收」都正常，服务端的「发」和「收」也都正常' },
            {
                t: '第 3 次（客户端 → 服务端）', f: '服务端收到 ACK 后才能确认：', r: '服务端自己的「发」正常，客户端的「收」正常',
                hi: '走完第二次时，<b>客户端已经全部确认完毕，但服务端还缺一半</b>。'
                    + '所以第三次是给服务端补齐的 —— 少一次不行，多一次没必要。',
            },
        ])
    );
}

function buildCloseDeep() {
    return Viz.card('fa-hourglass-half', 'TIME_WAIT 与 CLOSE_WAIT：面试重灾区',
        '这两个状态名字像，含义和排查方向完全相反。',
        Viz.cmpGrid([
            { h: 'TIME_WAIT', v: '主动关闭方', d: '等 2MSL 后才关闭', cls: 'cmp-save' },
            { h: 'CLOSE_WAIT', v: '被动关闭方', d: '收到 FIN 但自己还没 close()', cls: 'cmp-bad' },
        ]),
        Viz.pitfalls([
            ['TIME_WAIT 为什么要等 2MSL（约 1~4 分钟）',
                '<b>两个理由。</b>① 最后那个 ACK 可能丢失，对方会重发 FIN，'
                + '留在 TIME_WAIT 才有机会补发 ACK，否则对方会收到 RST。'
                + '② 让本次连接产生的所有报文在网络中自然消亡，'
                + '避免它们被误认成<b>下一个复用了相同四元组的新连接</b>的数据。'
                + 'MSL 是报文最大生存时间，一来一回所以是 2MSL。'],
            ['服务器上大量 TIME_WAIT 怎么办',
                '说明是<b>你这台机器在主动关连接</b>（常见于短连接的反向代理、爬虫）。'
                + '端口会被占住导致无法建新连接。解法：开启 <code>tcp_tw_reuse</code>（客户端侧安全）、'
                + '用长连接 / 连接池、扩大端口范围。<b>不要用 <code>tcp_tw_recycle</code></b>，'
                + 'NAT 环境下会导致丢包，Linux 4.12 后已被移除。'],
            ['大量 CLOSE_WAIT 一定是代码 bug',
                '这个更严重。CLOSE_WAIT 意味着<b>对方已经关了，而你的程序没有调用 close()</b> —— '
                + '几乎总是应用层没有正确关闭连接（忘了 close、异常路径漏了、连接池泄漏）。'
                + '它不会自己消失，会一直堆到文件描述符耗尽。看到它就去查代码，不要去调内核参数。'],
            ['为什么挥手是四次，握手是三次',
                '握手时服务端的 SYN 和 ACK 可以合并（它没什么要「说完」的）；'
                + '挥手时收到 FIN 只代表<b>对方不发了</b>，自己可能还有数据要发，'
                + '所以 ACK 必须先发、FIN 等数据发完再发，无法合并。'
                + '如果服务端确实没数据了，内核也可能把 ACK 和 FIN 合并 —— <b>那就变成三次挥手</b>，这是允许的。'],
        ])
    );
}

const QA = {
    open: [
        { q: 'SYN 洪泛攻击是什么？怎么防？', a: '攻击者伪造大量源 IP 发 SYN 但不回第三次 ACK，服务端在 SYN_RCVD 状态积压半连接队列直到耗尽。防御：<b>SYN Cookie</b>（不分配资源，把状态编码进序号里）、增大半连接队列、缩短 SYN+ACK 重试次数。' },
        { q: '初始序号 ISN 为什么是随机的？', a: '防止旧连接的报文被误收（同四元组复用时序号冲突），以及防止攻击者猜测序号伪造报文注入数据。ISN 通常基于时钟 + 四元组哈希生成。' },
        { q: '第三次握手可以携带数据吗？', a: '<b>可以。</b>第一次不行（还没验证对方存在，否则易被放大攻击）。TCP Fast Open（TFO）更进一步，让第一次握手就能带数据，靠的是首次连接时服务端下发的 cookie。' },
    ],
    twoWay: [
        { q: '两次握手到底哪里不行？', a: '服务端<b>无法确认客户端是否真的收到了自己的 SYN+ACK</b>。滞留的历史 SYN 会让服务端单方面建连并分配资源，客户端却毫不知情，造成资源浪费。三次握手让客户端有机会拒绝。' },
        { q: '四次握手行不行？', a: '行，但没必要。服务端的 ACK 和 SYN 之间没有任何需要等待的事情，合并成一个包即可，多一次纯属浪费一个 RTT。' },
    ],
    close: [
        { q: '可以三次挥手吗？', a: '<b>可以。</b>如果被动关闭方收到 FIN 时正好也没有数据要发了，内核可以把 ACK 和 FIN 合并成一个包发出，就变成三次。这恰好也反证了「四次」的原因是中间要留出发数据的时间。' },
        { q: 'TIME_WAIT 在哪一端？', a: '在<b>主动关闭方</b>。谁先调 close() 谁进 TIME_WAIT。HTTP 短连接场景下，如果是服务端主动关，TIME_WAIT 就堆在服务端。' },
        { q: '如果最后一个 ACK 丢了会怎样？', a: '被动关闭方停在 LAST_ACK，超时后重发 FIN；主动关闭方在 TIME_WAIT 期间收到重发的 FIN，会重新发 ACK 并重置 2MSL 计时器。这正是 TIME_WAIT 存在的第一个理由。' },
    ],
};

Viz.register({
    id: 'tcp-handshake',
    cat: 'net',
    title: '三次握手 / 四次挥手',
    subtitle: '状态机 · TIME_WAIT · CLOSE_WAIT',
    icon: 'fa-handshake',
    blurb: '状态怎么迁移，为什么不是两次，两个 WAIT 到底卡在哪',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.scenario = 'open'; state.step = 0;
        render();
    },
    unmount() { rootEl = null; },
});

})();
