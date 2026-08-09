// ============================================================
//  演示：Dijkstra 与 A*
//  两张一模一样的地图并排跑，一边是 Dijkstra，一边是 A*。
//  Dijkstra 会摊成一个圆（它对终点在哪一无所知），A* 收成一个锥（启发函数把它拽向终点）。
//  第二个打脸：把启发权重 w 调大，搜得更快，但走出来的路可能不是最短的 ——
//  这里专门做了一张地图，让 w=3 的路比最优解长一截，两条路叠着画给你看。
//  上半 PF.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const PF = {};

/** 四邻域（本演示不走对角线，所以曼哈顿距离才是「最紧」的可采纳启发）*/
PF.DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

PF.H = {
    zero: { name: 'h ≡ 0（退化成 Dijkstra）', f: function () { return 0; } },
    manhattan: {
        name: '曼哈顿 |dx|+|dy|',
        f: function (x, y, gx, gy) { return Math.abs(x - gx) + Math.abs(y - gy); },
    },
    euclid: {
        name: '欧几里得 √(dx²+dy²)',
        f: function (x, y, gx, gy) { const a = x - gx, b = y - gy; return Math.sqrt(a * a + b * b); },
    },
    chebyshev: {
        name: '切比雪夫 max(|dx|,|dy|)',
        f: function (x, y, gx, gy) { return Math.max(Math.abs(x - gx), Math.abs(y - gy)); },
    },
};

const GW = 17, GH = 11;

function blankGrid() {
    const blocked = [];
    for (let y = 0; y < GH; y++) {
        const row = [];
        for (let x = 0; x < GW; x++) row.push(x === 0 || y === 0 || x === GW - 1 || y === GH - 1);
        blocked.push(row);
    }
    return blocked;
}

/** 把一段线（横或竖）挖开 */
function carve(blocked, x1, y1, x2, y2) {
    const dx = Math.sign(x2 - x1), dy = Math.sign(y2 - y1);
    let x = x1, y = y1;
    blocked[y][x] = false;
    while (x !== x2 || y !== y2) { x += dx; y += dy; blocked[y][x] = false; }
}

PF.maps = {};

/** ① 开阔地：最能看出「圆」和「锥」的区别 */
PF.maps.open = function () {
    const blocked = blankGrid();
    return {
        id: 'open', name: '开阔地', w: GW, h: GH, blocked,
        start: { x: 1, y: 5 }, goal: { x: 15, y: 5 },
        note: '中间什么都没有。Dijkstra 会往四面八方均匀摊开，A* 几乎笔直冲过去。',
    };
};

/** ② 一堵墙 + 一个缺口 */
PF.maps.wall = function () {
    const blocked = blankGrid();
    for (let y = 1; y <= 7; y++) blocked[y][8] = true;
    for (let y = 3; y <= 9; y++) blocked[y][12] = true;
    return {
        id: 'wall', name: '两堵墙 · 错位缺口', w: GW, h: GH, blocked,
        start: { x: 1, y: 5 }, goal: { x: 15, y: 5 },
        note: '两堵墙的缺口一上一下，必须绕 S 形。A* 依然明显更省，但会先撞墙再修正。',
    };
};

/**
 * ③ 权重陷阱：专门用来演示 w > 1 会走出更长的路。
 *
 * 两条路通往终点：
 *   路 A（下面绕一圈）：先往下走 4 格 —— <b>一开始是在远离终点的</b>，但总长只有 22。
 *   路 B（中间之字形）：一路朝着终点的方向挪，但要不停上下折返，总长 26。
 * 权重 w 调大以后，A* 会被「看起来一直在靠近终点」的路 B 骗走。
 */
PF.maps.trap = function () {
    const blocked = blankGrid();
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) blocked[y][x] = true;
    // 路 A：绕下面一圈（更短，但开头背着终点走）
    carve(blocked, 1, 5, 1, 9);
    carve(blocked, 1, 9, 15, 9);
    carve(blocked, 15, 9, 15, 5);
    // 路 B：之字形（更长，但一直朝着终点的方向挪）
    carve(blocked, 1, 5, 3, 5);
    carve(blocked, 3, 5, 3, 2);
    carve(blocked, 3, 2, 6, 2);
    carve(blocked, 6, 2, 6, 5);
    carve(blocked, 6, 5, 9, 5);
    carve(blocked, 9, 5, 9, 2);
    carve(blocked, 9, 2, 12, 2);
    carve(blocked, 12, 2, 12, 5);
    carve(blocked, 12, 5, 15, 5);
    return {
        id: 'trap', name: '权重陷阱', w: GW, h: GH, blocked,
        start: { x: 1, y: 5 }, goal: { x: 15, y: 5 },
        note: '下面那条绕远的路其实更短（22 步），中间那条之字形看着一直在靠近终点，其实更长（26 步）。',
    };
};

