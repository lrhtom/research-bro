// ============================================================
//  演示：死锁
//  用资源分配图把「成环」这件事一步步画出来，四个必要条件做成可以逐个点掉的开关。
//  最重要的一点：教科书那句「有环就死锁」只在<每类资源只有 1 个实例>时成立。
//  资源有多个实例时，有环照样可能存在安全序列 —— 这里构造了具体例子。
//  第三部分是银行家算法，顺带点破「不安全 ≠ 已经死锁」。
//  上半 DL.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const DL = {};

// ========== 1) 资源分配图 ==========

/**
 * 图的结构：
 *   procs: ['P1','P2',...]
 *   res:   [{ id:'R1', n: 实例个数 }, ...]
 *   edges: [{ from, to, kind }]
 *          kind='request' 时 from 是进程、to 是资源（虚线，我想要）
 *          kind='assign'  时 from 是资源、to 是进程（实线，已经给你了）
 */

/** DFS 找一个有向环，返回 ['A','B',...,'A']，没有环返回 null */
DL.findCycle = function (graph) {
    const adj = {};
    graph.edges.forEach((e) => { (adj[e.from] || (adj[e.from] = [])).push(e.to); });
    const color = {}, parent = {};
    let cycle = null;

    function dfs(u) {
        color[u] = 1;
        const nb = adj[u] || [];
        for (let i = 0; i < nb.length; i++) {
            if (cycle) return;
            const v = nb[i];
            if (!color[v]) { parent[v] = u; dfs(v); }
            else if (color[v] === 1) {
                const path = [];
                let x = u;
                while (x !== v) { path.push(x); x = parent[x]; }
                path.push(v);
                path.reverse();
                path.push(v);
                cycle = path;
                return;
            }
        }
        color[u] = 2;
    }

    const nodes = graph.procs.concat(graph.res.map((r) => r.id));
    for (let i = 0; i < nodes.length && !cycle; i++) if (!color[nodes[i]]) dfs(nodes[i]);
    return cycle;
};

/**
 * 图归约（graph reduction）—— 判死锁的正确方法，多实例资源也适用。
 * 反复找「当前请求都能被满足」的进程，让它跑完、把资源全还回来。
 * 全部归约掉 = 没死锁；剩下的那些就是真的死锁了。
 */
DL.reduce = function (graph) {
    const avail = {}, alloc = {}, req = {};
    graph.res.forEach((r) => { avail[r.id] = r.n; });
    graph.procs.forEach((p) => { alloc[p] = {}; req[p] = {}; });
    graph.edges.forEach((e) => {
        if (e.kind === 'assign') {
            alloc[e.to][e.from] = (alloc[e.to][e.from] || 0) + 1;
            avail[e.from]--;
        } else {
            req[e.from][e.to] = (req[e.from][e.to] || 0) + 1;
        }
    });

    const order = [], steps = [];
    const left = graph.procs.slice();
    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < left.length; i++) {
            const p = left[i];
            const keys = Object.keys(req[p]);
            const canRun = keys.every((r) => avail[r] >= req[p][r]);
            if (!canRun) continue;
            const before = Object.assign({}, avail);
            Object.keys(alloc[p]).forEach((r) => { avail[r] += alloc[p][r]; });
            steps.push({
                p, wants: Object.assign({}, req[p]), holds: Object.assign({}, alloc[p]),
                availBefore: before, availAfter: Object.assign({}, avail),
            });
            order.push(p);
            left.splice(i, 1);
            changed = true;
            break;
        }
    }
    return { order, blocked: left, deadlock: left.length > 0, steps, avail };
};

/** 一句话结论：有没有环、是不是真死锁、两者是否不一致 */
DL.analyze = function (graph) {
    const cycle = DL.findCycle(graph);
    const red = DL.reduce(graph);
    return {
        cycle,
        hasCycle: !!cycle,
        deadlock: red.deadlock,
        blocked: red.blocked,
        order: red.order,
        steps: red.steps,
        // 单实例资源下「有环 ⟺ 死锁」；多实例下只有「死锁 ⇒ 有环」这一半成立
        allSingle: graph.res.every((r) => r.n === 1),
        surprise: !!cycle && !red.deadlock,
    };
};

// ========== 2) 四个必要条件 ==========

DL.CONDITIONS = [
    { id: 'mutex', name: '互斥', desc: '一个资源同一时刻只能被一个进程占有' },
    { id: 'holdWait', name: '占有并等待', desc: '手里攥着已有的，同时伸手要新的' },
    { id: 'noPreempt', name: '不可剥夺', desc: '别人手里的东西抢不过来，只能等它自己放' },
    { id: 'circular', name: '循环等待', desc: '存在一条首尾相接的等待链' },
];

/**
 * 按某个交错顺序重放一段进程/资源申请，可以逐个关掉四个必要条件。
 *
 * scn = {
 *   res: [{id,n}],
 *   procs: [{ id, seq: ['R1','R2'] }],   // 它按顺序想要哪些资源
 *   interleave: ['P1','P2','P1','P2'],   // 轮到谁发下一个请求
 * }
 * cond = { mutex, holdWait, noPreempt, circular }  —— true 表示这个条件成立（没被破坏）
 */
