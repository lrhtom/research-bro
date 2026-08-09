// ============================================================
//  演示：Join 算法 —— 嵌套循环 / 块嵌套 / 哈希 / 排序归并
//  同样两张表做 R JOIN S ON R.key = S.key，四种算法各跑一遍。
//  结果集必须一模一样，但「比较次数」和「磁盘 I/O」能差两个数量级 —— 这就是优化器每天在纠结的事。
//  上半 JN.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const JN = {};

/** 线性同余伪随机 —— 不用 Math.random，保证刷新前后数据完全一样，四种算法才能严格对照 */
JN.rng = function (seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
};

/**
 * 造一张表。
 * opt = { mode:'rand'|'seq', keyMax, seed, base }
 *   rand : key 在 [1, keyMax] 里伪随机，会有重复
 *   seq  : key = base + 1, base + 2, ...（唯一；两表 base 错开就成了「完全不匹配」）
 */
JN.makeTable = function (prefix, n, opt) {
    opt = opt || {};
    const rnd = JN.rng(opt.seed == null ? 1 : opt.seed);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const key = opt.mode === 'seq'
            ? (opt.base || 0) + i + 1
            : 1 + Math.floor(rnd() * (opt.keyMax || 8));
        rows.push({ id: prefix + (i + 1), key, idx: i });
    }
    return rows;
};

/** 连接条件。equi=true 的才是等值连接，也才轮得到哈希 join */
JN.PRED = {
    eq: { label: 'R.key = S.key', sym: '=', fn: (a, b) => a === b, equi: true },
    gt: { label: 'R.key > S.key', sym: '>', fn: (a, b) => a > b, equi: false },
};

function mkPair(l, r) {
    return { lid: l.id, rid: r.id, lkey: l.key, rkey: r.key };
}

/** 结果集归一化：排序后的 "Rx|Sy" 数组。四种算法输出顺序不同，但归一化后必须逐元素相等 */
JN.normalize = function (out) {
    return (out || []).map((o) => o.lid + '|' + o.rid).sort();
};

JN.sameResult = function (a, b) {
    const x = JN.normalize(a), y = JN.normalize(b);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
};

// ---------- 1. 简单嵌套循环 Simple Nested Loop ----------

/**
 * 外表每一行，把内表整个扫一遍。比较次数恒等于 M × N，一次也不多一次也不少。
 * opt = { pred, trace, maxSteps }
 */
JN.nestedLoop = function (R, S, opt) {
    opt = opt || {};
    const pred = JN.PRED[opt.pred || 'eq'];
    const trace = opt.trace !== false;
    const maxSteps = opt.maxSteps == null ? 5000 : opt.maxSteps;
    const out = [], steps = [];
    let comparisons = 0;

    for (let i = 0; i < R.length; i++) {
        for (let j = 0; j < S.length; j++) {
            comparisons++;
            const hit = pred.fn(R[i].key, S[j].key);
            if (hit) out.push(mkPair(R[i], S[j]));
            if (trace && steps.length < maxSteps) {
                steps.push({ kind: 'cmp', i, j, hit, cmp: comparisons, outN: out.length });
            }
        }
    }
    return {
        algo: 'snl', comparisons, out, steps,
        innerScans: R.length,           // 内表被完整扫了 M 遍
        truncated: trace && comparisons > maxSteps,
    };
};

// ---------- 2. 块嵌套循环 Block Nested Loop ----------

/**
 * 外表按 join buffer 装得下的行数分块；每读进内表一行，就和缓冲区里的全部外表行比一遍。
 * 关键：比较次数还是 M × N（一次没省），省的是**内表被完整读取的遍数**，也就是磁盘 I/O。
 * opt = { pred, blockRows, trace }
 */
JN.blockNested = function (R, S, opt) {
    opt = opt || {};
    const pred = JN.PRED[opt.pred || 'eq'];
    const trace = opt.trace !== false;
    const maxSteps = opt.maxSteps == null ? 5000 : opt.maxSteps;
    const blockRows = Math.max(1, opt.blockRows || 2);
    const out = [], steps = [], blocks = [];
    let comparisons = 0;

    for (let lo = 0; lo < R.length; lo += blockRows) {
        const hi = Math.min(lo + blockRows, R.length);
        const bi = blocks.length;
        blocks.push({ lo, hi });
        if (trace && steps.length < maxSteps) {
            steps.push({ kind: 'load', block: bi, lo, hi, cmp: comparisons, outN: out.length });
        }
        // 注意这层循环的顺序：外层是内表的行，内层是缓冲区里的外表行。
        // 内表每一行只读一次，就把缓冲区里所有外表行都比掉了。
        for (let j = 0; j < S.length; j++) {
            for (let i = lo; i < hi; i++) {
                comparisons++;
                const hit = pred.fn(R[i].key, S[j].key);
                if (hit) out.push(mkPair(R[i], S[j]));
                if (trace && steps.length < maxSteps) {
                    steps.push({ kind: 'cmp', i, j, hit, block: bi, cmp: comparisons, outN: out.length });
                }
            }
        }
    }
    return {
        algo: 'bnl', comparisons, out, steps, blocks, blockRows,
        innerScans: blocks.length,      // 内表只被完整扫了「块数」遍
    };
};

// ---------- 页 I/O 模型 ----------

JN.pages = function (rows, rowsPerPage) {
    return Math.max(1, Math.ceil(rows / Math.max(1, rowsPerPage)));
};

/**
 * 按页计数的 I/O 模型（教科书口径）：
 *   简单嵌套循环 = M + M × N      （每处理一页外表就把内表整个读一遍 —— 其实就是 B=1 的块嵌套）
 *   块嵌套循环   = M + ⌈M/B⌉ × N  （每读满一个 B 页的 join buffer 才扫一遍内表）
 * M / N 是页数，B 是 join buffer 能装几页外表。
 */
JN.pageIO = function (mPages, nPages, bPages) {
    const b = Math.max(1, bPages);
    return {
        simple: mPages + mPages * nPages,
        block: mPages + Math.ceil(mPages / b) * nPages,
        passes: Math.ceil(mPages / b),
    };
};

// ---------- 3. 哈希 Join ----------

JN.nextPow2 = function (n) { let p = 1; while (p < n) p *= 2; return p; };

/** 桶内哈希（Knuth 乘法散列） */
JN.hash = function (k) { return Math.imul(k >>> 0, 2654435761) >>> 0; };

/** 分区哈希 —— 必须和桶内哈希不同，否则同一分区里所有 key 会全撞进同一个桶 */
JN.hash2 = function (k) {
    let x = Math.imul(k >>> 0, 0x85ebca6b) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
    return Math.imul(x, 0xc2b2ae35) >>> 0;
};

/** 小表做 build 端 —— 'auto' 就是挑行数少的那张 */
JN.pickBuildSide = function (R, S, buildSide) {
    if (buildSide === 'left' || buildSide === 'right') return buildSide;
    return R.length <= S.length ? 'left' : 'right';
};

/**
 * 内存放得下版本的哈希 join：小表建哈希表（build），大表逐行探测（probe）。
 *
 * 计数口径（本演示统一用这一套，报告里的「比较次数」就是它）：
 *   comparisons = build 行数 + probe 行数 + 桶内链上的逐个 key 比较次数
 *               = hashOps + chainCompares
 * 前两项是每行算一次哈希的固定成本，第三项才是真正的 key 比较（哈希冲突时链有多长就比多少次）。
 *
 * opt = { pred, buildSide, buckets, trace }
 */
JN.hashJoin = function (R, S, opt) {
    opt = opt || {};
    const predName = opt.pred || 'eq';
    if (!JN.PRED[predName].equi) {
        return {
            algo: 'hash', ok: false, comparisons: 0, out: null, steps: [],
            reason: '哈希 join 只能做等值连接。哈希值相等 ≈ key 相等，但 key 的大小关系跟哈希值毫无关系 ——'
                + '要找「R.key > S.key」的行，你根本不知道该去翻哪个桶，只能退回嵌套循环或排序归并。',
        };
    }
    const trace = opt.trace !== false;
    const side = JN.pickBuildSide(R, S, opt.buildSide);
    const build = side === 'left' ? R : S;
    const probe = side === 'left' ? S : R;
    // 真实实现的哈希表都会留余量（装载因子 < 1），这里按 2 倍 build 行数取 2 的幂
    const nb = Math.max(2, opt.buckets || JN.nextPow2(Math.max(2, build.length * 2)));

    const buckets = [];
    for (let b = 0; b < nb; b++) buckets.push([]);
    const steps = [], out = [];
    let chainCompares = 0;

    // build 阶段：一行行落进桶，同桶的挂成冲突链
    build.forEach((row, bi) => {
        const b = JN.hash(row.key) % nb;
        buckets[b].push(bi);
        if (trace) steps.push({ kind: 'build', bi, bucket: b, phase: 'build', cmp: bi + 1, outN: 0 });
    });

    // probe 阶段：每行只查一个桶，再和链上的元素逐个比 key
    probe.forEach((row, pi) => {
        const b = JN.hash(row.key) % nb;
        const chain = buckets[b];
        const compared = [], matched = [];
        for (let c = 0; c < chain.length; c++) {
            chainCompares++;
            compared.push(chain[c]);
            if (build[chain[c]].key === row.key) matched.push(chain[c]);
        }
        matched.forEach((bi) => {
            out.push(side === 'left' ? mkPair(build[bi], row) : mkPair(row, build[bi]));
        });
        if (trace) {
            steps.push({
                kind: 'probe', pi, bucket: b, compared, matched, phase: 'probe',
                cmp: build.length + pi + 1 + chainCompares, outN: out.length,
            });
        }
    });

    const hashOps = build.length + probe.length;
    return {
        algo: 'hash', ok: true, side, buckets, nb, build, probe,
        hashOps, chainCompares, comparisons: hashOps + chainCompares,
        out, steps, partitions: 1, fits: true,
    };
};

/**
 * Grace Hash Join：build 端放不下内存时，先按 key 哈希把两张表都切成 P 份写到磁盘，
 * 再一份一份读回来做内存哈希 join。同一个 key 一定落进同一个分区，所以结果不会丢。
 * opt = { pred, buildSide, buckets, memRows, rowsPerPage }
 */
