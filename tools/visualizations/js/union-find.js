// ============================================================
//  演示：并查集（Union-Find / 不相交集合）
//  两个优化：路径压缩（find 完顺手把整条路径拍到根上）和按秩合并（矮树挂到高树下）。
//  这里把「拍扁」那一下显式画出来 —— 一次 find 之前和之后的树，摆在一起看。
//  打脸：朴素实现会退化成一条长链，n=1000 时累计指针跳转几十万次；
//  两个优化一起上，树高 ≤ 3，跳转次数掉到几千。
//  上半 UF.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const UF = {};

UF.MODES = [
    { id: 'naive', name: '朴素（什么都不做）', rank: false, compress: false },
    { id: 'rank', name: '只按秩合并', rank: true, compress: false },
    { id: 'compress', name: '只路径压缩', rank: false, compress: true },
    { id: 'both', name: '两个一起上', rank: true, compress: true },
];

UF.modeOf = function (id) {
    return UF.MODES.filter((m) => m.id === id)[0] || UF.MODES[0];
};

UF.create = function (n, modeId) {
    const m = UF.modeOf(modeId);
    const parent = [], rank = [];
    for (let i = 0; i < n; i++) { parent.push(i); rank.push(0); }
    return {
        n, parent, rank, mode: m.id, useRank: m.rank, useCompress: m.compress,
        hops: 0,          // 累计指针跳转次数 —— 这就是真正的成本
        writes: 0,        // 路径压缩改写的指针数
        finds: 0, unions: 0,
    };
};

/**
 * 找根。返回 { root, path }，path 是从 x 一路到根经过的所有结点（含根）。
 * 开了路径压缩的话，顺手把这条路上的每个结点直接挂到根上 —— 这就是「拍扁」。
 */
UF.find = function (uf, x) {
    uf.finds++;
    const path = [];
    let r = x;
    while (uf.parent[r] !== r) {
        path.push(r);
        r = uf.parent[r];
        uf.hops++;
    }
    path.push(r);
    if (uf.useCompress) {
        for (let i = 0; i < path.length - 1; i++) {
            if (uf.parent[path[i]] !== r) { uf.parent[path[i]] = r; uf.writes++; }
        }
    }
    return { root: r, path };
};

/** 合并两个集合。返回 { merged, ra, rb, root, pathA, pathB } */
UF.union = function (uf, a, b) {
    const fa = UF.find(uf, a), fb = UF.find(uf, b);
    const ra = fa.root, rb = fb.root;
    if (ra === rb) return { merged: false, ra, rb, root: ra, pathA: fa.path, pathB: fb.path };
    let root;
    if (uf.useRank) {
        // 矮的挂到高的下面，树才不会长歪
        if (uf.rank[ra] < uf.rank[rb]) { uf.parent[ra] = rb; root = rb; }
        else if (uf.rank[ra] > uf.rank[rb]) { uf.parent[rb] = ra; root = ra; }
        else { uf.parent[rb] = ra; uf.rank[ra]++; root = ra; }
    } else {
        // 朴素：不管三七二十一，把 a 的根挂到 b 的根下面 —— 长链就是这么来的
        uf.parent[ra] = rb;
        root = rb;
    }
    uf.unions++;
    return { merged: true, ra, rb, root, pathA: fa.path, pathB: fb.path };
};

/** 只查不改（统计树形时用，不能污染 hops）*/
UF.rootOf = function (parent, x) {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    return r;
};

UF.depthOf = function (parent, x) {
    let d = 0, r = x;
    while (parent[r] !== r) { r = parent[r]; d++; }
    return d;
};

/** 树高、平均深度、连通块个数 */
UF.stats = function (uf) {
    let height = 0, sum = 0, roots = 0;
    for (let i = 0; i < uf.n; i++) {
        const d = UF.depthOf(uf.parent, i);
        if (d > height) height = d;
        sum += d;
        if (uf.parent[i] === i) roots++;
    }
    return { height, avgDepth: uf.n ? sum / uf.n : 0, roots };
};

// ---------- 负载 ----------

/**
 * 负载 ①「退化链」：依次 union(0,1) union(1,2) ... 然后从 0 开始逐个 find。
 * 朴素实现下这会长成一条 n 长的链，find(0) 要走 n-1 步。
 */
UF.chainOps = function (n, findRounds) {
    const ops = [];
    for (let i = 0; i + 1 < n; i++) ops.push({ op: 'union', a: i, b: i + 1 });
    for (let r = 0; r < (findRounds || 1); r++) {
        for (let i = 0; i < n; i++) ops.push({ op: 'find', a: i });
    }
    return ops;
};

/**
 * 负载 ②「锦标赛式成对合并」：union(0,1) union(2,3) … 再 union(0,2) union(4,6) …
 * 这种合并方式下按秩合并也压不住深度（会到 log₂n），只有配上路径压缩才平。
 */
UF.binaryOps = function (n, findRounds) {
    const ops = [];
    for (let step = 1; step < n; step *= 2) {
        for (let i = 0; i + step < n; i += step * 2) ops.push({ op: 'union', a: i, b: i + step });
    }
    for (let r = 0; r < (findRounds || 1); r++) {
        for (let i = 0; i < n; i++) ops.push({ op: 'find', a: i });
    }
    return ops;
};