DL.simulate = function (scn, cond) {
    cond = Object.assign({ mutex: true, holdWait: true, noPreempt: true, circular: true }, cond || {});

    // 破坏「互斥」= 资源可共享，实例数按进程数给足
    const cap = {};
    scn.res.forEach((r) => { cap[r.id] = cond.mutex ? r.n : scn.procs.length; });
    const avail = Object.assign({}, cap);

    // 破坏「循环等待」= 全局给资源编号，所有进程一律按编号从小到大申请
    const seqOf = {};
    scn.procs.forEach((p) => {
        const s = p.seq.slice();
        if (!cond.circular) s.sort();
        seqOf[p.id] = s;
    });

    const alloc = {}, blockedOn = {};
    scn.procs.forEach((p) => { alloc[p.id] = {}; blockedOn[p.id] = null; });
    const steps = [];

    if (!cond.holdWait) {
        // 破坏「占有并等待」= 一次性把要的全申请了，拿不全就一个也不拿
        const order = [];
        scn.interleave.forEach((pid) => { if (order.indexOf(pid) < 0) order.push(pid); });
        order.forEach((pid) => {
            const need = seqOf[pid];
            if (need.every((r) => avail[r] >= 1)) {
                need.forEach((r) => { avail[r]--; alloc[pid][r] = 1; });
                steps.push({ p: pid, r: need.join(' + '), kind: 'all',
                    text: pid + ' 一次性申请 ' + need.join(' + ') + '，全部到手，开始执行' });
                need.forEach((r) => { avail[r]++; delete alloc[pid][r]; });
                steps.push({ p: pid, r: '', kind: 'release',
                    text: pid + ' 执行完毕，把 ' + need.join('、') + ' 全还回去' });
            } else {
                steps.push({ p: pid, r: need.join(' + '), kind: 'waitnone',
                    text: pid + ' 申请不全 → 一个也不拿，空着手等（不占茅坑）' });
            }
        });
    } else {
        const idx = {};
        scn.procs.forEach((p) => { idx[p.id] = 0; });
        scn.interleave.forEach((pid) => {
            if (blockedOn[pid]) return;                 // 已经卡住的进程发不出新请求
            const s = seqOf[pid];
            if (idx[pid] >= s.length) return;
            const r = s[idx[pid]];
            const holding = Object.keys(alloc[pid]);
            if (avail[r] >= 1) {
                avail[r]--;
                alloc[pid][r] = (alloc[pid][r] || 0) + 1;
                idx[pid]++;
                steps.push({ p: pid, r, kind: 'granted', text: pid + ' 申请 ' + r + '　→　拿到了' });
            } else {
                blockedOn[pid] = r;
                steps.push({
                    p: pid, r, kind: 'blocked',
                    text: pid + ' 申请 ' + r + '　→　被别人占着，只能等'
                        + (holding.length ? '（而它手里还攥着 ' + holding.join('、') + ' 不放）' : ''),
                });
            }
        });
    }

    // 组图
    const graph = { procs: scn.procs.map((p) => p.id), res: scn.res.map((r) => ({ id: r.id, n: cap[r.id] })), edges: [] };
    scn.procs.forEach((p) => {
        Object.keys(alloc[p.id]).forEach((r) => {
            for (let k = 0; k < alloc[p.id][r]; k++) graph.edges.push({ from: r, to: p.id, kind: 'assign' });
        });
        if (blockedOn[p.id]) graph.edges.push({ from: p.id, to: blockedOn[p.id], kind: 'request' });
    });

    let an = DL.analyze(graph);
    let preempted = null;

    // 破坏「不可剥夺」= 死锁了就直接抢一个回来
    if (!cond.noPreempt && an.deadlock) {
        const victim = an.blocked[0];
        const freed = Object.keys(alloc[victim]);
        graph.edges = graph.edges.filter((e) => !(e.kind === 'assign' && e.to === victim));
        steps.push({
            p: victim, r: freed.join('、'), kind: 'preempt',
            text: '检测到死锁 → 直接剥夺 ' + victim + ' 手里的 ' + freed.join('、')
                + '（回滚它，稍后重来），环立刻断开',
        });
        an = DL.analyze(graph);
        preempted = victim;
    }

    return { steps, graph, analysis: an, cond, preempted, cap };
};

// ========== 3) 银行家算法 ==========

/** 当前可用 = 总量 - 已分配 */
DL.available = function (st) {
    const m = st.total.length;
    const av = st.total.slice();
    st.alloc.forEach((row) => { for (let j = 0; j < m; j++) av[j] -= row[j]; });
    return av;
};

/** Need = Max - Allocation */
DL.needOf = function (st) {
    return st.alloc.map((row, i) => row.map((v, j) => st.max[i][j] - v));
};

/**
 * 安全性检查：找一个安全序列。
 * 返回 { safe, sequence（下标数组）, steps, need, available }
 */
DL.banker = function (st) {
    const n = st.alloc.length, m = st.total.length;
    const need = DL.needOf(st);
    const available = DL.available(st);
    const work = available.slice();
    const finish = new Array(n).fill(false);
    const sequence = [], steps = [];

    let changed = true;
    while (changed) {
        changed = false;
        for (let i = 0; i < n; i++) {
            if (finish[i]) continue;
            let fit = true;
            for (let j = 0; j < m; j++) if (need[i][j] > work[j]) { fit = false; break; }
            if (!fit) continue;
            const before = work.slice();
            for (let j = 0; j < m; j++) work[j] += st.alloc[i][j];
            finish[i] = true;
            sequence.push(i);
            steps.push({
                p: i, need: need[i].slice(), alloc: st.alloc[i].slice(),
                workBefore: before, workAfter: work.slice(),
            });
            changed = true;
            break;
        }
    }
    return {
        safe: finish.every(Boolean), sequence, steps, need, available,
        stuck: finish.map((f, i) => (f ? -1 : i)).filter((i) => i >= 0),
    };
};

/**
 * 试探性分配：进程 i 请求 req，能不能批？
 * 三道关：不能超 Need → 不能超 Available → 试着分下去之后必须仍然「安全」
 */
DL.bankerRequest = function (st, i, req) {
    const need = DL.needOf(st)[i];
    const avail = DL.available(st);
    const m = st.total.length;
    for (let j = 0; j < m; j++) {
        if (req[j] > need[j]) {
            return { granted: false, reason: 'over-max', need, avail,
                why: '请求量超过了它当初声明的最大需求（第 ' + (j + 1) + ' 类）—— 直接报错，这是进程自己的 bug' };
        }
    }
    for (let j = 0; j < m; j++) {
        if (req[j] > avail[j]) {
            return { granted: false, reason: 'not-available', need, avail,
                why: '现在根本没这么多资源（第 ' + (j + 1) + ' 类不够）—— 让它等着，这不是不安全，只是暂时没货' };
        }
    }
    const trial = {
        total: st.total.slice(),
        max: st.max.map((r) => r.slice()),
        alloc: st.alloc.map((r) => r.slice()),
        names: st.names, resNames: st.resNames,
    };
    for (let j = 0; j < m; j++) trial.alloc[i][j] += req[j];
    const safety = DL.banker(trial);
    return {
        granted: safety.safe, reason: safety.safe ? 'safe' : 'unsafe',
        need, avail, trial, safety,
        why: safety.safe
            ? '试着分下去之后仍然能找出一条安全序列 → 批准'
            : '试着分下去之后再也找不出安全序列了 → 拒绝，让它等（注意：此刻并没有死锁）',
    };
};

