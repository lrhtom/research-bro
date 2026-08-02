// ============================================================
//  演示：一致性哈希 Consistent Hashing
//  取模分片一加机器就要搬走 N/(N+1) 的数据，一致性哈希只搬 1/(N+1)。
//  这里把「哈希环 → key 归属 → 加/删节点的迁移量 → 虚拟节点治倾斜」一路画出来。
//  上半 CH.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const CH = {};

/** 环的大小：2^32，也就是哈希值的取值范围 */
CH.RING = 4294967296;

/**
 * 哈希函数：FNV-1a（32 位）+ 一步 xorshift-multiply 混合。
 *
 * 为什么要多加那一步混合：FNV-1a 本身的高位扩散不错，但低位雪崩偏弱，
 * 而「取模分片」恰恰只看低位（hash % N），不混一下会放大它的毛病，
 * 那样两种方案的对照就不公平了。这一步用的是 MurmurHash3 fmix32 的同款套路。
 *
 * 真实系统用什么：libketama 用 MD5，Redis Cluster 用 CRC16，
 * 很多自研分片用 MurmurHash3 —— 换哪个都行，只要「确定性 + 分布均匀」。
 */
CH.hash = function (str) {
    let h = 0x811c9dc5;                            // FNV-1a 32 位偏移基
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h ^= c & 0xff;
        h = Math.imul(h, 0x01000193);              // FNV 质数 16777619
        const hi = c >>> 8;                        // 中文等多字节字符，高位字节也要吃进去
        if (hi) { h ^= hi; h = Math.imul(h, 0x01000193); }
    }
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;                                // 无符号 32 位
};

/** 机器池。addr 才是参与哈希的那个字符串（真实系统里通常就是 ip:port）*/
CH.POOL = [
    { id: 'A', addr: '10.0.0.11:6379', color: '#4f46e5' },
    { id: 'B', addr: '10.0.0.12:6379', color: '#10b981' },
    { id: 'C', addr: '10.0.0.13:6379', color: '#f97316' },
    { id: 'D', addr: '10.0.0.14:6379', color: '#ec4899' },
    { id: 'E', addr: '10.0.0.15:6379', color: '#0ea5e9' },
    { id: 'F', addr: '10.0.0.16:6379', color: '#a855f7' },
    { id: 'G', addr: '10.0.0.17:6379', color: '#f59e0b' },
    { id: 'H', addr: '10.0.0.18:6379', color: '#14b8a6' },
];

CH.nodesByIds = function (ids) {
    return ids.map((id) => CH.POOL.find((n) => n.id === id)).filter(Boolean);
};

/** 造一批可复现的 key（不用随机数，刷新前后必须一模一样）*/
CH.keys = function (n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push('user:' + (10000 + i));
    return out;
};

/**
 * 建环：每台机器放 vnodes 个虚拟节点，按哈希值排好序。
 * 虚拟节点的种子是 `addr#i` —— libketama 是对 `addr-i` 做 MD5，思路一样。
 *
 * 排序必须完全确定：哈希撞了再按 id、序号排。
 * 这样「先加 A 再加 B」和「先加 B 再加 A」得到的环一模一样（顺序无关性）。
 */
CH.buildRing = function (nodes, vnodes) {
    const v = Math.max(1, vnodes | 0);
    const ring = [];
    nodes.forEach((n) => {
        for (let i = 0; i < v; i++) {
            ring.push({ h: CH.hash(n.addr + '#' + i), id: n.id, vi: i });
        }
    });
    ring.sort((a, b) => (a.h - b.h)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        || (a.vi - b.vi));
    return ring;
};

/**
 * 顺时针找第一个 >= keyHash 的环上点，找不到就绕回第一个（环是闭合的）。
 * 二分查找，O(log 环上点数)。环为空时返回 -1，绝不死循环。
 */
CH.lookupIndex = function (ring, keyHash) {
    if (!ring || !ring.length) return -1;
    let lo = 0, hi = ring.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ring[mid].h >= keyHash) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans === -1 ? 0 : ans;                  // 越过最大的那个点 → 绕回环的开头
};

/** key 归谁：环为空返回 null（调用方自己决定怎么处理，别假装有节点）*/
CH.lookup = function (ring, keyHash) {
    const i = CH.lookupIndex(ring, keyHash);
    return i < 0 ? null : ring[i].id;
};

/** 整批 key 的归属表：{ key: nodeId } */
CH.assign = function (ring, keys) {
    const out = {};
    for (let i = 0; i < keys.length; i++) out[keys[i]] = CH.lookup(ring, CH.hash(keys[i]));
    return out;
};

/** 对照组：老老实实的取模分片 hash(key) % N */
CH.modAssign = function (nodes, keys) {
    const out = {};
    const n = nodes.length;
    for (let i = 0; i < keys.length; i++) {
        out[keys[i]] = n ? nodes[CH.hash(keys[i]) % n].id : null;
    }
    return out;
};

/**
 * 两张归属表的差异 = 这次变更要搬多少数据。
 * dest 记录「搬到哪去了」，src 记录「从哪搬走的」—— 判定不变量全靠这两个。
 */
CH.diff = function (before, after, keys) {
    const moved = [], dest = {}, src = {};
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i], f = before[k], t = after[k];
        if (f !== t) {
            moved.push({ key: k, from: f, to: t });
            dest[t] = (dest[t] || 0) + 1;
            src[f] = (src[f] || 0) + 1;
        }
    }
    return {
        moved, dest, src,
        count: moved.length,
        ratio: keys.length ? moved.length / keys.length : 0,
    };
};

/** 负载统计：每台机器几个 key、标准差、变异系数、最大最小比 */
CH.stats = function (assign, nodes) {
    const counts = {};
    nodes.forEach((n) => { counts[n.id] = 0; });
    Object.keys(assign).forEach((k) => {
        const id = assign[k];
        if (id != null && counts[id] !== undefined) counts[id]++;
    });
    const vals = nodes.map((n) => counts[n.id]);
    const total = vals.reduce((a, b) => a + b, 0);
    const mean = vals.length ? total / vals.length : 0;
    const varr = vals.length
        ? vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length : 0;
    const sd = Math.sqrt(varr);
    const max = vals.length ? Math.max.apply(null, vals) : 0;
    const min = vals.length ? Math.min.apply(null, vals) : 0;
    return {
        counts, vals, total, mean, sd,
        cv: mean ? sd / mean : 0,                 // 变异系数：标准差 ÷ 平均值，跨规模可比
        max, min,
        ratio: min ? max / min : Infinity,
    };
};

/**
 * 把环切成一段段「辖区」：ring[i] 管的是「上一个点之后到自己」这一段。
 * 返回的 span 加起来必须正好等于 2^32（画扇区和算理论占比都靠它）。
 */
CH.arcs = function (ring) {
    if (!ring.length) return [];
    if (ring.length === 1) {
        return [{ from: ring[0].h, to: ring[0].h, id: ring[0].id, span: CH.RING, full: true }];
    }
    const out = [];
    for (let i = 0; i < ring.length; i++) {
        const cur = ring[i];
        const prev = ring[(i - 1 + ring.length) % ring.length];
        // 第 0 个点的辖区要绕过环上的 0 点，长度得拆成两截加起来
        const span = i === 0 ? cur.h + (CH.RING - prev.h) : cur.h - prev.h;
        out.push({ from: prev.h, to: cur.h, id: cur.id, span, wrap: i === 0 });
    }
    return out;
};