/** 把一段操作序列在某个策略下跑一遍（可以只跑前 upto 条）*/
UF.replay = function (n, ops, modeId, upto) {
    const uf = UF.create(n, modeId);
    const k = upto == null ? ops.length : Math.max(0, Math.min(upto, ops.length));
    let last = null;
    for (let i = 0; i < k; i++) {
        const o = ops[i];
        if (o.op === 'union') last = { op: 'union', a: o.a, b: o.b, r: UF.union(uf, o.a, o.b) };
        else last = { op: 'find', a: o.a, r: UF.find(uf, o.a) };
    }
    return { uf, last, ran: k, stats: UF.stats(uf) };
};

/** 四种策略跑同一段负载，对照累计跳转次数 */
UF.compareModes = function (n, ops) {
    return UF.MODES.map((m) => {
        const r = UF.replay(n, ops, m.id);
        return {
            id: m.id, name: m.name,
            hops: r.uf.hops, writes: r.uf.writes,
            height: r.stats.height,
            avgDepth: Math.round(r.stats.avgDepth * 100) / 100,
            finds: r.uf.finds, unions: r.uf.unions,
        };
    });
};

// ---------- 反阿克曼函数 α(n) ----------

/**
 * α(n) 的实用取值。用的是最常见的那个简化定义：
 *   α(n)=0 (n≤2)、1 (n=3)、2 (4≤n≤7)、3 (8≤n≤2047)、4 (2048≤n≤2^2048)
 * 2^2048 这个数远远超过可观测宇宙的原子总数（约 10^80 ≈ 2^266），
 * 所以工程上可以直接当成「α(n) ≤ 4，就是个常数」。
 */
UF.alpha = function (n) {
    if (n <= 2) return 0;
    if (n <= 3) return 1;
    if (n <= 7) return 2;
    if (n <= 2047) return 3;
    return 4;   // 一直到 2^2048，够用到宇宙热寂
};

/** 布局：把森林摆成能画的坐标 */
UF.layout = function (uf) {
    const children = [];
    const roots = [];
    for (let i = 0; i < uf.n; i++) children.push([]);
    for (let i = 0; i < uf.n; i++) {
        if (uf.parent[i] === i) roots.push(i);
        else children[uf.parent[i]].push(i);
    }
    const nodes = new Array(uf.n);
    let cursor = 0;
    let maxDepth = 0;

    function place(v, depth) {
        if (depth > maxDepth) maxDepth = depth;
        const kids = children[v];
        if (!kids.length) {
            nodes[v] = { i: v, col: cursor, depth };
            cursor += 1;
            return nodes[v].col;
        }
        const xs = kids.map((c) => place(c, depth + 1));
        const col = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
        nodes[v] = { i: v, col, depth };
        return col;
    }
    roots.forEach((r) => { place(r, 0); cursor += 0.7; });   // 树与树之间留点空

    const edges = [];
    for (let i = 0; i < uf.n; i++) if (uf.parent[i] !== i) edges.push({ from: i, to: uf.parent[i] });
    return { nodes, edges, roots, cols: Math.max(1, cursor), maxDepth };
};

// ---------- Kruskal 最小生成树 ----------

/**
 * 并查集最经典的用途。边按权重排序（同权重按输入顺序，保证确定性），
 * 依次尝试：两端已经连通就跳过（加了会成环），否则并进来。
 */
UF.kruskal = function (n, edges, modeId) {
    const uf = UF.create(n, modeId || 'both');
    const sorted = edges.map((e, i) => ({ u: e.u, v: e.v, w: e.w, i }))
        .sort((a, b) => (a.w - b.w) || (a.i - b.i));
    const steps = [];
    const chosen = [];
    let total = 0;
    sorted.forEach((e) => {
        const ru = UF.rootOf(uf.parent, e.u), rv = UF.rootOf(uf.parent, e.v);
        const take = ru !== rv;
        if (take) { UF.union(uf, e.u, e.v); chosen.push(e); total += e.w; }
        steps.push({
            edge: e, take,
            why: take ? '两端还不连通 → 收下' : '两端已经在同一个集合里 → 加了会成环，跳过',
            groups: UF.stats(uf).roots,
        });
    });
    return { chosen, steps, total, uf, connected: UF.stats(uf).roots === 1, sorted };
};

/** 演示用的固定图（教科书上那张经典的 7 点图）*/
UF.DEMO_GRAPH = {
    names: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    pos: [
        { x: 0.10, y: 0.20 }, { x: 0.38, y: 0.10 }, { x: 0.72, y: 0.12 },
        { x: 0.14, y: 0.78 }, { x: 0.52, y: 0.50 }, { x: 0.40, y: 0.92 },
        { x: 0.88, y: 0.64 },
    ],
    edges: [
        { u: 0, v: 1, w: 7 }, { u: 0, v: 3, w: 5 }, { u: 1, v: 2, w: 8 },
        { u: 1, v: 3, w: 9 }, { u: 1, v: 4, w: 7 }, { u: 2, v: 4, w: 5 },
        { u: 3, v: 4, w: 15 }, { u: 3, v: 5, w: 6 }, { u: 4, v: 5, w: 8 },
        { u: 4, v: 6, w: 9 }, { u: 5, v: 6, w: 11 },
    ],
};

if (typeof module !== 'undefined' && module.exports) module.exports = UF;
if (typeof window !== 'undefined') window.UFModel = UF;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const SMALL_N = 12;

const state = {
    mode: 'naive',
    step: SMALL_N - 1,     // 默认：链刚好建完
    bigN: 1000,
    workload: 'chain',
    kruskalStep: -1,
};

let rootEl = null;

function smallOps() { return UF.chainOps(SMALL_N, 1); }

// ---------- 森林绘制 ----------