JN.graceHashJoin = function (R, S, opt) {
    opt = opt || {};
    if (!JN.PRED[opt.pred || 'eq'].equi) return JN.hashJoin(R, S, opt);

    const side = JN.pickBuildSide(R, S, opt.buildSide);
    const build = side === 'left' ? R : S;
    const probe = side === 'left' ? S : R;
    const rpp = opt.rowsPerPage || 4;
    const memRows = Math.max(1, opt.memRows == null ? Infinity : opt.memRows);
    const bPages = JN.pages(build.length, rpp), pPages = JN.pages(probe.length, rpp);

    if (build.length <= memRows) {
        const r = JN.hashJoin(R, S, Object.assign({}, opt, { trace: false }));
        return Object.assign(r, {
            partitions: 1, partBuild: [build.length], partProbe: [probe.length],
            extraIO: 0, skew: false, fits: true, memRows,
            maxPartBuild: build.length, buildRows: build.length, probeRows: probe.length,
            baseIO: bPages + pPages, side,
        });
    }

    const P = Math.max(2, Math.ceil(build.length / memRows));
    const bp = [], pp = [];
    for (let p = 0; p < P; p++) { bp.push([]); pp.push([]); }
    build.forEach((row) => bp[JN.hash2(row.key) % P].push(row));
    probe.forEach((row) => pp[JN.hash2(row.key) % P].push(row));

    let out = [], hashOps = 0, chainCompares = 0;
    for (let p = 0; p < P; p++) {
        const sub = side === 'left'
            ? JN.hashJoin(bp[p], pp[p], { buildSide: 'left', buckets: opt.buckets, trace: false })
            : JN.hashJoin(pp[p], bp[p], { buildSide: 'right', buckets: opt.buckets, trace: false });
        out = out.concat(sub.out);
        hashOps += sub.hashOps;
        chainCompares += sub.chainCompares;
    }

    const partBuild = bp.map((a) => a.length), partProbe = pp.map((a) => a.length);
    const maxPartBuild = Math.max.apply(null, partBuild);
    return {
        algo: 'hash', ok: true, side, out, steps: [],
        hashOps, chainCompares, comparisons: hashOps + chainCompares,
        partitions: P, partBuild, partProbe, maxPartBuild,
        buildRows: build.length, probeRows: probe.length,
        // 分区一趟：两张表各写一遍再各读一遍
        extraIO: 2 * (bPages + pPages), baseIO: bPages + pPages,
        skew: maxPartBuild > memRows,          // 单个分区还是塞不下 → 得递归再分一层
        fits: false, memRows,
    };
};

// ---------- 4. 排序归并 Sort-Merge ----------

/** 自己实现归并排序，好精确数出排序阶段做了多少次比较（稳定、确定） */
JN.mergeSortCount = function (arr, cmp) {
    let compares = 0;
    const ms = (a) => {
        if (a.length <= 1) return a;
        const mid = a.length >> 1;
        const L = ms(a.slice(0, mid)), Rr = ms(a.slice(mid));
        const res = [];
        let i = 0, j = 0;
        while (i < L.length && j < Rr.length) {
            compares++;
            if (cmp(L[i], Rr[j]) <= 0) res.push(L[i++]); else res.push(Rr[j++]);
        }
        while (i < L.length) res.push(L[i++]);
        while (j < Rr.length) res.push(Rr[j++]);
        return res;
    };
    return { sorted: ms(arr.slice()), compares };
};

/**
 * 排序归并：两表各自排序，然后双指针归并。
 * 重复 key 是这里最容易讲错的地方：遇到相等的一段，左边每前进一行，
 * **右指针必须回退到这一段的起点重扫一遍**（mark / rewind），否则会漏掉笛卡尔展开。
 * opt = { pred, presorted, trace }
 */
JN.sortMerge = function (R, S, opt) {
    opt = opt || {};
    const predName = opt.pred || 'eq';
    const trace = opt.trace !== false;
    const byKey = (a, b) => (a.key - b.key) || (a.idx - b.idx);
    const sr = JN.mergeSortCount(R, byKey);
    const ss = JN.mergeSortCount(S, byKey);
    // presorted = 上游（索引扫描 / 上一个算子）给的就是有序的，排序开销记 0
    const sortCompares = opt.presorted ? 0 : sr.compares + ss.compares;
    const A = sr.sorted, B = ss.sorted;

    const steps = [], out = [];
    let mergeCompares = 0, moves = 0, rewinds = 0;

    const push = (act, i, j, extra) => {
        if (!trace) return;
        steps.push(Object.assign({
            kind: 'merge', act, i, j, outN: out.length,
            cmp: sortCompares + mergeCompares, moves, rewinds,
        }, extra || {}));
    };

    if (trace) {
        steps.push({ kind: 'sort', side: 'R', outN: 0, skipped: !!opt.presorted,
            cmp: opt.presorted ? 0 : sr.compares });
        steps.push({ kind: 'sort', side: 'S', outN: 0, skipped: !!opt.presorted, cmp: sortCompares });
    }

    let i = 0, j = 0;

    if (predName === 'eq') {
        while (i < A.length && j < B.length) {
            mergeCompares++;
            const d = A[i].key - B[j].key;
            if (d < 0) { push('advL', i, j); i++; moves++; }
            else if (d > 0) { push('advR', i, j); j++; moves++; }
            else {
                const k = A[i].key, mark = j;
                push('mark', i, j, { mark, key: k });
                for (;;) {
                    // 扫完右表这一段等值组
                    for (;;) {
                        if (j >= B.length) break;
                        mergeCompares++;
                        if (B[j].key !== k) break;
                        out.push(mkPair(A[i], B[j]));
                        push('emit', i, j, { mark, key: k });
                        j++; moves++;
                    }
                    i++; moves++;
                    if (i >= A.length) break;
                    mergeCompares++;
                    if (A[i].key !== k) break;
                    // 同一组里还有左行 → 右指针回退到 mark 重扫这一段
                    const from = j;
                    j = mark; rewinds++;
                    push('rewind', i, j, { mark, key: k, from });
                }
            }
        }
    } else {
        // 非等值（R.key > S.key）：两表有序时右指针依然只往前走 ——
        // 对排好序的左行来说，匹配的是右表的一整个前缀。哈希做不到这件事，排序归并可以。
        for (i = 0; i < A.length; i++) {
            for (;;) {
                if (j >= B.length) break;
                mergeCompares++;
                if (!(B[j].key < A[i].key)) break;
                j++; moves++;
            }
            for (let q = 0; q < j; q++) out.push(mkPair(A[i], B[q]));
            moves++;
            push('band', i, j, { band: j });
        }
    }

    return {
        algo: 'smj', mode: predName, presorted: !!opt.presorted,
        sortCompares, mergeCompares, comparisons: sortCompares + mergeCompares,
        pointerMoves: moves, rewinds, out, steps,
        sortedR: A, sortedS: B, sortRawR: sr.compares, sortRawS: ss.compares,
    };
};

// ---------- 汇总：四种算法一起跑 ----------

/**
 * 同一份输入，四种算法各跑一遍，并检查结果集是否完全一致。
 * opt = { pred, blockRows, buckets, buildSide, presorted, memRows, rowsPerPage, trace }
 */
JN.runAll = function (R, S, opt) {
    opt = opt || {};
    const t = { trace: opt.trace !== false, pred: opt.pred };
    const snl = JN.nestedLoop(R, S, t);
    const bnl = JN.blockNested(R, S, Object.assign({ blockRows: opt.blockRows || 2 }, t));
    const hash = JN.hashJoin(R, S, Object.assign({ buckets: opt.buckets, buildSide: opt.buildSide }, t));
    const smj = JN.sortMerge(R, S, Object.assign({ presorted: opt.presorted }, t));
    const base = JN.normalize(snl.out);
    return {
        snl, bnl, hash, smj, base,
        allSame: JN.sameResult(snl.out, bnl.out)
            && (!hash.ok || JN.sameResult(snl.out, hash.out))
            && JN.sameResult(snl.out, smj.out),
    };
};

/**
 * 只要成本数字、不要 trace 的轻量版（给规模对比图用）。
 * 简单嵌套循环的比较次数就是 M × N，不必真跑那 M×N 次循环。
 */
JN.costModel = function (R, S, opt) {
    opt = opt || {};
    const m = R.length, n = S.length;
    const rpp = opt.rowsPerPage || 4, bpg = opt.bufferPages || 2;
    const mp = JN.pages(m, rpp), np = JN.pages(n, rpp);
    const io = JN.pageIO(mp, np, bpg);
    const hash = JN.hashJoin(R, S, { buildSide: opt.buildSide, buckets: opt.buckets, trace: false });
    const smj = JN.sortMerge(R, S, { presorted: opt.presorted, trace: false });
    return {
        m, n, mPages: mp, nPages: np,
        snl: { comparisons: m * n, io: io.simple },
        bnl: { comparisons: m * n, io: io.block, passes: io.passes, blockRows: bpg * rpp },
        hash: { comparisons: hash.comparisons, hashOps: hash.hashOps, chain: hash.chainCompares, io: mp + np },
        smj: {
            comparisons: smj.comparisons, sort: smj.sortCompares, merge: smj.mergeCompares,
            io: mp + np + (opt.presorted ? 0 : 2 * (mp + np)),
        },
    };
};

if (typeof module !== 'undefined' && module.exports) module.exports = JN;
if (typeof window !== 'undefined') window.JNModel = JN;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const PRESETS = {
    normal: { label: '典型数据', m: 6, n: 5, keyMax: 6, seed: 7, mode: 'rand',
        note: 'key 有重也有独，最常见的样子。' },
    dup: { label: '大量重复 key', m: 6, n: 5, keyMax: 2, seed: 5, mode: 'rand',
        note: '重复 key 会「笛卡尔展开」：左边 3 行 key=1、右边 2 行 key=1，就得输出 3×2=6 行。这是排序归并最容易写错的地方。' },
    unique: { label: '一对一（key 唯一）', m: 6, n: 6, mode: 'seq', sBase: 0,
        note: '两表 key 都唯一且完全对上，结果行数 = 匹配数 = 6。' },
    none: { label: '完全不匹配', m: 5, n: 5, mode: 'seq', sBase: 100,
        note: '两表 key 毫不相交，四种算法都输出 0 行 —— 但为了确认「没有」，它们白干的活差得很远。' },
};

const ALGOS = [
    { v: 'snl', label: '简单嵌套循环', en: 'Simple Nested Loop' },
    { v: 'bnl', label: '块嵌套循环', en: 'Block Nested Loop' },
    { v: 'hash', label: '哈希 Join', en: 'Hash Join' },
    { v: 'smj', label: '排序归并', en: 'Sort-Merge Join' },
];

const state = {
    // —— 小表（主视图用）
    preset: 'normal', m: 6, n: 5, pred: 'eq',
    blockRows: 2, demoBuckets: 5,
    algo: 'snl', step: 0, playing: false,
    // —— 规模对比 / I/O / 内存
    scaleM: 100, rowsPerPage: 4, bufferPages: 2,
    memPct: 100, buildSide: 'auto', presorted: false,
    // —— 运行时
    R: [], S: [], runs: null, curve: null,
    tk: null, acc: 0, dom: {},
};

// ---------- 数据 ----------

function buildTables() {
    const p = PRESETS[state.preset] || PRESETS.normal;
    if (p.mode === 'seq') {
        state.R = JN.makeTable('R', state.m, { mode: 'seq', base: 0 });
        state.S = JN.makeTable('S', state.n, { mode: 'seq', base: p.sBase || 0 });
    } else {
        state.R = JN.makeTable('R', state.m, { keyMax: p.keyMax, seed: p.seed });
        state.S = JN.makeTable('S', state.n, { keyMax: p.keyMax, seed: p.seed + 91 });
    }
}

/** 给矩阵视图预算好「每个格子是在第几步被比的」，省得每次重放 */
function annotate(run, m, n) {
    const map = new Array(m * n).fill(-1);
    const hit = {};
    run.steps.forEach((s, k) => {
        if (s.kind === 'cmp') { map[s.i * n + s.j] = k; if (s.hit) hit[s.i * n + s.j] = 1; }
    });
    run.cellStep = map; run.hitAt = hit;
    return run;
}

