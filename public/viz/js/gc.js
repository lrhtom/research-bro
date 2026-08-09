// ============================================================
//  演示：垃圾回收 —— 标记-清除 / 标记-整理 / 复制 / 分代
//  同一批存活对象，四种回收方式在堆上留下的形状完全不同：
//  有的留下一地空洞（空间够却分配失败），有的把空间压成一整块，
//  有的干脆把活的抄到另一半、原地整片作废。
//  上半 GC.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const GC = {};

/** 线性同余伪随机。固定种子 —— 刷新前后结果必须一模一样，否则没法对照也没法单测。 */
GC.rng = function (seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
};

/** [{id,...}] → { id: obj } */
GC.index = function (objs) {
    const m = Object.create(null);
    objs.forEach((o) => { m[o.id] = o; });
    return m;
};

/** 一组对象一共占几格 */
GC.used = function (objs) {
    return objs.reduce((a, o) => a + o.size, 0);
};

/** 把对象铺进一条 size 格的堆：cells[i] = 占用它的对象 id，空的是 null */
GC.cellsOf = function (size, objs) {
    const c = new Array(size).fill(null);
    objs.forEach((o) => {
        for (let i = 0; i < o.size; i++) if (o.addr + i < size) c[o.addr + i] = o.id;
    });
    return c;
};

/**
 * 可达性分析（标记阶段）。从 GC Roots 出发做 BFS，一次弹一个对象。
 * 这里顺手把「三色标记」的中间状态记下来，好让界面一步一步看着染色扩散：
 *   白 = 还没碰过　灰 = 已经发现、但它引用的东西还没扫　黑 = 自己和引用都处理完了
 *
 * 返回 { order:[id...], steps:[{id, via, black[], gray[], pushed[]}], marked:Set }
 * 注意：steps 的条数 == 被标记到的对象个数，一步染一个。
 */
GC.markTrace = function (objs, roots) {
    const byId = GC.index(objs);
    const black = [];
    const seen = Object.create(null);
    const queue = [];
    const steps = [];

    // 枚举 GC Roots（栈变量 + 静态变量）——真实 JVM 里这一步必须 STW
    roots.forEach((r) => { if (byId[r.target]) queue.push({ id: r.target, via: 'root:' + r.name }); });

    while (queue.length) {
        const cur = queue.shift();
        if (seen[cur.id]) continue;
        seen[cur.id] = true;
        black.push(cur.id);

        const o = byId[cur.id];
        const pushed = [];
        (o.refs || []).forEach((t) => {
            if (!byId[t] || seen[t]) return;
            queue.push({ id: t, via: cur.id });
            if (pushed.indexOf(t) < 0) pushed.push(t);
        });

        // 队列里去个重，展示用
        const gray = [];
        queue.forEach((q) => { if (!seen[q.id] && gray.indexOf(q.id) < 0) gray.push(q.id); });

        steps.push({ id: cur.id, via: cur.via, pushed, black: black.slice(), gray });
    }

    const marked = new Set(black);
    return { order: black, steps, marked };
};

/** 清除阶段：白色对象占的格子直接置空，存活对象一格都不动。 */
GC.sweep = function (heapSize, objs, marked) {
    const live = objs.filter((o) => marked.has(o.id));
    const dead = objs.filter((o) => !marked.has(o.id));
    return {
        live, dead,
        cells: GC.cellsOf(heapSize, live),
        freedCells: GC.used(dead),
        liveCells: GC.used(live),
    };
};

/** 找出所有空闲区间 [{start,len}] —— 就是「空闲链表」里挂的那些块 */
GC.freeRuns = function (cells) {
    const runs = [];
    let s = -1;
    for (let i = 0; i < cells.length; i++) {
        if (cells[i] == null) { if (s < 0) s = i; }
        else if (s >= 0) { runs.push({ start: s, len: i - s }); s = -1; }
    }
    if (s >= 0) runs.push({ start: s, len: cells.length - s });
    return runs;
};

GC.totalFree = function (runs) { return runs.reduce((a, r) => a + r.len, 0); };
GC.maxRun = function (runs) { return runs.reduce((a, r) => Math.max(a, r.len), 0); };

/** 首次适应：从头找第一个塞得下的块 */
GC.firstFit = function (runs, size) {
    for (let i = 0; i < runs.length; i++) if (runs[i].len >= size) return runs[i].start;
    return -1;
};

/** 最佳适应：找刚好够用、剩得最少的那块 */
GC.bestFit = function (runs, size) {
    let best = -1, bestLen = Infinity;
    runs.forEach((r) => { if (r.len >= size && r.len < bestLen) { bestLen = r.len; best = r.start; } });
    return best;
};

/**
 * 试着分配一块 size 格的连续内存。
 * 关键点：能不能分配成功，看的<b>不是</b>总空闲，而是最大连续空闲。
 */
GC.tryAlloc = function (runs, size) {
    const first = GC.firstFit(runs, size);
    return {
        size,
        ok: first >= 0,
        at: first,
        best: GC.bestFit(runs, size),
        totalFree: GC.totalFree(runs),
        maxRun: GC.maxRun(runs),
        holes: runs.length,
    };
};

/**
 * 整理阶段：存活对象保持原有先后顺序，向低地址端滑动压实。
 * 返回 { objs:新对象数组, moves:[{id,from,to,moved}], cells, bump }
 * bump 就是压实之后的「分配指针」，它右边全是连续空闲。
 */
GC.compact = function (heapSize, liveObjs) {
    const sorted = liveObjs.slice().sort((a, b) => a.addr - b.addr);
    const moves = [], out = [];
    let p = 0;
    sorted.forEach((o) => {
        moves.push({ id: o.id, from: o.addr, to: p, moved: o.addr !== p });
        out.push(Object.assign({}, o, { addr: p }));
        p += o.size;
    });
    return { objs: out, moves, cells: GC.cellsOf(heapSize, out), bump: p };
};

/**
 * 复制算法（Cheney）：堆一分为二，只用 From 半区。
 * 存活对象按 BFS 顺序抄到 To 半区，抄完 From 整片作废。
 * halfSize = 半区大小；To 半区里的地址从 0 重新开始编号。
 */
GC.copyCollect = function (halfSize, objs, roots) {
    const trace = GC.markTrace(objs, roots);
    const byId = GC.index(objs);
    const moves = [], out = [];
    let p = 0;
    trace.order.forEach((id) => {
        const o = byId[id];
        moves.push({ id, from: o.addr, to: p, moved: true });
        out.push(Object.assign({}, o, { addr: p }));
        p += o.size;
    });
    return {
        objs: out, moves, order: trace.order, marked: trace.marked, bump: p, halfSize,
        toCells: GC.cellsOf(halfSize, out),
        fromCells: new Array(halfSize).fill(null),   // 旧半区整体清空，不逐个清理死对象
        fits: p <= halfSize,
    };
};

/**
 * 把对象图「物化」成堆镜像：每个引用槽位里存的是<b>目标对象的真实地址</b>，不是 id。
 * 对象一移动，这些数字就必须全部改写 —— 这正是整理/复制的主要代价。
 */
GC.materialize = function (objs) {
    const byId = GC.index(objs);
    return objs.map((o) => Object.assign({}, o, {
        ptrs: (o.refs || []).filter((r) => byId[r]).map((r) => byId[r].addr),
    }));
};

/** 顺着一个地址找回它落在哪个对象身上（没有就 null）*/
GC.objAt = function (objs, addr) {
    for (let i = 0; i < objs.length; i++) {
        const o = objs[i];
        if (addr >= o.addr && addr < o.addr + o.size) return o;
    }
    return null;
};

/** 列出所有需要改写的引用：[{from,to,oldAddr,newAddr,changed}] */
GC.refUpdates = function (oldObjs, newObjs) {
    const o1 = GC.index(oldObjs), o2 = GC.index(newObjs);
    const out = [];
    newObjs.forEach((o) => {
        (o.refs || []).forEach((t) => {
            if (!o2[t]) return;
            const oldAddr = o1[t] ? o1[t].addr : null;
            out.push({ from: o.id, to: t, oldAddr, newAddr: o2[t].addr, changed: oldAddr !== o2[t].addr });
        });
    });
    return out;
};

/**
 * 抽象代价模型（单位是「相对工作量」，不是纳秒）。
 *   标记：只走存活对象　→ markUnit * live
 *   清除：必须线性扫全堆才能找出空闲块 → scanUnit * cells（跟垃圾多少无关！）
 *   搬运：拷贝内容 + 改写引用 → moveUnit * live
 * 复制算法的特点：它<b>没有清除这一项</b>，死对象连碰都不碰。
 */
GC.gcCost = function (opt) {
    const cells = opt.cells;
    const markU = opt.markUnit == null ? 2 : opt.markUnit;
    const scanU = opt.scanUnit == null ? 1 : opt.scanUnit;
    const moveU = opt.moveUnit == null ? 3 : opt.moveUnit;
    const live = cells * (opt.survival / 100);
    return {
        live,
        mark: markU * live,
        scan: scanU * cells,
        move: moveU * live,
        markSweep: markU * live + scanU * cells,
        markCompact: markU * live + scanU * cells + moveU * live,
        copying: markU * live + moveU * live,
    };
};

/** 复制 vs 标记-清除 的时间盈亏平衡点（存活率，0~1）。推导：moveU*live == scanU*cells */
GC.copyBreakEven = function (opt) {
    const scanU = (opt && opt.scanUnit != null) ? opt.scanUnit : 1;
    const moveU = (opt && opt.moveUnit != null) ? opt.moveUnit : 3;
    return scanU / moveU;
};

/**
 * Survivor 装不装得下？
 * 8:1:1 的新生代里 Survivor 只有 Eden 的 1/8，
 * 所以存活率一旦超过 12.5%，剩下的只能提前晋升到老年代。
 */
GC.survivorFit = function (opt) {
    const live = opt.eden * (opt.survival / 100);
    return {
        live,
        cap: opt.survivor,
        fits: live <= opt.survivor,
        overflow: Math.max(0, live - opt.survivor),
        thresholdPct: (opt.survivor / opt.eden) * 100,
    };
};

/**
 * 分代回收的多轮演进（纯函数，给定参数结果完全确定）。
 * 每一轮 = 往 Eden 里塞对象直到塞不下 → 触发一次 Minor GC。
 * 返回每轮的快照数组。
 */