/** 每台机器占了环空间的百分之几（和 key 无关的理论占比）*/
CH.shares = function (ring) {
    const out = {};
    CH.arcs(ring).forEach((a) => { out[a.id] = (out[a.id] || 0) + a.span / CH.RING; });
    return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = CH;
if (typeof window !== 'undefined') window.CHModel = CH;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const DEFAULTS = { ids: ['A', 'B', 'C', 'D', 'E'], vnodes: 1, keyCount: 3000 };

const state = {
    ids: DEFAULTS.ids.slice(),
    vnodes: DEFAULTS.vnodes,
    keyCount: DEFAULTS.keyCount,
    delId: null,          // null = 自动选负载最重的那台
};

const ui = {};            // 需要局部重画的容器 + 滑块引用
let rootEl = null;
let keyCache = { n: -1, list: null };
let convCache = { sig: '', data: null };

function keyList() {
    if (keyCache.n !== state.keyCount) keyCache = { n: state.keyCount, list: CH.keys(state.keyCount) };
    return keyCache.list;
}

function colorOf(id) {
    const n = CH.POOL.find((x) => x.id === id);
    return n ? n.color : '#9ca3af';
}

function pct(x, d) { return (x * 100).toFixed(d == null ? 1 : d) + '%'; }

// ---------- 每次重画前先把数据全算一遍 ----------

function compute() {
    const keys = keyList();
    const nodes = CH.nodesByIds(state.ids);
    const ring = CH.buildRing(nodes, state.vnodes);
    const asg = CH.assign(ring, keys);
    const st = CH.stats(asg, nodes);

    // 加一台机器：一致性哈希 vs 取模
    const nextNode = CH.POOL.find((n) => state.ids.indexOf(n.id) === -1);
    let add = null;
    if (nextNode) {
        const nodes2 = nodes.concat([nextNode]);
        const asg2 = CH.assign(CH.buildRing(nodes2, state.vnodes), keys);
        const mod1 = CH.modAssign(nodes, keys);
        const mod2 = CH.modAssign(nodes2, keys);
        const dCH = CH.diff(asg, asg2, keys);
        const dMod = CH.diff(mod1, mod2, keys);
        add = {
            newId: nextNode.id, nodes2, asg2, mod1, mod2, dCH, dMod,
            chToOld: dCH.count - (dCH.dest[nextNode.id] || 0),      // 老节点之间互搬了多少（应为 0）
            modToOld: dMod.count - (dMod.dest[nextNode.id] || 0),
        };
    }

    // 删一台机器
    let delId = state.delId;
    if (state.ids.indexOf(delId) === -1) {
        delId = state.ids.slice().sort((a, b) => st.counts[b] - st.counts[a])[0] || null;
    }
    let del = null;
    if (delId && state.ids.length > 1) {
        const rest = nodes.filter((n) => n.id !== delId);
        const asgD = CH.assign(CH.buildRing(rest, state.vnodes), keys);
        const dCH = CH.diff(asg, asgD, keys);
        const mod1 = CH.modAssign(nodes, keys);
        const mod2 = CH.modAssign(rest, keys);
        const dMod = CH.diff(mod1, mod2, keys);
        del = {
            delId, rest, asgD, dCH, dMod,
            fromOthers: dCH.count - (dCH.src[delId] || 0),          // 不是它的 key 也被搬了？应为 0
            stAfter: CH.stats(asgD, rest),
        };
    }

    return { keys, nodes, ring, asg, st, add, del, delId };
}

/** 虚拟节点扫描：不同 vnodes 下的均衡度 + 迁移比例。只跟节点数/key 数有关，缓存住 */
const SWEEP = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 160, 200, 256, 320, 400, 500];

function sweep() {
    const sig = state.ids.join('') + '/' + state.keyCount;
    if (convCache.sig === sig) return convCache.data;
    const keys = keyList();
    const nodes = CH.nodesByIds(state.ids);
    const nextNode = CH.POOL.find((n) => state.ids.indexOf(n.id) === -1);
    const data = SWEEP.map((v) => {
        const ring = CH.buildRing(nodes, v);
        const asg = CH.assign(ring, keys);
        const st = CH.stats(asg, nodes);
        let mig = null;
        if (nextNode) {
            const asg2 = CH.assign(CH.buildRing(nodes.concat([nextNode]), v), keys);
            mig = CH.diff(asg, asg2, keys).ratio;
        }
        return { v, sd: st.sd, cv: st.cv, ratio: st.ratio, mig };
    });
    convCache = { sig, data };
    return data;
}

// ---------- 主视图：哈希环 ----------

const RW = 780, RH = 434, CX = 226, CY = 216;
const R_OUT = 172, R_IN = 149, R_WALK = 138, R_KEY = 127, R_LAB = 192;

function ang(hash) { return -Math.PI / 2 + (hash / CH.RING) * Math.PI * 2; }
function PX(r, a) { return (CX + r * Math.cos(a)).toFixed(2); }
function PY(r, a) { return (CY + r * Math.sin(a)).toFixed(2); }

function sectorPath(a0, a1) {
    if (a1 <= a0) a1 += Math.PI * 2;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    return `M${PX(R_OUT, a0)} ${PY(R_OUT, a0)}`
        + `A${R_OUT} ${R_OUT} 0 ${large} 1 ${PX(R_OUT, a1)} ${PY(R_OUT, a1)}`
        + `L${PX(R_IN, a1)} ${PY(R_IN, a1)}`
        + `A${R_IN} ${R_IN} 0 ${large} 0 ${PX(R_IN, a0)} ${PY(R_IN, a0)}Z`;
}

/**
 * 环上的彩带。虚拟节点一多，扇区就碎成上千片，逐片画既慢又没必要，
 * 所以超过阈值就改成「按 480 个角度桶采样、相邻同色合并」——
 * 画出来就是那条细密的彩带，恰好也就是虚拟节点想要的效果。
 */
function bandSegments(ring) {
    if (!ring.length) return [];
    const arcs = CH.arcs(ring);
    if (arcs.length === 1) return [{ full: true, id: arcs[0].id }];
    if (arcs.length <= 160) {
        return arcs.map((a) => ({ a0: ang(a.from), a1: ang(a.to), id: a.id }));
    }
    const N = 480, out = [];
    let cur = null;
    for (let b = 0; b < N; b++) {
        const id = CH.lookup(ring, Math.floor(((b + 0.5) / N) * CH.RING));
        if (cur && cur.id === id) cur.a1 = ang(((b + 1) / N) * CH.RING);
        else {
            cur = { a0: ang((b / N) * CH.RING), a1: ang(((b + 1) / N) * CH.RING), id };
            out.push(cur);
        }
    }
    return out;
}