function compute() {
    buildTables();
    const R = state.R, S = state.S;
    state.runs = JN.runAll(R, S, {
        pred: state.pred, blockRows: state.blockRows, buckets: state.demoBuckets,
    });
    annotate(state.runs.snl, R.length, S.length);
    annotate(state.runs.bnl, R.length, S.length);
}

function curRun() { return state.runs ? state.runs[state.algo] : null; }
function stepCount() { const r = curRun(); return r && r.steps ? r.steps.length : 0; }
function curStep() { const r = curRun(); return r && r.steps ? r.steps[state.step] : null; }

// ---------- 规模对比的曲线（算一次缓存住）----------

const SIZES = [10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000];

function scaleTables(size) {
    // key 取值范围放到 4 倍表长，匹配稀疏一些，输出不会爆炸
    return {
        R: JN.makeTable('R', size, { keyMax: size * 4, seed: 11 }),
        S: JN.makeTable('S', size, { keyMax: size * 4, seed: 102 }),
    };
}

function scaleCurve() {
    if (state.curve) return state.curve;
    state.curve = SIZES.map((size) => {
        const t = scaleTables(size);
        const c = JN.costModel(t.R, t.S, {
            rowsPerPage: state.rowsPerPage, bufferPages: state.bufferPages,
        });
        return { size, snl: c.snl.comparisons, hash: c.hash.comparisons, smj: c.smj.comparisons };
    });
    return state.curve;
}

function scaleAt(size) {
    const t = scaleTables(size);
    return JN.costModel(t.R, t.S, {
        rowsPerPage: state.rowsPerPage, bufferPages: state.bufferPages,
        presorted: state.presorted,
    });
}

// ---------- 主视图 A：比较矩阵（简单 / 块嵌套共用）----------

const CELL = 30, LEFTW = 108, TOPH = 48, GAP = 14, OUTW = 232;

function outPanel(root, x, y, w, hgt, rows, total) {
    root.appendChild(svg('rect', { x, y, width: w, height: hgt, rx: 9, class: 'jn-outbox' }));
    root.appendChild(T({ x: x + 12, y: y + 19, class: 'jn-out-title' },
        '输出结果 · ' + total + ' 行'));
    const room = Math.max(0, Math.floor((hgt - 34) / 18));
    const show = rows.slice(-room);
    const skipped = rows.length - show.length;
    show.forEach((o, k) => {
        root.appendChild(T({ x: x + 12, y: y + 36 + k * 18, class: 'jn-out-row' },
            o.lid + ' ⨝ ' + o.rid + '   (key ' + o.lkey + (o.lkey === o.rkey ? '' : ' > ' + o.rkey) + ')'));
    });
    if (skipped > 0) {
        root.appendChild(T({ x: x + 12, y: y + hgt - 10, class: 'jn-out-more' },
            '⋯ 上面还有 ' + skipped + ' 行'));
    }
    if (!rows.length) {
        root.appendChild(T({ x: x + 12, y: y + 40, class: 'jn-out-more' }, '（还没有匹配）'));
    }
}

function buildMatrixView(run) {
    const R = state.R, S = state.S, m = R.length, n = S.length;
    const W = LEFTW + n * CELL + GAP + OUTW;
    const H = TOPH + m * CELL + 30;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'jn-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '比较矩阵',
    });
    const st = curStep();
    const curI = st && st.kind === 'cmp' ? st.i : -1;
    const curJ = st && st.kind === 'cmp' ? st.j : -1;
    const curBlock = st ? (st.block == null ? (st.kind === 'load' ? st.block : -1) : st.block) : -1;
    const blk = st && st.kind === 'load' ? st.block : curBlock;

    // 顶部：S 表每一行占一列
    root.appendChild(T({ x: LEFTW - 10, y: 18, class: 'jn-corner', 'text-anchor': 'end' }, '内表 S →'));
    for (let j = 0; j < n; j++) {
        const x = LEFTW + j * CELL;
        root.appendChild(svg('rect', {
            x: x + 1.5, y: 6, width: CELL - 3, height: TOPH - 14, rx: 5,
            class: 'jn-head' + (j === curJ ? ' jn-head-cur' : ''),
        }));
        root.appendChild(T({ x: x + CELL / 2, y: 20, class: 'jn-head-id', 'text-anchor': 'middle' }, S[j].id));
        root.appendChild(T({ x: x + CELL / 2, y: 33, class: 'jn-head-key', 'text-anchor': 'middle' }, String(S[j].key)));
    }

    // 左侧：R 表每一行占一行
    for (let i = 0; i < m; i++) {
        const y = TOPH + i * CELL;
        const inBlk = run.blocks ? run.blocks.findIndex((b) => i >= b.lo && i < b.hi) : -1;
        root.appendChild(svg('rect', {
            x: 2, y: y + 1.5, width: LEFTW - 12, height: CELL - 3, rx: 5,
            class: 'jn-rowbox' + (i === curI ? ' jn-rowbox-cur' : '')
                + (inBlk >= 0 && inBlk === blk ? ' jn-rowbox-blk' : ''),
        }));
        root.appendChild(T({ x: 12, y: y + CELL / 2 + 4, class: 'jn-lab' }, R[i].id));
        root.appendChild(T({ x: LEFTW - 20, y: y + CELL / 2 + 4, class: 'jn-lab-key', 'text-anchor': 'end' },
            'key ' + R[i].key));
    }
    root.appendChild(T({ x: 6, y: TOPH - 8, class: 'jn-corner' }, '外表 R ↓'));

    // 矩阵格子：扫过的留痕，命中的变绿
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
            const x = LEFTW + j * CELL, y = TOPH + i * CELL;
            const k = run.cellStep[i * n + j];
            const done = k >= 0 && k <= state.step;
            const hit = done && run.hitAt[i * n + j];
            const cur = (i === curI && j === curJ);
            root.appendChild(svg('rect', {
                x: x + 1.5, y: y + 1.5, width: CELL - 3, height: CELL - 3, rx: 4,
                class: (hit ? 'jn-cell-hit' : (done ? 'jn-cell-done' : 'jn-cell')) + (cur ? ' jn-cell-cur' : ''),
            }));
            if (done) {
                root.appendChild(T({
                    x: x + CELL / 2, y: y + CELL / 2 + 4.5, 'text-anchor': 'middle',
                    class: hit ? 'jn-mark-hit' : 'jn-mark-miss',
                }, hit ? '✓' : '·'));
            }
        }
    }

    // 块嵌套：把每个块框出来，正在处理的块高亮
    if (run.blocks) {
        run.blocks.forEach((b, bi) => {
            root.appendChild(svg('rect', {
                x: LEFTW - 3, y: TOPH + b.lo * CELL - 2,
                width: n * CELL + 6, height: (b.hi - b.lo) * CELL + 4, rx: 6,
                class: 'jn-block' + (bi === blk ? ' jn-block-cur' : ''),
            }));
        });
    }

    outPanel(root, LEFTW + n * CELL + GAP, 6, OUTW, H - 16,
        run.out.slice(0, st ? st.outN : run.out.length), st ? st.outN : run.out.length);
    return root;
}

// ---------- 主视图 B：哈希表 ----------

function buildHashView(run) {
    if (!run.ok) {
        const W = 640, H = 190;
        const root = svg('svg', {
            viewBox: '0 0 ' + W + ' ' + H, class: 'jn-svg',
            preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '哈希 join 不可用',
        });
        root.appendChild(svg('rect', { x: 10, y: 10, width: W - 20, height: H - 20, rx: 12, class: 'jn-deadbox' }));
        root.appendChild(T({ x: W / 2, y: 62, class: 'jn-dead-t', 'text-anchor': 'middle' },
            '✗ 这个连接条件，哈希 Join 根本没法用'));
        root.appendChild(T({ x: W / 2, y: 96, class: 'jn-dead-d', 'text-anchor': 'middle' },
            '桶是按「哈希值」分的，而 key 的大小关系和哈希值毫无关系。'));
        root.appendChild(T({ x: W / 2, y: 118, class: 'jn-dead-d', 'text-anchor': 'middle' },
            '要找 R.key > S.key 的行，你不知道该翻哪个桶 —— 只能把所有桶都翻一遍，那就是嵌套循环了。'));
        root.appendChild(T({ x: W / 2, y: 150, class: 'jn-dead-f', 'text-anchor': 'middle' },
            '优化器这时只有两条路：嵌套循环（块嵌套），或者排序归并的 band join。'));
        return root;
    }

    const build = run.build, probe = run.probe, nb = run.nb;
    const st = curStep();
    const inBuild = st && st.kind === 'build';
    const placed = st ? (inBuild ? st.bi + 1 : build.length) : build.length;
    const curB = st ? st.bucket : -1;
    const compared = (st && st.compared) ? st.compared : [];
    const matched = (st && st.matched) ? st.matched : [];

    const chains = run.buckets.map((c) => c.filter((bi) => bi < placed));
    const maxChain = Math.max(1, Math.max.apply(null, chains.map((c) => c.length)));

    const ROWH = 27, BUCKH = 32, CW = 96, BX = 122, BLAB = 42, CHW = 56;
    const probeX = BX + BLAB + maxChain * CHW + 26;
    const W = probeX + CW + GAP + OUTW;
    const H = 40 + Math.max(build.length * ROWH, nb * BUCKH, probe.length * ROWH) + 22;

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'jn-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '哈希 join',
    });

    // build 端
    root.appendChild(T({ x: 4, y: 20, class: 'jn-colt' },
        'build 端 · ' + (run.side === 'left' ? '左表 R' : '右表 S') + '（小表）'));
    build.forEach((row, bi) => {
        const y = 34 + bi * ROWH;
        const on = bi < placed;
        root.appendChild(svg('rect', {
            x: 4, y: y + 1, width: CW - 8, height: ROWH - 4, rx: 5,
            class: 'jn-rowbox' + (on ? ' jn-rowbox-done' : '')
                + (inBuild && bi === st.bi ? ' jn-rowbox-cur' : ''),
        }));
        root.appendChild(T({ x: 13, y: y + ROWH / 2 + 3, class: 'jn-lab' + (on ? ' jn-lab-dim' : '') }, row.id));
        root.appendChild(T({ x: CW - 16, y: y + ROWH / 2 + 3, class: 'jn-lab-key', 'text-anchor': 'end' },
            String(row.key)));
    });

    // 哈希桶 + 冲突链
    root.appendChild(T({ x: BX, y: 20, class: 'jn-colt' }, '哈希表 · ' + nb + ' 个桶（同桶挂成冲突链）'));
    for (let b = 0; b < nb; b++) {
        const y = 34 + b * BUCKH;
        root.appendChild(svg('rect', {
            x: BX, y: y + 1, width: BLAB - 5, height: BUCKH - 4, rx: 5,
            class: 'jn-bucket' + (b === curB ? ' jn-bucket-cur' : ''),
        }));
        root.appendChild(T({ x: BX + (BLAB - 5) / 2, y: y + BUCKH / 2 + 3.5, class: 'jn-bucket-lab', 'text-anchor': 'middle' },
            '#' + b));
        chains[b].forEach((bi, c) => {
            const x = BX + BLAB + c * CHW;
            const isCmp = compared.indexOf(bi) >= 0;
            const isHit = matched.indexOf(bi) >= 0;
            root.appendChild(svg('line', {
                x1: x - 8, x2: x + 1, y1: y + BUCKH / 2, y2: y + BUCKH / 2, class: 'jn-chainlink',
            }));
            root.appendChild(svg('rect', {
                x: x + 1, y: y + 2, width: CHW - 10, height: BUCKH - 6, rx: 5,
                class: 'jn-chain' + (isHit ? ' jn-chain-hit' : (isCmp ? ' jn-chain-cmp' : '')),
            }));
            root.appendChild(T({ x: x + 8, y: y + BUCKH / 2 + 3.5, class: 'jn-chain-t' },
                build[bi].id + ':' + build[bi].key));
        });
    }

    // probe 端
    root.appendChild(T({ x: probeX, y: 20, class: 'jn-colt' },
        'probe 端 · ' + (run.side === 'left' ? '右表 S' : '左表 R') + '（大表）'));
    probe.forEach((row, pi) => {
        const y = 34 + pi * ROWH;
        const cur = st && st.kind === 'probe' && st.pi === pi;
        const done = st && st.kind === 'probe' && pi < st.pi;
        root.appendChild(svg('rect', {
            x: probeX, y: y + 1, width: CW - 8, height: ROWH - 4, rx: 5,
            class: 'jn-rowbox' + (done ? ' jn-rowbox-done' : '') + (cur ? ' jn-rowbox-cur' : ''),
        }));
        root.appendChild(T({ x: probeX + 9, y: y + ROWH / 2 + 3, class: 'jn-lab' + (done ? ' jn-lab-dim' : '') }, row.id));
        root.appendChild(T({ x: probeX + CW - 20, y: y + ROWH / 2 + 3, class: 'jn-lab-key', 'text-anchor': 'end' },
            String(row.key)));
    });

    // 当前这行 → 它落进的桶，画根线点破「只查一个桶」
    if (st && curB >= 0) {
        const by = 34 + curB * BUCKH + BUCKH / 2;
        if (inBuild) {
            const fy = 34 + st.bi * ROWH + ROWH / 2;
            root.appendChild(svg('line', { x1: CW - 2, y1: fy, x2: BX - 2, y2: by, class: 'jn-arrow' }));
        } else if (st.kind === 'probe') {
            const fy = 34 + st.pi * ROWH + ROWH / 2;
            root.appendChild(svg('line', {
                x1: probeX - 2, y1: fy, x2: BX + BLAB + Math.max(0, chains[curB].length) * CHW - 6, y2: by,
                class: 'jn-arrow',
            }));
        }
    }

    outPanel(root, probeX + CW + GAP - 8, 6, OUTW, H - 16,
        run.out.slice(0, st ? st.outN : run.out.length), st ? st.outN : run.out.length);
    return root;
}