GC.genRun = function (opt) {
    const rnd = GC.rng(opt.seed || 20260731);
    const clone = (a) => a.map((o) => ({ id: o.id, size: o.size, age: o.age, born: o.born }));
    const sizes = opt.sizes || [1, 2, 1, 3, 2, 1, 4, 2, 1, 3, 1, 2, 5, 1, 2, 1];
    const st = { eden: [], s0: [], s1: [], old: [], from: 0, nid: 1 };
    const snaps = [];
    let si = 0;

    for (let r = 1; r <= opt.rounds; r++) {
        // ---- 分配：一直往 Eden 塞，直到下一个对象塞不下 ----
        const fresh = [], big = [];
        let guard = 0;
        for (;;) {
            if (++guard > 400) break;
            const sz = sizes[si % sizes.length];
            const o = { id: 'o' + st.nid, size: sz, age: 0, born: r };
            if (sz >= opt.bigObj) {                       // 大对象直接进老年代
                st.nid++; si++; st.old.push(o); big.push(o); continue;
            }
            if (GC.used(st.eden) + sz > opt.eden) break;  // Eden 满 → 触发 Minor GC
            st.nid++; si++; st.eden.push(o); fresh.push(o);
        }

        const fromKey = st.from === 0 ? 's0' : 's1';
        const toKey = st.from === 0 ? 's1' : 's0';
        const pre = {
            eden: clone(st.eden), surv: clone(st[fromKey]), old: clone(st.old),
            fromName: fromKey.toUpperCase(), toName: toKey.toUpperCase(),
        };

        // ---- Minor GC：Eden + From-Survivor 一起回收 ----
        const cands = st.eden.concat(st[fromKey]);
        const survivors = [], died = [];
        cands.forEach((o) => {
            // 已经在 Survivor 里的（age>0）活过一轮了，继续活下去的概率更高 —— 弱分代假说的另一面
            const p = o.age > 0 ? opt.survivorKeep : opt.survival;
            (rnd() * 100 < p ? survivors : died).push(o);
        });
        survivors.forEach((o) => { o.age += 1; });

        const toS = [], pAge = [], pEarly = [];
        survivors.forEach((o) => {
            if (o.age >= opt.tenure) { st.old.push(o); pAge.push(o); return; }      // 年龄到阈值 → 晋升
            if (GC.used(toS) + o.size <= opt.survivor) { toS.push(o); return; }
            st.old.push(o); pEarly.push(o);                                          // Survivor 放不下 → 提前晋升
        });

        st.eden = [];
        st[fromKey] = [];
        st[toKey] = toS;
        st.from = st.from === 0 ? 1 : 0;

        // ---- 老年代满了 → Full GC（老年代自己做一次标记-整理）----
        let fullGC = null, oom = false;
        if (GC.used(st.old) > opt.old) {
            const keep = [], drop = [];
            st.old.forEach((o) => { (rnd() * 100 < opt.oldSurvival ? keep : drop).push(o); });
            fullGC = { before: GC.used(st.old), after: GC.used(keep), freed: GC.used(drop) };
            st.old = keep;
            if (GC.used(st.old) > opt.old) {
                oom = true;
                while (st.old.length && GC.used(st.old) > opt.old) st.old.shift();
            }
        }

        snaps.push({
            round: r,
            pre,
            post: { eden: [], surv: clone(toS), old: clone(st.old), toName: toKey.toUpperCase() },
            fresh: clone(fresh), big: clone(big),
            survivors: clone(survivors), died: clone(died),
            promotedAge: clone(pAge), promotedEarly: clone(pEarly),
            edenUsed: GC.used(pre.eden), oldUsed: GC.used(st.old),
            survUsed: GC.used(toS), fullGC, oom,
        });
    }
    return snaps;
};

// ---------- 场景（写死的对象图，不用随机，保证可对照）----------

GC.SCENARIOS = {
    basic: {
        id: 'basic',
        name: '基础对象图',
        heap: 48,
        garbageFromRow: 3,
        one: '一个普通时刻的堆：7 个还有人用的对象，5 个已经没人要的对象，混在一起躺着。',
        roots: [
            { name: '栈 · main.list', kind: 'stack', target: 'list', row: 0 },
            { name: '栈 · main.buf', kind: 'stack', target: 'buf', row: 1 },
            { name: '静态 · Config.I', kind: 'static', target: 'conf', row: 2 },
        ],
        objs: [
            { id: 'list', label: 'ArrayList', size: 3, addr: 0, refs: ['node', 'data'], col: 0, row: 0 },
            { id: 'node', label: 'Node', size: 2, addr: 7, refs: ['data'], col: 1, row: 0 },
            { id: 'data', label: 'byte[4]', size: 4, addr: 12, refs: [], col: 2, row: 0 },
            { id: 'buf', label: 'Buffer', size: 5, addr: 19, refs: ['arr'], col: 0, row: 1 },
            { id: 'arr', label: 'byte[6]', size: 6, addr: 27, refs: [], col: 1, row: 1 },
            { id: 'conf', label: 'Config', size: 2, addr: 35, refs: ['name'], col: 0, row: 2 },
            { id: 'name', label: 'String', size: 3, addr: 37, refs: [], col: 1, row: 2 },
            { id: 'old', label: 'OldList', size: 4, addr: 3, refs: ['oldn'], col: 0, row: 3 },
            { id: 'oldn', label: 'OldNode', size: 3, addr: 9, refs: ['cycA'], col: 1, row: 3 },
            { id: 'cycA', label: '环 A', size: 3, addr: 16, refs: ['cycB'], col: 2, row: 3 },
            { id: 'cycB', label: '环 B', size: 3, addr: 24, refs: ['cycA'], col: 3, row: 3 },
            { id: 'tmp', label: 'Temp', size: 2, addr: 33, refs: [], col: 0, row: 4 },
        ],
    },
    frag: {
        id: 'frag',
        name: '碎片化现场',
        heap: 64,
        garbageFromRow: 4,
        one: '存活对象被垃圾均匀地隔开了 —— 这是长期运行的服务里最常见的堆形状。',
        roots: [
            { name: '栈 · svc.session', kind: 'stack', target: 'session', row: 0 },
            { name: '栈 · req.cart', kind: 'stack', target: 'cart', row: 2 },
            { name: '静态 · Conf.I', kind: 'static', target: 'conf', row: 3 },
        ],
        objs: [
            { id: 'session', label: 'Session', size: 4, addr: 0, refs: ['user', 'orders'], col: 0, row: 0 },
            { id: 'user', label: 'User', size: 3, addr: 10, refs: [], col: 1, row: 0 },
            { id: 'orders', label: 'Order[]', size: 4, addr: 19, refs: ['cache'], col: 1, row: 1 },
            { id: 'cache', label: 'Cache', size: 4, addr: 38, refs: [], col: 2, row: 1 },
            { id: 'cart', label: 'Cart', size: 3, addr: 29, refs: ['logbuf'], col: 0, row: 2 },
            { id: 'logbuf', label: 'LogBuf', size: 3, addr: 48, refs: [], col: 1, row: 2 },
            { id: 'conf', label: 'Conf', size: 3, addr: 57, refs: [], col: 0, row: 3 },
            { id: 'tmp1', label: '临时 1', size: 6, addr: 4, refs: ['tmp2'], col: 0, row: 4 },
            { id: 'tmp2', label: '临时 2', size: 6, addr: 13, refs: [], col: 1, row: 4 },
            { id: 'req1', label: '旧请求 1', size: 6, addr: 23, refs: ['req2'], col: 2, row: 4 },
            { id: 'req2', label: '旧请求 2', size: 6, addr: 32, refs: [], col: 3, row: 4 },
            { id: 'zomA', label: '环 A', size: 6, addr: 42, refs: ['zomB'], col: 0, row: 5 },
            { id: 'zomB', label: '环 B', size: 6, addr: 51, refs: ['zomA'], col: 1, row: 5 },
        ],
    },
};

/** 一条龙：给定场景 + 算法，把整趟回收算完（界面和单测都用它）*/
GC.runAll = function (scen) {
    const trace = GC.markTrace(scen.objs, scen.roots);
    const swept = GC.sweep(scen.heap, scen.objs, trace.marked);
    const sweptRuns = GC.freeRuns(swept.cells);
    const comp = GC.compact(scen.heap, swept.live);
    const compRuns = GC.freeRuns(comp.cells);
    const copy = GC.copyCollect(scen.heap, scen.objs, scen.roots);
    return { trace, swept, sweptRuns, comp, compRuns, copy };
};

if (typeof module !== 'undefined' && module.exports) module.exports = GC;
if (typeof window !== 'undefined') window.GCModel = GC;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const COL = {
    white: '#ffffff',
    gray: '#9ca3af',
    black: '#374151',
    live: '#4f46e5',
    dead: '#fee2e2',
    free: '#f1f3f6',
    alloc: '#10b981',
};

const ALGOS = [
    { v: 'sweep', label: '标记-清除' },
    { v: 'compact', label: '标记-整理' },
    { v: 'copy', label: '复制' },
    { v: 'gen', label: '分代' },
];

const state = {
    scen: 'basic',
    algo: 'sweep',
    step: 0,
    allocSize: 10,
    allocTried: false,
    survival: 8,
    genRound: 1,
    gen: {
        eden: 32, survivor: 4, old: 48,
        survival: 8, survivorKeep: 70, oldSurvival: 45,
        tenure: 15, bigObj: 5, rounds: 10, seed: 20260731,
    },
};

let rootEl = null;
const ui = {};

// ---------- 步骤 ----------

function scen() { return GC.SCENARIOS[state.scen]; }

function buildSteps() {
    const sc = scen();
    const trace = GC.markTrace(sc.objs, sc.roots);
    const steps = [{ k: 'init' }];
    trace.steps.forEach((s, i) => steps.push({ k: 'mark', i, s }));
    if (state.algo === 'copy') {
        steps.push({ k: 'copy' });
        steps.push({ k: 'clear' });
    } else {
        steps.push({ k: 'sweep' });
        if (state.algo === 'compact') steps.push({ k: 'compact' });
    }
    return { trace, steps };
}

/** 当前步骤下每个对象是什么颜色 */
function colorMap(stepObj, trace) {
    const m = Object.create(null);
    scen().objs.forEach((o) => { m[o.id] = 'white'; });
    if (!stepObj) return m;
    if (stepObj.k === 'mark') {
        stepObj.s.black.forEach((id) => { m[id] = 'black'; });
        stepObj.s.gray.forEach((id) => { m[id] = 'gray'; });
    } else if (stepObj.k !== 'init') {
        scen().objs.forEach((o) => { m[o.id] = trace.marked.has(o.id) ? 'live' : 'dead'; });
    }
    return m;
}

function fillOf(c) {
    return c === 'white' ? COL.white : c === 'gray' ? COL.gray
        : c === 'black' ? COL.black : c === 'live' ? COL.live : COL.dead;
}
function textOf(c) { return (c === 'white' || c === 'dead') ? '#374151' : '#ffffff'; }

// ---------- 对象图 ----------

const NW = 100, NH = 34, COLW = 136, ROWH = 50, GX = 152, GY = 18, RW = 130;