function drawForest(uf, opt) {
    opt = opt || {};
    const lay = UF.layout(uf);
    const COLW = Math.min(52, Math.max(26, 640 / Math.max(1, lay.cols)));
    const ROWH = 40;
    const PAD_L = 16, PAD_T = 24;
    const W = 700;
    const H = PAD_T + (lay.maxDepth + 1) * ROWH + 16;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'uf-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': opt.label || '并查集森林',
    });

    if (opt.title) {
        const t = svg('text', { x: 2, y: 13, class: 'uf-title' });
        t.textContent = opt.title;
        root.appendChild(t);
    }

    const X = (col) => PAD_L + col * COLW + COLW / 2;
    const Y = (d) => PAD_T + d * ROWH + 15;

    const hi = {};
    (opt.path || []).forEach((v) => { hi[v] = true; });
    const hiEdge = {};
    for (let i = 0; i + 1 < (opt.path || []).length; i++) hiEdge[opt.path[i]] = true;

    lay.edges.forEach((e) => {
        const a = lay.nodes[e.from], b = lay.nodes[e.to];
        root.appendChild(svg('line', {
            x1: X(a.col), y1: Y(a.depth) - 11, x2: X(b.col), y2: Y(b.depth) + 11,
            class: 'uf-edge' + (hiEdge[e.from] ? ' uf-edge-hi' : ''),
        }));
    });

    lay.nodes.forEach((nd) => {
        if (!nd) return;
        const isRoot = uf.parent[nd.i] === nd.i;
        root.appendChild(svg('circle', {
            cx: X(nd.col), cy: Y(nd.depth), r: 11,
            class: 'uf-node' + (isRoot ? ' uf-root' : '') + (hi[nd.i] ? ' uf-hi' : ''),
        }));
        const t = svg('text', {
            x: X(nd.col), y: Y(nd.depth) + 3.5,
            class: 'uf-node-t' + (hi[nd.i] ? ' uf-hi-t' : ''), 'text-anchor': 'middle',
        });
        t.textContent = String(nd.i);
        root.appendChild(t);
        if (isRoot && uf.useRank) {
            const rk = svg('text', { x: X(nd.col), y: Y(nd.depth) - 15, class: 'uf-rank', 'text-anchor': 'middle' });
            rk.textContent = 'rank ' + uf.rank[nd.i];
            root.appendChild(rk);
        }
    });

    return root;
}

// ---------- Kruskal 图 ----------