/** 教科书那个经典例子（Silberschatz），手算答案可查 */
DL.CLASSIC = {
    resNames: ['A', 'B', 'C'],
    names: ['P0', 'P1', 'P2', 'P3', 'P4'],
    total: [10, 5, 7],
    alloc: [[0, 1, 0], [2, 0, 0], [3, 0, 2], [2, 1, 1], [0, 0, 2]],
    max: [[7, 5, 3], [3, 2, 2], [9, 0, 2], [2, 2, 2], [4, 3, 3]],
};

if (typeof module !== 'undefined' && module.exports) module.exports = DL;
if (typeof window !== 'undefined') window.DLModel = DL;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

// 主场景：两个进程，两把锁，交叉着拿
const SCENARIOS = {
    two: {
        name: '两个事务交叉加锁',
        note: 'P1 先锁 A 再锁 B，P2 先锁 B 再锁 A —— 数据库死锁里最常见的一种。',
        res: [{ id: 'R1', n: 1 }, { id: 'R2', n: 1 }],
        procs: [{ id: 'P1', seq: ['R1', 'R2'] }, { id: 'P2', seq: ['R2', 'R1'] }],
        interleave: ['P1', 'P2', 'P1', 'P2'],
    },
    three: {
        name: '三个进程绕一圈',
        note: '每个人都只等下一个人手里的东西，绕成一个圈 —— 环长 3，更难在日志里看出来。',
        res: [{ id: 'R1', n: 1 }, { id: 'R2', n: 1 }, { id: 'R3', n: 1 }],
        procs: [
            { id: 'P1', seq: ['R1', 'R2'] },
            { id: 'P2', seq: ['R2', 'R3'] },
            { id: 'P3', seq: ['R3', 'R1'] },
        ],
        interleave: ['P1', 'P2', 'P3', 'P1', 'P2', 'P3'],
    },
};

// 打脸用的两张固定图
const CYCLE_DEADLOCK = {
    procs: ['P1', 'P2'],
    res: [{ id: 'R1', n: 1 }, { id: 'R2', n: 1 }],
    edges: [
        { from: 'R1', to: 'P1', kind: 'assign' },
        { from: 'P1', to: 'R2', kind: 'request' },
        { from: 'R2', to: 'P2', kind: 'assign' },
        { from: 'P2', to: 'R1', kind: 'request' },
    ],
};

// 教科书里那个「有环但不死锁」的例子：R2 有两个实例，其中一个在 P4 手上，而 P4 谁也不等
const CYCLE_NO_DEADLOCK = {
    procs: ['P1', 'P3', 'P4'],
    res: [{ id: 'R1', n: 1 }, { id: 'R2', n: 2 }],
    edges: [
        { from: 'P1', to: 'R1', kind: 'request' },
        { from: 'R1', to: 'P3', kind: 'assign' },
        { from: 'P3', to: 'R2', kind: 'request' },
        { from: 'R2', to: 'P1', kind: 'assign' },
        { from: 'R2', to: 'P4', kind: 'assign' },
    ],
};

const state = {
    scn: 'two',
    cond: { mutex: true, holdWait: true, noPreempt: true, circular: true },
    step: -1,
    bankerStage: 0,     // 0 初始 / 1 批准了 P1 的请求 / 2 试探 P0 的请求
};

let rootEl = null;

// ---------- 资源分配图绘制 ----------

