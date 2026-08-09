// ============================================================
//  演示：进程调度算法
//  同一批进程喂给 FCFS / SJF / SRTF / RR / 优先级五种调度器，
//  五张甘特图共用一条时间轴并排放，谁快谁慢一眼可见。
//  上半部分 SCH.* 是纯函数模型（完全不碰 DOM，可以在 Node 里单测），
//  下半部分才是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const SCH = {};

/** 五种算法的元信息（顺序 = 甘特图从上到下的顺序）*/
SCH.ALGOS = [
    { key: 'fcfs', name: 'FCFS 先来先服务', short: 'FCFS', preempt: false,
        one: '按到达先后排队，一旦上 CPU 就跑到底' },
    { key: 'sjf', name: 'SJF 短作业优先', short: 'SJF', preempt: false,
        one: '每次挑「已到达的里面服务时间最短的」，不抢占' },
    { key: 'srtf', name: 'SRTF 最短剩余时间优先', short: 'SRTF', preempt: true,
        one: 'SJF 的抢占版：新来的比当前剩余还短就抢走 CPU' },
    { key: 'rr', name: 'RR 时间片轮转', short: 'RR', preempt: true,
        one: '就绪队列 FIFO，每次最多跑一个时间片 q' },
    { key: 'priority', name: '优先级调度（非抢占）', short: '优先级', preempt: false,
        one: '数字小 = 优先级高，每次挑优先级最高的，不抢占' },
];

/** 老化：等待每满 AGING_STEP 个时间单位，优先级数字 -1（越小越优先）*/
SCH.AGING_STEP = 2;

const EPS = 1e-9;

/**
 * 把用户填的进程表洗干净：补默认值、夹到合法区间、按位置重新命名 P1..Pn。
 * procs 每项 { arrival, burst, priority, name? }
 */
SCH.normalize = function (procs) {
    if (!procs || !procs.length) return [];
    return procs.map((p, i) => ({
        index: i,
        name: p && p.name ? String(p.name) : 'P' + (i + 1),
        arrival: Math.max(0, Number(p && p.arrival) || 0),
        burst: Math.max(1, Number(p && p.burst) || 1),
        priority: Math.max(1, Number(p && p.priority) || 1),
    }));
};

// ---- 内部：段记录器 ----
// segments 每项 { kind:'run'|'cs'|'idle', pid, start, end }
// pid 是进程下标；'cs'（上下文切换）和 'idle'（空转）的 pid 为 null。

function newRec() {
    return { segs: [], csCount: 0, busy: 0, idle: 0, csTime: 0, last: null };
}

function pushSeg(rec, kind, pid, start, end) {
    if (end - start <= EPS) return;
    const prev = rec.segs[rec.segs.length - 1];
    // 同一个进程连着拿到 CPU（比如 RR 里队列只剩它一个）就并成一段，
    // 免得甘特图上出现一串没有意义的碎块。
    if (prev && prev.kind === kind && prev.pid === pid && Math.abs(prev.end - start) < EPS) {
        prev.end = end;
    } else {
        rec.segs.push({ kind, pid, start, end });
    }
    if (kind === 'run') rec.busy += end - start;
    else if (kind === 'idle') rec.idle += end - start;
    else rec.csTime += end - start;
}

/**
 * 派发前先付上下文切换的账。
 * 约定：CPU 上一次跑的不是这个进程，就算一次切换（第一次派发不算，
 * 同一个进程连续拿到 CPU 也不算）。cs=0 时仍然计数，只是不占时间。
 */
function paySwitch(rec, pid, t, cs) {
    if (rec.last === null || rec.last === pid) return t;
    rec.csCount++;
    if (cs > EPS) { pushSeg(rec, 'cs', null, t, t + cs); return t + cs; }
    return t;
}

/**
 * 跑一遍调度。
 * procsIn : [{ arrival, burst, priority }]
 * algoKey : 'fcfs' | 'sjf' | 'srtf' | 'rr' | 'priority'
 * opt     : { quantum, cs, aging, agingStep }
 *
 * 返回 {
 *   algo, procs[], segments[],
 *   totalTime, busyTime, idleTime, csTime, csCount, utilization,
 *   avgTurnaround, avgWeighted, avgWaiting, avgResponse,
 *   quantum, cs, aging
 * }
 */
