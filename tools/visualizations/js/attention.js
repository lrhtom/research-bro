// ============================================================
//  演示：Self-Attention 与 KV Cache
//  用一个小到能手算的例子（5 个 token、d_model = d_k = 4、单头）
//  把 QKᵀ → /√d_k → 因果掩码 → 逐行 softmax → ×V 整条路走一遍；
//  再并排演示自回归解码时「开不开 KV Cache」的计算量差别，
//  最后用显存计算器捅破另一面：KV Cache 省了算力，却能把显存吃爆。
//  上半 AT.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const AT = {};

AT.D_MODEL = 4;
AT.D_K = 4;

// 一句中文短句当作 token 序列。数字全部写死，方便读者自己拿笔验算。
AT.TOKENS = ['我', '爱', '吃', '苹果', '。'];

// token embedding（5×4）—— 真实模型里这是查表得到的，这里直接编成 0/1
AT.EMB = [
    [1, 0, 1, 0],   // 我
    [0, 1, 1, 0],   // 爱
    [1, 1, 0, 0],   // 吃
    [0, 1, 0, 1],   // 苹果
    [1, 0, 0, 1],   // 。
];

// 三个投影矩阵（4×4）—— 同样是编的小整数，不是任何真实模型的参数
AT.WQ = [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
    [1, 1, 0, 0],
    [0, 0, 1, 1],
];

AT.WK = [
    [0, 1, 2, 0],
    [1, 0, 0, 1],
    [0, 1, 0, 1],
    [1, 0, 1, 0],
];

AT.WV = [
    [2, 0, 1, 0],
    [0, 1, 0, 1],
    [1, 0, 2, 0],
    [0, 1, 1, 1],
];

// ---- 基础线性代数 ----

AT.dot = function (a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
};

/** 行向量 × 矩阵 */
AT.vecMat = function (v, M) {
    const cols = M[0].length;
    const out = new Array(cols).fill(0);
    for (let j = 0; j < cols; j++) {
        let s = 0;
        for (let i = 0; i < v.length; i++) s += v[i] * M[i][j];
        out[j] = s;
    }
    return out;
};

AT.matmul = function (A, B) {
    const n = A.length, m = B[0].length, kk = B.length;
    const out = [];
    for (let i = 0; i < n; i++) {
        const row = new Array(m).fill(0);
        for (let j = 0; j < m; j++) {
            let s = 0;
            for (let k = 0; k < kk; k++) s += A[i][k] * B[k][j];
            row[j] = s;
        }
        out.push(row);
    }
    return out;
};

AT.transpose = function (M) {
    const out = [];
    for (let j = 0; j < M[0].length; j++) {
        const row = [];
        for (let i = 0; i < M.length; i++) row.push(M[i][j]);
        out.push(row);
    }
    return out;
};

AT.scaleMat = function (M, f) {
    return M.map((r) => r.map((v) => v * f));
};

/** 因果掩码：j > i（未来的 token）置成 -∞，softmax 之后自然变 0 */
AT.causal = function (M) {
    return M.map((r, i) => r.map((v, j) => (j > i ? -Infinity : v)));
};

/**
 * 数值稳定的 softmax。
 * 必须先减去这一行的最大值 —— 否则输入稍大（比如 1000）exp 就溢出成 Infinity，
 * Infinity / Infinity = NaN，整个前向直接烂掉。
 * -Infinity（被掩码的位置）单独处理成权重 0，不让它进 exp。
 */
AT.softmax = function (row) {
    let mx = -Infinity;
    for (let i = 0; i < row.length; i++) if (row[i] > mx) mx = row[i];
    // 整行都是 -∞（理论上不会发生，防御一下）：均匀分布，别返回 NaN
    if (!isFinite(mx)) return row.map(() => (row.length ? 1 / row.length : 0));
    let sum = 0;
    const ex = row.map((v) => {
        if (v === -Infinity) return 0;
        const e = Math.exp(v - mx);
        sum += e;
        return e;
    });
    return ex.map((e) => e / sum);
};

/**
 * 一次完整的前向（并行版 / prefill 版）：整个序列一起算。
 * 返回中间每一步的矩阵，界面就是照着这些一步步画的。
 */
AT.forward = function (n) {
    n = (n == null ? AT.TOKENS.length : n);
    const E = AT.EMB.slice(0, n);
    const Q = AT.matmul(E, AT.WQ);
    const K = AT.matmul(E, AT.WK);
    const V = AT.matmul(E, AT.WV);
    const scores = AT.matmul(Q, AT.transpose(K));          // QKᵀ
    const scaled = AT.scaleMat(scores, 1 / Math.sqrt(AT.D_K));
    const masked = AT.causal(scaled);
    const weights = masked.map((r) => AT.softmax(r));
    const out = AT.matmul(weights, V);
    return { n, E, Q, K, V, scores, scaled, masked, weights, out };
};

/**
 * 自回归解码 + KV Cache（增量版 / decode 版）。
 * 每步只做三件事：算新 token 的 q/k/v → 把 k、v 追加进缓存 →
 * 新 q 对缓存里所有 K 点积（只有 t 个），softmax，再对 V 加权求和。
 * 注意这里**根本没有掩码这一步** —— 缓存里压根没有未来的 K，因果性天然成立。
 */
AT.decodeAll = function (n) {
    n = (n == null ? AT.TOKENS.length : n);
    const cacheK = [], cacheV = [], steps = [], out = [];
    for (let t = 0; t < n; t++) {
        const e = AT.EMB[t];
        const q = AT.vecMat(e, AT.WQ);
        const k = AT.vecMat(e, AT.WK);
        const v = AT.vecMat(e, AT.WV);
        cacheK.push(k);
        cacheV.push(v);

        const row = [];
        for (let j = 0; j <= t; j++) row.push(AT.dot(q, cacheK[j]) / Math.sqrt(AT.D_K));
        const w = AT.softmax(row);

        const o = new Array(cacheV[0].length).fill(0);
        for (let j = 0; j <= t; j++) {
            for (let d = 0; d < o.length; d++) o[d] += w[j] * cacheV[j][d];
        }
        out.push(o);
        steps.push({
            t: t + 1, token: AT.TOKENS[t], q, k, v,
            scores: row.slice(), weights: w.slice(), out: o.slice(),
            dots: t + 1, cacheRows: t + 1,
        });
    }
    return { out, steps, K: cacheK, V: cacheV };
};

// ---- 计算量 ----

/**
 * 数「QKᵀ 里做了多少次点积」。口径写死如下：
 *   不开缓存：第 t 步把整个序列重新喂一遍，算满 t×t 个分数 → t²
 *             （其中上三角 t(t-1)/2 个算完立刻被掩码扔掉，纯浪费）
 *   开缓存　：第 t 步只算新 query 对 t 个 K 的点积 → t
 * 累计到 n 步分别是 Σt² = n(n+1)(2n+1)/6 ≈ n³/3 和 Σt = n(n+1)/2 ≈ n²/2。
 */
AT.costs = function (n) {
    const steps = [];
    let cumNo = 0, cumKv = 0;
    for (let t = 1; t <= n; t++) {
        const no = t * t, kv = t;
        const waste = (t * (t - 1)) / 2;
        cumNo += no;
        cumKv += kv;
        steps.push({ t, no, kv, waste, cumNo, cumKv });
    }
    return {
        n, steps, cumNo, cumKv,
        closedNo: (n * (n + 1) * (2 * n + 1)) / 6,
        closedKv: (n * (n + 1)) / 2,
        ratio: cumKv > 0 ? cumNo / cumKv : 0,
    };
};

// ---- 缩放的必要性：同一组关系放到不同 d_k 下 ----

/**
 * 点积的方差随 d_k 线性增长，标准差 ∝ √d_k。
 * 把 d_k=4 下的一行原始分数按 √(dk/4) 放大，就是「同样的关系搬到 d_k 维」的样子。
 * 不缩放 → softmax 被推到饱和区（几乎 one-hot），梯度趋近 0；
 * 除以 √dk → 恰好还原成 d_k=4 时的分布，跟维度无关。
 */
AT.scaleDemo = function (rawRow, dk) {
    const grown = rawRow.map((v) => v * Math.sqrt(dk / AT.D_K));
    return {
        dk, grown,
        noScale: AT.softmax(grown),
        withScale: AT.softmax(grown.map((v) => v / Math.sqrt(dk))),
    };
};