function drawGraph(kr, upto) {
    const G = UF.DEMO_GRAPH;
    const W = 700, H = 330, PAD = 34;
    const X = (p) => PAD + p.x * (W - PAD * 2);
    const Y = (p) => PAD + p.y * (H - PAD * 2);
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'uf-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Kruskal 最小生成树',
    });

    const decided = {};
    const shown = upto < 0 ? kr.steps.length : upto;
    for (let i = 0; i < Math.min(shown, kr.steps.length); i++) {
        decided[kr.steps[i].edge.i] = kr.steps[i].take ? 'take' : 'skip';
    }
    const cur = shown > 0 && shown <= kr.steps.length ? kr.steps[shown - 1] : null;

    G.edges.forEach((e, i) => {
        const a = G.pos[e.u], b = G.pos[e.v];
        const st = decided[i];
        const isCur = cur && cur.edge.i === i;
        root.appendChild(svg('line', {
            x1: X(a), y1: Y(a), x2: X(b), y2: Y(b),
            class: 'uf-gedge' + (st === 'take' ? ' uf-gedge-take' : (st === 'skip' ? ' uf-gedge-skip' : ''))
                + (isCur ? ' uf-gedge-cur' : ''),
        }));
        const mx = (X(a) + X(b)) / 2, my = (Y(a) + Y(b)) / 2;
        root.appendChild(svg('circle', {
            cx: mx, cy: my, r: 10,
            class: 'uf-wbg' + (st === 'take' ? ' uf-wbg-take' : (st === 'skip' ? ' uf-wbg-skip' : '')),
        }));
        const t = svg('text', { x: mx, y: my + 3.5, class: 'uf-w', 'text-anchor': 'middle' });
        t.textContent = String(e.w);
        root.appendChild(t);
    });

    // 结点按当前所属集合上色
    const palette = ['#4f46e5', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#ef4444'];
    const uf2 = UF.create(G.names.length, 'both');
    for (let i = 0; i < Math.min(shown, kr.steps.length); i++) {
        if (kr.steps[i].take) UF.union(uf2, kr.steps[i].edge.u, kr.steps[i].edge.v);
    }
    const rootColor = {};
    let ci = 0;
    G.names.forEach((_, i) => {
        const r = UF.rootOf(uf2.parent, i);
        if (rootColor[r] == null) { rootColor[r] = palette[ci % palette.length]; ci++; }
    });

    G.names.forEach((name, i) => {
        const p = G.pos[i];
        const col = rootColor[UF.rootOf(uf2.parent, i)];
        root.appendChild(svg('circle', { cx: X(p), cy: Y(p), r: 17, class: 'uf-gnode', fill: col }));
        const t = svg('text', { x: X(p), y: Y(p) + 5, class: 'uf-gnode-t', 'text-anchor': 'middle' });
        t.textContent = name;
        root.appendChild(t);
    });

    return root;
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const ops = smallOps();
    const step = Math.max(0, Math.min(state.step, ops.length));
    const cur = UF.replay(SMALL_N, ops, state.mode, step);
    const prev = UF.replay(SMALL_N, ops, state.mode, Math.max(0, step - 1));
    const lastOp = step > 0 ? ops[step - 1] : null;

    // ── 场景 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-sitemap"></i> 场景：只关心「这两个东西是不是一伙的」' }),
        h('p.sec-note', {
            html: '并查集只支持两个操作：<code>union(a,b)</code> 把两堆合成一堆，'
                + '<code>find(x)</code> 问 x 属于哪一堆。'
                + '实现方式是<b>用一棵树代表一个集合，树根就是这个集合的代号</b>，'
                + 'find 就是从 x 一路往上爬到根。<br>'
                + '所以<b>树越矮越快</b>。两个优化都是在跟「树长歪」作斗争：'
                + '<b>按秩合并</b>是「事前预防」（矮树挂高树下，别把树接长），'
                + '<b>路径压缩</b>是「事后补救」（既然爬过一遍了，顺手把这条路上的所有结点直接挂到根上）。',
        }),
        Viz.segmented({
            options: UF.MODES.map((m) => ({ v: m.id, label: m.name })),
            value: state.mode,
            onPick: (v) => { state.mode = v; render(); },
        })
    ));

    // ── 森林 + 步进 ──
    const ctl = h('div.controls');
    ctl.appendChild(h('label.ctl.ctl-wide', null,
        h('span.ctl-name', { text: '走到第几步' }),
        h('input', {
            type: 'range', min: '0', max: String(ops.length), step: '1', value: String(step),
            oninput: (e) => { state.step = Number(e.target.value); render(); },
        }),
        h('b.ctl-val', { text: step + ' / ' + ops.length })
    ));
    ctl.appendChild(h('div.ctl-btns', null,
        h('button.mini.danger', {
            onclick: () => { state.step = SMALL_N - 1; render(); },
        }, '① 构造退化链'),
        h('button.mini.primary', {
            onclick: () => { state.step = SMALL_N; render(); },
        }, '② 按一次 find(0)'),
        h('button.mini', {
            onclick: () => { state.step = Math.max(0, step - 1); render(); },
        }, '← 上一步'),
        h('button.mini', {
            onclick: () => { state.step = Math.min(ops.length, step + 1); render(); },
        }, '下一步 →')
    ));

    const forestCard = h('section.card', null,
        h('h3.sec-title', {
            html: '<i class="fas fa-tree"></i> 森林长什么样　'
                + '<span class="uf-badge">树高 ' + cur.stats.height
                + '　平均深度 ' + cur.stats.avgDepth.toFixed(2)
                + '　累计跳转 ' + cur.uf.hops + ' 次</span>',
        }),
        h('p.sec-note', { html: opDesc(lastOp, cur, prev) }),
        ctl
    );

    if (lastOp && lastOp.op === 'find' && cur.last && cur.last.r) {
        // 「拍扁」那一下：find 之前 / 之后 并排
        forestCard.appendChild(h('div.uf-two', null,
            h('div.uf-panel', null, drawForest(prev.uf, {
                title: 'find(' + lastOp.a + ') 之前　—— 要往上爬 '
                    + (cur.last.r.path.length - 1) + ' 步',
                path: cur.last.r.path,
            })),
            h('div.uf-panel', null, drawForest(cur.uf, {
                title: 'find(' + lastOp.a + ') 之后'
                    + (cur.uf.useCompress ? '　—— 整条路被拍到根上了' : '　—— 什么都没变（没开路径压缩）'),
                path: cur.uf.useCompress ? [lastOp.a] : cur.last.r.path,
            }))
        ));
    } else {
        forestCard.appendChild(h('div.uf-panel', null, drawForest(cur.uf, {
            title: '当前森林（' + UF.modeOf(state.mode).name + '）',
            path: cur.last && cur.last.r ? (cur.last.r.pathA || []) : [],
        })));
    }
    forestCard.appendChild(h('div.seq-note', { html: forestVerdict(cur, lastOp) }));
    rootEl.appendChild(forestCard);

    // ── 打脸：大规模跳转次数 ──
    rootEl.appendChild(bigCard());

    // ── α(n) ──
    rootEl.appendChild(alphaCard());

    // ── Kruskal ──
    rootEl.appendChild(kruskalCard());

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: '并查集的两个优化分别解决什么问题？',
                a: '两个都是在防「树长歪」，但方向相反：<br>'
                    + '<b>按秩合并</b>是<b>事前预防</b> —— 合并时把矮的挂到高的下面，'
                    + '这样树高只有在「两棵一样高的树合并」时才会 +1，'
                    + '所以树高最多 O(log n)。<br>'
                    + '<b>路径压缩</b>是<b>事后补救</b> —— 既然已经从 x 爬到根了，'
                    + '顺手把这一路上的每个结点都直接挂到根上，下次这条路只要 1 步。'
                    + '<b>它不需要额外的空间，只是把「反正都要走一遍」的这趟路利用起来。</b><br>'
                    + '注意「秩」不是精确的树高 —— 开了路径压缩以后树会变矮，'
                    + '但 rank 不会跟着减小，它只是树高的一个<b>上界</b>。',
            },
            {
                q: '复杂度到底是多少？',
                a: '<b>只用一个</b>：均摊 O(log n)。'
                    + '（只按秩是<b>最坏</b> O(log n)，只压缩是<b>均摊</b> O(log n)，'
                    + '这两个「log n」的含义还不一样。）<br>'
                    + '<b>两个一起用</b>：均摊 O(α(n))，α 是反阿克曼函数。'
                    + '它增长极慢，<b>在任何现实规模下都 ≤ 4</b> —— '
                    + '所以工程上直接当常数。<br>'
                    + '这个 O(mα(n)) 的界是 Tarjan 证的，而且已经被证明<b>是紧的</b>'
                    + '（存在使它达到这个下界的操作序列），不可能再优化到严格 O(1)。',
            },
            {
                q: '路径压缩有几种写法？',
                a: '<b>完全压缩</b>（本演示用的）：递归或两趟循环，把路径上每个结点都直接指向根。'
                    + '效果最好，但递归写法在链很长时可能爆栈，最好写成两趟循环。<br>'
                    + '<b>路径分裂（splitting）</b>：爬的时候把每个结点指向它的祖父。<br>'
                    + '<b>路径减半（halving）</b>：每隔一个结点指向祖父。<br>'
                    + '后两种<b>只需要一趟循环、代码只多一行</b>，而且理论复杂度和完全压缩一样是 α(n)。'
                    + '实际代码里 halving 用得很多：<br>'
                    + '<code>while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; }</code>',
            },
            {
                q: '并查集能不能撤销（undo）？能不能删除元素？',
                a: '<b>路径压缩之后就不能撤销了</b> —— 它把树结构改得面目全非，没法回退。'
                    + '需要撤销时（比如「可撤销并查集」用于线段树分治、动态图连通性），'
                    + '只能<b>放弃路径压缩、只保留按秩合并</b>，'
                    + '并用一个栈记录每次合并改了哪个指针。复杂度退化成 O(log n)。<br>'
                    + '<b>删除元素</b>标准并查集做不到。'
                    + '常见变通是「墓碑法」：给要删的元素新建一个孤立结点顶替它的位置，'
                    + '老结点留在树里当路由用。',
            },
            {
                q: '实际用在哪儿？',
                a: '<b>Kruskal 最小生成树</b>（判断加这条边会不会成环）—— 下面就有演示。<br>'
                    + '<b>连通性判断</b>：网络中两台机器是否互通、图像的连通区域标记。<br>'
                    + '<b>等价关系维护</b>：编译器的类型推导（合并类型变量）、'
                    + 'LCA 的 Tarjan 离线算法。<br>'
                    + '<b>带权并查集</b>：在 parent 指针上额外挂一个「到父结点的偏移量」，'
                    + '可以维护「a 比 b 大多少」这类关系，'
                    + '经典题是「食物链」和判断一组等式/不等式是否自洽。',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['union 里必须先 find 再合并，不能直接改 parent',
             '<code>parent[a] = b</code> 是错的 —— a 和 b 可能都不是根。'
             + '正确写法是 <code>parent[find(a)] = find(b)</code>。'
             + '这个错误很隐蔽：小数据全对，数据一大就出现「明明连通却查出不连通」。'],
            ['递归写路径压缩会爆栈',
             '<code>find(x) { return p[x]==x ? x : p[x]=find(p[x]); }</code> 很漂亮，'
             + '但在<b>还没被压缩过的长链</b>上递归深度就是链长。'
             + 'n=10⁶ 的退化链直接 stack overflow。'
             + '写成两趟循环（先找根，再回头改指针），或者用路径减半的一趟写法。'],
            ['rank 不是树高，别拿它当树高用',
             '开了路径压缩以后树会变矮，但 rank <b>只增不减</b>，'
             + '所以它只是树高的一个<b>上界</b>。'
             + '如果你的逻辑依赖「知道真实树高」（比如某些带权并查集的推导），'
             + '不能读 rank。<br>'
             + '另一种常见变体是<b>按大小合并</b>（记录集合元素个数），'
             + '效果和按秩一样，而且 size 这个值本身经常有用。'],
            ['「均摊 O(α(n))」不等于「每次操作都很快」',
             '均摊的意思是<b>一长串操作的总时间</b>除以操作数。'
             + '单次 find 完全可能很慢（比如第一次走完一条长链）。'
             + '在有<b>实时性要求</b>的场景（游戏帧循环、实时控制）里，'
             + '这个「偶尔的长尾」是要考虑的。'],
            ['本演示的「跳转次数」不是运行时间',
             '这里数的是<b>指针跳转</b>（爬树的步数），没算路径压缩自己的写入开销，'
             + '也没算 cache miss。'
             + '真实性能里 <b>cache 局部性影响很大</b> —— '
             + '路径压缩会让 parent 数组的访问变得非常随机，'
             + '所以「跳转次数少 10 倍」在实测里往往只快 3~5 倍。'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '简化的地方：<br>'
                + '① 上面那张森林图只有 ' + SMALL_N + ' 个元素，是为了看得清；'
                + '下面的跳转次数对比才是真实规模（可以拖到 ' + '2000' + '）。<br>'
                + '② 「累计跳转次数」只数<b>爬树的步数</b>，不含路径压缩改写指针的开销'
                + '（那部分单独统计成「压缩改写」）。真实耗时还要算上 cache miss，'
                + '这里没有建模。<br>'
                + '③ 路径压缩用的是<b>完全压缩</b>（两趟循环版）。'
                + '路径分裂 / 路径减半的复杂度同样是 α(n)，但森林的形状会不一样，'
                + '本演示没有实现。<br>'
                + '④ α(n) 用的是最常见的那个<b>简化分段定义</b>'
                + '（≤2→0，3→1，≤7→2，≤2047→3，之后→4）。'
                + '反阿克曼函数有好几种等价但不完全相同的定义方式，'
                + '具体分界点会略有出入，<b>但「实际规模下 ≤ 4」这个结论是共识</b>。<br>'
                + '⑤ 没有实现带权并查集、可撤销并查集、按大小合并这些变体。',
        }),
        h('p', {
            html: '所有操作序列都是写死的（没有随机数），'
                + '四种策略跑的是<b>完全相同</b>的序列，所以跳转次数可以直接横向比。',
        })
    ));
}