function drawGraph(graph, an, opt) {
    opt = opt || {};
    const W = opt.w || 700, H = opt.h || 300;
    const cx = W / 2, cy = H / 2 + 4;
    const R = Math.min(W, H) / 2 - 52;

    // 交替排布进程和资源，环画出来才好看
    const order = [];
    const ps = graph.procs.slice(), rs = graph.res.slice();
    while (ps.length || rs.length) {
        if (ps.length) order.push({ id: ps.shift(), type: 'p' });
        if (rs.length) { const r = rs.shift(); order.push({ id: r.id, type: 'r', n: r.n }); }
    }
    const pos = {};
    order.forEach((nd, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / order.length;
        pos[nd.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), type: nd.type, n: nd.n };
    });

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'dl-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '资源分配图',
    });

    const defs = svg('defs');
    [['dl-ar-req', '#94a3b8'], ['dl-ar-asg', '#4f46e5'], ['dl-ar-cyc', '#ef4444']].forEach(([id, c]) => {
        const m = svg('marker', {
            id, viewBox: '0 0 9 9', refX: 8.5, refY: 4.5,
            markerWidth: 6, markerHeight: 6, orient: 'auto',
        });
        m.appendChild(svg('path', { d: 'M0 0 L9 4.5 L0 9 Z', fill: c }));
        defs.appendChild(m);
    });
    root.appendChild(defs);

    // 环上的边集合
    const cycEdge = new Set();
    if (an && an.cycle) {
        for (let i = 0; i + 1 < an.cycle.length; i++) cycEdge.add(an.cycle[i] + '>' + an.cycle[i + 1]);
    }

    const rad = (id) => (pos[id].type === 'p' ? 24 : 27);

    graph.edges.forEach((e) => {
        const a = pos[e.from], b = pos[e.to];
        if (!a || !b) return;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len, uy = dy / len;
        const x1 = a.x + ux * rad(e.from), y1 = a.y + uy * rad(e.from);
        const x2 = b.x - ux * (rad(e.to) + 7), y2 = b.y - uy * (rad(e.to) + 7);
        const onCycle = cycEdge.has(e.from + '>' + e.to);
        const cls = onCycle ? 'dl-edge-cyc' : (e.kind === 'request' ? 'dl-edge-req' : 'dl-edge-asg');
        const mk = onCycle ? 'dl-ar-cyc' : (e.kind === 'request' ? 'dl-ar-req' : 'dl-ar-asg');
        root.appendChild(svg('line', {
            x1, y1, x2, y2, class: cls, 'marker-end': 'url(#' + mk + ')',
        }));
    });

    order.forEach((nd) => {
        const p = pos[nd.id];
        const inCycle = an && an.cycle && an.cycle.indexOf(nd.id) >= 0;
        const isBlocked = an && an.blocked && an.blocked.indexOf(nd.id) >= 0;
        if (nd.type === 'p') {
            root.appendChild(svg('circle', {
                cx: p.x, cy: p.y, r: 24,
                class: 'dl-proc' + (isBlocked ? ' dl-dead' : '') + (inCycle && !isBlocked ? ' dl-cyc' : ''),
            }));
            const t = svg('text', { x: p.x, y: p.y + 4.5, class: 'dl-proc-t', 'text-anchor': 'middle' });
            t.textContent = nd.id;
            root.appendChild(t);
        } else {
            root.appendChild(svg('rect', {
                x: p.x - 26, y: p.y - 22, width: 52, height: 44, rx: 7,
                class: 'dl-res' + (inCycle ? ' dl-cyc' : ''),
            }));
            const t = svg('text', { x: p.x, y: p.y - 4, class: 'dl-res-t', 'text-anchor': 'middle' });
            t.textContent = nd.id;
            root.appendChild(t);
            // 实例小圆点：实心 = 已被占，空心 = 还有富余
            const used = graph.edges.filter((e) => e.kind === 'assign' && e.from === nd.id).length;
            const n = nd.n;
            const gap = 11;
            for (let k = 0; k < n; k++) {
                root.appendChild(svg('circle', {
                    cx: p.x - ((n - 1) * gap) / 2 + k * gap, cy: p.y + 9, r: 3.6,
                    class: k < used ? 'dl-inst dl-inst-used' : 'dl-inst',
                }));
            }
        }
    });

    return root;
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const scn = SCENARIOS[state.scn];
    const sim = DL.simulate(scn, state.cond);
    const an = sim.analysis;
    const brokenList = DL.CONDITIONS.filter((c) => !state.cond[c.id]);

    // ── 场景 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-lock"></i> 场景：两个人互相攥着对方要的东西' }),
        h('p.sec-note', {
            html: '死锁不是「卡住了」，是<b>一组进程互相等着对方手里的资源，谁也不肯先放</b>，'
                + '于是永远等下去 —— 没有外力介入的话，这个状态是稳定的、不会自己好。<br>'
                + '下面这张图叫<b>资源分配图</b>：圆圈是进程，方块是资源（里面的小点是实例个数），'
                + '<b>实线 = 已经分给你了</b>（资源→进程），<b>虚线 = 我还想要</b>（进程→资源）。',
        }),
        Viz.segmented({
            options: Object.keys(SCENARIOS).map((k) => ({ v: k, label: SCENARIOS[k].name })),
            value: state.scn,
            onPick: (v) => { state.scn = v; render(); },
        }),
        h('p.sec-note', { html: scn.note })
    ));

    // ── 四条件开关 ──
    const sw = h('div.dl-conds');
    DL.CONDITIONS.forEach((c) => {
        const on = state.cond[c.id];
        sw.appendChild(h('button.dl-cond' + (on ? '.on' : '.off'), {
            onclick: () => { state.cond[c.id] = !state.cond[c.id]; render(); },
        },
            h('div.dl-cond-h', null,
                h('i', { class: 'fas ' + (on ? 'fa-toggle-on' : 'fa-toggle-off') }),
                h('b', { text: c.name })),
            h('div.dl-cond-d', { text: c.desc }),
            h('div.dl-cond-s', { text: on ? '成立' : '已破坏 →  点回来' })
        ));
    });

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-toggle-on"></i> 四个必要条件 —— 点掉任意一个，同一段序列就不死锁了' }),
        h('p.sec-note', {
            html: '这四条是<b>同时成立才会死锁</b>，所以破坏任意一条就能预防。'
                + '点一下开关，下面的图和步骤会用<b>同一段申请序列</b>重放一遍。',
        }),
        sw,
        h('div.seq-note', { html: condVerdict(sim, brokenList) })
    ));

    // ── 图 + 步骤 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', {
            html: '<i class="fas fa-circle-nodes"></i> 资源分配图'
                + (an.deadlock ? '<span class="dl-badge dl-badge-bad">死锁</span>'
                    : '<span class="dl-badge dl-badge-ok">没死锁</span>'),
        }),
        Viz.legend([
            { cls: 'dl-lg-asg', text: '实线：已分配（资源 → 进程）' },
            { cls: 'dl-lg-req', text: '虚线：正在请求（进程 → 资源）' },
            { cls: 'dl-lg-cyc', text: '红色：环上的边' },
            { cls: 'dl-lg-dead', text: '红圈：真的卡死的进程' },
        ]),
        drawGraph(sim.graph, an),
        h('p.sec-note', { html: '一步步是怎么走到这儿的：' }),
        stepList(sim.steps),
        h('div.seq-note', { html: graphVerdict(an) })
    ));

    // ── 打脸：有环 ≠ 死锁 ──
    const anA = DL.analyze(CYCLE_DEADLOCK);
    const anB = DL.analyze(CYCLE_NO_DEADLOCK);
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻：有环 ≠ 一定死锁' }),
        h('p.sec-note', {
            html: '「资源分配图里有环就是死锁」这句话被抄了无数遍，但它<b>少了一个前提</b>：'
                + '<b>只有每类资源都只有 1 个实例时才成立</b>。'
                + '资源有多个实例时，有环也可能存在安全序列。下面两张图都有环，结局却完全不同。',
        }),
        h('div.dl-two', null,
            cycleCase('每类资源 1 个实例', CYCLE_DEADLOCK, anA,
                'P1 攥着 R1 要 R2，P2 攥着 R2 要 R1。环上每个进程都在等唯一的那个实例，'
                + '而那个实例只能由环里的另一个人释放 —— <b>谁也走不了，真死锁。</b>'),
            cycleCase('R2 有 2 个实例', CYCLE_NO_DEADLOCK, anB,
                '环还是那个环（P1 → R1 → P3 → R2 → P1），但 <b>R2 的第二个实例在 P4 手上，'
                + '而 P4 什么都不等</b>。P4 迟早跑完、释放 R2 → P3 拿到 R2 → P3 跑完释放 R1 → '
                + 'P1 拿到 R1。<b>存在安全序列，不死锁。</b>')
        ),
        h('p.sec-note', { html: '右边这张图的<b>归约过程</b>（这才是判死锁的正确方法）：' }),
        reduceList(anB, CYCLE_NO_DEADLOCK),
        h('div.seq-note', {
            html: '<b>正确的说法是这样两句：</b><br>'
                + '① <b>死锁 ⇒ 一定有环</b>（无环必然无死锁，这半边永远成立，所以「无环」可以放心地当作「安全」）。<br>'
                + '② <b>有环 ⇒ 死锁</b> 只在「每类资源单实例」时成立；多实例时有环只是「可能死锁」，'
                + '要做<b>图归约</b>才能定论。<br>'
                + '面试时把第 ② 条的前提说出来，比背对结论更值钱。',
        })
    ));

    // ── 银行家算法 ──
    rootEl.appendChild(bankerCard());

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: '死锁的四个必要条件？',
                a: '<b>互斥</b>（资源同时只能一个人用）、<b>占有并等待</b>（攥着旧的要新的）、'
                    + '<b>不可剥夺</b>（抢不走别人手里的）、<b>循环等待</b>（等待链首尾相接）。<br>'
                    + '关键在于「<b>必要</b>」两个字：四条<b>同时</b>成立才可能死锁，'
                    + '所以<b>破坏任意一条就能预防</b>。'
                    + '工程上最常用的是破坏「循环等待」—— <b>给资源全局编号，一律按编号从小到大申请</b>，'
                    + '因为它对系统的侵入最小（另外三条要么做不到，要么代价太大）。',
            },
            {
                q: '资源分配图里有环，是不是就死锁了？',
                a: '<b>不一定。</b>只有「每类资源只有 1 个实例」时，有环才等价于死锁。'
                    + '资源有多个实例时，环外可能有个进程持有该资源的另一个实例并且不等任何东西，'
                    + '它跑完一释放，环就自己解开了。'
                    + '通用的判定方法是<b>图归约</b>：反复找出「请求都能被满足」的进程，'
                    + '让它跑完并归还全部资源；能全部归约掉就没死锁，剩下的就是死锁进程。<br>'
                    + '反过来<b>「无环一定无死锁」永远成立</b>，所以环检测可以当成便宜的必要条件先筛一遍。',
            },
            {
                q: '预防、避免、检测恢复，怎么选？',
                a: '<b>预防</b>（破坏四条件之一）：静态、开销为零，但可能严重降低资源利用率 —— '
                    + '按序申请是唯一被广泛采用的一种。<br>'
                    + '<b>避免</b>（银行家算法）：动态判断每次分配后系统是否仍处于安全状态。'
                    + '问题是要预先声明最大需求，而且每次分配都要跑一次 O(n²m) 的安全检查 —— '
                    + '<b>真实操作系统基本不用</b>，它主要活在教材和考试里。<br>'
                    + '<b>检测 + 恢复</b>：让它死，定期跑环检测，发现了就杀一个（回滚事务/杀进程）。'
                    + '<b>数据库走的就是这条路</b> —— InnoDB 默认开 <code>innodb_deadlock_detect</code>，'
                    + '检测到就回滚「代价最小」的那个事务，客户端收到 1213 错误自己重试。<br>'
                    + '还有第四种：<b>鸵鸟策略</b>，装看不见。Linux 内核对普通进程的资源死锁基本就是这态度 —— '
                    + '因为出现概率低，而防它的代价太高。',
            },
            {
                q: '「不安全状态」是不是就是死锁？',
                a: '<b>不是，这是最容易讲错的一个点。</b>'
                    + '安全状态 = 存在<b>某一个</b>顺序，能让所有进程都跑完。'
                    + '不安全状态只是「<b>没法保证</b>一定跑得完」—— '
                    + '如果那些进程实际上没有真的把声明的最大需求全用上，它照样可能顺利结束。<br>'
                    + '三者的包含关系：<b>死锁 ⊂ 不安全 ⊂ 全部状态</b>。'
                    + '银行家算法保守就保守在这里：<b>它把一部分本来能过的状态也拒了</b>，'
                    + '用利用率换确定性。',
            },
            {
                q: '数据库死锁和操作系统死锁有什么不一样？',
                a: '本质一样（都是循环等待），但<b>处理方式完全不同</b>。'
                    + '数据库有「事务回滚」这个大杀器 —— 它天生就能<b>剥夺</b>资源'
                    + '（回滚一个事务，它持有的锁全放掉，数据还能恢复原状），'
                    + '所以第三个条件「不可剥夺」在数据库里是可以破坏的。'
                    + '操作系统里你没法把一个进程写了一半的内存「回滚」，所以只能预防或者干脆杀进程。<br>'
                    + '业务侧的应对：<b>按固定顺序访问多张表/多行</b>（破坏循环等待）、'
                    + '<b>缩短事务</b>（减小交叠窗口）、<b>捕获 1213 错误后重试</b>。',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['死锁和活锁、饥饿是三件事',
             '<b>死锁</b>：都不动了，状态稳定。<b>活锁</b>：都在动，但一直在互相让路，谁也没进展'
             + '（两个人在走廊里反复左右躲闪）—— CPU 100% 却没有任何产出，比死锁更难查。'
             + '<b>饥饿</b>：别人都能跑，就某个倒霉蛋一直排不上队（优先级调度下的低优先级线程）。'
             + '死锁检测器<b>抓不到</b>后两种。'],
            ['「按序加锁」在代码里比想象中难做对',
             '规则本身简单（全局排个序，一律从小到大申请），难的是<b>落地</b>：'
             + '锁可能藏在框架里、藏在回调里、藏在别人写的函数里。'
             + '常见的失手是「先遍历一个 map 再逐个加锁」—— <b>map 的遍历顺序不保证稳定</b>，'
             + '两次遍历可能给出不同的加锁顺序，环就出来了。要先把 key 排序再加锁。'],
            ['自己等自己也是死锁',
             '<b>不可重入的锁递归加两次</b>，或者同一个事务对同一行先 <code>SELECT ... FOR SHARE</code> '
             + '再 <code>UPDATE</code>（锁升级），都能一个人把自己锁死。'
             + '这种环长度为 1，画在资源分配图上就是一个自环，很多简化版的检测器<b>会漏掉它</b>。'],
            ['死锁检测本身是有代价的',
             '检测算法是 O(进程数 × 资源数) 起步，跑太频繁会拖慢系统，跑太少死锁就要挂很久。'
             + 'MySQL 在高并发短事务场景下，<code>innodb_deadlock_detect</code> 自己会成为热点'
             + '（每个等待的事务都要遍历等待图），'
             + '所以 <b>MySQL 8.0 允许把它关掉</b>、改用 <code>innodb_lock_wait_timeout</code> 超时兜底。'
             + '关掉之后死锁不会被立刻发现，得等超时 —— <b>是拿延迟换吞吐</b>，不是无脑优化。'],
            ['银行家算法在真实系统里几乎没人用',
             '它要求<b>进程预先声明最大需求</b>，而现实中进程根本不知道自己要用多少内存/文件句柄；'
             + '它还假设进程数和资源数固定，而现实是随时有新进程创建。'
             + '所以它的价值主要在<b>教你理解「安全状态」这个概念</b>，'
             + '而不是拿去写代码。别在设计评审里认真提议用它。'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '简化的地方：<br>'
                + '① 「破坏条件」那四个开关不是通用的求解器，而是<b>针对同一段申请序列的具体改写</b>：'
                + '破坏互斥 = 把资源实例数放宽到进程数；破坏占有并等待 = 改成一次性申请，拿不全就一个都不拿；'
                + '破坏不可剥夺 = 检测到死锁就抢走一个进程手里的全部资源；'
                + '破坏循环等待 = 把每个进程的申请顺序按资源编号排序。'
                + '这四种都是教科书上的标准做法，但真实系统里每一种的落地都要复杂得多。<br>'
                + '② 没有模拟时间、调度和实际执行 —— 进程只有「申请」和「被卡住」两种动作，'
                + '也没有模拟锁超时、优先级反转这些真实系统里更常见的问题。<br>'
                + '③ 银行家算法用的是<b>贪心找第一个可满足的进程</b>，'
                + '所以找出来的安全序列不一定和教科书上写的那一条一样 —— '
                + '<b>安全序列通常不唯一，能找到任意一条就说明状态安全。</b>',
        }),
        h('p', {
            html: '银行家那一段的数据来自 Silberschatz《操作系统概念》里的经典例子'
                + '（5 个进程、3 类资源、总量 10/5/7），'
                + '两次请求的结论（P1 请求 (1,0,2) 批准、随后 P0 请求 (0,2,0) 拒绝）也和书上一致，'
                + '可以直接拿来对着课本核。',
        })
    ));
}