// ---- 显存 ----

AT.DTYPES = [
    { id: 'fp16', name: 'FP16 / BF16', bytes: 2 },
    { id: 'fp8', name: 'FP8 量化', bytes: 1 },
    { id: 'int4', name: 'INT4 量化', bytes: 0.5 },
];

AT.MODELS = [
    { id: 'llama3-8b', name: 'Llama-3-8B', attn: 'GQA', layers: 32, qHeads: 32, kvHeads: 8, dHead: 128, params: 8.03e9 },
    { id: 'llama2-7b', name: 'Llama-2-7B', attn: 'MHA', layers: 32, qHeads: 32, kvHeads: 32, dHead: 128, params: 6.74e9 },
    { id: 'mistral-7b', name: 'Mistral-7B', attn: 'GQA', layers: 32, qHeads: 32, kvHeads: 8, dHead: 128, params: 7.24e9 },
    { id: 'llama3-70b', name: 'Llama-3-70B', attn: 'GQA', layers: 80, qHeads: 64, kvHeads: 8, dHead: 128, params: 70.6e9 },
];

/**
 * KV Cache 显存 = 2(K 和 V) × layers × kvHeads × dHead × seqLen × batch × dtype字节数
 * 注意 kvHeads 是「KV 头数」不是 query 头数 —— GQA/MQA 砍的正是这一项。
 */
AT.kvBytes = function (o) {
    return 2 * o.layers * o.kvHeads * o.dHead * o.seqLen * o.batch * o.dtypeBytes;
};

/** 权重按 FP16 算（推理最常见），只是给 KV Cache 一个参照物 */
AT.weightBytes = function (params, bytesPerParam) {
    return params * (bytesPerParam == null ? 2 : bytesPerParam);
};

/**
 * 极粗的访存上限估算：decode 每生成一个 token，至少要把权重读一遍、
 * 把整个 KV Cache 读一遍。一个 batch 共享权重读取，产出 batch 个 token。
 * 忽略 cache 命中、算子融合、overlap，只用来说明「decode 是访存瓶颈」。
 */
AT.roofline = function (o) {
    const bytesPerStep = o.weightBytes + o.kvBytes;
    return {
        bytesPerStep,
        tokPerSec: bytesPerStep > 0 ? (o.batch * o.bandwidth) / bytesPerStep : 0,
    };
};

AT.fmtGiB = function (bytes) {
    const gib = bytes / (1024 * 1024 * 1024);
    if (gib >= 1024) return (gib / 1024).toFixed(2) + ' TiB';
    if (gib >= 100) return gib.toFixed(0) + ' GiB';
    if (gib >= 10) return gib.toFixed(1) + ' GiB';
    if (gib >= 1) return gib.toFixed(2) + ' GiB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
};

if (typeof module !== 'undefined' && module.exports) module.exports = AT;
if (typeof window !== 'undefined') window.ATModel = AT;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const SEQS = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
const BATCHES = [1, 2, 4, 8, 16, 32, 64, 128];
const HBM = 3.35e12;          // H100 SXM 的 HBM 带宽，约 3.35 TB/s

const state = {
    step: 6,          // 主视图 A 走到第几步（默认走完，页面一打开就是完整结果）
    pick: 3,          // 展开哪一行的加权求和（默认「苹果」）
    kvN: 8,           // KV Cache 演示的序列长度
    kvT: 8,           // 走到第几个解码步（默认走完）
    model: 'llama3-8b',
    layers: 32, kvHeads: 8, dHead: 128, params: 8.03e9, attn: 'GQA',
    seqIdx: 4,        // 8192
    batchIdx: 0,      // 1
    dtype: 'fp16',
};

const dom = {};
let rootEl = null;
let uid = 0;

// ---------- 小工具 ----------

function fmtInt(v) {
    return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtBig(v) {
    if (v >= 1e12) return (v / 1e12).toFixed(2) + ' 万亿';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
    return fmtInt(v);
}

/** 热力图配色：浅靛蓝 → 深靛蓝 */
function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const a = [238, 242, 255], b = [55, 48, 163];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ','
        + Math.round(a[1] + (b[1] - a[1]) * t) + ','
        + Math.round(a[2] + (b[2] - a[2]) * t) + ')';
}

// ---------- 普通小矩阵（HTML 网格）----------

/** opt = { cap, capHtml, rowLabels, colLabels, fmt, hi:[i,j], hiRow } */
function matEl(M, opt) {
    opt = opt || {};
    const cols = M[0].length;
    const fmt = opt.fmt || ((v) => String(v));
    const box = h('div.at-mat-box');
    if (opt.capHtml) box.appendChild(h('div.at-mat-cap', { html: opt.capHtml }));
    else if (opt.cap) box.appendChild(h('div.at-mat-cap', { text: opt.cap }));

    const grid = h('div.at-mat');
    grid.style.gridTemplateColumns = (opt.rowLabels ? 'auto ' : '') + 'repeat(' + cols + ', minmax(34px, 1fr))';

    if (opt.colLabels) {
        if (opt.rowLabels) grid.appendChild(h('span.at-corner'));
        opt.colLabels.forEach((c) => grid.appendChild(h('span.at-collab', { text: c })));
    }
    M.forEach((row, i) => {
        if (opt.rowLabels) grid.appendChild(h('span.at-rowlab', { text: opt.rowLabels[i] }));
        row.forEach((v, j) => {
            const on = (opt.hiRow === i) || (opt.hi && opt.hi[0] === i && opt.hi[1] === j);
            grid.appendChild(h('span.at-cell' + (on ? '.on' : ''), { text: fmt(v) }));
        });
    });
    box.appendChild(grid);
    if (opt.note) box.appendChild(h('div.at-mat-note', { html: opt.note }));
    return box;
}

// ---------- 热力图（SVG，本演示的视觉主体）----------

/**
 * opt = { fmt, zeroBase, rowSum, colLabels, rowLabels, sel, onRow, cell, label }
 * 值为 -Infinity 的格子画成斜纹 + 「−∞」。
 */
function heatSvg(M, opt) {
    opt = opt || {};
    const n = M.length, m = M[0].length;
    const CELL = opt.cell || 46;
    const PL = 58, PT = 26, PB = 10;
    const PR = opt.rowSum ? 76 : 12;
    const W = PL + m * CELL + PR;
    const H = PT + n * CELL + PB;
    const fmt = opt.fmt || ((v) => String(v));
    const pid = 'at-mask-' + (++uid);

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'at-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': opt.label || '注意力矩阵热力图',
    });

    // 掩码格子的斜纹底
    const pat = svg('pattern', {
        id: pid, width: 6, height: 6,
        patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
    });
    pat.appendChild(svg('rect', { width: 6, height: 6, fill: '#f3f4f6' }));
    pat.appendChild(svg('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#cbd2dc', 'stroke-width': 2 }));
    root.appendChild(svg('defs', null, pat));

    // 颜色标定范围（只看有限值）
    let lo = Infinity, hi = -Infinity;
    M.forEach((r) => r.forEach((v) => {
        if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }));
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (opt.zeroBase) lo = 0;
    if (!(hi > lo)) hi = lo + 1;

    // 列标签（被看的 token = key）
    (opt.colLabels || []).forEach((s, j) => {
        root.appendChild(T({
            x: PL + j * CELL + CELL / 2, y: PT - 9,
            class: 'at-hm-lab', 'text-anchor': 'middle',
        }, s));
    });
    root.appendChild(T({ x: PL - 8, y: PT - 9, class: 'at-hm-axis', 'text-anchor': 'end' }, 'key →'));

    for (let i = 0; i < n; i++) {
        const y = PT + i * CELL;
        // 行标签（发起看的 token = query）
        root.appendChild(T({
            x: PL - 8, y: y + CELL / 2 + 4,
            class: 'at-hm-lab' + (opt.sel === i ? ' on' : ''), 'text-anchor': 'end',
        }, (opt.rowLabels || [])[i] || String(i + 1)));

        for (let j = 0; j < m; j++) {
            const v = M[i][j];
            const x = PL + j * CELL;
            const masked = (v === -Infinity);
            const t = masked ? 0 : (v - lo) / (hi - lo);
            root.appendChild(svg('rect', {
                x: x + 1.5, y: y + 1.5, width: CELL - 3, height: CELL - 3, rx: 5,
                fill: masked ? 'url(#' + pid + ')' : heatColor(t),
                stroke: masked ? '#d8dde6' : 'rgba(255,255,255,0.55)', 'stroke-width': 1,
            }));
            root.appendChild(T({
                x: x + CELL / 2, y: y + CELL / 2 + 4,
                class: 'at-hm-num' + (masked ? ' mask' : (t > 0.55 ? ' light' : '')),
                'text-anchor': 'middle',
            }, masked ? '−∞' : fmt(v)));
        }

        // 行和（softmax 之后应当严格等于 1，把它显式打出来）
        if (opt.rowSum) {
            let s = 0;
            M[i].forEach((v) => { if (isFinite(v)) s += v; });
            root.appendChild(T({
                x: PL + m * CELL + 8, y: y + CELL / 2 + 4, class: 'at-hm-sum',
            }, 'Σ = ' + s.toFixed(3)));
        }

        // 选中行的框
        if (opt.sel === i) {
            root.appendChild(svg('rect', {
                x: PL + 0.5, y: y + 0.5, width: m * CELL - 1, height: CELL - 1, rx: 6,
                fill: 'none', stroke: '#ec4899', 'stroke-width': 2,
            }));
        }

        // 整行的点击热区（放最后，盖在上面接点击）
        if (opt.onRow) {
            const hit = svg('rect', {
                x: PL, y: y, width: m * CELL, height: CELL,
                fill: 'rgba(0,0,0,0)', class: 'at-hm-hit',
            });
            hit.addEventListener('click', ((k) => () => opt.onRow(k))(i));
            root.appendChild(hit);
        }
    }
    return root;
}

