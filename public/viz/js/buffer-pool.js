// ============================================================
//  演示：InnoDB Buffer Pool
//  教科书讲 LRU，MySQL 用的却不是教科书 LRU —— 它把链表切成 young(5/8) 和 old(3/8)，
//  新页先塞进 old 的头部，只有「在 old 里待够时间、并且被再次访问」才升进 young。
//  这套设计就是为了扛住一次全表扫描：扫描页在 old 里自生自灭，热点页纹丝不动。
//  第二部分是脏页 —— 脏页比例顶到红线时用户线程会被拖住，这就是「MySQL 突然抖一下」。
//  上半 BPL.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const BPL = {};

/**
 * 建一个缓冲池。
 * opt = { cap, mode:'naive'|'midpoint', oldPct=37, oldBlocksTime=1000 }
 *
 * oldPct 37 就是 InnoDB 的默认值 innodb_old_blocks_pct=37（约等于 3/8）。
 * oldBlocksTime 对应 innodb_old_blocks_time=1000(ms)：
 *   一个页刚进 old 子链的这 1 秒内，再怎么被访问也不给升级。
 *   为什么要这条？因为读一个数据页往往紧接着要读它上面的好几行，
 *   如果「访问第二次就升级」，一次全表扫描的每一页都会被升进 young，防线就白设了。
 */
BPL.create = function (opt) {
    const cap = Math.max(2, opt.cap | 0);
    const oldPct = opt.oldPct == null ? 37 : opt.oldPct;
    const oldLen = Math.min(cap - 1, Math.max(1, Math.round(cap * oldPct / 100)));
    return {
        cap, mode: opt.mode || 'midpoint', oldPct,
        oldLen, youngLen: cap - oldLen,
        oldBlocksTime: opt.oldBlocksTime == null ? 1000 : opt.oldBlocksTime,
        list: [],          // head → tail，head 是最近用过的
        hits: 0, misses: 0, evictions: 0, promotions: 0,
    };
};

/** 第 idx 个位置属于 old 子链吗（朴素 LRU 没有 old 的概念，一律 false）*/
BPL.isOld = function (bp, idx) {
    return bp.mode === 'midpoint' && idx >= bp.youngLen;
};

/**
 * 访问一个页。now 是抽象的毫秒时刻。
 * 返回 { hit, idx, promoted, evicted }
 */
BPL.access = function (bp, page, now) {
    let idx = -1;
    for (let i = 0; i < bp.list.length; i++) if (bp.list[i].page === page) { idx = i; break; }

    if (idx >= 0) {
        // ── 命中 ──
        bp.hits++;
        const e = bp.list[idx];
        e.hitCount++;
        e.lastAt = now;

        if (bp.mode === 'naive') {
            bp.list.splice(idx, 1); bp.list.unshift(e);
            return { hit: true, idx, promoted: false, evicted: null };
        }
        if (idx < bp.youngLen) {
            // 已经在 young 里了，往前挪到头部
            bp.list.splice(idx, 1); bp.list.unshift(e);
            return { hit: true, idx, promoted: false, evicted: null };
        }
        // 在 old 子链里：只有「进来够久了」才准升级
        if (now - e.insertedAt >= bp.oldBlocksTime) {
            bp.list.splice(idx, 1); bp.list.unshift(e);
            e.promotedAt = now;
            bp.promotions++;
            return { hit: true, idx, promoted: true, evicted: null };
        }
        // 待得不够久 —— 原地不动，等着被淘汰
        return { hit: true, idx, promoted: false, evicted: null };
    }

    // ── 未命中：从磁盘读进来 ──
    bp.misses++;
    let evicted = null;
    if (bp.list.length >= bp.cap) {
        evicted = bp.list.pop();     // 从链表尾部淘汰
        bp.evictions++;
    }
    const e = { page, insertedAt: now, lastAt: now, hitCount: 0, promotedAt: null };
    // 朴素 LRU 插头部；分区 LRU 插在 old 子链的头部（也就是 midpoint 这个位置）
    const at = bp.mode === 'naive' ? 0 : Math.min(bp.youngLen, bp.list.length);
    bp.list.splice(at, 0, e);
    return { hit: false, idx: at, promoted: false, evicted: evicted ? evicted.page : null };
};

/**
 * 生成负载序列。四个阶段：
 *  warm  预热，顺序读页 1..cap 把池子填满
 *  hot   反复访问热点页 1..hotPages（模拟正常业务）
 *  scan  一次全表扫描，顺序读页 1000..1000+scanPages，每页读 rowsPerPage 行
 *  check 再访问一遍热点页，看还在不在池子里
 */
BPL.workload = function (opt) {
    const cap = opt.cap, hotPages = opt.hotPages, hotRounds = opt.hotRounds;
    const scanPages = opt.scanPages, rowsPerPage = Math.max(1, opt.rowsPerPage || 1);
    const ops = [];
    let t = 0;
    for (let p = 1; p <= cap; p++) ops.push({ page: p, at: t++, phase: 'warm' });
    for (let r = 0; r < hotRounds; r++) {
        for (let p = 1; p <= hotPages; p++) ops.push({ page: p, at: t++, phase: 'hot' });
    }
    for (let i = 0; i < scanPages; i++) {
        const p = 1000 + i;
        for (let k = 0; k < rowsPerPage; k++) ops.push({ page: p, at: t++, phase: 'scan' });
    }
    for (let p = 1; p <= hotPages; p++) ops.push({ page: p, at: t++, phase: 'check' });
    return ops;
};

