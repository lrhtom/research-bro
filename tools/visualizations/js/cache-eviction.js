// ============================================================
//  演示：缓存淘汰策略
//  FIFO / LRU / LFU / Redis 近似 LRU / LRU-2 喂同一段序列，看谁留下了对的东西。
//  三个打脸：① Redis 用的根本不是真 LRU，是「随机采 N 个挑最老的」；
//  ② LRU 有悬崖效应，容量差 1 个，命中率从 0% 跳到 100%；
//  ③ LFU 会被老热点赖着不走（缓存污染），Redis 靠对数计数器 + 时间衰减解决。
//  上半 CE.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const CE = {};

/** 线性同余伪随机。固定种子 → 每次刷新结果完全一样，两种策略才能严格对照 */
CE.rng = function (seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        return s / 4294967296;
    };
};

/** 从 n 个下标里不重复地抽 k 个（部分洗牌，不用 Math.random）*/
CE.sampleIdx = function (n, k, rnd) {
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    const m = Math.min(k, n);
    for (let i = 0; i < m; i++) {
        const j = i + Math.floor(rnd() * (n - i));
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    return idx.slice(0, m);
};

CE.POLICIES = [
    { id: 'fifo', name: 'FIFO', desc: '谁先进谁先走，完全不看用得多不多' },
    { id: 'lru', name: 'LRU（真的）', desc: '扔掉最久没被访问的那个' },
    { id: 'lfu', name: 'LFU', desc: '扔掉访问次数最少的那个' },
    { id: 'sampled', name: 'Redis 近似 LRU', desc: '随机采 N 个，从里面挑最老的扔' },
    { id: 'lru2', name: 'LRU-2', desc: '看「倒数第二次访问」的时间，抗扫描' },
];

/**
 * 建一个缓存。
 * opt = { sample: 采样个数（只对 sampled 有意义）, seed }
 */
CE.create = function (cap, policy, opt) {
    opt = opt || {};
    return {
        cap: Math.max(1, cap | 0), policy,
        sample: opt.sample == null ? 5 : opt.sample,
        rnd: CE.rng(opt.seed == null ? 20260801 : opt.seed),
        entries: [],      // { key, insertAt, lastUsed, prevUsed, freq }
        clock: 0, hits: 0, misses: 0,
    };
};

/** 在给定的候选下标 pool 里，按 policy 挑出最该被扔的那个 */
CE.bestIdx = function (entries, pool, policy) {
    let best = pool[0];
    for (let n = 1; n < pool.length; n++) {
        const i = pool[n];
        if (CE.worseThan(policy, entries[i], entries[best])) best = i;
    }
    return best;
};

/**
 * 挑一个倒霉蛋。返回 { idx, key, pool, ideal }
 *   pool  = 被纳入比较的候选（采样 LRU 只有 N 个，其它策略是全部）
 *   ideal = 同一时刻「真 LRU」会扔谁
 *
 * ideal 这个字段是专门给打脸①用的：直接拿两个独立跑的缓存去比是不公平的
 * （它们的内容早就漂移开了，比出来的差异混着「漂移」和「采样偏差」两件事）。
 * 在同一个缓存状态里问「采样有没有摸中真正最老的那个」，才是干净的口径。
 */
CE.pickVictim = function (c) {
    const es = c.entries;
    if (!es.length) return null;
    const all = [];
    for (let i = 0; i < es.length; i++) all.push(i);
    const pool = c.policy === 'sampled' ? CE.sampleIdx(es.length, c.sample, c.rnd) : all;
    const best = CE.bestIdx(es, pool, c.policy);
    const ideal = CE.bestIdx(es, all, 'lru');
    return { idx: best, key: es[best].key, pool, ideal: es[ideal].key };
};

/** a 比 b 更该被扔掉吗 */
CE.worseThan = function (policy, a, b) {
    switch (policy) {
        case 'fifo':
            return a.insertAt < b.insertAt;
        case 'lfu':
            if (a.freq !== b.freq) return a.freq < b.freq;
            return a.lastUsed < b.lastUsed;      // 次数一样时退回 LRU
        case 'lru2': {
            // 只有一次访问记录的，视为「无穷旧」，优先扔 —— 这就是 LRU-2 抗扫描的地方
            const pa = a.prevUsed == null ? -1 : a.prevUsed;
            const pb = b.prevUsed == null ? -1 : b.prevUsed;
            if (pa !== pb) return pa < pb;
            return a.lastUsed < b.lastUsed;
        }
        default:                                  // lru / sampled 都是比 lastUsed
            return a.lastUsed < b.lastUsed;
    }
};

/** 访问一个 key。返回 { hit, evicted, pool, ideal } */
CE.access = function (c, key) {
    c.clock++;
    let idx = -1;
    for (let i = 0; i < c.entries.length; i++) if (c.entries[i].key === key) { idx = i; break; }

    if (idx >= 0) {
        c.hits++;
        const e = c.entries[idx];
        e.prevUsed = e.lastUsed;
        e.lastUsed = c.clock;
        e.freq++;
        return { hit: true, evicted: null, pool: null, ideal: null };
    }

    c.misses++;
    let evicted = null, pool = null, ideal = null;
    if (c.entries.length >= c.cap) {
        const v = CE.pickVictim(c);
        evicted = v.key; ideal = v.ideal;
        pool = v.pool.map((i) => c.entries[i].key);
        c.entries.splice(v.idx, 1);
    }
    c.entries.push({ key, insertAt: c.clock, lastUsed: c.clock, prevUsed: null, freq: 1 });
    return { hit: false, evicted, pool, ideal };
};

/** 跑一整段序列 */
CE.run = function (cap, policy, seq, opt) {
    const c = CE.create(cap, policy, opt);
    const steps = [];
    seq.forEach((k, i) => {
        const r = CE.access(c, k);
        steps.push({ i, key: k, hit: r.hit, evicted: r.evicted, pool: r.pool, ideal: r.ideal });
    });
    const n = c.hits + c.misses;
    return {
        cache: c, steps, hits: c.hits, misses: c.misses,
        hitRate: n ? c.hits / n : 0,
        keys: c.entries.map((e) => e.key),
    };
};

/** 只统计序列后半段的命中率（跳过冷启动，看稳态）*/
CE.steadyRate = function (res, from) {
    let hit = 0, n = 0;
    res.steps.forEach((s) => { if (s.i >= from) { n++; if (s.hit) hit++; } });
    return n ? hit / n : 0;
};

/**
 * 打脸①：真 LRU 和 Redis 采样 LRU 的淘汰决策差在哪。
 *
 * 口径说明（很重要）：agreeRate 统计的是「在采样缓存<b>自己</b>那一刻的状态下，
 * 随机摸出来的 N 个里，有没有包含真正最老的那个」。
 * 不能拿两个独立跑的缓存直接对比 —— 它们的内容早就漂移开了，
 * 比出来的差异混着「历史漂移」和「本次采样偏差」两件事，说明不了任何问题。
 *
 * 理论值：缓存满时有 cap 个候选，随机摸 N 个，最老的那个被摸到的概率就是 N/cap。
 */
CE.compareLRU = function (cap, seq, sample, seed) {
    const t = CE.run(cap, 'lru', seq);
    const s = CE.run(cap, 'sampled', seq, { sample, seed });
    const rows = [];
    let same = 0, total = 0;
    s.steps.forEach((b) => {
        if (b.evicted == null) return;
        total++;
        const agree = b.evicted === b.ideal;
        if (agree) same++;
        rows.push({
            i: b.i, key: b.key, ideal: b.ideal, sampEvict: b.evicted,
            pool: b.pool || [], agree,
        });
    });
    return {
        rows, same, total,
        agreeRate: total ? same / total : 1,
        expected: Math.min(1, sample / cap),
        trueRate: t.hitRate, sampRate: s.hitRate,
    };
};

/**
 * 打脸②：LRU 的悬崖效应。
 * 循环访问 1..loopLen，共 rounds 轮，测容量从 1 到 maxCap 的命中率。
 */
CE.cliff = function (loopLen, rounds, maxCap, policy) {
    const seq = [];
    for (let r = 0; r < rounds; r++) for (let i = 1; i <= loopLen; i++) seq.push('K' + i);
    const out = [];
    for (let cap = 1; cap <= maxCap; cap++) {
        const res = CE.run(cap, policy || 'lru', seq, { sample: 5 });
        out.push({
            cap,
            hitRate: res.hitRate,
            steadyRate: CE.steadyRate(res, loopLen),   // 跳过第一轮的必然缺页
        });
    }
    return { seq, rows: out, loopLen, rounds };
};

/**
 * 打脸③：LFU 缓存污染。
 * 前一段热点 a1..aHot 被刷了 hotRounds 轮（计数攒得很高），
 * 后一段业务换成 b1..bNew，看两种策略在「后一段」的命中率。
 */
CE.pollution = function (cap, hotKeys, hotRounds, newKeys, newRounds) {
    const seq = [];
    for (let r = 0; r < hotRounds; r++) for (let i = 1; i <= hotKeys; i++) seq.push('老' + i);
    const splitAt = seq.length;
    for (let r = 0; r < newRounds; r++) for (let i = 1; i <= newKeys; i++) seq.push('新' + i);
    const out = {};
    ['lru', 'lfu', 'fifo', 'sampled'].forEach((p) => {
        const res = CE.run(cap, p, seq, { sample: 5 });
        out[p] = {
            all: res.hitRate,
            phase2: CE.steadyRate(res, splitAt),
            keys: res.keys,
        };
    });
    return { seq, splitAt, out, cap };
};

// ---------- Redis 的 LFU：对数计数器 + 时间衰减 ----------

CE.LFU_INIT_VAL = 5;

/**
 * Redis 的 LFU 计数增长（Morris counter，8 位存不下真实次数，就存个对数）。
 * 命中时不是「+1」，而是「以 1/(baseval*factor+1) 的概率才 +1」。
 * baseval = counter - LFU_INIT_VAL，所以计数越高越难再涨。
 */
CE.lfuIncr = function (counter, logFactor, r) {
    if (counter >= 255) return 255;
    const baseval = Math.max(0, counter - CE.LFU_INIT_VAL);
    const p = 1 / (baseval * logFactor + 1);
    return r < p ? counter + 1 : counter;
};

/** 时间衰减：每过 decayMin 分钟，计数器减 1（老热点会自己凉下去）*/
CE.lfuDecay = function (counter, elapsedMin, decayMin) {
    if (decayMin <= 0) return counter;
    return Math.max(0, counter - Math.floor(elapsedMin / decayMin));
};

/** 访问 n 次以后计数器长到多少（固定种子模拟）*/
CE.lfuCurve = function (logFactor, maxHits, seed) {
    const r = CE.rng(seed == null ? 7 : seed);
    let c = CE.LFU_INIT_VAL;
    const pts = [{ hits: 0, counter: c }];
    for (let i = 1; i <= maxHits; i++) {
        c = CE.lfuIncr(c, logFactor, r());
        if (i % Math.max(1, Math.floor(maxHits / 120)) === 0 || i === maxHits) {
            pts.push({ hits: i, counter: c });
        }
    }
    return pts;
};

/** 近似 Zipf 分布的访问序列（固定种子）*/
CE.seqZipf = function (len, nKeys, skew, seed) {
    const r = CE.rng(seed == null ? 424242 : seed);
    const cdf = [];
    let tot = 0;
    for (let i = 1; i <= nKeys; i++) tot += 1 / Math.pow(i, skew);
    let acc = 0;
    for (let i = 1; i <= nKeys; i++) { acc += (1 / Math.pow(i, skew)) / tot; cdf.push(acc); }
    const out = [];
    for (let i = 0; i < len; i++) {
        const u = r();
        let k = 0;
        while (k < nKeys - 1 && u > cdf[k]) k++;
        out.push('K' + (k + 1));
    }
    return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = CE;
if (typeof window !== 'undefined') window.CEModel = CE;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const state = {
    cap: 8,
    sample: 5,
    seqLen: 240,
    nKeys: 24,
    skew: 0.9,
    loopLen: 4,
    loopCap: 3,
    polCap: 4,
    logFactor: 10,
};

let rootEl = null;

function mainSeq() {
    return CE.seqZipf(state.seqLen, state.nKeys, state.skew, 424242);
}

// ---------- 命中率柱状图 ----------

function rateBars(items) {
    const W = 700, rowH = 34, PAD_L = 132, PAD_R = 76, PAD_T = 8;
    const H = PAD_T + items.length * rowH + 8;
    const iw = W - PAD_L - PAD_R;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'ce-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '各策略命中率',
    });
    const best = Math.max.apply(null, items.map((it) => it.v));
    items.forEach((it, i) => {
        const y = PAD_T + i * rowH;
        const lb = svg('text', { x: PAD_L - 8, y: y + 19, class: 'ce-bar-l', 'text-anchor': 'end' });
        lb.textContent = it.name;
        root.appendChild(lb);
        root.appendChild(svg('rect', { x: PAD_L, y: y + 4, width: iw, height: 22, rx: 5, fill: '#f1f3f6' }));
        root.appendChild(svg('rect', {
            x: PAD_L, y: y + 4, width: Math.max(2, iw * it.v), height: 22, rx: 5,
            class: 'ce-bar' + (it.v >= best - 1e-9 ? ' ce-bar-best' : '') + (it.cls ? ' ' + it.cls : ''),
        }));
        const vl = svg('text', { x: PAD_L + iw + 6, y: y + 19, class: 'ce-bar-v' });
        vl.textContent = (it.v * 100).toFixed(1) + '%';
        root.appendChild(vl);
        if (it.sub) {
            const sl = svg('text', { x: PAD_L + 7, y: y + 19, class: 'ce-bar-sub' });
            sl.textContent = it.sub;
            root.appendChild(sl);
        }
    });
    return root;
}