// ---------- KV Cache 的格子图 ----------

/**
 * cached=false：第 t 步整个 t×t 块全部重算（上三角算完还要被掩码扔掉）
 * cached=true ：只有第 t 行是新算的，前面 t-1 行全部命中缓存
 */
function kvGridSvg(n, t, cached) {
    const CELL = n > 9 ? 21 : 26;
    const PL = 30, PT = 22, PB = 8, PR = 10;
    const W = PL + n * CELL + PR, H = PT + n * CELL + PB;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'at-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': cached ? '开缓存的计算格子' : '不开缓存的计算格子',
    });

    for (let j = 0; j < n; j++) {
        root.appendChild(T({
            x: PL + j * CELL + CELL / 2, y: PT - 7, class: 'at-kv-lab', 'text-anchor': 'middle',
        }, String(j + 1)));
    }

    for (let i = 0; i < n; i++) {
        const y = PT + i * CELL;
        root.appendChild(T({
            x: PL - 6, y: y + CELL / 2 + 3.5, class: 'at-kv-lab', 'text-anchor': 'end',
        }, String(i + 1)));

        for (let j = 0; j < n; j++) {
            const x = PL + j * CELL;
            let cls = 'at-kv-none';
            if (i < t && j < t) {
                if (!cached) {
                    // 不开缓存：整块重算，上三角是算完就扔的浪费
                    cls = (j > i) ? 'at-kv-waste' : 'at-kv-now';
                } else if (j > i) {
                    cls = 'at-kv-skip';           // 增量解码根本不会去算未来的位置
                } else if (i === t - 1) {
                    cls = 'at-kv-now';            // 只有最下面这一行是真算的
                } else {
                    cls = 'at-kv-cache';          // 历史行：结果早就出过了，不重算
                }
            }
            root.appendChild(svg('rect', {
                x: x + 1, y: y + 1, width: CELL - 2, height: CELL - 2, rx: 3, class: cls,
            }));
        }
    }

    // 当前这一步的高亮框
    if (t > 0) {
        if (!cached) {
            root.appendChild(svg('rect', {
                x: PL + 0.5, y: PT + 0.5, width: t * CELL - 1, height: t * CELL - 1, rx: 4,
                class: 'at-kv-frame',
            }));
        } else {
            root.appendChild(svg('rect', {
                x: PL + 0.5, y: PT + (t - 1) * CELL + 0.5, width: t * CELL - 1, height: CELL - 1, rx: 4,
                class: 'at-kv-frame',
            }));
        }
    }
    return root;
}

// ---------- 卡片 1：场景 ----------

function cardScene() {
    const fw = AT.forward();
    const card = Viz.card('fa-pen-ruler', '例子小到能拿笔验算',
        '句子是 <b>「我 / 爱 / 吃 / 苹果 / 。」</b>共 5 个 token，'
        + '<code>d_model = 4</code>、<code>d_k = 4</code>、<b>单头</b>。'
        + 'embedding 和 W<sub>Q</sub>/W<sub>K</sub>/W<sub>V</sub> 全部是写死的小整数（不是随机数，'
        + '刷新前后完全一样），你可以每一格自己算一遍对答案。');

    const mats = h('div.at-mats', null,
        matEl(fw.E, {
            capHtml: '<b>E</b> · token embedding（5×4）',
            rowLabels: AT.TOKENS, colLabels: ['d0', 'd1', 'd2', 'd3'],
        }),
        matEl(AT.WQ, { capHtml: '<b>W<sub>Q</sub></b>（4×4）' }),
        matEl(AT.WK, { capHtml: '<b>W<sub>K</sub></b>（4×4）' }),
        matEl(AT.WV, { capHtml: '<b>W<sub>V</sub></b>（4×4）' })
    );
    card.appendChild(h('div.mv-matrix-wrap', null, mats));
    card.appendChild(h('p.sec-note', {
        html: '真实模型里 <code>d_model</code> 是 4096、头有 32 个、层有 32 层，'
            + '但<b>一层单头里发生的事，跟下面这 5×5 的小矩阵一模一样</b>。'
            + '把这张小的看懂了，大的只是把同样的事重复很多遍。',
    }));
    return card;
}

// ---------- 卡片 2：主视图 A，一次完整的注意力计算 ----------

const STEPS = [
    { t: 'token → embedding', d: '查表把每个 token 变成一个 4 维向量，5 个 token 摞起来就是 5×4 的矩阵 E。' },
    { t: '乘 W_Q / W_K / W_V → 得到 Q、K、V', d: '同一个 E 过三个不同的投影，得到三份 5×4：Q 是「我想找什么」，K 是「我能被什么找到」，V 是「找到我以后拿走什么」。' },
    { t: 'QKᵀ → 注意力分数矩阵', d: '每个 query 跟每个 key 做点积，得到 5×5 的分数。第 i 行第 j 列 = 第 i 个 token 对第 j 个 token 的原始相似度。' },
    { t: '÷ √d_k → 缩放', d: '除以 √d_k = 2。这一步不是凑数，是救梯度的，下面单独讲。' },
    { t: '因果掩码 → 上三角置 -∞', d: '解码时第 i 个 token 只能看到 ≤ i 的位置。未来的位置置 -∞，softmax 之后自动变成 0。' },
    { t: '逐行 softmax → 每行和为 1', d: '注意是**逐行**做，不是整个矩阵一起做。每一行独立归一化成一个概率分布。' },
    { t: '× V → 输出', d: '权重矩阵乘 V。第 i 行输出 = 其它 token 的 V 向量按第 i 行的注意力权重加权求和。' },
];

function stage(idx, title, node, note) {
    const box = h('div.at-stage' + (state.step >= idx ? '.lit' : ''));
    box.appendChild(h('div.at-stage-h', null,
        h('span.at-stage-n', { text: String(idx + 1) }),
        h('span.at-stage-t', { text: title })));
    if (state.step >= idx) {
        box.appendChild(node);
        if (note) box.appendChild(h('div.at-stage-note', { html: note }));
    } else {
        box.appendChild(h('div.at-stage-hide', { text: '还没走到这一步' }));
    }
    return box;
}