/** 把 ops 跑完（或跑到 stopAt），返回缓冲池 + 分阶段统计 */
BPL.run = function (opt, ops, stopAt) {
    const bp = BPL.create(opt);
    const n = stopAt == null ? ops.length : Math.max(0, Math.min(stopAt, ops.length));
    const phases = {};
    const events = [];
    for (let i = 0; i < n; i++) {
        const op = ops[i];
        const r = BPL.access(bp, op.page, op.at);
        const ph = phases[op.phase] || (phases[op.phase] = { hits: 0, misses: 0, n: 0 });
        ph.n++;
        if (r.hit) ph.hits++; else ph.misses++;
        events.push({ i, page: op.page, phase: op.phase, hit: r.hit, promoted: r.promoted, evicted: r.evicted });
    }
    Object.keys(phases).forEach((k) => {
        phases[k].rate = phases[k].n ? phases[k].hits / phases[k].n : 0;
    });
    const total = bp.hits + bp.misses;
    return {
        bp, phases, events, ran: n,
        hits: bp.hits, misses: bp.misses,
        hitRate: total ? bp.hits / total : 0,
    };
};

/** 池子里还留着几个热点页（1..hotPages）*/
BPL.hotAlive = function (bp, hotPages) {
    let n = 0;
    bp.list.forEach((e) => { if (e.page >= 1 && e.page <= hotPages) n++; });
    return n;
};

/**
 * 脏页刷盘模拟。
 * opt = { cap, steps, writeRate, bgFlush, aggFlush, maxDirtyPct }
 *
 * 规则（简化的 InnoDB 行为）：
 *  · 每一步后台刷 bgFlush 个脏页；脏页比例顶到红线后转入激进刷盘 aggFlush。
 *  · 脏页比例不允许突破 innodb_max_dirty_pages_pct，写不进去的部分用户线程只能干等 ——
 *    于是吞吐从 writeRate 掉到「能刷多少就写多少」，这就是那一下卡顿。
 */
BPL.dirtySim = function (opt) {
    const cap = opt.cap, steps = opt.steps;
    const writeRate = opt.writeRate, bgFlush = opt.bgFlush;
    const aggFlush = opt.aggFlush == null ? bgFlush * 3 : opt.aggFlush;
    const limit = Math.floor(cap * opt.maxDirtyPct / 100);
    let dirty = 0;
    const rows = [];
    let stallFrom = -1;
    for (let t = 0; t < steps; t++) {
        const over = dirty >= limit;
        const flushed = Math.min(dirty, over ? aggFlush : bgFlush);
        dirty -= flushed;
        const room = Math.max(0, limit - dirty);
        const done = Math.min(writeRate, room);
        dirty += done;
        const stalled = done < writeRate;
        if (stalled && stallFrom < 0) stallFrom = t;
        rows.push({
            t, dirty, dirtyPct: (dirty / cap) * 100,
            flushed, done, stalled, throughput: done,
        });
    }
    return { rows, limit, cap, stallFrom, writeRate };
};

if (typeof module !== 'undefined' && module.exports) module.exports = BPL;
if (typeof window !== 'undefined') window.BPLModel = BPL;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const state = {
    cap: 32,
    hotPages: 8,
    hotRounds: 3,
    scanPages: 60,
    rowsPerPage: 4,
    oldBlocksTime: 1000,
    // -1 = 用默认位置：停在「扫描刚结束、复查还没开始」那一刻。
    // 为什么不是跑完整段？因为复查阶段会把热点页重新读回来，
    // 跑到最后两条链看起来又差不多了，反而看不出扫描造成的破坏。
    step: -1,
    // 脏页
    writeRate: 30,
    maxDirtyPct: 75,
    bgFlush: 12,
};

let rootEl = null;

function makeOps() {
    return BPL.workload({
        cap: state.cap, hotPages: state.hotPages, hotRounds: state.hotRounds,
        scanPages: state.scanPages, rowsPerPage: state.rowsPerPage,
    });
}

function runBoth(ops, stopAt) {
    return {
        naive: BPL.run({ cap: state.cap, mode: 'naive' }, ops, stopAt),
        mid: BPL.run({
            cap: state.cap, mode: 'midpoint', oldPct: 37, oldBlocksTime: state.oldBlocksTime,
        }, ops, stopAt),
    };
}

// ---------- LRU 链表图 ----------

function pageKind(p) {
    if (p >= 1000) return 'scan';
    if (p <= state.hotPages) return 'hot';
    return 'cold';
}