function objGraph(cmap) {
    const sc = scen();
    const nRows = Math.max.apply(null, sc.objs.map((o) => o.row)) + 1;
    const W = 880;
    const H = GY + nRows * ROWH + 18;
    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'gc-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '对象引用图',
    });

    const nx = (o) => GX + o.col * COLW;
    const ny = (o) => GY + o.row * ROWH;
    const byId = GC.index(sc.objs);

    // 箭头头
    const defs = svg('defs');
    [['gc-ah', '#9aa3b0'], ['gc-ah-hot', '#4f46e5']].forEach((a) => {
        const mk = svg('marker', {
            id: a[0], viewBox: '0 0 8 8', refX: 7, refY: 4,
            markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
        }, svg('path', { d: 'M0 0 L8 4 L0 8 z', fill: a[1] }));
        defs.appendChild(mk);
    });
    root.appendChild(defs);

    // 垃圾带的分隔线
    const sepY = GY + sc.garbageFromRow * ROWH - 9;
    root.appendChild(svg('line', { x1: 8, x2: W - 10, y1: sepY, y2: sepY, class: 'gc-band' }));
    root.appendChild(T({ x: 10, y: sepY - 5, class: 'gc-band-txt' },
        '↓ 下面这些从 GC Roots 一步都走不到 —— 不管它们互相引用得多热闹，都是垃圾'));

    // 边
    sc.objs.forEach((o) => {
        (o.refs || []).forEach((t) => {
            const b = byId[t];
            if (!b) return;
            const hot = cmap[o.id] === 'black' && (cmap[t] === 'gray' || cmap[t] === 'black');
            const cls = 'gc-edge' + (hot ? ' gc-edge-hot' : '');
            const mk = hot ? 'url(#gc-ah-hot)' : 'url(#gc-ah)';
            let d;
            if (b.col > o.col) {
                const x1 = nx(o) + NW, y1 = ny(o) + NH / 2, x2 = nx(b), y2 = ny(b) + NH / 2;
                const dx = Math.max(24, (x2 - x1) * 0.55);
                d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
            } else {
                // 回边（含循环引用）：从底部绕一圈回去，一眼看出是个环
                const x1 = nx(o) + NW / 2, y1 = ny(o) + NH, x2 = nx(b) + NW / 2, y2 = ny(b) + NH;
                d = `M${x1} ${y1} C${x1} ${y1 + 26} ${x2} ${y2 + 26} ${x2} ${y2}`;
            }
            root.appendChild(svg('path', { d, class: cls, fill: 'none', 'marker-end': mk }));
        });
    });

    // GC Roots
    sc.roots.forEach((r) => {
        const y = GY + r.row * ROWH;
        const on = cmap[r.target] !== 'white';
        root.appendChild(svg('rect', {
            x: 10, y, width: RW, height: NH, rx: 8,
            class: 'gc-root' + (on ? ' gc-root-on' : ''),
        }));
        root.appendChild(T({ x: 10 + RW / 2, y: y + 14, class: 'gc-root-txt', 'text-anchor': 'middle' }, r.name));
        root.appendChild(T({ x: 10 + RW / 2, y: y + 26, class: 'gc-root-sub', 'text-anchor': 'middle' },
            r.kind === 'stack' ? '栈上的局部变量' : '静态变量（类变量）'));
        const b = GC.index(sc.objs)[r.target];
        if (b) {
            const x1 = 10 + RW, y1 = y + NH / 2, x2 = nx(b), y2 = ny(b) + NH / 2;
            root.appendChild(svg('path', {
                d: `M${x1} ${y1} C${x1 + 14} ${y1} ${x2 - 14} ${y2} ${x2} ${y2}`,
                class: 'gc-edge' + (on ? ' gc-edge-hot' : ''), fill: 'none',
                'marker-end': on ? 'url(#gc-ah-hot)' : 'url(#gc-ah)',
            }));
        }
    });

    // 节点
    sc.objs.forEach((o) => {
        const c = cmap[o.id], x = nx(o), y = ny(o);
        root.appendChild(svg('rect', {
            x, y, width: NW, height: NH, rx: 8,
            fill: fillOf(c), stroke: c === 'white' ? '#cbd2dc' : (c === 'dead' ? '#fca5a5' : 'none'),
            'stroke-width': 1.4, 'stroke-dasharray': c === 'dead' ? '4 3' : 'none',
        }));
        root.appendChild(T({ x: x + NW / 2, y: y + 15, class: 'gc-node-txt', 'text-anchor': 'middle', fill: textOf(c) }, o.label));
        root.appendChild(T({ x: x + NW / 2, y: y + 27, class: 'gc-node-sub', 'text-anchor': 'middle', fill: textOf(c) },
            o.size + ' 格 @' + o.addr));
    });

    return root;
}

// ---------- 堆条 ----------

const HW = 880, HPAD_L = 62, HPAD_R = 14;

/**
 * rows = [{ title, n, objs:[{addr,size,label,color}], runs:[], maxRunLen, alloc:{at,size}, empty }]
 */
function heapSvg(rows) {
    const ROW_H = 40, RUN_H = 14, RULER_H = 16, GAP = 26;
    let H = 10;
    rows.forEach(() => { H += 16 + ROW_H + RUN_H + RULER_H + GAP; });
    const W = HW;
    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'gc-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '堆内存格子图',
    });

    let y = 10;
    rows.forEach((row) => {
        const iw = W - HPAD_L - HPAD_R;
        const cw = iw / row.n;
        const x = (i) => HPAD_L + i * cw;

        root.appendChild(T({ x: 4, y: y + 11, class: 'gc-lane-title' }, row.title));
        if (row.right) {
            root.appendChild(T({ x: W - HPAD_R, y: y + 11, class: 'gc-lane-right', 'text-anchor': 'end' }, row.right));
        }
        y += 16;

        // 底：全部空闲
        root.appendChild(svg('rect', { x: HPAD_L, y, width: iw, height: ROW_H, rx: 5, fill: COL.free, stroke: '#e3e7ee' }));
        root.appendChild(T({ x: HPAD_L - 8, y: y + ROW_H / 2 + 4, class: 'gc-lane-label', 'text-anchor': 'end' }, row.label || '堆'));

        // 每格的分隔刻度
        for (let i = 1; i < row.n; i++) {
            root.appendChild(svg('line', {
                x1: x(i), x2: x(i), y1: y + 2, y2: y + ROW_H - 2,
                stroke: '#e8ebf0', 'stroke-width': i % 8 === 0 ? 1 : 0.5,
            }));
        }

        // 对象
        (row.objs || []).forEach((o) => {
            const w = o.size * cw;
            root.appendChild(svg('rect', {
                x: x(o.addr) + 0.8, y: y + 2, width: Math.max(2, w - 1.6), height: ROW_H - 4, rx: 4,
                fill: fillOf(o.color),
                stroke: o.color === 'white' ? '#cbd2dc' : (o.color === 'dead' ? '#f87171' : 'none'),
                'stroke-width': 1.2,
                'stroke-dasharray': o.color === 'dead' ? '3 3' : 'none',
            }));
            if (w > 34) {
                root.appendChild(T({
                    x: x(o.addr) + w / 2, y: y + ROW_H / 2 + 4, class: 'gc-obj-txt',
                    'text-anchor': 'middle', fill: textOf(o.color),
                }, o.label));
            }
        });

        // 新分配上去的对象
        if (row.alloc) {
            const w = row.alloc.size * cw;
            root.appendChild(svg('rect', {
                x: x(row.alloc.at) + 0.8, y: y + 2, width: Math.max(2, w - 1.6), height: ROW_H - 4, rx: 4,
                fill: COL.alloc,
            }));
            if (w > 40) {
                root.appendChild(T({
                    x: x(row.alloc.at) + w / 2, y: y + ROW_H / 2 + 4,
                    class: 'gc-obj-txt', 'text-anchor': 'middle', fill: '#fff',
                }, '新对象 ' + row.alloc.size + ' 格'));
            }
        }

        if (row.empty) {
            root.appendChild(T({ x: HPAD_L + iw / 2, y: y + ROW_H / 2 + 4, class: 'gc-empty-txt', 'text-anchor': 'middle' },
                row.empty));
        }
        y += ROW_H + 3;

        // 空闲块条
        const maxLen = row.runs ? GC.maxRun(row.runs) : 0;
        (row.runs || []).forEach((r) => {
            const isMax = r.len === maxLen && maxLen > 0;
            root.appendChild(svg('rect', {
                x: x(r.start) + 0.8, y, width: Math.max(2, r.len * cw - 1.6), height: RUN_H, rx: 3,
                class: 'gc-run' + (isMax ? ' gc-run-max' : ''),
            }));
            if (r.len * cw > 18) {
                root.appendChild(T({
                    x: x(r.start) + (r.len * cw) / 2, y: y + RUN_H - 3.5,
                    class: 'gc-run-txt' + (isMax ? ' gc-run-txt-max' : ''), 'text-anchor': 'middle',
                }, String(r.len)));
            }
        });
        if (row.runs) {
            root.appendChild(T({ x: HPAD_L - 8, y: y + RUN_H - 3.5, class: 'gc-lane-sub', 'text-anchor': 'end' }, '空闲块'));
        }
        y += RUN_H + 2;

        // 地址尺
        const tick = row.n > 48 ? 8 : (row.n > 24 ? 8 : 4);
        for (let i = 0; i <= row.n; i += tick) {
            root.appendChild(T({ x: x(i), y: y + 11, class: 'gc-addr', 'text-anchor': 'middle' }, String(i)));
        }
        y += RULER_H + GAP;
    });

    return root;
}

// ---------- 主视图 ----------

function currentCtx() {
    const built = buildSteps();
    const steps = built.steps;
    const idx = Math.max(0, Math.min(state.step, steps.length - 1));
    return { trace: built.trace, steps, idx, cur: steps[idx] };
}