function cardWalk() {
    const fw = AT.forward();
    const card = Viz.card('fa-diagram-project', '主视图 A：一次完整的注意力，逐步算给你看',
        '每按一次「下一步」就往前推进一格。'
        + '默认已经走到最后一步（<b>页面一打开就是完整结果</b>），想从头看点「⟲ 从头走一遍」。');

    // 步骤导航
    const nav = h('div.seq-nav', null,
        h('button.mini', {
            onclick: () => { state.step = Math.max(0, state.step - 1); redrawWalk(); },
        }, '← 上一步'),
        h('span.seq-progress', { text: (state.step + 1) + ' / ' + STEPS.length }),
        h('button.mini.primary', {
            onclick: () => { state.step = Math.min(STEPS.length - 1, state.step + 1); redrawWalk(); },
        }, '下一步 →'),
        h('button.mini', { onclick: () => { state.step = STEPS.length - 1; redrawWalk(); } }, '走到底'),
        h('button.mini', { onclick: () => { state.step = 0; redrawWalk(); } }, '⟲ 从头走一遍')
    );
    card.appendChild(nav);
    card.appendChild(h('div.seq-note', {
        html: '<b>第 ' + (state.step + 1) + ' 步：' + Viz.esc(STEPS[state.step].t) + '</b><br>'
            + STEPS[state.step].d.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'),
    }));

    // ① embedding
    card.appendChild(stage(0, 'token → embedding',
        h('div.mv-matrix-wrap', null, h('div.at-mats', null,
            matEl(fw.E, {
                capHtml: '<b>E</b>（5×4）', rowLabels: AT.TOKENS,
                colLabels: ['d0', 'd1', 'd2', 'd3'],
            })
        )),
        '这里没有位置编码。真实模型会在这一步（或在 Q/K 上）加 RoPE 之类的位置信息，'
        + '否则模型分不清「我爱吃苹果」和「苹果吃爱我」。'));

    // ② Q / K / V
    card.appendChild(stage(1, '乘 W_Q / W_K / W_V → Q、K、V',
        h('div.mv-matrix-wrap', null, h('div.at-mats', null,
            matEl(fw.Q, { capHtml: '<b>Q = E · W<sub>Q</sub></b>', rowLabels: AT.TOKENS }),
            matEl(fw.K, { capHtml: '<b>K = E · W<sub>K</sub></b>', rowLabels: AT.TOKENS }),
            matEl(fw.V, { capHtml: '<b>V = E · W<sub>V</sub></b>', rowLabels: AT.TOKENS })
        )),
        '自己验一格：<code>Q[爱] = E[爱] · W<sub>Q</sub> = [0,1,1,0] · W<sub>Q</sub> = '
        + 'W<sub>Q</sub>第2行 + W<sub>Q</sub>第3行 = [0,1,1,0] + [1,1,0,0] = [1,2,1,0]</code>。'
        + '<b>Self-Attention 的「self」就在这：Q、K、V 全部来自同一个 E。</b>'
        + '（Cross-Attention 里 Q 来自解码端、K/V 来自编码端，区别只在这一行。）'));

    // ③ QKᵀ
    card.appendChild(stage(2, 'QKᵀ → 原始注意力分数',
        heatSvg(fw.scores, {
            rowLabels: AT.TOKENS, colLabels: AT.TOKENS,
            fmt: (v) => String(v), label: '原始分数 QKᵀ',
        }),
        '颜色越深分数越高。自己验一格：<code>S[苹果][我] = Q[苹果] · K[我] = '
        + '[0,1,2,1] · [0,2,2,1] = 0+2+4+1 = 7</code>，正是全图最深的那格之一。'
        + '<b>点积大 = 两个向量方向接近 = 这两个 token 在这一层里「有关系」。</b>'));

    // ④ 缩放
    card.appendChild(stage(3, '÷ √d_k = ÷ 2 → 缩放',
        h('div', null,
            heatSvg(fw.scaled, {
                rowLabels: AT.TOKENS, colLabels: AT.TOKENS,
                fmt: (v) => v.toFixed(1), label: '缩放后的分数',
            }),
            buildScaleWhy()
        ),
        null));

    // ⑤ 因果掩码
    card.appendChild(stage(4, '因果掩码：上三角置 -∞',
        heatSvg(fw.masked, {
            rowLabels: AT.TOKENS, colLabels: AT.TOKENS,
            fmt: (v) => v.toFixed(1), label: '加了因果掩码的分数',
        }),
        '斜纹格子就是被掩掉的位置。<b>为什么要掩？</b>训练时整句话是一次性喂进去的，'
        + '如果「爱」这个位置能看到后面的「苹果」，模型就等于在抄答案 —— '
        + '而真正推理时后面的 token 还没生成出来，根本不存在。'
        + '训练和推理必须看到同样的上下文范围，模型才不会「训练时满分、上线就崩」。'
        + '注意 <b>Encoder（BERT 那一类）不加这个掩码</b>，它本来就要双向看。'));

    // ⑥ softmax
    card.appendChild(stage(5, '逐行 softmax → 每行和为 1',
        heatSvg(fw.weights, {
            rowLabels: AT.TOKENS, colLabels: AT.TOKENS, zeroBase: true, rowSum: true,
            fmt: (v) => (v === 0 ? '0' : v.toFixed(3)), label: '注意力权重',
            sel: state.pick, onRow: (i) => { state.pick = i; redrawWalk(); },
        }),
        '右边把每行的和打出来了 —— <b>严格是 1.000</b>，这就是「注意力权重是一个概率分布」的含义。'
        + '第一行只有一个可见位置，所以「我」100% 只能看自己。'
        + '<b>点任意一行</b>可以选中它，下面会展开那一行的加权求和。'
        + '<br>实现细节：softmax 一定要先减去这一行的最大值再取 exp，'
        + '否则分数稍大 exp 就溢出成 <code>Infinity</code>，除完变 <code>NaN</code>。'));

    // ⑦ ×V
    card.appendChild(stage(6, '× V → 输出',
        h('div', null,
            h('div.mv-matrix-wrap', null, h('div.at-mats', null,
                matEl(fw.V, { capHtml: '<b>V</b>（谁被加权）', rowLabels: AT.TOKENS }),
                matEl(fw.out, {
                    capHtml: '<b>输出 = 权重 · V</b>', rowLabels: AT.TOKENS,
                    fmt: (v) => v.toFixed(2), hiRow: state.pick,
                })
            )),
            buildExpand(fw)
        ),
        '<b>整个注意力最后落到的就是这一句话：每个 token 的输出，是所有它看得见的 token 的 V 向量，'
        + '按注意力权重做的一次加权平均。</b>没有别的魔法。'));

    return card;
}

function buildScaleWhy() {
    const raw = AT.forward().scores[3];        // 「苹果」那一行的原始分数
    const box = h('div.at-why');
    box.appendChild(h('div.at-why-t', { html: '为什么非除不可？拿「苹果」那一行做实验' }));
    box.appendChild(h('p.at-why-p', {
        html: '点积是 d_k 项的和。假设各分量独立、均值 0 方差 1，'
            + '那么点积的<b>方差 ≈ d_k</b>，标准差 ≈ √d_k —— <b>维度越高，分数被拉得越开</b>。'
            + '把同一行分数按 √(d_k/4) 放大，就是「同样的关系搬到更高维」的样子：',
    }));

    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: 'd_k' }), h('th', { text: '原始分数这一行' }),
        h('th', { text: '不缩放，softmax 后' }), h('th', { text: '除以 √d_k 后' })));
    [4, 64, 128].forEach((dk) => {
        const d = AT.scaleDemo(raw, dk);
        const maskIdx = 4;                     // 「。」那一列在这行是未来，展示时略去
        const show = (arr, f) => arr.slice(0, maskIdx).map(f).join('  ');
        const tr = h('tr' + (dk === 128 ? '.on' : ''), null,
            h('td', { text: String(dk) }),
            h('td', { text: show(d.grown, (v) => v.toFixed(1)) }),
            h('td' + (dk > 4 ? '.bad' : ''), { text: show(AT.softmax(d.grown.slice(0, maskIdx)), (v) => v.toFixed(3)) }),
            h('td.ok', { text: show(AT.softmax(d.grown.slice(0, maskIdx).map((v) => v / Math.sqrt(dk))), (v) => v.toFixed(3)) })
        );
        tb.appendChild(tr);
    });
    box.appendChild(h('div.mv-matrix-wrap', null, tb));
    box.appendChild(h('div.flow-hi', {
        html: '看第三列：d_k 一大，不缩放的 softmax 直接被推进<b>饱和区</b>，'
            + '几乎变成 one-hot（0.9999 / 0.0000）。'
            + 'softmax 在饱和区的<b>梯度接近 0</b>，反向传播传不回去，这一层基本学不动。'
            + '<br>再看第四列：<b>除以 √d_k 之后，三种维度得到的分布完全一致</b> —— '
            + '这就是缩放的全部意义：<b>让 softmax 的锐度和维度脱钩</b>。'
            + '所以它叫 Scaled Dot-Product Attention，「Scaled」是名字里的一等公民，不是可选项。',
    }));
    return box;
}