/**
 * 统一的 A* / Dijkstra。
 *   hName='zero' 就是 Dijkstra（没有启发，只看已走的代价）
 *   w 是启发权重，f = g + w·h
 *
 * 取最小 f 用的是线性扫描 + 确定性的打破平局规则（f → h → 下标），
 * 保证同样的输入永远给出同样的扩展顺序 —— 不然两边根本没法对照。
 */
PF.search = function (map, hName, w) {
    const W = map.w, H = map.h;
    const N = W * H;
    const hf = (PF.H[hName] || PF.H.zero).f;
    const weight = w == null ? 1 : w;
    const gx = map.goal.x, gy = map.goal.y;
    const idx = (x, y) => y * W + x;

    const g = new Array(N).fill(Infinity);
    const hv = new Array(N).fill(0);
    const came = new Array(N).fill(-1);
    const closed = new Array(N).fill(false);
    const inOpen = new Array(N).fill(false);

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) hv[idx(x, y)] = hf(x, y, gx, gy);
    }

    const s = idx(map.start.x, map.start.y), t = idx(gx, gy);
    g[s] = 0;
    const open = [s];
    inOpen[s] = true;

    const order = [];
    let found = false;

    while (open.length) {
        // 找 f 最小的；平局时优先 h 小的（更靠近终点），再平局取下标小的
        let best = 0;
        for (let i = 1; i < open.length; i++) {
            const a = open[i], b = open[best];
            const fa = g[a] + weight * hv[a], fb = g[b] + weight * hv[b];
            if (fa < fb - 1e-9 || (Math.abs(fa - fb) <= 1e-9 && (hv[a] < hv[b] - 1e-9
                || (Math.abs(hv[a] - hv[b]) <= 1e-9 && a < b)))) best = i;
        }
        const cur = open[best];
        open.splice(best, 1);
        inOpen[cur] = false;
        if (closed[cur]) continue;
        closed[cur] = true;
        order.push(cur);
        if (cur === t) { found = true; break; }

        const cx = cur % W, cy = (cur - cx) / W;
        for (let d = 0; d < PF.DIRS.length; d++) {
            const nx = cx + PF.DIRS[d][0], ny = cy + PF.DIRS[d][1];
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            if (map.blocked[ny][nx]) continue;
            const nb = idx(nx, ny);
            if (closed[nb]) continue;
            const ng = g[cur] + 1;
            if (ng < g[nb]) {
                g[nb] = ng;
                came[nb] = cur;
                if (!inOpen[nb]) { open.push(nb); inOpen[nb] = true; }
            }
        }
    }

    // 回溯路径
    const path = [];
    if (found) {
        let c = t;
        while (c !== -1) { path.push({ x: c % W, y: (c - (c % W)) / W, i: c }); c = came[c]; }
        path.reverse();
    }

    return {
        map, hName, w: weight, order, g, h: hv, came, closed,
        path, found,
        cost: found ? g[t] : Infinity,
        expanded: order.length,
        frontier: open.slice(),
    };
};

/** 路径上每一格的 g / h / f，用来在界面上摊开看 */
PF.pathDetail = function (res) {
    return res.path.map((p) => ({
        x: p.x, y: p.y,
        g: res.g[p.i],
        h: Math.round(res.h[p.i] * 100) / 100,
        f: Math.round((res.g[p.i] + res.w * res.h[p.i]) * 100) / 100,
    }));
};

/** 同一张图上，各种启发函数的扩展节点数对照 */
PF.compareH = function (map, w) {
    return Object.keys(PF.H).map((k) => {
        const r = PF.search(map, k, w);
        return { id: k, name: PF.H[k].name, expanded: r.expanded, cost: r.cost, found: r.found };
    });
};