// ---------- 缓存内容条 ----------

function cacheStrip(keys, cap, hi) {
    const box = h('div.ce-strip');
    for (let i = 0; i < cap; i++) {
        const k = keys[i];
        box.appendChild(h('span.ce-slot' + (k == null ? '.empty' : '') + (hi && hi.indexOf(k) >= 0 ? '.hi' : ''),
            { text: k == null ? '·' : k }));
    }
    return box;
}

// ---------- 悬崖效应图 ----------

function cliffChart() {
    const maxCap = Math.max(8, state.loopLen + 3);
    const lru = CE.cliff(state.loopLen, 12, maxCap, 'lru');
    const fifo = CE.cliff(state.loopLen, 12, maxCap, 'fifo');
    const W = 700, H = 220, PAD_L = 46, PAD_R = 20, PAD_T = 16, PAD_B = 42;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
    const bw = iw / maxCap;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'ce-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '容量与命中率',
    });
    [0, 25, 50, 75, 100].forEach((p) => {
        const y = PAD_T + ih - (p / 100) * ih;
        root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L + iw, y1: y, y2: y, class: 'ce-grid' }));
        const lb = svg('text', { x: PAD_L - 6, y: y + 3.5, class: 'ce-ax', 'text-anchor': 'end' });
        lb.textContent = p + '%';
        root.appendChild(lb);
    });
    lru.rows.forEach((r, i) => {
        const x = PAD_L + i * bw;
        const cliffHere = r.cap === state.loopLen;
        const hh = r.steadyRate * ih;
        root.appendChild(svg('rect', {
            x: x + bw * 0.16, y: PAD_T + ih - hh, width: bw * 0.34, height: Math.max(1, hh),
            rx: 3, class: 'ce-cbar' + (cliffHere ? ' ce-cbar-jump' : ''),
        }));
        const f = fifo.rows[i];
        const hf = f.steadyRate * ih;
        root.appendChild(svg('rect', {
            x: x + bw * 0.52, y: PAD_T + ih - hf, width: bw * 0.34, height: Math.max(1, hf),
            rx: 3, class: 'ce-cbar2',
        }));
        const lb = svg('text', { x: x + bw / 2, y: PAD_T + ih + 15, class: 'ce-ax', 'text-anchor': 'middle' });
        lb.textContent = String(r.cap);
        root.appendChild(lb);
        if (r.steadyRate > 0.02) {
            const vl = svg('text', {
                x: x + bw * 0.33, y: PAD_T + ih - hh - 4, class: 'ce-cval', 'text-anchor': 'middle',
            });
            vl.textContent = Math.round(r.steadyRate * 100) + '%';
            root.appendChild(vl);
        }
    });
    // 悬崖标注
    const cx = PAD_L + (state.loopLen - 1) * bw + bw / 2;
    root.appendChild(svg('line', {
        x1: cx - bw / 2, x2: cx - bw / 2, y1: PAD_T, y2: PAD_T + ih, class: 'ce-cliff-line',
    }));
    const cl = svg('text', { x: cx - bw / 2 - 5, y: PAD_T + 12, class: 'ce-cliff-l', 'text-anchor': 'end' });
    cl.textContent = '← 容量 ' + (state.loopLen - 1) + '：命中率 0%';
    root.appendChild(cl);
    const cr = svg('text', { x: cx - bw / 2 + 5, y: PAD_T + 12, class: 'ce-cliff-l' });
    cr.textContent = '容量 ' + state.loopLen + '：直接满血 →';
    root.appendChild(cr);

    const xl = svg('text', { x: PAD_L + iw / 2, y: H - 8, class: 'ce-ax', 'text-anchor': 'middle' });
    xl.textContent = '缓存容量（能装几个 key）　　■ 紫色 = LRU　■ 灰色 = FIFO';
    root.appendChild(xl);
    return { svg: root, lru, fifo, maxCap };
}