function buildExpand(fw) {
    const i = state.pick;
    const w = fw.weights[i];
    const box = h('div.at-expand');
    box.appendChild(h('div.at-expand-h', {
        html: '把 <b>「' + Viz.esc(AT.TOKENS[i]) + '」</b> 这一行的加权求和逐项拆开：',
    }));

    const terms = h('div.at-terms');
    let shown = 0;
    w.forEach((wv, j) => {
        if (wv === 0) return;
        shown++;
        terms.appendChild(h('div.at-term', null,
            h('span.at-term-w', { text: wv.toFixed(3) }),
            h('span.at-term-x', { text: '×' }),
            h('span.at-term-tok', { text: 'V[' + AT.TOKENS[j] + ']' }),
            h('span.at-term-v', { text: '[' + fw.V[j].join(', ') + ']' }),
            h('span.at-term-r', { text: '= [' + fw.V[j].map((v) => (v * wv).toFixed(2)).join(', ') + ']' })
        ));
    });
    box.appendChild(terms);
    box.appendChild(h('div.at-term.at-term-sum', null,
        h('span.at-term-w', { text: 'Σ' }),
        h('span.at-term-x', { text: '' }),
        h('span.at-term-tok', { text: '输出[' + AT.TOKENS[i] + ']' }),
        h('span.at-term-v', { text: '' }),
        h('span.at-term-r', { text: '= [' + fw.out[i].map((v) => v.toFixed(2)).join(', ') + ']' })
    ));
    box.appendChild(h('p.at-why-p', {
        html: '一共 <b>' + shown + '</b> 项 —— 正好是「' + Viz.esc(AT.TOKENS[i]) + '」及它前面的 token 数，'
            + '被掩掉的位置权重是 0，压根没参与。'
            + '权重加起来是 1，所以输出是 V 各行的一个<b>凸组合</b>，'
            + '它永远落在这些 V 向量张成的范围里 —— 注意力自己不会「造」出新信息，只做筛选和混合。',
    }));
    return box;
}

function redrawWalk() {
    const card = cardWalk();
    if (dom.walk && dom.walk.parentNode) dom.walk.parentNode.replaceChild(card, dom.walk);
    dom.walk = card;
}

// ---------- 卡片 3：主视图 B，KV Cache ----------

function cardKV() {
    const card = Viz.card('fa-layer-group', '主视图 B：开不开 KV Cache，差别长这样',
        '现在换到<b>自回归解码</b>：一个字一个字往外吐，每吐一个就要重新算一次注意力。'
        + '左右两栏是同一件事的两种做法，格子 = 一次 q·k 点积。'
        + '<b>按「下一步」看它们怎么分道扬镳。</b>');

    const ctl = h('div.controls', null,
        Viz.slider({
            label: '序列长度 n', min: 4, max: 12, step: 1, value: state.kvN,
            fmt: (v) => v + ' 个 token',
            onInput: (v) => { state.kvN = v; state.kvT = Math.min(state.kvT, v); fillKV(); fillCost(); },
        }),
        h('div.ctl-btns', null,
            h('button.mini', { onclick: () => { state.kvT = Math.max(1, state.kvT - 1); fillKV(); } }, '← 上一步'),
            h('button.mini.primary', { onclick: () => { state.kvT = Math.min(state.kvN, state.kvT + 1); fillKV(); } }, '下一步 →'),
            h('button.mini', { onclick: () => { state.kvT = state.kvN; fillKV(); } }, '走到底'),
            h('button.mini', { onclick: () => { state.kvT = 1; fillKV(); } }, '⟲ 重来')
        )
    );
    card.appendChild(ctl);

    dom.kvOut = h('div.at-kvout');
    card.appendChild(dom.kvOut);
    fillKV();
    return card;
}

function fillKV() {
    const box = dom.kvOut;
    if (!box) return;
    box.innerHTML = '';

    const n = state.kvN, t = Math.max(1, Math.min(state.kvT, n));
    state.kvT = t;
    const c = AT.costs(n);
    const cur = c.steps[t - 1];

    box.appendChild(h('div.seq-nav', null,
        h('span.seq-progress', { text: '解码第 ' + t + ' 步 / 共 ' + n + ' 步' }),
        h('span.at-kv-hint', { text: '当前序列里已经有 ' + t + ' 个 token' })
    ));

    box.appendChild(Viz.legend([
        { cls: 'k-at-now', text: '本步真的在算' },
        { cls: 'k-at-waste', text: '算了又被掩码扔掉（纯浪费）' },
        { cls: 'k-at-cache', text: '命中缓存，本步不算' },
        { cls: 'k-at-skip', text: '因果性决定的、根本不用算' },
        { cls: 'k-at-none', text: '还没到的未来 token' },
    ]));

    const mk = (title, sub, cached, stepCost, cum, cls) => {
        const p = h('div.at-kv-panel' + cls);
        p.appendChild(h('div.at-kv-title', { html: title }));
        p.appendChild(h('div.at-kv-sub', { html: sub }));
        p.appendChild(kvGridSvg(n, t, cached));
        p.appendChild(h('div.at-kv-cnt', null,
            h('span.at-kv-cnt-a', { html: '本步 <b>' + fmtInt(stepCost) + '</b> 次点积' }),
            h('span.at-kv-cnt-b', { html: '累计 <b>' + fmtInt(cum) + '</b> 次' })
        ));
        return p;
    };

    box.appendChild(h('div.at-grid2', null,
        mk('❌ 不开缓存', '把整个序列重新喂一遍，<b>' + t + '×' + t + ' 的分数矩阵整块重算</b>',
            false, cur.no, cur.cumNo, '.bad'),
        mk('✅ 开 KV Cache', 'K、V 存着，新 token 只算<b>最下面那一行</b>',
            true, cur.kv, cur.cumKv, '.ok')
    ));

    const ratio = cur.cumKv > 0 ? cur.cumNo / cur.cumKv : 1;
    box.appendChild(h('div.seq-note', {
        html: '走到第 <b>' + t + '</b> 步：不开缓存这一步要算 <b>' + t + '² = ' + cur.no + '</b> 个分数，'
            + '开缓存只算 <b>' + cur.kv + '</b> 个。'
            + (cur.waste > 0
                ? '而且不开缓存那 ' + cur.no + ' 个里有 <b>' + cur.waste + '</b> 个落在上三角，'
                  + '<b>算出来立刻被因果掩码扔掉</b> —— 白算的。'
                : '')
            + '<br>累计已经差了 <b>' + ratio.toFixed(1) + ' 倍</b>。'
            + '差距不是恒定的，它<b>随序列变长而持续拉大</b>：'
            + '左边是 O(n³) 量级，右边是 O(n²) 量级。',
    }));

    if (t >= n) {
        box.appendChild(h('div.flow-hi', {
            html: '<b>关键观察：右边每一步只有最下面一行亮起来，上面全是绿色的缓存。</b>'
                + '这说明历史 token 的输出<b>永远不会变</b> —— '
                + '因果掩码保证第 i 个位置看不到第 t 个（t &gt; i），所以它的输出在第 i 步就定稿了，'
                + '重算一遍只会得到一模一样的结果。<b>KV Cache 不是近似、不是取巧，它是严格等价的。</b>'
                + '下面的第 4 条测试断言就是逐元素验证这件事。',
        }));
    }
}

// ---------- 卡片 4：计算量对比 ----------

function cardCost() {
    const card = Viz.card('fa-calculator', '把计算量算清楚：n³/3 对 n²/2', null);
    dom.costOut = h('div');
    card.appendChild(dom.costOut);
    fillCost();
    return card;
}