function buildList(res, title, subtitle) {
    const bp = res.bp;
    const cap = bp.cap;
    const PAD_L = 8, PAD_R = 8, TOP = 42, CELL_H = 30;
    const W = 700;
    const innerW = W - PAD_L - PAD_R;
    const cw = innerW / cap;
    const H = TOP + CELL_H + 46;

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'bpl-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': title,
    });

    const t = svg('text', { x: 2, y: 14, class: 'bpl-title' });
    t.textContent = title;
    root.appendChild(t);
    const st = svg('text', { x: 2, y: 28, class: 'bpl-sub' });
    st.textContent = subtitle;
    root.appendChild(st);

    // young / old 底色
    if (bp.mode === 'midpoint') {
        const mx = PAD_L + bp.youngLen * cw;
        root.appendChild(svg('rect', {
            x: PAD_L, y: TOP - 12, width: bp.youngLen * cw, height: CELL_H + 24,
            rx: 6, class: 'bpl-zone bpl-zone-young',
        }));
        root.appendChild(svg('rect', {
            x: mx, y: TOP - 12, width: bp.oldLen * cw, height: CELL_H + 24,
            rx: 6, class: 'bpl-zone bpl-zone-old',
        }));
        const yl = svg('text', { x: PAD_L + 5, y: TOP - 2, class: 'bpl-zone-l bpl-zl-young' });
        yl.textContent = 'young  ' + bp.youngLen + ' 页（约 5/8）';
        root.appendChild(yl);
        const ol = svg('text', { x: mx + 5, y: TOP - 2, class: 'bpl-zone-l bpl-zl-old' });
        ol.textContent = 'old  ' + bp.oldLen + ' 页（3/8）';
        root.appendChild(ol);
        // midpoint 竖线
        root.appendChild(svg('line', {
            x1: mx, x2: mx, y1: TOP - 16, y2: TOP + CELL_H + 16, class: 'bpl-mid',
        }));
        const ml = svg('text', { x: mx, y: TOP + CELL_H + 28, class: 'bpl-mid-l', 'text-anchor': 'middle' });
        ml.textContent = '↑ midpoint：新页从这里插进来';
        root.appendChild(ml);
    } else {
        root.appendChild(svg('rect', {
            x: PAD_L, y: TOP - 12, width: innerW, height: CELL_H + 24,
            rx: 6, class: 'bpl-zone bpl-zone-flat',
        }));
        const yl = svg('text', { x: PAD_L + 5, y: TOP - 2, class: 'bpl-zone-l' });
        yl.textContent = '一条链到底，新页永远插头部';
        root.appendChild(yl);
        const ml = svg('text', { x: PAD_L + 5, y: TOP + CELL_H + 28, class: 'bpl-mid-l' });
        ml.textContent = '↑ 新页从这里插进来';
        root.appendChild(ml);
    }

    // 格子
    for (let i = 0; i < cap; i++) {
        const e = bp.list[i];
        const x = PAD_L + i * cw;
        const kind = e ? pageKind(e.page) : 'empty';
        root.appendChild(svg('rect', {
            x: x + 0.7, y: TOP, width: Math.max(1, cw - 1.4), height: CELL_H,
            rx: 3, class: 'bpl-cell bpl-k-' + kind,
        }));
        if (e && cw >= 15) {
            const lb = svg('text', {
                x: x + cw / 2, y: TOP + CELL_H / 2 + 3.5,
                class: 'bpl-cell-t bpl-ct-' + kind, 'text-anchor': 'middle',
            });
            lb.textContent = e.page >= 1000 ? String(e.page - 1000) : String(e.page);
            root.appendChild(lb);
        }
    }

    // 头尾标注
    const hl = svg('text', { x: PAD_L, y: H - 4, class: 'bpl-end' });
    hl.textContent = '← 头部（最近用过）';
    root.appendChild(hl);
    const tl = svg('text', { x: W - PAD_R, y: H - 4, class: 'bpl-end', 'text-anchor': 'end' });
    tl.textContent = '尾部（下一个被淘汰）→';
    root.appendChild(tl);

    return root;
}

// ---------- 脏页图 ----------