// ---------- 主视图 C：排序归并 ----------

function buildMergeView(run) {
    const A = run.sortedR, B = run.sortedS;
    const st = curStep();
    const sorting = st && st.kind === 'sort';
    const MC = 44, LX = 84, ROWY1 = 62, ROWY2 = 156, RH = 34;
    const maxLen = Math.max(A.length, B.length);
    const W = LX + maxLen * MC + GAP + OUTW;
    const H = 224;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'jn-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '排序归并',
    });

    const i = st && st.i != null ? st.i : -1;
    const j = st && st.j != null ? st.j : -1;
    const grpKey = st && st.key != null ? st.key : null;
    const mark = st && st.mark != null ? st.mark : -1;
    const band = st && st.band != null ? st.band : -1;

    root.appendChild(T({ x: 4, y: 26, class: 'jn-colt' },
        run.presorted ? '两表已有序（上游索引扫描给的），排序成本 0' : '两表各自排序后：'));

    const row = (arr, y, label, ptr, isLeft) => {
        root.appendChild(T({ x: 4, y: y + RH / 2 + 4, class: 'jn-lab' }, label));
        arr.forEach((r, k) => {
            const x = LX + k * MC;
            const inGrp = grpKey != null && r.key === grpKey;
            const inBand = !isLeft && band >= 0 && k < band;
            const cur = (k === ptr);
            root.appendChild(svg('rect', {
                x: x + 2, y: y + 1, width: MC - 5, height: RH - 2, rx: 6,
                class: 'jn-mcell' + (inGrp ? ' jn-mcell-grp' : '') + (inBand ? ' jn-mcell-band' : '')
                    + (cur ? ' jn-mcell-cur' : ''),
            }));
            root.appendChild(T({ x: x + MC / 2 - 1, y: y + 14, class: 'jn-mkey', 'text-anchor': 'middle' },
                String(r.key)));
            root.appendChild(T({ x: x + MC / 2 - 1, y: y + 27, class: 'jn-mid', 'text-anchor': 'middle' }, r.id));
        });
    };

    row(A, ROWY1, 'R 排序后', sorting ? -1 : i, true);
    row(B, ROWY2, 'S 排序后', sorting ? -1 : j, false);

    // 指针
    if (!sorting && i >= 0 && i < A.length) {
        const x = LX + i * MC + MC / 2 - 1;
        root.appendChild(svg('path', { d: 'M' + (x - 7) + ' ' + (ROWY1 - 6) + 'L' + (x + 7) + ' ' + (ROWY1 - 6) + 'L' + x + ' ' + (ROWY1 + 2) + 'Z', class: 'jn-ptr' }));
        root.appendChild(T({ x, y: ROWY1 - 12, class: 'jn-ptr-lab', 'text-anchor': 'middle' }, 'i'));
    }
    if (!sorting && j >= 0 && j < B.length) {
        const x = LX + j * MC + MC / 2 - 1;
        root.appendChild(svg('path', { d: 'M' + (x - 7) + ' ' + (ROWY2 + RH + 6) + 'L' + (x + 7) + ' ' + (ROWY2 + RH + 6) + 'L' + x + ' ' + (ROWY2 + RH - 2) + 'Z', class: 'jn-ptr' }));
        root.appendChild(T({ x, y: ROWY2 + RH + 18, class: 'jn-ptr-lab', 'text-anchor': 'middle' }, 'j'));
    }

    // mark 线 + 回退箭头 —— 这就是重复 key 的处理方式
    if (!sorting && mark >= 0) {
        const mx = LX + mark * MC + 2;
        root.appendChild(svg('line', { x1: mx, y1: ROWY2 - 12, x2: mx, y2: ROWY2 + RH + 8, class: 'jn-markline' }));
        root.appendChild(T({ x: mx + 3, y: ROWY2 - 16, class: 'jn-mark-lab' }, 'mark'));
        if (st.act === 'rewind') {
            const fx = LX + st.from * MC + MC / 2;
            root.appendChild(svg('path', {
                d: 'M' + fx + ' ' + (ROWY2 - 8) + 'Q' + ((fx + mx) / 2) + ' ' + (ROWY2 - 34) + ' ' + (mx + 4) + ' ' + (ROWY2 - 8),
                class: 'jn-rewind',
            }));
            root.appendChild(T({ x: (fx + mx) / 2, y: ROWY2 - 30, class: 'jn-rewind-lab', 'text-anchor': 'middle' },
                '右指针回退重扫'));
        }
    }

    // 连线：正在输出的一对
    if (!sorting && st && (st.act === 'emit') && i >= 0 && j >= 0) {
        root.appendChild(svg('line', {
            x1: LX + i * MC + MC / 2 - 1, y1: ROWY1 + RH,
            x2: LX + j * MC + MC / 2 - 1, y2: ROWY2, class: 'jn-arrow',
        }));
    }

    outPanel(root, LX + maxLen * MC + GAP, 6, OUTW, H - 16,
        run.out.slice(0, st ? st.outN : run.out.length), st ? st.outN : run.out.length);
    return root;
}

function buildView(run) {
    if (!run) return h('div');
    if (state.algo === 'hash') return buildHashView(run);
    if (state.algo === 'smj') return buildMergeView(run);
    return buildMatrixView(run);
}

// ---------- 计数器 + 步骤解说 ----------

function countCell(label, val, cls) {
    return h('div.jn-count' + (cls ? '.' + cls : ''), null,
        h('span', { text: label }), h('b', { text: val }));
}

function buildCounters(run) {
    const box = h('div.jn-counters');
    const st = curStep();
    const cmp = st ? (st.cmp == null ? 0 : st.cmp) : (run && run.comparisons) || 0;
    const outN = st ? st.outN : ((run && run.out) ? run.out.length : 0);
    box.appendChild(countCell('比较 / 哈希操作次数', String(cmp), 'jn-count-big'));
    box.appendChild(countCell('已输出结果', outN + ' 行'));

    if (state.algo === 'snl') {
        box.appendChild(countCell('内表被完整扫过', (st && st.kind === 'cmp' ? st.i + 1 : run.innerScans) + ' 遍'));
        box.appendChild(countCell('最终 = M × N', state.R.length + ' × ' + state.S.length + ' = ' + run.comparisons));
    } else if (state.algo === 'bnl') {
        const b = st ? (st.block == null ? 0 : st.block) : run.blocks.length - 1;
        box.appendChild(countCell('内表被完整扫过', (b + 1) + ' / ' + run.blocks.length + ' 遍'));
        box.appendChild(countCell('比较次数（和简单版一样）', String(run.comparisons)));
    } else if (state.algo === 'hash') {
        if (!run.ok) {
            box.appendChild(countCell('可用性', '✗ 不可用'));
            box.appendChild(countCell('只能改用', '嵌套循环 / 排序归并'));
        } else {
            box.appendChild(countCell('哈希计算 M+N', String(run.hashOps)));
            box.appendChild(countCell('桶内链上比较', String(run.chainCompares) + ' 次'));
        }
    } else {
        box.appendChild(countCell('排序比较', run.sortCompares + ' 次'));
        box.appendChild(countCell('归并：指针前进 / 回退',
            run.pointerMoves + ' / ' + run.rewinds));
    }
    return box;
}