function fillCost() {
    const box = dom.costOut;
    if (!box) return;
    box.innerHTML = '';

    const n = state.kvN;
    const c = AT.costs(n);
    box.appendChild(Viz.cmpGrid([
        { h: '不开缓存 · n=' + n, v: fmtInt(c.cumNo), d: '累计点积次数 ≈ n³/3', cls: 'cmp-bad' },
        { h: '开 KV Cache · n=' + n, v: fmtInt(c.cumKv), d: '累计点积次数 ≈ n²/2', cls: 'cmp-ok' },
        { h: '省下', v: c.ratio.toFixed(1) + '×', d: '而且 n 越大省得越多', cls: 'cmp-save' },
    ]));

    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '序列长度 n' }),
        h('th', { text: '不开缓存 Σt² = n(n+1)(2n+1)/6' }),
        h('th', { text: '开缓存 Σt = n(n+1)/2' }),
        h('th', { text: '倍数 = (2n+1)/3' })));
    [n, 128, 512, 2048, 8192].forEach((k) => {
        // 直接用闭式解，跟上面逐步累加的结果是同一个数（测试里做了对拍）
        const no = (k * (k + 1) * (2 * k + 1)) / 6;
        const kv = (k * (k + 1)) / 2;
        tb.appendChild(h('tr' + (k === n ? '.on' : ''), null,
            h('td', { text: fmtInt(k) + (k === n ? '（当前）' : '') }),
            h('td.bad', { text: fmtBig(no) }),
            h('td.ok', { text: fmtBig(kv) }),
            h('td.mv-strong', { text: ((2 * k + 1) / 3).toFixed(1) + '×' })));
    });
    box.appendChild(h('div.mv-matrix-wrap', null, tb));

    box.appendChild(h('p.sec-note', {
        html: '倍数是精确的闭式解 <code>(2n+1)/3</code>。'
            + '<b>n = 512 时差 341.7 倍，n = 8192 时差 5461 倍。</b>'
            + '这就是为什么所有推理框架都默认开 KV Cache —— '
            + '不开的话，长上下文的解码根本没法用。'
            + '<br>计数口径：只数 QKᵀ 的点积次数，没算 ×V、没算 QKV 投影、没算 FFN，也没乘 d_k 和层数。'
            + '真实 FLOPs 要在这上面再乘常数，但<b>量级关系（n³ 对 n²）是一样的</b>。',
    }));
}

// ---------- 卡片 5：显存计算器（第二个打脸时刻）----------

function cardMem() {
    const card = Viz.card('fa-memory', '第二个打脸时刻：KV Cache 省了算力，却在吃显存',
        '上面看完你可能觉得 KV Cache 是纯赚。它不是 —— 它是<b>拿显存换算力</b>。'
        + '公式很简单：<br>'
        + '<code>KV Cache 显存 = 2(K和V) × layers × kvHeads × d_head × seq_len × batch × dtype字节数</code>');

    const presets = h('div.at-presets', null,
        h('button.mini', {
            onclick: () => setMem({ model: 'llama3-8b', seqIdx: 4, batchIdx: 0, dtype: 'fp16' }),
        }, '① 日常：8B · 8K · batch 1'),
        h('button.mini.danger', {
            onclick: () => setMem({ model: 'llama2-7b', seqIdx: 6, batchIdx: 4, dtype: 'fp16' }),
        }, '② ☠ 打脸：MHA · 32K · batch 16'),
        h('button.mini', {
            onclick: () => setMem({ model: 'llama3-8b', seqIdx: 6, batchIdx: 4, dtype: 'fp16' }),
        }, '③ GQA 救场：同样负载'),
        h('button.mini', {
            onclick: () => setMem({ model: 'llama3-8b', seqIdx: 6, batchIdx: 4, dtype: 'int4' }),
        }, '④ 再叠 INT4 量化 KV')
    );
    card.appendChild(presets);

    card.appendChild(Viz.segmented({
        value: state.model,
        options: AT.MODELS.map((m) => ({ v: m.id, label: m.name + ' · ' + m.attn })),
        onPick: (v) => setMem({ model: v }),
    }));

    const ctl = h('div.controls', null,
        Viz.slider({
            label: '序列长度', min: 0, max: SEQS.length - 1, step: 1, value: state.seqIdx,
            fmt: (i) => (SEQS[i] >= 1024 ? (SEQS[i] / 1024) + 'K' : SEQS[i]) + ' token',
            onInput: (i) => { state.seqIdx = i; fillMem(); },
        }),
        Viz.slider({
            label: 'batch', min: 0, max: BATCHES.length - 1, step: 1, value: state.batchIdx,
            fmt: (i) => BATCHES[i] + ' 条',
            onInput: (i) => { state.batchIdx = i; fillMem(); },
        }),
        Viz.slider({
            label: '层数', min: 4, max: 96, step: 4, value: state.layers,
            fmt: (v) => v + ' 层',
            onInput: (v) => { state.layers = v; fillMem(); },
        }),
        Viz.slider({
            label: 'KV 头数', min: 1, max: 64, step: 1, value: state.kvHeads,
            fmt: (v) => v + ' 个',
            onInput: (v) => { state.kvHeads = v; fillMem(); },
        })
    );
    card.appendChild(ctl);

    card.appendChild(Viz.segmented({
        value: state.dtype,
        options: AT.DTYPES.map((d) => ({ v: d.id, label: d.name })),
        onPick: (v) => setMem({ dtype: v }),
    }));

    dom.memOut = h('div.at-memout');
    card.appendChild(dom.memOut);
    fillMem();
    return card;
}

function setMem(patch) {
    Object.keys(patch).forEach((k) => { state[k] = patch[k]; });
    if (patch.model) {
        const m = AT.MODELS.find((x) => x.id === patch.model);
        state.layers = m.layers; state.kvHeads = m.kvHeads;
        state.dHead = m.dHead; state.params = m.params; state.attn = m.attn;
    }
    redrawMem();
}

function redrawMem() {
    const card = cardMem();
    if (dom.mem && dom.mem.parentNode) dom.mem.parentNode.replaceChild(card, dom.mem);
    dom.mem = card;
}

function fillMem() {
    const box = dom.memOut;
    if (!box) return;
    box.innerHTML = '';

    const seqLen = SEQS[state.seqIdx], batch = BATCHES[state.batchIdx];
    const dt = AT.DTYPES.find((d) => d.id === state.dtype);
    const kv = AT.kvBytes({
        layers: state.layers, kvHeads: state.kvHeads, dHead: state.dHead,
        seqLen, batch, dtypeBytes: dt.bytes,
    });
    const wt = AT.weightBytes(state.params, 2);
    const perTok = AT.kvBytes({
        layers: state.layers, kvHeads: state.kvHeads, dHead: state.dHead,
        seqLen: 1, batch: 1, dtypeBytes: dt.bytes,
    });
    const rf = AT.roofline({ weightBytes: wt, kvBytes: kv, batch, bandwidth: HBM });
    const times = wt > 0 ? kv / wt : 0;

    // 公式逐项展开，让人看见每个数字从哪来
    box.appendChild(h('code.at-formula', {
        html: 'KV = 2 × ' + state.layers + '层 × ' + state.kvHeads + '个KV头 × '
            + state.dHead + ' × ' + fmtInt(seqLen) + ' × batch ' + batch + ' × '
            + dt.bytes + ' 字节 = <b>' + AT.fmtGiB(kv) + '</b>',
    }));

    box.appendChild(Viz.cmpGrid([
        { h: 'KV Cache 显存', v: AT.fmtGiB(kv), d: '随 seq × batch 线性涨', cls: times >= 1 ? 'cmp-bad' : 'cmp-save' },
        { h: '模型权重（FP16）', v: AT.fmtGiB(wt), d: fmtBig(state.params) + ' 参数 × 2 字节', cls: 'cmp-ok' },
        { h: 'KV / 权重', v: times.toFixed(2) + '×', d: times >= 1 ? '缓存比权重还大' : '权重还占大头', cls: times >= 1 ? 'cmp-bad' : 'cmp-save' },
    ]));

    if (times >= 1) {
        box.appendChild(h('div.at-warn', {
            html: '<b>☠ 打脸时刻：KV Cache 已经比模型权重本身还大了（' + times.toFixed(1) + ' 倍）。</b><br>'
                + '很多人对大模型显存的直觉停留在「权重多大就要多大显存」，'
                + '但长上下文 + 大 batch 一上来，<b>KV Cache 才是显存的大头</b>。'
                + '一张 H100 是 80 GiB，这份 KV Cache 就要占掉 <b>'
                + (kv / (80 * 1024 * 1024 * 1024)).toFixed(1) + ' 张卡</b>，权重还没算进去。'
                + '<br>这就是为什么线上服务的「最大并发数」经常不是被算力卡住的，'
                + '而是被<b>显存里塞不下更多 KV Cache</b> 卡住的。',
        }));
    } else {
        box.appendChild(h('div.at-ok-banner', {
            html: '现在权重还是大头（KV 只占权重的 ' + times.toFixed(2) + ' 倍）。'
                + '把「序列长度」和「batch」往右拉，或者点上面第 ② 个预设，看它什么时候翻过去。',
        }));
    }

    const stats = h('div.stats', null,
        h('div.stat.s-s', null,
            h('div.stat-name', null, h('b', { text: '每个 token 的 KV' }), h('small', { text: '全部层加起来' })),
            h('div.stat-val', { text: (perTok / 1024).toFixed(0) + ' KB' }),
            h('div.stat-desc', { html: '上下文每长 1 个 token，显存就多这么多。乘上 batch 再乘上并发请求数，很快就爆了。' })),
        h('div.stat.s-d', null,
            h('div.stat-name', null, h('b', { text: '每生成 1 个 token' }), h('small', { text: '要搬运的字节' })),
            h('div.stat-val', { text: AT.fmtGiB(rf.bytesPerStep) }),
            h('div.stat-desc', { html: '权重 + 整个 KV Cache 都要从显存读一遍，而只做了 batch 个 token 的计算。<b>算术强度极低。</b>' })),
        h('div.stat.s-r', null,
            h('div.stat-name', null, h('b', { text: '带宽算出的上限' }), h('small', { text: 'H100 · 3.35 TB/s' })),
            h('div.stat-val', { text: fmtInt(rf.tokPerSec) + ' tok/s' }),
            h('div.stat-desc', { html: '注意这个数字<b>完全由带宽决定，跟算力一点关系都没有</b> —— decode 阶段是不折不扣的访存瓶颈。' }))
    );
    box.appendChild(stats);
}

