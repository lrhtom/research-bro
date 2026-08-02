// ============================================================
//  演示：限流四算法对比（固定窗口 / 滑动窗口 / 漏桶 / 令牌桶）
//  同一条请求到达序列，同时喂给四个限流器，谁放谁挡一眼看完。
//  主角是固定窗口的「临界突刺」：窗口翻页那一瞬间计数器归零，
//  于是 200ms 里能塞进去 2 倍于阈值的请求 —— 限流形同虚设。
//  上半 RL.* 全是纯函数（不碰 DOM，能在 Node 里直接单测），下半才是界面。
//  到达序列一律确定性生成（固定分布 / 线性同余 + 固定种子），
//  不用 Math.random()，四条时间轴才严格可对照、每次刷新结果一样。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const RL = {};

/** 线性同余伪随机。固定种子 → 每次刷新完全一样，图才可对照 */
RL.lcg = function (seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
};

/** 把 n 个点均匀铺在 [a, b] 闭区间上（含端点），取整 */
RL.spread = function (n, a, b) {
    const out = [];
    if (n <= 0) return out;
    if (n === 1) { out.push(Math.round(a)); return out; }
    for (let k = 0; k < n; k++) out.push(Math.round(a + ((b - a) * k) / (n - 1)));
    return out;
};

/**
 * 生成到达序列（确定性）。
 * opt = { pattern, limit, windowMs, durationMs, intensity }
 *   pattern: 'even' 均匀 | 'burst' 一波洪峰 | 'edge' 临界突刺 | 'jitter' 真实抖动
 * 返回 { times:[ms 升序], spikes:[{from,to,label}] }
 *   spikes 是给界面画高亮用的「要重点看的时间段」
 */
RL.arrivals = function (opt) {
    const D = opt.durationMs, W = opt.windowMs, limit = opt.limit;
    const times = [], spikes = [];

    if (opt.pattern === 'edge') {
        // 临界突刺：limit 个挤在第 1 个窗口的末尾，limit 个挤在第 2 个窗口的开头。
        // 两簇加起来只跨 2×sw 毫秒，但固定窗口会全部放行。
        const sw = Math.max(30, Math.min(200, Math.round(W * 0.1)));
        RL.spread(limit, W - sw, W - 1).forEach((t) => times.push(t));
        RL.spread(limit, W, W + sw - 1).forEach((t) => times.push(t));
        spikes.push({ from: W - sw, to: W, label: '窗口①末尾' });
        spikes.push({ from: W, to: W + sw, label: '窗口②开头' });
        // 后半段补一点稀疏流量，免得时间轴太空
        const lo = 2 * W;
        if (lo + 200 < D) {
            const nT = Math.max(2, Math.round(((D - lo) / W) * limit * 0.7));
            RL.spread(nT, lo, D - 60).forEach((t) => times.push(t));
        }
    } else if (opt.pattern === 'burst') {
        // 一波洪峰：六成请求挤在中段的一小截里，其余当背景流量
        const n = Math.max(3, Math.round((opt.intensity * D) / 1000));
        const nb = Math.round(n * 0.6);
        const b0 = Math.round(D * 0.38);
        const b1 = b0 + Math.max(120, Math.round(D * 0.09));
        RL.spread(nb, b0, b1).forEach((t) => times.push(t));
        RL.spread(n - nb, 0, D - 40).forEach((t) => times.push(t));
        spikes.push({ from: b0, to: b1, label: '洪峰' });
    } else if (opt.pattern === 'jitter') {
        // 真实抖动：指数分布的到达间隔（泊松流），用固定种子的 LCG 生成
        const rnd = RL.lcg(20260731);
        const meanGap = 1000 / Math.max(1, opt.intensity);
        let t = 0;
        for (let guard = 0; guard < 4000; guard++) {
            t += Math.max(3, -Math.log(1 - rnd() * 0.999) * meanGap);
            if (t > D - 20) break;
            times.push(Math.round(t));
        }
    } else {
        // 均匀流量
        const n = Math.max(3, Math.round((opt.intensity * D) / 1000));
        RL.spread(n, 0, D - 40).forEach((t) => times.push(t));
    }

    times.sort((a, b) => a - b);
    return { times, spikes };
};

/** 长期允许速率：阈值 / 窗口 → 每秒多少个。四个算法统一用它，才谈得上公平对照 */
RL.rateOf = function (opt) { return (opt.limit * 1000) / opt.windowMs; };

/**
 * 固定窗口 Fixed Window
 * 时间按 W 切片，每片一个计数器，翻页时归零。count < limit 就放行并 count++。
 * opt = { limit, windowMs, durationMs? }
 */
RL.fixedWindow = function (times, opt) {
    const W = opt.windowMs, limit = opt.limit;
    const counts = {};
    const events = [], passTimes = [];

    times.forEach((t, i) => {
        const w = Math.floor(t / W);
        const c = counts[w] || 0;
        if (c < limit) {
            counts[w] = c + 1;
            events.push({ i, t, ok: true, win: w, seq: c + 1 });
            passTimes.push(t);
        } else {
            events.push({ i, t, ok: false, win: w, seq: limit });
        }
    });

    const endT = opt.durationMs != null ? opt.durationMs
        : (times.length ? times[times.length - 1] + 1 : W);
    const windows = [];
    for (let w = 0; w * W < endT; w++) {
        windows.push({ i: w, from: w * W, to: Math.min((w + 1) * W, endT), count: counts[w] || 0, limit });
    }

    return {
        algo: 'fixed', events, passTimes, outTimes: passTimes, windows,
        pass: passTimes.length, reject: times.length - passTimes.length, total: times.length,
    };
};

/**
 * 滑动窗口日志 Sliding Window Log
 * 只记「已放行」的时间戳；到达 t 时若 (t-W, t] 内已放行数 < limit 就放行。
 * 没有临界突刺（任意长度为 W 的窗口内放行数恒 ≤ limit），代价是要存时间戳。
 * 日志长度永远 ≤ limit（被拒的根本不入日志），所以内存是 O(limit)。
 */
RL.slidingWindow = function (times, opt) {
    const W = opt.windowMs, limit = opt.limit;
    const log = [];           // 已放行时间戳，天然升序
    let head = 0;             // 头指针，代替真删除
    const events = [], passTimes = [];
    let memPeak = 0;

    times.forEach((t, i) => {
        while (head < log.length && log[head] <= t - W) head++;   // 只保留 (t-W, t]
        const inWin = log.length - head;
        if (inWin < limit) {
            log.push(t);
            passTimes.push(t);
            events.push({ i, t, ok: true, inWin: inWin + 1 });
        } else {
            events.push({ i, t, ok: false, inWin });
        }
        memPeak = Math.max(memPeak, log.length - head);
    });

    return {
        algo: 'sliding', events, passTimes, outTimes: passTimes, memPeak,
        pass: passTimes.length, reject: times.length - passTimes.length, total: times.length,
    };
};