SCH.simulate = function (procsIn, algoKey, optIn) {
    const opt = optIn || {};
    const cs = Math.max(0, Number(opt.cs) || 0);
    const quantum = Math.max(0.5, Number(opt.quantum) || 1);
    const aging = !!opt.aging;
    const agingStep = Math.max(1, Number(opt.agingStep) || SCH.AGING_STEP);

    const procs = SCH.normalize(procsIn);
    const n = procs.length;
    const rec = newRec();
    const rem = procs.map((p) => p.burst);
    const first = procs.map(() => null);
    const comp = procs.map(() => null);
    let done = 0, t = 0;

    // 按 (到达时刻, 进程号) 排好的下标序列 —— 「谁先来」以及 RR 的入队顺序都用它
    const byArrival = procs.map((p, i) => i)
        .sort((a, b) => procs[a].arrival - procs[b].arrival || a - b);

    // 老化后的有效优先级（不开老化就是原值）
    const effPri = (i) => (aging
        ? procs[i].priority - Math.floor(Math.max(0, t - procs[i].arrival) / agingStep)
        : procs[i].priority);

    const nextArrivalAfter = (tt) => {
        let na = Infinity;
        for (let i = 0; i < n; i++) {
            if (comp[i] === null && procs[i].arrival > tt + EPS) na = Math.min(na, procs[i].arrival);
        }
        return na;
    };

    if (n > 0 && algoKey === 'rr') {
        // ---- RR 时间片轮转 ----
        // 入队顺序的约定（教科书标准，也是最容易写错的地方）：
        // 时间片用完的那一刻 T，先把「到达时刻 <= T」的新进程按到达顺序排进队尾，
        // 再把被换下来的那个进程放到它们后面。反过来写会让老进程插队，
        // 结果和标准答案对不上。
        let ai = 0;
        const queue = [];
        const enqueueUntil = (tt) => {
            while (ai < n && procs[byArrival[ai]].arrival <= tt + EPS) queue.push(byArrival[ai++]);
        };
        while (done < n) {
            enqueueUntil(t);
            if (!queue.length) {
                if (ai >= n) break;                       // 理论上到不了，防御一下
                const nt = procs[byArrival[ai]].arrival;
                pushSeg(rec, 'idle', null, t, nt);
                t = nt;
                continue;
            }
            const p = queue.shift();
            t = paySwitch(rec, p, t, cs);
            enqueueUntil(t);                              // 切换窗口里到达的，先进队
            if (first[p] === null) first[p] = t;
            const run = Math.min(quantum, rem[p]);
            const end = t + run;
            pushSeg(rec, 'run', p, t, end);
            rem[p] -= run;
            t = end;
            rec.last = p;
            enqueueUntil(t);                              // ★ 先收「此刻到达」的
            if (rem[p] <= EPS) { rem[p] = 0; comp[p] = t; done++; }
            else queue.push(p);                           // ★ 再把用完时间片的自己放回队尾
        }
    } else if (n > 0 && algoKey === 'srtf') {
        // ---- SRTF 最短剩余时间优先（抢占式）----
        // 决策点：时刻 0 / 每个进程到达 / 每个进程跑完。
        // 抢占判据用「严格小于」：新来的剩余时间必须严格短于当前进程的剩余，
        // 才抢得走 CPU；相等不抢（否则会凭空多出一堆没意义的切换）。
        let cur = null;                                   // CPU 目前握着的进程，跑完置 null
        while (done < n) {
            const ready = [];
            for (let i = 0; i < n; i++) {
                if (rem[i] > EPS && procs[i].arrival <= t + EPS) ready.push(i);
            }
            if (!ready.length) {
                const nt = nextArrivalAfter(t);
                if (!isFinite(nt)) break;
                pushSeg(rec, 'idle', null, t, nt);
                t = nt;
                continue;
            }
            ready.sort((a, b) => rem[a] - rem[b] || procs[a].arrival - procs[b].arrival || a - b);
            let pick = ready[0];
            if (cur !== null && rem[cur] > EPS && rem[pick] >= rem[cur] - EPS) pick = cur;

            t = paySwitch(rec, pick, t, cs);
            if (first[pick] === null) first[pick] = t;
            // 下一个到达时刻就是下一个可能的抢占点；切换窗口内到达的进程
            // 要等到这一段跑完才参与竞争（切换已经付过钱，不再中途反悔）。
            const end = Math.min(t + rem[pick], nextArrivalAfter(t));
            pushSeg(rec, 'run', pick, t, end);
            rem[pick] -= end - t;
            t = end;
            rec.last = pick;
            if (rem[pick] <= EPS) { rem[pick] = 0; comp[pick] = t; done++; cur = null; }
            else cur = pick;
        }
    } else if (n > 0) {
        // ---- 非抢占三兄弟：FCFS / SJF / 优先级 ----
        // 差别只在「从已到达的就绪进程里挑谁」，其余流程完全一样。
        const cmp = {
            fcfs: (a, b) => procs[a].arrival - procs[b].arrival || a - b,
            sjf: (a, b) => procs[a].burst - procs[b].burst
                || procs[a].arrival - procs[b].arrival || a - b,
            priority: (a, b) => effPri(a) - effPri(b)
                || procs[a].arrival - procs[b].arrival || a - b,
        }[algoKey] || ((a, b) => procs[a].arrival - procs[b].arrival || a - b);

        while (done < n) {
            const ready = [];
            for (let i = 0; i < n; i++) {
                if (comp[i] === null && procs[i].arrival <= t + EPS) ready.push(i);
            }
            if (!ready.length) {
                const nt = nextArrivalAfter(t);
                if (!isFinite(nt)) break;
                pushSeg(rec, 'idle', null, t, nt);        // CPU 空转，等下一个进程来
                t = nt;
                continue;
            }
            ready.sort(cmp);
            const p = ready[0];
            t = paySwitch(rec, p, t, cs);
            if (first[p] === null) first[p] = t;
            pushSeg(rec, 'run', p, t, t + rem[p]);        // 非抢占：一上 CPU 就跑到底
            t += rem[p];
            rem[p] = 0;
            comp[p] = t;
            rec.last = p;
            done++;
        }
    }

    // ---- 算指标 ----
    const detail = procs.map((p, i) => {
        const completion = comp[i] == null ? 0 : comp[i];
        const turnaround = completion - p.arrival;
        const firstRun = first[i] == null ? p.arrival : first[i];
        return {
            index: i, name: p.name,
            arrival: p.arrival, burst: p.burst, priority: p.priority,
            firstRun,
            completion,
            turnaround,
            weighted: turnaround / p.burst,            // 带权周转 = 周转 / 服务
            waiting: turnaround - p.burst,             // 等待 = 周转 − 服务
            response: firstRun - p.arrival,            // 响应 = 首次上 CPU − 到达
        };
    });

    const totalTime = rec.segs.length ? rec.segs[rec.segs.length - 1].end : 0;
    const avg = (get) => (n ? detail.reduce((s, d) => s + get(d), 0) / n : 0);

    return {
        algo: algoKey,
        procs: detail,
        segments: rec.segs,
        totalTime,
        busyTime: rec.busy,
        idleTime: rec.idle,
        csTime: rec.csTime,
        csCount: rec.csCount,
        utilization: totalTime > EPS ? rec.busy / totalTime : 0,
        avgTurnaround: avg((d) => d.turnaround),
        avgWeighted: avg((d) => d.weighted),
        avgWaiting: avg((d) => d.waiting),
        avgResponse: avg((d) => d.response),
        quantum, cs, aging,
    };
};

/** 一次跑完五种算法，返回 { fcfs: {...}, sjf: {...}, ... } */
SCH.simulateAll = function (procs, opt) {
    const out = {};
    SCH.ALGOS.forEach((a) => { out[a.key] = SCH.simulate(procs, a.key, opt); });
    return out;
};

/** 两张甘特图是不是长得一模一样（用来验证「q 够大时 RR 退化成 FCFS」）*/
SCH.sameGantt = function (a, b) {
    const A = a.segments, B = b.segments;
    if (A.length !== B.length) return false;
    for (let i = 0; i < A.length; i++) {
        if (A[i].kind !== B[i].kind || A[i].pid !== B[i].pid) return false;
        if (Math.abs(A[i].start - B[i].start) > EPS) return false;
        if (Math.abs(A[i].end - B[i].end) > EPS) return false;
    }
    return true;
};

/** t 时刻 CPU 上在跑什么（给播放头做实时读数用）*/
SCH.atTime = function (res, t) {
    for (let i = 0; i < res.segments.length; i++) {
        const s = res.segments[i];
        if (s.start <= t + EPS && t < s.end - EPS) return s;
    }
    return null;
};

if (typeof module !== 'undefined' && module.exports) module.exports = SCH;
if (typeof window !== 'undefined') window.SCHModel = SCH;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

// 同一个进程在五张图里必须是同一个颜色，所以颜色只跟「第几个进程」绑定
const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706',
    '#db2777', '#7c3aed', '#dc2626', '#0284c7'];
const colorOf = (i) => COLORS[i % COLORS.length];

// 预设场景：[到达时刻, 服务时间, 优先级]
// 优先级特意选成和「到达顺序」「服务时间顺序」都不一样，
// 这样五条泳道各画各的，不会有两条长得一模一样。
const TEXTBOOK = [[0, 7, 3], [2, 4, 4], [4, 1, 2], [5, 4, 1]];

