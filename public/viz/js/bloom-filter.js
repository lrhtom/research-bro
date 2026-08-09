// ============================================================
//  演示：布隆过滤器 Bloom Filter
//  一条位数组 + k 个哈希函数，用极小的内存回答「这个 key 在不在」。
//  代价是它会误判「在」（假阳性），但绝不会误判「不在」——
//  这个「只朝一个方向错」的不对称，就是它全部价值的来源。
//  上半 BF.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const BF = {};

// 两个种子只是为了让 h1、h2 差别够大。取值是常见的混淆常数，没有魔法。
BF.SEED_A = 0x9e3779b1;
BF.SEED_B = 0x85ebca6b;

/**
 * 确定性 32 位哈希（FNV-1a + 一轮 murmur3 风格的收尾混淆）。
 * 为什么要收尾混淆：FNV-1a 的低位散列性一般，而我们最后要 `% m`，
 * m 常常是 2 的幂 —— 那时只有低位起作用，不混一下位置会扎堆。
 * 全程整数运算、无 Math.random，同一个 key 任何时候都得到同一个值。
 */
BF.hash32 = function (str, seed) {
    const s = String(str);
    let hv = (2166136261 ^ (seed >>> 0)) >>> 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        hv = Math.imul(hv ^ (c & 0xff), 16777619) >>> 0;
        hv = Math.imul(hv ^ (c >>> 8), 16777619) >>> 0;
    }
    hv ^= hv >>> 16; hv = Math.imul(hv, 2246822507) >>> 0;
    hv ^= hv >>> 13; hv = Math.imul(hv, 3266489909) >>> 0;
    hv ^= hv >>> 16;
    return hv >>> 0;
};

/**
 * 只算两个哈希，其余 k-2 个用它俩线性组合出来。
 * 这是工业界标准做法（Kirsch–Mitzenmacher 双哈希）：
 * g_i(x) = (h1(x) + i·h2(x)) mod m，误判率与 k 个独立哈希渐近等价，
 * 但只需要算两次哈希 —— k 越大越省。
 * h2 强制取奇数：m 是 2 的幂时，奇数步长才能走遍整个位数组，不会只在几个位置打转。
 */
BF.h1h2 = function (key) {
    const h1 = BF.hash32(key, BF.SEED_A);
    let h2 = BF.hash32(key, BF.SEED_B);
    if (h2 % 2 === 0) h2 += 1;
    return { h1: h1, h2: h2 };
};

/** 一个 key 的 k 个位置（可能重复 —— 两个哈希撞到同一位是正常现象）*/
BF.positions = function (key, k, m) {
    const hh = BF.h1h2(key);
    const out = [];
    for (let i = 0; i < k; i++) out.push((hh.h1 + i * hh.h2) % m);
    return out;
};

/**
 * 建一个过滤器。
 * bits   : 真正的 1 位数组（布隆过滤器本体）
 * counts : 「如果换成计数布隆过滤器，此刻计数器会是多少」—— 只为演示删除用，不影响判定
 * setBy  : 每一位是被哪个 key 第一次从 0 点到 1 的（演示假阳性归因用，真实实现没有这个）
 */
BF.create = function (m, k) {
    return {
        m: m, k: k,
        bits: new Array(m).fill(0),
        counts: new Array(m).fill(0),
        setBy: new Array(m).fill(null),
        keys: [],
    };
};

BF.clone = function (f) {
    return {
        m: f.m, k: f.k,
        bits: f.bits.slice(), counts: f.counts.slice(),
        setBy: f.setBy.slice(), keys: f.keys.slice(),
    };
};

/**
 * 插入。limit 用来做「逐个点亮」的动画：只应用前 limit 个哈希，其余标记 pending。
 * 返回 trace：{ key, positions[], steps[{i,pos,was,dup,pending}], applied }
 * 幂等：同一个 key 再插一次，位数组一位都不会变（1 只会保持 1）。
 */
BF.insert = function (f, key, limit) {
    const lim = limit == null ? f.k : limit;
    const pos = BF.positions(key, f.k, f.m);
    const already = f.keys.indexOf(key) >= 0;
    const steps = [];
    for (let i = 0; i < pos.length; i++) {
        const p = pos[i];
        if (i >= lim) { steps.push({ i: i, pos: p, pending: true }); continue; }
        const was = f.bits[p];
        f.bits[p] = 1;
        // 计数器只在「这个 key 第一次进来」时加，免得重复插入把计数搞乱
        if (!already) f.counts[p] += 1;
        if (!was && f.setBy[p] == null) f.setBy[p] = key;
        steps.push({ i: i, pos: p, was: was, dup: pos.indexOf(p) < i });
    }
    if (!already) f.keys.push(key);
    return { key: key, positions: pos, steps: steps, applied: Math.min(lim, pos.length), already: already };
};

/**
 * 查询。核心是短路：只要有一位是 0，立刻返回「一定不存在」，后面的哈希根本不用算。
 * verdict: 'absent' 一定不存在 / 'maybe' 可能存在 / 'pending' 还没查完（动画中间态）
 */
BF.query = function (f, key, limit) {
    const lim = limit == null ? f.k : limit;
    const pos = BF.positions(key, f.k, f.m);
    const checks = [];
    let verdict = 'maybe';
    let short = false;

    for (let i = 0; i < pos.length; i++) {
        if (i >= lim) { checks.push({ i: i, pos: pos[i], pending: true }); continue; }
        const bit = f.bits[pos[i]];
        checks.push({ i: i, pos: pos[i], bit: bit });
        if (!bit) {
            verdict = 'absent';
            short = true;
            for (let j = i + 1; j < pos.length; j++) checks.push({ i: j, pos: pos[j], skipped: true });
            break;
        }
    }
    if (!short && lim < pos.length) verdict = 'pending';

    return {
        key: key, positions: pos, checks: checks, verdict: verdict,
        maybe: verdict === 'maybe',
        absent: verdict === 'absent',
        // 全查完都是 1、但这个 key 其实从没插过 → 这一次就是假阳性
        falsePositive: verdict === 'maybe' && f.keys.indexOf(key) < 0,
    };
};

/** 布尔快捷方式：布隆过滤器意义上的「可能存在」*/
BF.contains = function (f, key) { return BF.query(f, key).maybe; };

/** 粗暴删除：把 k 位直接置 0 —— 这就是灾难的来源（会误伤别人的位）*/
BF.removeNaive = function (f, key) {
    const pos = BF.positions(key, f.k, f.m);
    pos.forEach(function (p) { f.bits[p] = 0; });
    const i = f.keys.indexOf(key);
    if (i >= 0) f.keys.splice(i, 1);
    return pos;
};

/** 计数布隆过滤器的删除：计数器减 1，减到 0 才把位放掉 */
BF.removeCounting = function (f, key) {
    const pos = BF.positions(key, f.k, f.m);
    pos.forEach(function (p) {
        if (f.counts[p] > 0) f.counts[p] -= 1;
        if (f.counts[p] === 0) f.bits[p] = 0;
    });
    const i = f.keys.indexOf(key);
    if (i >= 0) f.keys.splice(i, 1);
    return pos;
};

/** 当前还留在过滤器里的、覆盖了第 pos 位的所有 key */
BF.coveredBy = function (f, pos) {
    return f.keys.filter(function (key) { return BF.positions(key, f.k, f.m).indexOf(pos) >= 0; });
};

/** 假阳性归因：这个 key 的每一位，分别是谁点亮的 */
BF.attribute = function (f, key) {
    return BF.positions(key, f.k, f.m).map(function (p, i) {
        const by = f.setBy[p];
        return {
            i: i, pos: p, bit: f.bits[p], by: by,
            byHash: by ? BF.positions(by, f.k, f.m).indexOf(p) : -1,
            all: BF.coveredBy(f, p),
        };
    });
};

/** 位数组的填充率（1 的比例）*/
BF.fillRatio = function (f) {
    let on = 0;
    for (let i = 0; i < f.m; i++) if (f.bits[i]) on++;
    return on / f.m;
};

/** 理论误判率：p ≈ (1 - e^(-kn/m))^k */
BF.fpRate = function (m, n, k) {
    if (n <= 0) return 0;
    return Math.pow(1 - Math.exp(-k * n / m), k);
};