/**
 * 漏桶 Leaky Bucket
 * 桶里最多同时装 capacity 个请求（含此刻正在出水的那个），出口以恒定间隔 1000/r 出水。
 * 请求到达时桶没满就「入队排队」（不是立刻通过！），满了才拒。
 * opt = { capacity, ratePerSec, endT? }
 * 注意语义：ok=true 表示被接纳（迟早会出水），wait 是它排队等了多久。
 */
RL.leakyBucket = function (times, opt) {
    const cap = opt.capacity;
    const interval = 1000 / opt.ratePerSec;
    const events = [], departures = [];
    const bucket = [];        // 已接纳请求的出水时刻，升序
    let head = 0;
    let nextOut = -Infinity;  // 下一滴最早能出水的时刻

    times.forEach((t, i) => {
        while (head < bucket.length && bucket[head] < t) head++;   // 已经出水的不占位
        const occupied = bucket.length - head;
        if (occupied >= cap) {
            events.push({ i, t, ok: false, leaveAt: null, wait: 0, occupied });
            return;
        }
        const leaveAt = Math.max(t, nextOut);
        nextOut = leaveAt + interval;
        bucket.push(leaveAt);
        departures.push(leaveAt);
        events.push({ i, t, ok: true, leaveAt, wait: leaveAt - t, occupied });
    });

    const waits = events.filter((e) => e.ok).map((e) => e.wait);
    const sum = waits.reduce((a, b) => a + b, 0);
    const endT = opt.endT != null ? opt.endT
        : (departures.length ? departures[departures.length - 1] : 0);

    return {
        algo: 'leaky', events, departures, outTimes: departures, interval,
        pass: waits.length, reject: times.length - waits.length, total: times.length,
        avgWait: waits.length ? sum / waits.length : 0,
        maxWait: waits.length ? Math.max.apply(null, waits) : 0,
        stillQueued: departures.filter((d) => d > endT).length,
    };
};

/**
 * 令牌桶 Token Bucket
 * 桶容量 capacity，以 ratePerSec 匀速补令牌（补满就不再补）。
 * 请求到达时有令牌就消耗 1 个立刻放行，没有就拒 —— 允许最大 capacity 的突发。
 * opt = { capacity, ratePerSec, initial?, endT? }
 * series 是画令牌余量曲线用的阶梯点（每次到达记「消耗前 / 消耗后」两点）
 */
RL.tokenBucket = function (times, opt) {
    const cap = opt.capacity, r = opt.ratePerSec;
    let tokens = opt.initial == null ? cap : opt.initial;
    let last = times.length ? Math.min(0, times[0]) : 0;
    const events = [], passTimes = [], series = [{ t: last, v: tokens }];

    times.forEach((t, i) => {
        tokens = Math.min(cap, tokens + ((t - last) * r) / 1000);
        last = t;
        series.push({ t, v: tokens });
        if (tokens >= 1 - 1e-9) {
            tokens = Math.max(0, tokens - 1);
            passTimes.push(t);
            events.push({ i, t, ok: true, before: tokens + 1, after: tokens });
        } else {
            events.push({ i, t, ok: false, before: tokens, after: tokens });
        }
        series.push({ t, v: tokens });
    });

    if (opt.endT != null && opt.endT > last) {
        tokens = Math.min(cap, tokens + ((opt.endT - last) * r) / 1000);
        series.push({ t: opt.endT, v: tokens });
    }

    return {
        algo: 'token', events, passTimes, outTimes: passTimes, series, capacity: cap,
        pass: passTimes.length, reject: times.length - passTimes.length, total: times.length,
    };
};

/** 在阶梯序列上取 t 时刻的值（线性插值），给播放头读数用 */
RL.sampleSeries = function (series, t) {
    if (!series.length) return 0;
    if (t <= series[0].t) return series[0].v;
    let i = 0;
    while (i + 1 < series.length && series[i + 1].t <= t) i++;
    const a = series[i], b = series[i + 1];
    if (!b || b.t === a.t) return a.v;
    return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
};

/**
 * 任意长度为 W 的时间窗内，最多放行了几个。
 * 这是揭穿固定窗口的关键指标：它会给出 2×limit，而滑动窗口恒等于 limit。
 * 最优窗口一定可以对齐到某个放行时刻，所以只枚举放行时刻即可。
 */
RL.maxPassInWindow = function (ts, W) {
    let best = 0, at = 0;
    for (let i = 0; i < ts.length; i++) {
        let c = 0;
        for (let j = i; j < ts.length && ts[j] < ts[i] + W; j++) c++;
        if (c > best) { best = c; at = ts[i]; }
    }
    return { max: best, at };
};

/** 连续 k 个放行最挤能挤进多短的时间里（k 个的最小跨度）*/
RL.tightestSpan = function (ts, k) {
    if (!ts.length || ts.length < k || k < 2) return null;
    let best = Infinity, at = 0;
    for (let i = 0; i + k - 1 < ts.length; i++) {
        const s = ts[i + k - 1] - ts[i];
        if (s < best) { best = s; at = ts[i]; }
    }
    return { span: best, at };
};

/**
 * 一把梭：同一条到达序列喂给四个限流器。
 * opt = { limit, windowMs, leakyCap, tokenCap, durationMs }
 */
RL.runAll = function (times, opt) {
    const rate = RL.rateOf(opt);
    return {
        rate,
        fixed: RL.fixedWindow(times, opt),
        sliding: RL.slidingWindow(times, opt),
        leaky: RL.leakyBucket(times, { capacity: opt.leakyCap, ratePerSec: rate, endT: opt.durationMs }),
        token: RL.tokenBucket(times, { capacity: opt.tokenCap, ratePerSec: rate, endT: opt.durationMs }),
    };
};

if (typeof module !== 'undefined' && module.exports) module.exports = RL;
if (typeof window !== 'undefined') window.RLModel = RL;
if (typeof window === 'undefined' || !window.Viz) return;   // Node 下到此为止

// ---------- 二、界面 ----------

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const PRESETS = {
    even: { label: '均匀流量', mul: 0.8 },
    burst: { label: '突发流量（一波洪峰）', mul: 2.6 },
    edge: { label: '临界突刺（打固定窗口的脸）', mul: 1 },
    jitter: { label: '真实抖动（泊松流）', mul: 1.4 },
};

const state = {
    pattern: 'edge',
    limit: 5,
    windowMs: 1000,
    leakyCap: 4,
    tokenCap: 5,
    intensity: 12,
    dur: 3000,
    t: 0,
    times: [],
    spikes: [],
    res: null,
    dom: {},
};

let rootEl = null;
let ticker = null;

// ---------- 计算 ----------

function compute() {
    const a = RL.arrivals({
        pattern: state.pattern, limit: state.limit, windowMs: state.windowMs,
        durationMs: state.dur, intensity: state.intensity,
    });
    state.times = a.times;
    state.spikes = a.spikes;
    state.res = RL.runAll(a.times, {
        limit: state.limit, windowMs: state.windowMs,
        leakyCap: state.leakyCap, tokenCap: state.tokenCap, durationMs: state.dur,
    });
}

function applyPreset(p) {
    state.pattern = p;
    // 预设顺手把到达强度也调到一个能说明问题的量级（相对于阈值速率）
    const base = RL.rateOf({ limit: state.limit, windowMs: state.windowMs });
    state.intensity = Math.max(2, Math.min(40, Math.round(base * PRESETS[p].mul)));
    render();
}