// ---------- Redis LFU 对数计数器曲线 ----------

function lfuChart() {
    const factors = [0, 1, 10, 100];
    const maxHits = 1000;
    const W = 700, H = 210, PAD_L = 40, PAD_R = 96, PAD_T = 14, PAD_B = 34;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'ce-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'LFU 对数计数器',
    });
    const X = (n) => PAD_L + (n / maxHits) * iw;
    const Y = (c) => PAD_T + ih - (Math.min(c, 120) / 120) * ih;
    [0, 30, 60, 90, 120].forEach((c) => {
        const y = Y(c);
        root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L + iw, y1: y, y2: y, class: 'ce-grid' }));
        const lb = svg('text', { x: PAD_L - 6, y: y + 3.5, class: 'ce-ax', 'text-anchor': 'end' });
        lb.textContent = String(c);
        root.appendChild(lb);
    });
    factors.forEach((f, i) => {
        const pts = CE.lfuCurve(f, maxHits, 7 + i);
        let d = '';
        pts.forEach((p, k) => { d += (k ? 'L' : 'M') + X(p.hits).toFixed(1) + ' ' + Y(p.counter).toFixed(1); });
        root.appendChild(svg('path', { d, fill: 'none', class: 'ce-lfu ce-lfu-' + i }));
        const last = pts[pts.length - 1];
        const lb = svg('text', { x: PAD_L + iw + 5, y: Math.min(Y(last.counter) + 4, PAD_T + ih), class: 'ce-lfu-l ce-lfu-t' + i });
        lb.textContent = 'factor ' + f + ' → ' + last.counter;
        root.appendChild(lb);
    });
    const xl = svg('text', { x: PAD_L + iw / 2, y: H - 6, class: 'ce-ax', 'text-anchor': 'middle' });
    xl.textContent = '被访问次数（0 → 1000）　　纵轴 = 8 位计数器的值';
    root.appendChild(xl);
    return root;
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const seq = mainSeq();
    const runs = {};
    CE.POLICIES.forEach((p) => {
        runs[p.id] = CE.run(state.cap, p.id, seq, { sample: state.sample, seed: 20260801 });
    });

    // ── 场景 + 控制 ──
    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '缓存容量', min: 3, max: 20, step: 1, value: state.cap,
        fmt: (v) => v + ' 个', onInput: (v) => { state.cap = v; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: 'key 总数', min: 8, max: 60, step: 2, value: state.nKeys,
        fmt: (v) => v + ' 个', onInput: (v) => { state.nKeys = v; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '热点集中度', min: 0, max: 20, step: 1, value: Math.round(state.skew * 10),
        fmt: (v) => (v / 10).toFixed(1), onInput: (v) => { state.skew = v / 10; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '访问次数', min: 60, max: 600, step: 20, value: state.seqLen,
        fmt: (v) => v + ' 次', onInput: (v) => { state.seqLen = v; render(); },
    }));

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-broom"></i> 场景：缓存满了，下一个该扔谁？' }),
        h('p.sec-note', {
            html: '访问序列按 <b>Zipf 分布</b>生成（少数 key 特别热，长尾很长 —— 真实缓存负载就长这样），'
                + '固定种子，五种策略喂的是<b>一模一样</b>的序列。'
                + '「热点集中度」是 Zipf 的指数：0 就是均匀随机（缓存基本没用），'
                + '越大越集中（缓存越吃香）。',
        }),
        ctl
    ));

    // ── 命中率并排 ──
    const bars = CE.POLICIES.map((p) => ({
        name: p.name, v: runs[p.id].hitRate,
        sub: p.id === 'sampled' ? '采样 ' + state.sample + ' 个' : '',
        cls: p.id === 'sampled' ? 'ce-bar-redis' : '',
    }));
    const stripBox = h('div.ce-strips');
    CE.POLICIES.forEach((p) => {
        stripBox.appendChild(h('div.ce-strip-row', null,
            h('span.ce-strip-name', { text: p.name }),
            cacheStrip(runs[p.id].keys, state.cap)
        ));
    });

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-ranking-star"></i> 同一段序列，五种策略的命中率' }),
        rateBars(bars),
        h('p.sec-note', {
            html: '跑完之后每个缓存里剩下的 key（左边是先进来的）：',
        }),
        stripBox,
        h('div.seq-note', {
            html: '<b>FIFO 通常垫底</b>，因为它根本不看「用得多不多」，一个被反复访问的热 key '
                + '照样会因为「进来得早」被扔掉。<br>'
                + '<b>LFU 在稳定负载下往往最好</b>（它记的是长期热度），但换了业务它就翻车 —— 下面会演示。<br>'
                + '<b>Redis 的采样 LRU 几乎贴着真 LRU</b>，代价却小得多。这是这一页最值得看的东西。',
        })
    ));

    // ── 打脸①：Redis 不是真 LRU ──
    const cmp = CE.compareLRU(state.cap, seq, state.sample, 20260801);
    const sctl = h('div.controls');
    sctl.appendChild(Viz.slider({
        label: 'maxmemory-samples', min: 1, max: 20, step: 1, value: state.sample,
        fmt: (v) => v + ' 个', onInput: (v) => { state.sample = v; render(); },
    }));
    sctl.appendChild(h('div.ctl-btns', null,
        h('button.mini.danger', { onclick: () => { state.sample = 1; render(); } }, '采样 1（=纯随机）'),
        h('button.mini.primary', { onclick: () => { state.sample = 5; render(); } }, '采样 5（Redis 默认）'),
        h('button.mini', { onclick: () => { state.sample = 10; render(); } }, '采样 10'),
        h('button.mini', { onclick: () => { state.sample = 20; render(); } }, '采样 20')
    ));

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻一：Redis 用的根本不是真 LRU' }),
        h('p.sec-note', {
            html: '真 LRU 要维护一条全局链表，每次访问都得把节点摘下来重新挂到头部 —— '
                + '在几千万 key、几十万 QPS 的场景下，这条链本身就是瓶颈（还有内存开销：每个 key 多两个指针）。'
                + '<b>Redis 的做法是：淘汰时随机摸 N 个 key 出来，从这 N 个里挑最老的扔。</b>'
                + '配置项就叫 <code>maxmemory-samples</code>，默认 5。',
        }),
        sctl,
        Viz.cmpGrid([
            {
                h: '摸中「真正最老」的比例', v: Math.round(cmp.agreeRate * 100) + '%',
                d: cmp.same + '/' + cmp.total + ' 次　理论值 N/容量 = '
                    + Math.round(cmp.expected * 100) + '%',
                cls: cmp.agreeRate > 0.55 ? 'cmp-ok' : 'cmp-bad',
            },
            {
                h: '真 LRU 命中率', v: (cmp.trueRate * 100).toFixed(1) + '%',
                d: '维护全局链表的代价换来的', cls: 'cmp-save',
            },
            {
                h: '采样 ' + state.sample + ' 的命中率', v: (cmp.sampRate * 100).toFixed(1) + '%',
                d: '差 ' + ((cmp.trueRate - cmp.sampRate) * 100).toFixed(1) + ' 个百分点',
                cls: Math.abs(cmp.trueRate - cmp.sampRate) < 0.03 ? 'cmp-ok' : 'cmp-bad',
            },
        ]),
        h('p.sec-note', {
            html: '逐次淘汰对照。<b>红底 = 这一次摸偏了</b>：随机摸出来的那 N 个里没有真正最老的那个，'
                + '于是扔掉了一个「次老」的。<br>'
                + '注意这里是拿<b>同一个缓存</b>在同一时刻的状态去比的 —— '
                + '如果拿两个独立跑的缓存对比，差异里会混进「历史漂移」，那个数字没有意义。',
        }),
        evictTable(cmp),
        h('div.seq-note', { html: sampleVerdict(cmp) })
    ));

    // ── 打脸②：悬崖效应 ──
    const cliff = cliffChart();
    const cctl = h('div.controls');
    cctl.appendChild(Viz.slider({
        label: '循环访问几个 key', min: 3, max: 8, step: 1, value: state.loopLen,
        fmt: (v) => v + ' 个', onInput: (v) => { state.loopLen = v; render(); },
    }));
    cctl.appendChild(h('div.ctl-btns', null,
        h('button.mini.danger', { onclick: () => { state.loopLen = 4; render(); } }, '循环 4 个 key')
    ));
    const rowAt = (c) => cliff.lru.rows[c - 1] || { steadyRate: 0 };
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻二：LRU 的悬崖效应，差一个格子就是天壤之别' }),
        h('p.sec-note', {
            html: '访问模式是最简单的循环：<code>' + Array.from({ length: state.loopLen }, (_, i) => 'K' + (i + 1)).join(' → ')
                + ' → K1 → K2 → …</code>，一直转。'
                + '横轴是缓存容量，纵轴是<b>稳态命中率</b>（跳过了第一轮必然缺页的冷启动）。',
        }),
        cctl,
        cliff.svg,
        Viz.cmpGrid([
            {
                h: '容量 ' + (state.loopLen - 1), v: Math.round(rowAt(state.loopLen - 1).steadyRate * 100) + '%',
                d: '每次要用的那个刚好被扔掉', cls: 'cmp-bad',
            },
            {
                h: '容量 ' + state.loopLen, v: Math.round(rowAt(state.loopLen).steadyRate * 100) + '%',
                d: '刚好装得下，全命中', cls: 'cmp-ok',
            },
            {
                h: '多加 1 个格子', v: '+' + Math.round((rowAt(state.loopLen).steadyRate - rowAt(state.loopLen - 1).steadyRate) * 100) + ' 分',
                d: '内存只多了一点点', cls: 'cmp-save',
            },
        ]),
        h('div.seq-note', {
            html: '<b>容量比工作集小 1 个，LRU 的命中率就是 0%</b> —— 不是「低」，是精确的 0。'
                + '因为每一次你要用的那个，恰恰是上一轮刚被扔掉的那个，'
                + 'LRU 每一步都做出了「最坏的选择」。<br>'
                + '这也解释了一个常见的运维现象：<b>缓存命中率不是随内存线性上升的</b>，'
                + '它可能长期趴在地上，然后在某个容量点突然跳起来。'
                + '所以「加一点点内存试试」经常没效果，而「一次性加够」立刻见效。<br>'
                + '顺带看灰色的 FIFO 柱子：它在有些容量点比 LRU 还高一点 —— '
                + 'FIFO 存在 <b>Bélády 异常</b>（容量变大反而命中率变低），LRU 没有这个毛病。',
        })
    ));

    // ── 打脸③：LFU 污染 ──
    const pol = CE.pollution(state.polCap, 3, 20, 3, 10);
    const pctl = h('div.controls');
    pctl.appendChild(Viz.slider({
        label: '缓存容量', min: 3, max: 8, step: 1, value: state.polCap,
        fmt: (v) => v + ' 个', onInput: (v) => { state.polCap = v; render(); },
    }));
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻三：LFU 会被「过气热点」赖住' }),
        h('p.sec-note', {
            html: '场景很现实：老1/老2/老3 是昨天的爆款，被访问了 20 轮，计数攒到了 20+。'
                + '今天热点换成了 新1/新2/新3，老的再也没人看。缓存容量 ' + state.polCap + ' 个。'
                + '<b>下面统计的只是「后一段」的命中率</b>：',
        }),
        pctl,
        Viz.cmpGrid([
            {
                h: 'LFU', v: Math.round(pol.out.lfu.phase2 * 100) + '%',
                d: '老热点计数高，赖着不走', cls: 'cmp-bad',
            },
            {
                h: 'LRU', v: Math.round(pol.out.lru.phase2 * 100) + '%',
                d: '老的没人访问，很快被挤出去', cls: 'cmp-ok',
            },
            {
                h: 'Redis 采样 LRU', v: Math.round(pol.out.sampled.phase2 * 100) + '%',
                d: '跟真 LRU 差不多', cls: 'cmp-save',
            },
        ]),
        h('p.sec-note', { html: '跑完之后各自缓存里剩下什么（<b>看 LFU 那一行</b>）：' }),
        h('div.ce-strips', null,
            polRow('LFU', pol.out.lfu.keys, pol.cap),
            polRow('LRU', pol.out.lru.keys, pol.cap),
            polRow('FIFO', pol.out.fifo.keys, pol.cap)
        ),
        h('div.seq-note', {
            html: '<b>LFU 的缓存里全是「老」，一个「新」都留不住</b> —— '
                + '新 key 进来时计数是 1，一比就输给计数 20 的老 key，'
                + '于是刚进来就被扔，永远攒不起计数。这叫<b>缓存污染</b>，'
                + '本质是「LFU 只记次数不记时间，历史包袱一背就是一辈子」。',
        }),
        h('h3.sec-title.ce-sub', { html: '<i class="fas fa-wand-magic-sparkles"></i> Redis 的解法：对数计数器 + 时间衰减' }),
        h('p.sec-note', {
            html: 'Redis 4.0 的 <code>allkeys-lfu</code> 干了两件事：<br>'
                + '<b>① 计数器只有 8 位，而且是对数增长的</b> —— 命中时不是 +1，'
                + '而是以 <code>1/(baseval × lfu-log-factor + 1)</code> 的概率才 +1。'
                + '计数越高越难再涨，所以 100 次和 100 万次访问的差距被压缩到很小，'
                + '<b>老热点攒不出「不可撼动」的分数</b>。<br>'
                + '<b>② 时间衰减</b> —— 每过 <code>lfu-decay-time</code> 分钟（默认 1），计数器减 1。'
                + '不再被访问的 key 会自己凉下去，几十分钟后就跟新 key 站在同一起跑线。',
        }),
        lfuChart(),
        h('p.sec-note', {
            html: '（固定种子模拟。注意 <code>factor 0</code> 那条几乎是直线 —— 退化成朴素计数，'
                + '1000 次访问就顶到接近上限了；<code>factor 10</code>（默认值）'
                + '把 1000 次访问压到了两位数，这样 8 位计数器才够用几百万次访问的量级。）',
        })
    ));

    // ── 策略对比表 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-table-list"></i> 五种策略，什么时候用哪个' }),
        policyTable(runs)
    ));

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: 'Redis 的 LRU 是真的 LRU 吗？',
                a: '<b>不是。</b>Redis 用的是<b>近似 LRU</b>：淘汰时随机采样 '
                    + '<code>maxmemory-samples</code> 个 key（默认 5），从这几个里挑 idle 时间最长的扔。'
                    + '每个 key 的 <code>redisObject</code> 里只存一个 24 位的 <code>lru</code> 时钟字段，'
                    + '不维护链表。<br>'
                    + '为什么这么设计？真 LRU 需要全局双向链表 + 每次访问都要移动节点，'
                    + '内存和锁的代价在千万级 key 下扛不住。'
                    + '而实测采样 5 个的<b>命中率</b>就已经很接近真 LRU 了'
                    + '（本演示里只差 ' + ((cmp.trueRate - cmp.sampRate) * 100).toFixed(1) + ' 个百分点，'
                    + '尽管每次「摸中真正最老那个」的概率只有 ' + Math.round(cmp.agreeRate * 100) + '%）。'
                    + '<b>这是一个非常漂亮的工程权衡：决策经常不最优，但结果几乎一样好。</b><br>'
                    + 'Redis 3.0 还加了个「候选池」优化：把历次采样中比较老的 key 攒在一个 16 大小的池子里，'
                    + '进一步逼近真 LRU。',
            },
            {
                q: 'LRU 和 LFU 各自的死穴是什么？',
                a: '<b>LRU 怕扫描</b>：一次遍历型访问（备份、报表、爬虫）就能把热数据全冲掉，'
                    + '而且有<b>悬崖效应</b>——容量比工作集小 1 个，命中率就是 0%。<br>'
                    + '<b>LFU 怕变化</b>：老热点靠历史计数赖着不走，新热点刚进来计数是 1，'
                    + '一比就输、刚进来就被扔，永远起不来（缓存污染）。<br>'
                    + '解法：LRU 侧用 <b>LRU-K / 分区 LRU</b>（要「被访问过 K 次」才算热，'
                    + 'InnoDB 就是这么干的）；LFU 侧用 <b>时间衰减</b>（Redis 的 lfu-decay-time）'
                    + '或 <b>W-TinyLFU</b>（Caffeine 用的，拿 Count-Min Sketch 记频率 + 定期减半）。',
            },
            {
                q: 'Redis 的 volatile-* 和 allkeys-* 有什么区别？',
                a: '<code>allkeys-lru</code> / <code>allkeys-lfu</code> / <code>allkeys-random</code> '
                    + '在<b>所有 key</b> 里挑；<code>volatile-*</code> 只在<b>设置了过期时间的 key</b> 里挑。<br>'
                    + '坑在于：如果你用 <code>volatile-lru</code> 但大部分 key 没设 TTL，'
                    + '内存满了会直接返回 <b>OOM 错误</b>而不是淘汰 —— 因为没有候选。'
                    + '当纯缓存用就选 <code>allkeys-lru</code> 或 <code>allkeys-lfu</code>；'
                    + '缓存和持久数据混在一个实例里才用 <code>volatile-*</code>（更好的做法是拆实例）。',
            },
            {
                q: '怎么判断该加内存还是该换策略？',
                a: '看命中率<b>随容量的变化曲线</b>，不是看单点数值。'
                    + '如果曲线还在陡峭上升段，加内存最划算；'
                    + '如果已经到平台期（再加也就涨 1~2 个点），那问题在<b>访问模式</b>，'
                    + '要么换策略（比如换 LFU 或 W-TinyLFU），要么在应用层做分层缓存。<br>'
                    + '另外要警惕上面那个悬崖：<b>命中率长期是 0% 或很低，不一定是策略不行，'
                    + '可能只是差最后一点点容量</b>，加够就直接跳满。',
            },
            {
                q: 'LRU-K（LRU-2）是什么？',
                a: '普通 LRU 看「最后一次访问时间」，LRU-K 看「<b>倒数第 K 次</b>访问时间」。'
                    + '效果是：<b>只被访问过一次的 key 被视为「无穷旧」，优先淘汰</b> —— '
                    + '这样一次性的扫描流量就冲不掉热数据了。<br>'
                    + '代价是要为「还没进缓存但访问过一次」的 key 维护一个历史队列，内存和实现都更重。'
                    + 'InnoDB 的分区 LRU 本质上是 LRU-2 的一个便宜的近似：'
                    + '新页先放 old 子链，被再次访问才升 young。',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['命中率不是越高越好 —— 要看省下了什么',
             '90% 命中率但漏掉的 10% 全是慢查询，可能比 70% 命中率但漏掉的都是快查询更糟。'
             + '<b>该优化的指标是「后端总耗时」，命中率只是中间量。</b>'
             + '真实系统里更该看 P99 延迟和后端 QPS 的下降幅度。'],
            ['LFU 的计数器一定要能衰减',
             '自己实现 LFU 时如果只加不减，跑几天以后缓存里全是「历史冠军」，'
             + '新数据一个都进不来，命中率会随时间缓慢腐烂。'
             + '这种问题<b>上线当天测不出来</b>，一周后才发作，特别难查。'
             + '要么定期把所有计数除以 2，要么像 Redis 那样按时间衰减。'],
            ['采样 LRU 在 key 数量很少时反而不准',
             '缓存里只有 6 个 key、采样 5 个，那基本就是全扫，和真 LRU 一样；'
             + '但如果只有 2 个 key 而采样 5 个，每次都是全体参与，也没问题。'
             + '真正尴尬的是<b>采样数设成 1</b> —— 那就是纯随机淘汰，'
             + '把上面的滑块拖到 1 看看命中率掉多少。'],
            ['过期（TTL）和淘汰（eviction）是两回事',
             '<code>expire</code> 到点删除是「这个数据本来就该没了」，'
             + '淘汰是「内存不够了被迫扔」。Redis 里前者靠惰性删除 + 定期抽样删除，'
             + '后者才走 maxmemory-policy。'
             + '<b>监控要分开看</b>：<code>evicted_keys</code> 持续增长说明内存不够，'
             + '<code>expired_keys</code> 增长是正常的。'],
            ['本演示的命中率不能直接对标线上',
             'Zipf 分布只是对真实负载的一个粗糙近似，真实业务有时段性、有突发热点、'
             + '有 key 大小差异（Redis 淘汰时不看 value 多大，扔一个 1MB 的和扔一个 10B 的一样算一次）。'
             + '<b>这里的数字用来看「策略之间的相对关系」，不要当成绝对值。</b>'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '简化的地方：<br>'
                + '① 所有随机都来自<b>线性同余伪随机 + 固定种子</b>，没有用 <code>Math.random</code> —— '
                + '否则采样 LRU 和真 LRU 就没法严格对照，刷新一次结论就变了。<br>'
                + '② 采样 LRU 没有实现 Redis 3.0 加的<b>候选池（eviction pool）</b>：'
                + '真实 Redis 会把历次采样中较老的 key 攒进一个大小 16 的池子，'
                + '所以线上效果比这里演示的还要更接近真 LRU。<br>'
                + '③ LRU-2 这里用的是「entry 已经在缓存里」的倒数第二次访问时间；'
                + '标准 LRU-K 还要为不在缓存里的 key 维护历史队列，本演示没做。<br>'
                + '④ 对数计数器那张图是按 Redis 的公式模拟出来的，'
                + '不是抄的官方表格，具体数值会因随机序列略有出入，趋势是对的。<br>'
                + '⑤ 每个条目都按「1 个格子」算，没有考虑 value 大小差异。'
                + '真实缓存里「扔一个大 value」和「扔十个小 value」腾出的空间完全不同。',
        }),
        h('p', {
            html: '悬崖效应那一段的「稳态命中率」跳过了第一轮（冷启动阶段必然全部缺页），'
                + '否则容量刚好够时也只能算出 (n-loopLen)/n 而不是 100%，看不出「跳变」这个重点。',
        })
    ));
}