function buildRingView(cx) {
    const { ring, nodes, asg, st, keys } = cx;
    const box = h('div');

    const dotted = ring.length <= 60;
    const walk = ring.length <= 26;
    box.appendChild(h('p.sec-note', {
        html: `环上一圈是 <code>0 ~ 2³²</code> 的哈希空间，顺时针方向。`
            + `<b>一个 key 落在环上后，顺时针撞见的第一台机器就是它的家</b>——`
            + `所以彩色扇区就是每台机器的辖区。`
            + (state.vnodes === 1
                ? '现在每台机器只有 <b>1 个</b>点，扇区大小完全看运气，一眼就能看出哪台被塞爆了。'
                : `现在每台机器有 <b>${state.vnodes}</b> 个虚拟节点，环上一共 <b>${ring.length}</b> 个点，`
                  + '碎成细密彩带 —— 这正是虚拟节点在干的事：把大块辖区打散重新掺匀。'
                  + (dotted ? '' : '（点太密了，就不逐个画了，只画彩带。）')),
    }));

    const s = svg('svg', {
        viewBox: `0 0 ${RW} ${RH}`, class: 'ch-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '一致性哈希环',
    });

    // 环底色
    s.appendChild(svg('circle', { cx: CX, cy: CY, r: (R_OUT + R_IN) / 2, fill: 'none', stroke: '#eef0f3', 'stroke-width': R_OUT - R_IN }));

    // 扇区
    bandSegments(ring).forEach((sg) => {
        if (sg.full) {
            s.appendChild(svg('circle', {
                cx: CX, cy: CY, r: (R_OUT + R_IN) / 2, fill: 'none',
                stroke: colorOf(sg.id), 'stroke-width': R_OUT - R_IN, opacity: 0.75,
            }));
            return;
        }
        s.appendChild(svg('path', { d: sectorPath(sg.a0, sg.a1), fill: colorOf(sg.id), opacity: 0.75, class: 'ch-seg' }));
    });

    // 刻度：0 / ¼ / ½ / ¾
    [[0, '0'], [0.25, '¼·2³²'], [0.5, '½·2³²'], [0.75, '¾·2³²']].forEach(([f, lb]) => {
        const a = ang(f * CH.RING);
        s.appendChild(svg('line', {
            x1: PX(R_OUT, a), y1: PY(R_OUT, a), x2: PX(R_OUT + 6, a), y2: PY(R_OUT + 6, a),
            stroke: '#cbd2dc', 'stroke-width': 1,
        }));
        const tx = Number(PX(R_OUT + 15, a)), ty = Number(PY(R_OUT + 15, a));
        s.appendChild(T({
            x: tx, y: ty + 3, class: 'ch-tick',
            'text-anchor': Math.abs(Math.cos(a)) < 0.3 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end'),
        }, lb));
    });

    // 顺时针指示
    s.appendChild(svg('path', {
        d: `M${PX(R_OUT + 26, ang(CH.RING * 0.055))} ${PY(R_OUT + 26, ang(CH.RING * 0.055))}`
            + `A${R_OUT + 26} ${R_OUT + 26} 0 0 1 ${PX(R_OUT + 26, ang(CH.RING * 0.115))} ${PY(R_OUT + 26, ang(CH.RING * 0.115))}`,
        fill: 'none', stroke: '#9ca3af', 'stroke-width': 1.4, 'marker-end': '',
    }));
    s.appendChild(T({
        x: PX(R_OUT + 34, ang(CH.RING * 0.085)), y: PY(R_OUT + 34, ang(CH.RING * 0.085)),
        class: 'ch-tick', 'text-anchor': 'start',
    }, '顺时针 →'));

    // key 小点（只画前若干个，统计用的是全部）
    const shown = Math.min(keys.length, 56);
    for (let i = 0; i < shown; i++) {
        const k = keys[i];
        const kh = CH.hash(k);
        const a = ang(kh);
        const owner = asg[k];
        if (walk && owner != null) {
            // 把「顺时针走到第一个节点」这一步真的画出来
            const oi = CH.lookupIndex(ring, kh);
            let a2 = ang(ring[oi].h);
            if (a2 <= a) a2 += Math.PI * 2;
            const large = (a2 - a) > Math.PI ? 1 : 0;
            s.appendChild(svg('path', {
                d: `M${PX(R_WALK, a)} ${PY(R_WALK, a)}A${R_WALK} ${R_WALK} 0 ${large} 1 ${PX(R_WALK, a2)} ${PY(R_WALK, a2)}`,
                class: 'ch-walk', stroke: colorOf(owner),
            }));
        }
        s.appendChild(svg('circle', {
            cx: PX(R_KEY, a), cy: PY(R_KEY, a), r: 2.8,
            fill: colorOf(owner), class: 'ch-key-dot',
        }));
    }
    s.appendChild(T({ x: CX, y: CY - 6, class: 'ch-center-a', 'text-anchor': 'middle' }, '哈希环'));
    s.appendChild(T({ x: CX, y: CY + 12, class: 'ch-center-b', 'text-anchor': 'middle' },
        `${nodes.length} 台机器 · ${ring.length} 个环上点`));
    s.appendChild(T({ x: CX, y: CY + 28, class: 'ch-center-b', 'text-anchor': 'middle' },
        `环上画了前 ${shown} 个 key`));

    // 节点点位
    if (dotted) {
        ring.forEach((e) => {
            const a = ang(e.h);
            const g = svg('g');
            g.appendChild(svg('circle', {
                cx: PX((R_OUT + R_IN) / 2, a), cy: PY((R_OUT + R_IN) / 2, a),
                r: state.vnodes === 1 ? 8 : 3.4, fill: colorOf(e.id), class: 'ch-node-dot',
            }));
            if (state.vnodes === 1) {
                const tt = svg('title');
                tt.textContent = `点一下删掉 ${e.id}（${CH.POOL.find((n) => n.id === e.id).addr}）`;
                g.appendChild(tt);
                g.addEventListener('click', () => removeNode(e.id));
                g.setAttribute('style', 'cursor:pointer');
                const la = ang(e.h);
                s.appendChild(T({
                    x: PX(R_LAB, la), y: Number(PY(R_LAB, la)) + 4, class: 'ch-node-label',
                    fill: colorOf(e.id),
                    'text-anchor': Math.abs(Math.cos(la)) < 0.25 ? 'middle' : (Math.cos(la) > 0 ? 'start' : 'end'),
                }, e.id));
            }
            s.appendChild(g);
        });
    }

    // 右侧：每台机器的成绩单（点一下可以删）
    const px0 = 438, rowH = 34;
    s.appendChild(T({ x: px0, y: 34, class: 'ch-panel-head' }, '每台机器分到多少 key'));
    s.appendChild(T({ x: RW - 6, y: 34, class: 'ch-panel-head', 'text-anchor': 'end' }, '点一行 = 删掉它'));
    nodes.forEach((n, i) => {
        const y = 52 + i * rowH;
        const cnt = st.counts[n.id];
        const share = st.total ? cnt / st.total : 0;
        const g = svg('g');
        g.setAttribute('style', 'cursor:pointer');
        g.appendChild(svg('rect', { x: px0 - 6, y: y - 4, width: RW - px0, height: rowH - 4, rx: 7, class: 'ch-panel-hit' }));
        g.appendChild(svg('rect', { x: px0, y: y + 1, width: 11, height: 11, rx: 3, fill: n.color }));
        g.appendChild(T({ x: px0 + 18, y: y + 11, class: 'ch-panel-name' }, n.id + '  ' + n.addr));
        g.appendChild(T({ x: RW - 6, y: y + 11, class: 'ch-panel-num', 'text-anchor': 'end', fill: n.color },
            cnt.toLocaleString() + ' key · ' + pct(share)));
        // 迷你条
        const barW = RW - 6 - px0;
        g.appendChild(svg('rect', { x: px0, y: y + 17, width: barW, height: 6, rx: 3, fill: '#eef0f3' }));
        g.appendChild(svg('rect', {
            x: px0, y: y + 17, width: Math.max(1, barW * (st.max ? cnt / st.max : 0)), height: 6, rx: 3, fill: n.color,
        }));
        const tt = svg('title');
        tt.textContent = `点一下删掉 ${n.id}`;
        g.appendChild(tt);
        g.addEventListener('click', () => removeNode(n.id));
        s.appendChild(g);
    });

    const yy = 52 + nodes.length * rowH + 10;
    s.appendChild(T({ x: px0, y: yy + 12, class: 'ch-panel-note' },
        `最重 ÷ 最轻 = ${isFinite(st.ratio) ? st.ratio.toFixed(2) : '—'} 倍`));
    s.appendChild(T({ x: px0, y: yy + 30, class: 'ch-panel-note' },
        `理论均分应该是 ${Math.round(st.mean).toLocaleString()} key／台`));

    box.appendChild(s);

    // 图例
    const lg = h('div.legend');
    nodes.forEach((n) => {
        lg.appendChild(h('span.lg', null,
            h('span.k', { style: 'background:' + n.color }), n.id + ' ' + n.addr));
    });
    box.appendChild(lg);
    return box;
}

// ---------- 迁移带：把「谁换了家」一格一格画出来 ----------