function countLE(arr, t) {
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] <= t) n++;
    return n;
}

// ---------- 四条时间轴 ----------

const SW = 900, PL = 112, PR = 18, PT = 44, PB = 30, GAP = 12;
const INNER = SW - PL - PR;

const LANES = [
    { key: 'fixed', title: '固定窗口', en: 'Fixed Window', hh: 62 },
    { key: 'sliding', title: '滑动窗口', en: 'Sliding Log', hh: 62 },
    { key: 'leaky', title: '漏桶', en: 'Leaky Bucket', hh: 102 },
    { key: 'token', title: '令牌桶', en: 'Token Bucket', hh: 62 },
];

function xOf(t) { return PL + (t / state.dur) * INNER; }

/** 时间轴刻度标签：最右边那个居中会被 viewBox 裁掉，改成右对齐贴边 */
function axisLabel(t, y) {
    const px = xOf(t), last = px + 24 > SW;
    return T({
        x: (last ? SW - 2 : px).toFixed(1), y, class: 'rl-axis',
        'text-anchor': last ? 'end' : 'middle',
    }, t === 0 ? '0' : Math.round(t) + 'ms');
}

function buildTimeline() {
    const R = state.res, D = state.dur, W = state.windowMs, limit = state.limit;
    let H = PT + PB;
    LANES.forEach((l, i) => { H += l.hh + (i ? GAP : 0); });

    const root = svg('svg', {
        viewBox: '0 0 ' + SW + ' ' + H, class: 'rl-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': '固定窗口、滑动窗口、漏桶、令牌桶四种限流算法在同一条请求流上的对照时间轴',
    });

    // 要重点看的时间段：画在最底层，纵向贯穿四条泳道
    state.spikes.forEach((sp) => {
        root.appendChild(svg('rect', {
            x: xOf(sp.from).toFixed(1), y: PT - 8,
            width: Math.max(2.5, xOf(sp.to) - xOf(sp.from)).toFixed(1),
            height: (H - PT - PB + 14).toFixed(1), class: 'rl-spike',
        }));
    });
    if (state.spikes.length) {
        const a = xOf(state.spikes[0].from), b = xOf(state.spikes[state.spikes.length - 1].to);
        root.appendChild(svg('path', {
            d: 'M' + a.toFixed(1) + ' ' + (PT - 12) + 'V' + (PT - 18)
                + 'H' + b.toFixed(1) + 'V' + (PT - 12), class: 'rl-spike-bracket',
        }));
        const mid = Math.min(Math.max((a + b) / 2, 96), SW - 96);
        root.appendChild(T({ x: mid.toFixed(1), y: PT - 24, class: 'rl-spike-label', 'text-anchor': 'middle' },
            state.spikes.map((s) => s.label).join(' + ')));
    }

    let y = PT;
    LANES.forEach((L, li) => {
        if (li) y += GAP;
        drawLane(root, L, y, H);
        y += L.hh;
    });

    // 时间坐标轴
    const step = Viz.niceStep(D, 6);
    for (let t = 0; t <= D + 0.5; t += step) {
        root.appendChild(svg('line', {
            x1: xOf(t).toFixed(1), x2: xOf(t).toFixed(1), y1: PT - 8, y2: H - PB + 2, class: 'rl-grid',
        }));
        root.appendChild(axisLabel(t, H - PB + 16));
    }
    root.appendChild(T({ x: PL - 10, y: H - PB + 16, class: 'rl-axis', 'text-anchor': 'end' }, '时间 →'));

    // 播放头
    const head = svg('line', { x1: xOf(0), x2: xOf(0), y1: PT - 10, y2: H - PB + 2, class: 'rl-head' });
    root.appendChild(head);
    state.dom.heads = [head];

    // 顺手把两个关键指标塞进 state，下面的结论横幅要用
    state.metric = {
        fixMax: RL.maxPassInWindow(R.fixed.outTimes, W).max,
        slidMax: RL.maxPassInWindow(R.sliding.outTimes, W).max,
        leakMax: RL.maxPassInWindow(R.leaky.outTimes, W).max,
        tokMax: RL.maxPassInWindow(R.token.outTimes, W).max,
        tight: RL.tightestSpan(R.fixed.outTimes, 2 * limit),
    };
    return root;
}

function drawLane(root, L, yTop, H) {
    const R = state.res, D = state.dur, r = R[L.key];

    root.appendChild(svg('rect', {
        x: PL, y: yTop, width: INNER, height: L.hh, rx: 6, class: 'rl-lane-bg',
    }));

    // 左侧标签栏（和绘图区左右分开，互不遮挡）
    const ty = L.key === 'leaky' ? yTop + 18 : yTop + 27;
    root.appendChild(T({ x: PL - 12, y: ty, class: 'rl-lane-title rl-t-' + L.key, 'text-anchor': 'end' }, L.title));
    root.appendChild(T({ x: PL - 12, y: ty + 12, class: 'rl-lane-en', 'text-anchor': 'end' }, L.en));

    // 右上角：这条轴的成绩单
    root.appendChild(T({ x: SW - PR - 6, y: yTop + 13, class: 'rl-lane-stat', 'text-anchor': 'end' },
        '放行 ' + r.pass + ' · 拒绝 ' + r.reject));

    if (L.key === 'fixed') drawFixedLane(root, yTop, L);
    else if (L.key === 'sliding') drawSimpleLane(root, yTop, L, R.sliding.events);
    else if (L.key === 'leaky') drawLeakyLane(root, yTop, L);
    else drawTokenLane(root, yTop, L);
}

/** 竖条：一个请求 */
function tick(x, yBase, hgt, cls) {
    return svg('rect', {
        x: (x - 1.7).toFixed(1), y: (yBase - hgt).toFixed(1),
        width: 3.4, height: hgt, rx: 1.4, class: cls,
    });
}

function drawFixedLane(root, yTop, L) {
    const R = state.res, W = state.windowMs, limit = state.limit;
    const base = yTop + L.hh - 12, hgt = 30;

    // 每个窗口一格：满了的格子染红，格子里写「已放行/阈值」
    R.fixed.windows.forEach((w) => {
        const x0 = xOf(w.from), x1 = xOf(w.to);
        if (w.count >= limit) {
            root.appendChild(svg('rect', {
                x: x0.toFixed(1), y: yTop + 1, width: Math.max(1, x1 - x0).toFixed(1),
                height: L.hh - 2, class: 'rl-win-full',
            }));
        }
        if (w.from > 0) {
            root.appendChild(svg('line', {
                x1: x0.toFixed(1), x2: x0.toFixed(1), y1: yTop, y2: yTop + L.hh, class: 'rl-win-sep',
            }));
        }
        root.appendChild(T({
            x: (x0 + 5).toFixed(1), y: yTop + 14,
            class: 'rl-win-count' + (w.count >= limit ? ' rl-win-count-full' : ''),
        }, w.count + '/' + limit));
    });

    R.fixed.events.forEach((e) => {
        root.appendChild(tick(xOf(e.t), base, hgt, e.ok ? 'rl-tick-ok' : 'rl-tick-bad'));
    });
    root.appendChild(svg('line', { x1: PL, x2: PL + INNER, y1: base, y2: base, class: 'rl-base' }));
}