function polRow(name, keys, cap) {
    const box = h('div.ce-strip-row', null, h('span.ce-strip-name', { text: name }));
    const strip = h('div.ce-strip');
    for (let i = 0; i < cap; i++) {
        const k = keys[i];
        const old = k && k.indexOf('老') === 0;
        strip.appendChild(h('span.ce-slot' + (k == null ? '.empty' : (old ? '.stale' : '.fresh')),
            { text: k == null ? '·' : k }));
    }
    box.appendChild(strip);
    return box;
}

function evictTable(cmp) {
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '第几次访问' }),
        h('th', { text: '要装进来的' }),
        h('th', { text: '这一刻真正最老的' }),
        h('th', { text: '采样实际扔掉的' }),
        h('th', { text: '这次摸到了哪几个' })
    ));
    const show = cmp.rows.slice(0, 14);
    show.forEach((r) => {
        tbl.appendChild(h('tr' + (r.agree ? '' : '.ce-diff'), null,
            h('td', { text: '#' + (r.i + 1) }),
            h('td', { text: r.key }),
            h('td', { text: r.ideal || '—' }),
            h('td' + (r.agree ? '.ok' : '.bad'), { text: r.sampEvict || '—' }),
            h('td.ce-pool', { text: r.pool.join(' ') })
        ));
    });
    wrap.appendChild(tbl);
    if (cmp.rows.length > show.length) {
        wrap.appendChild(h('p.sec-note', {
            text: '（只列了前 ' + show.length + ' 次淘汰，一共 ' + cmp.rows.length + ' 次）',
        }));
    }
    return wrap;
}