function condVerdict(sim, broken) {
    const an = sim.analysis;
    if (!broken.length) {
        return an.deadlock
            ? '四个条件<b>全都成立</b> → 这段序列走完就死锁了。现在随便点掉一个开关试试。'
            : '四个条件都成立，但这段序列恰好没走出死锁 —— <b>四条件是必要条件，不是充分条件</b>，'
              + '满足了也未必真会死，还得看运行时的交错顺序。';
    }
    const names = broken.map((c) => c.name).join('、');
    if (sim.preempted) {
        return '你破坏了「<b>' + names + '</b>」。序列照样走到了成环，'
            + '但系统直接<b>剥夺了 ' + sim.preempted + ' 手里的资源</b>（回滚它，稍后重来），环立刻断开。<br>'
            + '这正是<b>数据库的做法</b> —— 事务回滚天生就是一种剥夺，'
            + 'InnoDB 检测到死锁就选一个「代价最小」的事务回滚掉，客户端收到 1213 自己重试。';
    }
    if (!an.deadlock) {
        return '你破坏了「<b>' + names + '</b>」，同一段序列重放，<b>不再死锁</b> —— '
            + '看下面的步骤列表，每一步都换了走法。'
            + (broken.some((c) => c.id === 'circular')
                ? '<br>注意这里的改法：<b>给资源全局编号，所有进程一律按编号从小到大申请</b>。'
                  + '于是 P2 也变成先要 R1 再要 R2，两个人抢的是同一把「第一把锁」，'
                  + '抢到的那个能一路走完，另一个老老实实排队。'
                  + '<b>这是工程上最常用的一招</b>，因为它不需要改系统，只要改代码约定。'
                : '')
            + (broken.some((c) => c.id === 'holdWait')
                ? '<br>一次性申请的问题是：<b>资源利用率会掉</b>。'
                  + '一个进程可能开头就把整个流程要用的东西全占了，即使它要到很后面才真正用到。'
                  + '而且「要什么」经常得跑起来才知道。'
                : '')
            + (broken.some((c) => c.id === 'mutex')
                ? '<br>破坏互斥听起来最彻底，但<b>大部分资源天生就不能共享</b>'
                  + '（打印机、写锁、独占文件）。能共享的（只读数据）本来也不会死锁。'
                : '');
    }
    return '破坏了「<b>' + names + '</b>」，但这段序列还是走到了死锁 —— 换个场景或者多点掉一个试试。';
}