function migrationStrip(blocks) {
    const W = 800, LAB = 104, PADR = 8, NC = 80, ROW = 17, BLK = 82;
    const cellsX = LAB, cellsW = W - LAB - PADR;
    const cw = cellsW / NC;
    const H = 22 + blocks.length * BLK;

    const s = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'ch-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '数据迁移对照',
    });
    s.appendChild(T({ x: 0, y: 11, class: 'ch-strip-sub' },
        `下面每一格 = 一个 key（只画前 ${NC} 个做示意），上排是变更前的归属，下排是变更后；`));
    s.appendChild(T({ x: 0, y: 24, class: 'ch-strip-sub' },
        '深色描边 + 中间粉条 = 这个 key 换了机器，百分比是拿全部 key 算的。'));

    blocks.forEach((b, bi) => {
        const y0 = 34 + bi * BLK;
        s.appendChild(T({ x: 0, y: y0 + 12, class: 'ch-strip-label', fill: b.color }, b.name));
        s.appendChild(T({ x: 0, y: y0 + 28, class: 'ch-strip-sub' }, b.sub || ''));
        s.appendChild(T({ x: 0, y: y0 + 48, class: 'ch-strip-stat', fill: b.color },
            pct(b.diff.ratio) + ' 要搬'));
        s.appendChild(T({ x: 0, y: y0 + 63, class: 'ch-strip-sub' },
            b.diff.count.toLocaleString() + ' / ' + b.keys.length.toLocaleString() + ' 个 key'));

        for (let i = 0; i < NC; i++) {
            const k = b.keys[i];
            if (k == null) break;
            const x = cellsX + i * cw;
            const f = b.before[k], t = b.after[k];
            s.appendChild(svg('rect', { x: x.toFixed(2), y: y0, width: (cw - 0.6).toFixed(2), height: ROW, fill: colorOf(f), opacity: 0.9 }));
            s.appendChild(svg('rect', {
                x: x.toFixed(2), y: y0 + ROW + 8, width: (cw - 0.6).toFixed(2), height: ROW,
                fill: colorOf(t), opacity: 0.9,
                class: f !== t ? 'ch-cell-moved' : '',
            }));
            if (f !== t) {
                s.appendChild(svg('rect', {
                    x: x.toFixed(2), y: y0 + ROW + 1.5, width: (cw - 0.6).toFixed(2), height: 5, class: 'ch-mark',
                }));
            }
        }
        s.appendChild(T({ x: cellsX - 6, y: y0 + 12, class: 'ch-strip-row', 'text-anchor': 'end' }, ''));
    });
    return s;
}

// ---------- 打脸时刻：加一台机器要搬多少 ----------

function buildBoom(cx) {
    const box = h('div');
    if (!cx.add) {
        box.appendChild(h('p.sec-note', { html: '机器池只有 8 台，已经加满了。先删掉一台再回来看。' }));
        return box;
    }
    const N = cx.nodes.length;
    const a = cx.add;
    const theoryMod = N / (N + 1), theoryCH = 1 / (N + 1);

    box.appendChild(h('p.sec-note', {
        html: `现在有 <b>${N}</b> 台机器，加进第 ${N + 1} 台 <b>${a.newId}</b>（${CH.POOL.find((n) => n.id === a.newId).addr}）。`
            + '两种分片方案、同一批 key、同一次扩容，看各自要搬多少数据。',
    }));

    box.appendChild(Viz.cmpGrid([
        { h: `取模分片 hash%${N} → hash%${N + 1}`, v: pct(a.dMod.ratio), d: `${a.dMod.count.toLocaleString()} 个 key 要换机器`, cls: 'cmp-bad' },
        { h: `一致性哈希（${state.vnodes} 个虚拟节点）`, v: pct(a.dCH.ratio), d: `${a.dCH.count.toLocaleString()} 个 key 要换机器`, cls: 'cmp-ok' },
        { h: '少搬', v: a.dMod.count ? pct(1 - a.dCH.count / a.dMod.count, 0) : '—', d: '的数据量', cls: 'cmp-save' },
    ]));

    box.appendChild(migrationStrip([
        {
            name: '取模分片', color: '#f97316',
            sub: `hash(key) % ${N} → % ${N + 1}`,
            keys: cx.keys, before: a.mod1, after: a.mod2, diff: a.dMod,
        },
        {
            name: '一致性哈希', color: '#4f46e5',
            sub: `环上顺时针找第一个节点`,
            keys: cx.keys, before: cx.asg, after: a.asg2, diff: a.dCH,
        },
    ]));

    // 点破
    box.appendChild(h('div.seq-note', {
        html: `<b>第一个反直觉点：取模扩容不是「只搬新机器那一份」。</b><br>`
            + `很多人以为 ${N} 台变 ${N + 1} 台只要挪 <code>1/${N + 1}</code>。实际上一个 key 待着不动，`
            + `要求 <code>hash%${N}</code> 和 <code>hash%${N + 1}</code> 算出来是同一个下标 —— `
            + `这只在 <code>hash mod ${N * (N + 1)} &lt; ${N}</code> 时成立，概率正好 <code>1/${N + 1}</code>。`
            + `<br>所以 <b>取模要搬 N/(N+1) = ${pct(theoryMod, 1)}，一致性哈希只搬 1/(N+1) ≈ ${pct(theoryCH, 1)}，整整差 ${N} 倍。</b>`
            + `本次实测：取模 <b>${pct(a.dMod.ratio)}</b>，一致性哈希 <b>${pct(a.dCH.ratio)}</b>。`,
    }));

    box.appendChild(h('div.seq-note.ch-invariant', {
        html: `<b>第二个反直觉点（这条才是一致性哈希的命根子）：搬走的 key 全部只往新机器搬。</b><br>`
            + `一致性哈希这边，${a.dCH.count.toLocaleString()} 个换家的 key 里，`
            + `进新机器 ${a.newId} 的有 <b>${(a.dCH.dest[a.newId] || 0).toLocaleString()}</b> 个，`
            + `在老机器之间乱窜的有 <b class="ch-zero">${a.chToOld}</b> 个。`
            + `<br>取模那边，${a.dMod.count.toLocaleString()} 个换家的 key 里，`
            + `有 <b class="ch-bad">${a.modToOld.toLocaleString()}</b> 个是<b>老机器之间互相乱搬</b> —— `
            + `这部分搬运<b>纯属白干</b>：数据从 A 挪到 B，谁也没多一台机器的好处，全是为了迁就取模公式。`,
    }));

    // 虚拟节点数怎么影响迁移比例
    const sw = sweep().filter((r) => [1, 10, 50, 160, 500].indexOf(r.v) >= 0 || SWEEP.indexOf(r.v) === 0);
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '每台的虚拟节点数' }),
        h('th', { text: '一致性哈希实测迁移' }),
        h('th', { text: `理论值 1/(N+1) = ${pct(theoryCH, 1)}` }),
        h('th', { text: '负载最重÷最轻' })));
    sw.forEach((r) => {
        const tr = h('tr' + (r.v === state.vnodes ? '.on' : ''), {
            onclick: () => { state.vnodes = r.v; syncSliders(); repaint(); },
        });
        tr.appendChild(h('td.mv-strong', { text: r.v + ' 个' }));
        tr.appendChild(h('td', { text: r.mig == null ? '—' : pct(r.mig) }));
        tr.appendChild(h('td', {
            text: r.mig == null ? '—'
                : (Math.abs(r.mig - theoryCH) / theoryCH < 0.15 ? '很贴近' : '偏差还挺大'),
        }));
        tr.appendChild(h('td', { text: (isFinite(r.ratio) ? r.ratio.toFixed(2) : '—') + ' 倍' }));
        tb.appendChild(tr);
    });
    box.appendChild(h('p.sec-note', {
        html: '顺带说一件教程里很少讲的事：<b>「只搬 1/(N+1)」是个期望值，不是保证。</b>'
            + '虚拟节点少的时候，新机器落在环上哪个位置全看运气 —— '
            + '落在一段大辖区里就抢走一大坨，落在两个点的夹缝里就几乎啥也没抢到。'
            + '虚拟节点多了才会稳稳收敛到理论值。点表格里的任意一行可以直接切过去看：',
    }));
    box.appendChild(h('div.mv-matrix-wrap', null, tb));
    return box;
}