function buildDirty() {
    const sim = BPL.dirtySim({
        cap: 1000, steps: 60, writeRate: state.writeRate,
        bgFlush: state.bgFlush, aggFlush: state.bgFlush * 2,
        maxDirtyPct: state.maxDirtyPct,
    });
    const W = 700, H = 210, PAD_L = 44, PAD_R = 52, PAD_T = 18, PAD_B = 30;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
    const n = sim.rows.length;
    const X = (t) => PAD_L + (t / (n - 1)) * iw;
    const Ypct = (p) => PAD_T + ih - (p / 100) * ih;
    const Ytp = (v) => PAD_T + ih - (v / Math.max(1, state.writeRate)) * ih;

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'bpl-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '脏页比例与吞吐',
    });

    // 卡顿区着色
    if (sim.stallFrom >= 0) {
        root.appendChild(svg('rect', {
            x: X(sim.stallFrom), y: PAD_T, width: Math.max(2, X(n - 1) - X(sim.stallFrom)),
            height: ih, class: 'bpl-stall-zone',
        }));
        const sl = svg('text', { x: X(sim.stallFrom) + 6, y: PAD_T + 14, class: 'bpl-stall-l' });
        sl.textContent = '↓ 从这里开始，用户线程被拖住了';
        root.appendChild(sl);
    }

    // 红线
    const ly = Ypct(state.maxDirtyPct);
    root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L + iw, y1: ly, y2: ly, class: 'bpl-limit' }));
    const ll = svg('text', { x: PAD_L + iw + 4, y: ly + 4, class: 'bpl-limit-l' });
    ll.textContent = 'max_dirty ' + state.maxDirtyPct + '%';
    root.appendChild(ll);

    // 坐标轴
    root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L, y1: PAD_T, y2: PAD_T + ih, class: 'bpl-axis' }));
    root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L + iw, y1: PAD_T + ih, y2: PAD_T + ih, class: 'bpl-axis' }));
    [0, 25, 50, 75, 100].forEach((p) => {
        const y = Ypct(p);
        const lb = svg('text', { x: PAD_L - 6, y: y + 3.5, class: 'bpl-ax-t', 'text-anchor': 'end' });
        lb.textContent = p + '%';
        root.appendChild(lb);
    });

    // 脏页比例曲线
    let d = '';
    sim.rows.forEach((r, i) => { d += (i ? 'L' : 'M') + X(r.t).toFixed(1) + ' ' + Ypct(r.dirtyPct).toFixed(1); });
    root.appendChild(svg('path', { d, class: 'bpl-line-dirty', fill: 'none' }));

    // 吞吐曲线
    let d2 = '';
    sim.rows.forEach((r, i) => { d2 += (i ? 'L' : 'M') + X(r.t).toFixed(1) + ' ' + Ytp(r.throughput).toFixed(1); });
    root.appendChild(svg('path', { d: d2, class: 'bpl-line-tp', fill: 'none' }));

    const l1 = svg('text', { x: PAD_L + 6, y: PAD_T + ih - 6, class: 'bpl-lg bpl-lg-dirty' });
    l1.textContent = '脏页比例';
    root.appendChild(l1);
    const l2 = svg('text', { x: PAD_L + iw - 4, y: Ytp(sim.rows[n - 1].throughput) - 7, class: 'bpl-lg bpl-lg-tp', 'text-anchor': 'end' });
    l2.textContent = '实际写入吞吐 ' + sim.rows[n - 1].throughput + '/步（想写 ' + state.writeRate + '）';
    root.appendChild(l2);

    const xl = svg('text', { x: PAD_L + iw / 2, y: H - 6, class: 'bpl-ax-t', 'text-anchor': 'middle' });
    xl.textContent = '时间（步）';
    root.appendChild(xl);

    return { svg: root, sim };
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const ops = makeOps();
    const scanEnd = Math.max(0, ops.length - state.hotPages);   // 复查阶段开始之前
    const stopAt = state.step < 0 ? scanEnd : Math.min(state.step, ops.length);
    const now = runBoth(ops, stopAt);
    const full = runBoth(ops, ops.length);

    // ── 场景 + 控制 ──
    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '缓冲池页数', min: 16, max: 48, step: 8, value: state.cap,
        fmt: (v) => v + ' 页', onInput: (v) => { state.cap = v; state.step = -1; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '热点页数', min: 4, max: 12, step: 1, value: state.hotPages,
        fmt: (v) => v + ' 页', onInput: (v) => { state.hotPages = v; state.step = -1; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '扫描页数', min: 10, max: 120, step: 10, value: state.scanPages,
        fmt: (v) => v + ' 页', onInput: (v) => { state.scanPages = v; state.step = -1; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '每页读几行', min: 1, max: 8, step: 1, value: state.rowsPerPage,
        fmt: (v) => v + ' 行', onInput: (v) => { state.rowsPerPage = v; state.step = -1; render(); },
    }));

    const obt = h('div.controls');
    obt.appendChild(Viz.slider({
        label: 'innodb_old_blocks_time', min: 0, max: 2000, step: 100, value: state.oldBlocksTime,
        fmt: (v) => v + ' ms', onInput: (v) => { state.oldBlocksTime = v; render(); },
    }));
    obt.appendChild(h('div.ctl-btns', null,
        h('button.mini.danger', {
            onclick: () => {
                state.cap = 32; state.hotPages = 8; state.hotRounds = 3;
                state.scanPages = 60; state.rowsPerPage = 4;
                state.oldBlocksTime = 1000; state.step = -1; render();
            },
        }, '① 全表扫描冲击热点'),
        h('button.mini', {
            onclick: () => { state.oldBlocksTime = 0; state.rowsPerPage = 4; state.step = -1; render(); },
        }, '② 把 old_blocks_time 调成 0'),
        h('button.mini', {
            onclick: () => { state.oldBlocksTime = 1000; state.rowsPerPage = 4; state.step = -1; render(); },
        }, '③ 调回 1000ms')
    ));

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-server"></i> 场景：正常跑着业务，突然来了一条全表扫描' }),
        h('p.sec-note', {
            html: '负载分四段：<b>① 预热</b>把池子填满 → <b>② 热点</b>反复访问前 ' + state.hotPages
                + ' 个页（模拟真实业务的热数据）→ <b>③ 扫描</b>顺序读 ' + state.scanPages
                + ' 个从没读过的页，每页读 ' + state.rowsPerPage + ' 行（一条忘了加索引的 SQL）'
                + ' → <b>④ 复查</b>再访问一遍热点页，看还在不在。<br>'
                + '同一份负载喂给两种淘汰策略，看结果差多少。',
        }),
        ctl,
        h('p.sec-note', {
            html: '<b>innodb_old_blocks_time</b>：页刚进 old 子链的这段时间内，'
                + '再怎么被访问都不给升进 young。把它拖到 0 试试，会很有意思。',
        }),
        obt
    ));

    // ── 主视图：两条链 ──
    const scrub = h('div.controls');
    const phaseName = { warm: '① 预热', hot: '② 建立热点', scan: '③ 全表扫描', check: '④ 复查热点' };
    const curOp = stopAt > 0 ? ops[stopAt - 1] : null;
    scrub.appendChild(h('label.ctl.ctl-wide', null,
        h('span.ctl-name', { text: '走到第几步' }),
        h('input', {
            type: 'range', min: '0', max: String(ops.length), step: '1', value: String(stopAt),
            oninput: (e) => { state.step = Number(e.target.value); render(); },
        }),
        h('b.ctl-val', {
            text: stopAt + '/' + ops.length + (curOp ? '  ' + phaseName[curOp.phase] : ''),
        })
    ));
    scrub.appendChild(h('div.ctl-btns', null,
        h('button.mini', {
            onclick: () => { state.step = state.cap; render(); },
        }, '预热结束'),
        h('button.mini', {
            onclick: () => { state.step = state.cap + state.hotPages * state.hotRounds; render(); },
        }, '扫描开始前'),
        h('button.mini.primary', {
            onclick: () => { state.step = -1; render(); },
        }, '扫描刚结束'),
        h('button.mini', {
            onclick: () => { state.step = ops.length; render(); },
        }, '连复查也走完')
    ));

    const naiveHot = BPL.hotAlive(now.naive.bp, state.hotPages);
    const midHot = BPL.hotAlive(now.mid.bp, state.hotPages);

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-bars-staggered"></i> 两条 LRU 链，同一份负载' }),
        Viz.legend([
            { cls: 'bpl-lg-hot', text: '热点页（编号 1~' + state.hotPages + '）' },
            { cls: 'bpl-lg-cold', text: '预热时读进来的普通页' },
            { cls: 'bpl-lg-scan', text: '全表扫描读进来的页' },
            { cls: 'bpl-lg-empty', text: '空槽' },
        ]),
        scrub,
        h('div.bpl-panel', null, buildList(now.naive,
            '朴素 LRU（教科书版）',
            '池子里还剩 ' + naiveHot + '/' + state.hotPages + ' 个热点页')),
        h('div.bpl-panel', null, buildList(now.mid,
            '分区 LRU（InnoDB 实际用的）',
            '池子里还剩 ' + midHot + '/' + state.hotPages + ' 个热点页'
            + '　·　升进 young 的次数 ' + now.mid.bp.promotions)),
        h('div.seq-note', {
            html: buildLiveNote(now, naiveHot, midHot, stopAt, ops.length),
        })
    ));

    // ── 打脸：热点页命中率 ──
    const nc = full.naive.phases.check || { rate: 0, hits: 0, n: 0 };
    const mc = full.mid.phases.check || { rate: 0, hits: 0, n: 0 };
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻：扫描过后，热点页还在不在？' }),
        h('p.sec-note', {
            html: '这里统计的是<b>第 ④ 段「复查热点」</b>的命中率 —— 也就是扫描结束以后，'
                + '业务再来读那 ' + state.hotPages + ' 个热点页，有几个还在内存里。',
        }),
        Viz.cmpGrid([
            {
                h: '朴素 LRU', v: Math.round(nc.rate * 100) + '%',
                d: '热点页命中 ' + nc.hits + '/' + nc.n + ' 个', cls: 'cmp-bad',
            },
            {
                h: '分区 LRU（InnoDB）', v: Math.round(mc.rate * 100) + '%',
                d: '热点页命中 ' + mc.hits + '/' + mc.n + ' 个', cls: 'cmp-ok',
            },
            {
                h: '整段负载总命中率', v: Math.round(full.mid.hitRate * 100) + '%',
                d: '朴素是 ' + Math.round(full.naive.hitRate * 100) + '%', cls: 'cmp-save',
            },
        ]),
        h('div.seq-note', { html: buildVerdict(full, nc, mc) })
    ));

    // ── 分阶段明细 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-table-list"></i> 分阶段明细' }),
        buildPhaseTable(full),
        h('p.sec-note', {
            html: '注意<b>扫描阶段</b>两种策略的命中率是差不多的 —— 扫描本来就读的是新页，谁都救不了。'
                + '差别全在<b>复查阶段</b>：分区 LRU 把扫描的破坏关在 old 子链里了。',
        })
    ));

    // ── 脏页 ──
    const dirty = buildDirty();
    const dctl = h('div.controls');
    dctl.appendChild(Viz.slider({
        label: '业务写入速率', min: 5, max: 60, step: 5, value: state.writeRate,
        fmt: (v) => v + ' 页/步', onInput: (v) => { state.writeRate = v; render(); },
    }));
    dctl.appendChild(Viz.slider({
        label: 'max_dirty_pages_pct', min: 20, max: 90, step: 5, value: state.maxDirtyPct,
        fmt: (v) => v + '%', onInput: (v) => { state.maxDirtyPct = v; render(); },
    }));
    dctl.appendChild(Viz.slider({
        label: '后台刷盘能力', min: 3, max: 40, step: 1, value: state.bgFlush,
        fmt: (v) => v + ' 页/步', onInput: (v) => { state.bgFlush = v; render(); },
    }));

    const last = dirty.sim.rows[dirty.sim.rows.length - 1];
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-droplet"></i> 第二件事：脏页顶到红线，MySQL 就会「抖一下」' }),
        h('p.sec-note', {
            html: '缓冲池里被改过、还没写回磁盘的页叫<b>脏页</b>。'
                + 'InnoDB 平时靠后台线程慢慢刷，但脏页比例一旦顶到 '
                + '<code>innodb_max_dirty_pages_pct</code>（默认 75%），'
                + '它就不敢再让脏页涨了 —— <b>用户线程只能等刷盘腾出位置才能继续写</b>。'
                + '业务侧看到的现象就是：明明啥也没变，写入 QPS 突然掉下去、响应时间毛刺。',
        }),
        dctl,
        dirty.svg,
        Viz.cmpGrid([
            {
                h: '想写', v: state.writeRate + ' 页/步',
                d: '业务侧发过来的写入压力', cls: 'cmp-save',
            },
            {
                h: '实际写进去', v: last.throughput + ' 页/步',
                d: last.stalled ? '被刷盘拖住了' : '刷得过来，没卡',
                cls: last.stalled ? 'cmp-bad' : 'cmp-ok',
            },
            {
                h: '吞吐损失', v: Math.round((1 - last.throughput / state.writeRate) * 100) + '%',
                d: dirty.sim.stallFrom >= 0 ? '第 ' + dirty.sim.stallFrom + ' 步开始卡' : '全程没卡',
                cls: last.stalled ? 'cmp-bad' : 'cmp-ok',
            },
        ]),
        h('div.seq-note', {
            html: '把「后台刷盘能力」拖到大于「业务写入速率」，曲线立刻变平、吞吐满血 —— '
                + '这就是调 <code>innodb_io_capacity</code> 的意义：'
                + '<b>它不是让 MySQL 变快，是让它别攒着脏页最后一次性还债。</b><br>'
                + '反过来，把 <code>max_dirty_pages_pct</code> 调大只是把这一下推迟了，'
                + '真崩的时候崩得更狠（而且崩溃恢复要重放的 redo 更多，重启更慢）。',
        })
    ));

    // ── 机制 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list-ol"></i> 一个页在链上的一生' }),
        Viz.flowList([
            {
                t: '① 缺页：从磁盘读进来，插在 midpoint（old 子链的头部）',
                f: 'buf_LRU_add_block(block, /* old = */ TRUE);\n// 不是插链表头！是插在 5/8 的位置',
                r: '它一进来就站在「离淘汰只有 3/8 距离」的地方',
                hi: '这一步是整个设计的核心。教科书 LRU 把新页当成最热的，'
                    + '而 InnoDB 认为「刚读进来的页嫌疑最大」—— 很可能只是某次扫描路过。',
            },
            {
                t: '② 同一个页紧接着又被访问（读同一页上的第 2、3 行）',
                f: 'if (now - block->access_time < innodb_old_blocks_time) {\n    /* 不给升级，原地待着 */\n}',
                r: '默认 1000ms 内的重复访问一律不算数',
                hi: '为什么要这条？因为一个 16KB 的数据页上有几十行，扫描时会连着读。'
                    + '没有这条时间闸门，扫描的每一页都会被「第二次访问」顶进 young，防线形同虚设。'
                    + '（上面把它拖到 0 就能看到这个结果。）',
            },
            {
                t: '③ 熬过了 old_blocks_time，又被访问 → 升进 young 头部',
                f: 'buf_LRU_make_block_young(block);',
                r: '这时才算「真的是热数据」',
            },
            {
                t: '④ 在 young 里被访问：只有落在 young 的后 3/4 才往前挪',
                f: '// 已经在最前面那 1/4 的页，再访问也不动它',
                r: '省掉大量链表指针操作和锁竞争',
                hi: '这是个纯工程优化：热页每次访问都去抢 LRU 链的 mutex，'
                    + '在高并发下这个锁自己就成了瓶颈。<b>本演示为了看得清，简化成「命中就挪到头」。</b>',
            },
            {
                t: '⑤ 一直没人再理它 → 慢慢被挤到链尾 → 淘汰',
                f: '// 脏页要先刷盘才能淘汰；干净页直接扔',
                r: '所以脏页太多时，连「淘汰一个页」都要等 I/O',
            },
        ])
    ));

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: 'InnoDB 为什么不用普通 LRU？',
                a: '因为<b>一次全表扫描就能把整个缓冲池洗一遍</b>。'
                    + '普通 LRU 认为「刚访问的最热」，可扫描读进来的页恰恰是最不该留的。'
                    + 'InnoDB 把链表切成 young(5/8) + old(3/8)，'
                    + '<b>新页插在 midpoint 而不是链头</b>，只有「在 old 里熬够 '
                    + '<code>innodb_old_blocks_time</code> 且被再次访问」才升进 young。'
                    + '效果就是：扫描页在 old 那 3/8 里自生自灭，young 里的热点页一动不动。'
                    + '演示里复查阶段命中率 ' + Math.round(nc.rate * 100) + '% vs '
                    + Math.round(mc.rate * 100) + '%，差距就是这么来的。',
            },
            {
                q: 'innodb_old_blocks_time 是干什么的？调成 0 会怎样？',
                a: '它是一道<b>时间闸门</b>：页刚进 old 的这段时间内，再怎么被访问都不给升级。'
                    + '存在的理由是「一个数据页上有几十行，扫描会连着读同一页」—— '
                    + '如果访问两次就升级，扫描的每一页都会进 young，分区 LRU 就白设计了。'
                    + '把它调成 0，本演示里分区 LRU 的复查命中率会掉到跟朴素 LRU 差不多。',
            },
            {
                q: '缓冲池设多大合适？',
                a: '经验值是<b>物理内存的 50%~75%</b>，但要留够给操作系统、连接线程栈、'
                    + 'sort_buffer/join_buffer 这类每连接内存。'
                    + '判断依据不是内存占比，是 <code>Innodb_buffer_pool_reads</code>（真的去读磁盘的次数）'
                    + '和 <code>Innodb_buffer_pool_read_requests</code> 的比值 —— 命中率上不去才加内存。'
                    + '另外 <code>innodb_buffer_pool_instances</code> 会把池子切成多份，'
                    + '每份一把锁，缓解高并发下的 mutex 争用。',
            },
            {
                q: '为什么写入吞吐会突然掉一截？',
                a: '大概率是<b>脏页顶到了 <code>innodb_max_dirty_pages_pct</code></b>（默认 75%）。'
                    + '这之后 InnoDB 不允许脏页继续涨，用户线程要自己参与刷盘或者干等，'
                    + '吞吐被压到刷盘能力那条线上。'
                    + '排查看 <code>Innodb_buffer_pool_pages_dirty</code> 的曲线；'
                    + '解法通常是把 <code>innodb_io_capacity</code> 调到跟实际硬盘匹配'
                    + '（SSD 别再用默认的 200），让它平时就刷起来，而不是攒到红线一次性还债。',
            },
            {
                q: '预读（read ahead）和这套 LRU 有什么关系？',
                a: '预读会把「猜测将来要用的页」提前读进来。这些页可能压根用不上，'
                    + '所以它们也是插在 <b>old 子链</b>的 —— 猜错了就在 old 里被淘汰，不污染 young。'
                    + '<code>Innodb_buffer_pool_read_ahead_evicted</code> 这个状态变量数的就是'
                    + '「预读进来但一次没被用就被淘汰」的页数，它高说明预读在做无用功。',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['分区 LRU 不是万能的，它只挡「一次性扫描」',
             '如果你的业务本身就是随机访问一个远大于内存的数据集，'
             + '那么 young 里的页也一样留不住，分区 LRU 帮不上忙。'
             + '它解决的是<b>「偶尔一条大 SQL 把热数据冲掉」</b>这个具体问题，不是万能的。'],
            ['重启后缓冲池是冷的，性能会「慢慢恢复」',
             '刚重启的 MySQL 缓冲池空空如也，所有查询都要读磁盘，QPS 可能只有平时的几分之一。'
             + 'MySQL 5.6+ 提供 <code>innodb_buffer_pool_dump_at_shutdown</code> / '
             + '<code>load_at_startup</code>，关机时把热页的页号存下来、启动时重新读回。'
             + '<b>注意存的是页号不是数据</b>，所以启动后还有一段 I/O 密集期。'],
            ['调大 buffer pool 是在线操作，但会短暂卡住',
             'MySQL 5.7+ 支持在线改 <code>innodb_buffer_pool_size</code>，'
             + '但内部是按 chunk（默认 128MB）重新组织的，过程中会持有全局锁。'
             + '生产环境改之前先看清 <code>innodb_buffer_pool_chunk_size</code>，'
             + '而且新值会被<b>向上取整</b>到 chunk × instances 的倍数 —— 你设 9G 可能变成 10G。'],
            ['脏页比例低不代表没风险',
             '脏页比例只是水位，真正决定崩溃恢复时长的是 <b>checkpoint age</b>'
             + '（当前 LSN 和已刷盘 LSN 的差）。'
             + 'redo log 太小时，即使脏页比例不高，也会因为 redo 快写满而触发'
             + '<b>同步刷盘（sharp checkpoint）</b>，那一下比脏页超限还狠 —— 几乎全库卡住。'],
            ['本演示的「命中率」和 MySQL 状态变量口径不一样',
             '这里的命中率按「访问次数」算。MySQL 的 <code>Innodb_buffer_pool_read_requests</code> '
             + '统计的是逻辑读请求，包含了一次查询里对同一页的多次访问，'
             + '所以线上算出来的命中率通常比这里高得多（99% 以上很常见），'
             + '<b>不能拿 95% 这种数字直接横向比</b>。'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '简化的地方，一个个说：<br>'
                + '① 真实 InnoDB 的缓冲池是几万到几百万页（16KB/页），这里只画 ' + state.cap
                + ' 个格子，比例（5/8 : 3/8）是真的，规模不是。<br>'
                + '② InnoDB 在 LRU 链长度不足 512 页时压根不启用 midpoint 插入（<code>BUF_LRU_OLD_MIN_LEN</code>），'
                + '本演示为了在小规模下也能看出效果，从第一页起就按 midpoint 插。<br>'
                + '③ young 子链内部的「只有落在后 3/4 才前移」这个优化没有实现，这里命中就挪到头 —— '
                + '它影响的是锁竞争，不影响本演示要讲的结论。<br>'
                + '④ 没有模拟 free list、flush list（脏页链）、页哈希表、预读、'
                + '也没有模拟多个 buffer pool instance。脏页那一段是独立的简化模型，'
                + '和上面 LRU 那一段不共享状态。',
        }),
        h('p', {
            html: '时间单位是抽象的「步」，一次页访问算 1ms。'
                + '所有序列都是写死的（没有随机数），你怎么拖滑块、刷新多少次，'
                + '同样的参数一定得到同样的结果 —— 这样两种策略才能严格对照。',
        })
    ));
}