/** 用「实际填充率」估的误判率：p ≈ fill^k。比理论式更贴近当前这个具体位数组 */
BF.fpRateFromFill = function (f) { return Math.pow(BF.fillRatio(f), f.k); };

/** 最优 k（实数）：k* = (m/n)·ln2 ≈ 0.693·(m/n) */
BF.optimalK = function (m, n) { return (m / Math.max(n, 1)) * Math.LN2; };

/** 最优 k（取整，至少 1）*/
BF.bestK = function (m, n) { return Math.max(1, Math.round(BF.optimalK(m, n))); };

/**
 * 选型：给定预期元素数 n 和可接受误判率 p，算需要多大的位数组和几个哈希。
 * m = -n·ln(p) / (ln2)²      k = (m/n)·ln2 = -log2(p)
 */
BF.designFor = function (n, p) {
    const m = -n * Math.log(p) / (Math.LN2 * Math.LN2);
    const kReal = (m / n) * Math.LN2;
    return {
        m: Math.ceil(m), mExact: m,
        k: Math.max(1, Math.round(kReal)), kExact: kReal,
        bitsPerKey: m / n,
        bytes: Math.ceil(m / 8),
    };
};

/** 实测误判率：插一批、查另一批（两批必须不相交），统计误判比例 */
BF.measureFP = function (m, k, insertKeys, probeKeys) {
    const f = BF.create(m, k);
    insertKeys.forEach(function (x) { BF.insert(f, x); });
    let fp = 0;
    probeKeys.forEach(function (x) { if (BF.query(f, x).maybe) fp++; });
    return { rate: probeKeys.length ? fp / probeKeys.length : 0, fp: fp, n: probeKeys.length, filter: f };
};

/** 在候选里找第一个「没插过、却被判成可能存在」的 key */
BF.firstFalsePositive = function (f, candidates) {
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (f.keys.indexOf(c) >= 0) continue;
        const q = BF.query(f, c);
        if (q.maybe) return { key: c, query: q };
    }
    return null;
};

/** 找一对「位置有重叠」的 key —— 删除灾难需要它们共用至少一位 */
BF.findOverlapPair = function (m, k, candidates) {
    for (let i = 0; i < candidates.length; i++) {
        const pa = BF.positions(candidates[i], k, m);
        for (let j = i + 1; j < candidates.length; j++) {
            const pb = BF.positions(candidates[j], k, m);
            const shared = pa.filter(function (p) { return pb.indexOf(p) >= 0; });
            if (shared.length) {
                return { a: candidates[i], b: candidates[j], shared: shared.filter(function (v, x, arr) { return arr.indexOf(v) === x; }) };
            }
        }
    }
    return null;
};

/**
 * 删除灾难的完整剧本（模型里跑一遍，界面只负责画）：
 * 插 A、插 B（有重叠位）→ 粗暴删 A → 查 B 变成「不存在」= 假阴性。
 * 同一剧本换成计数版，B 还在。
 */
BF.deleteDisaster = function (m, k, candidates) {
    const pair = BF.findOverlapPair(m, k, candidates);
    if (!pair) return null;

    const naive = BF.create(m, k);
    BF.insert(naive, pair.a); BF.insert(naive, pair.b);
    const before = BF.contains(naive, pair.b);
    BF.removeNaive(naive, pair.a);
    const after = BF.contains(naive, pair.b);

    const counting = BF.create(m, k);
    BF.insert(counting, pair.a); BF.insert(counting, pair.b);
    BF.removeCounting(counting, pair.a);
    const afterCounting = BF.contains(counting, pair.b);

    return {
        a: pair.a, b: pair.b, shared: pair.shared,
        before: before, after: after, afterCounting: afterCounting,
        falseNegative: before && !after,
        naive: naive, counting: counting,
    };
};

/** 造一批确定性的 key（测试和界面共用，杜绝随机数）*/
BF.keyRange = function (prefix, from, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(prefix + (from + i));
    return out;
};

/** 大小格式化（Viz.fmtBytes 到 MB 就封顶了，这里要显示到 GB / TB）*/
BF.fmtBytes = function (b) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = b, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + u[i];
};

/** 中文数量：1 亿 / 100 万 */
BF.fmtCount = function (n) {
    if (n >= 1e8) return (n / 1e8) + ' 亿';
    if (n >= 1e4) return (n / 1e4) + ' 万';
    return String(n);
};

if (typeof module !== 'undefined' && module.exports) module.exports = BF;
if (typeof window !== 'undefined') window.BFModel = BF;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

// 演示用的固定 key 池（全部确定性，刷新前后完全一样）
const SEED_KEYS = BF.keyRange('user:', 1001, 8);          // 预先插进去的
const PROBE_KEYS = BF.keyRange('user:', 2001, 600);       // 用来找假阳性的探测池
const DEL_M = 24, DEL_K = 3;                              // 删除演示单独用一个小过滤器

const state = {
    m: 32,
    k: 3,
    keys: SEED_KEYS.slice(),
    trace: null,        // { type:'insert'|'query', key, cursor }
    attrib: false,      // 主视图上是否显示「这一位是谁点亮的」
    keyInput: '',
    focusInput: false,
    probeSeq: 0,
    delMode: 'naive',
    calcN: 1e8,
    calcP: 0.01,
};

/**
 * 每次渲染都按 state.keys 从零重建过滤器 —— 因为 m / k 一变，所有位置都变了。
 * 如果当前有一条「插入」轨迹还没走完，最后那个 key 只应用到 cursor 为止，
 * 这样画面上才是真正的「逐个点亮」，而不是一次全亮。
 */
function buildFilter() {
    const f = BF.create(state.m, state.k);
    f.log = [];
    const t = state.trace;
    const partialIdx = (t && t.type === 'insert') ? state.keys.indexOf(t.key) : -1;
    state.keys.forEach(function (key, idx) {
        f.log.push(idx === partialIdx ? BF.insert(f, key, t.cursor + 1) : BF.insert(f, key));
    });
    return f;
}

/** 当前轨迹最多能走到第几步（查询会短路，所以往往不到 k-1）*/
function traceMax(f) {
    const t = state.trace;
    if (!t) return 0;
    if (t.type === 'insert') return state.k - 1;
    let last = 0;
    BF.query(f, t.key).checks.forEach(function (c) {
        if (!c.skipped && !c.pending) last = c.i;
    });
    return last;
}

// ---------- 位数组图 ----------

/**
 * 画位数组。deco: { 位置 → { cls, top, bottom } }
 * mode = 'bits' 画 0/1；'counts' 画计数器数值。
 */
function buildBits(f, deco, mode, cellMax) {
    deco = deco || {};
    const m = f.m;
    const W = 880, PAD = 10;
    const rows = Math.ceil(m / 32);
    const perRow = Math.ceil(m / rows);
    const cw = Math.min(cellMax || 30, (W - PAD * 2) / perRow);
    const ch = 26, topH = 16, botH = 14, rowH = topH + ch + botH + 8;
    const H = rows * rowH + 4;
    const x0 = (W - perRow * cw) / 2;

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'bf-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '位数组',
    });

    for (let p = 0; p < m; p++) {
        const r = Math.floor(p / perRow), c = p % perRow;
        const x = x0 + c * cw, y = 4 + r * rowH + topH;
        const d = deco[p];
        const val = mode === 'counts' ? f.counts[p] : f.bits[p];
        const on = val > 0;

        let cls = 'bf-bit' + (on ? ' bf-on' : '');
        if (d && d.cls) cls += ' ' + d.cls;
        root.appendChild(svg('rect', { x: x + 1, y: y, width: cw - 2, height: ch, rx: 4, class: cls }));
        root.appendChild(T({
            x: x + cw / 2, y: y + ch / 2 + 4, 'text-anchor': 'middle',
            class: 'bf-bit-txt' + (on ? ' bf-on-txt' : ''),
        }, String(val)));

        if (d && d.top) {
            root.appendChild(T({
                x: x + cw / 2, y: y - 5, 'text-anchor': 'middle',
                class: 'bf-htag' + (d.topCls ? ' ' + d.topCls : ''),
            }, d.top));
        }
        if (d && d.bottom) {
            root.appendChild(T({ x: x + cw / 2, y: y + ch + 11, 'text-anchor': 'middle', class: 'bf-owner' }, d.bottom));
        } else if (cw >= 16 || p % 4 === 0) {
            root.appendChild(T({ x: x + cw / 2, y: y + ch + 11, 'text-anchor': 'middle', class: 'bf-idx' }, String(p)));
        }
    }
    return root;
}