function sampleVerdict(cmp) {
    const gap = ((cmp.trueRate - cmp.sampRate) * 100).toFixed(1);
    if (state.sample <= 1) {
        return '<b>采样数 = 1，这就是纯随机淘汰了</b> —— 摸到谁扔谁，跟「最久没用」半点关系没有。'
            + '摸中率掉到 ' + Math.round(cmp.agreeRate * 100) + '%（就是 1/' + state.cap + '），'
            + '命中率也跟着掉。现在把滑块拖到 5 看看。';
    }
    if (state.sample >= state.cap) {
        return '采样数 ' + state.sample + ' 已经不小于缓存容量 ' + state.cap + ' 了，'
            + '等于每次都全体参与，<b>那就是真 LRU</b>，摸中率 100%。'
            + '但这也就失去了采样的全部意义 —— 真实 Redis 里 key 有几千万个，'
            + '不可能全扫一遍。把容量调大一点再看。';
    }
    return '<b>关键的一点：摸中率只有 ' + Math.round(cmp.agreeRate * 100) + '%'
        + '（理论值 ' + state.sample + '/' + state.cap + ' = ' + Math.round(cmp.expected * 100) + '%），'
        + '命中率却只比真 LRU 低 ' + gap + ' 个百分点。</b><br>'
        + '为什么？因为就算没摸中「最老的那个」，摸到的多半也是个<b>挺老的</b> —— '
        + '缓存淘汰不需要每次都精确最优，只要别把热 key 扔了就行。'
        + '这就是近似算法在工程上成立的根本原因。<br>'
        + '把滑块拖到 1 看退化成纯随机的样子，再往上拖看收益怎么迅速见顶 —— '
        + '这条「先陡后平」的收益曲线，就是 Redis 把默认值定在 5 的理由。';
}