function opDesc(lastOp, cur, prev) {
    if (!lastOp) {
        return '一开始每个元素自成一个集合（' + SMALL_N + ' 棵单结点的树）。'
            + '点下面的「① 构造退化链」看会发生什么。';
    }
    if (lastOp.op === 'union') {
        return '刚执行了 <code>union(' + lastOp.a + ', ' + lastOp.b + ')</code>。'
            + '当前有 <b>' + cur.stats.roots + '</b> 个集合。';
    }
    return '刚执行了 <code>find(' + lastOp.a + ')</code>，'
        + '往上爬了 <b>' + (cur.uf.hops - prev.uf.hops) + '</b> 步。';
}

function forestVerdict(cur, lastOp) {
    const m = UF.modeOf(state.mode);
    if (state.mode === 'naive') {
        return '<b>朴素实现（<code>parent[find(a)] = find(b)</code>，谁也不管）</b>：'
            + '因为每次都是 union(i, i+1)，新加的元素永远成为新根，'
            + '老的那一整串就挂在它下面 —— <b>树彻底退化成了一条链，树高 '
            + cur.stats.height + '</b>。<br>'
            + '这时候 find(0) 要一路爬 ' + cur.stats.height + ' 步，'
            + '而且<b>爬完什么也没留下，下次还得再爬一遍</b>。'
            + '把上面的策略切成「只路径压缩」，再点「② 按一次 find(0)」，看那一下拍扁。';
    }
    if (state.mode === 'compress') {
        return '<b>只有路径压缩</b>：链照样会形成（因为合并时不挑），'
            + '但<b>只要有人 find 过一次，这条路就永远被拍平了</b>。'
            + '当前树高 ' + cur.stats.height + '。<br>'
            + '这就是路径压缩最漂亮的地方：<b>它不需要额外空间，'
            + '也不需要提前知道什么，只是把「反正都要走的这一趟」顺手利用了</b>。'
            + (lastOp && lastOp.op === 'find'
                ? ' 上面左右两张图就是同一次 find 的前后对比。'
                : ' 点「② 按一次 find(0)」看前后对比。');
    }
    if (state.mode === 'rank') {
        return '<b>只有按秩合并</b>：链根本没机会形成 —— '
            + '每次合并都把矮树挂到高树下，所以这个序列跑完树高只有 '
            + cur.stats.height + '。<br>'
            + '注意根结点上标的 <code>rank</code>：<b>只有两棵秩相同的树合并时，'
            + '秩才会 +1</b>。所以要让秩涨到 k，至少需要 2^k 个元素 —— '
            + '这就是树高 O(log n) 的来源。';
    }
    return '<b>两个一起上</b>：树高 ' + cur.stats.height + '，'
        + '累计跳转 ' + cur.uf.hops + ' 次。'
        + '按秩合并保证树一开始就长不高，路径压缩再把偶尔爬过的路拍平 —— '
        + '<b>这两个优化不是重复劳动，它们的作用互补</b>，'
        + '合起来才有 α(n) 的均摊复杂度。';
}