// ---------- 虚拟节点：治倾斜 ----------

function buildBalance(cx) {
    const { st, nodes } = cx;
    const box = h('div');

    const W = 740, H = 214, PL = 46, PR = 16, PT = 26, PB = 40;
    const iw = W - PL - PR, ih = H - PT - PB;
    const maxV = Math.max(1, st.max) * 1.18;
    const y = (v) => PT + ih - (v / maxV) * ih;
    const slot = iw / Math.max(1, nodes.length);
    const bw = Math.min(78, slot * 0.6);

    const s = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'ch-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '各节点负载',
    });
    s.appendChild(T({ x: 0, y: 12, class: 'ch-strip-label', fill: '#4f46e5' },
        `每台机器分到的 key（每台 ${state.vnodes} 个虚拟节点）`));

    for (let g = 0; g <= 2; g++) {
        const v = (maxV / 2) * g;
        s.appendChild(svg('line', { x1: PL, x2: W - PR, y1: y(v), y2: y(v), stroke: '#eef0f3' }));
        s.appendChild(T({ x: PL - 6, y: y(v) + 4, class: 'ch-axis', 'text-anchor': 'end' }, Math.round(v).toLocaleString()));
    }

    nodes.forEach((n, i) => {
        const cnt = st.counts[n.id];
        const cxx = PL + slot * i + slot / 2;
        s.appendChild(svg('rect', {
            x: (cxx - bw / 2).toFixed(1), y: y(cnt).toFixed(1),
            width: bw.toFixed(1), height: Math.max(0, PT + ih - y(cnt)).toFixed(1),
            rx: 4, fill: n.color, opacity: 0.88,
        }));
        s.appendChild(T({ x: cxx, y: y(cnt) - 6, class: 'ch-bar-val', 'text-anchor': 'middle', fill: n.color },
            cnt.toLocaleString()));
        s.appendChild(T({ x: cxx, y: PT + ih + 16, class: 'ch-bar-label', 'text-anchor': 'middle' }, n.id));
        s.appendChild(T({ x: cxx, y: PT + ih + 29, class: 'ch-axis', 'text-anchor': 'middle' },
            pct(st.total ? cnt / st.total : 0)));
    });

    s.appendChild(svg('line', { x1: PL, x2: W - PR, y1: y(st.mean), y2: y(st.mean), class: 'ch-mean' }));
    s.appendChild(T({ x: W - PR, y: y(st.mean) - 5, class: 'ch-mean-label', 'text-anchor': 'end' },
        '完美均分线 ' + Math.round(st.mean).toLocaleString()));
    box.appendChild(s);

    const grid = h('div.stats');
    const cell = (name, sub, val, desc, cls) => h('div.stat' + (cls ? '.' + cls : ''), null,
        h('div.stat-name', null, h('b', { text: name }), h('small', { text: sub })),
        h('div.stat-val', { text: val }),
        h('div.stat-desc', { html: desc }));
    grid.appendChild(cell('负载标准差', 'σ', st.sd.toFixed(1),
        `变异系数 σ/均值 = <b>${pct(st.cv)}</b>。越小越均匀，虚拟节点就是拿来压它的。`, 's-s'));
    grid.appendChild(cell('最重 ÷ 最轻', 'max/min', (isFinite(st.ratio) ? st.ratio.toFixed(2) : '—') + ' 倍',
        st.ratio > 1.5
            ? `最重的 <b>${st.max.toLocaleString()}</b>，最轻的 <b>${st.min.toLocaleString()}</b> —— 这就是倾斜。`
            : `最重 ${st.max.toLocaleString()}，最轻 ${st.min.toLocaleString()}，已经相当平了。`,
        st.ratio > 1.5 ? 's-d' : 's-r'));
    grid.appendChild(cell('最重那台占', 'share', pct(st.total ? st.max / st.total : 0),
        `理论均分应该是 <b>${pct(nodes.length ? 1 / nodes.length : 0)}</b>。差得越多，扩容时越容易先把它压垮。`,
        's-r'));
    box.appendChild(grid);

    // 收敛曲线
    const data = sweep();
    const CW = 740, CHH = 176, CPL = 50, CPR = 18, CPT = 24, CPB = 34;
    const ciw = CW - CPL - CPR, cih = CHH - CPT - CPB;
    const maxCv = Math.max.apply(null, data.map((d) => d.cv)) * 1.12 || 1;
    const lx = (v) => CPL + (Math.log(v) / Math.log(500)) * ciw;
    const ly = (c) => CPT + cih - (c / maxCv) * cih;

    const c = svg('svg', {
        viewBox: `0 0 ${CW} ${CHH}`, class: 'ch-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '虚拟节点数与均衡度',
    });
    c.appendChild(T({ x: 0, y: 12, class: 'ch-strip-label', fill: '#4f46e5' }, '拉滑块时，不均匀程度是怎么掉下去的'));
    c.appendChild(T({ x: CW, y: 12, class: 'ch-strip-sub', 'text-anchor': 'end' }, '纵轴：变异系数（越低越均匀）'));
    for (let g = 0; g <= 2; g++) {
        const v = (maxCv / 2) * g;
        c.appendChild(svg('line', { x1: CPL, x2: CW - CPR, y1: ly(v), y2: ly(v), stroke: '#eef0f3' }));
        c.appendChild(T({ x: CPL - 6, y: ly(v) + 4, class: 'ch-axis', 'text-anchor': 'end' }, pct(v, 0)));
    }
    [1, 4, 16, 64, 160, 500].forEach((v) => {
        c.appendChild(svg('line', { x1: lx(v), x2: lx(v), y1: CPT, y2: CPT + cih, stroke: '#f4f5f7' }));
        c.appendChild(T({ x: lx(v), y: CHH - 14, class: 'ch-axis', 'text-anchor': 'middle' }, String(v)));
    });
    c.appendChild(T({ x: CW / 2, y: CHH - 2, class: 'ch-axis', 'text-anchor': 'middle' }, '每台机器的虚拟节点数（对数轴）'));

    let d = '';
    data.forEach((p, i) => { d += (i ? 'L' : 'M') + lx(p.v).toFixed(1) + ' ' + ly(p.cv).toFixed(1); });
    c.appendChild(svg('path', { d, class: 'ch-conv-line' }));

    // Ketama 的 160
    c.appendChild(svg('line', { x1: lx(160), x2: lx(160), y1: CPT - 4, y2: CPT + cih, class: 'ch-mean' }));
    c.appendChild(T({ x: lx(160) - 6, y: CPT + 8, class: 'ch-mean-label', 'text-anchor': 'end' }, 'Ketama 默认 160'));

    const near = data.reduce((a, b) => (Math.abs(b.v - state.vnodes) < Math.abs(a.v - state.vnodes) ? b : a));
    c.appendChild(svg('circle', { cx: lx(near.v), cy: ly(near.cv), r: 5, class: 'ch-conv-dot' }));
    c.appendChild(T({ x: lx(near.v), y: ly(near.cv) - 11, class: 'ch-bar-val', 'text-anchor': 'middle', fill: '#db2777' },
        '现在这里'));
    box.appendChild(c);

    const one = data[0], k160 = data.find((x) => x.v === 160);
    box.appendChild(h('div.seq-note', {
        html: `<b>第三个反直觉点：不加虚拟节点，节点少的时候会歪得离谱。</b><br>`
            + `${nodes.length} 台机器、每台 1 个点时，最重 ÷ 最轻 = <b>${isFinite(one.ratio) ? one.ratio.toFixed(2) : '—'} 倍</b>`
            + `（变异系数 ${pct(one.cv)}）；每台 160 个虚拟节点时降到 `
            + `<b>${k160 && isFinite(k160.ratio) ? k160.ratio.toFixed(2) : '—'} 倍</b>（变异系数 ${k160 ? pct(k160.cv) : '—'}）。`
            + `<br><b>libketama 每台机器正好放 160 个虚拟节点</b>：它对 <code>addr-i</code> 算 40 次 MD5，`
            + `每个 MD5 的 16 字节切成 4 个 4 字节整数，40 × 4 = 160 个环上点。`
            + `<br>再看曲线左半段那些锯齿 —— <b>虚拟节点少的时候，均不均匀基本靠运气</b>：`
            + `换一批机器 IP，曲线左边的高低完全是另一副样子，几十个以上才开始稳定收敛。`,
    }));
    return box;
}