function stepNote(run) {
    if (!run) return '';
    const st = curStep();
    if (!st) {
        return run.ok === false
            ? '<b>没有可走的步骤。</b>' + Viz.esc(run.reason)
            : '<b>没有可走的步骤。</b>';
    }
    const R = state.R, S = state.S;
    const p = JN.PRED[state.pred];

    if (st.kind === 'cmp') {
        const a = R[st.i], b = S[st.j];
        const head = '<b>比较 ' + a.id + '(key=' + a.key + ') 与 ' + b.id + '(key=' + b.key + ')：</b>'
            + (st.hit ? '<span class="jn-yes">命中 ✓ 输出一行</span>' : '<span class="jn-no">不满足，跳过</span>');
        if (state.algo === 'bnl') {
            const blk = run.blocks[st.block];
            return head + '　　当前 join buffer 里装着 <code>'
                + R.slice(blk.lo, blk.hi).map((r) => r.id).join(', ')
                + '</code>。注意填格子的顺序是<b>竖着走的</b>：内表这一行读进来，就把缓冲区里几行外表一次比完，'
                + '再也不用为它们各读一遍内表。';
        }
        return head + '　　填格子的顺序是<b>横着走的</b>：外表停在 ' + a.id + ' 不动，把内表 '
            + S.length + ' 行整个扫一遍，然后外表才前进一行 —— 内表因此要被完整读 ' + R.length + ' 遍。';
    }
    if (st.kind === 'load') {
        const blk = run.blocks[st.block];
        return '<b>把外表第 ' + (st.block + 1) + ' 块读进 join buffer：</b><code>'
            + R.slice(blk.lo, blk.hi).map((r) => r.id + '(' + r.key + ')').join(', ')
            + '</code>。接下来内表<b>只会被完整扫这一遍</b>，缓冲区里这 ' + (blk.hi - blk.lo)
            + ' 行外表全靠它。buffer 越大，内表要重读的遍数越少。';
    }
    if (st.kind === 'build') {
        const row = run.build[st.bi];
        const chain = run.buckets[st.bucket].filter((x) => x <= st.bi);
        return '<b>build 阶段：</b>把 ' + row.id + '(key=' + row.key + ') 算一次哈希，落进 <code>#'
            + st.bucket + '</code> 号桶。'
            + (chain.length > 1
                ? '这个桶已经有人了 —— <b>哈希冲突</b>，挂到链尾，链长 ' + chain.length + '。'
                  + '冲突链越长，probe 时要多比几次。'
                : '桶是空的，直接放进去。')
            + '　build 表必须<b>整个装进内存</b>，这就是它必须是小表的原因。';
    }
    if (st.kind === 'probe') {
        const row = run.probe[st.pi];
        return '<b>probe 阶段：</b>' + row.id + '(key=' + row.key + ') 算一次哈希 → 直奔 <code>#'
            + st.bucket + '</code> 号桶，'
            + (st.compared.length === 0
                ? '桶是空的，<b>一次 key 比较都不用做</b>，直接判定无匹配。'
                : '链上有 ' + st.compared.length + ' 个元素，逐个比 key，命中 ' + st.matched.length + ' 个。')
            + '　<b>它没有碰过其它任何一个桶</b> —— 这就是哈希 join 把 M×N 压成 M+N 的全部秘密。';
    }
    if (st.kind === 'sort') {
        return st.skipped
            ? '<b>' + st.side + ' 表已经是有序的</b>（比如走了索引扫描），这一步<b>白送</b>，排序成本 0。'
              + '排序归并的全部成本就压在排序上，省掉它，它立刻从最贵变成最便宜。'
            : '<b>先把 ' + st.side + ' 表排序。</b>这是排序归并的大头开销：O(n log n)。'
              + '如果上游能直接给有序数据，这一步就没了。';
    }
    if (st.kind === 'merge') {
        const A = run.sortedR, B = run.sortedS;
        const a = A[st.i], b = B[st.j];
        if (st.act === 'advL') {
            return '<b>' + a.key + ' &lt; ' + b.key + '</b>　左边的 key 小 → 左指针前进。'
                + '左边这行永远不可能再匹配到后面更大的右行，直接放弃 —— 有序带来的确定性。';
        }
        if (st.act === 'advR') {
            return '<b>' + a.key + ' &gt; ' + b.key + '</b>　右边的 key 小 → 右指针前进。两个指针一共只往前走 M+N 步。';
        }
        if (st.act === 'mark') {
            return '<b>两边 key 相等（' + st.key + '），进入等值组。</b>记下右表这一段的起点 <code>mark = ' + st.mark
                + '</code>。<b>这一笔是整个算法最容易写错的地方</b> —— 没有 mark 就没法处理重复 key。';
        }
        if (st.act === 'emit') {
            return '<b>输出 ' + a.id + ' ⨝ ' + b.id + '（key=' + st.key + '）。</b>'
                + '右指针继续在这个等值组里往前扫，把这一组右行全配一遍。';
        }
        if (st.act === 'rewind') {
            return '<b>左指针进到组内下一行 ' + a.id + '，右指针从 ' + st.from + ' <span class="jn-no">回退</span>到 mark='
                + st.mark + '，把这一段重扫。</b>'
                + '为什么必须回退？因为 key 相等是<b>多对多</b>的：左边 3 行、右边 2 行就要输出 3×2=6 行。'
                + '只往前扫的双指针会漏掉一大半 —— 这就是「排序归并的指针不是单调的」这句话的真正含义。';
        }
        if (st.act === 'band') {
            return '<b>非等值也能扫：</b>' + a.id + '(key=' + a.key + ') 匹配右表前 ' + st.band + ' 行（它们的 key 都比它小）。'
                + '因为两边有序，右指针依然只往前走，不用回头 —— <b>哈希 join 在这里完全无能为力</b>。';
        }
    }
    return '';
}

// ---------- 播放 ----------

function ensureTicker() {
    if (state.tk) return state.tk;
    state.tk = Viz.ticker((dt) => {
        state.acc += dt;
        if (state.acc < 340) return true;
        state.acc = 0;
        if (state.step >= stepCount() - 1) { state.playing = false; paintStep(); return false; }
        state.step++;
        paintStep();
        return true;
    });
    return state.tk;
}

function stopPlay() {
    state.playing = false;
    if (state.tk) state.tk.stop();
    state.acc = 0;
}

function togglePlay() {
    if (state.playing) { stopPlay(); paintStep(); return; }
    if (stepCount() === 0) return;
    if (state.step >= stepCount() - 1) state.step = 0;
    state.playing = true;
    state.acc = 0;
    ensureTicker().start();
    paintStep();
}

function gotoStep(k) {
    stopPlay();
    const n = stepCount();
    state.step = Math.max(0, Math.min(n - 1, k));
    paintStep();
}

// ---------- 局部重绘（只换主视图那张卡，播放才不卡）----------

function paintStep() {
    const run = curRun();
    const n = stepCount();
    if (state.step > n - 1) state.step = Math.max(0, n - 1);
    const d = state.dom;
    if (!d.viewBox) return;
    d.viewBox.innerHTML = '';
    d.viewBox.appendChild(buildView(run));
    d.countersWrap.innerHTML = '';
    d.countersWrap.appendChild(buildCounters(run));
    d.note.innerHTML = stepNote(run);
    d.progress.textContent = n ? (state.step + 1) + ' / ' + n : '—';
    if (d.playBtn) {
        d.playBtn.innerHTML = state.playing
            ? '<i class="fas fa-pause"></i> 暂停'
            : '<i class="fas fa-play"></i> 播放';
    }
}

// ---------- 各版块 ----------

function scenarioCard() {
    const p = PRESETS[state.preset];
    const card = Viz.card('fa-table-cells', '两张小表，一个 JOIN',
        '<code>SELECT * FROM R JOIN S ON ' + JN.PRED[state.pred].label + '</code>　'
        + 'R 有 <b>' + state.m + '</b> 行，S 有 <b>' + state.n + '</b> 行。'
        + '下面四种算法跑的是<b>同一份数据、同一个条件</b>，结果集必须一模一样 —— 差的只是干了多少活。');

    const preBox = h('div.segmented');
    Object.keys(PRESETS).forEach((k) => {
        preBox.appendChild(h('button.seg' + (k === state.preset ? '.on' : ''), {
            onclick: () => {
                state.preset = k;
                state.m = PRESETS[k].m; state.n = PRESETS[k].n;
                render();
            },
        }, PRESETS[k].label));
    });
    card.appendChild(preBox);
    card.appendChild(h('p.jn-preset-note', { html: '<i class="fas fa-lightbulb"></i> ' + p.note }));

    card.appendChild(h('p.sec-note', { html: '连接条件：' }));
    card.appendChild(Viz.segmented({
        value: state.pred,
        options: [
            { v: 'eq', label: 'R.key = S.key （等值）' },
            { v: 'gt', label: 'R.key > S.key （非等值）' },
        ],
        onPick: (v) => { state.pred = v; render(); },
    }));

    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '左表 R 行数', min: 3, max: 8, step: 1, value: state.m,
        fmt: (v) => v + ' 行', onInput: (v) => { state.m = v; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: '右表 S 行数', min: 3, max: 8, step: 1, value: state.n,
        fmt: (v) => v + ' 行', onInput: (v) => { state.n = v; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: 'join buffer（装几行外表）', min: 1, max: 6, step: 1, value: state.blockRows,
        fmt: (v) => v + ' 行', onInput: (v) => { state.blockRows = v; render(); },
    }));
    card.appendChild(ctl);
    return card;
}

function mainCard() {
    const run = curRun();
    const card = Viz.card('fa-play', '主视图：一步一步看它到底比了些什么',
        '默认直接停在<b>跑完</b>的状态（所有格子都填好了）。想看过程就按「从头开始」，'
        + '再一下一下点「下一步」。角落那个大数字是<b>实时累加的比较次数</b>。');

    card.appendChild(Viz.segmented({
        value: state.algo,
        options: ALGOS.map((a) => ({ v: a.v, label: a.label })),
        onPick: (v) => { state.algo = v; state.step = Math.max(0, (state.runs[v].steps || []).length - 1); paintStep(); },
    }));

    const countersWrap = h('div.jn-cwrap');
    state.dom.countersWrap = countersWrap;
    countersWrap.appendChild(buildCounters(run));
    card.appendChild(countersWrap);

    card.appendChild(Viz.legend([
        { cls: 'k-jn-todo', text: '还没比过' },
        { cls: 'k-jn-done', text: '比过了，不匹配' },
        { cls: 'k-jn-hit', text: '命中，输出一行' },
        { cls: 'k-jn-cur', text: '当前这一步' },
    ]));

    const viewBox = h('div.jn-view');
    state.dom.viewBox = viewBox;
    viewBox.appendChild(buildView(run));
    card.appendChild(viewBox);

    const progress = h('span.seq-progress', { text: '—' });
    const playBtn = h('button.mini.primary', { onclick: togglePlay }, h('i.fas.fa-play'), ' 播放');
    state.dom.progress = progress;
    state.dom.playBtn = playBtn;

    card.appendChild(h('div.seq-nav', null,
        h('button.mini', { onclick: () => gotoStep(0) }, '⟲ 从头开始'),
        h('button.mini', { onclick: () => gotoStep(state.step - 1) }, '← 上一步'),
        progress,
        h('button.mini.primary', { onclick: () => gotoStep(state.step + 1) }, '下一步 →'),
        h('button.mini', { onclick: () => gotoStep(stepCount() - 1) }, '⏭ 走到底'),
        playBtn
    ));

    const note = h('div.seq-note');
    state.dom.note = note;
    card.appendChild(note);
    return card;
}