function paintMain() {
    if (state.algo === 'gen') { paintGen(); return; }
    const sc = scen();
    const ctx = currentCtx();
    const cmap = colorMap(ctx.cur, ctx.trace);
    const all = GC.runAll(sc);

    // --- 步骤条 ---
    ui.stepBar.innerHTML = '';
    const jump = (k) => {
        const i = ctx.steps.map((s) => s.k).lastIndexOf(k);
        if (i >= 0) { state.step = i; state.allocTried = false; paintMain(); }
    };
    const btn = (label, fn, cls) => h('button.mini' + (cls || ''), { onclick: fn }, label);
    ui.stepBar.appendChild(h('div.gc-steps', null,
        btn('◀ 上一步', () => { state.step = Math.max(0, ctx.idx - 1); state.allocTried = false; paintMain(); }),
        btn('下一步 ▶', () => { state.step = Math.min(ctx.steps.length - 1, ctx.idx + 1); state.allocTried = false; paintMain(); }, '.primary'),
        h('span.gc-progress', { text: (ctx.idx + 1) + ' / ' + ctx.steps.length }),
        btn('① 跳到标记完成', () => jump('mark')),
        state.algo === 'copy' ? btn('② 跳到复制完成', () => jump('copy')) : btn('② 跳到清除完成', () => jump('sweep')),
        state.algo === 'compact' ? btn('③ 跳到整理完成', () => jump('compact')) : null,
        state.algo === 'copy' ? btn('③ 清空 From 半区', () => jump('clear')) : null,
        btn('重来', () => { state.step = 0; state.allocTried = false; paintMain(); })
    ));

    // --- 对象图 + 堆条 ---
    ui.mainBody.innerHTML = '';
    ui.mainBody.appendChild(Viz.legend(
        ctx.cur.k === 'init' || ctx.cur.k === 'mark'
            ? [
                { cls: 'gc-k-white', text: '白：还没碰过' },
                { cls: 'gc-k-gray', text: '灰：已发现，引用还没扫完（在队列里）' },
                { cls: 'gc-k-black', text: '黑：自己和引用全处理完了' },
            ]
            : [
                { cls: 'gc-k-live', text: '存活（被标记到）' },
                { cls: 'gc-k-dead', text: '判定为垃圾' },
                { cls: 'gc-k-free', text: '空闲格' },
                { cls: 'gc-k-run', text: '空闲块（最大的那块加深）' },
            ]
    ));
    ui.mainBody.appendChild(objGraph(cmap));

    // 堆条
    const rows = [];
    const mkObjs = (objs, colorFn) => objs.map((o) => ({
        addr: o.addr, size: o.size, label: o.label, color: colorFn(o),
    }));

    if (state.algo === 'copy') {
        const half = sc.heap;
        const copied = ctx.cur.k === 'copy' || ctx.cur.k === 'clear';
        const fromCleared = ctx.cur.k === 'clear';
        rows.push({
            title: 'From 半区（正在用的那一半）', label: 'From', n: half,
            objs: fromCleared ? [] : mkObjs(sc.objs, (o) => cmap[o.id]),
            runs: fromCleared ? [{ start: 0, len: half }] : GC.freeRuns(GC.cellsOf(half, sc.objs)),
            empty: fromCleared ? '整片作废 —— 死对象一个都不用管，分配指针直接拨回 0' : null,
            right: fromCleared ? '已清空，等着下次当 To 半区' : ('已用 ' + GC.used(sc.objs) + ' / ' + half + ' 格'),
        });
        rows.push({
            title: 'To 半区（另一半，平时完全闲置）', label: 'To', n: half,
            objs: copied ? all.copy.objs.map((o) => ({ addr: o.addr, size: o.size, label: o.label, color: 'live' })) : [],
            runs: copied ? GC.freeRuns(all.copy.toCells) : [{ start: 0, len: half }],
            empty: copied ? null : '空着 —— 这就是「永远浪费一半空间」的那一半',
            right: copied ? ('存活 ' + all.copy.bump + ' 格，其余 ' + (half - all.copy.bump) + ' 格连续空闲') : ('闲置 ' + half + ' 格'),
        });
    } else {
        const k = ctx.cur.k;
        let objs, runs, alloc = null, right;
        if (k === 'compact') {
            objs = all.comp.objs.map((o) => ({ addr: o.addr, size: o.size, label: o.label, color: 'live' }));
            runs = all.compRuns;
            right = '压实到地址 0～' + (all.comp.bump - 1) + '，分配指针 = ' + all.comp.bump;
        } else if (k === 'sweep') {
            objs = mkObjs(all.swept.live, () => 'live');
            runs = all.sweptRuns;
            right = '存活 ' + all.swept.liveCells + ' 格，回收 ' + all.swept.freedCells + ' 格';
        } else {
            objs = mkObjs(sc.objs, (o) => cmap[o.id]);
            runs = GC.freeRuns(GC.cellsOf(sc.heap, sc.objs));
            right = '已用 ' + GC.used(sc.objs) + ' / ' + sc.heap + ' 格';
        }
        if (state.allocTried && (k === 'sweep' || k === 'compact')) {
            const r = GC.tryAlloc(runs, state.allocSize);
            if (r.ok) alloc = { at: r.at, size: state.allocSize };
        }
        rows.push({ title: '堆（一格 = 一个抽象分配单位）', label: '堆', n: sc.heap, objs, runs, alloc, right });
    }
    ui.mainBody.appendChild(heapSvg(rows));
    ui.mainBody.appendChild(h('div.seq-note', { html: stepNote(ctx, all) }));

    // 引用改写表
    if (ctx.cur.k === 'compact' || ctx.cur.k === 'copy' || ctx.cur.k === 'clear') {
        const oldLive = state.algo === 'copy' ? sc.objs.filter((o) => all.copy.marked.has(o.id)) : all.swept.live;
        const newLive = state.algo === 'copy' ? all.copy.objs : all.comp.objs;
        ui.mainBody.appendChild(refTable(oldLive, newLive));
    }

    paintStats(all, ctx);
    paintPunch(all, ctx);
}

function stepNote(ctx, all) {
    const sc = scen();
    const byId = GC.index(sc.objs);
    const k = ctx.cur.k;
    if (k === 'init') {
        const dead = sc.objs.length - ctx.trace.marked.size;
        return `堆里躺着 <b>${sc.objs.length}</b> 个对象、占 <b>${GC.used(sc.objs)}</b> 格，`
            + `还剩 <b>${sc.heap - GC.used(sc.objs)}</b> 格空闲。<b>光看堆是分不出谁是垃圾的</b> —— `
            + `必须从 GC Roots（栈上的局部变量、静态变量）出发走一遍，走得到的才算活着。`
            + `点「下一步」开始标记，你会看到染色一层层扩散出去，最后剩下 <b>${dead}</b> 个白的。`;
    }
    if (k === 'mark') {
        const s = ctx.cur.s;
        const o = byId[s.id];
        const via = s.via.indexOf('root:') === 0
            ? `<b>${Viz.esc(s.via.slice(5))}</b>（GC Root）`
            : `<b>${Viz.esc(byId[s.via] ? byId[s.via].label : s.via)}</b>`;
        const pushed = s.pushed.map((t) => byId[t].label).join('、');
        const tail = s.pushed.length
            ? `它引用的 <b>${Viz.esc(pushed)}</b> 被推进灰色队列，下一步再处理。`
            : '它不再引用任何新对象，队列没有增长。';
        const last = ctx.idx === ctx.steps.length - (state.algo === 'copy' ? 3 : (state.algo === 'compact' ? 3 : 2));
        return `第 ${ctx.cur.i + 1} 步：从 ${via} 找到 <b>${Viz.esc(o.label)}</b>，把它<b>染黑</b>（说明它和它的引用都处理完了）。${tail}`
            + (last
                ? `<br><br>队列空了，<b>标记阶段结束</b>：一共染黑 ${ctx.trace.marked.size} 个对象。`
                  + `剩下的白色对象从 Roots 一步都走不到 —— 注意那对<b>互相引用的「环 A / 环 B」</b>：`
                  + `它们的引用计数永远是 1，引用计数法一辈子回收不掉它们；<b>可达性分析一眼就看穿了</b>。`
                : '');
    }
    if (k === 'sweep') {
        const runs = all.sweptRuns;
        return `白色对象占的格子直接标成空闲，<b>存活对象一格都没动</b> —— 地址不变、内容不变、引用不用改写，`
            + `这就是标记-清除快的地方（也是唯一的好处）。<br>代价立刻显现：`
            + `空闲空间被切成了 <b>${runs.length}</b> 块，总共 <b>${GC.totalFree(runs)}</b> 格，`
            + `但<b>最大的一块只有 ${GC.maxRun(runs)} 格</b>。下面那张卡片就是为这件事准备的。`;
    }
    if (k === 'compact') {
        const moved = all.comp.moves.filter((m) => m.moved).length;
        const ups = GC.refUpdates(GC.materialize(all.swept.live), GC.materialize(all.comp.objs)).filter((u) => u.changed);
        return `存活对象<b>按原来的先后顺序</b>向低地址端滑动压实。现在空闲是<b>一整块 ${GC.maxRun(all.compRuns)} 格</b>，`
            + `碎片彻底消失，分配退化成最简单的「指针碰撞」。<br>代价也很实在：搬动了 <b>${moved}</b> 个对象`
            + `（共 ${all.comp.bump} 格数据要真的拷贝），并且<b>所有指向它们的引用都必须改写</b> —— `
            + `这次改了 <b>${ups.length}</b> 处，明细在下面。改写期间对象地址在变，所以整个过程必须 STW。`;
    }
    if (k === 'copy') {
        return `按 Cheney 算法把存活对象抄进 To 半区 —— <b>抄的顺序就是刚才那趟 BFS 的顺序</b>，`
            + `所以复制之后对象排列会跟着可达性重排（顺带改善了局部性，是白送的好处）。`
            + `抄的时候顺手把引用改成新地址。注意：<b>它从头到尾没有碰过任何一个死对象</b>。`;
    }
    if (k === 'clear') {
        const half = sc.heap;
        return `From 半区<b>整片作废</b>：不需要遍历、不需要逐个清理死对象，把分配指针拨回 0 就完事了。`
            + `<br>这就是复制算法快的根源 —— <b>它的代价只跟存活对象有关，跟垃圾有多少完全无关</b>。`
            + `新生代里 90% 以上的对象活不过第一次 GC，所以「搬走的那一点点」几乎是免费的。`
            + `<br>但账也要算清楚：为了这个，你永远有 <b>${half}</b> 格（整整一半堆）是闲置的。`;
    }
    return '';
}

function refTable(oldObjs, newObjs) {
    const o1 = GC.materialize(oldObjs), o2 = GC.materialize(newObjs);
    const ups = GC.refUpdates(o1, o2);
    const byId = GC.index(newObjs);
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '哪个对象的哪个字段' }), h('th', { text: '指向' }),
        h('th', { text: '旧地址' }), h('th', { text: '新地址' }), h('th', { text: '' })));
    ups.forEach((u) => {
        const tr = h('tr');
        tr.appendChild(h('td.mv-strong', { text: (byId[u.from] ? byId[u.from].label : u.from) + '.ref' }));
        tr.appendChild(h('td', { text: byId[u.to] ? byId[u.to].label : u.to }));
        tr.appendChild(h('td', { text: '@' + u.oldAddr }));
        tr.appendChild(h('td', { text: '@' + u.newAddr }));
        tr.appendChild(h('td' + (u.changed ? '.bad' : '.ok'), { text: u.changed ? '必须改写' : '没变' }));
        tb.appendChild(tr);
    });
    return h('div', null,
        h('p.sec-note', { html: '<b>引用改写明细</b>：对象一动，所有存着它地址的字段都得跟着改，一处漏掉就是野指针。' }),
        h('div.mv-matrix-wrap', null, tb));
}

// ---------- 空闲空间统计 ----------