const PRESETS = [
    {
        key: 'textbook', label: '教科书例题', icon: 'fa-book',
        procs: TEXTBOOK, quantum: 2, cs: 0,
        note: '最常见的那道题：P1 先到但最长，后面三个陆续来。五种算法的基本脾气都能在这一组里看出来。',
    },
    {
        key: 'convoy', label: '长作业饥饿', icon: 'fa-truck-moving',
        procs: [[0, 2, 3], [1, 18, 4], [2, 3, 1], [3, 2, 2], [4, 4, 2], [5, 3, 1]],
        quantum: 3, cs: 0,
        note: '一个 18 单位的长作业 P2 夹在一串短作业中间。'
            + 'FCFS 里它把后面全堵死（<b>护航效应</b>），SJF 里它自己被一直往后挤到最后才跑（<b>长作业饥饿</b>）。'
            + '同一个长作业，两种算法两种死法。',
    },
    {
        key: 'bigq', label: '时间片过大 → RR 退化成 FCFS', icon: 'fa-arrows-left-right',
        procs: TEXTBOOK, quantum: 10, cs: 0,
        note: '时间片 q=10 已经大于所有进程的服务时间，谁上 CPU 都用不完一个时间片就跑完了。'
            + '于是 <b>RR 的甘特图和 FCFS 一模一样</b> —— 把 q 拉到很大，轮转就不存在了。',
    },
    {
        key: 'smallq', label: '时间片过小 → 切换吃掉 CPU', icon: 'fa-compress',
        procs: TEXTBOOK, quantum: 1, cs: 2,
        note: 'q=1、每次切换要 2 个单位。RR 一半以上的时间在搬寄存器而不是算东西，'
            + '<b>CPU 利用率直接垮掉</b>，总时长被拉长一倍多。这就是时间片不能无限小的原因。',
    },
    {
        key: 'starve', label: '低优先级饥饿', icon: 'fa-user-clock',
        procs: [[0, 3, 1], [1, 9, 4], [2, 3, 1], [4, 3, 1], [7, 3, 1], [10, 3, 1]],
        quantum: 2, cs: 0,
        note: 'P2 优先级最低（4），后面高优先级的进程一个接一个来。'
            + '不开老化的话 P2 会被一路挤到最后 —— 把下面的<b>「优先级老化」开关打开</b>，看它的等待时间怎么掉下来。',
    },
];

const state = {
    procs: [],            // [{ arrival, burst, priority }]
    quantum: 2,
    cs: 0,
    aging: false,
    presetKey: 'textbook',
    presetNote: PRESETS[0].note,
    selected: 'srtf',     // 明细表看哪个算法
    results: null,
    maxT: 1,
    t: 0,
    playing: false,
    msPerUnit: 400,
    tick: null,
    dom: {},
};

// ---------- 小工具 ----------

function num(v) {
    if (!isFinite(v)) return '—';
    return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(2);
}
function pct(v) { return (v * 100).toFixed(1) + '%'; }

function loadPreset(key) {
    const p = PRESETS.find((x) => x.key === key) || PRESETS[0];
    state.presetKey = p.key;
    state.presetNote = p.note;
    state.procs = p.procs.map((r) => ({ arrival: r[0], burst: r[1], priority: r[2] }));
    state.quantum = p.quantum;
    state.cs = p.cs;
}

function opts() {
    return { quantum: state.quantum, cs: state.cs, aging: state.aging, agingStep: SCH.AGING_STEP };
}

// ---------- 甘特图 ----------

const G = { W: 900, PL: 12, PR: 12, TOP: 42, LANE_H: 26, TITLE_H: 17, GAP: 16, AXIS: 26 };

function buildGantt() {
    const res = state.results;
    const algos = SCH.ALGOS;
    const plotW = G.W - G.PL - G.PR;
    const maxT = state.maxT;
    const x = (t) => G.PL + (t / maxT) * plotW;

    const block = G.TITLE_H + G.LANE_H + G.GAP;
    const lanesBottom = G.TOP + algos.length * block - G.GAP;
    const H = lanesBottom + G.AXIS;

    const root = svg('svg', {
        viewBox: `0 0 ${G.W} ${H}`, class: 'sch-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': '五种调度算法的甘特图对照',
    });

    // 斜纹填充：给「上下文切换」用，一眼区分「在干活」和「在搬家」
    const defs = svg('defs');
    const pat = svg('pattern', {
        id: 'schHatch', width: 7, height: 7,
        patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
    });
    pat.appendChild(svg('rect', { width: 7, height: 7, fill: '#e8eaee' }));
    pat.appendChild(svg('line', { x1: 0, y1: 0, x2: 0, y2: 7, stroke: '#9aa2ae', 'stroke-width': 2.6 }));
    defs.appendChild(pat);
    root.appendChild(defs);

    // 时间网格（贯穿五条泳道，强调「共用同一条时间轴」）
    const step = Viz.niceStep(maxT, 10);
    for (let t = 0; t <= maxT + EPS; t += step) {
        root.appendChild(svg('line', {
            x1: x(t), x2: x(t), y1: G.TOP - 8, y2: lanesBottom, class: 'sch-grid',
        }));
        root.appendChild(T({ x: x(t), y: H - 9, class: 'sch-axis', 'text-anchor': 'middle' }, num(t)));
    }
    // 单位说明放右上角，别去挤最后一个刻度数字
    root.appendChild(T({ x: G.W - G.PR, y: 12, class: 'sch-axis-unit', 'text-anchor': 'end' },
        '横轴 = 时间（抽象单位），五条泳道共用'));

    // 顶部到达标记：谁在什么时候进系统
    const arrs = state.procs.map((p, i) => ({ i, t: Number(p.arrival) || 0 }))
        .sort((a, b) => a.t - b.t || a.i - b.i);
    let lastLabelX = -1e9;
    arrs.forEach((a) => {
        const px = x(a.t);
        const tri = svg('path', {
            d: `M${px - 4} ${G.TOP - 16}L${px + 4} ${G.TOP - 16}L${px} ${G.TOP - 8}Z`,
            fill: colorOf(a.i), class: 'sch-arr',
        });
        tri.appendChild(mkTitle(`P${a.i + 1} 在 t=${num(a.t)} 到达`));
        root.appendChild(tri);
        if (px - lastLabelX > 16) {           // 挨太近就只画三角，标签让位，免得糊成一坨
            root.appendChild(T({ x: px, y: G.TOP - 20, class: 'sch-arr-label', 'text-anchor': 'middle' },
                'P' + (a.i + 1)));
            lastLabelX = px;
        }
    });
    root.appendChild(T({ x: G.PL, y: 12, class: 'sch-arr-hint' }, '▼ 进程到达时刻（五张图共用）'));

    // 五条泳道
    algos.forEach((a, li) => {
        const r = res[a.key];
        const yTop = G.TOP + li * block;
        const yBar = yTop + G.TITLE_H;

        root.appendChild(T({ x: G.PL, y: yTop + 11, class: 'sch-lane-title' }, a.name));
        root.appendChild(T({
            x: G.W - G.PR, y: yTop + 11, class: 'sch-lane-stat', 'text-anchor': 'end',
        }, `总时长 ${num(r.totalTime)} · 利用率 ${pct(r.utilization)} · 切换 ${r.csCount} 次 · 平均周转 ${num(r.avgTurnaround)}`));

        // 泳道底板（画到 maxT，方便横向比长短）
        root.appendChild(svg('rect', {
            x: x(0), y: yBar, width: plotW, height: G.LANE_H, rx: 4, class: 'sch-lane-bg',
        }));

        r.segments.forEach((s) => {
            const x0 = x(s.start), x1 = x(s.end);
            const w = Math.max(x1 - x0, 0.8);
            let rect, label = '', tip = '';
            if (s.kind === 'run') {
                rect = svg('rect', {
                    x: x0, y: yBar + 1, width: w, height: G.LANE_H - 2, rx: 3,
                    fill: colorOf(s.pid), class: 'sch-run',
                });
                label = 'P' + (s.pid + 1);
                tip = `${a.short}：P${s.pid + 1} 占用 CPU　${num(s.start)} → ${num(s.end)}（跑了 ${num(s.end - s.start)}）`;
            } else if (s.kind === 'cs') {
                rect = svg('rect', {
                    x: x0, y: yBar + 1, width: w, height: G.LANE_H - 2, rx: 2,
                    fill: 'url(#schHatch)', class: 'sch-cs',
                });
                label = '切';
                tip = `${a.short}：上下文切换（CPU 空转）　${num(s.start)} → ${num(s.end)}`;
            } else {
                rect = svg('rect', {
                    x: x0, y: yBar + 1, width: w, height: G.LANE_H - 2, rx: 2, class: 'sch-idle',
                });
                label = '空闲';
                tip = `${a.short}：CPU 空闲，没有进程可跑　${num(s.start)} → ${num(s.end)}`;
            }
            rect.appendChild(mkTitle(tip));
            root.appendChild(rect);

            const need = s.kind === 'run' ? 15 : 20;
            if (w >= need) {
                const tx = T({
                    x: x0 + w / 2, y: yBar + G.LANE_H / 2 + 4, 'text-anchor': 'middle',
                    class: s.kind === 'run' ? 'sch-seg-label' : 'sch-seg-label-dim',
                }, label);
                tx.appendChild(mkTitle(tip));
                root.appendChild(tx);
            }
        });
    });

    // 播放头（不播放时停在 0，主视图本身已经是完整的）
    const head = svg('line', {
        x1: x(0), x2: x(0), y1: G.TOP - 10, y2: lanesBottom, class: 'sch-head',
    });
    root.appendChild(head);
    state.dom.head = head;
    state.dom.headX = x;

    return root;
}