/** 权重扫描：w 从 1 到 maxW，看扩展数和路径长度怎么变 */
PF.sweepW = function (map, hName, maxW) {
    const out = [];
    for (let w = 1; w <= (maxW || 5); w += 0.5) {
        const r = PF.search(map, hName, w);
        out.push({ w, expanded: r.expanded, cost: r.cost, found: r.found });
    }
    return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = PF;
if (typeof window !== 'undefined') window.PFModel = PF;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const state = {
    map: 'open',
    hName: 'manhattan',
    w: 1,
    step: -1,      // -1 = 全部走完
    trapW: 3,
};

let rootEl = null;

const CELL = 19;

function mixColor(t) {
    // 扩展顺序 → 颜色：早期偏深蓝紫，后期偏浅青
    const a = [79, 70, 229], b = [186, 230, 253];
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return 'rgb(' + c.join(',') + ')';
}

function drawGrid(res, title, sub, opt) {
    opt = opt || {};
    const map = res.map;
    const PAD = 4, TOP = 34;
    const W = PAD * 2 + map.w * CELL;
    const H = TOP + map.h * CELL + (opt.extraH || 4);
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'pf-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': title,
    });

    const t1 = svg('text', { x: PAD, y: 13, class: 'pf-title' });
    t1.textContent = title;
    root.appendChild(t1);
    const t2 = svg('text', { x: PAD, y: 27, class: 'pf-sub' });
    t2.textContent = sub;
    root.appendChild(t2);

    const upto = opt.upto == null ? res.order.length : opt.upto;
    const rank = {};
    for (let i = 0; i < Math.min(upto, res.order.length); i++) rank[res.order[i]] = i;
    const total = Math.max(1, Math.min(upto, res.order.length) - 1);

    const onPath = {};
    if (opt.showPath !== false) res.path.forEach((p) => { onPath[p.i] = true; });
    const altPath = {};
    (opt.altPath || []).forEach((p) => { altPath[p.i] = true; });

    for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
            const i = y * map.w + x;
            const px = PAD + x * CELL, py = TOP + y * CELL;
            const isStart = x === map.start.x && y === map.start.y;
            const isGoal = x === map.goal.x && y === map.goal.y;
            let cls = 'pf-cell', fill = null;
            if (map.blocked[y][x]) cls += ' pf-wall';
            else if (rank[i] != null) { cls += ' pf-open'; fill = mixColor(rank[i] / total); }

            const attrs = {
                x: px + 0.5, y: py + 0.5, width: CELL - 1, height: CELL - 1, rx: 2, class: cls,
            };
            if (fill) attrs.fill = fill;
            const cell = svg('rect', attrs);
            if (rank[i] != null) {
                const ti = svg('title');
                ti.textContent = '(' + x + ',' + y + ')  g=' + res.g[i]
                    + '  h=' + (Math.round(res.h[i] * 100) / 100)
                    + '  f=' + (Math.round((res.g[i] + res.w * res.h[i]) * 100) / 100)
                    + '  第 ' + (rank[i] + 1) + ' 个被扩展';
                cell.appendChild(ti);
            }
            root.appendChild(cell);

            // 备选路径（画在下面一层）
            if (altPath[i] && !map.blocked[y][x]) {
                root.appendChild(svg('rect', {
                    x: px + 3, y: py + 3, width: CELL - 6, height: CELL - 6, rx: 2, class: 'pf-alt',
                }));
            }
            if (onPath[i] && !isStart && !isGoal) {
                root.appendChild(svg('circle', {
                    cx: px + CELL / 2, cy: py + CELL / 2, r: 3.4, class: 'pf-path',
                }));
            }
            if (rank[i] != null && !isStart && !isGoal && CELL >= 18) {
                const f = res.g[i] + res.w * res.h[i];
                const lb = svg('text', {
                    x: px + CELL / 2, y: py + CELL / 2 + 3.2,
                    class: 'pf-f' + (onPath[i] ? ' pf-f-path' : ''), 'text-anchor': 'middle',
                });
                lb.textContent = String(Math.round(f));
                root.appendChild(lb);
            }
            if (isStart || isGoal) {
                root.appendChild(svg('rect', {
                    x: px + 1.5, y: py + 1.5, width: CELL - 3, height: CELL - 3, rx: 3,
                    class: isStart ? 'pf-start' : 'pf-goal',
                }));
                const lb = svg('text', {
                    x: px + CELL / 2, y: py + CELL / 2 + 4, class: 'pf-se', 'text-anchor': 'middle',
                });
                lb.textContent = isStart ? 'S' : 'G';
                root.appendChild(lb);
            }
        }
    }
    return root;
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const map = PF.maps[state.map]();
    const dij = PF.search(map, 'zero', 1);
    const astar = PF.search(map, state.hName, state.w);
    const maxSteps = Math.max(dij.expanded, astar.expanded);
    const upto = state.step < 0 ? maxSteps : state.step;

    // ── 场景 ──
    const ctl = h('div.controls');
    ctl.appendChild(h('label.ctl.ctl-wide', null,
        h('span.ctl-name', { text: '单步扩展到第几个' }),
        h('input', {
            type: 'range', min: '1', max: String(maxSteps), step: '1', value: String(Math.min(upto, maxSteps)),
            oninput: (e) => { state.step = Number(e.target.value); render(); },
        }),
        h('b.ctl-val', { text: (state.step < 0 ? maxSteps : state.step) + ' / ' + maxSteps })
    ));
    ctl.appendChild(h('div.ctl-btns', null,
        h('button.mini', { onclick: () => { state.step = 1; render(); } }, '回到第 1 步'),
        h('button.mini', {
            onclick: () => { state.step = Math.max(1, (state.step < 0 ? maxSteps : state.step) - 1); render(); },
        }, '← 上一步'),
        h('button.mini', {
            onclick: () => { state.step = Math.min(maxSteps, (state.step < 0 ? maxSteps : state.step) + 1); render(); },
        }, '下一步 →'),
        h('button.mini.primary', { onclick: () => { state.step = -1; render(); } }, '直接跑完')
    ));

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-route"></i> 场景：同一张地图，同一对起终点，两种搜法' }),
        h('p.sec-note', {
            html: '<b>Dijkstra</b> 按「已经走了多远」（g）排序，一层层往外扩 —— '
                + '它压根不知道终点在哪，只能地毯式搜。<br>'
                + '<b>A*</b> 按 <code>f = g + w·h</code> 排序，'
                + 'h 是「从这里到终点的估计距离」，相当于给了它一个指南针。<br>'
                + '格子里的数字是那一格的 f 值，颜色深浅是<b>被扩展的先后</b>（深 = 早）。'
                + '鼠标停在格子上能看到完整的 g / h / f。',
        }),
        Viz.segmented({
            options: [
                { v: 'open', label: '开阔地' },
                { v: 'wall', label: '两堵墙' },
                { v: 'trap', label: '权重陷阱' },
            ],
            value: state.map,
            onPick: (v) => { state.map = v; state.step = -1; render(); },
        }),
        h('p.sec-note', { text: map.note }),
        ctl
    ));

    // ── 并排两张图 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻一：Dijkstra 摊成圆，A* 收成锥' }),
        h('p.sec-note', {
            html: '同样的起终点、同样的障碍。看被搜过的格子的<b>形状</b> —— '
                + '这是理解 A* 最快的一眼。',
        }),
        h('div.pf-two', null,
            h('div.pf-panel', null, drawGrid(dij,
                'Dijkstra（h ≡ 0）',
                '扩展了 ' + Math.min(upto, dij.expanded) + ' 个格子　路径长 '
                    + (dij.found ? dij.cost : '—'),
                { upto })),
            h('div.pf-panel', null, drawGrid(astar,
                'A*（' + PF.H[state.hName].name + '，w=' + state.w + '）',
                '扩展了 ' + Math.min(upto, astar.expanded) + ' 个格子　路径长 '
                    + (astar.found ? astar.cost : '—'),
                { upto }))
        ),
        Viz.cmpGrid([
            { h: 'Dijkstra 扩展', v: String(dij.expanded), d: '个格子', cls: 'cmp-bad' },
            { h: 'A* 扩展', v: String(astar.expanded), d: '个格子', cls: 'cmp-ok' },
            {
                h: '少搜了', v: dij.expanded
                    ? Math.round((1 - astar.expanded / dij.expanded) * 100) + '%' : '—',
                d: '路径长度 ' + dij.cost + ' vs ' + astar.cost, cls: 'cmp-save',
            },
        ]),
        h('div.seq-note', { html: shapeVerdict(dij, astar) })
    ));

    // ── 启发函数对照 ──
    const cmp = PF.compareH(map, state.w);
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-compass"></i> 换个启发函数试试' }),
        h('p.sec-note', {
            html: '注意 <b>h ≡ 0 那一行</b>：扩展数和 Dijkstra 一模一样 —— '
                + '<b>Dijkstra 就是启发函数恒为 0 的 A*</b>，不是两个算法。',
        }),
        Viz.segmented({
            options: Object.keys(PF.H).map((k) => ({ v: k, label: PF.H[k].name })),
            value: state.hName,
            onPick: (v) => { state.hName = v; state.step = -1; render(); },
        }),
        hTable(cmp, dij),
        h('div.seq-note', {
            html: '<b>为什么欧几里得和切比雪夫反而更慢？</b>'
                + '本演示只能走上下左右四个方向，走一格代价是 1，'
                + '所以从 (x,y) 到终点<b>真实的最少步数就是曼哈顿距离</b>。'
                + '欧几里得（走直线的长度）和切比雪夫（取较大的那个分量）都<b>比它小</b> —— '
                + '也就是<b>低估</b>了。<br>'
                + '低估不会让结果出错（可采纳的启发保证最优），但会让 A* 变得没那么果断，'
                + '白扩展一堆格子。<b>可采纳的前提下，h 越大越好</b>；'
                + '曼哈顿在四邻域网格上是「最紧」的那个，所以它最快。<br>'
                + '（如果允许走对角线，切比雪夫或者八方向距离才是最紧的 —— '
                + '<b>启发函数必须配着移动方式选</b>，抄错了要么变慢，要么直接出错。）',
        })
    ));

    // ── 打脸二：权重 ──
    rootEl.appendChild(weightCard());

    // ── 路径细节 ──
    if (astar.found) {
        rootEl.appendChild(h('section.card', null,
            h('h3.sec-title', { html: '<i class="fas fa-table-list"></i> A* 走出来的这条路，每一格的 g / h / f' }),
            h('p.sec-note', {
                html: '<code>g</code> = 从起点走到这里已经花了多少　'
                    + '<code>h</code> = 估计从这里到终点还要多少　'
                    + '<code>f = g + w·h</code> = 对「走这条路的总代价」的估计。<br>'
                    + 'A* 每次从待选集合里挑 f 最小的展开 —— 就这么简单。',
            }),
            pathTable(PF.pathDetail(astar), astar)
        ));
    }

    // ── 机制 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list-ol"></i> A* 一轮循环干了什么' }),
        Viz.flowList([
            {
                t: '① 从开放集合里挑 f 最小的那个格子',
                f: 'cur = argmin(g[n] + w * h[n])   // n ∈ open',
                r: '这是唯一的「决策点」，A* 全部的聪明都在这一行',
                hi: '实现上必须用<b>优先队列（二叉堆）</b>，不然每次线性扫是 O(n)，'
                    + '整体退化成 O(n²)。本演示格子少，为了让扩展顺序完全确定就用了线性扫描 + '
                    + '固定的打破平局规则。',
            },
            {
                t: '② 如果它就是终点 —— 结束',
                f: 'if (cur === goal) return 回溯路径;',
                r: '注意是「<b>弹出</b>终点时才结束」，不是「看到终点时」',
                hi: '这是最经典的实现 bug：一发现邻居是终点就直接返回。'
                    + '那样返回的是「第一条到达终点的路」，<b>不是最短的那条</b> —— '
                    + '此时开放集合里可能还有 f 更小的节点没展开。',
            },
            {
                t: '③ 把它标记为已处理，然后看它的四个邻居',
                f: 'closed[cur] = true;\nfor (nb of 邻居) { ... }',
                r: '已处理的不再回头（前提是 h 满足一致性）',
            },
            {
                t: '④ 如果从 cur 走到邻居比之前记录的更近，就更新',
                f: 'ng = g[cur] + 1;\nif (ng < g[nb]) { g[nb] = ng; came[nb] = cur; open.push(nb); }',
                r: '记下「我是从哪来的」，最后靠它回溯出整条路',
            },
            {
                t: '⑤ 开放集合空了还没到终点 → 无解',
                f: 'return 找不到路;',
                r: '这时被扩展过的格子就是「从起点能到达的全部区域」',
            },
        ])
    ));

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: 'A* 和 Dijkstra 的关系？',
                a: '<b>Dijkstra 就是启发函数恒为 0 的 A*。</b>'
                    + '不是两个算法，是同一个算法的两个参数取值。'
                    + '上面那张表里 <code>h ≡ 0</code> 那一行的扩展数和 Dijkstra 完全相同，'
                    + '就是这个意思。<br>'
                    + '（顺带：BFS 是所有边权相等时的 Dijkstra，'
                    + '贪心最佳优先搜索是 <code>f = h</code>、完全不看 g 的版本 —— 快但不保证最优。'
                    + '这四个是一家人。）',
            },
            {
                q: '什么叫「可采纳」（admissible）？什么叫「一致」（consistent）？',
                a: '<b>可采纳</b>：h(n) ≤ 从 n 到终点的真实最短距离，也就是<b>永远不高估</b>。'
                    + '这一条保证 A* 找到的是最短路。<br>'
                    + '<b>一致（也叫单调）</b>：更强的条件，h(n) ≤ cost(n→n\') + h(n\')，'
                    + '类似三角不等式。有了它，<b>每个节点只需要被展开一次</b>，'
                    + '进了 closed 就不用再回头改（这就是上面第 ③ 步能成立的前提）。<br>'
                    + '一致必然可采纳，反过来不成立。'
                    + '实践中常用的几何距离（曼哈顿、欧几里得）在均匀网格上<b>都是一致的</b>，'
                    + '所以不用担心。但如果你自己拍脑袋编了个启发函数，'
                    + '就得老老实实检查 —— <b>不一致时必须允许节点从 closed 里被重新打开</b>。',
            },
            {
                q: 'h 高估了会怎样？',
                a: '<b>不再保证最短路</b>，但通常会更快。'
                    + '把 h 乘上一个 w>1 的权重就是最简单的高估方式，叫 <b>Weighted A*</b>。'
                    + '它有一个很好的性质：<b>找到的路径长度 ≤ w × 最优长度</b>（ε-admissible）。'
                    + '也就是说 w=1.5 时最多比最优长 50%，是<b>有界</b>的次优，不是乱来。<br>'
                    + '游戏里的寻路、机器人的实时规划经常故意这么干 —— '
                    + '<b>玩家看不出多绕了两格，但能明显感觉到卡顿</b>。'
                    + '上面「权重陷阱」那张图就是把这件事显式做出来了。',
            },
            {
                q: '起点终点都知道，能不能两头一起搜？',
                a: '能，叫<b>双向搜索</b>。'
                    + '直觉上：单向搜索扩展的区域大致是半径 d 的圆（面积 ∝ d²），'
                    + '双向是两个半径 d/2 的圆（面积 ∝ 2·(d/2)² = d²/2），<b>大约省一半</b>；'
                    + '在三维或者更高维里节省更明显。<br>'
                    + '但双向 A* 的<b>终止条件很不好写</b> —— '
                    + '「两边碰上了」不等于「碰到的那条就是最短路」，'
                    + '要额外判断才能保证最优。工程上更常见的是 Dijkstra 的双向版本，'
                    + '或者干脆用预处理型算法（Contraction Hierarchies），'
                    + '地图导航基本都走后者。',
            },
            {
                q: '实际项目里 A* 还有什么要注意的？',
                a: '① <b>开放集合必须用堆</b>，不然复杂度退化。<br>'
                    + '② <b>打破平局的规则很重要</b>：f 相同时优先选 h 小的，'
                    + '能显著减少在「等价路径」上的无谓扩展（开阔地里效果尤其明显）。<br>'
                    + '③ <b>启发函数要配着移动方式选</b>：能走对角线却用曼哈顿会高估，'
                    + '直接破坏最优性。<br>'
                    + '④ 网格图上更该考虑 <b>JPS（跳点搜索）</b>：'
                    + '它利用网格的对称性大段跳过等价路径，在开阔地上能快一个数量级。<br>'
                    + '⑤ 路径出来了通常还要<b>平滑</b>一下 —— A* 给的是格子序列，'
                    + '直接照着走会是锯齿状的。',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['「看到终点就返回」是最常见的 bug',
             '正确的时机是<b>把终点从优先队列里弹出来</b>的那一刻，不是「某个邻居是终点」的那一刻。'
             + '提前返回时，队列里可能还有 f 更小的节点没展开，'
             + '<b>返回的路会比最优长</b>。可怕的是它在开阔地图上测不出来'
             + '（很多路等长），只有在特定地形才暴露。'],
            ['能走对角线却用曼哈顿距离 = 高估',
             '八方向移动时，从 (0,0) 到 (3,3) 只要 3 步（对角线代价按 1 算），'
             + '但曼哈顿给出 6 —— <b>高估了一倍</b>，最优性直接没了。'
             + '八方向的正确启发是 <code>max(dx,dy)</code>（对角线也算 1）'
             + '或者 <code>(dx+dy) + (√2−2)·min(dx,dy)</code>（对角线算 √2）。'],
            ['浮点数比较不能用 ==',
             '欧几里得启发会产生浮点 f 值，用 <code>==</code> 判断平局会因为精度问题'
             + '给出不稳定的扩展顺序 —— 同一份输入两次跑出来的路径可能不一样。'
             + '要用 <code>Math.abs(a-b) &lt; eps</code>。'
             + '本演示就是这么做的，否则两张图根本没法严格对照。'],
            ['地图变了要重算，别缓存旧路径',
             '动态环境（有移动的障碍）下每帧重跑 A* 很贵。'
             + '这类场景该用 <b>D* Lite</b> 或 <b>LPA*</b> —— 它们能<b>增量修复</b>已有的搜索树，'
             + '只重算受影响的那一小块。'
             + '很多人在游戏里硬扛全量 A*，然后靠「降低寻路频率」掩盖，结果单位反应迟钝。'],
            ['扩展节点数不等于耗时',
             'A* 每展开一个节点都要做堆操作（O(log n)）和启发函数计算，'
             + '而 Dijkstra 的每个节点更便宜。'
             + '如果启发函数本身很贵（比如要查一张预计算表、或者跑一次几何求交），'
             + '<b>「少扩展 80% 的节点」未必等于「快 5 倍」</b>。'
             + '优化前先测，别只看节点数。'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '简化的地方：<br>'
                + '① 只能走<b>上下左右四个方向</b>，每走一格代价固定为 1。'
                + '所以曼哈顿距离恰好等于「无障碍时的真实最短步数」，是这里最紧的可采纳启发。'
                + '换成八方向或者带地形代价（草地 1、沼泽 5），结论要重新算。<br>'
                + '② 开放集合用的是<b>线性扫描找最小值</b>而不是二叉堆 —— '
                + '格子只有 ' + (GW * GH) + ' 个，性能不是问题，'
                + '而线性扫描配上固定的打破平局规则（f → h → 下标）'
                + '能保证扩展顺序<b>完全确定</b>，两张图才有可比性。'
                + '真实实现必须用堆。<br>'
                + '③ 没有实现 JPS、双向搜索、分层寻路、路径平滑这些工程上的常规优化。<br>'
                + '④ 「权重陷阱」那张地图是<b>为了演示专门构造</b>的 —— '
                + '真实地图上 w>1 不一定每次都绕远，但只要地形里存在'
                + '「绕远的短路 vs 顺向的长路」这种结构，它就会中招。',
        }),
        h('p', {
            html: '所有地图都是写死的，没有用随机数生成，'
                + '所以你刷新多少次、拖多少次滑块，同样的参数一定给出同样的搜索过程和同样的路径。',
        })
    ));
}