// ---------- 卡片 6：这条技术路线为什么存在 ----------

function cardRoute() {
    const card = Viz.card('fa-route', '于是有了这一整条技术路线',
        '上面那个「显存被 KV Cache 吃爆」的问题，把 LLM 推理优化劈成了三个方向。'
        + '看懂了成因，这些名字就不用背了 —— 它们各自在砍公式里的哪一项，一目了然。');

    card.appendChild(Viz.flowList([
        {
            t: '方向一：砍 kvHeads —— MQA / GQA / MLA',
            f: 'MHA : kvHeads = qHeads      （Llama-2-7B: 32）\n'
             + 'GQA : 几个 query 头共享一组 KV （Llama-3-8B: 8，直接省 4 倍）\n'
             + 'MQA : 所有 query 头共享一组   （kvHeads = 1，省到极致）\n'
             + 'MLA : 把 KV 压成一个低秩隐向量再存（DeepSeek 走的路）',
            r: '公式里 kvHeads 这一项直接除以 4 / 除以 32',
            hi: '注意 <b>GQA 砍的是 KV 头，query 头一个没少</b> —— '
                + '所以表达能力掉得不多，显存却是成倍地省。'
                + '这也是为什么 2023 年之后新出的模型几乎全是 GQA：它几乎是白捡的。',
        },
        {
            t: '方向二：别浪费已有的显存 —— PagedAttention / vLLM',
            f: '朴素做法：每条序列按 max_len 预分配一整块连续显存\n'
             + '问题　　：实际长度千差万别，预留的部分全是碎片，谁也用不上\n'
             + 'PagedAttention：学操作系统的分页，KV 切成固定大小的 block，\n'
             + '                用一张「块表」映射，物理上不必连续',
            r: '同样的显存能塞下更多并发请求 → 吞吐直接上去',
            hi: '这个类比是字面意义上的：<b>就是虚拟内存那一套搬到了 KV Cache 上</b>。'
                + '顺带还白送了一个能力 —— 多个请求共享同一段 prompt 的 KV（前缀复用），'
                + '因为块表可以指向同一个物理块。',
        },
        {
            t: '方向三：把每个数存小一点 —— KV Cache 量化',
            f: 'FP16 → FP8   : 显存减半\n'
             + 'FP16 → INT4  : 显存变 1/4\n'
             + '（权重照旧 FP16/INT8，跟 KV 的精度是两件事）',
            r: '公式里 dtype 字节数从 2 变成 1 或 0.5',
            hi: 'KV Cache 对精度的敏感度通常低于权重，所以量化 KV 往往是性价比很高的一刀。'
                + '但它<b>不是免费的</b>：量化/反量化本身要花时间，长上下文下的误差也会累积，上线前必须实测。',
        },
        {
            t: '为什么这三条路线都在跟「显存/带宽」较劲，而不是跟算力？',
            f: 'prefill（处理 prompt）: 矩阵 × 矩阵，GEMM，算术强度高 → 算力瓶颈\n'
             + 'decode （逐 token 生成）: 向量 × 矩阵，GEMV，每个权重只用一次 → 访存瓶颈',
            r: 'decode 阶段 GPU 的算力单元大部分时间在等数据',
            hi: '这是整个演示最该带走的一句话：<b>大模型推理的 decode 阶段是访存瓶颈，不是算力瓶颈。</b>'
                + '每生成一个 token，都要把全部权重 + 整个 KV Cache 从 HBM 读一遍，'
                + '却只做了一个 token 的计算量。'
                + '所以优化的方向是「少搬点数据」，而不是「买更强的算力」—— '
                + 'continuous batching、chunked prefill、PD 分离，本质都是在提高每次搬运的利用率。',
        },
    ]));
    return card;
}

// ---------- 卡片 7 / 8 / 9 ----------

function cardQA() {
    return Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        {
            q: '为什么注意力要除以 √d_k？',
            a: '<b>为了不让 softmax 进饱和区。</b>'
                + 'q 和 k 的点积是 d_k 项的和，假设各分量独立、均值 0 方差 1，'
                + '那么点积的<b>方差就是 d_k</b>、标准差是 √d_k。'
                + 'd_k 越大，分数被拉得越开；分数一大，<code>softmax</code> 就趋近 one-hot，'
                + '而 softmax 在饱和区的<b>雅可比矩阵接近 0</b>，梯度传不回去，这一层学不动。'
                + '除以 √d_k 把方差拉回 1，<b>让 softmax 的锐度跟维度脱钩</b>。'
                + '<br>加分项：这也是它叫 <b>Scaled</b> Dot-Product Attention 的原因；'
                + '另外注意<b>除的是 √d_k（每个头的维度），不是 √d_model</b> —— 多头场景下这两个不一样。',
        },
        {
            q: '多头注意力的「多头」到底多在哪？是复制好几份吗？',
            a: '<b>不是复制，是把 d_model 切开并行。</b>'
                + '假设 d_model = 4096、8 个头，那么每个头的 <code>d_head = 4096 / 8 = 512</code>，'
                + '八个头各自在 512 维的子空间里独立算注意力，算完 concat 回 4096，再过一个 W<sub>O</sub>。'
                + '<br><b>所以参数量和 FLOPs 跟单头 d_model=4096 基本一样，不是 8 倍。</b>'
                + '这是最常被答错的地方 —— 很多人以为多头 = 多算 8 遍。'
                + '<br>多头的收益是<b>同一层里可以有 8 组不同的相似度度量</b>：'
                + '一个头盯语法依存、一个头盯共指、一个头盯位置邻接……单头只能学出一种加权方式。'
                + '<br>顺带：<b>GQA 打破了「Q 头数 = KV 头数」这个默认约定</b> —— '
                + 'query 头照旧 32 个，KV 头只留 8 个，几个 query 头共用一组 K/V，专门为了砍 KV Cache。',
        },
        {
            q: 'prefill 和 decode 阶段有什么本质区别？',
            a: '<b>一个是算力瓶颈，一个是访存瓶颈，这是两种完全不同的负载。</b>'
                + '<br><b>prefill</b>（处理输入的 prompt）：所有 token 一次性并行进去，'
                + '是<b>矩阵 × 矩阵</b>（GEMM）。一份权重读进来能服务成百上千个 token，'
                + '算术强度高，GPU 的算力单元能吃饱 → <b>compute-bound</b>。'
                + '<br><b>decode</b>（一个字一个字往外吐）：每步只有 1 个新 token，'
                + '是<b>向量 × 矩阵</b>（GEMV）。为了算这 1 个 token，要把全部权重 + 整个 KV Cache '
                + '从 HBM 搬一遍，每个权重只被用一次 → <b>memory-bound</b>，算力大部分时间在空转。'
                + '<br>工程后果：① 增大 batch 对 decode 几乎「免费」提吞吐（权重那一遍读取被摊薄了），'
                + '对 prefill 则不然；② 两阶段抢同一张卡会互相干扰，于是有了 '
                + '<b>chunked prefill</b> 和 <b>PD 分离</b>（把 prefill 和 decode 放到不同的机器上）；'
                + '③ 评价指标也分成两个：<b>TTFT</b>（首 token 延迟，看 prefill）和 '
                + '<b>TPOT</b>（每 token 间隔，看 decode）。',
        },
        {
            q: 'KV Cache 为什么只缓存 K 和 V，不缓存 Q？',
            a: '<b>因为历史的 q 再也用不到了。</b>'
                + '解码第 t 步只需要新 token 的 <code>q_t</code>，拿它去跟缓存里全部的 K 点积；'
                + '而历史位置 i 的输出，在第 i 步就已经算完输出去了 —— '
                + '<b>因果掩码保证位置 i 永远看不到位置 t（t &gt; i），所以它的输出不会因为新 token 而改变</b>，'
                + '既然不用重算，<code>q_i</code> 自然也没有留着的必要。'
                + '<br>反过来 K 和 V 每一步都要被新来的 q 全量点乘 / 加权，所以必须留着。'
                + '<b>一句话：Q 是「这一步的问题」，K/V 是「历史的答案库」；问题问完就作废，答案库要一直留着。</b>'
                + '<br>还有个常被忽略的好处：<b>增量解码根本不需要写掩码代码</b> —— '
                + '缓存里压根没有未来的 K，因果性天然成立。掩码只在 prefill（并行算整段）时才需要。',
        },
    ]));
}