function policyTable(runs) {
    const rows = [
        ['FIFO', '进来的顺序', '实现最简单，几乎不占额外内存', '完全不看热度，热 key 也照扔', '只有在「所有数据同等重要」时才考虑'],
        ['LRU（真）', '最后一次访问时间', '符合直觉，抗「过气热点」', '怕扫描；有悬崖效应；要维护链表', '数据量不大、访问有明显时间局部性'],
        ['LFU', '访问次数', '稳定负载下命中率最高', '缓存污染：老热点赖着不走', '热点长期稳定，比如静态资源、字典表'],
        ['Redis 近似 LRU', '随机 N 个里最老的', '不用链表，内存和 CPU 都省', '有偏差；采样数太小会退化成随机', 'Redis 默认，绝大多数场景直接用'],
        ['LRU-2', '倒数第二次访问时间', '抗扫描（一次性访问的直接扔）', '要额外维护访问历史', '有大量一次性访问混在业务流量里'],
    ];
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '策略' }), h('th', { text: '按什么排序' }),
        h('th', { text: '好处' }), h('th', { text: '坏处' }), h('th', { text: '什么时候选它' })
    ));
    rows.forEach((r) => {
        tbl.appendChild(h('tr', null,
            h('td.mv-strong', { text: r[0] }), h('td', { text: r[1] }),
            h('td.ok', { text: r[2] }), h('td.bad', { text: r[3] }), h('td', { text: r[4] })
        ));
    });
    wrap.appendChild(tbl);
    return wrap;
}

Viz.register({
    id: 'cache-eviction',
    cat: 'cache',
    title: '缓存淘汰策略',
    subtitle: 'LRU · LFU · Redis 近似 LRU',
    icon: 'fa-broom',
    blurb: '缓存满了扔谁？顺便看看 Redis 为什么不用真 LRU',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.cap = 8; state.sample = 5; state.seqLen = 240;
        state.nKeys = 24; state.skew = 0.9;
        state.loopLen = 4; state.polCap = 4; state.logFactor = 10;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