function shapeVerdict(dij, astar) {
    const save = dij.expanded ? Math.round((1 - astar.expanded / dij.expanded) * 100) : 0;
    let s = '';
    if (state.hName === 'zero') {
        return '你现在把启发函数设成了 <code>h ≡ 0</code> —— <b>两张图应该长得一模一样</b>，'
            + '扩展数也完全相等（' + dij.expanded + ' vs ' + astar.expanded + '）。<br>'
            + '这不是巧合：<b>Dijkstra 就是 h 恒为 0 的 A*</b>。'
            + '把启发函数换回曼哈顿，右边那张图立刻会收成一个锥。';
    }
    s = '<b>Dijkstra 那张图是一圈一圈往外摊的</b> —— 因为它按 g 排序，'
        + '而 g 相同的格子构成一个「等距圈」，它对终点在哪一无所知，只能公平地往每个方向找。<br>'
        + '<b>A* 那张图是朝终点收窄的一个锥</b> —— h 把「离终点还远」这个信息塞进了排序里，'
        + '于是背向终点的格子 f 值高、排在后面，基本轮不到被展开。<br>'
        + '这一局 A* 少搜了 <b>' + save + '%</b> 的格子';
    if (dij.cost === astar.cost) {
        s += '，而且<b>路径长度完全一样（都是 ' + dij.cost + '）</b> —— '
            + '这就是「可采纳的启发不会牺牲最优性」的意思：<b>白拿的速度</b>。';
    } else {
        s += '，但<b>路径变长了（' + dij.cost + ' → ' + astar.cost + '）</b> —— '
            + '当前 w=' + state.w + ' 让 h 高估了，最优性没了。下一节专门讲这个。';
    }
    if (state.map === 'open') {
        s += '<br>把地图换成「两堵墙」，能看到 A* 也会先一头撞上墙、再修正方向 —— '
            + '<b>启发函数只是「直线距离的猜测」，它不知道墙在哪</b>。';
    }
    return s;
}