function graphVerdict(an) {
    if (!an.hasCycle) {
        return '<b>图上没有环</b> → 可以直接断定没有死锁。'
            + '「无环 ⇒ 无死锁」这半边是永远成立的，所以环检测可以当成便宜的第一道筛子。';
    }
    if (an.surprise) {
        return '<b>有环，但归约得下来 → 不是死锁。</b>安全序列：'
            + an.order.join(' → ') + '。这就是下面那一节要讲的事。';
    }
    return '<b>成环了：</b><code>' + an.cycle.join(' → ') + '</code><br>'
        + '环上每个进程都在等下一个手里的东西，而下一个又在等再下一个 —— '
        + '<b>' + an.blocked.join('、') + '</b> 全部卡死，没有外力介入就永远这样了。'
        + (an.allSingle ? '（这里每类资源都只有 1 个实例，所以有环就等于死锁。）' : '');
}

function stepList(steps) {
    const box = h('div.dl-steps');
    steps.forEach((s, i) => {
        box.appendChild(h('div.dl-step.dl-s-' + s.kind, null,
            h('div.dl-step-n', { text: String(i + 1) }),
            h('div.dl-step-t', { text: s.text })
        ));
    });
    if (!steps.length) box.appendChild(h('p.flow-empty', { text: '（这个组合下没有产生任何申请动作）' }));
    return box;
}