/** 把当前轨迹翻译成位数组上的高亮标记 */
function traceDeco(f) {
    const t = state.trace;
    const deco = {};
    if (!t) return deco;

    if (t.type === 'insert') {
        const tr = f.log[state.keys.indexOf(t.key)];
        if (!tr) return deco;
        tr.steps.forEach(function (s) {
            if (s.pending) return;
            const cur = s.i === t.cursor;
            deco[s.pos] = {
                cls: cur ? 'bf-hit-now' : 'bf-hit',
                top: 'h' + (s.i + 1),
                topCls: cur ? 'bf-htag-now' : '',
            };
        });
        return deco;
    }

    const q = BF.query(f, t.key, t.cursor + 1);
    q.checks.forEach(function (c) {
        if (c.pending || c.skipped) return;
        const cur = c.i === t.cursor;
        deco[c.pos] = {
            cls: c.bit ? (cur ? 'bf-hit-now' : 'bf-hit') : 'bf-hit-fail',
            top: 'h' + (c.i + 1),
            topCls: c.bit ? (cur ? 'bf-htag-now' : '') : 'bf-htag-fail',
        };
    });

    // 假阳性归因：在这几位下面标出「是谁点亮的」
    if (state.attrib) {
        BF.attribute(f, t.key).forEach(function (a) {
            if (!deco[a.pos] || !a.by) return;
            deco[a.pos].bottom = shortKey(a.by);
        });
    }
    return deco;
}

function shortKey(k) { return String(k).split(':').pop(); }

// ---------- 步骤清单 ----------

function buildSteps(f) {
    const t = state.trace;
    const box = h('div.bf-steps');
    if (!t) return box;

    const hh = BF.h1h2(t.key);
    box.appendChild(h('div.bf-hh', {
        html: '先算两个基础哈希：<code>h1 = ' + hh.h1 + '</code>　<code>h2 = ' + hh.h2 + '</code>'
            + '　剩下的位置全靠它俩组合出来（双哈希）。',
    }));

    const rows = [];
    if (t.type === 'insert') {
        const tr = f.log[state.keys.indexOf(t.key)];
        if (!tr) return box;
        tr.steps.forEach(function (s) {
            const formula = 'g' + (s.i + 1) + ' = (h1 + ' + s.i + '×h2) mod ' + state.m + ' = ' + s.pos;
            let res, cls;
            if (s.pending) {
                res = '还没轮到它';
                cls = 'pending';
            } else if (s.dup) {
                res = '第 ' + s.pos + ' 位 —— 和前面某个哈希算出了同一位，白算一次（这很正常）';
                cls = s.i === t.cursor ? 'cur' : 'done';
            } else if (s.was) {
                const by = f.setBy[s.pos];
                res = '第 ' + s.pos + ' 位本来就是 1'
                    + (by && by !== t.key ? '（' + by + ' 早就点亮过它）' : '')
                    + ' → 保持 1，这一步什么也没发生';
                cls = s.i === t.cursor ? 'cur' : 'done';
            } else {
                res = '第 ' + s.pos + ' 位：0 → 1';
                cls = s.i === t.cursor ? 'cur' : 'done';
            }
            rows.push({ n: s.i + 1, title: '第 ' + (s.i + 1) + ' 个哈希函数', f: formula, r: res, cls: cls });
        });
    } else {
        const q = BF.query(f, t.key, t.cursor + 1);
        q.checks.forEach(function (c) {
            const formula = 'g' + (c.i + 1) + ' = (h1 + ' + c.i + '×h2) mod ' + state.m + ' = ' + c.pos;
            let res, cls;
            if (c.skipped) {
                res = '不用算了 —— 前面已经出现 0，答案已经定了';
                cls = 'skip';
            } else if (c.pending) {
                res = '还没轮到它';
                cls = 'pending';
            } else if (c.bit) {
                res = '第 ' + c.pos + ' 位是 1 → 还不能下结论，继续查下一个';
                cls = c.i === t.cursor ? 'cur' : 'done';
            } else {
                res = '第 ' + c.pos + ' 位是 0 → 立刻收工：一定不存在';
                cls = 'fail';
            }
            rows.push({ n: c.i + 1, title: '第 ' + (c.i + 1) + ' 个哈希函数', f: formula, r: res, cls: cls });
        });
    }

    rows.forEach(function (r) {
        box.appendChild(h('div.bf-step.bf-' + r.cls, null,
            h('div.bf-step-n', { text: String(r.n) }),
            h('div.bf-step-body', null,
                h('div.bf-step-t', { text: r.title }),
                h('code.bf-step-f', { text: r.f }),
                h('div.bf-step-r', { text: r.r })
            )
        ));
    });
    return box;
}

/** 结论横幅 */
function buildVerdict(f) {
    const t = state.trace;
    if (!t) {
        return h('div.bf-verdict.bf-v-idle', {
            html: '<i class="fas fa-hand-pointer"></i> 输入一个 key，点「插入」或「查询」，'
                + '就会一步步看到 k 个哈希函数分别落在哪一位。',
        });
    }
    if (t.type === 'insert') {
        const done = t.cursor >= state.k - 1;
        return h('div.bf-verdict.bf-v-ins', {
            html: '<i class="fas fa-pen"></i> 正在插入 <b>' + Viz.esc(t.key) + '</b>：'
                + '已经点亮 ' + (t.cursor + 1) + ' / ' + state.k + ' 个位置。'
                + (done ? '　<b>插完了。注意：过滤器里并没有存下这个 key 本身，只留下了几个 1。</b>' : ''),
        });
    }

    const q = BF.query(f, t.key, t.cursor + 1);
    const known = state.keys.indexOf(t.key) >= 0;
    if (q.verdict === 'pending') {
        return h('div.bf-verdict.bf-v-run', {
            html: '<i class="fas fa-magnifying-glass"></i> 正在查 <b>' + Viz.esc(t.key) + '</b>：'
                + '前 ' + (t.cursor + 1) + ' 位都是 1，还不能下结论 —— 继续。',
        });
    }
    if (q.absent) {
        const bad = q.checks.filter(function (c) { return c.bit === 0; })[0];
        return h('div.bf-verdict.bf-v-no', {
            html: '<i class="fas fa-ban"></i> <b>一定不存在</b>　'
                + '第 ' + (bad.i + 1) + ' 个哈希落在第 ' + bad.pos + ' 位，那里是 0。'
                + '如果 ' + Viz.esc(t.key) + ' 插过，这一位必然被点亮 —— 它是 0，就说明它绝对没插过。'
                + '<b>这个结论 100% 可靠，可以放心打回。</b>',
        });
    }
    if (known) {
        return h('div.bf-verdict.bf-v-yes', {
            html: '<i class="fas fa-check"></i> <b>可能存在</b>　k 个位置全是 1。'
                + '我们从旁边的 key 列表知道它确实插过 —— 但<b>过滤器自己不知道</b>，'
                + '它只能说「可能」，因为这些 1 也可能是别的 key 凑出来的。',
        });
    }
    return h('div.bf-verdict.bf-v-fp', {
        html: '<i class="fas fa-triangle-exclamation"></i> <b>可能存在 —— 但它从来没被插入过。这就是一次假阳性。</b>　'
            + '它的 ' + state.k + ' 个位置碰巧全被别的 key 点亮了。'
            + '往下翻，看看每一位分别是谁点的。',
    });
}

// ---------- 各版块 ----------