function hTable(cmp, dij) {
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '启发函数 h' }), h('th', { text: '扩展了几个格子' }),
        h('th', { text: '相对 Dijkstra' }), h('th', { text: '路径长度' }), h('th', { text: '说明' })
    ));
    const notes = {
        zero: '这就是 Dijkstra 本人',
        manhattan: '四邻域网格上最紧的可采纳启发 —— 最快',
        euclid: '低估了（直线比走格子短）→ 白扩展一堆',
        chebyshev: '低估得更狠 → 更慢，只有八方向移动时才该用它',
    };
    cmp.forEach((c) => {
        const ratio = dij.expanded ? Math.round((c.expanded / dij.expanded) * 100) : 100;
        tbl.appendChild(h('tr' + (c.id === state.hName ? '.on' : ''), null,
            h('td.mv-strong', { text: c.name }),
            h('td', { text: String(c.expanded) }),
            h('td' + (ratio < 60 ? '.ok' : (ratio > 95 ? '.bad' : '')), { text: ratio + '%' }),
            h('td' + (c.cost === cmp[1].cost ? '' : '.bad'), { text: c.found ? String(c.cost) : '无解' }),
            h('td', { text: notes[c.id] })
        ));
    });
    wrap.appendChild(tbl);
    return wrap;
}