function buildLiveNote(now, naiveHot, midHot, stopAt, total) {
    if (stopAt >= total && total > 0) {
        return '你走完了<b>第 ④ 段复查</b>。注意看：朴素 LRU 那条链现在也有热点页了 —— '
            + '因为复查时它们<b>刚从磁盘重新读进来</b>，代价是 ' + state.hotPages
            + ' 次实打实的磁盘 I/O。<br>'
            + '想看扫描造成的破坏，点上面的「扫描刚结束」回到复查之前那一刻。';
    }
    if (midHot > naiveHot) {
        return '看链尾：<b>朴素 LRU</b> 那条链已经被橙色的扫描页整个洗了一遍，热点页（紫色）被挤没了；'
            + '<b>分区 LRU</b> 那条链里，橙色的扫描页全都堆在右边的 old 区域，'
            + '左边 young 区的热点页一个没动 —— 它们压根没被扫描碰到。'
            + '现在朴素池里剩 <b>' + naiveHot + '</b> 个热点页，分区池里剩 <b>' + midHot + '</b> 个。';
    }
    if (midHot === naiveHot && midHot === 0) {
        return '两边都被洗光了。'
            + (state.oldBlocksTime === 0
                ? '<b>因为 innodb_old_blocks_time 被调成了 0</b> —— '
                  + '扫描每页读 ' + state.rowsPerPage + ' 行，第二次访问就把这个页顶进了 young，'
                  + '分区 LRU 的防线自己塌了。把它调回 1000ms 再看。'
                : '试试把「扫描页数」调小一点，或者把缓冲池调大。');
    }
    return '把滑块拖到「跑完整段」，再对比两条链的样子。'
        + '现在朴素池里剩 <b>' + naiveHot + '</b> 个热点页，分区池里剩 <b>' + midHot + '</b> 个。';
}