function cardPitfalls() {
    return Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls([
        ['KV Cache 是拿显存换算力，不是白赚',
            '上面的计算器已经演示了：长上下文 + 大 batch 时，<b>KV Cache 能比模型权重本身还大好几倍</b>。'
            + '显存塞不下就只能减 batch，而 decode 是访存瓶颈、靠大 batch 摊薄权重读取来提吞吐 —— '
            + '于是 <b>batch 一减，吞吐直接崩</b>。「省了计算」和「吞吐变高」之间没有必然关系，别想当然。'],
        ['softmax 忘了减最大值，长上下文一来就 NaN',
            '<code>exp(1000)</code> 在 FP32 里直接是 <code>Infinity</code>，'
            + '<code>Infinity / Infinity = NaN</code>，整个前向静默烂掉，还很难查。'
            + '正确写法永远是先 <code>x - max(x)</code> 再 <code>exp</code>。'
            + 'FlashAttention 的 online softmax 之所以要一路维护「running max」，就是为了在分块计算时也保住这条性质。'],
        ['缓存必须跟着序列状态一起管理，不然会静默出错',
            '换 prompt、beam search 分叉、投机解码回退、请求被抢占换出……'
            + '任何一个地方忘了裁剪或清空 KV Cache，新 token 就会去 attend 到<b>别的序列的历史</b>。'
            + '要命的是它<b>不报错</b> —— 输出照样通顺，只是内容悄悄跑偏，'
            + '是那种能在生产上藏好几个月的 bug。'],
        ['按 max_len 预分配显存，浪费得吓人',
            '一条请求可能只用 200 个 token，却按 32K 上限预留了一整块连续显存，剩下的谁也用不了。'
            + '并发一多，显存全被这些「预留但没用」的碎片占着，实际能跑的请求数远低于纸面。'
            + '<b>PagedAttention（vLLM）就是冲着这个来的</b>：分块 + 块表，用多少给多少。'],
        ['不要用「注意力权重」当解释性证据',
            '权重大 ≠ 这个 token 更重要。经过多层堆叠、残差、多头混合之后，'
            + '单层单头的注意力权重跟最终输出的因果关系已经很弱了。'
            + '学界对「attention is explanation」这件事有过明确的争论，'
            + '<b>拿注意力热力图当模型可解释性的结论来用，是要挨打的</b>。'
            + '看看趋势可以，别下判断。'],
        ['这里的因果掩码只对 Decoder 成立',
            'GPT / Llama 这类 Decoder-only 模型才有上三角掩码。'
            + '<b>BERT 那一类 Encoder 是双向的，没有这个掩码</b>，'
            + '它也因此没法做自回归生成（也就用不上 KV Cache）。'
            + '面试时把「注意力」和「因果注意力」混着说，会被追问。'],
    ]));
}

function cardFoot() {
    return h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示（做了哪些简化）' }),
        h('p', {
            html: '<b>模型口径</b>：单头、<code>d_model = d_k = 4</code>、5 个 token。'
                + 'embedding 和 W<sub>Q</sub>/W<sub>K</sub>/W<sub>V</sub> 是<b>我为了好验算编的小整数</b>，'
                + '不是任何真实模型的参数，也没有经过任何训练。全部写死，没有用随机数，'
                + '所以刷新前后、你我看到的数字完全一致。',
        }),
        h('p', {
            html: '<b>省掉的部分</b>：没有位置编码（真实模型会用 RoPE / ALiBi / 绝对位置编码；'
                + '没有位置编码时，注意力对 token 顺序是置换等变的，因果掩码只限制了「能看到谁」，'
                + '并不能告诉模型「谁在前谁在后」）；没有 LayerNorm、没有残差连接、没有 FFN、'
                + '没有输出投影 W<sub>O</sub>、没有 dropout。真实的一层 Transformer 比这里多得多。',
        }),
        h('p', {
            html: '<b>计算量口径</b>：只数 QKᵀ 的点积次数（不开缓存第 t 步 t²、开缓存第 t 步 t），'
                + '没有算 ×V、没有算 QKV 投影、没有算 FFN，也没有乘以 d_k 和层数。'
                + '真实 FLOPs 要在这上面乘常数，但 <b>n³ 对 n² 的量级关系是一致的</b>。'
                + '另外「不开缓存算满 t²」对应的是「把整个序列重新喂一遍」这种朴素实现；'
                + '如果实现时跳过上三角，那是 t(t+1)/2，量级仍然是 n³。',
        }),
        h('p', {
            html: '<b>显存口径</b>：只算 KV Cache 本身，<b>忽略了 activation、显存碎片、'
                + '框架和 CUDA context 开销、CUDA Graph 缓冲区</b>等等，真实占用只会更多不会更少。'
                + '模型权重一律按 FP16（2 字节/参数）估算。'
                + '「每秒 token 数」是<b>极粗的带宽上限</b>：假设每步把权重和 KV 各完整读一遍、'
                + '一个 batch 共享权重读取，忽略 cache 命中、算子融合和计算/搬运的 overlap，'
                + '<b>只用来说明 decode 是访存瓶颈这件事，不能当性能预测用</b>。',
        }),
        h('p', {
            html: '几个模型的配置（层数 / KV 头数 / d_head）取自各自的公开配置，'
                + '参数量取常见的近似值；你也可以直接拖滑块调成任意配置。',
        })
    );
}

// ---------- 组装 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    rootEl.appendChild(cardScene());
    dom.walk = cardWalk();
    rootEl.appendChild(dom.walk);
    rootEl.appendChild(cardKV());
    rootEl.appendChild(cardCost());
    dom.mem = cardMem();
    rootEl.appendChild(dom.mem);
    rootEl.appendChild(cardRoute());
    rootEl.appendChild(cardQA());
    rootEl.appendChild(cardPitfalls());
    rootEl.appendChild(cardFoot());
}

Viz.register({
    id: 'attention',
    cat: 'ai',
    title: 'Self-Attention 与 KV Cache',
    subtitle: 'QKᵀ · 因果掩码 · 增量解码',
    icon: 'fa-brain',
    blurb: '5 个 token 手算一遍注意力，再看 KV Cache 省了什么、又吃掉了什么',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.step = STEPS.length - 1;
        state.pick = 3;
        state.kvN = 8;
        state.kvT = 8;
        state.model = 'llama3-8b';
        state.layers = 32; state.kvHeads = 8; state.dHead = 128;
        state.params = 8.03e9; state.attn = 'GQA';
        state.seqIdx = 4; state.batchIdx = 0; state.dtype = 'fp16';
        render();
    },
    unmount() {
        // 没有 rAF / 定时器，只需要断掉 DOM 引用
        dom.walk = null; dom.kvOut = null; dom.costOut = null;
        dom.mem = null; dom.memOut = null;
        rootEl = null;
    },
});

})();