function mkTitle(str) {
    const t = svg('title');
    t.textContent = str;
    return t;
}

// ---------- 播放 ----------

function paintHead() {
    const d = state.dom;
    if (d.head && d.headX) {
        const px = d.headX(state.t);
        d.head.setAttribute('x1', px);
        d.head.setAttribute('x2', px);
    }
    if (d.clock) d.clock.textContent = 't = ' + num(state.t);
    if (d.liveCells) {
        SCH.ALGOS.forEach((a) => {
            const cell = d.liveCells[a.key];
            if (!cell) return;
            cell.style.color = '';
            const s = SCH.atTime(state.results[a.key], state.t);
            if (!s) { cell.textContent = '已结束'; cell.className = 'sch-live-v sch-live-done'; return; }
            if (s.kind === 'run') {
                cell.textContent = 'P' + (s.pid + 1);
                cell.className = 'sch-live-v';
                cell.style.color = colorOf(s.pid);
                return;
            }
            cell.textContent = s.kind === 'cs' ? '切换中' : '空闲';
            cell.className = 'sch-live-v sch-live-dim';
        });
    }
}

function updatePlayBtn() {
    const b = state.dom.playBtn;
    if (!b) return;
    b.innerHTML = state.playing
        ? '<i class="fas fa-pause"></i> 暂停'
        : (state.t >= state.maxT - EPS
            ? '<i class="fas fa-rotate-left"></i> 重放'
            : '<i class="fas fa-play"></i> 播放');
}

function ensureTicker() {
    if (state.tick) return state.tick;
    state.tick = Viz.ticker((dt) => {
        state.t += dt / state.msPerUnit;
        if (state.t >= state.maxT) {
            state.t = state.maxT;
            state.playing = false;
            paintHead();
            updatePlayBtn();
            return false;
        }
        paintHead();
    });
    return state.tick;
}

function play() {
    if (state.t >= state.maxT - EPS) state.t = 0;
    state.playing = true;
    ensureTicker().start();
    updatePlayBtn();
}

function stopPlay() {
    state.playing = false;
    if (state.tick) state.tick.stop();
    updatePlayBtn();
}

// ---------- 计算 + 重绘动态部分 ----------

function recompute() {
    state.results = SCH.simulateAll(state.procs, opts());
    let mx = 1;
    SCH.ALGOS.forEach((a) => { mx = Math.max(mx, state.results[a.key].totalTime); });
    state.maxT = mx;
    state.msPerUnit = Math.max(90, 12000 / mx);
    if (state.t > state.maxT) state.t = state.maxT;

    const d = state.dom;
    if (d.ganttBox) { d.ganttBox.innerHTML = ''; d.ganttBox.appendChild(buildGantt()); }
    if (d.metricsBox) { d.metricsBox.innerHTML = ''; d.metricsBox.appendChild(buildMetrics()); }
    if (d.detailBox) { d.detailBox.innerHTML = ''; d.detailBox.appendChild(buildDetail()); }
    if (d.insightBox) { d.insightBox.innerHTML = ''; buildInsight(d.insightBox); }
    if (d.legendBox) { d.legendBox.innerHTML = ''; d.legendBox.appendChild(buildLegend()); }
    paintHead();
    updatePlayBtn();
}

// ---------- 进程表（可编辑）----------

function buildProcTable() {
    const tbl = h('table.sch-ptable');
    const head = h('tr', null,
        h('th', { text: '进程' }),
        h('th', { text: '到达时刻' }),
        h('th', { text: '服务时间' }),
        h('th', { text: '优先级' }),
        h('th', { text: '' })
    );
    tbl.appendChild(head);

    state.procs.forEach((p, i) => {
        const cell = (key, min) => {
            const inp = h('input.sch-num', {
                type: 'number', min: String(min), step: '1', value: String(p[key]),
            });
            inp.addEventListener('input', () => {
                const v = Number(inp.value);
                p[key] = (inp.value === '' || !isFinite(v)) ? min : Math.max(min, v);
                recompute();
            });
            // 失焦时把非法值写回去，免得输入框一直显示 -3 而模型用的是 0
            inp.addEventListener('change', () => { inp.value = String(p[key]); });
            return h('td', null, inp);
        };
        const row = h('tr', null,
            h('td', null,
                h('span.sch-swatch', { style: 'background:' + colorOf(i) }),
                h('b', { text: 'P' + (i + 1) })),
            cell('arrival', 0),
            cell('burst', 1),
            cell('priority', 1),
            h('td', null, h('button.mini.danger.sch-del', {
                onclick: () => {
                    if (state.procs.length <= 1) return;
                    state.procs.splice(i, 1);
                    refreshTable();
                    recompute();
                },
                title: '删掉这个进程',
            }, '删'))
        );
        tbl.appendChild(row);
    });

    return h('div.sch-ptable-wrap', null, tbl);
}

function refreshTable() {
    const d = state.dom;
    if (!d.tableBox) return;
    d.tableBox.innerHTML = '';
    d.tableBox.appendChild(buildProcTable());
}

// ---------- 控制区 ----------