function buildVerdict(full, nc, mc) {
    if (mc.rate > nc.rate + 0.2) {
        return '<b>这就是打脸的地方</b>：同一条 SQL、同一个缓冲池大小，'
            + '朴素 LRU 下热点数据被冲得干干净净（' + Math.round(nc.rate * 100) + '%），'
            + '分区 LRU 下<b>纹丝不动</b>（' + Math.round(mc.rate * 100) + '%）。<br>'
            + '业务侧的体感差别是：前者在那条大 SQL 跑完之后，'
            + '接下来几分钟所有正常查询都要重新读磁盘，QPS 塌一截；后者根本没感觉。<br>'
            + '现在点上面那个「② 把 old_blocks_time 调成 0」，看这个优势怎么瞬间消失。';
    }
    if (state.oldBlocksTime === 0) {
        return '<b>优势消失了。</b>把 <code>innodb_old_blocks_time</code> 调成 0 以后，'
            + '扫描时每页读的第 2 行就把这个页顶进了 young（因为「不是新页 + 又被访问了」），'
            + '于是扫描页照样往 young 里灌，分区 LRU 退化成了朴素 LRU。<br>'
            + '<b>结论：midpoint 插入和时间闸门是一套组合拳，缺一个就不成立。</b>'
            + '这也是为什么 MySQL 5.5 之后把 old_blocks_time 的默认值从 0 改成了 1000。';
    }
    return '当前参数下两者差别不大。把「扫描页数」调大到超过缓冲池容量，'
        + '或者把 <code>innodb_old_blocks_time</code> 调回 1000ms，差距就出来了。';
}