function paintStats(all, ctx) {
    ui.statsBody.innerHTML = '';
    const k = ctx.cur.k;
    let runs, label;
    if (state.algo === 'copy') {
        runs = (k === 'copy' || k === 'clear') ? GC.freeRuns(all.copy.toCells) : [{ start: 0, len: 0 }];
        label = (k === 'copy' || k === 'clear') ? 'To 半区回收之后' : '还没开始复制';
    } else if (k === 'compact') {
        runs = all.compRuns; label = '标记-整理跑完之后';
    } else if (k === 'sweep') {
        runs = all.sweptRuns; label = '标记-清除跑完之后';
    } else {
        runs = GC.freeRuns(GC.cellsOf(scen().heap, scen().objs)); label = '回收之前';
    }
    const total = GC.totalFree(runs), max = GC.maxRun(runs);
    ui.statsBody.appendChild(Viz.cmpGrid([
        { h: label + ' · 总空闲', v: total + ' 格', d: '所有空洞加起来', cls: 'cmp-save' },
        { h: '最大连续空闲', v: max + ' 格', d: '真正决定能不能分配的数字', cls: max === total ? 'cmp-ok' : 'cmp-bad' },
        { h: '空闲块个数', v: String(runs.filter((r) => r.len > 0).length), d: '空闲链表上挂了几块', cls: runs.length > 1 ? 'cmp-bad' : 'cmp-ok' },
    ]));
    ui.statsBody.appendChild(h('p.sec-note', {
        html: max === total && total > 0
            ? '<b>最大连续 == 总空闲</b>，说明一点碎片都没有 —— 任何不超过这个数的申请都一定能满足。'
            : (total > 0
                ? `总空闲 ${total} 格，但最大连续只有 ${max} 格。`
                  + `<b>操作系统 / JVM 分配对象要的是「一段连续地址」，不是「总量」</b>，`
                  + `所以能不能分配成功只看后面那个数字。`
                : '还没回收，先把上面的步骤走完。'),
    }));
}

// ---------- 打脸卡片 ----------

function paintPunch(all, ctx) {
    ui.punchBody.innerHTML = '';
    const k = ctx.cur.k;
    const done = k === 'sweep' || k === 'compact' || k === 'copy' || k === 'clear';
    if (!done) {
        ui.punchBody.appendChild(h('p.sec-note', {
            html: '把上面的回收流程走完（点「② 跳到清除完成」最快），这里就会出现结果。'
                + '想直接看最戏剧的那一幕，按下面的<b>「制造碎片」</b>。',
        }));
        ui.punchBody.appendChild(punchButtons());
        return;
    }

    let runs;
    if (state.algo === 'copy') runs = GC.freeRuns(all.copy.toCells);
    else if (k === 'compact') runs = all.compRuns;
    else runs = all.sweptRuns;

    const total = GC.totalFree(runs), max = GC.maxRun(runs);
    const res = GC.tryAlloc(runs, state.allocSize);

    ui.punchBody.appendChild(h('div.gc-punch', null,
        h('div.gc-punch-cell', null,
            h('div.gc-punch-h', { text: '总空闲空间' }),
            h('div.gc-big', { text: String(total) }),
            h('div.gc-punch-d', { text: '格 —— 看起来绰绰有余' })),
        h('div.gc-punch-op', { text: 'VS' }),
        h('div.gc-punch-cell' + (max < state.allocSize ? '.bad' : '.ok'), null,
            h('div.gc-punch-h', { text: '最大连续空闲' }),
            h('div.gc-big', { text: String(max) }),
            h('div.gc-punch-d', { text: '格 —— 这个才算数' }))
    ));

    ui.punchBody.appendChild(h('div.gc-alloc-bar', null,
        h('span.ctl-name', { text: '申请一个大对象：' }),
        h('input.bp-input', {
            type: 'number', min: '1', max: '64', value: String(state.allocSize),
            oninput: (e) => {
                const v = Math.max(1, Math.min(64, Number(e.target.value) || 1));
                state.allocSize = v;
            },
        }),
        h('span.ctl-name', { text: '格' }),
        h('button.mini.primary', {
            onclick: () => { state.allocTried = true; paintMain(); },
        }, '试着分配'),
        h('button.mini', {
            onclick: () => { state.allocTried = false; paintMain(); },
        }, '收起结果')
    ));

    if (state.allocTried) {
        ui.punchBody.appendChild(h('div.gc-verdict' + (res.ok ? '.ok' : '.bad'), {
            html: res.ok
                ? `<b>✓ 分配成功</b> —— 落在地址 <b>@${res.at}</b>（首次适应）。`
                  + `最佳适应会选 <b>@${res.best}</b>。堆上那块绿色就是它。`
                : `<b>✗ 分配失败</b> —— 空闲总量有 <b>${total}</b> 格，可就是凑不出 <b>${state.allocSize}</b> 格连续的地址；`
                  + `最大的一块才 <b>${max}</b> 格。<br>首次适应找不到、最佳适应也找不到 —— `
                  + `<b>它们只是不同的挑法，挑不出来的东西还是挑不出来。</b>`
                  + `<br>接下来 JVM 会做的事：<b>触发一次 Full GC</b>，把老年代也一起做标记-整理，`
                  + `压实之后再试一次；还是不行才抛 OutOfMemoryError。`
                  + `<b>注意这次 Full GC 完全是碎片逼出来的，堆里其实一点都不缺空间。</b>`,
        }));
    }

    ui.punchBody.appendChild(punchButtons());
}

function punchButtons() {
    const box = h('div.ctl-btns.gc-preset', null,
        h('button.mini.danger', {
            onclick: () => {
                state.scen = 'frag'; state.algo = 'sweep'; state.allocSize = 10;
                state.step = buildSteps().steps.length - 1;
                state.allocTried = true;
                render();
            },
        }, '① 制造碎片（标记-清除跑完）'),
        h('button.mini.primary', {
            onclick: () => {
                state.scen = 'frag'; state.algo = 'compact'; state.allocSize = 10;
                state.step = buildSteps().steps.length - 1;
                state.allocTried = true;
                render();
            },
        }, '② 同样的对象，改用标记-整理'),
        h('button.mini', {
            onclick: () => {
                state.scen = 'basic'; state.algo = 'sweep'; state.step = 0;
                state.allocSize = 10; state.allocTried = false;
                render();
            },
        }, '回到基础场景')
    );
    return h('div', null,
        h('p.sec-note', {
            html: '<b>推荐路线</b>：先按 ①，看「总空闲 40 / 最大连续 6，申请 10 格失败」；'
                + '再按 ②，<b>同一批存活对象</b>压实之后最大连续变成 40，同一个申请立刻成功。',
        }),
        box);
}

// ---------- 分代视图 ----------

function genSnaps() {
    return GC.genRun(Object.assign({}, state.gen));
}

function genBar(root, y, label, cap, objs, colorFn, cw, note) {
    const x0 = 96;
    const ROW = 30;
    root.appendChild(T({ x: x0 - 8, y: y + 20, class: 'gc-lane-label', 'text-anchor': 'end' }, label));
    root.appendChild(svg('rect', { x: x0, y: y + 2, width: cap * cw, height: ROW, rx: 5, fill: COL.free, stroke: '#e3e7ee' }));
    for (let i = 1; i < cap; i++) {
        root.appendChild(svg('line', { x1: x0 + i * cw, x2: x0 + i * cw, y1: y + 4, y2: y + ROW, stroke: '#e8ebf0', 'stroke-width': 0.5 }));
    }
    let p = 0;
    objs.forEach((o) => {
        const c = colorFn(o);
        const w = o.size * cw;
        root.appendChild(svg('rect', {
            x: x0 + p * cw + 0.6, y: y + 4, width: Math.max(2, w - 1.2), height: ROW - 4, rx: 3,
            fill: c.fill, stroke: c.stroke || 'none', 'stroke-width': 1.1,
            'stroke-dasharray': c.dash || 'none',
        }));
        if (w > 17) {
            root.appendChild(T({
                x: x0 + p * cw + w / 2, y: y + ROW / 2 + 6, class: 'gc-age',
                'text-anchor': 'middle', fill: c.text || '#fff',
            }, String(o.age)));
        }
        p += o.size;
    });
    root.appendChild(T({ x: x0 + cap * cw + 8, y: y + 21, class: 'gc-lane-sub' },
        GC.used(objs) + '/' + cap + (note ? '　' + note : '')));
    return y + ROW + 8;
}