function resultCard() {
    const r = state.runs;
    const rows = JN.normalize(r.snl.out);
    const card = Viz.card('fa-equals', '第一件必须确认的事：四种算法结果完全一样',
        '算法只影响<b>怎么算</b>，不影响<b>算出什么</b>。谁要是快得离谱又结果不同，那不叫优化，那叫 bug。');

    const ok = r.allSame;
    card.appendChild(h('div.jn-verdict' + (ok ? '.ok' : '.bad'), {
        html: ok
            ? '<i class="fas fa-circle-check"></i> 四种算法都输出了 <b>' + rows.length + '</b> 行，逐条对齐完全一致'
              + (r.hash.ok ? '' : '（哈希 join 在非等值条件下不可用，其余三种一致）')
            : '<i class="fas fa-circle-xmark"></i> 结果不一致！',
    }));

    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '算法' }), h('th', { text: '结果行数' }),
        h('th', { text: '比较 / 哈希操作' }), h('th', { text: '内表完整扫描' }), h('th', { text: '备注' })));
    const line = (name, run, extra, scans) => {
        const tr = h('tr');
        tr.appendChild(h('td.mv-strong', { text: name }));
        tr.appendChild(h('td', { text: run && run.out ? run.out.length + ' 行' : '—' }));
        tr.appendChild(h('td', { text: run && run.ok !== false ? String(run.comparisons) : '—' }));
        tr.appendChild(h('td', { text: scans }));
        tr.appendChild(h('td', { html: extra }));
        tb.appendChild(tr);
    };
    line('简单嵌套循环', r.snl, 'M × N = ' + state.m + ' × ' + state.n + '，一次都躲不掉', state.m + ' 遍');
    line('块嵌套循环', r.bnl,
        '<b>比较次数一模一样</b>，省的是内表重读的遍数', r.bnl.blocks.length + ' 遍');
    line('哈希 Join', r.hash.ok ? r.hash : { out: null, ok: false, comparisons: 0 },
        r.hash.ok
            ? 'M+N 次哈希 + ' + r.hash.chainCompares + ' 次链上比较'
            : '<span class="jn-no">非等值条件下不可用</span>',
        r.hash.ok ? '各 1 遍' : '—');
    line('排序归并', r.smj,
        '排序 ' + r.smj.sortCompares + ' + 归并 ' + r.smj.mergeCompares
            + (r.smj.rewinds ? '，右指针回退 <b>' + r.smj.rewinds + '</b> 次' : ''),
        '各 1 遍');
    card.appendChild(h('div.mv-matrix-wrap', null, tb));

    card.appendChild(h('p.sec-note', {
        html: '结果集是一样的，但<b>输出顺序不一样</b>：简单嵌套循环按外表行序出，块嵌套按「块 → 内表行 → 块内外表行」出，'
            + '排序归并按 key 升序出。所以 <b>SQL 不写 ORDER BY 就不要指望顺序稳定</b> —— '
            + '同一条语句换个执行计划，出来的顺序就变了。',
    }));

    if (rows.length) {
        card.appendChild(h('div.jn-pairs', {
            html: rows.map((s) => '<span>' + Viz.esc(s.replace('|', ' ⨝ ')) + '</span>').join(''),
        }));
    }
    return card;
}

// ---------- 打脸时刻：规模一上去，差距从「差不多」拉成两个数量级 ----------

function buildScaleChart(cur) {
    const pts = scaleCurve();
    const W = 660, H = 272, PL = 58, PR = 122, PT = 16, PB = 36;
    const lx0 = Math.log(10) / Math.LN10, lx1 = Math.log(2000) / Math.LN10;
    const maxLog = 6.7;
    const xs = (s) => PL + ((Math.log(s) / Math.LN10) - lx0) / (lx1 - lx0) * (W - PL - PR);
    const ys = (v) => PT + (1 - (Math.log(Math.max(1, v)) / Math.LN10) / maxLog) * (H - PT - PB);

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'jn-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '比较次数随规模增长',
    });

    const yLabels = [[1e1, '10'], [1e2, '100'], [1e3, '1 千'], [1e4, '1 万'], [1e5, '10 万'], [1e6, '100 万']];
    yLabels.forEach((yl) => {
        root.appendChild(svg('line', { x1: PL, x2: W - PR, y1: ys(yl[0]), y2: ys(yl[0]), class: 'jn-grid' }));
        root.appendChild(T({ x: PL - 8, y: ys(yl[0]) + 4, class: 'jn-axis', 'text-anchor': 'end' }, yl[1]));
    });
    [10, 50, 100, 500, 1000, 2000].forEach((s) => {
        root.appendChild(T({ x: xs(s), y: H - PB + 18, class: 'jn-axis', 'text-anchor': 'middle' }, String(s)));
    });
    root.appendChild(T({ x: (PL + W - PR) / 2, y: H - 4, class: 'jn-axis-t', 'text-anchor': 'middle' },
        '两表各多少行（对数刻度）'));
    root.appendChild(T({ x: 6, y: 12, class: 'jn-axis-t' }, '比较次数（对数刻度）'));

    const path = (key, cls) => {
        let d = '';
        pts.forEach((p, k) => { d += (k ? 'L' : 'M') + xs(p.size).toFixed(1) + ' ' + ys(p[key]).toFixed(1); });
        root.appendChild(svg('path', { d, class: cls, fill: 'none' }));
    };
    path('snl', 'jn-line-snl');
    path('smj', 'jn-line-smj');
    path('hash', 'jn-line-hash');

    const last = pts[pts.length - 1];
    root.appendChild(T({ x: W - PR + 8, y: ys(last.snl) + 4, class: 'jn-lg-snl' }, '嵌套循环 M×N'));
    root.appendChild(T({ x: W - PR + 8, y: ys(last.smj) + 4, class: 'jn-lg-smj' }, '排序归并'));
    root.appendChild(T({ x: W - PR + 8, y: ys(last.hash) + 15, class: 'jn-lg-hash' }, '哈希 join'));

    // 当前规模：竖线 + 差距括号
    const x = xs(cur.m);
    const ySnl = ys(cur.snl.comparisons), yHash = ys(cur.hash.comparisons);
    root.appendChild(svg('line', { x1: x, x2: x, y1: PT, y2: H - PB, class: 'jn-marker' }));
    root.appendChild(svg('circle', { cx: x, cy: ySnl, r: 4.5, class: 'jn-dot-snl' }));
    root.appendChild(svg('circle', { cx: x, cy: yHash, r: 4.5, class: 'jn-dot-hash' }));
    root.appendChild(svg('path', {
        d: 'M' + (x - 9) + ' ' + ySnl + 'L' + (x - 16) + ' ' + ySnl + 'L' + (x - 16) + ' ' + yHash + 'L' + (x - 9) + ' ' + yHash,
        class: 'jn-gap',
    }));
    const ratio = Math.round(cur.snl.comparisons / Math.max(1, cur.hash.comparisons));
    root.appendChild(T({
        x: x - 22, y: (ySnl + yHash) / 2 + 4, class: 'jn-gap-lab', 'text-anchor': 'end',
    }, '差 ' + ratio + ' 倍'));
    return root;
}

function scaleCard() {
    const cur = scaleAt(state.scaleM);
    const ratio = Math.round(cur.snl.comparisons / Math.max(1, cur.hash.comparisons));
    const card = Viz.card('fa-bolt', '打脸时刻：同样两张表，比较次数差两个数量级',
        '上面那两张小表是六七行，四种算法看起来「差不多」。把规模拉起来，'
        + '<b>M×N 是抛物线，M+N 是直线</b> —— 差距会从「差不多」一路拉成几百上千倍。'
        + '拖滑块，盯着右边那个倍数看。');

    const btns = h('div.ctl-btns');
    [[10, '① 各 10 行：几乎没差'], [100, '② 各 100 行：一万 vs 几百'], [2000, '③ 各 2000 行：四百万 vs 几千']]
        .forEach((b) => {
            btns.appendChild(h('button.mini' + (state.scaleM === b[0] ? '.primary' : ''), {
                onclick: () => { state.scaleM = b[0]; render(); },
            }, b[1]));
        });
    const ctl = h('div.controls', null,
        Viz.slider({
            label: '两表各多少行', min: 10, max: 2000, step: 10, value: state.scaleM,
            fmt: (v) => v + ' 行', onInput: (v) => { state.scaleM = v; render(); },
        }), btns);
    card.appendChild(ctl);

    card.appendChild(Viz.cmpGrid([
        { h: '嵌套循环（简单 / 块）', v: cur.snl.comparisons.toLocaleString('en-US'), d: 'M × N 次比较', cls: 'cmp-bad' },
        { h: '哈希 Join', v: cur.hash.comparisons.toLocaleString('en-US'), d: 'M+N 次哈希 + ' + cur.hash.chain + ' 次链上比较', cls: 'cmp-ok' },
        { h: '差距', v: ratio + ' ×', d: '规模越大差得越离谱', cls: 'cmp-save' },
    ]));

    card.appendChild(h('div.jn-view', null, buildScaleChart(cur)));

    card.appendChild(h('p.sec-note', {
        html: '<b>为什么块嵌套循环没画在图上单独一条线？</b>因为它的比较次数<b>和简单嵌套循环完全相同</b>，'
            + '两条线是重合的。块嵌套省的是磁盘 I/O，不是 CPU 比较 —— 这一点下面单开一节讲。'
            + '<br>排序归并那条线在小规模时比哈希高（排序要 n log n），但增长斜率和哈希是同一档，'
            + '离 M×N 那条抛物线越来越远。',
    }));
    return card;
}

// ---------- 块嵌套的 I/O 账 ----------

function ioCard() {
    const m = state.scaleM, n = state.scaleM;
    const mp = JN.pages(m, state.rowsPerPage), np = JN.pages(n, state.rowsPerPage);
    const io = JN.pageIO(mp, np, state.bufferPages);
    const saved = io.simple > 0 ? Math.round((1 - io.block / io.simple) * 100) : 0;

    const card = Viz.card('fa-hard-drive', '块嵌套循环：一次比较也没省，却能少读几百页磁盘',
        '这是最容易被误解的一个：<b>BNL 的比较次数和简单嵌套循环一模一样，都是 M×N</b>。'
        + '它优化的是「内表被完整读取的遍数」。简单版每处理一行/一页外表就把内表整个读一遍；'
        + 'BNL 攒够一个 join buffer 才读一遍。');

    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '每页放几行', min: 2, max: 16, step: 1, value: state.rowsPerPage,
        fmt: (v) => v + ' 行/页', onInput: (v) => { state.rowsPerPage = v; state.curve = null; render(); },
    }));
    ctl.appendChild(Viz.slider({
        label: 'join buffer 装几页', min: 1, max: 12, step: 1, value: state.bufferPages,
        fmt: (v) => 'B = ' + v, onInput: (v) => { state.bufferPages = v; render(); },
    }));
    card.appendChild(ctl);

    card.appendChild(Viz.flowList([
        {
            t: '外表 / 内表各占多少页',
            f: 'M = ⌈' + m + ' 行 / ' + state.rowsPerPage + ' 行每页⌉ = ' + mp + ' 页\n'
                + 'N = ⌈' + n + ' 行 / ' + state.rowsPerPage + ' 行每页⌉ = ' + np + ' 页',
            r: '页是数据库读盘的最小单位（InnoDB 默认 16KB）',
        },
        {
            t: '简单嵌套循环（其实就是 B = 1 的块嵌套）',
            f: 'I/O = M + M × N = ' + mp + ' + ' + mp + ' × ' + np + ' = ' + io.simple + ' 页',
            r: '内表被完整读了 ' + mp + ' 遍',
        },
        {
            t: '块嵌套循环',
            f: 'I/O = M + ⌈M/B⌉ × N = ' + mp + ' + ⌈' + mp + '/' + state.bufferPages + '⌉ × ' + np
                + ' = ' + mp + ' + ' + io.passes + ' × ' + np + ' = ' + io.block + ' 页',
            r: '内表只被完整读了 ' + io.passes + ' 遍，省下 ' + saved + '% 的页读取',
            hi: 'buffer 每翻一倍，内表重读的遍数就减半。MySQL 的 <code>join_buffer_size</code> 调的就是这个 B。'
                + '但它是<b>每个 join 每个线程</b>各分一份的，调太大会直接把内存吃光。',
        },
    ]));

    card.appendChild(Viz.cmpGrid([
        { h: '简单嵌套循环', v: io.simple + ' 页', d: '内表读 ' + mp + ' 遍', cls: 'cmp-bad' },
        { h: '块嵌套循环 B=' + state.bufferPages, v: io.block + ' 页', d: '内表读 ' + io.passes + ' 遍', cls: 'cmp-ok' },
        { h: '省下', v: saved + '%', d: '的磁盘页读取', cls: 'cmp-save' },
    ]));
    card.appendChild(h('p.sec-note', {
        html: '把 join buffer 拉到 1 页试试 —— 两个数字会完全相等。'
            + '<b>「简单嵌套循环 = B 只有一页的块嵌套循环」</b>，这句话能省掉一半的记忆量。'
            + '而无论 B 多大，比较次数始终是 ' + (m * n).toLocaleString('en-US') + ' 次，一次都没少。',
    }));
    return card;
}