// ---------- 删节点的影响面 ----------

function buildDelete(cx) {
    const box = h('div');
    if (!cx.del) {
        box.appendChild(h('p.sec-note', { html: '只剩一台机器了，删不动。先加几台回来。' }));
        return box;
    }
    const d = cx.del, N = cx.nodes.length;
    const gone = CH.POOL.find((n) => n.id === d.delId);
    const goneCnt = cx.st.counts[d.delId];

    box.appendChild(Viz.segmented({
        value: d.delId,
        options: cx.nodes.map((n) => ({ v: n.id, label: '拔掉 ' + n.id })),
        onPick: (v) => { state.delId = v; repaint(); },
    }));

    box.appendChild(h('p.sec-note', {
        html: `假设 <b>${d.delId}</b>（${gone.addr}）宕机了，它手上的 <b>${goneCnt.toLocaleString()}</b> 个 key 得找新家。`
            + '看两种方案各要动多少。',
    }));

    box.appendChild(Viz.cmpGrid([
        { h: `取模分片 hash%${N} → hash%${N - 1}`, v: pct(d.dMod.ratio), d: `${d.dMod.count.toLocaleString()} 个 key 换机器`, cls: 'cmp-bad' },
        { h: '一致性哈希', v: pct(d.dCH.ratio), d: `${d.dCH.count.toLocaleString()} 个 key 换机器`, cls: 'cmp-ok' },
        { h: '受牵连的老机器', v: d.fromOthers + ' 个 key', d: '一致性哈希这边被无辜搬动的', cls: 'cmp-save' },
    ]));

    // 谁接手了
    const chips = h('div.ch-dest');
    Object.keys(d.dCH.dest).sort().forEach((id) => {
        const n = d.dCH.dest[id];
        const before = cx.st.counts[id], after = d.stAfter.counts[id];
        chips.appendChild(h('span.ch-chip', {
            style: 'border-color:' + colorOf(id),
            html: `<b style="color:${colorOf(id)}">${id}</b> 接手 ${n.toLocaleString()} 个`
                + `<small>（${before.toLocaleString()} → ${after.toLocaleString()}，`
                + `${before ? '×' + (after / before).toFixed(2) : '—'}）</small>`,
        }));
    });
    box.appendChild(chips);

    box.appendChild(h('div.seq-note.ch-invariant', {
        html: `<b>${d.delId} 的 key 被它顺时针方向的后继瓜分，其它机器之间搬动了 `
            + `<b class="ch-zero">${d.fromOthers}</b> 个 key —— 一个都没动。</b><br>`
            + (state.vnodes === 1
                ? `现在每台只有 1 个虚拟节点，所以 ${d.delId} 的这 ${goneCnt.toLocaleString()} 个 key `
                  + `<b>一次性全砸给了同一台机器</b>。看上面的倍数：接手的那台负载直接跳了一大截。`
                  + '<b>这本身就是个隐患</b>：拔掉一台，后继那台可能当场被压垮，然后接着挂，接着往下传 —— 连锁雪崩。'
                  + '把虚拟节点数拉上去，这坨负载就会被摊给好几台，谁也不会被单独压死。'
                : `每台有 ${state.vnodes} 个虚拟节点，所以 ${d.delId} 的负载被 <b>${Object.keys(d.dCH.dest).length}</b> 台机器分摊了，`
                  + '谁也没被一次性压垮 —— 这是虚拟节点的第二个作用，常常被忽略。'),
    }));

    box.appendChild(migrationStrip([
        { name: '取模分片', color: '#f97316', sub: `hash(key) % ${N} → % ${N - 1}`, keys: cx.keys, before: CH.modAssign(cx.nodes, cx.keys), after: CH.modAssign(d.rest, cx.keys), diff: d.dMod },
        { name: '一致性哈希', color: '#4f46e5', sub: `只有 ${d.delId} 那几段辖区变了`, keys: cx.keys, before: cx.asg, after: d.asgD, diff: d.dCH },
    ]));

    box.appendChild(h('div.seq-note', {
        html: '<b>这件事对缓存意味着什么。</b>缓存机器的伸缩（扩容、宕机、下线）是常态。'
            + `用取模分片，每动一次就有 <b>${pct(d.dMod.ratio)}</b> 的 key 换了归属 —— `
            + '换了归属就意味着<b>在新机器上查不到，全部穿透到数据库</b>。'
            + '一次扩容 = 缓存整体失效 = 数据库瞬间承受全量流量，这是<b>缓存雪崩的经典成因之一</b>，'
            + '而且往往发生在「我们只是加了台机器」这种看起来最人畜无害的操作里。'
            + `一致性哈希把这个数字压到 <b>${pct(d.dCH.ratio)}</b>，剩下 ${pct(1 - d.dCH.ratio)} 的缓存原地不动，继续命中。`,
    }));
    return box;
}

// ---------- 控制 ----------

function addNode() {
    const next = CH.POOL.find((n) => state.ids.indexOf(n.id) === -1);
    if (!next) return;
    state.ids.push(next.id);
    convCache.sig = '';
    repaint();
}

function removeNode(id) {
    if (state.ids.length <= 1) return;
    state.ids = state.ids.filter((x) => x !== id);
    if (state.delId === id) state.delId = null;
    convCache.sig = '';
    repaint();
}

function preset(ids, vnodes, keyCount) {
    state.ids = ids.slice();
    state.vnodes = vnodes;
    if (keyCount) state.keyCount = keyCount;
    state.delId = null;
    convCache.sig = '';
    syncSliders();
    repaint();
}

/** 预设按钮改了滑块背后的值，滑块本体不会自己动，得手动同步一下 */
function syncSliders() {
    if (ui.vInput) { ui.vInput.value = String(state.vnodes); ui.vVal.textContent = state.vnodes + ' 个'; }
    if (ui.kInput) { ui.kInput.value = String(state.keyCount); ui.kVal.textContent = state.keyCount.toLocaleString(); }
}

function repaint() {
    if (!rootEl) return;
    const cx = compute();
    const fill = (host, node) => { if (host) { host.innerHTML = ''; host.appendChild(node); } };
    fill(ui.ring, buildRingView(cx));
    fill(ui.boom, buildBoom(cx));
    fill(ui.bal, buildBalance(cx));
    fill(ui.del, buildDelete(cx));
    if (ui.addBtn) ui.addBtn.disabled = state.ids.length >= CH.POOL.length;
    if (ui.delBtn) ui.delBtn.disabled = state.ids.length <= 1;
}

// ---------- 渲染 ----------