function buildControls() {
    const box = h('div.controls');

    box.appendChild(Viz.slider({
        label: '时间片 q', min: 1, max: 12, step: 1, value: state.quantum,
        fmt: (v) => v + ' 个单位',
        onInput: (v) => { state.quantum = v; recompute(); },
    }));
    box.appendChild(Viz.slider({
        label: '上下文切换开销 cs', min: 0, max: 2, step: 0.5, value: state.cs,
        fmt: (v) => v + ' 个单位',
        onInput: (v) => { state.cs = v; recompute(); },
    }));

    const play0 = h('button.mini.primary', {
        onclick: () => (state.playing ? stopPlay() : play()),
    }, '播放');
    state.dom.playBtn = play0;

    box.appendChild(h('div.ctl-btns', null,
        play0,
        h('button.mini', {
            onclick: () => { stopPlay(); state.t = 0; paintHead(); updatePlayBtn(); },
        }, '回到 0'),
        h('button.mini', {
            onclick: () => {
                state.procs.push({
                    arrival: state.procs.length ? state.procs.length * 2 : 0,
                    burst: 3, priority: 2,
                });
                refreshTable();
                recompute();
            },
        }, '+ 加一个进程')
    ));

    // 优先级老化开关（只影响「优先级调度」那一条泳道）
    box.appendChild(h('div.sch-aging', null,
        h('span.ctl-name', { text: '优先级老化 aging' }),
        Viz.segmented({
            options: [{ v: false, label: '关' }, { v: true, label: '开（每等 ' + SCH.AGING_STEP + ' 个单位，优先级 +1 档）' }],
            value: state.aging,
            onPick: (v) => { state.aging = v; rebuildControls(); recompute(); },
        })
    ));

    return box;
}

function rebuildControls() {
    const d = state.dom;
    if (!d.ctlBox) return;
    d.ctlBox.innerHTML = '';
    d.ctlBox.appendChild(buildControls());
}

function buildPresets() {
    const box = h('div.sch-presets');
    PRESETS.forEach((p) => {
        box.appendChild(h('button.mini' + (p.key === state.presetKey ? '.primary' : ''), {
            onclick: () => {
                stopPlay();
                loadPreset(p.key);
                state.t = 0;
                refreshTable();
                rebuildControls();
                refreshPresets();
                if (state.dom.presetNote) state.dom.presetNote.innerHTML = state.presetNote;
                recompute();
            },
        }, h('i', { class: 'fas ' + p.icon }), ' ' + p.label));
    });
    return box;
}

function refreshPresets() {
    const d = state.dom;
    if (!d.presetBox) return;
    d.presetBox.innerHTML = '';
    d.presetBox.appendChild(buildPresets());
}

// ---------- 图例 ----------

function buildLegend() {
    const box = h('div.legend');
    state.procs.forEach((p, i) => {
        box.appendChild(h('span.lg', null,
            h('span.k', { style: 'background:' + colorOf(i) }),
            `P${i + 1}（到达 ${num(p.arrival)}，服务 ${num(p.burst)}，优先级 ${num(p.priority)}）`));
    });
    box.appendChild(h('span.lg', null, h('span.k.k-sch-cs'), '上下文切换（CPU 空转）'));
    box.appendChild(h('span.lg', null, h('span.k.k-sch-idle'), 'CPU 空闲，没进程可跑'));
    return box;
}

// ---------- 指标对比表 ----------

const METRICS = [
    { key: 'avgTurnaround', label: '平均周转时间', lower: true, fmt: num,
        tip: '周转 = 完成 − 到达。作业从进系统到彻底做完花了多久。' },
    { key: 'avgWeighted', label: '平均带权周转', lower: true, fmt: num,
        tip: '带权周转 = 周转 / 服务。相当于「实际花的时间是纯干活时间的几倍」，短作业被拖累时这个数会很难看。' },
    { key: 'avgWaiting', label: '平均等待时间', lower: true, fmt: num,
        tip: '等待 = 周转 − 服务。在就绪队列里干耗的时间。' },
    { key: 'avgResponse', label: '平均响应时间', lower: true, fmt: num,
        tip: '响应 = 首次上 CPU − 到达。交互式系统真正在乎的就是它。' },
    { key: 'utilization', label: 'CPU 利用率', lower: false, fmt: pct,
        tip: '有效执行时间 / 总时长。上下文切换和空转都算浪费。' },
    { key: 'csCount', label: '切换次数', lower: true, fmt: (v) => String(v),
        tip: 'CPU 从一个进程换到另一个进程的次数。' },
];

function buildMetrics() {
    const res = state.results;
    const algos = SCH.ALGOS;

    // 每一列挑出最优值，等下高亮
    const best = {};
    METRICS.forEach((m) => {
        let b = null;
        algos.forEach((a) => {
            const v = res[a.key][m.key];
            if (b === null || (m.lower ? v < b - 1e-9 : v > b + 1e-9)) b = v;
        });
        best[m.key] = b;
    });

    const tbl = h('table.mv-matrix');
    const head = h('tr', null, h('th', { text: '算法' }));
    METRICS.forEach((m) => head.appendChild(h('th', { text: m.label, title: m.tip })));
    tbl.appendChild(head);

    algos.forEach((a) => {
        const r = res[a.key];
        const row = h('tr' + (a.key === state.selected ? '.on' : ''), {
            onclick: () => { state.selected = a.key; recompute(); },
            title: '点一下，下面的逐进程明细表就换成它',
        }, h('td', null, h('b', { text: a.short }), h('span.sch-algo-sub', { text: '　' + a.one })));
        METRICS.forEach((m) => {
            const v = r[m.key];
            const isBest = Math.abs(v - best[m.key]) < 1e-9;
            row.appendChild(h('td' + (isBest ? '.ok' : ''), { text: m.fmt(v) }));
        });
        tbl.appendChild(row);
    });

    return h('div.mv-matrix-wrap', null, tbl);
}

// ---------- 逐进程明细 ----------