// ---------- 哈希 join 不是万能的 ----------

function buildPartChart(g) {
    const P = g.partitions;
    const W = 640, H = 190, PL = 46, PB = 46, PT = 26;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'jn-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '分区',
    });
    const bw = Math.min(72, (W - PL - 20) / P);
    const maxV = Math.max(g.memRows, Math.max.apply(null, g.partBuild)) * 1.15;
    const ys = (v) => H - PB - (v / maxV) * (H - PB - PT);

    root.appendChild(svg('line', { x1: PL - 8, x2: PL + P * bw + 8, y1: ys(g.memRows), y2: ys(g.memRows), class: 'jn-memline' }));
    root.appendChild(T({ x: PL - 12, y: ys(g.memRows) + 4, class: 'jn-mem-lab', 'text-anchor': 'end' }, '内存上限'));
    root.appendChild(T({ x: PL + P * bw + 12, y: ys(g.memRows) + 4, class: 'jn-mem-lab' }, g.memRows + ' 行'));

    g.partBuild.forEach((v, p) => {
        const x = PL + p * bw;
        const over = v > g.memRows;
        root.appendChild(svg('rect', {
            x: x + 4, y: ys(v), width: bw - 8, height: H - PB - ys(v), rx: 4,
            class: 'jn-part' + (over ? ' jn-part-over' : ''),
        }));
        root.appendChild(T({ x: x + bw / 2, y: ys(v) - 5, class: 'jn-part-v', 'text-anchor': 'middle' }, String(v)));
        if (P <= 12) {
            root.appendChild(T({ x: x + bw / 2, y: H - PB + 15, class: 'jn-axis', 'text-anchor': 'middle' }, 'P' + p));
        }
    });
    root.appendChild(svg('line', { x1: PL - 8, x2: PL + P * bw + 8, y1: H - PB, y2: H - PB, class: 'jn-axisline' }));
    root.appendChild(T({ x: PL - 8, y: 16, class: 'jn-axis-t' },
        P === 1 ? 'build 端整个装进内存，一趟搞定' : 'build 端被切成 ' + P + ' 个分区，一个个读回来做'));
    root.appendChild(T({ x: (PL + P * bw) / 2, y: H - 8, class: 'jn-axis', 'text-anchor': 'middle' },
        '每个柱子 = 一个分区里的 build 行数'));
    return root;
}

function hashLimitCard() {
    // 这一节故意把右表放大到 2 倍，好看清 build 端选错的后果
    const m = state.scaleM, n = state.scaleM * 2;
    const R = JN.makeTable('R', m, { keyMax: m * 4, seed: 11 });
    const S = JN.makeTable('S', n, { keyMax: m * 4, seed: 102 });
    const buildRows = state.buildSide === 'right' ? n : (state.buildSide === 'left' ? m : Math.min(m, n));
    const memRows = Math.max(1, Math.round(m * state.memPct / 100));
    const g = JN.graceHashJoin(R, S, {
        buildSide: state.buildSide, memRows, rowsPerPage: state.rowsPerPage,
    });

    const card = Viz.card('fa-triangle-exclamation', '反直觉之二：哈希 Join 不是万能的',
        '它有两条硬约束，面试和线上事故都栽在这两条上：'
        + '<b>① build 端必须装进内存；② 只能做等值连接。</b>');

    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '内存够装小表的百分之几', min: 10, max: 130, step: 5, value: state.memPct,
        fmt: (v) => v + '%', onInput: (v) => { state.memPct = v; render(); },
    }));
    card.appendChild(h('p.sec-note', {
        html: '这一节把右表放大到左表的 <b>2 倍</b>（R = ' + m + ' 行，S = ' + n + ' 行），'
            + '好看清 build 端选错的后果。谁做 build 端：',
    }));
    card.appendChild(Viz.segmented({
        value: state.buildSide,
        options: [
            { v: 'auto', label: '自动（挑小表）✓' },
            { v: 'left', label: '强制用左表 R' },
            { v: 'right', label: '强制用大表 S ✗' },
        ],
        onPick: (v) => { state.buildSide = v; render(); },
    }));
    card.appendChild(ctl);

    card.appendChild(Viz.cmpGrid([
        { h: 'build 端行数', v: String(buildRows), d: g.side === 'left' ? '用的是左表 R' : '用的是右表 S',
            cls: g.fits ? 'cmp-ok' : 'cmp-bad' },
        { h: '要分几个分区', v: String(g.partitions),
            d: g.fits ? '装得下，纯内存一趟' : 'Grace Hash：溢写磁盘', cls: g.fits ? 'cmp-ok' : 'cmp-bad' },
        { h: '额外磁盘 I/O', v: '+' + g.extraIO + ' 页',
            d: g.fits ? '没有额外开销' : '两张表各写一遍再读一遍', cls: g.fits ? 'cmp-ok' : 'cmp-bad' },
    ]));

    card.appendChild(h('div.jn-view', null, buildPartChart(g)));

    if (!g.fits) {
        card.appendChild(h('div.jn-verdict.bad', {
            html: '<i class="fas fa-bolt"></i> <b>性能断崖：</b>build 端 ' + g.buildRows + ' 行装不进 '
                + g.memRows + ' 行的内存 → 触发 <b>Grace Hash Join</b>：'
                + '先按 key 哈希把两张表都切成 <b>' + g.partitions + '</b> 份写到临时文件，'
                + '再一份一份读回来 join。多出来的 <b>' + g.extraIO + ' 页</b> I/O 全是白花的 ——'
                + '原本 ' + g.baseIO + ' 页就能读完，现在要 ' + (g.baseIO + g.extraIO) + ' 页。'
                + (g.skew
                    ? '<br><b>更糟的是：</b>最大的分区还有 ' + g.maxPartBuild + ' 行，<b>仍然装不下</b> —— '
                      + '数据倾斜时得<b>递归再分一层</b>，I/O 再翻一倍。这就是「哈希 join 遇到倾斜键会毒发」的由来。'
                    : ''),
        }));
    } else {
        card.appendChild(h('div.jn-verdict.ok', {
            html: '<i class="fas fa-circle-check"></i> build 端 ' + g.buildRows + ' 行装得进 ' + g.memRows
                + ' 行的内存，纯内存一趟跑完，零额外 I/O。'
                + '把内存滑块往左拉，或者把 build 端强制换成大表，看看断崖长什么样。',
        }));
    }

    card.appendChild(h('p.sec-note', {
        html: '<b>第二条硬约束：只能等值。</b>桶是按哈希值分的，而哈希值和 key 的大小关系没有任何联系。'
            + '<code>R.key &gt; S.key</code>、<code>BETWEEN</code>、<code>LIKE</code> 这类条件，'
            + '你根本不知道该去翻哪个桶。',
    }));
    card.appendChild(h('div.ctl-btns', null,
        h('button.mini' + (state.pred === 'gt' ? '.primary' : ''), {
            onclick: () => { state.pred = 'gt'; state.algo = 'hash'; render(); },
        }, '把连接条件换成非等值，再看一眼哈希 join'),
        h('button.mini', {
            onclick: () => { state.pred = 'eq'; render(); },
        }, '换回等值')
    ));
    return card;
}

// ---------- 排序归并的隐藏优势 ----------

function sortMergeCard() {
    const t = scaleTables(state.scaleM);
    const cold = JN.costModel(t.R, t.S, { rowsPerPage: state.rowsPerPage, presorted: false });
    const warm = JN.costModel(t.R, t.S, { rowsPerPage: state.rowsPerPage, presorted: true });
    const cur = state.presorted ? warm : cold;

    const card = Viz.card('fa-arrow-down-a-z', '反直觉之三：排序归并的成本可以直接塌成 0',
        '排序归并平时打不过哈希，因为它得先花 O(M log M + N log N) 排序。'
        + '<b>但如果两表本来就是有序的</b>（都走了索引扫描，或者上游算子已经排好了），'
        + '这笔钱一分不用出，它立刻变成最便宜的那个。');

    card.appendChild(Viz.segmented({
        value: state.presorted ? 'yes' : 'no',
        options: [
            { v: 'no', label: '两表都要现排' },
            { v: 'yes', label: '两表已有序（走索引扫描）' },
        ],
        onPick: (v) => { state.presorted = (v === 'yes'); render(); },
    }));

    card.appendChild(Viz.cmpGrid([
        { h: '排序阶段', v: cur.smj.sort.toLocaleString('en-US'), d: state.presorted ? '白送，一次比较都不用' : '这就是它平时的短板',
            cls: state.presorted ? 'cmp-ok' : 'cmp-bad' },
        { h: '归并阶段', v: cur.smj.merge.toLocaleString('en-US'), d: '双指针，O(M+N)', cls: 'cmp-ok' },
        { h: '总计 vs 哈希 join', v: cur.smj.comparisons.toLocaleString('en-US') + ' / ' + cur.hash.comparisons.toLocaleString('en-US'),
            d: cur.smj.comparisons <= cur.hash.comparisons ? '排序归并反超' : '哈希仍然领先', cls: 'cmp-save' },
    ]));

    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null, h('th', { text: '' }), h('th', { text: '要现排' }),
        h('th', { text: '已有序' }), h('th', { text: '差别' })));
    const row = (name, a, b) => {
        const tr = h('tr');
        tr.appendChild(h('td.mv-strong', { text: name }));
        tr.appendChild(h('td', { text: a.toLocaleString('en-US') }));
        tr.appendChild(h('td.ok', { text: b.toLocaleString('en-US') }));
        tr.appendChild(h('td', { text: a === b ? '一样' : '省掉 ' + (a - b).toLocaleString('en-US') }));
        tb.appendChild(tr);
    };
    row('比较次数', cold.smj.comparisons, warm.smj.comparisons);
    row('磁盘 I/O（页）', cold.smj.io, warm.smj.io);
    card.appendChild(h('div.mv-matrix-wrap', null, tb));

    card.appendChild(h('p.sec-note', {
        html: '<b>还有一笔白赚的：排序归并的输出天然按 join key 有序。</b>'
            + '如果上层还有 <code>ORDER BY key</code>、<code>GROUP BY key</code>，或者要再跟第三张表做一次 merge join，'
            + '这个顺序可以直接被复用，<b>省掉上层的一次排序</b>。哈希 join 的输出是乱的，上层想要顺序就得自己再排一遍。'
            + '<br>这就是优化器为什么非要看「有没有可用的有序索引」—— 它决定的不只是这一个算子的成本，'
            + '还有上面一整串算子的成本。',
    }));
    return card;
}