function pathTable(detail, res) {
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '第几格' }), h('th', { text: '坐标' }),
        h('th', { text: 'g 已走' }), h('th', { text: 'h 估计还要' }),
        h('th', { text: 'f = g + ' + res.w + '·h' })
    ));
    detail.forEach((d, i) => {
        tbl.appendChild(h('tr' + (i === 0 || i === detail.length - 1 ? '.on' : ''), null,
            h('td', { text: i === 0 ? '起点' : (i === detail.length - 1 ? '终点' : String(i)) }),
            h('td', { text: '(' + d.x + ', ' + d.y + ')' }),
            h('td.dl-num', { text: String(d.g) }),
            h('td.dl-num', { text: String(d.h) }),
            h('td.dl-num', { text: String(d.f) })
        ));
    });
    wrap.appendChild(tbl);
    return wrap;
}

function weightCard() {
    const map = PF.maps.trap();
    const opt = PF.search(map, 'manhattan', 1);
    const weighted = PF.search(map, 'manhattan', state.trapW);
    const sweep = PF.sweepW(map, 'manhattan', 5);

    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '启发权重 w', min: 10, max: 50, step: 5, value: Math.round(state.trapW * 10),
        fmt: (v) => 'w = ' + (v / 10).toFixed(1),
        onInput: (v) => { state.trapW = v / 10; render(); },
    }));
    ctl.appendChild(h('div.ctl-btns', null,
        h('button.mini.primary', { onclick: () => { state.trapW = 1; render(); } }, 'w=1（保证最短）'),
        h('button.mini.danger', { onclick: () => { state.trapW = 3; render(); } }, 'w=3（快但可能绕远）')
    ));

    const same = weighted.cost === opt.cost;

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻二：快和最优是可以交易的' }),
        h('p.sec-note', {
            html: '这张地图有两条通往终点的路：<br>'
                + '<b>下面绕一圈那条（22 步，其实更短）</b> —— 但它一开始要往下走 4 格，'
                + '<b>是在远离终点的</b>，h 会立刻变大。<br>'
                + '<b>中间之字形那条（26 步，其实更长）</b> —— 它一路朝着终点的方向挪，'
                + 'h 一直在变小，<b>看起来一直在进步</b>。<br>'
                + '把 w 调大，等于告诉 A*「更相信 h」—— 于是它被那条看着顺眼的长路骗走了。',
        }),
        ctl,
        h('div.pf-two', null,
            h('div.pf-panel', null, drawGrid(opt,
                'w = 1（可采纳）',
                '扩展 ' + opt.expanded + ' 个　路径长 ' + opt.cost + '（最优）',
                {})),
            h('div.pf-panel', null, drawGrid(weighted,
                'w = ' + state.trapW + '（高估）',
                '扩展 ' + weighted.expanded + ' 个　路径长 ' + weighted.cost,
                { altPath: opt.path }))
        ),
        h('p.sec-note', {
            html: '右图里<b>浅色方框</b>是 w=1 找到的最优路径，<b>实心圆点</b>是当前 w 找到的路径 —— '
                + '两者不重合的地方就是被骗走的那一段。',
        }),
        Viz.cmpGrid([
            { h: 'w=1 路径长度', v: String(opt.cost), d: '扩展 ' + opt.expanded + ' 个格子', cls: 'cmp-ok' },
            {
                h: 'w=' + state.trapW + ' 路径长度', v: String(weighted.cost),
                d: '扩展 ' + weighted.expanded + ' 个格子',
                cls: same ? 'cmp-ok' : 'cmp-bad',
            },
            {
                h: same ? '这次没被骗' : '多走了',
                v: same ? '一样长' : '+' + (weighted.cost - opt.cost) + ' 步',
                d: same ? '' : '但少搜了 ' + (opt.expanded - weighted.expanded) + ' 个格子',
                cls: 'cmp-save',
            },
        ]),
        sweepTable(sweep, opt.cost),
        h('div.seq-note', {
            html: (same
                ? 'w = ' + state.trapW + ' 时还没被骗走。<b>把滑块拖到 3 试试</b>，'
                  + '或者直接点上面那个「w=3」按钮。'
                : '<b>w = ' + state.trapW + ' 走出来的路比最优长了 '
                  + (weighted.cost - opt.cost) + ' 步（' + opt.cost + ' → ' + weighted.cost + '）</b>，'
                  + '但扩展的格子少了 ' + (opt.expanded - weighted.expanded) + ' 个。')
                + '<br><b>这个交易是有保证的</b>：Weighted A* 满足 '
                + '<code>找到的长度 ≤ w × 最优长度</code>（ε-admissible）。'
                + 'w=' + state.trapW + ' 时上界是 ' + (opt.cost * state.trapW).toFixed(0)
                + '，实际是 ' + weighted.cost + ' —— 离上界还远，说明大多数时候没那么糟。<br>'
                + '所以游戏和机器人里经常故意把 w 设成 1.2~2：'
                + '<b>玩家看不出多绕了两格，但一定看得出卡顿。</b>'
                + '而在地图导航这种「多开 500 米就是投诉」的场景，w 必须是 1。',
        })
    );
}