function bigCard() {
    const n = state.bigN;
    const ops = state.workload === 'chain' ? UF.chainOps(n, 1) : UF.binaryOps(n, 1);
    const cmp = UF.compareModes(n, ops);
    const worst = Math.max.apply(null, cmp.map((c) => c.hops));

    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '元素个数 n', min: 100, max: 2000, step: 100, value: n,
        fmt: (v) => v + ' 个', onInput: (v) => { state.bigN = v; render(); },
    }));
    ctl.appendChild(h('div.ctl-btns', null,
        h('button.mini' + (state.workload === 'chain' ? '.primary' : ''), {
            onclick: () => { state.workload = 'chain'; render(); },
        }, '负载①：退化链'),
        h('button.mini' + (state.workload === 'binary' ? '.primary' : ''), {
            onclick: () => { state.workload = 'binary'; render(); },
        }, '负载②：成对合并')
    ));

    // 柱状图
    const W = 700, rowH = 36, PAD_L = 128, PAD_R = 96, PAD_T = 6;
    const H = PAD_T + cmp.length * rowH + 6;
    const iw = W - PAD_L - PAD_R;
    const sv = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'uf-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '各策略跳转次数',
    });
    cmp.forEach((c, i) => {
        const y = PAD_T + i * rowH;
        const lb = svg('text', { x: PAD_L - 8, y: y + 19, class: 'uf-bar-l', 'text-anchor': 'end' });
        lb.textContent = c.name;
        sv.appendChild(lb);
        sv.appendChild(svg('rect', { x: PAD_L, y: y + 3, width: iw, height: 24, rx: 5, fill: '#f1f3f6' }));
        sv.appendChild(svg('rect', {
            x: PAD_L, y: y + 3, width: Math.max(2, (c.hops / Math.max(1, worst)) * iw), height: 24, rx: 5,
            class: 'uf-bar' + (c.id === 'both' ? ' uf-bar-best' : (c.id === 'naive' ? ' uf-bar-worst' : '')),
        }));
        const vl = svg('text', { x: PAD_L + iw + 6, y: y + 19, class: 'uf-bar-v' });
        vl.textContent = c.hops.toLocaleString('en-US');
        sv.appendChild(vl);
        const sl = svg('text', { x: PAD_L + 8, y: y + 19, class: 'uf-bar-sub' });
        sl.textContent = '树高 ' + c.height + '　平均深度 ' + c.avgDepth;
        sv.appendChild(sl);
    });

    const naive = cmp[0], both = cmp[3];
    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻：n=' + n + ' 时，四种策略差多少' }),
        h('p.sec-note', {
            html: '负载①「退化链」：先 <code>union(0,1) union(1,2) … union(n-2,n-1)</code>，'
                + '再从 0 开始逐个 <code>find</code>。<br>'
                + '负载②「成对合并」：<code>union(0,1) union(2,3) …</code> 再 '
                + '<code>union(0,2) union(4,6) …</code>，锦标赛式两两合并，再逐个 find。'
                + '<b>这个负载专门用来打按秩合并</b> —— 它压不住深度。',
        }),
        ctl,
        sv,
        Viz.cmpGrid([
            { h: '朴素', v: fmtBig(naive.hops), d: '次指针跳转　树高 ' + naive.height, cls: 'cmp-bad' },
            { h: '两个一起上', v: fmtBig(both.hops), d: '次指针跳转　树高 ' + both.height, cls: 'cmp-ok' },
            {
                h: '差距', v: both.hops ? Math.round(naive.hops / both.hops) + '×' : '—',
                d: '而且 n 越大差得越离谱', cls: 'cmp-save',
            },
        ]),
        h('div.seq-note', { html: bigVerdict(cmp, n) })
    );
}