// ---------- 问答 / 坑 / 脚注 ----------

function qaCard() {
    return Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        {
            q: 'MySQL 8.0 之前为什么只有 BNL，没有 Hash Join？',
            a: '历史包袱 + 场景假设。MySQL 是<b>面向 OLTP</b> 设计的：绝大多数 join 都走主键或二级索引，'
                + '走的是 <b>Index Nested Loop</b>（索引嵌套循环），根本轮不到哈希。'
                + '只有在<b>连接列上没有可用索引</b>时才会退化，而这在 OLTP 里被视为「SQL 写错了，去加索引」而不是「引擎该优化」。'
                + '于是官方长期只提供了 BNL 这个兜底方案。'
                + '<b>MySQL 8.0.18 起加入 Hash Join</b>，8.0.20 起 BNL 基本被 Hash Join 取代 —— '
                + '因为分析型查询越来越多，大表无索引 join 变成了真实需求。'
                + 'PostgreSQL / Oracle / SQL Server 一直都有，它们从一开始就要面对 OLAP 场景。',
        },
        {
            q: '为什么 EXPLAIN 里看到 Using join buffer (Block Nested Loop) 是个警告信号？',
            a: '因为它等于在说：<b>「这个 join 的连接列上没有可用索引，我只能全表暴力比」</b>。'
                + '比较次数是实打实的 M×N —— 两张 10 万行的表就是 100 亿次。'
                + 'BNL 只是让 I/O 别那么惨，CPU 那一份钱一分没省。'
                + '<b>正确的反应不是去调大 <code>join_buffer_size</code>，而是去连接列上加索引</b>，'
                + '让它变成 Index Nested Loop（<code>eq_ref</code> / <code>ref</code>）。'
                + '8.0.20 之后你更可能看到 <code>Using join buffer (hash join)</code>，那个可以接受得多，但同样说明没索引。',
        },
        {
            q: '驱动表（外表）怎么选？',
            a: '一句话：<b>小表驱动大表</b>，但「小」指的是<b>过滤之后的结果集</b>，不是表的总行数。'
                + '① <b>嵌套循环</b>：外表每一行都要触发一次内表查找，所以外表结果集越小越好；'
                + '内表则要有索引（否则退化成 BNL）。'
                + '② <b>哈希 join</b>：小表做 build 端（要装进内存），大表做 probe 端。'
                + '③ <b>排序归并</b>：两边对称，谁驱动都一样。'
                + '优化器靠<b>统计信息</b>估算过滤后的行数来决定 —— 统计信息过期，它就会选错，'
                + '这也是 <code>ANALYZE TABLE</code> 和 <code>STRAIGHT_JOIN</code> 存在的意义。',
        },
        {
            q: 'Hash Join 怎么做 Semi Join / Anti Join？',
            a: '几乎不用改，只改「命中之后干什么」：'
                + '<b>Semi Join</b>（<code>EXISTS</code> / <code>IN</code>）：'
                + 'probe 行在桶里<b>找到第一个匹配就立刻停</b>，输出这一行本身，不做笛卡尔展开 —— '
                + '所以它天然不会因为右表有重复而放大行数（这正是 <code>IN</code> 比 <code>JOIN</code> 安全的地方）。'
                + '<b>Anti Join</b>（<code>NOT EXISTS</code>）：反过来，<b>整条链都没匹配才输出</b>。'
                + '这里有个经典坑：<code>NOT IN</code> 遇到子查询里的 <code>NULL</code> 会整体返回空，'
                + '而 <code>NOT EXISTS</code> 不会 —— 所以生产上一律用 <code>NOT EXISTS</code>。'
                + '另外 build 端还可以顺手去重，进一步缩小内存占用。',
        },
        {
            q: '既然哈希这么快，为什么线上大部分 join 还是嵌套循环？',
            a: '因为线上大部分 join <b>只取几十行</b>。<b>Index Nested Loop</b> 的成本是'
                + '「外表结果集行数 × 一次索引查找（B+ 树 3~4 次 I/O，还基本都在 buffer pool 里命中）」，'
                + '外表过滤完只剩 10 行时，总成本就是 30~40 次内存访问。'
                + '而哈希 join 无论结果多小，<b>都得先把整张 build 表扫一遍建哈希表</b>，起步价就很贵。'
                + '一句话：<b>小结果集用索引嵌套循环，大结果集 + 无索引才用哈希。</b>'
                + '这也是为什么给 join 列加索引往往比调任何参数都有效。',
        },
    ]));
}

function pitfallsCard() {
    return Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls([
        ['块嵌套循环不减少比较次数，一次都不减',
            '它把内表的<b>完整扫描遍数</b>从 M 降到 ⌈M/B⌉，省的是 I/O。'
            + 'CPU 那边照样要做 M×N 次比较。所以看到 <code>Using join buffer (Block Nested Loop)</code> 就去加索引，'
            + '别指望调大 <code>join_buffer_size</code> 能救命 —— 它只能让「很慢」变成「稍微没那么慢」。'],
        ['哈希 Join 只能等值，而且 build 端放不下就断崖',
            '① 非等值（<code>&gt;</code>、<code>BETWEEN</code>、范围）它做不了，只能回退嵌套循环或排序归并。'
            + '② build 端超内存就触发 <b>Grace Hash</b>：两张表都要写到临时文件再读回来，I/O 直接翻几倍。'
            + '③ 更阴的是<b>数据倾斜</b>：某个 key 占了半张表，分区之后那一个分区还是塞不下，'
            + '要递归再分 —— 表现就是「99% 的分区秒完，卡在最后一个上」。'],
        ['build 端选错，内存直接爆',
            '哈希 join 必须<b>小表做 build</b>。优化器靠统计信息判断谁小，'
            + '统计信息过期（大批量导入后没 <code>ANALYZE</code>）就可能把大表当成 build 端，'
            + '内存瞬间打满或者疯狂溢写磁盘。上面那个「强制用大表」的开关就是在演这件事。'],
        ['排序归并的双指针不是单调的',
            '遇到重复 key 时，<b>右指针必须回退到这一组的起点重扫</b>，因为等值匹配是多对多的：'
            + '左边 3 行 key=5、右边 2 行 key=5 → 必须输出 3×2 = 6 行。'
            + '手写归并 join 时漏掉这个 mark/rewind，是最常见的 bug —— 表现是「大部分数据对，'
            + '但重复 key 的行少了」，测试数据没重复的话根本发现不了。'],
        ['join 的输出顺序不保证，永远别依赖它',
            '同一份数据，简单嵌套循环按外表行序出、块嵌套按块序出、排序归并按 key 升序出、哈希按 probe 行序出。'
            + '换个执行计划顺序就变了。<b>要顺序就写 <code>ORDER BY</code></b>，'
            + '而且要意识到：如果计划恰好是排序归并，这个 ORDER BY 是免费的；如果是哈希，它是一笔真实开销。'],
        ['「小表驱动大表」说的是过滤后的行数',
            '不是 <code>COUNT(*)</code>。一张 1000 万行的表加上 <code>WHERE id = 42</code> 之后只有 1 行，'
            + '它才是那个「小表」。优化器判断依据是统计信息里的选择率估算，'
            + '估错了就会选错驱动表 —— 这时 <code>ANALYZE TABLE</code> 通常比改 SQL 更有效。'],
    ]));
}

function footCard() {
    return h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示的口径和简化' }),
        h('p', {
            html: '<b>「比较次数」是逻辑比较，不是 CPU 周期。</b>一次哈希计算和一次整数比较在这里都记 1，'
                + '真实机器上它们的代价并不相等（哈希更贵，但缓存友好；而 M×N 的嵌套循环虽然每次便宜，'
                + '架不住次数是平方级）。所以这个数字用来<b>比数量级</b>是对的，用来算绝对耗时是不对的。',
        }),
        h('p', {
            html: '<b>哈希 join 的计数口径</b>：build 行数 + probe 行数（每行算一次哈希）+ 桶内冲突链上的逐个 key 比较。'
                + '哈希表按 build 行数的 2 倍取 2 的幂做桶数（装载因子约 0.5），主视图里为了让冲突链可见，'
                + '故意把桶数压到了 5 个。',
        }),
        h('p', {
            html: '<b>I/O 模型按页计数，只数「读」不数「写」</b>：'
                + '简单嵌套 = M + M×N，块嵌套 = M + ⌈M/B⌉×N，M/N 是页数、B 是 join buffer 的页数。'
                + '真实系统还有预读、buffer pool 命中、顺序读比随机读快好几倍等等，全都没建模。'
                + 'Grace Hash 的额外 I/O 按「两张表各写一遍再读一遍」估。',
        }),
        h('p', {
            html: '<b>没有建模的东西</b>：并行 join（现代数据库会把分区分给多个线程）、'
                + '半连接/反连接的提前退出、优化器的代价估算本身。'
                + '<br><b>还有一个重要遗漏：Index Nested Loop（索引嵌套循环）。</b>'
                + '它是「内表连接列上有索引」时的嵌套循环 —— 内层不再是全扫，而是走 B+ 树查找（3~4 次 I/O）。'
                + '成本 ≈ 外表结果行数 × 一次索引查找，<b>在小结果集时反而是全场最快的</b>，'
                + '也是 OLTP 线上最常见的 join 方式。本演示只讨论「连接列上没有索引」的那几种，'
                + '否则四个算法根本不在一个赛道上。',
        }),
        h('p', {
            html: '所有数据都由固定种子的线性同余伪随机生成，<b>不用 <code>Math.random()</code></b> —— '
                + '刷新前后完全一样，四种算法才谈得上严格对照。',
        })
    );
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    stopPlay();
    compute();
    // 默认停在跑完的状态：不播动画也是完整可读的
    state.step = Math.max(0, stepCount() - 1);
    rootEl.innerHTML = '';
    state.dom = {};

    rootEl.appendChild(scenarioCard());
    rootEl.appendChild(mainCard());
    rootEl.appendChild(resultCard());
    rootEl.appendChild(scaleCard());
    rootEl.appendChild(ioCard());
    rootEl.appendChild(hashLimitCard());
    rootEl.appendChild(sortMergeCard());
    rootEl.appendChild(qaCard());
    rootEl.appendChild(pitfallsCard());
    rootEl.appendChild(footCard());

    paintStep();
}

Viz.register({
    id: 'join-algorithms',
    cat: 'db',
    title: 'Join 算法',
    subtitle: '嵌套循环 / 哈希 / 排序归并',
    icon: 'fa-code-branch',
    blurb: '同样两张表，四种 join 算法的比较次数能差两个数量级',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.preset = 'normal'; state.m = 6; state.n = 5; state.pred = 'eq';
        state.blockRows = 2; state.algo = 'snl'; state.step = 0;
        state.scaleM = 100; state.rowsPerPage = 4; state.bufferPages = 2;
        state.memPct = 100; state.buildSide = 'auto'; state.presorted = false;
        state.curve = null;
        render();
    },
    unmount() {
        stopPlay();
        state.tk = null;
        state.dom = {};
        state.runs = null;
        state.curve = null;
        rootEl = null;
    },
});

})();