function drawSimpleLane(root, yTop, L, events) {
    const base = yTop + L.hh - 12, hgt = 30;
    events.forEach((e) => {
        root.appendChild(tick(xOf(e.t), base, hgt, e.ok ? 'rl-tick-ok' : 'rl-tick-bad'));
    });
    root.appendChild(svg('line', { x1: PL, x2: PL + INNER, y1: base, y2: base, class: 'rl-base' }));
}

/** 漏桶：上排到达、下排出水，中间斜线就是「排队等了多久」*/
function drawLeakyLane(root, yTop, L) {
    const R = state.res.leaky;
    const inBase = yTop + 42, outBase = yTop + 90;

    root.appendChild(T({ x: PL - 12, y: inBase, class: 'rl-row-tag', 'text-anchor': 'end' }, '到达 ▸'));
    root.appendChild(T({ x: PL - 12, y: outBase, class: 'rl-row-tag', 'text-anchor': 'end' }, '出水 ▸'));

    // 先画斜线（在竖条底下）
    R.events.forEach((e) => {
        if (!e.ok || e.wait <= 0) return;
        root.appendChild(svg('line', {
            x1: xOf(e.t).toFixed(1), y1: inBase, x2: xOf(e.leaveAt).toFixed(1), y2: outBase - 18,
            class: 'rl-link',
        }));
    });

    R.events.forEach((e) => {
        const cls = !e.ok ? 'rl-tick-bad' : (e.wait > 0 ? 'rl-tick-wait' : 'rl-tick-ok');
        root.appendChild(tick(xOf(e.t), inBase, 24, cls));
    });
    R.departures.forEach((d) => {
        root.appendChild(tick(xOf(d), outBase, 18, 'rl-tick-out'));
    });

    root.appendChild(svg('line', { x1: PL, x2: PL + INNER, y1: inBase, y2: inBase, class: 'rl-base' }));
    root.appendChild(svg('line', { x1: PL, x2: PL + INNER, y1: outBase, y2: outBase, class: 'rl-base' }));

    root.appendChild(T({ x: SW - PR - 6, y: yTop + 26, class: 'rl-lane-sub', 'text-anchor': 'end' },
        '平均排队 ' + Math.round(R.avgWait) + 'ms · 最久 ' + Math.round(R.maxWait) + 'ms'));
    root.appendChild(T({ x: SW - PR - 6, y: outBase + 10, class: 'rl-lane-sub', 'text-anchor': 'end' },
        '出水间隔恒定 ' + Math.round(R.interval) + 'ms'));
}

function drawTokenLane(root, yTop, L) {
    const R = state.res.token;
    const base = yTop + L.hh - 12, hgt = 30;
    R.events.forEach((e) => {
        root.appendChild(tick(xOf(e.t), base, hgt, e.ok ? 'rl-tick-ok' : 'rl-tick-bad'));
    });
    root.appendChild(svg('line', { x1: PL, x2: PL + INNER, y1: base, y2: base, class: 'rl-base' }));
}

// ---------- 令牌余量曲线 ----------

function buildTokenChart() {
    const R = state.res.token, D = state.dur, cap = state.tokenCap;
    const H = 168, TT = 22, BB = 30;
    const ih = H - TT - BB;
    const y = (v) => TT + ih - (v / Math.max(cap, 1)) * ih;

    const root = svg('svg', {
        viewBox: '0 0 ' + SW + ' ' + H, class: 'rl-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '令牌桶内令牌余量随时间变化',
    });

    root.appendChild(svg('rect', { x: PL, y: TT, width: INNER, height: ih, rx: 6, class: 'rl-lane-bg' }));

    // 横向刻度：0 / 1 / 桶满（标签必须短，左边只有 100px 的位置）
    [[0, '0 · 空'], [1, '1 · 门槛'], [cap, '满 B=' + cap]].forEach((g) => {
        if (g[0] > cap) return;
        root.appendChild(svg('line', {
            x1: PL, x2: PL + INNER, y1: y(g[0]).toFixed(1), y2: y(g[0]).toFixed(1),
            class: g[0] === 1 ? 'rl-tok-one' : 'rl-tok-cap',
        }));
        root.appendChild(T({ x: PL - 10, y: (y(g[0]) + 4).toFixed(1), class: 'rl-axis', 'text-anchor': 'end' }, g[1]));
    });
    // 门槛线的意思写在图里面，省得左边挤不下
    root.appendChild(T({
        x: PL + INNER - 6, y: (y(1) - 6).toFixed(1), class: 'rl-tok-note', 'text-anchor': 'end',
    }, '余量掉到这条线以下 → 只能拒'));

    // 阶梯曲线 + 填充
    let area = 'M' + xOf(0).toFixed(1) + ' ' + y(0).toFixed(1);
    let line = '';
    R.series.forEach((p, i) => {
        const px = xOf(Math.min(p.t, D)).toFixed(1), py = y(p.v).toFixed(1);
        line += (i ? 'L' : 'M') + px + ' ' + py;
        area += 'L' + px + ' ' + py;
    });
    const lastT = R.series.length ? Math.min(R.series[R.series.length - 1].t, D) : 0;
    area += 'L' + xOf(lastT).toFixed(1) + ' ' + y(0).toFixed(1) + 'Z';
    root.appendChild(svg('path', { d: area, class: 'rl-tok-area' }));
    root.appendChild(svg('path', { d: line, class: 'rl-tok-line' }));

    // 被拒的那些点：正好落在「余量不足 1」的位置
    R.events.forEach((e) => {
        if (e.ok) return;
        root.appendChild(svg('circle', {
            cx: xOf(e.t).toFixed(1), cy: y(e.before).toFixed(1), r: 3, class: 'rl-tok-reject',
        }));
    });

    const step = Viz.niceStep(D, 6);
    for (let t = 0; t <= D + 0.5; t += step) {
        root.appendChild(axisLabel(t, H - 10));
    }

    const head = svg('line', { x1: xOf(0), x2: xOf(0), y1: TT - 4, y2: H - BB + 4, class: 'rl-head' });
    root.appendChild(head);
    state.dom.heads.push(head);

    return root;
}

// ---------- 播放头 ----------

function paint() {
    const t = state.t, d = state.dom, R = state.res;
    if (!R || !d.heads) return;
    const px = xOf(t).toFixed(1);
    d.heads.forEach((el) => { el.setAttribute('x1', px); el.setAttribute('x2', px); });

    if (!d.liveClock) return;
    d.liveClock.textContent = Math.round(t) + ' ms';
    d.liveFixed.textContent = countLE(R.fixed.passTimes, t);
    d.liveSliding.textContent = countLE(R.sliding.passTimes, t);
    d.liveOut.textContent = countLE(R.leaky.departures, t);

    let queued = 0;
    R.leaky.events.forEach((e) => { if (e.ok && e.t <= t && e.leaveAt > t) queued++; });
    d.liveQueue.textContent = queued + ' / ' + state.leakyCap;
    d.liveToken.textContent = RL.sampleSeries(R.token.series, t).toFixed(1);
}