function paintGen() {
    const snaps = genSnaps();
    const r = Math.max(1, Math.min(state.genRound, snaps.length));
    const s = snaps[r - 1];
    const g = state.gen;

    ui.stepBar.innerHTML = '';
    ui.stepBar.appendChild(h('div.gc-steps', null,
        h('button.mini', { onclick: () => { state.genRound = Math.max(1, r - 1); paintGen(); } }, '◀ 上一轮'),
        h('button.mini.primary', { onclick: () => { state.genRound = Math.min(snaps.length, r + 1); paintGen(); } }, '下一轮 Minor GC ▶'),
        h('span.gc-progress', { text: '第 ' + r + ' / ' + snaps.length + ' 轮' }),
        h('button.mini', { onclick: () => { state.genRound = 1; paintGen(); } }, '重来')
    ));

    ui.mainBody.innerHTML = '';
    ui.mainBody.appendChild(Viz.legend([
        { cls: 'gc-k-live', text: '这轮存活（框里数字 = 年龄）' },
        { cls: 'gc-k-dead', text: '这轮死掉' },
        { cls: 'gc-k-prom', text: '晋升到老年代' },
        { cls: 'gc-k-big', text: '大对象，直接进老年代' },
    ]));

    const survSet = new Set(s.survivors.map((o) => o.id));
    const ageSet = new Set(s.promotedAge.map((o) => o.id));
    const earlySet = new Set(s.promotedEarly.map((o) => o.id));
    const bigSet = new Set(s.big.map((o) => o.id));

    const cw = 13;
    const W = 880;
    const H = 2 * (3 * 38 + 22) + 30;
    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'gc-svg', preserveAspectRatio: 'xMidYMid meet',
        role: 'img', 'aria-label': '分代堆布局',
    });

    const preColor = (o) => {
        if (bigSet.has(o.id)) return { fill: COL.alloc };
        if (!survSet.has(o.id)) return { fill: COL.dead, stroke: '#f87171', dash: '3 3', text: '#b91c1c' };
        if (ageSet.has(o.id) || earlySet.has(o.id)) return { fill: '#f97316' };
        return { fill: COL.live };
    };
    const postColor = (o) => {
        if (bigSet.has(o.id)) return { fill: COL.alloc };
        if (ageSet.has(o.id) || earlySet.has(o.id)) return { fill: '#f97316' };
        return { fill: COL.live };
    };

    let y = 6;
    root.appendChild(T({ x: 4, y: y + 10, class: 'gc-lane-title' }, `第 ${r} 轮 · Minor GC 之前（Eden 刚好塞满）`));
    y += 16;
    y = genBar(root, y, 'Eden', g.eden, s.pre.eden, preColor, cw, s.pre.eden.length + ' 个对象');
    y = genBar(root, y, s.pre.fromName + '（From）', g.survivor, s.pre.surv, preColor, cw, '上一轮的幸存者');
    y = genBar(root, y, '老年代', g.old, s.pre.old, preColor, cw * 0.72, '');
    y += 10;

    root.appendChild(T({ x: 4, y: y + 10, class: 'gc-lane-title' }, `Minor GC 之后（Eden 与 From 整体清空）`));
    y += 16;
    y = genBar(root, y, 'Eden', g.eden, [], postColor, cw, '整片清空，分配指针归 0');
    y = genBar(root, y, s.post.toName + '（To）', g.survivor, s.post.surv, postColor, cw, '年龄都 +1 了');
    y = genBar(root, y, '老年代', g.old, s.post.old, postColor, cw * 0.72, s.fullGC ? '← 这轮触发了 Full GC' : '');

    ui.mainBody.appendChild(root);

    const died = s.died.length, surv = s.survivors.length;
    const rate = (died + surv) ? Math.round((surv / (died + surv)) * 100) : 0;
    ui.mainBody.appendChild(h('div.seq-note', {
        html: `这一轮往 Eden 里塞了 <b>${s.pre.eden.length}</b> 个对象（${s.edenUsed} 格）就塞满了，触发 Minor GC。`
            + `候选对象（Eden + From-Survivor）里活下来 <b>${surv}</b> 个、死了 <b>${died}</b> 个，存活率 <b>${rate}%</b>。`
            + `<br>其中 <b>${s.promotedAge.length}</b> 个因为<b>年龄到了 ${g.tenure}</b> 晋升老年代；`
            + `<b>${s.promotedEarly.length}</b> 个因为 <b>Survivor（只有 ${g.survivor} 格）放不下</b>被<b>提前晋升</b>；`
            + `另有 <b>${s.big.length}</b> 个<b>大对象（≥${g.bigObj} 格）在分配时就直接进了老年代</b>，压根没经过 Eden —— `
            + `否则它们要在两个 Survivor 之间来回抄，纯属浪费。`
            + (s.fullGC
                ? `<br><b>老年代放不下了（${s.fullGC.before} > ${g.old}），触发 Full GC</b>：`
                  + `回收掉 ${s.fullGC.freed} 格，剩 ${s.fullGC.after} 格。`
                  + `<b>Full GC 要停顿整个堆，比 Minor GC 贵一个数量级</b> —— `
                  + `而它常常就是被上面那些「提前晋升」喂出来的。`
                : '')
            + (s.oom ? '<br><b>Full GC 之后仍然放不下 → OutOfMemoryError。</b>' : ''),
    }));

    // 轮次表
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '轮' }), h('th', { text: 'Eden 分配' }), h('th', { text: '大对象直入老年代' }),
        h('th', { text: '存活' }), h('th', { text: '进 Survivor' }), h('th', { text: '年龄晋升' }),
        h('th', { text: '提前晋升' }), h('th', { text: '老年代占用' }), h('th', { text: 'Full GC' })));
    snaps.forEach((sn) => {
        const tr = h('tr' + (sn.round === r ? '.on' : ''), { onclick: () => { state.genRound = sn.round; paintGen(); } });
        [
            String(sn.round), sn.edenUsed + ' 格', sn.big.length + ' 个',
            sn.survivors.length + ' 个', sn.survUsed + '/' + g.survivor + ' 格',
            String(sn.promotedAge.length), String(sn.promotedEarly.length),
            sn.oldUsed + '/' + g.old + ' 格',
        ].forEach((c, i) => tr.appendChild(h('td' + (i === 0 ? '.mv-strong' : ''), { text: c })));
        tr.appendChild(h('td' + (sn.fullGC ? '.bad' : ''), { text: sn.fullGC ? '触发' : '—' }));
        tb.appendChild(tr);
    });
    ui.mainBody.appendChild(h('p.sec-note', { html: '点表格任意一行可以跳到那一轮。' }));
    ui.mainBody.appendChild(h('div.mv-matrix-wrap', null, tb));

    ui.statsBody.innerHTML = '';
    const totalEarly = snaps.reduce((a, x) => a + x.promotedEarly.length, 0);
    const totalAge = snaps.reduce((a, x) => a + x.promotedAge.length, 0);
    const fulls = snaps.filter((x) => x.fullGC).length;
    ui.statsBody.appendChild(Viz.cmpGrid([
        { h: '累计「年龄到了」晋升', v: totalAge + ' 个', d: '正常晋升，这是设计意图', cls: 'cmp-ok' },
        { h: '累计「提前晋升」', v: totalEarly + ' 个', d: 'Survivor 装不下被挤出去的', cls: totalEarly > 0 ? 'cmp-bad' : 'cmp-ok' },
        { h: 'Full GC 次数', v: fulls + ' 次', d: totalEarly > 0 ? '大半是提前晋升喂出来的' : '老年代很稳', cls: fulls > 0 ? 'cmp-bad' : 'cmp-ok' },
    ]));
    ui.statsBody.appendChild(h('p.sec-note', {
        html: '<b>提前晋升是线上最常见的隐性杀手</b>：它不报错、不告警，只是悄悄把一堆本该在新生代死掉的对象'
            + '塞进老年代，直到 Full GC 频率高得离谱才被发现。'
            + '调 <code>-Xmn</code>（新生代大小）和 <code>-XX:SurvivorRatio</code> 主要就是在跟这件事较劲。',
    }));

    ui.punchBody.innerHTML = '';
    ui.punchBody.appendChild(h('p.sec-note', {
        html: '分代模式下这张卡片换成<b>晋升规则的三个预设</b>。选完直接看上面的表格和图。',
    }));
    ui.punchBody.appendChild(h('div.ctl-btns.gc-preset', null,
        h('button.mini', {
            onclick: () => { Object.assign(state.gen, { survival: 8, tenure: 15 }); state.genRound = 1; paintGen(); },
        }, '正常：存活 8%，Survivor 装得下'),
        h('button.mini.danger', {
            onclick: () => { Object.assign(state.gen, { survival: 45, tenure: 15 }); state.genRound = 1; paintGen(); },
        }, 'Survivor 放不下 → 提前晋升'),
        h('button.mini.primary', {
            onclick: () => { Object.assign(state.gen, { survival: 12, tenure: 4 }); state.genRound = 1; paintGen(); },
        }, '把阈值调到 4，看年龄晋升')
    ));
    ui.punchBody.appendChild(h('div.controls', null,
        Viz.slider({
            label: '新生代存活率', min: 2, max: 60, step: 1, value: g.survival,
            fmt: (v) => v + '%', onInput: (v) => { g.survival = v; paintGen(); },
        }),
        Viz.slider({
            label: '晋升年龄阈值', min: 1, max: 15, step: 1, value: g.tenure,
            fmt: (v) => String(v), onInput: (v) => { g.tenure = v; paintGen(); },
        }),
        Viz.slider({
            label: '大对象阈值', min: 3, max: 8, step: 1, value: g.bigObj,
            fmt: (v) => '≥' + v + ' 格', onInput: (v) => { g.bigObj = v; state.genRound = 1; paintGen(); },
        }),
        Viz.slider({
            label: 'Survivor 大小', min: 2, max: 12, step: 1, value: g.survivor,
            fmt: (v) => v + ' 格', onInput: (v) => { g.survivor = v; paintGen(); },
        })
    ));
}

// ---------- 复制成本卡 ----------