function buildDetail() {
    const wrap = h('div');
    const algo = SCH.ALGOS.find((a) => a.key === state.selected) || SCH.ALGOS[0];
    const r = state.results[algo.key];

    wrap.appendChild(Viz.segmented({
        options: SCH.ALGOS.map((a) => ({ v: a.key, label: a.short })),
        value: state.selected,
        onPick: (v) => { state.selected = v; recompute(); },
    }));

    const tbl = h('table.mv-matrix.sch-flat');
    const cols = ['进程', '到达', '服务', '优先级', '首次上 CPU', '完成', '周转', '带权周转', '等待', '响应'];
    const head = h('tr');
    cols.forEach((c) => head.appendChild(h('th', { text: c })));
    tbl.appendChild(head);

    r.procs.forEach((p, i) => {
        tbl.appendChild(h('tr', null,
            h('td', null, h('span.sch-swatch', { style: 'background:' + colorOf(i) }), h('b', { text: p.name })),
            h('td', { text: num(p.arrival) }),
            h('td', { text: num(p.burst) }),
            h('td', { text: num(p.priority) }),
            h('td', { text: num(p.firstRun) }),
            h('td', { text: num(p.completion) }),
            h('td', { text: num(p.turnaround) }),
            h('td', { text: num(p.weighted) }),
            h('td', { text: num(p.waiting) }),
            h('td', { text: num(p.response) })
        ));
    });

    const avgRow = h('tr.sch-avg', null,
        h('td', null, h('b', { text: '平均' })),
        h('td', { text: '' }), h('td', { text: '' }), h('td', { text: '' }),
        h('td', { text: '' }), h('td', { text: '' }),
        h('td', null, h('b', { text: num(r.avgTurnaround) })),
        h('td', null, h('b', { text: num(r.avgWeighted) })),
        h('td', null, h('b', { text: num(r.avgWaiting) })),
        h('td', null, h('b', { text: num(r.avgResponse) }))
    );
    tbl.appendChild(avgRow);

    wrap.appendChild(h('div.mv-matrix-wrap', null, tbl));
    wrap.appendChild(h('p.sec-note', {
        html: `<b>${Viz.esc(algo.name)}</b>：${algo.one}。`
            + `这一轮总时长 <b>${num(r.totalTime)}</b>，其中有效执行 <b>${num(r.busyTime)}</b>、`
            + `切换浪费 <b>${num(r.csTime)}</b>、空转 <b>${num(r.idleTime)}</b>。`,
    }));
    return wrap;
}

// ---------- 反直觉点 ----------

function buildInsight(box) {
    const res = state.results;
    const fcfs = res.fcfs, sjf = res.sjf, rr = res.rr, srtf = res.srtf, pri = res.priority;

    box.appendChild(Viz.cmpGrid([
        {
            h: 'FCFS 平均响应时间', v: num(fcfs.avgResponse), d: '先到的把后面全堵着', cls: 'cmp-bad',
        },
        {
            h: 'RR 平均响应时间', v: num(rr.avgResponse), d: `时间片 q=${num(state.quantum)}，人人先摸一口 CPU`, cls: 'cmp-ok',
        },
        {
            h: '但 RR 的平均周转', v: num(rr.avgTurnaround), d: `比 FCFS 的 ${num(fcfs.avgTurnaround)} ${rr.avgTurnaround > fcfs.avgTurnaround ? '更差' : '更好'}`,
            cls: 'cmp-save',
        },
    ]));

    box.appendChild(h('p.sec-note', {
        html: '<b>响应时间和周转时间是两码事，而且经常打架。</b>'
            + 'RR 每个进程都能很快摸到 CPU（响应快），但它把每个进程都切碎了，'
            + '每个人的完成时刻都被别人往后推（周转差）。'
            + '交互式系统宁可牺牲周转也要保响应 —— 你按下键盘 30ms 没反应就会觉得卡，'
            + '至于后台那个编译任务是 10 秒还是 11 秒完成，你根本感觉不到。',
    }));

    const sjfWin = sjf.avgTurnaround <= fcfs.avgTurnaround + 1e-9;
    box.appendChild(h('div.sch-fact' + (sjfWin ? '' : '.sch-fact-warn'), {
        html: sjfWin
            ? `<b>SJF 的平均周转（${num(sjf.avgTurnaround)}）≤ FCFS（${num(fcfs.avgTurnaround)}）。</b>`
              + '道理很朴素：把一个长作业排在短作业前面，它后面<b>每一个</b>进程都要多等这么久；'
              + '把短的提前，只有那一个长作业多等一点。这个「交换论证」在<b>所有进程同时到达</b>时是严格成立的，'
              + 'SJF 因此可证明是非抢占里平均周转最优的。'
              + '到达时刻不一样时它不再有最优保证（抢占式的 SRTF 才是这个意义上的最优），但依然是很强的启发式。'
            : `这一组输入里 SJF 的平均周转（${num(sjf.avgTurnaround)}）没能压过 FCFS（${num(fcfs.avgTurnaround)}）。`
              + '这正说明了一件常被误传的事：<b>SJF 的最优性只在「所有进程同时到达」时才是定理</b>；'
              + '到达时刻错开时，非抢占 SJF 会因为「必须等当前进程跑完」而错过更好的排法。'
              + `真正最优的是抢占式 SRTF —— 看它这一轮的 ${num(srtf.avgTurnaround)}。`,
    }));

    // RR 是不是退化成 FCFS 了
    const maxBurst = state.procs.reduce((m, p) => Math.max(m, Number(p.burst) || 1), 0);
    const same = SCH.sameGantt(rr, fcfs);
    box.appendChild(h('div.sch-fact' + (same ? '.sch-fact-ok' : ''), {
        html: same
            ? `<b>此刻 RR 的甘特图和 FCFS 完全一样。</b>时间片 q=${num(state.quantum)} 已经 ≥ 最长的服务时间 ${num(maxBurst)}，`
              + '谁上 CPU 都用不完一个时间片就跑完了，轮转根本没机会发生 —— <b>q → ∞ 时 RR 就是 FCFS</b>。'
              + '把 q 拖小，轮转立刻回来。'
            : `时间片 q=${num(state.quantum)}，最长服务时间 ${num(maxBurst)}。`
              + `把 q 拖到 ≥ ${num(maxBurst)}，RR 的甘特图会和 FCFS <b>一模一样</b>（q → ∞ 退化成 FCFS）；`
              + '把 q 拖到 1 再把切换开销拉起来，看 CPU 利用率怎么掉。',
    }));

    // 切换开销
    const waste = rr.totalTime > 0 ? rr.csTime / rr.totalTime : 0;
    box.appendChild(h('div.sch-fact' + (waste > 0.2 ? '.sch-fact-warn' : ''), {
        html: `当前 cs=${num(state.cs)}：RR 一共切了 <b>${rr.csCount}</b> 次，`
            + `烧掉 <b>${num(rr.csTime)}</b> 个时间单位，占总时长的 <b>${pct(waste)}</b>，`
            + `CPU 利用率 <b>${pct(rr.utilization)}</b>。`
            + (waste > 0.2
                ? '　<b>这就是时间片不能无限小的原因</b> —— 切换本身不产出任何计算。'
                : '　把 cs 拉到 2、把 q 拖到 1，这个数字会难看到让人印象深刻。'),
    }));

    // 优先级饥饿
    const sorted = pri.procs.slice().sort((a, b) => b.waiting - a.waiting);
    if (sorted.length >= 2) {
        const worst = sorted[0], bestP = sorted[sorted.length - 1];
        box.appendChild(h('div.sch-fact', {
            html: `优先级调度里等得最久的是 <b>${worst.name}</b>（优先级 ${num(worst.priority)}，等了 <b>${num(worst.waiting)}</b>），`
                + `最舒服的是 <b>${bestP.name}</b>（优先级 ${num(bestP.priority)}，只等了 ${num(bestP.waiting)}）。`
                + (state.aging
                    ? '　<b>老化已打开</b>：一个进程在就绪队列里每多等 ' + SCH.AGING_STEP
                      + ' 个单位，优先级数字就减 1，等久了自然会浮上来 —— 这就是防饥饿的标准做法。'
                    : '　只要高优先级进程源源不断地来，低优先级的就<b>永远排不上队</b>。'
                      + '把上面的<b>「优先级老化」开关打开</b>，再看这个数字。'),
        }));
    }
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const d = state.dom;

    // ① 场景 + 进程表 + 控制区
    d.tableBox = h('div');
    d.ctlBox = h('div');
    d.presetBox = h('div');
    d.presetNote = h('p.sec-note.sch-preset-note', { html: state.presetNote });

    rootEl.appendChild(Viz.card('fa-list-check', '一批进程，五种排法',
        '下面这张表是<b>可以直接改的</b>：到达时刻、服务时间、优先级都能填，也能加进程、删进程。'
        + '改完立刻重算重画，五种算法用的<b>永远是同一批进程</b>，所以横着比才有意义。'
        + '<br>优先级<b>数字越小越优先</b>（1 最高）。时间单位是抽象的，你可以当成毫秒，也可以当成 10ms。',
        d.presetBox, d.presetNote, d.tableBox, d.ctlBox));

    refreshPresets();
    refreshTable();
    rebuildControls();

    // ② 五张甘特图（主视图）
    d.ganttBox = h('div.sch-gantt');
    d.legendBox = h('div');
    const live = h('div.sch-live');
    d.clock = h('b.sch-clock', { text: 't = 0' });
    d.liveCells = {};
    live.appendChild(h('div.sch-live-cell', null,
        h('span.sch-live-k', { text: '播放时刻' }), d.clock));
    SCH.ALGOS.forEach((a) => {
        const v = h('b.sch-live-v', { text: '—' });
        d.liveCells[a.key] = v;
        live.appendChild(h('div.sch-live-cell', null,
            h('span.sch-live-k', { text: a.short + ' 在跑' }), v));
    });

    rootEl.appendChild(Viz.card('fa-bars-staggered', '五张甘特图，共用同一条时间轴',
        '同一个进程在五张图里<b>永远是同一个颜色</b>，横着扫一眼就知道谁把谁挤到了后面。'
        + '斜纹格子是<b>上下文切换</b>（CPU 在搬寄存器，不产出计算），浅灰是 <b>CPU 空闲</b>。'
        + '鼠标停在任意一格上能看到它是哪个进程、从几跑到几。',
        d.legendBox, d.ganttBox, live));

    // ③ 指标对比
    d.metricsBox = h('div');
    rootEl.appendChild(Viz.card('fa-table-list', '指标对比：每一列的最优值都标绿了',
        '点表格里的任意一行，下面的逐进程明细就切到那个算法。'
        + '<b>重点看「平均周转」和「平均响应」这两列</b> —— 它们经常不是同一个赢家，'
        + '这正是批处理系统和交互式系统选择不同算法的根本原因。',
        d.metricsBox));

    // ④ 反直觉点
    d.insightBox = h('div');
    rootEl.appendChild(Viz.card('fa-lightbulb', '四个反直觉的地方', null, d.insightBox));

    // ⑤ 逐进程明细
    d.detailBox = h('div');
    rootEl.appendChild(Viz.card('fa-magnifying-glass-chart', '逐进程明细', null, d.detailBox));

    // ⑥ 怎么选
    rootEl.appendChild(Viz.card('fa-comments', '这五个算法到底怎么选', null, buildQA()));

    // ⑦ 常见误区
    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '常见误区', null, buildPitfalls()));

    // ⑧ 建模口径
    rootEl.appendChild(buildFootNote());

    recompute();
}