function ensureTicker() {
    if (ticker) return ticker;
    ticker = Viz.ticker((dt) => {
        state.t += dt * 1.4;                 // 稍微快一点，3 秒的模拟别看太久
        if (state.t >= state.dur) {
            state.t = state.dur;
            paint();
            updatePlayBtn(false);
            return false;
        }
        paint();
        return true;
    });
    return ticker;
}

function updatePlayBtn(running) {
    const b = state.dom.playBtn;
    if (!b) return;
    b.innerHTML = running
        ? '<i class="fas fa-pause"></i> 暂停'
        : (state.t >= state.dur ? '<i class="fas fa-rotate-left"></i> 重放' : '<i class="fas fa-play"></i> 播放');
}

function togglePlay() {
    const tk = ensureTicker();
    if (tk.running) { tk.stop(); updatePlayBtn(false); return; }
    if (state.t >= state.dur) state.t = 0;
    tk.start();
    updatePlayBtn(true);
}

function stopPlay() {
    if (ticker) ticker.stop();
    state.t = 0;
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    stopPlay();
    compute();
    state.dom = {};
    rootEl.innerHTML = '';

    const R = state.res, W = state.windowMs, limit = state.limit;
    const rate = R.rate;
    const rateTxt = (Math.round(rate * 10) / 10) + ' 个/秒';

    rootEl.appendChild(buildScene(rateTxt));
    rootEl.appendChild(buildTimelineCard());
    rootEl.appendChild(buildResultCard());
    rootEl.appendChild(buildTokenCard(rateTxt));
    rootEl.appendChild(buildPickCard());
    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '用之前必须知道的坑', null, buildPitfalls()));
    rootEl.appendChild(buildFootNote(rateTxt));

    updatePlayBtn(false);
    paint();
}

function buildScene(rateTxt) {
    const c = Viz.card('fa-gauge-high', '场景：同一条请求流，喂给四个限流器',
        '限流的目标只有一句话：<b>别让下游被打死</b>。'
        + '四种算法都能把长期速率压到 <b>' + state.limit + ' 个 / ' + state.windowMs + 'ms（≈ ' + rateTxt + '）</b>，'
        + '但它们对付「毛刺」的方式完全不同 —— 有的会漏掉 2 倍流量，有的把请求扣下来排队，有的干脆允许你突发。'
        + '<b>下面四条时间轴共用同一个时间坐标、同一批请求</b>，谁放谁挡直接对着看。');

    c.appendChild(h('div.rl-presets', null,
        h('span.rl-presets-tag', { text: '预设场景：' }),
        Viz.segmented({
            value: state.pattern,
            options: Object.keys(PRESETS).map((k) => ({ v: k, label: PRESETS[k].label })),
            onPick: (v) => applyPreset(v),
        })
    ));

    const box = h('div.controls');
    box.appendChild(Viz.slider({
        label: '阈值 limit', min: 2, max: 12, step: 1, value: state.limit,
        fmt: (v) => v + ' 个/窗口', onInput: (v) => { state.limit = v; render(); },
    }));
    box.appendChild(Viz.slider({
        label: '窗口 W', min: 250, max: 1500, step: 50, value: state.windowMs,
        fmt: (v) => v + ' ms', onInput: (v) => { state.windowMs = v; render(); },
    }));
    box.appendChild(Viz.slider({
        label: '漏桶容量 C', min: 1, max: 12, step: 1, value: state.leakyCap,
        fmt: (v) => v + ' 个', onInput: (v) => { state.leakyCap = v; render(); },
    }));
    box.appendChild(Viz.slider({
        label: '令牌桶 B', min: 1, max: 12, step: 1, value: state.tokenCap,
        fmt: (v) => v + ' 个', onInput: (v) => { state.tokenCap = v; render(); },
    }));
    box.appendChild(Viz.slider({
        label: '到达强度', min: 2, max: 40, step: 1, value: state.intensity,
        fmt: (v) => v + ' 个/秒', onInput: (v) => { state.intensity = v; render(); },
    }));

    const play = h('button.mini.primary', { onclick: togglePlay }, h('i.fas.fa-play'), ' 播放');
    state.dom.playBtn = play;
    box.appendChild(h('div.ctl-btns', null, play,
        h('button.mini', { onclick: () => { stopPlay(); paint(); updatePlayBtn(false); } }, '回到 0')));
    c.appendChild(box);

    c.appendChild(h('p.rl-hint', {
        html: '<i class="fas fa-link"></i> 为了公平对照，<b>漏桶的出水速率</b>和<b>令牌桶的补令牌速率</b>都取 '
            + '<code>limit ÷ W = ' + ((Math.round(state.res.rate * 100) / 100)) + ' 个/秒</code>，'
            + '和前两个算法的长期上限完全一致 —— 这样差别才全部来自「怎么处理瞬时毛刺」。'
            + (state.pattern === 'edge'
                ? '<br><i class="fas fa-circle-info"></i> 临界突刺场景的到达序列由 <b>阈值</b> 和 <b>窗口</b> 直接推出来，'
                  + '「到达强度」这根滑块在这个场景下不起作用。'
                : ''),
    }));
    return c;
}