function buildMainCard(f) {
    const input = h('input.bp-input.bf-key-input', {
        type: 'text', placeholder: '比如 user:9527', value: state.keyInput,
        oninput: function (e) { state.keyInput = e.target.value; },
    });
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { doInsert(); }
    });

    function pick() {
        const v = (state.keyInput || '').trim();
        return v || null;
    }
    function doInsert() {
        const key = pick();
        if (!key) return;
        if (state.keys.indexOf(key) < 0) state.keys.push(key);
        state.trace = { type: 'insert', key: key, cursor: 0 };
        state.attrib = false;
        state.keyInput = '';
        state.focusInput = true;
        render();
    }
    function doQuery() {
        const key = pick();
        if (!key) return;
        state.trace = { type: 'query', key: key, cursor: 0 };
        state.attrib = false;
        state.focusInput = true;
        render();
    }

    const ctl = h('div.controls', null,
        Viz.slider({
            label: '位数组长度 m', min: 32, max: 128, step: 16, value: state.m,
            fmt: function (v) { return v + ' 位'; },
            onInput: function (v) { state.m = v; state.attrib = false; clampCursor(); render(); },
        }),
        Viz.slider({
            label: '哈希函数个数 k', min: 1, max: 12, step: 1, value: state.k,
            fmt: function (v) { return v + ' 个'; },
            onInput: function (v) { state.k = v; state.attrib = false; clampCursor(); render(); },
        }),
        h('div.ctl-btns', null,
            input,
            h('button.mini.primary', { onclick: doInsert }, '插入'),
            h('button.mini', { onclick: doQuery }, '查询'),
            h('button.mini', {
                onclick: function () {
                    state.probeSeq += 1;
                    state.keyInput = 'user:' + (7000 + state.probeSeq);
                    doQuery();
                },
            }, '查一个没插过的'))
    );

    const maxC = traceMax(f);
    const t = state.trace;
    const nav = h('div.bf-nav', null,
        h('button.mini' + (t && t.cursor < maxC ? '.primary' : '.bf-off'), {
            onclick: function () {
                if (!state.trace || state.trace.cursor >= maxC) return;
                state.trace.cursor += 1; render();
            },
        }, h('i.fas.fa-forward-step'), ' 下一步'),
        h('button.mini' + (t && t.cursor < maxC ? '' : '.bf-off'), {
            onclick: function () {
                if (!state.trace) return;
                state.trace.cursor = maxC; render();
            },
        }, '一步到底'),
        h('button.mini', {
            onclick: function () { state.trace = null; state.attrib = false; render(); },
        }, '清除标记'),
        h('span.bf-progress', {
            text: t ? '第 ' + (t.cursor + 1) + ' / ' + (maxC + 1) + ' 步' : '—',
        })
    );

    const card = Viz.card('fa-filter', '位数组：k 个哈希函数，逐个点亮',
        '过滤器里<b>只有这一排格子</b>，没有存任何 key 本身。'
        + '插入 <code>x</code> 就是把 <code>g1(x) … g' + state.k + '(x)</code> 这 ' + state.k + ' 个位置全置 1；'
        + '查询就是把同样 ' + state.k + ' 个位置挨个看一遍。'
        + '<b>拖动滑块改 m 或 k，所有位置会全部重算</b> —— 因为位置本来就是算出来的，不是存下来的。',
        ctl,
        buildBits(f, traceDeco(f), 'bits'),
        buildVerdict(f),
        nav,
        buildSteps(f),
        buildKeyList(f)
    );
    return card;
}

function clampCursor() {
    if (state.trace && state.trace.cursor > state.k - 1) state.trace.cursor = state.k - 1;
}

function buildKeyList(f) {
    const box = h('div.bf-keys');
    if (!state.keys.length) {
        box.appendChild(h('span.bf-empty', { text: '过滤器是空的 —— 此时任何查询都会得到「一定不存在」。' }));
    }
    state.keys.forEach(function (key) {
        const pos = BF.positions(key, state.k, state.m);
        const chip = h('span.bf-key' + (state.trace && state.trace.key === key ? '.on' : ''), {
            title: '点一下：查询这个 key',
            onclick: function () {
                state.trace = { type: 'query', key: key, cursor: 0 };
                state.attrib = false; render();
            },
        },
            h('b', { text: key }),
            h('i', { text: pos.join(' · ') })
        );
        chip.appendChild(h('span.bf-key-x', {
            title: '把它从 key 列表移除，然后整个重建过滤器',
            text: '✕',
            onclick: function (e) {
                e.stopPropagation();
                state.keys = state.keys.filter(function (x) { return x !== key; });
                if (state.trace && state.trace.key === key) state.trace = null;
                state.attrib = false;
                render();
            },
        }));
        box.appendChild(chip);
    });

    const fill = BF.fillRatio(f);
    return h('div', null,
        h('p.sec-note', {
            html: '<b>已插入的 key（' + state.keys.length + ' 个）</b>　'
                + '点一下就查它；点 ✕ 是把它从列表删掉后<b>整个重建</b>过滤器 —— '
                + '这是布隆过滤器唯一正确的「删除」方式，代价是你得一直留着全部原始 key。'
                + '<br>当前位数组填充率 <b>' + (fill * 100).toFixed(1) + '%</b>'
                + '（' + Math.round(fill * state.m) + ' / ' + state.m + ' 位是 1），'
                + '按填充率估的误判率 <b>' + pct(BF.fpRateFromFill(f)) + '</b>。',
        }),
        box
    );
}

function pct(p) {
    if (p >= 0.1) return (p * 100).toFixed(1) + '%';
    if (p >= 0.001) return (p * 100).toFixed(2) + '%';
    if (p <= 0) return '0';
    return (p * 100).toPrecision(2) + '%';
}

// ---------- 打脸时刻：假阳性 ----------

function buildFpCard(f) {
    const fp = BF.firstFalsePositive(f, PROBE_KEYS);

    const btn = h('button.mini.danger', {
        onclick: function () {
            // 一键回到「必出假阳性」的经典配置：32 位、3 个哈希、8 个 key
            state.m = 32; state.k = 3;
            state.keys = SEED_KEYS.slice();
            const g = BF.create(32, 3);
            state.keys.forEach(function (x) { BF.insert(g, x); });
            const hit = BF.firstFalsePositive(g, PROBE_KEYS);
            if (hit) {
                state.trace = { type: 'query', key: hit.key, cursor: 2 };
                state.attrib = true;
            }
            render();
            if (rootEl) rootEl.scrollIntoView({ block: 'start' });
        },
    }, h('i.fas.fa-bolt'), ' 制造一次假阳性');

    const card = Viz.card('fa-bolt', '打脸时刻：它说「有」，但那个 key 从来没来过',
        '布隆过滤器判「可能存在」的依据，只是<b>那几位都是 1</b> —— 它压根不知道这些 1 是谁点的。'
        + '只要别的 key 恰好把这几位都点亮了，一个从没插入过的 key 也会被判成「可能存在」。');

    card.appendChild(h('div.ctl-btns.bf-fp-btns', null, btn,
        h('button.mini', {
            onclick: function () {
                state.m = 32; state.k = 3; state.keys = SEED_KEYS.slice();
                state.trace = null; state.attrib = false; state.probeSeq = 0; render();
            },
        }, '重置演示')));

    if (!fp) {
        card.appendChild(h('div.seq-note', {
            html: '当前参数（m=' + state.m + '、k=' + state.k + '、n=' + state.keys.length + '）下，'
                + '在 ' + PROBE_KEYS.length + ' 个探测 key 里<b>一个假阳性都没找到</b> —— '
                + '说明位数组相对元素数还很宽裕。把 m 调小、或者多插几个 key，假阳性立刻就会冒出来。',
        }));
        return card;
    }

    const attr = BF.attribute(f, fp.key);
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '第几个哈希' }), h('th', { text: '落在哪一位' }),
        h('th', { text: '这一位的值' }), h('th', { text: '是谁把它点亮的' }),
        h('th', { text: '现在还有谁压在这一位上' })));
    attr.forEach(function (a) {
        tb.appendChild(h('tr', null,
            h('td', { text: 'h' + (a.i + 1) }),
            h('td.mv-strong', { text: '第 ' + a.pos + ' 位' }),
            h('td.ok', { text: String(a.bit) }),
            h('td', { html: a.by ? '<b>' + Viz.esc(a.by) + '</b> 的第 ' + (a.byHash + 1) + ' 个哈希' : '—' }),
            h('td', { text: a.all.join('、') || '—' })));
    });

    card.appendChild(h('div.seq-note', {
        html: '当前这个过滤器（m=' + state.m + '、k=' + state.k + '、已插 ' + state.keys.length + ' 个 key）里，'
            + '第一个中招的是 <b>' + Viz.esc(fp.key) + '</b> —— 它从来没被插入过，却被判成「可能存在」。'
            + '下面这张表把每一位的「肇事者」都点出来了：<b>没有一位是它自己点的。</b>',
    }));
    card.appendChild(h('div.mv-matrix-wrap', null, tb));
    card.appendChild(h('div.bf-punch', {
        html: '<b>反过来永远不会发生。</b>一个真的插入过的 key，它那 k 位<b>一定</b>被自己点成了 1，'
            + '而位数组里的 1 只会越来越多、不会自己变回 0 —— 所以查它必然全中，绝不可能被判成「不存在」。'
            + '<br>一句话：<b>布隆过滤器只会误判「存在」，绝不会误判「不存在」；有假阳性，无假阴性。</b>'
            + '这个不对称就是它的全部价值 —— 只要业务能承受「偶尔多放一个进来」，'
            + '就能拿几十 MB 换掉几十 GB。',
    }));
    return card;
}