function buildQA() {
    return Viz.qa([
        {
            q: '批处理系统（跑报表、跑编译、跑大数据任务）该用哪个？',
            a: '用 <b>SJF / SRTF</b>。批处理没人盯着屏幕，用户只关心「一批任务整体什么时候做完」，'
                + '也就是<b>平均周转时间</b>。SJF 在这个指标上有理论支撑（所有任务同时就绪时可证明最优），'
                + 'SRTF 更进一步。'
                + '代价是<b>需要预先知道每个作业要跑多久</b> —— 现实中拿不到，只能靠历史数据做指数平滑预测'
                + '（<code>τₙ₊₁ = α·tₙ + (1−α)·τₙ</code>），预测不准算法就退化。'
                + '另外长作业会饥饿，得配「等太久就提级」之类的兜底。',
        },
        {
            q: '交互式系统（桌面、手机、Web 服务器）为什么一定是 RR？',
            a: '因为用户感知的是<b>响应时间</b>，不是周转时间。'
                + '你按下键盘、点下按钮，30ms 内没动静就觉得卡；'
                + '至于后台那个下载任务是 10 秒还是 11 秒完成，没人在意。'
                + 'RR 让每个进程在一轮里都能摸到 CPU，最坏响应时间被<b>时间片 × 就绪进程数</b>兜住了，'
                + '这是可预期的；FCFS 则是「前面来了个大活，所有人一起等」，没有上界。'
                + '<b>代价是平均周转变差</b>，以及切换开销 —— 所以时间片要选在「响应够快」和「切换不太亏」之间，'
                + '经典取值是 <b>10~100ms</b>，并且要让<b>绝大多数交互任务在一个时间片内做完</b>。',
        },
        {
            q: '实时系统呢？',
            a: '实时系统关心的是<b>能不能在截止时间前完成</b>，'
                + '上面五个都不直接解决这件事。工程上用的是<b>抢占式优先级</b>打底，'
                + '再配专门的实时调度策略：静态优先级的 <b>RMS</b>（周期越短优先级越高）、'
                + '动态优先级的 <b>EDF</b>（截止时间越近越优先）。'
                + '另外实时系统里有个著名的坑叫<b>优先级反转</b>：'
                + '低优先级进程持有锁，把等锁的高优先级进程拖住，中优先级进程反倒抢先跑。'
                + '解法是<b>优先级继承</b>或<b>优先级天花板</b>。火星探路者号 1997 年就栽在这个上面。',
        },
        {
            q: '现在的 Linux 用的是这五个里的哪一个？',
            a: '<b>一个都不是。</b>普通进程（<code>SCHED_OTHER</code>）在 2007–2023 年走的是 '
                + '<b>CFS 完全公平调度器</b>，6.6 内核起换成了 <b>EEVDF</b>。'
                + 'CFS 的核心不是「排队」也不是「轮转」，而是给每个进程记一个<b>虚拟运行时间 vruntime</b>'
                + '（真实运行时间按权重折算，nice 值越低权重越大、vruntime 涨得越慢），'
                + '用红黑树维护，<b>每次挑 vruntime 最小的那个跑</b>。'
                + '它没有固定时间片，调度周期是按就绪进程数动态算的。'
                + '真正的实时策略 <code>SCHED_FIFO</code>（就是不带时间片的抢占式优先级）和 '
                + '<code>SCHED_RR</code>（带时间片的）依然在，但只给实时优先级用。'
                + '所以别以为现代内核还在跑课本里那个 RR。',
        },
        {
            q: '时间片设多大合适？',
            a: '看两个约束。<b>下界</b>：时间片必须远大于一次上下文切换的开销，'
                + '否则 CPU 全在搬家（把上面的 cs 拉到 2、q 拖到 1 就能看到利用率崩掉）。'
                + '经验值是让切换开销占比控制在 <b>1% 以内</b>。'
                + '<b>上界</b>：时间片 × 就绪进程数就是最坏响应时间，太大了就退化成 FCFS，交互体验崩。'
                + '实践里还要看「绝大多数交互请求能不能在一个时间片里做完」—— '
                + '如果 80% 的任务都要跨两个时间片，说明时间片偏小了。',
        },
    ]);
}