function sweepTable(sweep, optCost) {
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '权重 w' }), h('th', { text: '扩展格子数' }),
        h('th', { text: '路径长度' }), h('th', { text: '比最优长多少' }),
        h('th', { text: '理论上界 w × 最优' })
    ));
    sweep.forEach((s) => {
        const over = s.cost - optCost;
        tbl.appendChild(h('tr' + (Math.abs(s.w - state.trapW) < 1e-9 ? '.on' : ''), null,
            h('td.mv-strong', { text: s.w.toFixed(1) }),
            h('td', { text: String(s.expanded) }),
            h('td', { text: String(s.cost) }),
            h('td' + (over > 0 ? '.bad' : '.ok'), { text: over > 0 ? '+' + over + ' 步' : '最优' }),
            h('td', { text: (optCost * s.w).toFixed(0) })
        ));
    });
    wrap.appendChild(tbl);
    return wrap;
}

Viz.register({
    id: 'pathfinding',
    cat: 'algo',
    title: 'Dijkstra 与 A*',
    subtitle: '启发函数怎么把搜索收窄',
    icon: 'fa-route',
    blurb: '一个摊成圆，一个收成锥 —— 差别就在那个 h',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.map = 'open'; state.hName = 'manhattan'; state.w = 1;
        state.step = -1; state.trapW = 3;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