function render() {
    rootEl.innerHTML = '';

    // 1) 场景
    const kSlider = Viz.slider({
        label: 'key 总数', min: 500, max: 8000, step: 500, value: state.keyCount,
        fmt: (v) => v.toLocaleString(),
        onInput: (v) => { state.keyCount = v; convCache.sig = ''; repaint(); },
    });
    ui.kInput = kSlider.querySelector('input');
    ui.kVal = kSlider.querySelector('.ctl-val');

    const presets = h('div.ctl-btns', null,
        h('button.mini.primary', { onclick: () => preset(['A', 'B', 'C'], 160, 3000) }, '经典对照：3 台 → 4 台'),
        h('button.mini', { onclick: () => preset(['A', 'B', 'C', 'D', 'E'], 1, 3000) }, '看倾斜：5 台 × 1 个虚拟节点'),
        h('button.mini', { onclick: () => preset(['A', 'B', 'C', 'D', 'E'], 160, 3000) }, 'Ketama：5 台 × 160 个'),
        h('button.mini', { onclick: () => preset(DEFAULTS.ids, DEFAULTS.vnodes, DEFAULTS.keyCount) }, '重置')
    );

    rootEl.appendChild(Viz.card('fa-circle-nodes', '场景：一堆 key 要分给几台缓存机器',
        '最朴素的办法是 <code>hash(key) % 机器数</code> —— 简单、均匀、O(1)，'
        + '但它有个致命毛病：<b>机器数一变，公式的分母就变了，几乎所有 key 的归属都跟着变</b>。'
        + '一致性哈希换了个思路：<b>不把 key 映射到机器，而是把 key 和机器都映射到同一个环上</b>，'
        + '让 key 顺时针去找机器。这样加减机器只影响环上相邻的一小段。'
        + '下面每一步都用同一批 key、同一个哈希函数，两种方案严格对照。',
        h('div.controls', null, kSlider, presets)
    ));

    // 2) 哈希环
    ui.ring = h('div');
    ui.addBtn = h('button.mini.primary', { onclick: addNode }, '＋ 加一台机器');
    ui.delBtn = h('button.mini.danger', { onclick: () => removeNode(state.ids[state.ids.length - 1]) }, '－ 删掉最后一台');
    rootEl.appendChild(Viz.card('fa-compact-disc', '主视图：哈希环长什么样', null,
        ui.ring,
        h('div.controls', null,
            h('span.ctl-name', { text: '环上的点和右边的成绩单都能直接点，点哪台删哪台：' }),
            h('div.ctl-btns', null, ui.addBtn, ui.delBtn))
    ));

    // 3) 打脸时刻
    ui.boom = h('div');
    rootEl.appendChild(Viz.card('fa-hand-back-fist', '打脸时刻：加一台机器，到底要搬多少数据', null, ui.boom));

    // 4) 虚拟节点
    const vSlider = Viz.slider({
        label: '每台机器的虚拟节点数', min: 1, max: 500, step: 1, value: state.vnodes,
        fmt: (v) => v + ' 个',
        onInput: (v) => { state.vnodes = v; repaint(); },
    });
    ui.vInput = vSlider.querySelector('input');
    ui.vVal = vSlider.querySelector('.ctl-val');
    ui.bal = h('div');
    rootEl.appendChild(Viz.card('fa-scale-unbalanced', '虚拟节点：治的是「分布倾斜」这个病',
        '真实节点只有几台时，它们在环上的位置就是几个随机点，'
        + '<b>切出来的辖区大小可以差好几倍</b>。解法不是换哈希函数，而是<b>让每台机器在环上占很多个点</b>：'
        + '同一台机器用 <code>addr#0</code>、<code>addr#1</code>… 算出几十上百个位置，'
        + '大数定律一上来，各家的总辖区面积就被抹平了。把滑块从 1 拉到 500 看柱子怎么变齐。',
        h('div.controls', null, h('label.ctl.ctl-wide', null, vSlider),
            h('div.ctl-btns', null,
                h('button.mini', { onclick: () => { state.vnodes = 1; syncSliders(); repaint(); } }, '1 个'),
                h('button.mini', { onclick: () => { state.vnodes = 20; syncSliders(); repaint(); } }, '20 个'),
                h('button.mini.primary', { onclick: () => { state.vnodes = 160; syncSliders(); repaint(); } }, '160 个（Ketama）'),
                h('button.mini', { onclick: () => { state.vnodes = 500; syncSliders(); repaint(); } }, '500 个'))),
        ui.bal
    ));

    // 5) 删节点
    ui.del = h('div');
    rootEl.appendChild(Viz.card('fa-plug-circle-xmark', '拔掉一台机器：影响面有多大', null, ui.del));

    // 6) 面试怎么答
    rootEl.appendChild(Viz.card('fa-comments', '这几个问题基本每次都问', null, Viz.qa([
        {
            q: '一致性哈希和取模到底差在哪？一句话说清',
            a: '<b>取模把 key 直接映射到「机器下标」，分母是机器数；一致性哈希把 key 和机器映射到同一个固定的环上（分母永远是 2³²），'
                + '机器只是环上的几个点。</b>'
                + '差别就在这个分母：取模的分母一变，全体重算；一致性哈希的分母永远不变，'
                + '加减机器只是在环上多一个点或少一个点，<b>只影响这个点到它前一个点之间那一段</b>。'
                + '数字上：<b>取模加一台要搬 N/(N+1)（3→4 就是 75%），一致性哈希只搬约 1/(N+1)（约 25%），差 N 倍。</b>'
                + '代价是查找从 O(1) 变成 O(log 环上点数)（二分），以及要多维护一份环。',
        },
        {
            q: '虚拟节点数怎么定？为什么是 160',
            a: '看两件事：<b>① 均衡度够不够</b>，② <b>环的内存和重建成本能不能接受</b>。'
                + '经验区间是<b>每台 100～200 个</b>，libketama 定的 160 是行业里最常被抄的默认值'
                + '（40 次 MD5 × 每次切出 4 个 32 位整数）。'
                + '再往上收益迅速递减 —— 上面那条收敛曲线从 160 拉到 500，变异系数只再掉一点点，'
                + '但环上条目数翻了 3 倍。'
                + '<b>还要按机器配置加权</b>：内存大一倍的机器就给两倍虚拟节点，这是一致性哈希做加权的标准姿势。'
                + '规模估算：1000 台 × 160 = 16 万个环上条目，二分 17 次，内存也就几 MB，完全扛得住；'
                + '但每次增删节点都要重建/重排这个环，节点频繁抖动时这个开销要算进去。',
        },
        {
            q: '一致性哈希能解决数据倾斜吗？',
            a: '<b>不能完全解决，要分清是哪种倾斜。</b>'
                + '① <b>「机器分到的 key 数量不均」</b>——这个能解决，虚拟节点就是干这个的，上面的柱状图演示的就是它。'
                + '② <b>「某个 key 本身是超级热点」</b>——<b>解决不了</b>。'
                + '一个微博大 V 的 key 不管环怎么切，永远只落在一台机器上，虚拟节点再多也没用，'
                + '因为它就是<b>一个</b> key。'
                + '③ <b>「key 的大小差异极大」</b>——也解决不了，它按 key 个数均分，不按字节数。'
                + '热点 key 的正经解法是另一套：<b>key 打散（加随机后缀分成 N 份）、多副本读、本地缓存兜一层、读写分离</b>。'
                + '面试时把这层说清楚，比背「一致性哈希解决数据倾斜」这种半对的话强得多 —— '
                + '<b>它真正解决的是「节点数量变化时的迁移量」，均衡只是虚拟节点顺手带来的副产品。</b>',
        },
        {
            q: 'Redis Cluster 的 16384 个 slot 和一致性哈希是什么关系？',
            a: '<b>没有关系。Redis Cluster 用的不是一致性哈希</b>，这一点大量中文资料写错了。'
                + '它用的是<b>固定数量的哈希槽 + 一张显式的槽→节点映射表</b>：'
                + '<code>slot = CRC16(key) mod 16384</code>，然后查表看这个 slot 归哪个节点，'
                + '这张表由节点之间用 gossip 协议互相同步，客户端也会缓存一份。'
                + '<br><b>两者解决同一类问题，机制不同：</b>'
                + '一致性哈希靠「环上位置」<b>算</b>出归属，槽映射靠<b>查</b>一张表。'
                + '查表的好处是<b>迁移粒度和目标完全可控</b>——运维可以精确指定「把 100 号槽从 A 搬到 B」，'
                + '而一致性哈希只能通过调虚拟节点间接影响，没法点名。'
                + '代价是要多维护、多同步这张表。'
                + '<br>至于为什么是 16384 而不是 65536：节点心跳包里要带一份「我负责哪些槽」的位图，'
                + '16384 位 = 2KB，65536 位 = 8KB，心跳是高频消息，8KB 太浪费；'
                + '而且 Redis 官方本来就不建议集群超过约 1000 个节点，16384 个槽分给 1000 个节点已经足够细了。',
        },
        {
            q: '既然一致性哈希还要靠虚拟节点打补丁，有没有更好的方案？',
            a: '有，各有取舍：'
                + '<br>① <b>Rendezvous / HRW 哈希</b>：对每台机器算 <code>hash(key + node)</code>，取最大的那台。'
                + '<b>天然均匀、不需要虚拟节点、加减节点同样只影响 1/N</b>，缺点是每次查找要遍历所有节点 O(N)'
                + '（节点少的时候完全不是问题，几十台以内很多人直接用它）。'
                + '<br>② <b>Jump Consistent Hash</b>：几行代码、不占内存、分布近乎完美，'
                + '但它返回的是<b>桶编号 0~N-1</b>，只能在「末尾增删」的场景用 —— 没法任意拔掉中间某台机器。'
                + '<br>③ <b>显式槽映射</b>（Redis Cluster 那一套）：迁移完全可控，代价是要维护和同步映射表。'
                + '<br>一致性哈希今天还这么常见，很大程度上是历史惯性 + 客户端实现遍地都是（memcached 那一代留下的）。',
        },
    ])));

    // 7) 坑
    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '用之前必须知道的坑', null, Viz.pitfalls([
        ['虚拟节点太少时，「只搬 1/(N+1)」是句空话',
            '那个漂亮的比例是<b>期望值</b>。虚拟节点只有 1 个时，新机器落在环上哪儿全看运气：'
            + '落进一段大辖区就抢走一大坨，落在两点夹缝里就几乎啥也没抢到。'
            + '本演示把虚拟节点拉到 1 再看迁移比例，会发现它和理论值差得很远。<b>没有虚拟节点的一致性哈希是不完整的。</b>'],
        ['虚拟节点 = 1 时删节点，是在给下一台机器递刀',
            '被删机器的全部负载会<b>一次性压给顺时针的下一台</b>。那台如果本来就快满了，很可能当场被压垮，'
            + '然后它的负载又整个甩给再下一台 —— <b>连锁挂机</b>。'
            + '虚拟节点多了，这坨负载会被摊给好几台，谁也不会被单独压死。'
            + '这是虚拟节点第二个作用，比「均衡」那个更少被提到。'],
        ['机器换了 IP / 端口，等于删一台加一台',
            '环上的位置来自 <code>hash(addr#i)</code>。'
            + '<b>只要参与哈希的那个字符串变了，这台机器的所有虚拟节点位置就全变了</b>，'
            + '效果等同于「拔掉旧的 + 插入一台全新的」，缓存大面积失效。'
            + '所以种子要用<b>稳定的逻辑标识</b>（节点 ID / 主机名），别用会漂移的 IP，'
            + '尤其是在容器环境里 —— Pod 一重建 IP 就换了。'],
        ['做多副本时，别顺时针取到同一台机器上',
            '很多实现是「顺时针取接下来的 N 个环上点当副本」。'
            + '有了虚拟节点之后，<b>接下来的 3 个点很可能是同一台物理机的 3 个虚拟节点</b>，'
            + '那三副本就全在一台机器上，机器一挂数据全丢。'
            + '正确做法是<b>一路往下跳，直到凑够 N 个不同的物理节点</b>（更严格的还要跨机架、跨可用区）。'
            + 'Dynamo 这类系统在论文里专门强调过这一点。'],
        ['环重建的成本别忽略，尤其节点抖动的时候',
            '一次增删节点要重算并重排整个环。1000 台 × 160 = 16 万个条目，排序不是零成本；'
            + '如果节点因为网络抖动反复上下线，环就在反复重建，'
            + '客户端还会跟着经历一轮又一轮的缓存失效。'
            + '生产上通常配<b>故障判定的抑制窗口</b>（连续失败多久才真正摘除），别一超时就改环。'],
        ['一致性哈希管不了「数据实际怎么搬过去」',
            '它只回答「变更后这个 key 该归谁」，<b>不负责把数据真的挪过去</b>。'
            + '缓存场景一般不搬——直接让它失效、回源重建就行（代价是那 1/(N+1) 的请求会穿透）；'
            + '但存储场景必须真搬，还要处理搬迁期间的双写、读旧读新、断点续传。'
            + '<b>「只搬 1/(N+1)」说的是数据量，不是说这件事很轻松。</b>'],
    ])));

    // 8) 口径
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示（做了哪些简化）' }),
        h('p', {
            html: '<b>哈希函数</b>：自己实现的 <b>FNV-1a（32 位）+ 一步 xorshift-multiply 混合</b>'
                + '（混合那步是 MurmurHash3 <code>fmix32</code> 的同款做法）。'
                + '加这一步是因为 FNV-1a 的低位雪崩偏弱，而取模分片恰好只看低位，不混一下对照就不公平了。'
                + '真实系统里：<b>libketama 用 MD5 取前 4 字节</b>，<b>Redis Cluster 用 CRC16</b>，'
                + '自研分片常用 MurmurHash3 —— 换哪个都行，只要确定性 + 分布均匀。',
        }),
        h('p', {
            html: '<b>没有任何随机数</b>。key 是 <code>user:10000</code> 起连续构造的固定序列，'
                + '机器地址是写死的 <code>10.0.0.11:6379</code> 起 8 台，虚拟节点种子是 <code>addr#i</code>。'
                + '所以刷新前后、两种方案之间，结果严格可对照，单测也能直接断言。'
                + '真实业务 key 的分布当然不长这样，但对哈希函数来说这不影响结论。',
        }),
        h('p', {
            html: '<b>画图上的取舍</b>：环上只画前 <b>56</b> 个 key 的点，迁移带只画前 <b>80</b> 个 key 的格子，'
                + '<b>但所有百分比和统计都是拿全部 key 算的</b>。'
                + '环上点超过 60 个就不再逐个画点、超过 160 个就改成按 480 个角度桶采样画彩带（逐个画上千片又慢又看不清）；'
                + '「顺时针找节点」那些细弧线只在环上点 ≤ 26 时才画。',
        }),
        h('p', {
            html: '<b>「迁移比例」的口径</b>：指<b>归属发生变化的 key 占比</b>，不是字节数、不是耗时。'
                + '演示里也<b>没有</b>模拟：数据真实拷贝的时间、网络带宽、副本放置、故障检测与摘除、'
                + '迁移期间的双写与读一致性。这些才是生产上真正花时间的部分。',
        }),
        h('p', {
            html: '<b>取模那一侧的建模</b>：机器列表按加入顺序排成数组，<code>hash(key) % N</code> 取下标。'
                + '删掉中间一台会让后面的下标整体前移 —— 这就是取模删节点同样要全局重排的原因，'
                + '和真实实现的行为一致。',
        })
    ));

    repaint();
}

Viz.register({
    id: 'consistent-hash',
    cat: 'sys',
    title: '一致性哈希',
    subtitle: '哈希环 · 虚拟节点 · 数据迁移',
    icon: 'fa-circle-nodes',
    blurb: '加一台机器要搬多少数据：取模 N/(N+1)，一致性哈希 1/(N+1)',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.ids = DEFAULTS.ids.slice();
        state.vnodes = DEFAULTS.vnodes;
        state.keyCount = DEFAULTS.keyCount;
        state.delId = null;
        keyCache = { n: -1, list: null };
        convCache = { sig: '', data: null };
        render();
    },
    unmount() {
        // 没有 rAF / 定时器，只要把 DOM 引用清干净，别让旧节点被闭包拖住
        Object.keys(ui).forEach((k) => { delete ui[k]; });
        keyCache = { n: -1, list: null };
        convCache = { sig: '', data: null };
        rootEl = null;
    },
});

})();