function buildTimelineCard() {
    const c = Viz.card('fa-bars-staggered', '四条时间轴：同一批请求，四种命运',
        '每一根小竖条 = 一个请求。'
        + '<b>漏桶那条有上下两排</b>：上排是请求到达的时刻，下排是它真正被放出去（出水）的时刻，'
        + '中间的斜线就是它<b>排队等了多久</b> —— 这是漏桶和其它三个最本质的区别，'
        + '它不是「放行/拒绝」二选一，而是多了个「先扣下来慢慢放」。');

    c.appendChild(Viz.legend([
        { cls: 'k-rl-ok', text: '放行' },
        { cls: 'k-rl-bad', text: '拒绝' },
        { cls: 'k-rl-wait', text: '漏桶：接纳但要排队' },
        { cls: 'k-rl-out', text: '漏桶：出水（等间隔）' },
        { cls: 'k-rl-spike', text: '重点看的时段' },
    ]));

    c.appendChild(h('div.rl-scroll', null, buildTimeline()));

    // 结论横幅：把「临界突刺」这件事直接用数字点破
    const m = state.metric, W = state.windowMs, limit = state.limit;
    const bad = m.fixMax > limit;
    const banner = h('div.rl-banner' + (bad ? '.rl-banner-bad' : ''));
    if (bad && m.tight && m.fixMax >= 2 * limit) {
        banner.innerHTML = '<i class="fas fa-land-mine-on"></i> <b>临界突刺出现了。</b>'
            + '阈值明明写的是「' + limit + ' 个 / ' + W + 'ms」，但固定窗口把 <b>' + (2 * limit) + '</b> 个请求'
            + '塞进了短短 <b>' + Math.round(m.tight.span) + 'ms</b> 里 —— '
            + '在任意一个 ' + W + 'ms 的滑动窗口内它最多放行了 <b>' + m.fixMax + '</b> 个，<b>正好是阈值的 '
            + (m.fixMax / limit).toFixed(1) + ' 倍</b>。'
            + '原因很简单：<b>窗口翻页那一刻计数器归零</b>，趴在边界两侧的两簇请求分属两个窗口，各花各的额度，'
            + '谁也不知道对方存在。'
            + '同一批请求，滑动窗口任意 ' + W + 'ms 内最多只放行 <b>' + m.slidMax + '</b> 个。';
    } else if (bad) {
        banner.innerHTML = '<i class="fas fa-triangle-exclamation"></i> 固定窗口在某个 ' + W + 'ms 的滑动窗口里'
            + '放行了 <b>' + m.fixMax + '</b> 个（阈值 ' + limit + '），已经超了 —— '
            + '这就是窗口边界带来的超发。滑动窗口同一批请求最多只放 <b>' + m.slidMax + '</b> 个。'
            + '想看最极端的情况，点上面的<b>「临界突刺」</b>预设。';
    } else {
        banner.innerHTML = '<i class="fas fa-circle-check"></i> 当前这条流量比较温和，四个算法都没露出破绽（'
            + '任意 ' + W + 'ms 内固定窗口最多放行 <b>' + m.fixMax + '</b> 个）。'
            + '点上面的<b>「临界突刺」</b>预设，看固定窗口怎么在 200ms 里放进去 2 倍的量。';
    }
    c.appendChild(banner);

    // 播放时的实时状态
    const live = h('div.rl-live');
    const cell = (label, ref, cls) => {
        const v = h('b.rl-live-val' + (cls ? '.' + cls : ''), { text: '0' });
        state.dom[ref] = v;
        live.appendChild(h('div.rl-live-cell', null, h('span.rl-live-label', { text: label }), v));
    };
    cell('时间', 'liveClock');
    cell('固定窗口已放行', 'liveFixed', 'rl-v-bad');
    cell('滑动窗口已放行', 'liveSliding', 'rl-v-ok');
    cell('漏桶已出水', 'liveOut', 'rl-v-ok');
    cell('漏桶排队中', 'liveQueue');
    cell('令牌余量', 'liveToken');
    state.dom.liveClock.textContent = '0 ms';
    c.appendChild(live);
    c.appendChild(h('p.sec-note', {
        html: '（上面这排数字在<b>点「播放」</b>时会跟着播放头走；'
            + '不播放也不影响 —— 图上该有的通过/拒绝标记和统计一开始就全在。）',
    }));
    return c;
}

function buildResultCard() {
    const R = state.res, m = state.metric, W = state.windowMs, limit = state.limit;
    const pct = (r) => (r.total ? Math.round((r.pass / r.total) * 100) : 0) + '%';

    const c = Viz.card('fa-scale-balanced', '结果对比',
        '「通过率高」不等于「好」—— 固定窗口通过率最高，恰恰是因为它<b>漏放了不该放的</b>。'
        + '真正该看的是右边那个指标：<b>任意 ' + W + 'ms 内最多放行了几个</b>，'
        + '它才是「限流到底有没有守住」的答案（守住 = 恒等于阈值 ' + limit + '）。');

    const cards = h('div.rl-cards');
    const one = (key, title, en, r, extra, worst) => {
        cards.appendChild(h('div.rl-c.rl-b-' + key + (worst ? '.rl-c-warn' : ''), null,
            h('div.rl-c-h', null, h('b', { text: title }), h('small', { text: en })),
            h('div.rl-c-v', { text: pct(r) }),
            h('div.rl-c-sub', { text: '通过 ' + r.pass + ' · 拒绝 ' + r.reject + '（共 ' + r.total + '）' }),
            h('div.rl-c-d', { html: extra })
        ));
    };
    one('fixed', '固定窗口', 'Fixed Window', R.fixed,
        '任意 ' + W + 'ms 内最多放行 <b class="rl-hot">' + m.fixMax + '</b> 个'
        + (m.fixMax > limit ? '　←　<b class="rl-hot">超了 ' + (m.fixMax - limit) + ' 个</b>' : ''),
        m.fixMax > limit);
    one('sliding', '滑动窗口', 'Sliding Log', R.sliding,
        '任意 ' + W + 'ms 内最多放行 <b>' + m.slidMax + '</b> 个（恒 ≤ 阈值）<br>'
        + '内存代价：峰值存了 <b>' + R.sliding.memPeak + '</b> 个时间戳');
    one('leaky', '漏桶', 'Leaky Bucket', R.leaky,
        '平均排队 <b>' + Math.round(R.leaky.avgWait) + 'ms</b> · 最久 <b>' + Math.round(R.leaky.maxWait) + 'ms</b><br>'
        + '出水恒定 ' + Math.round(R.leaky.interval) + 'ms 一个，窗口内最多 <b>' + m.leakMax + '</b> 个');
    one('token', '令牌桶', 'Token Bucket', R.token,
        '允许突发上限 = 桶容量 <b>' + state.tokenCap + '</b> 个<br>'
        + '任意 ' + W + 'ms 内最多放行 <b>' + m.tokMax + '</b> 个');
    c.appendChild(cards);

    c.appendChild(Viz.cmpGrid([
        {
            h: '固定窗口 · 边界超发',
            v: m.fixMax + ' / ' + limit,
            d: '任意 ' + W + 'ms 内放行 / 阈值',
            cls: m.fixMax > limit ? 'cmp-bad' : 'cmp-ok',
        },
        {
            h: '漏桶 · 平滑的代价',
            v: Math.round(R.leaky.avgWait) + ' ms',
            d: '平均每个请求排队多久',
            cls: 'cmp-save',
        },
        {
            h: '令牌桶 · 峰值放行',
            v: m.tokMax + ' 个',
            d: '一个窗口内最多放出去多少',
            cls: 'cmp-ok',
        },
    ]));

    if (R.leaky.stillQueued > 0) {
        c.appendChild(h('p.sec-note', {
            html: '注意漏桶那 <b>' + R.leaky.pass + '</b> 个「通过」里，还有 <b>' + R.leaky.stillQueued
                + '</b> 个到时间轴结束时<b>仍卡在桶里没出水</b>。'
                + '漏桶的「通过」意思是<b>被接纳、迟早会被处理</b>，不是「已经处理完」—— '
                + '这笔账必须算清楚，否则会误以为漏桶通过率高。',
        }));
    }
    return c;
}

function buildTokenCard(rateTxt) {
    const R = state.res.token;
    const c = Viz.card('fa-coins', '令牌桶内部：令牌余量随时间怎么变',
        '桶以 <b>' + rateTxt + '</b> 匀速滴令牌，<b>补满 ' + state.tokenCap + ' 个就不再补</b>（这就是突发上限的来源）。'
        + '每来一个请求扣掉 1 个 —— 所以曲线是「缓慢爬升 + 垂直下跌」的锯齿。'
        + '<b>曲线跌到 1 以下时，请求就只能被拒</b>（图上的红点）。');
    c.appendChild(h('div.rl-scroll', null, buildTokenChart()));
    c.appendChild(h('p.sec-note', {
        html: '看懂这张图，令牌桶的两个性质就自然了：'
            + '① <b>长时间没人来 → 令牌攒到满</b>，攒不过 B 个（曲线顶到天花板就平了），'
            + '所以突发能力有硬上限，不会越攒越可怕；'
            + '② <b>持续高压 → 余量贴着 0 走</b>，此时放行速率正好等于补令牌速率，'
            + '退化成一个匀速阀门。<b>令牌桶 = 平时匀速 + 攒下来的额度可以一次花掉。</b>',
    }));
    return c;
}