function buildPhaseTable(full) {
    const order = [
        ['warm', '① 预热（填满池子）'],
        ['hot', '② 建立热点'],
        ['scan', '③ 全表扫描'],
        ['check', '④ 复查热点'],
    ];
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    const thead = h('tr', null,
        h('th', { text: '阶段' }),
        h('th', { text: '访问次数' }),
        h('th', { text: '朴素 LRU 命中率' }),
        h('th', { text: '分区 LRU 命中率' }),
        h('th', { text: '差距' })
    );
    tbl.appendChild(thead);
    order.forEach(([k, name]) => {
        const a = full.naive.phases[k] || { n: 0, rate: 0, hits: 0 };
        const b = full.mid.phases[k] || { n: 0, rate: 0, hits: 0 };
        const diff = Math.round((b.rate - a.rate) * 100);
        tbl.appendChild(h('tr' + (k === 'check' ? '.on' : ''), null,
            h('td', { html: k === 'check' ? '<b>' + Viz.esc(name) + '</b>' : Viz.esc(name) }),
            h('td', { text: String(a.n) }),
            h('td' + (a.rate < b.rate ? '.bad' : ''), { text: Math.round(a.rate * 100) + '%  (' + a.hits + ')' }),
            h('td' + (b.rate > a.rate ? '.ok' : ''), { text: Math.round(b.rate * 100) + '%  (' + b.hits + ')' }),
            h('td', { text: (diff > 0 ? '+' : '') + diff + ' 个百分点' })
        ));
    });
    wrap.appendChild(tbl);
    return wrap;
}

Viz.register({
    id: 'buffer-pool',
    cat: 'db',
    title: 'Buffer Pool',
    subtitle: '分区 LRU · 脏页 · 预读',
    icon: 'fa-server',
    blurb: 'MySQL 用的不是教科书 LRU —— 一次全表扫描就能看出为什么',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.cap = 32; state.hotPages = 8; state.hotRounds = 3;
        state.scanPages = 60; state.rowsPerPage = 4;
        state.oldBlocksTime = 1000; state.step = -1;
        state.writeRate = 30; state.maxDirtyPct = 75; state.bgFlush = 12;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