function fmtBig(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(2) + ' 百万';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
    return String(v);
}

function bigVerdict(cmp, n) {
    const by = {};
    cmp.forEach((c) => { by[c.id] = c; });
    if (state.workload === 'chain') {
        return '<b>朴素实现是 ' + fmtBig(by.naive.hops) + ' 次跳转，'
            + '而且树高 ' + by.naive.height + '（就是一条 n 长的链）。</b>'
            + '这个数字的来源很直白：find(0) 走 n-1 步、find(1) 走 n-2 步…… '
            + '加起来就是 n(n-1)/2 ≈ ' + fmtBig(n * (n - 1) / 2) + '。<b>这是 O(n²)。</b><br>'
            + '<b>只按秩合并</b>（' + fmtBig(by.rank.hops) + ' 次）在这个负载上表现极好 —— '
            + '因为它压根不让链形成，每次合并都把矮的挂到高的下面，直接长成一个星形。<br>'
            + '<b>只路径压缩</b>（' + fmtBig(by.compress.hops) + ' 次）：链照样形成了，'
            + '但<b>第一次 find(0) 走完 n-1 步之后，整条链就被拍平了</b>，'
            + '后面每次 find 都只要 1 步。所以总数大约是 2n 而不是 n²。<br>'
            + '现在点「负载②」，看只按秩合并会怎么被打脸。';
    }
    return '换成<b>成对合并</b>之后，只按秩合并的优势没了 —— '
        + '树高 ' + by.rank.height + '（大约是 log₂' + n + ' ≈ '
        + Math.ceil(Math.log2(n)) + '），跳转 ' + fmtBig(by.rank.hops) + ' 次。<br>'
        + '<b>这正是「只按秩合并是 O(log n) 最坏」的具体样子</b>：'
        + '它保证树高不超过 log n，但也<b>只能</b>保证到这个程度 —— '
        + '两棵一样高的树合并时，树高就是会 +1，n 个元素合成一棵就会到 log₂n 层。<br>'
        + '而配上路径压缩之后（' + fmtBig(by.both.hops) + ' 次，树高 ' + by.both.height + '），'
        + '爬过的路径立刻被拍平，深度再也涨不回去。<br>'
        + '<b>结论：两个优化的作用是互补的，缺一个都只能到 O(log n)，'
        + '合起来才是 α(n)。</b>';
}

function alphaCard() {
    const rows = [
        [10, '十个'],
        [1000, '一千'],
        [1e6, '一百万'],
        [1e9, '十亿（全球人口量级）'],
        [1e12, '一万亿'],
        [Math.pow(2, 266), '10^80，可观测宇宙的原子总数'],
    ];
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: 'n' }), h('th', { text: '有多大' }),
        h('th', { text: 'log₂ n' }), h('th', { text: 'α(n)' })
    ));
    rows.forEach(([v, name]) => {
        tbl.appendChild(h('tr', null,
            h('td.mv-strong', { text: v >= 1e15 ? '≈ 10^80' : v.toLocaleString('en-US') }),
            h('td', { text: name }),
            h('td.dl-num', { text: Math.round(Math.log2(v)).toString() }),
            h('td.ok.mv-strong', { text: String(UF.alpha(v)) })
        ));
    });
    wrap.appendChild(tbl);

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-infinity"></i> α(n) 到底有多小' }),
        h('p.sec-note', {
            html: '反阿克曼函数 α(n) 是阿克曼函数的反函数。'
                + '阿克曼函数长得快到离谱（A(4,2) 已经是一个有 19729 位的数），'
                + '所以它的反函数就慢到离谱：',
        }),
        wrap,
        h('div.seq-note', {
            html: '<b>看最后一列：从十个到宇宙的原子总数，α(n) 只从 2 涨到 4。</b>'
                + '而同一段范围里 log₂n 从 3 涨到了 266。<br>'
                + '所以工程上说「并查集是 O(1) 的」不算错 —— '
                + '<b>但严格来说它不是 O(1)</b>：Tarjan 证明了 O(mα(n)) 这个界是<b>紧的</b>，'
                + '存在能让它达到这个下界的操作序列，不可能再优化到严格常数。'
                + '这是一个「理论上不是常数、实践中就是常数」的漂亮例子。<br>'
                + '<b>另外要分清三个「log n」：</b>'
                + '只按秩合并是 <b>最坏</b> O(log n)（每次都可能是 log n）；'
                + '只路径压缩是 <b>均摊</b> O(log n)（个别很慢，总体摊下来 log n）；'
                + '两个一起才是均摊 O(α(n))。',
        })
    );
}