function buildPickCard() {
    const c = Viz.card('fa-hand-pointer', '四个算法怎么选',
        '别背「哪个最好」—— 它们解决的是不同的问题。先问自己一句：'
        + '<b>下游扛得住毛刺吗？超额的请求是该拒掉还是该等？</b>答案出来了，选哪个就定了。');

    const rows = [
        ['随便挡一下就行，边界抖动能忍', '固定窗口',
            'Redis <code>INCR</code> + <code>EXPIRE</code>，两行代码。计数器是唯一状态，内存 O(1)，'
            + '分布式下也最好实现。缺点就是本演示的主角：<b>边界最多放行 2 倍</b>。'],
        ['必须严格保证「任意 1 秒不超过 N」', '滑动窗口日志',
            'Redis <code>ZSET</code>：<code>ZREMRANGEBYSCORE</code> 清掉过期时间戳 → <code>ZCARD</code> 数一下 → '
            + '<code>ZADD</code> 记账，三步用一段 <b>Lua</b> 包成原子操作。'
            + '精确，但每个 key 要存最多 N 个时间戳。'],
        ['下游只能吃固定速率（写库、调三方支付、发短信）', '漏桶',
            '本质就是<b>「消息队列 + 固定速率的消费者」</b>。Nginx 的 <code>limit_req</code> 官方文档就写着用的 '
            + 'leaky bucket；<code>burst=20</code> 就是给桶 20 个排队位。'
            + 'Sentinel 的「排队等待」流控效果也是它。'],
        ['要容忍合理突发，但不能被打爆', '令牌桶',
            'Guava <code>RateLimiter.create(5)</code>（SmoothBursty，最多攒 1 秒的令牌）；'
            + 'Nginx <code>limit_req ... burst=20 nodelay</code>；'
            + 'Sentinel 的「Warm Up」（冷启动，令牌数从少到多慢慢放开）。'
            + '分布式版本用 Redis + Lua 存 <code>{令牌数, 上次补充时间}</code> 惰性补令牌。'],
    ];

    const tb = h('table.rl-tbl');
    tb.appendChild(h('tr', null, h('th', { text: '你的场景' }), h('th', { text: '选它' }), h('th', { text: '工程上怎么落地' })));
    rows.forEach((r) => {
        tb.appendChild(h('tr', null,
            h('td.rl-tbl-s', { text: r[0] }),
            h('td.rl-tbl-a', { text: r[1] }),
            h('td', { html: r[2] })
        ));
    });
    c.appendChild(h('div.rl-scroll', null, tb));

    c.appendChild(Viz.qa([
        {
            q: '一句话说清漏桶和令牌桶的区别？',
            a: '<b>出口视角看，两者是对称的</b>：漏桶限制的是「出水速率」，令牌桶限制的是「发令牌速率」，'
                + '长期吞吐都等于 r。真正的区别只有两条 —— '
                + '① <b>桶满之后新来的怎么办</b>：漏桶是「桶里排队位满了才拒」，被接纳的要<b>等</b>；'
                + '令牌桶是「没令牌立刻拒」，被接纳的<b>不等</b>。'
                + '② <b>能不能攒额度</b>：令牌桶闲的时候把令牌攒起来，忙的时候一次花掉（允许突发 B 个）；'
                + '漏桶闲的时候什么也攒不下，出水速率永远是 r。'
                + '所以：<b>要平滑选漏桶，要弹性选令牌桶。</b>',
        },
        {
            q: 'Nginx 的 limit_req 到底是哪一个？',
            a: '官方文档写的是 <b>leaky bucket（漏桶）</b>。'
                + '<code>limit_req zone=one;</code> 不带 burst 时是最严格的匀速漏桶，超出立刻 503；'
                + '<code>burst=20</code> 给了 20 个排队位，超出的请求<b>被延迟处理</b>（这就是漏桶的排队）；'
                + '加上 <code>nodelay</code> 后，这 20 个不再等待、立即转发，但仍然占着桶位、按 r 的速率释放 —— '
                + '<b>此时的行为已经和令牌桶等价了</b>。所以「nginx 是漏桶还是令牌桶」这个问题，'
                + '答案取决于你有没有写 nodelay。',
        },
        {
            q: '滑动窗口「计数器」和滑动窗口「日志」不是一回事？',
            a: '不是，这是最常被混为一谈的两个东西。'
                + '<b>日志版</b>（本演示画的）存每个放行请求的时间戳，<b>精确</b>，内存 O(limit)。'
                + '<b>计数器版</b>把窗口切成若干小格（比如 1 秒切 10 格），只存每格的计数，'
                + '当前值 = 本格计数 + 上一窗口计数 × 重叠比例。内存小得多，'
                + '但它<b>假设流量在格子内均匀分布</b> —— 这是个<b>近似</b>：'
                + '真遇到突发（请求全挤在格子的一端）就会算错，可能误放也可能误杀。'
                + '格子切得越细越准，代价是内存和计算。<b>工程上绝大多数「滑动窗口限流」指的是计数器版。</b>',
        },
        {
            q: '分布式环境下这四个怎么落地？',
            a: '核心是<b>状态要放在共享存储里，且读改写必须原子</b>。'
                + '固定窗口最简单（<code>INCR</code> 天然原子）；'
                + '其余三个都得靠 <b>Redis + Lua</b>（Lua 脚本在 Redis 里单线程执行，天然原子）。'
                + '令牌桶不需要真的开定时器补令牌 —— 存 <code>{tokens, lastRefill}</code>，'
                + '每次请求来了再按时间差<b>惰性补</b>，一次 Lua 调用搞定。'
                + 'Redis 官方的 <code>redis-cell</code> 模块用的 GCRA 算法，本质就是令牌桶的等价形式，'
                + '连令牌数都不用存，只存一个「理论到达时间」。',
        },
        {
            q: '为什么令牌桶允许突发，反而是优点？',
            a: '因为<b>真实流量本来就是毛刺的</b>。用户点一下页面可能并发发出 8 个接口请求，'
                + '你按「平均 QPS」严格匀速限流，用户体验直接崩掉，而下游其实完全扛得住这点毛刺。'
                + '令牌桶的做法是：<b>把闲时没用掉的额度存起来，允许忙时一次花掉</b>，'
                + '长期平均值仍然守得死死的。'
                + '<b>关键在于突发量是你自己设的（桶容量 B），是显式可控的</b> —— '
                + '这和固定窗口那种「你没想要、算法自己漏出来的 2 倍」有本质区别。',
        },
    ]));
    return c;
}