function paintCost() {
    ui.costBody.innerHTML = '';
    const s = state.survival;
    const cells = 100;
    const c = GC.gcCost({ cells, survival: s });
    const be = GC.copyBreakEven({}) * 100;
    const fit = GC.survivorFit({ eden: state.gen.eden, survivor: state.gen.survivor, survival: s });

    const maxV = Math.max(c.markSweep, c.markCompact, c.copying, 1);
    const W = 880, BH = 34, H = 3 * (BH + 12) + 26;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'gc-svg', preserveAspectRatio: 'xMidYMid meet' });
    const x0 = 108, iw = W - x0 - 130;
    const bars = [
        ['复制', c.copying, '#10b981'],
        ['标记-清除', c.markSweep, '#4f46e5'],
        ['标记-整理', c.markCompact, '#f97316'],
    ];
    let y = 8;
    bars.forEach((b) => {
        root.appendChild(T({ x: x0 - 8, y: y + BH / 2 + 4, class: 'gc-lane-label', 'text-anchor': 'end' }, b[0]));
        root.appendChild(svg('rect', { x: x0, y, width: iw, height: BH, rx: 5, fill: '#f6f7f9' }));
        root.appendChild(svg('rect', { x: x0, y, width: Math.max(2, (b[1] / maxV) * iw), height: BH, rx: 5, fill: b[2] }));
        root.appendChild(T({ x: x0 + iw + 8, y: y + BH / 2 + 4, class: 'gc-cost-txt', fill: b[2] },
            Math.round(b[1]) + ' 工作量'));
        y += BH + 12;
    });
    ui.costBody.appendChild(root);

    ui.costBody.appendChild(Viz.cmpGrid([
        { h: '存活对象', v: Math.round(c.live) + ' 格', d: '一百格堆里活着的', cls: 'cmp-save' },
        { h: '复制 vs 标记-清除', v: (c.copying <= c.markSweep ? '复制更划算' : '复制更贵'), d: `盈亏平衡点在存活率 ${Math.round(be)}%`, cls: c.copying <= c.markSweep ? 'cmp-ok' : 'cmp-bad' },
        { h: 'Survivor 装得下吗', v: fit.fits ? '装得下' : '装不下', d: fit.fits ? `${Math.round(fit.live)} ≤ ${fit.cap} 格` : `溢出 ${Math.round(fit.overflow)} 格 → 提前晋升`, cls: fit.fits ? 'cmp-ok' : 'cmp-bad' },
    ]));

    ui.costBody.appendChild(h('div.seq-note', {
        html: `<b>为什么复制在低存活率下几乎免费</b>：标记-清除有一项固定开销 —— `
            + `<b>清除必须线性扫一遍整个堆</b>才能找出空闲块，这项跟垃圾多少无关、跟堆多大有关。`
            + `复制算法<b>连死对象都不看一眼</b>，代价只有「搬走那几个活的」。存活率 5% 时，`
            + `复制的工作量只有标记-清除的四分之一左右。`
            + `<br><br><b>三个阈值，记住这三个数就够了：</b>`
            + `<br>· <b>${fit.thresholdPct.toFixed(1)}%</b> —— Survivor 只有 Eden 的 1/8，存活率一超过它，`
            + `多出来的对象<b>只能提前晋升到老年代</b>（当前 ${Math.round(fit.live)} 格 vs 容量 ${fit.cap} 格）。`
            + `<br>· <b>${Math.round(be)}%</b> —— 搬运比扫描贵，存活率超过这里，<b>复制的总工作量就反超标记-清除了</b>。`
            + `<br>· <b>50%</b> —— 堆对半分时 To 半区必须装得下全部存活对象，存活率过半，<b>复制算法直接没法用</b>。`
            + `<br><br>老年代的存活率通常在 <b>90% 以上</b>，三条线全部踩爆 —— `
            + `<b>所以老年代只能用标记-清除或标记-整理，不能用复制。</b>`
            + `而新生代存活率通常只有 <b>2%~10%</b>，复制那点搬运量几乎不要钱，`
            + `还白送了「分配 = 指针碰撞」这个大好处：不用查空闲链表、不用挑块，`
            + `<b>指针往后一挪就是新对象</b>。`,
    }));
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const sc = scen();

    // 1. 场景 + 算法切换
    const head = Viz.card('fa-trash-can', 'GC 要回答的其实只有两个问题',
        '<b>① 谁是垃圾？</b>—— 从 GC Roots 出发走一遍，走不到的就是垃圾（可达性分析）。'
        + '<b>② 收回来的空间怎么摆？</b>—— 四种基础算法的分歧全在这一步：'
        + '是原地留下空洞、还是压实、还是整体搬到另一半、还是按年龄分开管。'
        + '<br>下面这四个按钮切的就是第二个问题的四种答案。<b>第一个问题（标记）四种算法完全一样。</b>');
    head.appendChild(Viz.segmented({
        options: ALGOS, value: state.algo,
        onPick: (v) => { state.algo = v; state.step = 0; state.allocTried = false; render(); },
    }));
    if (state.algo !== 'gen') {
        head.appendChild(h('p.sec-note', { html: '换一个堆的初始形状：' }));
        head.appendChild(Viz.segmented({
            options: Object.keys(GC.SCENARIOS).map((k) => ({ v: k, label: GC.SCENARIOS[k].name })),
            value: state.scen,
            onPick: (v) => { state.scen = v; state.step = 0; state.allocTried = false; render(); },
        }));
        head.appendChild(h('p.sec-note', { html: '当前场景：<b>' + sc.name + '</b> —— ' + sc.one }));
    } else {
        head.appendChild(h('p.sec-note', {
            html: '<b>分代不是第五种算法，是一种「分工」</b>：新生代（Eden + 两个 Survivor，8:1:1）用<b>复制</b>，'
                + '老年代用<b>标记-清除 / 标记-整理</b>。依据是<b>弱分代假说</b>：'
                + '绝大多数对象朝生夕死，熬过几次 GC 还活着的，多半会一直活下去。',
        }));
    }
    rootEl.appendChild(head);

    // 2. 主视图
    const main = Viz.card('fa-microchip',
        state.algo === 'gen' ? '主视图：新生代与老年代之间的对象流动' : '主视图：对象图 + 堆内存格子',
        state.algo === 'gen'
            ? '上半是 Minor GC 之前、下半是之后。方块里的数字是对象<b>年龄</b>（熬过几次 GC）。'
            : '上面是对象之间的引用关系，下面是它们在堆上实际占的格子。<b>两张图颜色永远同步</b> —— '
              + '标记阶段一步染一个，看得见染色怎么从 Roots 扩散出去。');
    ui.stepBar = h('div');
    ui.mainBody = h('div');
    main.appendChild(ui.stepBar);
    main.appendChild(ui.mainBody);
    rootEl.appendChild(main);

    // 3. 空闲空间统计
    const stats = Viz.card('fa-ruler-horizontal',
        state.algo === 'gen' ? '几轮跑下来的晋升账' : '空闲空间：总量和「最大连续」是两码事', null);
    ui.statsBody = h('div');
    stats.appendChild(ui.statsBody);
    rootEl.appendChild(stats);

    // 4. 打脸卡片
    const punch = Viz.card('fa-bomb',
        state.algo === 'gen' ? '晋升规则：三个预设场景' : '空间够，却分配失败 —— 碎片化是怎么杀人的', null);
    ui.punchBody = h('div');
    punch.appendChild(ui.punchBody);
    rootEl.appendChild(punch);

    // 5. 四种算法对比
    rootEl.appendChild(Viz.card('fa-table-list', '四种基础算法，一张表看完',
        '注意<b>没有一种是全面胜出的</b>，每一行都是拿一样东西换另一样。',
        algoMatrix()));

    // 6. 复制为什么划算
    const cost = Viz.card('fa-scale-unbalanced', '反直觉：复制算法「浪费一半空间」，反而是最划算的',
        '拖动下面的存活率，看三种算法的工作量怎么此消彼长。堆固定为 100 格（抽象单位）。');
    cost.appendChild(h('div.controls', null, Viz.slider({
        label: '新生代存活率', min: 1, max: 90, step: 1, value: state.survival,
        fmt: (v) => v + '%', onInput: (v) => { state.survival = v; paintCost(); },
    })));
    ui.costBody = h('div');
    cost.appendChild(ui.costBody);
    rootEl.appendChild(cost);

    // 7. 晋升规则
    rootEl.appendChild(Viz.card('fa-arrow-up-right-dots', '对象是怎么一步步爬进老年代的', null, promoFlow()));

    // 8. 面试怎么答
    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa(QA)));

    // 9. 坑
    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls(PITS)));

    // 10. 简化口径
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示（做了哪些简化）' }),
        h('p', {
            html: '<b>格子是抽象分配单位，不是字节。</b>真实堆的对象头、对齐填充、TLAB 都不在这里 —— '
                + '一格你可以理解成「若干字节的一个块」，重点是相对大小和连续性，不是绝对数字。',
        }),
        h('p', {
            html: '<b>对象图是我构造的，不是从真实程序 dump 出来的。</b>'
                + '两个场景（基础 / 碎片化）都是为了把现象说清楚特意摆的位置：'
                + '「碎片化现场」里存活对象被垃圾均匀隔开，是刻意做出来的最坏情况，'
                + '目的是让「总空闲 40 / 最大连续 6」这个对比足够刺眼。真实堆的碎片程度介于两者之间。',
        }),
        h('p', {
            html: '<b>标记阶段画的是完全 STW 的串行版本。</b>并发标记、写屏障（增量更新 / 原始快照 SATB）、'
                + '三色不变式的破坏与修复都没有画进来 —— 这里的三色只用来展示 BFS 的中间状态。'
                + '同样没有画的还有：<b>TLAB</b>（线程本地分配缓冲）、<b>卡表 Card Table</b>、'
                + '<b>Remembered Set</b>（跨代引用怎么记）、<b>分配担保</b>的完整规则、finalize 的复活机制。',
        }),
        h('p', {
            html: '<b>代价模型是相对工作量，不是纳秒。</b>「标记 2 / 扫描 1 / 搬运 3」这组系数是为了'
                + '把三条曲线的相对形状画出来，真实比例随硬件、对象大小、指针密度变化很大。'
                + '结论（复制的代价只跟存活量有关、清除有一项固定的全堆扫描）是稳的，具体数字别当基准测试用。',
        }),
        h('p', {
            html: '<b>分代模拟里对象的存亡是固定种子的伪随机</b>（不用 <code>Math.random()</code>，'
                + '刷新前后结果完全一样，方便对照和单测）。Eden 里的对象按滑块给的存活率决定生死，'
                + '已经进过 Survivor 的按固定 70% —— 这是弱分代假说的另一面（活得越久越可能继续活）。',
        })
    ));

    // 首次绘制
    paintMain();
    paintCost();
}

function algoMatrix() {
    const rows = [
        ['标记-清除', '不移动', '有，而且会越来越碎', '快（不用搬对象）', '空闲链表，要挑块', '老年代（CMS）'],
        ['标记-整理', '存活对象滑到一端', '完全没有', '慢（搬对象 + 改所有引用）', '指针碰撞', '老年代（Serial Old / Parallel Old）'],
        ['复制', '整体抄到另一半', '完全没有', '只跟存活量有关，垃圾多少无所谓', '指针碰撞', '新生代'],
        ['分代（组合）', '新生代复制，老年代整理', '老年代仍需定期整理', '大部分时间只收新生代，很便宜', '新生代指针碰撞', '几乎所有主流 JVM 收集器'],
    ];
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '算法' }), h('th', { text: '对象会不会动' }), h('th', { text: '内存碎片' }),
        h('th', { text: '回收耗时' }), h('th', { text: '分配方式' }), h('th', { text: '实际用在哪' })));
    rows.forEach((r, i) => {
        const key = ['sweep', 'compact', 'copy', 'gen'][i];
        const tr = h('tr' + (key === state.algo ? '.on' : ''), {
            onclick: () => { state.algo = key; state.step = 0; state.allocTried = false; render(); },
        });
        r.forEach((c, j) => tr.appendChild(h('td' + (j === 0 ? '.mv-strong' : ''), { text: c })));
        tb.appendChild(tr);
    });
    return h('div', null,
        h('p.sec-note', { html: '点任意一行可以直接切到那个算法的演示。' }),
        h('div.mv-matrix-wrap', null, tb));
}

function promoFlow() {
    return Viz.flowList([
        {
            t: '① 新对象在 Eden 里分配',
            f: 'ptr += size;   // 指针碰撞，就这一行',
            r: 'Eden 是连续的，分配只是把指针往后挪一格',
            hi: '例外：<b>大对象直接进老年代</b>（<code>-XX:PretenureSizeThreshold</code>）。'
                + '因为大对象在两个 Survivor 之间来回复制成本极高，还容易把 Survivor 直接撑爆。',
        },
        {
            t: '② Eden 满了 → 触发 Minor GC（Young GC）',
            f: 'roots ∪ 老年代指向新生代的引用 → 可达的就是存活对象',
            r: '只收新生代，停顿短。老年代不参与',
            hi: '老年代对象也可能引用新生代对象。为了不扫整个老年代，JVM 用<b>卡表 Card Table</b> + '
                + '<b>写屏障</b>把「哪些老年代页面里有跨代引用」记下来，Minor GC 只扫这些页面。',
        },
        {
            t: '③ 存活对象复制到 To-Survivor，年龄 +1',
            f: 'age++;  copy(obj, toSurvivor);',
            r: '两个 Survivor 轮流当 From / To，每次 GC 交换一次',
            hi: '为什么要<b>两个</b> Survivor 而不是一个？因为复制算法需要一块空地当目标区。'
                + '只有一个 Survivor 的话，存活对象没地方放，就只能立刻晋升老年代。',
        },
        {
            t: '④ 年龄超过阈值 → 晋升老年代',
            f: 'if (age >= MaxTenuringThreshold) promote(obj);   // 默认 15',
            r: '熬过 15 次 Minor GC 还活着，基本可以认为它会长期活着',
            hi: 'HotSpot 还有个<b>动态年龄判定</b>：如果 Survivor 里同年龄的对象加起来超过一半，'
                + '大于等于该年龄的<b>直接全部晋升</b>，不用等到 15。',
        },
        {
            t: '⑤ Survivor 放不下 → 提前晋升（这条最容易出事）',
            f: 'if (used(toSurvivor) + size > survivorCap) promote(obj);',
            r: 'Survivor 只有新生代的 1/10，存活率一超过 ~12.5% 就开始往老年代倒',
            hi: '这是<b>老年代过早填满、Full GC 变频繁</b>的头号原因，而且它完全不报错，只能靠 GC 日志发现。'
                + '典型诱因：突发流量、大 List 一次性加载、缓存预热。',
        },
        {
            t: '⑥ 老年代也满了 → Full GC',
            f: '老年代做标记-整理（或标记-清除），停顿整个堆',
            r: '比 Minor GC 贵一个数量级；再放不下就 OutOfMemoryError',
            hi: '还有一种触发方式在上面演示过了：<b>老年代空间够、但碎得没有一块连续空间放下大对象</b>，'
                + '也会触发 Full GC。CMS 时代这是最典型的「明明还有内存却 Full GC」。',
        },
    ]);
}