function cycleCase(title, graph, an, note) {
    return h('div.dl-case' + (an.deadlock ? '.bad' : '.ok'), null,
        h('div.dl-case-h', null,
            h('b', { text: title }),
            h('span.dl-badge' + (an.deadlock ? '.dl-badge-bad' : '.dl-badge-ok'), {
                text: an.deadlock ? '死锁' : '不死锁',
            })),
        drawGraph(graph, an, { w: 340, h: 250 }),
        h('div.dl-case-cy', {
            html: '环：<code>' + (an.cycle ? an.cycle.join(' → ') : '无') + '</code>',
        }),
        h('div.dl-case-d', { html: note })
    );
}

function reduceList(an, graph) {
    const box = h('div.flow');
    an.steps.forEach((s, i) => {
        const wants = Object.keys(s.wants);
        const holds = Object.keys(s.holds);
        box.appendChild(h('div.flow-step.lit', null,
            h('div.flow-num', { text: String(i + 1) }),
            h('div.flow-body', null,
                h('div.flow-title', {
                    text: s.p + (wants.length
                        ? ' 想要 ' + wants.map((r) => r + '×' + s.wants[r]).join('、')
                        : ' 什么都不等'),
                }),
                h('code.flow-formula', {
                    text: '可用：' + fmtAvail(s.availBefore)
                        + (holds.length ? '\n它手里有：' + holds.map((r) => r + '×' + s.holds[r]).join('、') : '')
                        + '\n跑完释放后可用：' + fmtAvail(s.availAfter),
                }),
                h('div.flow-result', {
                    text: wants.length
                        ? '请求能被满足 → 让它跑完，资源全还回来'
                        : '它谁也不等，直接就能跑完 —— 关键就在这个人身上',
                })
            )
        ));
    });
    if (an.blocked.length) {
        box.appendChild(h('div.flow-step.lit', null,
            h('div.flow-num', { text: '×' }),
            h('div.flow-body', null,
                h('div.flow-title', { text: '归约不下去了：' + an.blocked.join('、') + ' 卡死' }))
        ));
    }
    return box;
}

function fmtAvail(a) {
    return Object.keys(a).map((k) => k + '=' + a[k]).join('  ');
}

// ---------- 银行家 ----------

function bankerCard() {
    const base = DL.CLASSIC;
    // 阶段 1：P1 请求 (1,0,2)，批准
    const req1 = [1, 0, 2];
    const r1 = DL.bankerRequest(base, 1, req1);
    const afterP1 = r1.granted ? r1.trial : base;
    // 阶段 2：P0 请求 (0,2,0)，在上面那个状态基础上
    const req2 = [0, 2, 0];
    const r2 = DL.bankerRequest(afterP1, 0, req2);

    const cur = state.bankerStage === 0 ? base : afterP1;
    const safety = DL.banker(cur);

    const card = h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-building-columns"></i> 银行家算法：先问「分完之后还安全吗」' }),
        h('p.sec-note', {
            html: '思路像银行放贷：<b>每个客户先声明自己最多要借多少（Max）</b>，'
                + '银行每次收到借款请求时，先<b>假装批了</b>，然后检查「按某个顺序把剩下的钱轮流借出去，'
                + '能不能让所有人都还上」。能就真批，不能就让它等。<br>'
                + '数据用的是教科书那个经典例子，可以对着课本核：5 个进程、3 类资源、总量 A=10 B=5 C=7。',
        }),
        Viz.segmented({
            options: [
                { v: 0, label: '① 初始状态' },
                { v: 1, label: '② P1 请求 (1,0,2)' },
                { v: 2, label: '③ 再来 P0 请求 (0,2,0)' },
            ],
            value: state.bankerStage,
            onPick: (v) => { state.bankerStage = Number(v); render(); },
        }),
        bankerTable(cur, safety)
    );

    if (state.bankerStage === 0) {
        card.appendChild(h('div.seq-note', {
            html: '<b>Available = Total − 已分配 = ' + safety.available.join(' / ') + '</b>（A/B/C）。<br>'
                + '安全性检查从可用量出发，反复找「Need ≤ 当前可用」的进程，'
                + '让它跑完把 Allocation 全还回来，可用量就变大了，于是能带动下一个 —— '
                + '<b>找到一条能覆盖所有进程的顺序，就叫安全状态。</b>',
        }));
        card.appendChild(bankerSeq(safety, base));
    } else if (state.bankerStage === 1) {
        card.appendChild(h('div.dl-req' + (r1.granted ? '.ok' : '.bad'), null,
            h('div.dl-req-h', { text: 'P1 请求 (1, 0, 2)' }),
            h('div.dl-req-v', { text: r1.granted ? '批准 ✅' : '拒绝 ❌' }),
            h('div.dl-req-d', {
                html: '三道关：<br>'
                    + '① Request ≤ Need？ (1,0,2) ≤ (' + r1.need.join(',') + ') —— 过<br>'
                    + '② Request ≤ Available？ (1,0,2) ≤ (' + r1.avail.join(',') + ') —— 过<br>'
                    + '③ 试探分配后还安全吗？ —— ' + Viz.esc(r1.why),
            })
        ));
        card.appendChild(h('p.sec-note', { html: '批准之后新的安全序列：' }));
        card.appendChild(bankerSeq(safety, base));
    } else {
        card.appendChild(h('div.dl-req.bad', null,
            h('div.dl-req-h', { text: '在上一步的基础上，P0 请求 (0, 2, 0)' }),
            h('div.dl-req-v', { text: '拒绝 ❌' }),
            h('div.dl-req-d', {
                html: '① Request ≤ Need？ (0,2,0) ≤ (' + r2.need.join(',') + ') —— 过<br>'
                    + '② Request ≤ Available？ (0,2,0) ≤ (' + r2.avail.join(',') + ') —— '
                    + '<b>过！资源明明是够的</b><br>'
                    + '③ 试探分配后还安全吗？ —— <b>不安全</b>。'
                    + '分完之后 Available 会变成 (' + DL.available(r2.trial).join(',') + ')，'
                    + '这时候<b>没有任何一个进程的 Need 能被满足</b>，'
                    + '安全序列一条都找不出来，所以拒绝。',
            })
        ));
        card.appendChild(h('div.mv-matrix-wrap', null, needTable(r2.trial, r2.safety)));
        card.appendChild(h('div.seq-note', {
            html: '<b>这里必须点破一件事：拒绝的这一刻，系统并没有死锁。</b><br>'
                + '如果真把 (0,2,0) 分给 P0，系统会进入「<b>不安全状态</b>」—— '
                + '意思只是「<b>没法保证</b>所有进程都跑得完」，不是「已经卡住了」。'
                + '实际上如果那几个进程没真的用满它们声明的 Max，照样可能顺利结束。<br>'
                + '三者的包含关系是：<b>死锁 ⊂ 不安全状态 ⊂ 全部状态</b>。'
                + '银行家算法保守就保守在这儿 —— <b>它把一部分本来能过的状态也拒了，'
                + '用资源利用率换「绝不出事」的确定性</b>。'
                + '这也是它在真实系统里没人用的原因之一。',
        }));
    }
    return card;
}