// ---------- k 不是越大越好 ----------

function buildKCurve(m, n, kCur) {
    const kOpt = BF.optimalK(m, n);
    const KMAX = Math.max(12, Math.min(20, Math.ceil(kOpt * 2)));
    const W = 880, H = 260, PL = 62, PR = 22, PT = 20, PB = 40;
    const iw = W - PL - PR, ih = H - PT - PB;

    const pts = [];
    for (let k = 1; k <= KMAX; k++) pts.push({ k: k, p: Math.max(BF.fpRate(m, n, k), 1e-12) });
    const logs = pts.map(function (q) { return Math.log10(q.p); });
    let hi = Math.ceil(Math.max.apply(null, logs));
    let lo = Math.floor(Math.min.apply(null, logs));
    if (hi > 0) hi = 0;
    if (lo < hi - 6) lo = hi - 6;
    if (hi - lo < 1) lo = hi - 1;

    const x = function (k) { return PL + ((k - 1) / (KMAX - 1)) * iw; };
    const y = function (p) {
        const v = Math.min(Math.max(Math.log10(Math.max(p, 1e-12)), lo), hi);
        return PT + ih - ((v - lo) / (hi - lo)) * ih;
    };

    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'bf-curve-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '误判率随 k 变化',
    });

    // y 轴（对数）：每一档就是一个数量级
    for (let e = lo; e <= hi; e++) {
        const yy = y(Math.pow(10, e));
        root.appendChild(svg('line', { x1: PL, x2: W - PR, y1: yy, y2: yy, stroke: '#eef0f3' }));
        root.appendChild(T({ x: PL - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis-label' },
            pct(Math.pow(10, e))));
    }
    for (let k = 1; k <= KMAX; k += (KMAX > 14 ? 2 : 1)) {
        root.appendChild(T({ x: x(k), y: H - PB + 18, 'text-anchor': 'middle', class: 'axis-label' }, String(k)));
    }
    root.appendChild(T({ x: PL + iw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' },
        '哈希函数个数 k'));
    root.appendChild(T({ x: 12, y: PT + 4, class: 'axis-title' }, '误判率 p'));

    // 最优 k
    if (kOpt >= 1 && kOpt <= KMAX) {
        root.appendChild(svg('line', {
            x1: x(kOpt), x2: x(kOpt), y1: PT - 4, y2: PT + ih, class: 'bf-kopt-line',
        }));
        root.appendChild(T({ x: x(kOpt) + 6, y: PT + 10, class: 'bf-kopt-label' },
            'k* = 0.693 × m/n ≈ ' + kOpt.toFixed(2)));
    }

    let d = '';
    pts.forEach(function (q, i) { d += (i ? 'L' : 'M') + x(q.k).toFixed(1) + ' ' + y(q.p).toFixed(1); });
    root.appendChild(svg('path', { d: d, class: 'bf-curve' }));

    pts.forEach(function (q) {
        root.appendChild(svg('circle', { cx: x(q.k), cy: y(q.p), r: 3, class: 'bf-curve-dot' }));
    });

    // 曲线最低点
    let best = pts[0];
    pts.forEach(function (q) { if (q.p < best.p) best = q; });
    root.appendChild(svg('circle', { cx: x(best.k), cy: y(best.p), r: 6, class: 'bf-curve-min' }));
    root.appendChild(T({ x: x(best.k), y: y(best.p) + 22, 'text-anchor': 'middle', class: 'bf-min-label' },
        '最低点 k=' + best.k + '（' + pct(best.p) + '）'));

    // 当前 k
    if (kCur <= KMAX) {
        const pc = BF.fpRate(m, n, kCur);
        root.appendChild(svg('line', {
            x1: x(kCur), x2: x(kCur), y1: PT - 4, y2: PT + ih, class: 'bf-kcur-line',
        }));
        root.appendChild(svg('circle', { cx: x(kCur), cy: y(pc), r: 6, class: 'bf-curve-cur' }));
        root.appendChild(T({
            x: Math.min(x(kCur) + 8, W - PR - 120), y: y(pc) - 12, class: 'bf-cur-label',
        }, '当前 k=' + kCur + '　p≈' + pct(pc)));
    }
    return root;
}

function buildKCard() {
    const m = state.m, n = Math.max(state.keys.length, 1), k = state.k;
    const kOpt = BF.optimalK(m, n);
    const kBest = BF.bestK(m, n);
    const pCur = BF.fpRate(m, n, k);
    const pBest = BF.fpRate(m, n, kBest);
    const kBig = Math.min(kBest * 3, 40);
    const pBig = BF.fpRate(m, n, kBig);

    const card = Viz.card('fa-chart-line', '反直觉之二：k 不是越大越好，它有一个最低点',
        '直觉是「多几个哈希 = 多几道关卡 = 更准」。<b>错。</b>'
        + 'k 越大，每插一个 key 就点亮越多位，位数组<b>被填满得越快</b>；'
        + '填满之后随便查什么都是「可能存在」，误判率反而冲上去。'
        + '所以曲线是先降后升的 U 形，最低点在 <code>k* = (m/n)·ln2 ≈ 0.693·(m/n)</code>。'
        + '<br>下面这条曲线用的是<b>你此刻的 m 和已插入的 key 数 n</b> —— 拖 k 滑块，红点跟着跑；'
        + '多插几个 key，整条曲线会往上抬。');

    card.appendChild(buildKCurve(m, n, k));
    card.appendChild(Viz.cmpGrid([
        { h: '当前 k = ' + k, v: pct(pCur), d: '理论误判率', cls: k === kBest ? 'cmp-ok' : 'cmp-bad' },
        { h: '最优 k = ' + kBest, v: pct(pBest), d: 'k* ≈ ' + kOpt.toFixed(2) + '，取整得 ' + kBest, cls: 'cmp-ok' },
        { h: '三倍最优 k = ' + kBig, v: pct(pBig), d: '哈希更多，反而更差 ' + (pBest > 0 ? (pBig / pBest).toFixed(1) + ' 倍' : ''), cls: 'cmp-bad' },
    ]));
    card.appendChild(h('div.ctl-btns.bf-fp-btns', null,
        h('button.mini.primary', {
            onclick: function () { state.k = Math.min(kBest, 12); clampCursor(); render(); },
        }, h('i.fas.fa-crosshairs'), ' 按当前 m、n 算出最优 k（= ' + kBest + '）'),
        h('button.mini', {
            onclick: function () { state.k = Math.min(kBest * 3, 12); clampCursor(); render(); },
        }, '故意调到 3 倍看看'))
    );
    card.appendChild(h('div.seq-note', {
        html: '换个角度记：<b>最优状态下位数组恰好被填满一半</b>（填充率 50%）。'
            + '这不是巧合 —— 把 p = (1-e^(-kn/m))^k 对 k 求导会发现，'
            + '极值点正好落在「每一位是 1 的概率 = 1/2」的地方，此时每一位携带的信息量最大。'
            + '再多加哈希，只是在把更多位提前烧成 1。'
            + '<br>顺带：k 必须取整数，所以真实系统里 <b>k 一般直接取 <code>round(0.693·m/n)</code></b>，'
            + '差一个也无所谓 —— 曲线在最低点附近很平，k 取 6 还是 7 通常只差百分之几。',
    }));
    return card;
}

// ---------- 不能删除 ----------

function buildDeleteCard() {
    const cand = BF.keyRange('user:', 1001, 80);
    const dis = BF.deleteDisaster(DEL_M, DEL_K, cand);
    const counting = state.delMode === 'counting';

    const card = Viz.card('fa-trash-can', '反直觉之三：它不能删除，一删就会产生「假阴性」',
        '删一个 key 的自然想法是把它那 k 位置回 0。'
        + '<b>问题是这些位很可能同时属于别的 key</b> —— 你一置 0，等于顺手把别人也删了。'
        + '那个被误伤的 key 明明还在，却会被判成「一定不存在」= <b>假阴性</b>，'
        + '而「无假阴性」正是布隆过滤器唯一的硬保证。保证一破，整个数据结构就没意义了。');

    if (!dis) { card.appendChild(h('p.sec-note', { text: '（没找到有重叠位的 key 对）' })); return card; }

    card.appendChild(Viz.segmented({
        value: state.delMode,
        options: [
            { v: 'naive', label: '普通布隆（1 位）· 直接置 0' },
            { v: 'counting', label: '计数布隆（4 位计数器）· 减 1' },
        ],
        onPick: function (v) { state.delMode = v; render(); },
    }));

    // 四个阶段，全部静态画出来，不用播放也能一眼看完
    const f = BF.create(DEL_M, DEL_K);
    const posA = BF.positions(dis.a, DEL_K, DEL_M);
    const posB = BF.positions(dis.b, DEL_K, DEL_M);
    const shared = dis.shared;
    const mode = counting ? 'counts' : 'bits';

    const decoOf = function (list, cls) {
        const d = {};
        list.forEach(function (p, i) { d[p] = { cls: cls, top: 'h' + (i + 1) }; });
        shared.forEach(function (p) { d[p] = d[p] || {}; d[p].cls = 'bf-shared'; d[p].bottom = '共用'; });
        return d;
    };

    const stages = [];
    BF.insert(f, dis.a);
    stages.push({
        t: '① 插入 A = ' + dis.a,
        snap: BF.clone(f), deco: decoOf(posA, 'bf-hit'),
        note: 'A 点亮了第 ' + posA.join('、') + ' 位。',
    });

    BF.insert(f, dis.b);
    stages.push({
        t: '② 插入 B = ' + dis.b,
        snap: BF.clone(f), deco: decoOf(posB, 'bf-hit'),
        note: 'B 点亮了第 ' + posB.join('、') + ' 位。注意<b>第 ' + shared.join('、') + ' 位被 A 和 B 共用</b>'
            + (counting ? ' —— 计数版这一格的计数器变成了 2。' : ' —— 1 位的版本根本记不住这件事。'),
    });

    if (counting) BF.removeCounting(f, dis.a); else BF.removeNaive(f, dis.a);
    const dDel = decoOf(posA, 'bf-hit-fail');
    stages.push({
        t: '③ 删除 A' + (counting ? '（计数器各减 1）' : '（把 A 的 3 位直接置 0）'),
        snap: BF.clone(f), deco: dDel,
        note: counting
            ? '共用的第 ' + shared.join('、') + ' 位计数器从 2 减到 1，<b>仍然大于 0，位还是 1</b> —— B 没被误伤。'
            : '共用的第 ' + shared.join('、') + ' 位<b>被一起清零了</b>。'
              + 'A 确实删掉了，但 B 也被顺手打了一枪 —— 过滤器完全不知道这一位还有主。',
    });

    const qB = BF.query(f, dis.b);
    stages.push({
        t: '④ 查询 B = ' + dis.b,
        snap: BF.clone(f),
        deco: (function () {
            const d = {};
            qB.checks.forEach(function (c) {
                if (c.skipped) return;
                d[c.pos] = { cls: c.bit ? 'bf-hit' : 'bf-hit-fail', top: 'h' + (c.i + 1) };
            });
            return d;
        })(),
        note: qB.maybe
            ? '<b>「可能存在」—— 正确。</b>B 从来没被删过，它就应该还在。'
            : '<b>「一定不存在」—— 但 B 明明还在！这就是假阴性。</b>'
              + '布隆过滤器唯一的硬保证在这一刻被打破了：调用方相信「不存在」是绝对可靠的，'
              + '于是直接把请求打回 —— 真实数据就这样被判了死刑。',
    });

    stages.forEach(function (s) {
        card.appendChild(h('div.bf-stage', null,
            h('div.bf-stage-t', { text: s.t }),
            buildBits(s.snap, s.deco, mode, 30),
            h('div.bf-stage-note', { html: s.note })
        ));
    });

    card.appendChild(h('div.bf-punch' + (counting ? '.bf-punch-ok' : ''), {
        html: counting
            ? '<b>计数布隆过滤器（Counting Bloom Filter）就是这么补的</b>：每格从 1 位扩成一个小计数器'
              + '（工程上常用 4 位），插入 +1、删除 -1，减到 0 才真正放掉这一位。'
              + '<br>代价一：<b>空间直接 ×4</b>，布隆过滤器最大的优势被砍掉一截。'
              + '代价二：<b>4 位最大只能数到 15</b>，超过就溢出；溢出后只能让它「饱和」不再增加，'
              + '而饱和的格子<b>永远减不回去</b>了 —— 那一位从此再也不能被释放，误判率只升不降。'
              + '代价三：<b>删除必须保证这个 key 真的插入过</b>，删一个没插过的 key 会把别人的计数减掉，照样制造假阴性。'
            : '<b>所以标准布隆过滤器压根不提供删除接口</b>。要「删」只有两条路：'
              + '① 留着全部原始 key，<b>整个重建</b>一个新的（上面 key 列表里的 ✕ 就是这么干的）；'
              + '② 换成<b>计数布隆过滤器</b> —— 把上面的开关拨到右边看它怎么修好这个问题，以及要付出什么代价。',
    }));
    return card;
}

// ---------- 实际选型计算器 ----------

const HASHSET_BYTES = 64;   // 每元素估算：对象头 + 引用 + 桶数组分摊，JVM HashSet 的量级
const RAW_KEY_BYTES = 20;   // 只存 key 本身（比如一个 20 字节的订单号），理论下界

function buildCalcCard() {
    const n = state.calcN, p = state.calcP;
    const d = BF.designFor(n, p);
    const bloomBytes = d.bytes;
    const setBytes = n * HASHSET_BYTES;
    const rawBytes = n * RAW_KEY_BYTES;

    const card = Viz.card('fa-calculator', '实际选型：给我 n 和 p，我告诉你要多少内存',
        '这两条公式是从误判率公式反解出来的，是布隆过滤器落地时唯一需要算的东西：'
        + '<br><code>m = -n·ln(p) / (ln2)²</code>　　<code>k = (m/n)·ln2 = -log₂(p)</code>'
        + '<br>注意 <b>k 只跟 p 有关，跟 n 一点关系都没有</b> —— 要 1% 误判率，永远是 7 个哈希函数。');

    card.appendChild(h('div.controls', null,
        h('div.ctl', null, h('span.ctl-name', { text: '预期元素数 n' }), Viz.segmented({
            value: n,
            options: [1e4, 1e6, 1e8, 1e9].map(function (v) { return { v: v, label: BF.fmtCount(v) }; }),
            onPick: function (v) { state.calcN = v; render(); },
        })),
        h('div.ctl', null, h('span.ctl-name', { text: '可接受误判率 p' }), Viz.segmented({
            value: p,
            options: [0.1, 0.01, 0.001, 0.0001].map(function (v) { return { v: v, label: pct(v) }; }),
            onPick: function (v) { state.calcP = v; render(); },
        }))
    ));

    card.appendChild(Viz.flowList([
        {
            t: '① 先算位数组要多长',
            f: 'm = -n·ln(p) / (ln2)²\n  = -' + n.toExponential(0) + ' × ln(' + p + ') / 0.4805\n  = ' + d.m.toExponential(3) + ' 位',
            r: '要 ' + d.m.toLocaleString() + ' 位',
        },
        {
            t: '② 换算成「每个 key 摊多少位」',
            f: 'm / n = ' + d.bitsPerKey.toFixed(2) + ' 位/个',
            r: '每个 key 只占 ' + d.bitsPerKey.toFixed(2) + ' 位 ≈ ' + (d.bitsPerKey / 8).toFixed(2) + ' 字节',
            hi: '这里是布隆过滤器最反直觉的地方：<b>每个 key 占多少位，只由误判率 p 决定，跟 key 本身多长完全无关。</b>'
                + 'key 是 8 字节的整数还是 200 字节的 URL，都是 ' + d.bitsPerKey.toFixed(1) + ' 位。'
                + '因为它存的不是 key，是 key 的哈希落点。',
        },
        {
            t: '③ 算哈希函数个数',
            f: 'k = (m/n)·ln2 = ' + d.kExact.toFixed(2) + '　（也等于 -log₂(p)）',
            r: '取整 k = ' + d.k + ' 个',
        },
        {
            t: '④ 换算成实际内存',
            f: 'm / 8 = ' + d.bytes.toLocaleString() + ' 字节',
            r: BF.fmtBytes(bloomBytes),
        },
    ]));

    card.appendChild(Viz.cmpGrid([
        { h: '布隆过滤器', v: BF.fmtBytes(bloomBytes), d: BF.fmtCount(n) + ' 个 key，误判率 ' + pct(p), cls: 'cmp-ok' },
        { h: 'HashSet（估算）', v: BF.fmtBytes(setBytes), d: '按每个元素 ' + HASHSET_BYTES + ' 字节', cls: 'cmp-bad' },
        { h: '省下', v: (setBytes / bloomBytes).toFixed(0) + ' 倍', d: '这就是它存在的理由', cls: 'cmp-save' },
    ]));

    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null, h('th', { text: '方案' }), h('th', { text: '内存' }),
        h('th', { text: '能回答' }), h('th', { text: '会出错吗' })));
    [
        ['布隆过滤器', BF.fmtBytes(bloomBytes), '在不在（可能 / 一定不在）', pct(p) + ' 概率误判「在」，绝不误判「不在」'],
        ['只存原始 key（理论下界）', BF.fmtBytes(rawBytes), '在不在 + 取回 key', '不会出错'],
        ['HashSet（实际）', BF.fmtBytes(setBytes), '在不在 + 取回 key + 遍历', '不会出错'],
    ].forEach(function (r, i) {
        const tr = h('tr' + (i === 0 ? '.on' : ''));
        r.forEach(function (c, j) { tr.appendChild(h('td' + (j === 0 ? '.mv-strong' : ''), { text: c })); });
        tb.appendChild(tr);
    });
    card.appendChild(h('div.mv-matrix-wrap', null, tb));

    card.appendChild(h('div.seq-note', {
        html: '第二行是<b>理论下界</b>：就算你把所有指针、对象头、哈希桶全省掉，只把 ' + BF.fmtCount(n)
            + ' 个 ' + RAW_KEY_BYTES + ' 字节的 key 原样堆在内存里，也要 ' + BF.fmtBytes(rawBytes) + '，'
            + '仍然是布隆过滤器的 <b>' + (rawBytes / bloomBytes).toFixed(0) + ' 倍</b>。'
            + '布隆过滤器能低于这个下界，是因为它<b>根本没打算把 key 存下来</b> —— '
            + '它用「记不住原文、只记得指纹」换掉了绝大部分空间，并且用「偶尔认错人」付了账。'
            + '<br>HashSet 那一行按每元素 ' + HASHSET_BYTES + ' 字节估（JVM 里一个 HashSet 条目'
            + '光对象头 + 引用 + 桶数组分摊就是这个量级，存字符串还要更多），是个粗口径，量级对得上就行。',
    }));
    return card;
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    const f = buildFilter();
    rootEl.innerHTML = '';

    rootEl.appendChild(Viz.card('fa-circle-question', '它解决的是什么问题',
        '你有 1 亿个订单号，要判断某个号「见过没有」。'
        + '用 HashSet 得几 GB 内存；可如果<b>你只需要一个「肯定没见过」的快速否决</b>（比如挡住缓存穿透），'
        + '那就没必要真把 key 存下来。'
        + '<br><b>布隆过滤器的做法：只留一条位数组。</b>'
        + '插入时用 k 个哈希函数把 k 个位置点成 1；查询时看这 k 位 ——'
        + '<b>只要有一位是 0，这个 key 就一定没插过</b>（因为插过的话那一位必然被点亮）；'
        + '全是 1 就只能说「可能存在」，因为这些 1 也可能是别人凑出来的。'
        + '<br>代价明码标价：<b>有假阳性，无假阴性。</b>下面每一块都在拆这句话。'));

    rootEl.appendChild(buildMainCard(f));
    rootEl.appendChild(buildFpCard(f));
    rootEl.appendChild(buildKCard());
    rootEl.appendChild(buildDeleteCard());
    rootEl.appendChild(buildCalcCard());

    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        {
            q: '布隆过滤器怎么防缓存穿透？',
            a: '穿透的定义是「查一个<b>数据库里根本不存在</b>的 key」：缓存查不到 → 打到库 → 库也没有 → 不写缓存 → '
                + '下次照样穿。恶意流量拿随机 ID 刷接口就是这么打垮数据库的。'
                + '<br><b>做法</b>：启动时把数据库里<b>所有存在的主键</b>灌进布隆过滤器（一般几十 MB 就够），'
                + '请求先过一遍它 —— 判「一定不存在」的<b>直接返回，连 Redis 都不用查</b>。'
                + '<br><b>为什么正好合适</b>：它的错误方向刚好是无害的那一边。'
                + '假阳性只是「漏放一个不存在的 key 进来」，那个请求会走完原来的老流程（查缓存 → 查库 → 返回空），'
                + '<b>正确性一点没变，只是没挡住</b>；而假阴性（误杀真实存在的 key）会直接导致业务查不到数据 —— '
                + '偏偏这个它<b>保证不会发生</b>。'
                + '<br><b>坑</b>：新增数据必须<b>同步写进过滤器</b>（一般在写库成功后补一次），'
                + '否则新数据会被当成不存在直接打回，那就真出线上事故了。删除数据则删不掉，只能靠定期重建。',
        },
        {
            q: '为什么 Redis 的布隆过滤器是「模块」而不是原生命令？',
            a: 'Redis 核心一直刻意保持小而稳：进核心的数据结构要通用、参数少、语义无歧义。'
                + '布隆过滤器偏偏反过来 —— 它<b>必须先给出 n 和 p 才能确定 m 和 k</b>，还要定义扩容策略'
                + '（RedisBloom 的 <code>SCALABLE</code> 用的是层叠多个子过滤器）、持久化格式、'
                + '以及一整个概率型数据结构家族（Cuckoo、Count-Min Sketch、Top-K、t-digest）要不要一起进来。'
                + '这类「有调参、有取舍、还会持续演进」的东西，正是 Redis 4.0 引入<b>模块机制</b>要装的。'
                + '<br>所以官方把它做成了 <b>RedisBloom</b> 模块（<code>BF.ADD</code> / <code>BF.EXISTS</code> / '
                + '<code>BF.RESERVE</code>），后来打包进 Redis Stack。'
                + '<b>需要注意的是</b>：较新的 Redis 发行版已经把这几个概率型数据结构随包分发了，'
                + '「Redis 不支持布隆过滤器」这个说法现在要看版本，别背死。'
                + '<br>另外，不装模块也能<b>自己手搓</b>：用 <code>SETBIT</code> / <code>GETBIT</code> 在一个 String 上做位数组，'
                + '哈希在客户端算。上限是单个 String 512MB = 2³² 位，够存几亿个 key 了。',
        },
        {
            q: '布谷鸟过滤器（Cuckoo Filter）比它强在哪？',
            a: '① <b>支持删除</b>，而且是真删 —— 它存的是 key 的<b>指纹</b>（几位短哈希），删除时把对应桶里那个指纹拿掉即可，'
                + '不像布隆那样一位被多个 key 共用。'
                + '<br>② <b>局部性好</b>：一次查询只看 2 个桶（布谷鸟哈希的两个候选位置），'
                + '基本就是 2 次 cache miss；布隆的 k 个位置<b>散落在整个数组里</b>，k=7 就是 7 次随机访问，'
                + '过滤器一大就全是 cache miss，这在高 QPS 下差别很明显。'
                + '<br>③ 在<b>误判率较低时（大约 p &lt; 3%）空间反而更省</b>。'
                + '<br><b>代价</b>：插入可能<b>失败</b> —— 桶满了要把老指纹踢走重新安置（这就是「布谷鸟」的由来），'
                + '踢的链条太长就宣告插入失败，所以装载率不能顶满（一般到 95% 就该扩容）。'
                + '而布隆过滤器<b>插入永远成功</b>，只是误判率悄悄变高。'
                + '另外同一个 key 不能无限次插入（指纹副本数有上限），删除也必须保证这个 key 真的插过。',
        },
        {
            q: 'HyperLogLog 和它是一回事吗？',
            a: '<b>完全不是，它俩回答的是两个不同的问题。</b>'
                + '<br>布隆过滤器回答 <b>「x 在不在？」</b>（成员判定 / membership）。'
                + '<br>HyperLogLog 回答 <b>「一共有多少个不同的元素？」</b>（基数估计 / cardinality），'
                + '它<b>根本没法判断某个具体的 x 在不在</b> —— 它只记住了哈希值前导零的最大长度这类统计量，'
                + '个体信息早就丢光了。'
                + '<br>容易混是因为两者气质像：都是概率型、都用哈希、都用极小空间换一点误差。'
                + '但误差的含义也不同：布隆是<b>「个别 key 判错」</b>，HLL 是<b>「总数估偏」</b>'
                + '（Redis 实现固定 12KB，标准误差 0.81%，能估到 2⁶⁴ 量级的基数）。'
                + '<br>一句话记：<b>要问「在不在」用布隆，要问「有几个不重样的」用 HLL，'
                + '要问「大概出现了多少次」用 Count-Min Sketch。</b>',
        },
        {
            q: '数据一直在增长怎么办？',
            a: '布隆过滤器<b>不能扩容</b> —— 位数组一长，所有位置全变，而原始 key 早就不在里面了，没法 rehash。'
                + '工程上三条路：① <b>按峰值容量预分配</b>，宁可多给点内存；'
                + '② <b>可扩展布隆过滤器</b>（RedisBloom 的 SCALABLE）：满了就再挂一层新的、误判率更严的子过滤器，'
                + '查询要<b>逐层查</b>，层数越多越慢，总误判率是各层的叠加；'
                + '③ <b>定期全量重建 + 双缓冲</b>：后台用全量数据建新的，建好原子切换 —— '
                + '这也是同时解决「删除」问题的标准做法。',
        },
    ])));

    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls([
        ['不能删除，删了就有假阴性',
            '一位被多个 key 共用，置 0 会误伤别人 —— 上面第三块演示的就是这个。'
            + '计数布隆过滤器能删，但<b>空间 ×4</b>，而且 4 位计数器最多数到 15，'
            + '<b>溢出后只能饱和，饱和的格子永远减不回去</b>，那一位从此报废。'],
        ['n 一旦超过设计值，误判率会飙升，而且降不回来',
            '按 n=1000 万设计的过滤器，真塞进 5000 万，误判率会从 1% 涨到几十个百分点。'
            + '更要命的是<b>没有回头路</b>：位已经是 1 了，你既删不掉也不知道是谁点的，'
            + '连「删掉一部分老数据来降低填充率」都做不到。<b>唯一出路是重建一个更大的。</b>'
            + '所以上线前一定要按<b>峰值</b>估 n，并监控实际填充率（超过 50% 就该警觉了）。'],
        ['它只能回答「在不在」，别的什么都问不了',
            '<b>不能取出元素</b>（存的是位，不是 key）、<b>不能遍历</b>、<b>不能计数</b>、<b>不能存 value</b>、'
            + '<b>不能做交并差</b>（除非两个过滤器的 m、k、哈希函数完全一致，才能按位与 / 或）。'
            + '如果业务上「以后可能要把这些 key 列出来」，那从一开始就不该用它。'],
        ['多个哈希函数必须足够独立，否则误判率会明显恶化',
            '常见的错误写法是 <code>hash(key) + i</code> 或 <code>hash(key) * i</code> —— '
            + '这类线性相关的构造会让 k 个位置<b>扎堆在一小段区域</b>，等效于哈希数变少，误判率上升。'
            + '正确做法是本演示用的<b>双哈希</b> <code>g_i = h1 + i·h2</code>：'
            + '只算两次强哈希（且 h2 取奇数保证能走遍整个数组），效果与 k 个独立哈希渐近等价 —— '
            + '这是 Kirsch–Mitzenmacher 的经典结论，也是工业实现的默认选择。'],
        ['「1% 误判率」不是「1% 的请求会出错」',
            'p 是<b>「查一个未插入元素时被误判的概率」</b>。'
            + '真实系统里还要乘上「未命中流量占比」：如果 99% 的请求查的都是真实存在的 key，'
            + '那实际被误放行的请求只有 <code>1% × 1% = 0.01%</code>。'
            + '反过来，如果你是在扛一波恶意的随机 ID 攻击（几乎 100% 未命中），那 1% 就是实打实的 1%。'],
    ])));

    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示（做了哪些简化）' }),
        h('p', {
            html: '<b>哈希函数</b>：用的是 FNV-1a（加一轮 murmur3 风格的收尾混淆）+ <b>双哈希</b> '
                + '<code>g_i(x) = (h1(x) + i·h2(x)) mod m</code>，全程确定性、不用随机数，'
                + '所以你刷新页面、或者把 m 调走再调回来，位置分布完全一样。'
                + '真实系统常用 MurmurHash3 / xxHash，思路一致。',
        }),
        h('p', {
            html: '<b>位数组是用普通数组模拟的</b>，每个元素存 0/1，只为画图方便；'
                + '真实实现是一条紧凑的 bitmap，m 位就占 m/8 字节。演示里的 m 只有 32~128 位，'
                + '是为了让每一位都看得见 —— 真实场景里 m 动辄上亿。',
        }),
        h('p', {
            html: '<b>误判率公式 <code>p ≈ (1 - e^(-kn/m))^k</code> 是近似式</b>：'
                + '它假设 k 个哈希互相独立、并且用「期望填充率」代替了「实际填充率」。'
                + '实测值和它通常有几个百分点的相对偏差，位数组较小时偏差更明显。'
                + '本演示的 key 列表旁边同时给了<b>按实际填充率算的 <code>fill^k</code></b>，'
                + '那个更贴近眼前这个具体的位数组。',
        }),
        h('p', {
            html: '<b>「谁点亮了这一位」是演示专用的作弊数据</b>（<code>setBy</code> 数组）。'
                + '真实的布隆过滤器<b>绝对不知道</b>这件事 —— 它只有 0 和 1。'
                + '正因为不知道，它才无法删除、也无法解释自己为什么判「可能存在」。',
        }),
        h('p', {
            html: '<b>内存对比是量级估算</b>：HashSet 按每元素 ' + HASHSET_BYTES + ' 字节、原始 key 按 '
                + RAW_KEY_BYTES + ' 字节计。真实数字随语言、JVM 参数、key 长度浮动，'
                + '但「差一到两个数量级」这个结论是稳的。',
        })
    ));

    if (state.focusInput) {
        state.focusInput = false;
        const inp = rootEl.querySelector('.bf-key-input');
        if (inp) inp.focus();
    }
}

Viz.register({
    id: 'bloom-filter',
    cat: 'sys',
    title: '布隆过滤器',
    subtitle: '位数组 · 多哈希 · 假阳性',
    icon: 'fa-filter',
    blurb: '用几十 MB 判断一亿个 key 在不在，代价是偶尔会误判「在」',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.m = 32;
        state.k = 3;
        state.keys = SEED_KEYS.slice();
        state.trace = { type: 'query', key: SEED_KEYS[0], cursor: 2 };
        state.attrib = false;
        state.keyInput = '';
        state.probeSeq = 0;
        state.delMode = 'naive';
        state.calcN = 1e8;
        state.calcP = 0.01;
        render();
    },
    unmount() {
        state.trace = null;
        rootEl = null;
    },
});

})();