function kruskalCard() {
    const G = UF.DEMO_GRAPH;
    const kr = UF.kruskal(G.names.length, G.edges, 'both');
    const shown = state.kruskalStep < 0 ? kr.steps.length : state.kruskalStep;

    const ctl = h('div.controls');
    ctl.appendChild(h('label.ctl.ctl-wide', null,
        h('span.ctl-name', { text: '考察到第几条边' }),
        h('input', {
            type: 'range', min: '0', max: String(kr.steps.length), step: '1',
            value: String(Math.min(shown, kr.steps.length)),
            oninput: (e) => { state.kruskalStep = Number(e.target.value); render(); },
        }),
        h('b.ctl-val', { text: shown + ' / ' + kr.steps.length })
    ));
    ctl.appendChild(h('div.ctl-btns', null,
        h('button.mini', {
            onclick: () => { state.kruskalStep = Math.max(0, shown - 1); render(); },
        }, '← 上一条'),
        h('button.mini', {
            onclick: () => { state.kruskalStep = Math.min(kr.steps.length, shown + 1); render(); },
        }, '下一条 →'),
        h('button.mini.primary', { onclick: () => { state.kruskalStep = -1; render(); } }, '直接跑完')
    ));

    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '#' }), h('th', { text: '边' }), h('th', { text: '权重' }),
        h('th', { text: 'find 两端' }), h('th', { text: '决定' }), h('th', { text: '剩几个集合' })
    ));
    kr.steps.slice(0, shown).forEach((s, i) => {
        tbl.appendChild(h('tr' + (i === shown - 1 ? '.on' : ''), null,
            h('td', { text: String(i + 1) }),
            h('td.mv-strong', { text: G.names[s.edge.u] + ' — ' + G.names[s.edge.v] }),
            h('td.dl-num', { text: String(s.edge.w) }),
            h('td', { text: s.take ? '不同根' : '同一个根' }),
            h('td' + (s.take ? '.ok' : '.bad'), { text: s.take ? '✓ 收下' : '✗ 会成环，跳过' }),
            h('td', { text: String(s.groups) })
        ));
    });
    wrap.appendChild(tbl);

    const takenSoFar = kr.steps.slice(0, shown).filter((s) => s.take);
    const sumSoFar = takenSoFar.reduce((a, s) => a + s.edge.w, 0);

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-diagram-project"></i> 实际用途：Kruskal 最小生成树' }),
        h('p.sec-note', {
            html: 'Kruskal 的算法本体只有一句话：<b>把所有边按权重从小到大排序，'
                + '依次尝试加入 —— 只要这条边的两端还不连通就收下</b>。'
                + '而「两端连不连通」正是并查集唯一擅长的事。<br>'
                + '结点的颜色表示它当前属于哪个集合，'
                + '<b class="uf-take">绿色实线</b>是收下的边，'
                + '<b class="uf-skip">灰色虚线</b>是因为会成环被跳过的。',
        }),
        ctl,
        drawGraph(kr, shown),
        wrap,
        Viz.cmpGrid([
            { h: '已收下', v: takenSoFar.length + ' 条', d: '最多需要 n−1 = 6 条', cls: 'cmp-ok' },
            { h: '当前总权重', v: String(sumSoFar), d: shown >= kr.steps.length ? '这就是最小生成树的权重' : '还没跑完', cls: 'cmp-save' },
            {
                h: '剩余集合数', v: String(shown ? kr.steps[shown - 1].groups : G.names.length),
                d: '降到 1 就全连通了',
                cls: (shown && kr.steps[shown - 1].groups === 1) ? 'cmp-ok' : 'cmp-bad',
            },
        ]),
        h('div.seq-note', {
            html: shown >= kr.steps.length
                ? '<b>最小生成树权重 = ' + kr.total + '</b>，用了 ' + kr.chosen.length + ' 条边。<br>'
                  + '注意后面几条边（BC 8、EF 8、BD 9、FG 11、DE 15）全被跳过了 —— '
                  + '<b>并查集在这里干的活就是「一次 find 判断加这条边会不会成环」</b>，'
                  + '如果改用「每次都跑一遍 DFS 看连不连通」，整体复杂度会从 '
                  + 'O(E log E) 退化到 O(E·V)。<br>'
                  + '顺带说个细节：<b>权重相同的边谁先谁后会影响最终选出哪些边</b>'
                  + '（这里 AD 和 CE 都是 5），但<b>总权重一定相同</b> —— '
                  + '最小生成树可能不唯一，最小权重是唯一的。'
                : '继续往下点。注意看什么时候会出现「同一个根 → 跳过」，'
                  + '那就是并查集在阻止成环。',
        })
    );
}

Viz.register({
    id: 'union-find',
    cat: 'algo',
    title: '并查集',
    subtitle: '路径压缩 · 按秩合并',
    icon: 'fa-sitemap',
    blurb: '一次 find 顺手把整条路拍到根上 —— 那一下就是灵魂',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.mode = 'naive';
        state.step = SMALL_N - 1;
        state.bigN = 1000;
        state.workload = 'chain';
        state.kruskalStep = -1;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