function bankerTable(st, safety) {
    const need = DL.needOf(st);
    const avail = DL.available(st);
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    const rn = st.resNames || DL.CLASSIC.resNames;
    const head = h('tr', null, h('th', { text: '进程' }));
    ['Allocation 已分配', 'Max 最大需求', 'Need 还差多少'].forEach((g) => {
        head.appendChild(h('th', { text: g + '  (' + rn.join(' ') + ')' }));
    });
    head.appendChild(h('th', { text: '能不能直接跑' }));
    tbl.appendChild(head);
    (st.names || DL.CLASSIC.names).forEach((name, i) => {
        const canRun = need[i].every((v, j) => v <= avail[j]);
        tbl.appendChild(h('tr', null,
            h('td.mv-strong', { text: name }),
            h('td.dl-num', { text: st.alloc[i].join('  ') }),
            h('td.dl-num', { text: st.max[i].join('  ') }),
            h('td.dl-num', { text: need[i].join('  ') }),
            h('td' + (canRun ? '.ok' : '.bad'), { text: canRun ? '可以（Need ≤ 可用）' : '不行，得等' })
        ));
    });
    tbl.appendChild(h('tr.on', null,
        h('td.mv-strong', { text: 'Available' }),
        h('td.dl-num', { text: avail.join('  ') }),
        h('td', { text: 'Total = ' + st.total.join('  ') }),
        h('td', { text: '' }),
        h('td' + (safety.safe ? '.ok' : '.bad'), {
            text: safety.safe ? '安全状态' : '不安全状态',
        })
    ));
    wrap.appendChild(tbl);
    return wrap;
}

function needTable(st, safety) {
    const need = DL.needOf(st);
    const avail = DL.available(st);
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '进程' }), h('th', { text: 'Need' }),
        h('th', { text: '当前可用 ' + avail.join(' ') }), h('th', { text: '结论' })
    ));
    (st.names || DL.CLASSIC.names).forEach((name, i) => {
        const canRun = need[i].every((v, j) => v <= avail[j]);
        tbl.appendChild(h('tr', null,
            h('td.mv-strong', { text: name }),
            h('td.dl-num', { text: need[i].join('  ') }),
            h('td.dl-num', { text: avail.join('  ') }),
            h('td.bad', { text: canRun ? '可以跑' : '跑不了' })
        ));
    });
    return tbl;
}

function bankerSeq(safety, base) {
    const names = base.names;
    const box = h('div.flow');
    safety.steps.forEach((s, i) => {
        box.appendChild(h('div.flow-step.lit', null,
            h('div.flow-num', { text: String(i + 1) }),
            h('div.flow-body', null,
                h('div.flow-title', { text: '轮到 ' + names[s.p] + '：Need = (' + s.need.join(', ') + ')' }),
                h('code.flow-formula', {
                    text: 'Need (' + s.need.join(', ') + ')  ≤  Work (' + s.workBefore.join(', ') + ')  ✔\n'
                        + '让它跑完，归还 Allocation (' + s.alloc.join(', ') + ')\n'
                        + 'Work → (' + s.workAfter.join(', ') + ')',
                }),
                h('div.flow-result', { text: '可用量变大了，可以带动下一个' })
            )
        ));
    });
    const seqTxt = safety.sequence.map((i) => names[i]).join(' → ');
    box.appendChild(h('div.seq-note', {
        html: safety.safe
            ? '<b>安全序列：' + seqTxt + '</b><br>'
              + '注意：<b>安全序列通常不止一条</b>，找到任意一条就说明这个状态是安全的。'
              + '（本演示用的是「从上往下找第一个能跑的」，所以给出的顺序可能和你课本上写的那条不同，'
              + '但同样正确。）'
            : '<b>找不出安全序列</b> —— ' + safety.stuck.map((i) => names[i]).join('、') + ' 全都卡住了。',
    }));
    return box;
}

Viz.register({
    id: 'deadlock',
    cat: 'os',
    title: '死锁',
    subtitle: '成环 · 检测 · 银行家算法',
    icon: 'fa-lock',
    blurb: '资源分配图怎么成环，以及「有环就死锁」这句话错在哪',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.scn = 'two';
        state.cond = { mutex: true, holdWait: true, noPreempt: true, circular: true };
        state.bankerStage = 0;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