function buildPitfalls() {
    const W = state.windowMs, limit = state.limit;
    return Viz.pitfalls([
        ['固定窗口的临界突刺：你以为限了 N，实际能放 2N',
            '窗口翻页的那一刻计数器<b>归零</b>，趴在边界两侧的两簇请求分属两个窗口、各花各的额度。'
            + '于是在一个跨边界的 ' + W + 'ms 里，能放行 <b>2 × ' + limit + ' = ' + (2 * limit) + '</b> 个。'
            + '这不是 bug，是固定窗口的<b>数学上界</b>：任意长度为 W 的时间窗内，它最多放行 2×limit 个。'
            + '所以做容量规划时，<b>下游必须按 2 倍阈值来扛</b>，或者干脆别用固定窗口。'],
        ['漏桶「不拒绝」的真相是「排队」，平滑是用延迟买来的',
            '漏桶不像另外三个那样二选一，它多了一档「先扣下来慢慢放」。'
            + '看着通过率高，代价是<b>请求要等</b>（本演示里最久等了 '
            + Math.round(state.res.leaky.maxWait) + 'ms）。'
            + '而且这个「不拒绝」是有限的：<b>只要到达速率长期超过出水速率 r，队列必然填满，最终照样拒绝</b>，'
            + '只是拒得更晚、而且前面那些人还白等了一场。'
            + '对<b>用户直接感知</b>的同步接口，这个延迟往往比直接拒还难受（超时、重试风暴）；'
            + '对异步写库、发短信这类下游，它才是最优解。'],
        ['令牌桶允许突发是特性不是 bug，但突发量必须算进容量',
            '真实流量天然带毛刺，令牌桶就是拿来吸收毛刺的。'
            + 'Guava <code>RateLimiter</code>、Nginx <code>limit_req ... burst=N</code> 里的 burst 就是桶容量。'
            + '但要清醒：一个窗口内它<b>最多能放出 B + limit 个</b>（先花光攒的 B，再按速率放 limit）—— '
            + '本演示当前是 <b>' + state.metric.tokMax + '</b> 个。'
            + '<b>桶开太大，令牌桶的峰值可以比固定窗口的边界突刺还猛。</b>'
            + '区别在于<b>这个数是你自己设的、可控的</b>，而不是算法漏出来的。'],
        ['漏桶和令牌桶其实是一体两面，别当成两个世界',
            '<b>出口视角看两者对称</b>：一个限制出水速率，一个限制发令牌速率，长期吞吐都是 r。'
            + '区别只在两处：<b>桶满之后新来的怎么办</b>（漏桶排队等 / 令牌桶立刻拒）、'
            + '<b>能不能攒额度</b>（令牌桶能攒 B 个 / 漏桶攒不了）。'
            + '甚至可以这么理解：<b>把令牌桶的「拒绝」改成「阻塞等待下一个令牌」，它就变成漏桶了</b> —— '
            + 'Guava 的 <code>acquire()</code> 正是阻塞版（还会「透支」下一次的令牌），'
            + '所以很多人以为自己在用令牌桶，实际跑出来的是漏桶的排队行为；'
            + '真要不等就得用 <code>tryAcquire()</code>。'],
        ['滑动窗口计数器是近似，突发时会误判',
            '工程上说的「滑动窗口限流」多半不是本演示画的日志版，而是<b>计数器版</b>：'
            + '把窗口切成若干小格，当前计数 = 本格 + 上一窗口 × 重叠比例。'
            + '它省内存，但<b>假设流量在格子内均匀分布</b>。'
            + '真实突发下这个假设不成立：请求全挤在上个格子末尾时它会低估（误放），'
            + '全挤在开头时会高估（误杀）。'
            + '格子越细越准，代价是内存和计算量。<b>要「一个都不能多」就只能用日志版。</b>'],
        ['分布式下最容易翻车的是「读改写不原子」',
            '单机 <code>if (count &lt; limit) count++</code> 在多实例下就是经典竞态：'
            + '10 个实例同时读到 4，同时判断通过，实际放了 14 个。'
            + '正确做法是把整套判断塞进一次原子操作 —— Redis 的 <code>INCR</code>，'
            + '或者一段 <b>Lua 脚本</b>（Redis 单线程执行，天然原子）。'
            + '另外别忘了<b>时钟</b>：多实例的本地时间不一致会让窗口边界错位，'
            + '时间戳统一取 Redis 的 <code>TIME</code> 更稳。'],
    ]);
}

function buildFootNote(rateTxt) {
    return h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示的建模口径' }),
        h('p', {
            html: '<b>时间是模拟的</b>：整条时间轴一共 ' + state.dur + 'ms，'
                + '请求处理本身假定瞬时完成（不建模服务耗时、网络抖动、下游排队）。'
                + '<b>到达序列是确定性的</b>：均匀 / 洪峰 / 临界突刺三个场景由固定分布直接算出，'
                + '「真实抖动」用的是<b>固定种子的线性同余伪随机</b>（不是 <code>Math.random()</code>）—— '
                + '所以每次刷新结果完全一样，四条时间轴才严格可对照。',
        }),
        h('p', {
            html: '<b>四个算法用了同一个长期速率</b>：'
                + '<code>r = limit ÷ W = ' + rateTxt + '</code>，'
                + '否则比较没有意义。<b>固定窗口的窗口是从 t=0 对齐的</b>（<code>floor(t / W)</code>），'
                + '真实系统里窗口起点取决于第一个请求或 Redis key 的创建时刻，边界位置会漂，但突刺性质一样。',
        }),
        h('p', {
            html: '<b>漏桶按离散队列建模</b>：桶里最多同时装 C 个（含此刻正在出水的那个），'
                + '出水时刻 <code>leaveAt = max(到达时刻, 上一滴出水时刻 + 1000/r)</code> —— '
                + '所以繁忙期的出水间隔严格等于 <code>1000/r</code>，空闲期则不会「攒出水额度」。'
                + '<b>令牌桶按惰性补令牌建模</b>：'
                + '<code>tokens = min(B, tokens + Δt × r / 1000)</code>，'
                + '有令牌（≥1）就扣 1 放行，令牌数任何时刻都被夹在 [0, B] 内。'
                + '这两套都是工业实现（Nginx / Guava / Sentinel / Redis+Lua）真正在用的口径。',
        })
    );
}

// ---------- 注册 ----------

Viz.register({
    id: 'rate-limit',
    cat: 'sys',
    title: '限流四算法',
    subtitle: '固定窗口 / 滑动窗口 / 漏桶 / 令牌桶',
    icon: 'fa-gauge-high',
    blurb: '同一条请求流喂给四种限流器，看谁放谁挡',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.pattern = 'edge';
        state.limit = 5;
        state.windowMs = 1000;
        state.leakyCap = 4;
        state.tokenCap = 5;
        state.intensity = 12;
        state.t = 0;
        render();
    },
    unmount() {
        if (ticker) { ticker.stop(); ticker = null; }
        state.dom = {};
        state.res = null;
        state.times = [];
        state.spikes = [];
        state.t = 0;
        rootEl = null;
    },
});

})();