function buildPitfalls() {
    return Viz.pitfalls([
        ['「抢占」和「时间片」不是一回事',
            '抢占指的是「进程还没跑完就被夺走 CPU」，时间片只是<b>触发抢占的一种理由</b>。'
            + 'SRTF 是抢占式但没有时间片（它在<b>有新进程到达</b>时才可能抢）；'
            + 'RR 是抢占式且靠时间片；SJF 和 FCFS 完全不抢。'
            + '还有一种抢占式优先级调度（本演示做的是非抢占版），它在高优先级进程到达时立刻抢。'],
        ['平均周转时间好，不等于用户觉得快',
            '这是整个话题最重要的一句话。指标表里 RR 的平均周转通常比 FCFS 差，'
            + '但<b>平均响应时间好得多</b>，而用户感知的是后者。'
            + '拿平均周转去评价一个交互式系统，等于用「总里程」评价一辆车好不好开。'],
        ['SJF 需要预知未来，这在现实里做不到',
            '课本题目直接给你「服务时间」，操作系统可拿不到。'
            + '真实系统只能用历史行为<b>预测</b>下一次的 CPU 突发长度'
            + '（指数平滑 <code>τₙ₊₁ = α·tₙ + (1−α)·τₙ</code>）。'
            + '预测偏差一大，SJF 的理论优势就没了。'
            + '这也是为什么通用操作系统里几乎见不到纯 SJF。'],
        ['优先级调度不带老化就是在制造饥饿',
            '只要高优先级进程源源不断，低优先级的可以<b>永远</b>等下去。'
            + '标准解法是<b>老化 aging</b>：进程在就绪队列里每等一段时间，优先级就自动提一档，'
            + '等得够久总能浮上来。（本演示的老化开关就是干这个的。）'
            + '另一种做法是<b>多级反馈队列 MLFQ</b>：新进程放高优先级队列，用完时间片就降一级，'
            + '定期把所有进程拉回最高级，兼顾响应和防饥饿。'],
        ['上下文切换的开销不只是「保存几个寄存器」',
            '寄存器和页表基址的保存恢复只是显性成本，通常几微秒。'
            + '真正贵的是<b>隐性成本</b>：TLB 被刷、CPU cache 变冷，'
            + '新进程上来后要重新把工作集捞进 cache，'
            + '这段「热身」时间往往比切换本身长一个数量级。'
            + '这也是为什么调度器会尽量把进程<b>调度回同一个核</b>（CPU 亲和性）。'],
        ['甘特图上的「一格」不是一秒',
            '课本例题里的时间单位是抽象的。真实系统里一次 CPU 突发通常是毫秒级，'
            + '时间片是 10~100ms 级，上下文切换是微秒级。'
            + '本演示为了让切换开销看得见，把 cs 放大到了和时间片同一个量级 —— '
            + '<b>真实比例远没有这么夸张</b>，别拿这张图去估算真实系统的开销占比。'],
    ]);
}

function buildFootNote() {
    return h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 这个演示做了哪些简化（很重要，别跳过）' }),
        h('p', {
            html: '任何调度模型都是简化过的，把简化摊开说清楚，你才知道结论能推广到哪儿。'
                + '本演示的口径如下：',
        }),
        h('ul.sch-assume', {
            html: [
                '<b>单核 CPU</b>。多核调度要额外处理负载均衡、CPU 亲和性、迁移开销，完全是另一个话题。',
                '<b>纯 CPU 密集，没有 I/O 阻塞</b>。这里的进程一上 CPU 就一直算到时间片用完或跑完，'
                + '不会中途去读磁盘、等网络。真实进程是「CPU 突发 → I/O 突发 → CPU 突发」交替的，'
                + 'I/O 密集型进程往往只跑几毫秒就主动让出 CPU —— 这也是 RR 在真实系统里没那么亏的原因之一。',
                '<b>时间单位是抽象的</b>，不对应秒或毫秒；所有进程在 t=0 之后陆续到达。',
                '<b>上下文切换的计费口径</b>：CPU 上一次跑的不是即将派发的这个进程，就收一次 cs 的费用。'
                + '第一次派发不收（不是「从别的进程切过来」），同一个进程连着拿到 CPU 也不收'
                + '（RR 里就绪队列只剩它一个时就是这种情况）。空转之后再派发别的进程<b>要收</b>。'
                + '因此恒等式成立：<code>总时长 = 有效执行 + 切换次数 × cs + 空转</code>。',
                '<b>RR 的入队顺序</b>：时间片在时刻 T 用完时，先把「到达时刻 ≤ T」的新进程按到达顺序排进队尾，'
                + '<b>再</b>把被换下来的那个进程放到它们后面。这是教科书标准约定，也是这类题最容易做错的一步；'
                + '反过来写会让老进程插队，答案就和标准解对不上。切换窗口 <code>[T, T+cs]</code> 内到达的进程，'
                + '在切换结束那一刻入队。',
                '<b>SRTF 的抢占时机</b>：决策点只有「时刻 0 / 有进程到达 / 有进程跑完」三种。'
                + '抢占判据用<b>严格小于</b> —— 新到达进程的服务时间必须<b>严格短于</b>当前进程的剩余时间才抢得走 CPU，'
                + '相等时不抢（否则会凭空多出一堆毫无意义的切换）。'
                + '切换窗口内到达的进程要等到当前这一段跑完才参与竞争（钱已经付了，不中途反悔）。',
                '<b>优先级</b>：数字小 = 优先级高，做的是<b>非抢占</b>版本（高优先级进程到达时不会打断正在跑的）。'
                + '老化公式是「有效优先级 = 原优先级 − ⌊等待时长 / ' + SCH.AGING_STEP + '⌋」，'
                + '只是众多老化实现里最简单的一种。',
                '<b>同分怎么办</b>：所有算法在关键指标相同时，一律先按到达时刻、再按进程编号排。'
                + '不同教材的 tie-break 写法不一样，甘特图对不上时先看这里。',
                '<b>没有随机数</b>。进程集完全由上面那张表决定，同样的输入永远得到同样的结果，'
                + '五个算法才严格可对照。',
            ].map((s) => '<li>' + s + '</li>').join(''),
        })
    );
}

Viz.register({
    id: 'scheduling',
    cat: 'os',
    title: '进程调度算法',
    subtitle: 'FCFS / SJF / SRTF / RR / 优先级',
    icon: 'fa-list-check',
    blurb: '同一批进程喂给五种调度算法，甘特图并排看谁更快',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.aging = false;
        state.selected = 'srtf';
        state.t = 0;
        state.playing = false;
        loadPreset('textbook');
        render();
    },
    unmount() {
        stopPlay();
        if (state.tick) { state.tick.stop(); state.tick = null; }
        state.results = null;
        state.dom = {};
        rootEl = null;
    },
});

})();