const QA = [
    {
        q: '为什么不用引用计数？',
        a: '两个致命问题。<b>① 循环引用回收不掉</b>：A 引用 B、B 引用 A，两边计数永远是 1，'
            + '哪怕外面早就没人引用它俩了 —— 上面演示里那对「环 A / 环 B」就是专门做出来给你看的，'
            + '可达性分析一步就把它们判成垃圾。'
            + '<b>② 计数本身很贵</b>：每一次引用赋值都要改两个计数器（旧目标 -1、新目标 +1），'
            + '多线程下这两个操作还得是原子的，热点路径上开销大得离谱；'
            + '而且计数归零可能引发级联释放，造成不可预测的长停顿。'
            + '<br>所以主流 JVM / Go 全用<b>可达性分析</b>。'
            + 'CPython 用引用计数是因为它有 GIL（计数不用原子操作），但它<b>额外挂了一个分代循环回收器</b>专门处理环。',
    },
    {
        q: '三色标记是什么？并发标记为什么会漏标？怎么修？',
        a: '<b>白</b>=没访问过、<b>灰</b>=访问过但引用还没扫完、<b>黑</b>=自己和引用都扫完了。'
            + '标记结束时还是白的就是垃圾。上面主视图里染色的那三种颜色就是它。'
            + '<br><b>漏标</b>只在「标记和用户线程并发跑」时才会发生，需要<b>同时</b>满足两个条件：'
            + '① 用户线程<b>插入了一条黑 → 白的新引用</b>；② 同时<b>删掉了所有灰 → 白的引用</b>。'
            + '这时白对象没人再去扫它，却是活的 —— 被当垃圾回收掉，程序直接崩。'
            + '<br>两种修法各破坏一个条件：'
            + '<b>增量更新（Incremental Update，CMS 用）</b>破坏条件①：黑对象新增引用时，把<b>黑对象</b>记下来，'
            + '重新标记阶段再以它为根扫一遍。'
            + '<b>原始快照（SATB，G1 / Shenandoah 用）</b>破坏条件②：引用<b>被删除</b>时，把<b>旧的那个引用</b>记下来，'
            + '按「标记开始那一刻的快照」处理 —— 宁可放过（浮动垃圾留到下次），也不能错杀。'
            + '两者都靠<b>写屏障</b>实现。',
    },
    {
        q: 'STW 到底停的是什么？为什么非停不可？',
        a: '停的是<b>所有用户线程</b>（Java 线程），GC 线程照跑。'
            + '<br>为什么非停不可：GC 在动对象图，用户线程也在动对象图，两边打架就会出错。'
            + '最典型的是<b>移动对象</b>时 —— 整理和复制都要改写引用，'
            + '改写的一瞬间如果有线程正拿着旧地址读写，读到的就是垃圾数据。'
            + '<br>另外 <b>GC Roots 枚举必须 STW</b>：要准确知道每个栈帧里哪些槽位是引用（靠 OopMap），'
            + '而 OopMap 只在特定位置（<b>安全点 Safepoint</b>）才是准确的，'
            + '所以 JVM 会让线程「跑到最近的安全点再停」，不是立刻停。'
            + '这也是为什么<b>可数循环</b>（int 计数）里可能没有安全点，导致某个线程迟迟停不下来、整体停顿被拖长。',
    },
    {
        q: 'G1 / ZGC 跟这四种基础算法是什么关系？',
        a: '它们不是新算法，是<b>把这四种基础算法重新组合 + 加并发</b>。'
            + '<br><b>G1</b>：把堆切成上千个大小相等的 Region，Eden / Survivor / Old 只是 Region 的<b>角色标签</b>。'
            + '回收时挑「垃圾最多、收益最高」的几个 Region（所以叫 Garbage First），'
            + '把它们的存活对象<b>复制</b>到别的空 Region —— 所以 <b>G1 局部看是复制、整体看是标记-整理</b>，'
            + '因此它<b>不产生碎片</b>（这是 G1 取代 CMS 的关键理由之一，CMS 是标记-清除，会碎）。'
            + '<br><b>ZGC / Shenandoah</b>：目标是把「移动对象」这件事也做成并发的。'
            + 'ZGC 用<b>染色指针</b>（把标记信息直接塞进 64 位指针的空闲位里）+ <b>读屏障</b>：'
            + '用户线程每次读引用都会被拦一下，如果发现这个对象已经被搬走了，就<b>当场修正指针</b>再返回。'
            + '这样整理可以跟用户线程同时进行，停顿被压到亚毫秒，且<b>与堆大小无关</b>。'
            + '<br>一句话：<b>基础算法决定「空间怎么摆」，并发方案决定「什么时候能不停顿地摆」。</b>',
    },
    {
        q: '标记-清除和标记-整理，老年代到底该选哪个？',
        a: '看你怕停顿还是怕碎片。'
            + '<b>标记-清除</b>不搬对象，回收阶段可以做成并发（CMS 就是这么做的），停顿短；'
            + '代价是碎片会累积，最终必然遇到「空间够但分配失败」→ 被迫来一次 <b>Full GC + 压缩</b>，'
            + '那一下停顿反而特别长（CMS 有 <code>-XX:CMSFullGCsBeforeCompaction</code> 就是在调这个）。'
            + '<b>标记-整理</b>每次都压实，永不碎片，代价是每次都要搬对象 + 改引用，停顿更长且必须 STW。'
            + '<br>现代收集器（G1 / ZGC）的答案是<b>两个都要</b>：平时并发标记，回收时只挑少数 Region 做复制式压缩，'
            + '把「整理」的成本摊成很多小份。',
    },
];

const PITS = [
    ['「内存够」和「能分配」是两件事',
        '这是本演示的核心。分配一个对象要的是<b>一段连续地址</b>，看的是<b>最大连续空闲</b>，'
        + '不是空闲总量。上面那个「总空闲 40 格、最大连续 6 格、申请 10 格失败」就是标准剧本 —— '
        + '换成首次适应还是最佳适应都没用，<b>它们只是不同的挑法，挑不出来的东西还是挑不出来</b>。'
        + '线上表现：堆使用率明明只有 60%，却在疯狂 Full GC。'],
    ['System.gc() 不是「立刻回收」，是「建议」',
        '<code>System.gc()</code> 只是<b>建议</b> JVM 做一次 Full GC，JVM 完全可以无视'
        + '（<code>-XX:+DisableExplicitGC</code> 直接把它变成空操作）。'
        + '而一旦它真的执行了，那就是一次<b>全堆 STW</b>，在生产环境里几乎总是坏事。'
        + '真实事故常见于 NIO 的 DirectByteBuffer 回收逻辑和某些框架的定时清理线程。'],
    ['对象「不可达」不等于「已经被回收」',
        '不可达只是<b>拿到了死刑判决书</b>，什么时候执行由 GC 说了算。'
        + '所以内存泄漏排查里，「对象已经没人引用了」和「内存降下来了」中间还隔着一次 GC。'
        + '更坑的是 <code>finalize()</code>：不可达对象在第一次被标记时如果重写了 finalize，'
        + '会被放进 F-Queue 缓刑一次，甚至能在 finalize 里<b>把自己重新挂到某个静态变量上复活</b>。'
        + 'finalize 早已被标记废弃，别用。'],
    ['提前晋升是最安静的杀手',
        'Survivor 只有新生代的 1/10，存活率一超过 ~12.5%（本演示里 Eden 32 格 / Survivor 4 格），'
        + '装不下的对象会<b>直接被塞进老年代</b>。这些对象本来在下一次 Minor GC 就该死掉的，'
        + '现在却要等一次昂贵的 Full GC 才能清掉。'
        + '<b>它不报错、不告警</b>，唯一的症状是 Full GC 频率慢慢变高。'
        + '排查靠 GC 日志里的晋升量（promoted）和老年代增长速率，不是靠看堆大小。'],
    ['碎片化不只发生在 GC 里',
        '同样的道理适用于任何「按需切分连续空间」的地方：'
        + 'C 的 <code>malloc</code>、Redis 的 jemalloc（所以有 <code>activedefrag</code>）、'
        + '文件系统的磁盘块、甚至数据库页内的行空间。'
        + '解法也永远是那两条：<b>要么定期整理（有停顿），要么按固定尺寸分档分配</b>（slab / size class，'
        + '牺牲一点内部碎片换掉外部碎片）。'],
    ['别拿这个演示的数字去调线上参数',
        '格子是抽象单位，代价系数是为了画图挑的。真实调优必须看 GC 日志'
        + '（<code>-Xlog:gc*</code>）里的实际停顿时间、晋升量、各代占用曲线。'
        + '尤其是「存活率」这个词，在真实系统里随流量波动极大，'
        + '不存在一个能照抄的固定值。'],
];

Viz.register({
    id: 'gc',
    cat: 'os',
    title: '垃圾回收算法',
    subtitle: '标记-清除 / 整理 / 复制 / 分代',
    icon: 'fa-trash-can',
    blurb: '同一批存活对象，四种回收方式在堆上留下完全不同的形状',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.scen = 'basic';
        state.algo = 'sweep';
        state.step = 0;
        state.allocSize = 10;
        state.allocTried = false;
        state.survival = 8;
        state.genRound = 1;
        Object.assign(state.gen, {
            eden: 32, survivor: 4, old: 48,
            survival: 8, survivorKeep: 70, oldSurvival: 45,
            tenure: 15, bigObj: 5, rounds: 10, seed: 20260731,
        });
        render();
    },
    unmount() {
        // 没有 rAF / 定时器，清引用即可
        ui.stepBar = ui.mainBody = ui.statsBody = ui.punchBody = ui.costBody = null;
        rootEl = null;
    },
});

})();
