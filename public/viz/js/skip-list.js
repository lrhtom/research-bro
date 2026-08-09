// ============================================================
//  演示：跳表 Skip List
//  最底层是一条完整的有序链表，往上每一层都是下一层的「随机抽稀索引」。
//  查找从最高层最左边出发：能往右就往右，不能往右就下沉一层，走出一条折线。
//  Redis 的 ZSet 就是靠它做有序和范围查询的 —— 顺带把「为什么不用红黑树」讲清楚。
//  上半 SK.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const SK = {};

/** 最大层数。Redis 源码里 ZSKIPLIST_MAXLEVEL 也是 32。 */
SK.MAX_LEVEL = 32;

/** 固定种子。全演示禁止 Math.random —— 刷新前后结构必须一模一样，单测才断言得了。 */
SK.SEED = 20260731;

/**
 * 线性同余伪随机（Numerical Recipes 的那组常数），32 位。
 * 用 Math.imul 是为了让乘法在 32 位里精确回绕，不然 double 会丢低位。
 * 取高 24 位（>>> 8）是因为 LCG 的低位周期短、质量差，直接用低位会明显偏。
 */
SK.next01 = function (list) {
    list.rs = (Math.imul(list.rs, 1664525) + 1013904223) >>> 0;
    return (list.rs >>> 8) / 16777216;
};

/**
 * 建一个空跳表。
 * head 是哨兵头节点：不存数据，只是每一层的起跑线（key 视作 -∞）。
 */
SK.create = function (opt) {
    opt = opt || {};
    const maxLevel = opt.maxLevel || SK.MAX_LEVEL;
    const seed = (opt.seed == null ? SK.SEED : opt.seed) >>> 0;
    return {
        p: opt.p == null ? 0.5 : opt.p,
        maxLevel,
        seed,
        rs: seed || 1,                  // 伪随机当前状态
        head: {
            key: -Infinity, val: null, isHead: true,
            forward: new Array(maxLevel).fill(null),
        },
        level: 1,                       // 当前实际用到的层数
        count: 0,
    };
};

/**
 * 抛硬币定层数：正面就再加一层，反面就停。
 * P(层数 = k) = p^(k-1) · (1-p)，所以期望层数 = 1/(1-p)。
 * 返回 flips 是为了能在界面上把「这次抛了几次正面」原样画出来。
 */
SK.randomLevel = function (list) {
    const flips = [];
    let lv = 1;
    while (lv < list.maxLevel) {
        const isHead = SK.next01(list) < list.p;
        flips.push(isHead);
        if (!isHead) break;
        lv++;
    }
    return { level: lv, flips, heads: lv - 1 };
};

/**
 * 找出每一层的前驱节点（就是教科书里的 update[]）。
 * 这里必须用「严格小于」：update[i] 是最后一个 key < target 的节点，
 * 插入要挂在它后面，删除要从它身上摘链。
 */
SK.findUpdate = function (list, key) {
    const update = new Array(list.maxLevel).fill(list.head);
    let x = list.head;
    for (let i = list.level - 1; i >= 0; i--) {
        while (x.forward[i] && x.forward[i].key < key) x = x.forward[i];
        update[i] = x;
    }
    return { update, cand: x.forward[0] };
};

/**
 * 插入。
 * 【重复 key 的语义：覆盖 value，不新建节点、不重新抛硬币、层数不变。】
 * 选「覆盖」而不是「拒绝」，是为了对齐 Redis 的 ZADD —— 同一个 member 再 ZADD
 * 是更新分数，不会多出一份。返回 duplicate:true 让调用方知道没新增。
 */
SK.insert = function (list, key, val) {
    const f = SK.findUpdate(list, key);
    if (f.cand && f.cand.key === key) {
        f.cand.val = val;
        return {
            duplicate: true, node: f.cand, key,
            level: f.cand.forward.length, flips: [], heads: 0,
            update: f.update, grew: false,
        };
    }

    const rl = SK.randomLevel(list);
    const prevLevel = list.level;
    if (rl.level > list.level) {
        // 新节点比整表都高：多出来的那几层，前驱只能是头节点
        for (let i = list.level; i < rl.level; i++) f.update[i] = list.head;
        list.level = rl.level;
    }

    const node = { key, val: val === undefined ? key : val, forward: new Array(rl.level).fill(null) };
    for (let i = 0; i < rl.level; i++) {
        node.forward[i] = f.update[i].forward[i];
        f.update[i].forward[i] = node;
    }
    list.count++;

    return {
        duplicate: false, node, key,
        level: rl.level, flips: rl.flips, heads: rl.heads,
        update: f.update, grew: rl.level > prevLevel, prevLevel,
    };
};

/**
 * 删除：从上到下逐层解链。
 * 漏掉任何一层，那一层的指针就指着一个已经"不存在"的节点，遍历时会串味。
 * 删完还要把表高收回来（最高层空了就降一层），否则查找每次都要白白下沉。
 */
SK.remove = function (list, key) {
    const f = SK.findUpdate(list, key);
    const cand = f.cand;
    if (!cand || cand.key !== key) {
        return { removed: false, key, update: f.update, unlinked: [], shrank: 0 };
    }
    const unlinked = [];
    for (let i = 0; i < list.level; i++) {
        if (f.update[i].forward[i] === cand) {
            f.update[i].forward[i] = cand.forward[i];
            unlinked.push(i);
        }
    }
    const before = list.level;
    while (list.level > 1 && !list.head.forward[list.level - 1]) list.level--;
    list.count--;
    return { removed: true, key, node: cand, update: f.update, unlinked, shrank: before - list.level };
};

/**
 * 查找，并把每一步都记下来（给单步动画用）。
 * 规则只有两条：右边节点的 key ≤ 目标就往右走；否则下沉一层。
 * 走到第 1 层还走不动，就是真没有。
 * 步数口径：右移一次算一步，下沉一次也算一步（起点不算）。
 */
SK.search = function (list, key) {
    const nameOf = (nd) => (nd.isHead ? '头节点' : String(nd.key));
    const steps = [];
    let x = list.head;
    let i = list.level - 1;
    let right = 0, down = 0, found = false;

    steps.push({
        type: 'start', level: i, node: x, at: x,
        text: `从最高层 L${i + 1} 的头节点出发。头节点不存数据，只是每层的起跑线。`,
    });

    let guard = 0;
    while (i >= 0 && guard++ < 1000000) {
        const nxt = x.forward[i];
        if (nxt && nxt.key <= key) {
            right++;
            steps.push({
                type: 'right', level: i, from: x, to: nxt, at: nxt,
                text: `L${i + 1}：现在在 ${nameOf(x)}，右邻居是 ${nxt.key}。`
                    + `${nxt.key} ≤ ${key}，走过去还不会越过目标 → 往右跳。`,
            });
            x = nxt;
            if (x.key === key) {
                found = true;
                steps.push({
                    type: 'found', level: i, node: x, at: x,
                    text: `踩中了：${key} 就在 L${i + 1} 上。上层能命中说明它被抽进了索引层，`
                        + `连最底层都不用下去。`,
                });
                break;
            }
        } else if (i > 0) {
            down++;
            const why = nxt
                ? `右邻居是 ${nxt.key}，${nxt.key} > ${key}，再往右就越过目标了`
                : '右邻居是 NIL，这一层已经到头';
            steps.push({
                type: 'down', level: i, from: x, at: x,
                text: `L${i + 1}：现在在 ${nameOf(x)}，${why} → 原地下沉到 L${i}，换更密的一层继续找。`,
            });
            i--;
        } else {
            const why = nxt ? `右邻居是 ${nxt.key} > ${key}` : '右邻居是 NIL';
            steps.push({
                type: 'fail', level: 0, from: x, at: x,
                text: `L1 是完整链表，已经没有更低的层可以下沉。现在在 ${nameOf(x)}，${why}`
                    + ` → ${key} 不在表里。`,
            });
            break;
        }
    }
    return { found, node: found ? x : null, steps, right, down, total: right + down };
};

/** 只数步数、不生成文字的轻量版（统计时要跑几千次，别去拼字符串）。 */
SK.searchCost = function (list, key) {
    let x = list.head, i = list.level - 1, c = 0, guard = 0;
    while (i >= 0 && guard++ < 1000000) {
        const nxt = x.forward[i];
        if (nxt && nxt.key <= key) {
            c++; x = nxt;
            if (x.key === key) return { steps: c, found: true };
        } else if (i > 0) { c++; i--; } else return { steps: c, found: false };
    }
    return { steps: c, found: false };
};

/** 对照组：普通有序链表，只能沿着 L1 一个一个往右挪。 */
SK.listSearch = function (list, key) {
    let x = list.head, steps = 0, found = false;
    const visited = [];
    while (x.forward[0]) {
        const nxt = x.forward[0];
        if (nxt.key > key) break;
        steps++; x = nxt; visited.push(nxt.key);
        if (nxt.key === key) { found = true; break; }
    }
    return { found, steps, visited };
};

/** 第 i 层（0 = 最底层）从左到右的所有节点。 */
SK.levelNodes = function (list, i) {
    const out = [];
    if (i < 0 || i >= list.maxLevel) return out;
    let x = list.head.forward[i];
    let guard = 0;
    while (x && guard++ < 1000000) { out.push(x); x = x.forward[i]; }
    return out;
};

SK.levelKeys = function (list, i) { return SK.levelNodes(list, i).map((nd) => nd.key); };

/** 遍历最底层 —— 这就是「跳表天然有序」的全部含义。 */
SK.toArray = function (list) { return SK.levelKeys(list, 0); };

SK.build = function (keys, opt) {
    const list = SK.create(opt);
    for (let i = 0; i < keys.length; i++) SK.insert(list, keys[i]);
    return list;
};

/** 表里所有 key 各查一次，取平均步数。 */
SK.avgCost = function (list) {
    const keys = SK.toArray(list);
    if (!keys.length) return 0;
    let s = 0;
    for (let i = 0; i < keys.length; i++) s += SK.searchCost(list, keys[i]).steps;
    return s / keys.length;
};

/**
 * 理论期望查找步数 = (1/p) · log_{1/p}(n)。
 * 注意它比 log₂(n) 大一个常数因子 1/p —— 大 O 把这个常数吃掉了，实测可吃不掉。
 */
SK.theory = function (n, p) {
    if (n <= 1) return 0;
    return (1 / p) * (Math.log(n) / Math.log(1 / p));
};

SK.stats = function (list) {
    const nodes = SK.levelNodes(list, 0);
    let ptr = 0, maxLv = 0;
    nodes.forEach((nd) => {
        ptr += nd.forward.length;
        if (nd.forward.length > maxLv) maxLv = nd.forward.length;
    });
    const n = nodes.length;
    return {
        n, level: list.level, maxNodeLevel: maxLv, pointers: ptr,
        avgLevel: n ? ptr / n : 0,
        avgCost: SK.avgCost(list),
        avgListCost: n ? (n + 1) / 2 : 0,   // 链表查第 r 个要 r 步，平均 (n+1)/2
    };
};

if (typeof module !== 'undefined' && module.exports) module.exports = SK;
if (typeof window !== 'undefined') window.SKModel = SK;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

// 初始那 16 个 key：够长，才能让「跳表 4 步 vs 链表 15 步」的差距看得见
const BASE_KEYS = [3, 7, 12, 17, 19, 21, 25, 26, 31, 38, 44, 50, 55, 61, 68, 72];
// 「再插一个」按钮按顺序取这些，不用随机，保证每次点的结果都一样
const EXTRA_KEYS = [9, 28, 41, 58, 64, 77, 15, 35, 47, 70];
const CURVE_NS = [8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1000];

const state = {
    pPct: 50,           // p × 100，滑块用整数
    keys: BASE_KEYS.slice(),
    extraIdx: 0,
    list: null,
    target: 61,
    stepIdx: 0,
    lastOp: null,
    n: 512,             // 打脸曲线上的当前节点数
    playing: false,
    ticker: null,
    dom: {},
};

let svgSeq = 0;         // marker 的 id 要全页唯一
let rootEl = null;

function P() { return state.pPct / 100; }

function rebuild() {
    state.list = SK.build(state.keys, { p: P(), seed: SK.SEED });
}

// ---------- 统计缓存（滑块一拖就要算几千次，缓存一下）----------

const memo = Object.create(null);

function sampleStat(n, p) {
    const k = n + '|' + p;
    if (memo[k]) return memo[k];
    const keys = [];
    for (let i = 1; i <= n; i++) keys.push(i);
    const list = SK.build(keys, { p, seed: SK.SEED });
    const st = SK.stats(list);
    memo[k] = st;
    return st;
}

// ---------- 主图 ----------

/**
 * 画整张跳表。
 * opt = {
 *   walk      : SK.search 的结果 + 走到第几步，画成折线
 *   stepIdx   : 折线画到第几步
 *   showLinear: 底下再画一条「普通有序链表」的对照带
 *   updMarks  : update[] 前驱标记（插入/删除时用），updMarks[i] = key 或 null(表示头节点)
 *   newKey    : 高亮某个刚插进来的节点
 *   targetKey : 画一条竖虚线指出目标列
 * }
 */
function buildSkipSvg(list, opt) {
    opt = opt || {};
    const keys = SK.toArray(list);
    const n = keys.length;
    const col = Object.create(null);
    keys.forEach((k, i) => { col[k] = i; });

    const LBL = 42, HEADW = 32, GAP = 10;
    const CW = Math.max(24, Math.min(48, Math.floor((880 - LBL - HEADW - GAP - 48) / Math.max(n, 1))));
    const NW = Math.min(38, CW - 8);
    const X0 = LBL + HEADW + GAP;
    const cx = (c) => X0 + c * CW + CW / 2;
    const headX = LBL + HEADW / 2;
    const nodeX = (nd) => (!nd || nd.isHead ? headX : cx(col[nd.key]));
    const nilX = X0 + n * CW + 18;
    const W = nilX + 30;

    const ROW = 24, RG = 9, PT = 14;
    const L = list.level;
    const rowY = (i) => PT + (L - 1 - i) * (ROW + RG);
    const midY = (i) => rowY(i) + ROW / 2;

    const base = PT + L * (ROW + RG) + 16;
    const linY = base + 6;
    const H = opt.showLinear ? linY + 44 : base;

    const id = 'skA' + (svgSeq++);
    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'sk-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': '跳表结构图',
    });

    const defs = svg('defs');
    const mk = svg('marker', {
        id, viewBox: '0 0 10 10', refX: '9', refY: '5',
        markerWidth: '5', markerHeight: '5', orient: 'auto',
    });
    mk.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', fill: '#c3cad6' }));
    defs.appendChild(mk);
    root.appendChild(defs);

    // 走过的路径：先算出折线的所有拐点，顺便记下"哪些格子被踩过"
    const walkPts = [];
    const hitCell = Object.create(null);   // key@level
    let curPt = null, curLevel = null, foundHit = false;
    if (opt.walk) {
        const st = opt.walk.steps;
        const upto = Math.min(opt.stepIdx == null ? st.length - 1 : opt.stepIdx, st.length - 1);
        walkPts.push([headX, midY(st[0].level)]);
        curLevel = st[0].level;
        for (let k = 1; k <= upto; k++) {
            const s = st[k];
            if (s.type === 'right') {
                walkPts.push([nodeX(s.to), midY(s.level)]);
                hitCell[s.to.key + '@' + s.level] = 1;
                curLevel = s.level;
            } else if (s.type === 'down') {
                walkPts.push([walkPts[walkPts.length - 1][0], midY(s.level - 1)]);
                curLevel = s.level - 1;
            } else if (s.type === 'found') {
                foundHit = true;
            }
        }
        curPt = walkPts[walkPts.length - 1];
    }

    // 每层的泳道底
    for (let i = 0; i < L; i++) {
        root.appendChild(svg('rect', {
            x: X0 - 6, y: rowY(i), width: nilX - X0 + 14, height: ROW, rx: 4,
            class: 'sk-lane' + (i === 0 ? ' sk-lane-base' : ''),
        }));
        root.appendChild(T({ x: 2, y: midY(i) + 3.5, class: 'sk-lvl' },
            'L' + (i + 1) + ' ×' + SK.levelNodes(list, i).length));
    }

    // 目标列的竖虚线（先画，压在下面）
    if (opt.targetKey != null && col[opt.targetKey] != null) {
        const tx = cx(col[opt.targetKey]);
        root.appendChild(svg('line', {
            x1: tx, x2: tx, y1: PT - 8, y2: rowY(0) + ROW + 4, class: 'sk-guide',
        }));
        root.appendChild(T({ x: tx, y: rowY(0) + ROW + 14, class: 'sk-guide-t', 'text-anchor': 'middle' },
            '目标 ' + opt.targetKey));
    }

    // 同一个 key 的各层用竖线串起来（这才是"一座塔"的感觉）
    keys.forEach((k, c) => {
        const nd = SK.levelNodes(list, 0)[c];
        if (!nd || nd.forward.length < 2) return;
        root.appendChild(svg('line', {
            x1: cx(c), x2: cx(c), y1: midY(nd.forward.length - 1), y2: midY(0),
            class: 'sk-vlink',
        }));
    });

    // 每层的横向指针
    for (let i = 0; i < L; i++) {
        const row = SK.levelNodes(list, i);
        let prevX = headX + HEADW / 2, prevNode = list.head;
        row.forEach((nd) => {
            const nx = cx(col[nd.key]);
            const walked = opt.walk && hitCell[nd.key + '@' + i]
                && (prevNode.isHead || hitCell[prevNode.key + '@' + i]);
            root.appendChild(svg('line', {
                x1: prevX, y1: midY(i), x2: nx - NW / 2 - 2, y2: midY(i),
                class: walked ? 'sk-link sk-link-walk' : 'sk-link',
                'marker-end': walked ? null : `url(#${id})`,
            }));
            prevX = nx + NW / 2; prevNode = nd;
        });
        root.appendChild(svg('line', {
            x1: prevX, y1: midY(i), x2: nilX - 12, y2: midY(i),
            class: 'sk-link', 'marker-end': `url(#${id})`,
        }));
        root.appendChild(T({ x: nilX - 8, y: midY(i) + 3.5, class: 'sk-nil' }, 'NIL'));
        // 头节点格子
        root.appendChild(svg('rect', {
            x: headX - HEADW / 2, y: rowY(i), width: HEADW, height: ROW, rx: 4, class: 'sk-head',
        }));
        root.appendChild(T({ x: headX, y: midY(i) + 3.5, class: 'sk-head-t', 'text-anchor': 'middle' }, '头'));
    }

    // 节点方块
    const baseRow = SK.levelNodes(list, 0);
    baseRow.forEach((nd, c) => {
        for (let i = 0; i < nd.forward.length; i++) {
            let cls = 'sk-node';
            if (nd.key === opt.newKey) cls += ' sk-node-new';
            else if (hitCell[nd.key + '@' + i]) cls += ' sk-node-hit';
            if (foundHit && nd.key === opt.walk.node?.key && i === curLevel) cls += ' sk-node-found';
            root.appendChild(svg('rect', {
                x: cx(c) - NW / 2, y: rowY(i), width: NW, height: ROW, rx: 4, class: cls,
            }));
            root.appendChild(T({
                x: cx(c), y: midY(i) + 3.8, 'text-anchor': 'middle',
                class: 'sk-key' + (hitCell[nd.key + '@' + i] ? ' sk-key-hit' : ''),
            }, String(nd.key)));
        }
        // update[] 前驱标记
        if (opt.updMarks) {
            for (let i = 0; i < opt.updMarks.length; i++) {
                if (opt.updMarks[i] === nd.key && i < L) {
                    root.appendChild(svg('line', {
                        x1: cx(c) - NW / 2, x2: cx(c) + NW / 2,
                        y1: rowY(i) + ROW + 2.5, y2: rowY(i) + ROW + 2.5, class: 'sk-upd-mark',
                    }));
                }
            }
        }
    });
    if (opt.updMarks) {
        for (let i = 0; i < opt.updMarks.length; i++) {
            if (opt.updMarks[i] == null && i < L) {
                root.appendChild(svg('line', {
                    x1: headX - HEADW / 2, x2: headX + HEADW / 2,
                    y1: rowY(i) + ROW + 2.5, y2: rowY(i) + ROW + 2.5, class: 'sk-upd-mark',
                }));
            }
        }
    }

    // 折线
    if (walkPts.length > 1) {
        root.appendChild(svg('polyline', {
            points: walkPts.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' '),
            class: 'sk-walk', fill: 'none',
        }));
    }
    if (curPt) {
        root.appendChild(svg('circle', {
            cx: curPt[0], cy: curPt[1], r: 6.5,
            class: 'sk-cur' + (foundHit ? ' sk-cur-ok' : ''),
        }));
    }

    // 对照：普通有序链表
    if (opt.showLinear) {
        const ly = linY + 4, lh = 20;
        root.appendChild(T({ x: 2, y: ly + 9, class: 'sk-lvl' }, '普通有序'));
        root.appendChild(T({ x: 2, y: ly + 19, class: 'sk-lvl' }, '链表'));
        root.appendChild(svg('rect', {
            x: X0 - 6, y: ly, width: nilX - X0 + 14, height: lh, rx: 4, class: 'sk-lane sk-lane-lin',
        }));
        root.appendChild(svg('rect', {
            x: headX - HEADW / 2, y: ly, width: HEADW, height: lh, rx: 4, class: 'sk-head',
        }));
        root.appendChild(T({ x: headX, y: ly + lh / 2 + 3.5, class: 'sk-head-t', 'text-anchor': 'middle' }, '头'));

        const walked = opt.linSteps || 0;
        let px = headX + HEADW / 2;
        baseRow.forEach((nd, c) => {
            const nx = cx(c);
            root.appendChild(svg('line', {
                x1: px, y1: ly + lh / 2, x2: nx - NW / 2 - 2, y2: ly + lh / 2,
                class: c < walked ? 'sk-link sk-link-lin' : 'sk-link',
                'marker-end': c < walked ? null : `url(#${id})`,
            }));
            root.appendChild(svg('rect', {
                x: nx - NW / 2, y: ly, width: NW, height: lh, rx: 4,
                class: 'sk-node' + (c < walked ? ' sk-node-lin' : ''),
            }));
            root.appendChild(T({
                x: nx, y: ly + lh / 2 + 3.5, 'text-anchor': 'middle',
                class: 'sk-key' + (c < walked ? ' sk-key-lin' : ''),
            }, String(nd.key)));
            px = nx + NW / 2;
        });
        root.appendChild(svg('line', {
            x1: px, y1: ly + lh / 2, x2: nilX - 12, y2: ly + lh / 2,
            class: 'sk-link', 'marker-end': `url(#${id})`,
        }));
        root.appendChild(T({ x: nilX - 8, y: ly + lh / 2 + 3.5, class: 'sk-nil' }, 'NIL'));
        root.appendChild(T({ x: X0, y: ly + lh + 15, class: 'sk-lin-note' },
            `一个一个往右挪，走了 ${walked} 步才走到这里`));
    }

    return root;
}

// ---------- 打脸曲线 ----------

function buildCurve() {
    const p = P();
    const pts = CURVE_NS.map((n) => ({ n, v: sampleStat(n, p).avgCost }));
    const maxMeasured = Math.max.apply(null, pts.map((q) => q.v));
    const yMax = Math.max(24, Math.ceil(Math.max(maxMeasured, SK.theory(1000, p)) * 1.28 / 4) * 4);

    const W = 860, H = 300, PL = 46, PR = 150, PT = 16, PB = 40;
    const iw = W - PL - PR, ih = H - PT - PB;
    const X = (n) => PL + ((Math.log(n) / Math.LN2) - 3) / 7 * iw;
    const Y = (v) => PT + ih - (v / yMax) * ih;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'sk-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': '平均查找步数随节点数的变化',
    });

    // 网格
    const stepY = Viz.niceStep(yMax, 5);
    for (let v = 0; v <= yMax + 0.001; v += stepY) {
        root.appendChild(svg('line', { x1: PL, x2: PL + iw, y1: Y(v), y2: Y(v), stroke: '#eef0f3' }));
        root.appendChild(T({ x: PL - 8, y: Y(v) + 4, class: 'axis-label', 'text-anchor': 'end' }, String(v)));
    }
    [8, 16, 32, 64, 128, 256, 512, 1024].forEach((n) => {
        root.appendChild(svg('line', { x1: X(n), x2: X(n), y1: PT, y2: PT + ih, stroke: '#f4f5f7' }));
        root.appendChild(T({ x: X(n), y: PT + ih + 16, class: 'axis-label', 'text-anchor': 'middle' }, String(n)));
    });
    root.appendChild(T({ x: 2, y: 11, class: 'axis-title' }, '平均查找步数'));
    root.appendChild(T({ x: PL + iw / 2, y: H - 8, class: 'axis-title', 'text-anchor': 'middle' },
        '节点数 n（横轴是对数刻度，所以 log₂n 是一条直线）'));

    const line = (fn, cls, from, to) => {
        let d = '';
        for (let k = 0; k <= 160; k++) {
            const n = Math.pow(2, 3 + 7 * k / 160);
            if (n < (from || 8) || n > (to || 1024)) continue;
            const v = fn(n);
            if (v > yMax) return { d, exitN: n, exitV: v };
            d += (d ? 'L' : 'M') + X(n).toFixed(1) + ' ' + Y(v).toFixed(1);
        }
        return { d, exitN: null };
    };

    // 链表 n/2：画着画着就冲出图外
    const lin = line((n) => n / 2, 'x');
    root.appendChild(svg('path', { d: lin.d, class: 'sk-c-lin', fill: 'none' }));
    if (lin.exitN) {
        const ex = X(lin.exitN);
        root.appendChild(svg('line', { x1: ex, y1: Y(yMax), x2: ex + 16, y2: PT - 4, class: 'sk-c-lin sk-c-arrow' }));
        root.appendChild(T({ x: ex + 20, y: PT + 8, class: 'sk-c-lin-t' },
            `链表 n/2 从这里冲出图外 → n=1000 时是 500 步`));
    }

    // log₂n：只是"形状"参照
    root.appendChild(svg('path', { d: line((n) => Math.log(n) / Math.LN2).d, class: 'sk-c-log', fill: 'none' }));
    // 理论期望 (1/p)·log_{1/p}(n)
    root.appendChild(svg('path', { d: line((n) => SK.theory(n, p)).d, class: 'sk-c-th', fill: 'none' }));

    // 实测点
    let dm = '';
    pts.forEach((q, i) => { dm += (i ? 'L' : 'M') + X(q.n).toFixed(1) + ' ' + Y(q.v).toFixed(1); });
    root.appendChild(svg('path', { d: dm, class: 'sk-c-meas', fill: 'none' }));
    pts.forEach((q) => {
        const c = svg('circle', { cx: X(q.n), cy: Y(q.v), r: 3.6, class: 'sk-c-dot' });
        const tip = svg('title');
        tip.textContent = `n=${q.n}：实测平均 ${q.v.toFixed(2)} 步，理论 ${SK.theory(q.n, p).toFixed(2)} 步`;
        c.appendChild(tip);
        root.appendChild(c);
    });

    // 当前 n 的位置
    const st = sampleStat(state.n, p);
    root.appendChild(svg('line', { x1: X(state.n), x2: X(state.n), y1: PT, y2: PT + ih, class: 'sk-c-mark' }));
    root.appendChild(svg('circle', { cx: X(state.n), cy: Y(st.avgCost), r: 6, class: 'sk-c-cur' }));
    root.appendChild(T({
        x: X(state.n), y: Math.max(PT + 12, Y(st.avgCost) - 12), class: 'sk-c-cur-t', 'text-anchor': 'middle',
    }, `n=${state.n} → ${st.avgCost.toFixed(1)} 步`));

    // 右侧图例
    const lgx = PL + iw + 14;
    const lg = [
        ['sk-lgc-meas', '实测平均步数'],
        ['sk-lgc-th', `理论 (1/p)·log₁ᐟₚ n`],
        ['sk-lgc-log', 'log₂ n（形状参照）'],
        ['sk-lgc-lin', '链表 n/2'],
    ];
    lg.forEach((it, i) => {
        root.appendChild(svg('rect', { x: lgx, y: PT + 24 + i * 20, width: 16, height: 3, rx: 1.5, class: it[0] }));
        root.appendChild(T({ x: lgx + 22, y: PT + 24 + i * 20 + 4, class: 'sk-c-lg' }, it[1]));
    });

    return root;
}

function refreshCurveBox() {
    const box = state.dom.curveBox;
    if (!box) return;
    box.innerHTML = '';
    const p = P();
    const st = sampleStat(state.n, p);
    const th = SK.theory(state.n, p);
    const linCost = (state.n + 1) / 2;

    box.appendChild(buildCurve());
    box.appendChild(Viz.cmpGrid([
        { h: `跳表实测（n=${state.n}）`, v: st.avgCost.toFixed(1) + ' 步', d: `理论值 ${th.toFixed(1)} 步，误差 ${(Math.abs(st.avgCost - th) / th * 100).toFixed(1)}%`, cls: 'cmp-ok' },
        { h: '普通有序链表', v: linCost.toFixed(0) + ' 步', d: '(n+1)/2，随 n 线性涨', cls: 'cmp-bad' },
        { h: '快了', v: (linCost / Math.max(st.avgCost, 0.001)).toFixed(0) + ' ×', d: `n 再大 10 倍，这个倍数还会再涨`, cls: 'cmp-save' },
    ]));

    const rows = [8, 32, 128, 512, 1000];
    if (rows.indexOf(state.n) < 0) { rows.push(state.n); rows.sort((a, b) => a - b); }
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: 'n' }), h('th', { text: '实测平均步数' }),
        h('th', { text: '理论 (1/p)·log₁ᐟₚn' }), h('th', { text: 'log₂ n' }),
        h('th', { text: '链表 (n+1)/2' })));
    rows.forEach((n) => {
        const s = sampleStat(n, p);
        const tr = h('tr' + (n === state.n ? '.on' : ''), null,
            h('td', { html: '<b>' + n + '</b>' }),
            h('td', { html: '<span class="mv-strong">' + s.avgCost.toFixed(2) + '</span>' }),
            h('td', { text: SK.theory(n, p).toFixed(2) }),
            h('td', { text: (Math.log(n) / Math.LN2).toFixed(2) }),
            h('td', { html: '<span style="color:#f97316;font-weight:700">' + ((n + 1) / 2).toFixed(1) + '</span>' }));
        tb.appendChild(tr);
    });
    box.appendChild(h('div.mv-matrix-wrap', null, tb));
}

// ---------- 单步播放 ----------

function stopPlay() {
    state.playing = false;
    if (state.ticker) { state.ticker.stop(); state.ticker = null; }
}

function play() {
    stopPlay();
    const res = SK.search(state.list, state.target);
    if (state.stepIdx >= res.steps.length - 1) state.stepIdx = 0;
    state.playing = true;
    let acc = 0;
    state.ticker = Viz.ticker((dt) => {
        acc += dt;
        if (acc < 620) return true;
        acc = 0;
        const r = SK.search(state.list, state.target);
        state.stepIdx++;
        if (state.stepIdx >= r.steps.length - 1) {
            state.stepIdx = r.steps.length - 1;
            state.playing = false;
            state.ticker = null;
            render();
            return false;
        }
        render();
        return true;
    });
    state.ticker.start();
}

// ---------- 各卡片 ----------

function bestGapKey(list) {
    const keys = SK.toArray(list);
    let best = keys[0], bg = -1;
    keys.forEach((k) => {
        const g = SK.listSearch(list, k).steps - SK.searchCost(list, k).steps;
        if (g > bg) { bg = g; best = k; }
    });
    return best;
}

function cardMain() {
    const res = SK.search(state.list, state.target);
    const maxStep = res.steps.length - 1;
    if (state.stepIdx > maxStep) state.stepIdx = maxStep;
    const cur = res.steps[state.stepIdx];
    const lin = SK.listSearch(state.list, state.target);
    const st = SK.stats(state.list);

    const graph = buildSkipSvg(state.list, {
        walk: res, stepIdx: state.stepIdx, showLinear: true,
        linSteps: lin.steps, targetKey: state.target,
    });

    // 步进控制
    const jump = (i) => { stopPlay(); state.stepIdx = Math.max(0, Math.min(maxStep, i)); render(); };
    const nav = h('div.seq-nav', null,
        h('button.mini', { onclick: () => jump(state.stepIdx - 1) }, h('i.fas.fa-chevron-left'), ' 上一步'),
        h('span.seq-progress', { text: `${state.stepIdx} / ${maxStep}` }),
        h('button.mini.primary', { onclick: () => jump(state.stepIdx + 1) }, '下一步 ', h('i.fas.fa-chevron-right')),
        h('button.mini', {
            onclick: () => { if (state.playing) { stopPlay(); render(); } else play(); },
        }, state.playing ? '暂停' : '自动播放'),
        h('button.mini', { onclick: () => jump(maxStep) }, '一步到底'),
        h('button.mini', { onclick: () => jump(0) }, '重来')
    );

    // 目标选择
    const inp = h('input', { type: 'number', class: 'bp-input', placeholder: '要查的 key', value: String(state.target) });
    const doFind = () => {
        const v = Number(inp.value);
        if (inp.value === '' || Number.isNaN(v)) return;
        stopPlay(); state.target = v; state.stepIdx = 0; render();
        const el = rootEl.querySelector('.sk-find-input'); if (el) el.focus();
    };
    inp.className = 'bp-input sk-find-input';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(); });

    const ctl = h('div.controls', null,
        Viz.slider({
            label: '概率 p', min: 15, max: 75, step: 5, value: state.pPct,
            fmt: (v) => 'p = ' + (v / 100).toFixed(2),
            onInput: (v) => { stopPlay(); state.pPct = v; state.stepIdx = 0; state.lastOp = null; rebuild(); render(); },
        }),
        h('div.ctl-btns', null, inp,
            h('button.mini.primary', { onclick: doFind }, '查这个 key'),
            h('button.mini', {
                onclick: () => { stopPlay(); state.target = bestGapKey(state.list); state.stepIdx = 0; render(); },
            }, '差距最大的 key'),
            h('button.mini', {
                onclick: () => {
                    stopPlay(); state.keys = BASE_KEYS.slice(); state.extraIdx = 0;
                    state.lastOp = null; state.target = 61; state.stepIdx = 0; rebuild(); render();
                },
            }, '重置'))
    );

    // 步骤日志
    const log = h('div.sk-log');
    res.steps.forEach((s, i) => {
        const tag = s.type === 'right' ? '往右' : s.type === 'down' ? '下沉'
            : s.type === 'found' ? '命中' : s.type === 'fail' ? '没有' : '起点';
        log.appendChild(h('div.sk-log-item' + (i === state.stepIdx ? '.on' : '') + (i > state.stepIdx ? '.dim' : ''), {
            onclick: () => jump(i),
        },
            h('span.sk-log-n', { text: i === 0 ? '·' : String(i) }),
            h('span.sk-log-tag.t-' + s.type, { text: tag }),
            h('span.sk-log-t', { text: s.text })));
    });

    return Viz.card('fa-layer-group', '跳表长这样：底层是完整链表，上面全是抛硬币抽出来的索引',
        `当前 <b>${st.n}</b> 个 key、<b>${st.level}</b> 层、p = <b>${P().toFixed(2)}</b>。`
        + '<b>L1 是一条不折不扣的普通有序链表</b>，一个 key 都不能少；'
        + 'L2 是从 L1 里随机抽出来的一部分，L3 又是从 L2 里抽的……越往上越稀。'
        + '查找规则只有两条：<b>右邻居 ≤ 目标就往右跳，否则原地下沉一层</b>。'
        + '走出来的那条粉色折线，就是跳表全部的秘密。',
        graph,
        h('div.seq-note', { html: `<b>第 ${state.stepIdx} 步 · </b>${Viz.esc(cur.text)}` }),
        nav, log, ctl);
}

function cardCompare() {
    const res = SK.search(state.list, state.target);
    const lin = SK.listSearch(state.list, state.target);
    const st = SK.stats(state.list);
    const ratio = res.total > 0 ? (lin.steps / res.total) : 0;

    return Viz.card('fa-scale-balanced', '同一个 key，两条路：折线 vs 一条直路',
        `查 <b>${state.target}</b> 这个 key，跳表在 <b>${res.right}</b> 次右移 + <b>${res.down}</b> 次下沉之后`
        + `${res.found ? '命中' : '判定不存在'}；普通链表得老老实实挪 <b>${lin.steps}</b> 步。`
        + '步数口径：<b>右移一次算一步，下沉一次也算一步</b>，起点不算。',
        Viz.cmpGrid([
            { h: '跳表', v: res.total + ' 步', d: `右移 ${res.right} + 下沉 ${res.down}`, cls: 'cmp-ok' },
            { h: '普通有序链表', v: lin.steps + ' 步', d: '只能沿着 L1 一格一格挪', cls: 'cmp-bad' },
            { h: '快了', v: ratio.toFixed(1) + ' ×', d: `n=${st.n}，n 越大差得越离谱`, cls: 'cmp-save' },
        ]),
        h('p.sec-note', {
            html: '别被"才快几倍"骗了 —— 这里 n 只有 ' + st.n + '。'
                + '链表是 <b>n/2</b>，跳表是 <b>log 级</b>，两条曲线的形状根本不是一个物种：'
                + 'n 涨到 1000，链表要 500 步，跳表还是二十步左右。下面那张图会把这件事画给你看。',
        }));
}

function cardOps() {
    const inp = h('input', { type: 'number', class: 'bp-input sk-ins-input', placeholder: 'key' });
    const doIns = (k) => {
        stopPlay();
        const key = k == null ? Number(inp.value) : k;
        if (Number.isNaN(key)) return;
        const r = SK.insert(state.list, key, key);
        if (!r.duplicate) state.keys.push(key);
        state.lastOp = {
            type: 'insert', key, duplicate: r.duplicate, level: r.level,
            flips: r.flips, heads: r.heads, grew: r.grew, prevLevel: r.prevLevel,
            updKeys: updKeysOf(r.update, r.level),
        };
        state.stepIdx = 0;
        render();
    };
    const doDel = (k) => {
        stopPlay();
        const key = k == null ? Number(inp.value) : k;
        if (Number.isNaN(key)) return;
        const before = state.list.level;
        const upd = SK.findUpdate(state.list, key);
        const lv = upd.cand && upd.cand.key === key ? upd.cand.forward.length : state.list.level;
        const r = SK.remove(state.list, key);
        if (r.removed) {
            const i = state.keys.indexOf(key);
            if (i >= 0) state.keys.splice(i, 1);
        }
        state.lastOp = {
            type: 'delete', key, removed: r.removed, unlinked: r.unlinked,
            level: lv, shrank: before - state.list.level,
            updKeys: updKeysOf(r.update, lv),
        };
        state.stepIdx = 0;
        render();
    };

    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') doIns(); });

    const op = state.lastOp;
    const graph = buildSkipSvg(state.list, {
        updMarks: op ? op.updKeys : null,
        newKey: op && op.type === 'insert' && !op.duplicate ? op.key : null,
    });

    // 抛硬币记录
    let coinBox = null, detail = null;
    if (op && op.type === 'insert' && !op.duplicate) {
        coinBox = h('div.sk-coins');
        op.flips.forEach((f) => {
            coinBox.appendChild(h('span.sk-coin' + (f ? '.head' : '.tail'), { text: f ? '正' : '反' }));
        });
        coinBox.appendChild(h('span.sk-coin-eq', {
            html: `→ 连中 <b>${op.heads}</b> 次正面 → 这个节点占 <b>${op.level}</b> 层`,
        }));
        detail = h('div.seq-note', {
            html: `插入 <b>${op.key}</b>：先按 p=${P().toFixed(2)} 抛硬币，`
                + `抛出 ${op.heads} 次正面后收手，于是它的塔高 <b>${op.level}</b> 层。`
                + `然后在这 ${op.level} 层各挂一次链 —— 前驱就是下面这排 <code>update[]</code>。`
                + (op.grew ? `<br><b>它比整张表都高</b>，表高从 ${op.prevLevel} 涨到 ${op.level}，多出来的那几层前驱只能是头节点。` : ''),
        });
    } else if (op && op.type === 'insert' && op.duplicate) {
        detail = h('div.seq-note', {
            html: `<b>${op.key}</b> 已经在表里了。本演示对重复 key 的语义是「<b>覆盖 value</b>」：`
                + '不新建节点、不重新抛硬币、层数一点不变（对齐 Redis 的 <code>ZADD</code> —— '
                + '同一个 member 再 ZADD 是改分数，不会多出一份）。',
        });
    } else if (op && op.type === 'delete') {
        detail = h('div.seq-note', {
            html: op.removed
                ? `删除 <b>${op.key}</b>：它占了 <b>${op.level}</b> 层，就得在 `
                  + `<b>L${op.unlinked.map((i) => i + 1).join('、L')}</b> 这几层各解一次链 —— `
                  + '每层把前驱的指针改指到它的后继。'
                  + '<b>漏掉任何一层，那一层就还指着一个已经"不存在"的节点。</b>'
                  + (op.shrank ? `<br>最高的 ${op.shrank} 层被它删空了，表高收回 ${op.shrank} 层，`
                      + '否则以后每次查找都要在空层上白白下沉。' : '')
                : `表里没有 <b>${op.key}</b>，什么也没删（删不存在的 key 不该崩，也不该改结构）。`,
        });
    }

    let updBox = null;
    if (op && op.updKeys && op.updKeys.length) {
        updBox = h('div.sk-upd');
        updBox.appendChild(h('span.sk-upd-lab', { text: 'update[] =' }));
        for (let i = op.updKeys.length - 1; i >= 0; i--) {
            updBox.appendChild(h('span.sk-chip', {
                html: `L${i + 1} <b>${op.updKeys[i] == null ? '头' : op.updKeys[i]}</b>`,
            }));
        }
    }

    const ctl = h('div.controls', null,
        h('div.ctl-btns', null, inp,
            h('button.mini.primary', { onclick: () => doIns() }, '插入'),
            h('button.mini.danger', { onclick: () => doDel() }, '删除'),
            h('button.mini', {
                onclick: () => {
                    const k = EXTRA_KEYS[state.extraIdx % EXTRA_KEYS.length];
                    state.extraIdx++;
                    doIns(k);
                },
            }, '插下一个预设 key'),
            h('button.mini', { onclick: () => doIns(BASE_KEYS[5]) }, '试试插重复的 21'))
    );

    return Viz.card('fa-dice', '插入 = 抛硬币定层数 + 逐层挂链；删除 = 逐层解链',
        '插入的层数不是算出来的，是<b>抛硬币抛出来的</b>：抛到正面就再加一层，抛到反面就停。'
        + '这就是"概率性数据结构"的字面意思 —— 没有旋转、没有变色、没有再平衡，'
        + '<b>结构好不好全靠概率兜底</b>。'
        + `<span class="sk-badge">本演示用固定种子的线性同余伪随机，不是 Math.random，所以你刷新多少次结构都一样</span>`,
        graph,
        Viz.legend([{ cls: 'k-skn', text: '新插入的节点' }, { cls: 'k-sku', text: 'update[] 前驱（底下那条橙线）' }]),
        coinBox, detail, updBox, ctl);
}

function updKeysOf(update, level) {
    const out = [];
    for (let i = 0; i < level; i++) {
        const u = update[i];
        out.push(u && !u.isHead ? u.key : null);
    }
    return out;
}

function cardCurve() {
    const box = h('div.sk-curve-box');
    state.dom.curveBox = box;

    const ctl = h('div.controls', null,
        h('label.ctl.ctl-wide', null,
            h('span.ctl-name', { text: '节点数 n' }),
            h('input', {
                type: 'range', min: '8', max: '1000', step: '8', value: String(state.n),
                oninput: (e) => {
                    state.n = Number(e.target.value);
                    if (state.dom.nVal) state.dom.nVal.textContent = state.n + ' 个';
                    refreshCurveBox();
                },
            }),
            (state.dom.nVal = h('b.ctl-val', { text: state.n + ' 个' }))),
        h('div.ctl-btns', null,
            h('button.mini.primary', {
                onclick: () => {
                    state.n = 1000;
                    const s = rootEl.querySelector('.sk-curve-card input[type="range"]');
                    if (s) s.value = '1000';
                    if (state.dom.nVal) state.dom.nVal.textContent = '1000 个';
                    refreshCurveBox();
                },
            }, 'n = 1000（看差距）'),
            h('button.mini', {
                onclick: () => {
                    state.n = 8;
                    const s = rootEl.querySelector('.sk-curve-card input[type="range"]');
                    if (s) s.value = '8';
                    if (state.dom.nVal) state.dom.nVal.textContent = '8 个';
                    refreshCurveBox();
                },
            }, '回到 n = 8'))
    );

    const card = Viz.card('fa-chart-line', '打脸时刻：把 n 从 8 拖到 1000，实测点自己贴上理论曲线',
        '这张图是整个演示的重点。<b>绿点是真跑出来的</b>（每个 n 都建一棵真跳表，把表里所有 key 各查一次取平均），'
        + '紫色虚线是理论期望 <code>(1/p)·log₁ᐟₚ(n)</code>。'
        + '<b>没有任何拟合，绿点就是自己贴着紫线走的。</b>'
        + '而橙色那条 <code>n/2</code>（普通链表）画到 n≈' + (2 * 24) + ' 就已经冲出图外了。',
        box, ctl);
    card.classList.add('sk-curve-card');
    // 先把内容填进去（主视图必须在不播放动画的情况下就完整可读）
    refreshCurveBox();

    const note = h('p.sec-note', {
        html: '<b>第二个打脸点藏在这张图里：实测值大约是 log₂(n) 的 2 倍，不是 log₂(n) 本身。</b>'
            + '因为期望步数是 <code>(1/p)·log₁ᐟₚ(n)</code>，p=0.5 时就是 <code>2·log₂(n)</code> —— '
            + '那个 <b>1/p 的常数因子被大 O 记号吃掉了</b>。'
            + '所以浅灰的 log₂n 只是"形状参照"，它告诉你曲线是什么<b>形状</b>，不告诉你曲线在<b>哪</b>。',
    });
    card.appendChild(note);
    return card;
}

function cardP() {
    const p = P();
    const N = 1000;
    const st = sampleStat(N, p);
    const rows = [0.25, 0.5, 0.75];

    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: 'p' }), h('th', { text: '平均层数（实测）' }),
        h('th', { text: '理论 1/(1-p)' }), h('th', { text: '指针总数' }),
        h('th', { text: '最高层' }), h('th', { text: '平均查找步数' })));
    rows.forEach((pp) => {
        const s = sampleStat(N, pp);
        tb.appendChild(h('tr' + (Math.abs(pp - p) < 1e-9 ? '.on' : ''), null,
            h('td', { html: '<b>' + pp.toFixed(2) + '</b>' + (pp === 0.25 ? ' <small>Redis</small>' : '') }),
            h('td', { html: '<span class="mv-strong">' + s.avgLevel.toFixed(3) + '</span>' }),
            h('td', { text: (1 / (1 - pp)).toFixed(3) }),
            h('td', { text: String(s.pointers) }),
            h('td', { text: String(s.level) }),
            h('td', { html: '<span class="mv-strong">' + s.avgCost.toFixed(2) + '</span>' })));
    });

    return Viz.card('fa-sliders', 'p 怎么选：空间和时间就在这一个数字上拔河',
        `p 是"抛到正面继续加层"的概率。<b>p 越小，塔越矮、指针越少、越省内存，但查找越慢；`
        + `p 越大，索引越密、查得越快，但每个节点平均要挂 1/(1-p) 个指针。</b>`
        + `上面那个 p 滑块会连主图一起重建，拖一下就能看到层数肉眼可见地变。`
        + `<span class="sk-badge">当前 p = ${p.toFixed(2)}，期望每节点 ${(1 / (1 - p)).toFixed(2)} 个指针</span>`,
        Viz.cmpGrid([
            { h: `平均层数（n=${N} 实测）`, v: st.avgLevel.toFixed(2), d: `理论 1/(1-p) = ${(1 / (1 - p)).toFixed(2)}`, cls: 'cmp-ok' },
            { h: '期望空间开销', v: (1 / (1 - p)).toFixed(2) + ' 指针/节点', d: 'p=0.5 时正好是 2 个', cls: 'cmp-save' },
            { h: '平均查找步数', v: st.avgCost.toFixed(1) + ' 步', d: `理论 ${SK.theory(N, p).toFixed(1)} 步`, cls: 'cmp-bad' },
        ]),
        h('div.mv-matrix-wrap', null, tb),
        h('p.sec-note', {
            html: '看表里这三行：p 从 0.25 涨到 0.75，<b>平均层数从 1.33 涨到 4</b>（指针多了 3 倍），'
                + '但<b>平均查找步数反而先降后升</b> —— p 太大时层数太多，光下沉就要下沉半天。'
                + 'p=0.5 是步数最省的那一档；<b>Redis 却选了 0.25</b>，因为它宁可多走几步，'
                + '也要把每个 ZSet 节点的指针数压到 1.33 个 —— '
                + '一个 Redis 实例里可能有几百万个 ZSet 成员，指针省下来的是真金白银的内存。',
        }));
}

function cardRedis() {
    const zset = h('div.sk-zset', null,
        h('div.sk-zpanel', null,
            h('div.sk-zh', { html: '<i class="fas fa-table-cells"></i> 哈希表 dict' }),
            h('div.sk-zsub', { text: 'member → score' }),
            h('div.sk-zrow', { html: '<code>"张三"</code> → <b>89</b>' }),
            h('div.sk-zrow', { html: '<code>"李四"</code> → <b>95</b>' }),
            h('div.sk-zrow', { html: '<code>"王五"</code> → <b>72</b>' }),
            h('div.sk-zuse', { html: '<b>ZSCORE / ZADD 判重</b><br>O(1) 直接查分数' })),
        h('div.sk-zplus', { text: '+' }),
        h('div.sk-zpanel', null,
            h('div.sk-zh', { html: '<i class="fas fa-layer-group"></i> 跳表 zskiplist' }),
            h('div.sk-zsub', { text: '按 score 有序' }),
            h('div.sk-zrow', { html: '<b>72</b> <code>"王五"</code> → <b>89</b> <code>"张三"</code> → <b>95</b> <code>"李四"</code>' }),
            h('div.sk-zrow.sk-zrow-dim', { text: '上面还有若干层随机抽出来的索引' }),
            h('div.sk-zuse', { html: '<b>ZRANGE / ZRANGEBYSCORE / ZRANK</b><br>定位一次，然后顺着 L1 往右扫' })));

    return Viz.card('fa-database', 'Redis 的 ZSet 为什么用跳表而不是红黑树',
        '这是跳表最著名的落地场景，也是面试必问。先说一个很多人不知道的事实：'
        + '<b>ZSet 底层不是"一个"结构，是跳表 + 哈希表两份数据同时维护。</b>',
        zset,
        h('p.sec-note', {
            html: '<b>为什么要两份？</b>因为两种查询的形状完全不同。'
                + '<code>ZSCORE key member</code> 是"给我张三的分数"，这是等值查询，哈希表 O(1) 最合适；'
                + '<code>ZRANGEBYSCORE key 80 90</code> 是"给我 80 到 90 分的人"，这是范围查询，只有有序结构做得到。'
                + '两份数据共用同一批 member 对象（只多存指针，不复制字符串），所以代价没有想象中大。',
        }),
        Viz.flowList([
            {
                t: '① 范围查询是天然的 —— 这是最实在的理由',
                f: 'ZRANGEBYSCORE zset 80 90\n→ 跳表定位到第一个 ≥80 的节点\n→ 然后顺着最底层链表一路往右扫，扫到 >90 停',
                r: '定位一次 O(log n)，之后每吐一个元素 O(1)',
                hi: '红黑树也能做范围查询，但要写中序遍历 + 记录栈，来回上下跳；'
                    + '跳表的最底层<b>本来就是一条完整的有序链表</b>，扫过去就完事了。'
                    + 'Redis 的跳表最底层还额外加了 <code>backward</code> 反向指针，'
                    + '所以 <code>ZREVRANGE</code> 也能直接倒着扫。',
            },
            {
                t: '② 实现和调试简单得多 —— antirez 本人给的理由就是这个',
                f: '跳表插入：抛硬币 + 每层改一个指针\n红黑树插入：变色 + 左旋 + 右旋 + 5 种删除情况',
                r: '跳表核心代码百来行，红黑树的删除单独就能写一页',
                hi: 'antirez 在 Redis 邮件列表里解释过选型：跳表<b>实现、调试都更简单</b>，'
                    + '内存占用可以靠调 p 来控制，而且做范围操作很自然。'
                    + '这是一个非常务实的工程理由 —— 不是"更快"，是"更不容易写错"。',
            },
            {
                t: '③ 还能顺手支持 ZRANK（第几名）',
                f: '每个 forward 指针额外带一个 span（这一跳跨过了几个节点）\n查排名时把路径上的 span 加起来',
                r: 'ZRANK 也是 O(log n)，不用额外结构',
                hi: '这是 Redis 对标准跳表的一个改造。'
                    + '普通跳表教材里没有 span 字段，Redis 加上它，才让排行榜的"第几名"变成一次查找就能算出来。',
            },
            {
                t: '④ 局部修改，天然对并发友好（但这不是 Redis 的理由）',
                f: '跳表插入只改动 update[] 那几个指针\n红黑树旋转可能牵动到根，影响一整条路径',
                r: '所以 LevelDB / RocksDB 的 memtable、HBase 的 MemStore 都用跳表',
                hi: '注意别答错：<b>Redis 是单线程执行命令的，并发根本不是它选跳表的原因。</b>'
                    + '"并发友好"是跳表在<b>别的系统</b>里被选中的理由（无锁跳表实现成熟），'
                    + '面试时把这两件事混在一起答，反而会被追问到掉坑。',
            },
        ]),
        h('div.seq-note', {
            html: '<b>三个具体数字，能说出来就很加分：</b>'
                + 'Redis 源码里 <code>ZSKIPLIST_P = 0.25</code>（不是教科书默认的 0.5）、'
                + '<code>ZSKIPLIST_MAXLEVEL = 32</code>；'
                + '而且<b>小 ZSet 压根不用跳表</b> —— 元素个数不超过 <code>zset-max-listpack-entries</code>（默认 128）'
                + '且每个成员短于 <code>zset-max-listpack-value</code>（默认 64 字节）时，'
                + 'Redis 用的是紧凑的 <b>listpack</b>（老版本叫 ziplist），'
                + '超过任一阈值才转成 skiplist+dict。所以"ZSet = 跳表"这句话严格说只对大 ZSet 成立。',
        }));
}

function cardQA() {
    return Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        {
            q: '跳表凭什么是 O(log n)？给个不用公式的直觉。',
            a: '每往上一层，节点数期望变成下一层的 <b>p 倍</b>（p=0.5 就是砍一半）。'
                + '所以总层数期望是 <code>log₁ᐟₚ(n)</code>。'
                + '再看每一层：<b>你在某一层最多往右走几步就一定会下沉</b> —— '
                + '因为如果右邻居还能走，说明它没被抽到上一层去（否则你在上一层就已经走过它了），'
                + '而"没被抽到上层"这件事的概率是 1-p，期望连续发生 <code>1/p</code> 次。'
                + '所以总步数 ≈ <b>层数 × 每层步数 = (1/p)·log₁ᐟₚ(n)</b>。'
                + '这个推导比背结论值钱得多。',
        },
        {
            q: '跳表和红黑树/AVL 到底怎么选？',
            a: '① <b>要范围查询就选跳表</b>（<code>ZRANGEBYSCORE</code>、"分数在 80~90 的人"），'
                + '底层本来就是有序链表，扫过去就行；平衡树得写中序遍历。'
                + '② <b>要严格的最坏情况保证就选平衡树</b>：跳表是概率性的，'
                + '理论上存在退化成一条链表的可能（概率极低但不为 0），红黑树是<b>确定性</b>的 O(log n)。'
                + '③ <b>要好写好维护就选跳表</b>：没有旋转、没有变色，插入删除就是改几个指针。'
                + '④ <b>要省内存就选平衡树</b>：跳表每节点平均 1/(1-p) 个指针，'
                + '红黑树固定 2 个孩子指针 + 1 bit 颜色。',
        },
        {
            q: 'Redis 的 ZSet 底层到底是什么？',
            a: '<b>大 ZSet 是 skiplist + dict 两个结构同时维护</b>：'
                + 'dict 存 <code>member → score</code>，让 <code>ZSCORE</code> 是 O(1)；'
                + 'skiplist 按 score 排序，让 <code>ZRANGE / ZRANGEBYSCORE / ZRANK</code> 能做。'
                + '两者共享同一批 member 对象，不重复存字符串。'
                + '<b>小 ZSet（≤128 个元素且成员 &lt;64 字节）用 listpack</b>，'
                + '整块连续内存，省得为几个元素分配一堆节点。'
                + '另外 Redis 的跳表节点比教科书多两样：<code>span</code>（支持 ZRANK）和 '
                + '<code>backward</code>（支持 ZREVRANGE）。',
        },
        {
            q: '为什么层数要随机？"每两个提一个"这种确定性做法不行吗？',
            a: '确定性的"理想跳表"（每 2 个提一个，像完美二叉索引）查找确实是严格 O(log n)，'
                + '<b>但插入一个元素可能要把后面所有节点的层数全部重排</b>，最坏 O(n)。'
                + '这就跟数组"有序但插入贵"是一个毛病。'
                + '随机化的意义在于：<b>用"期望正确"换"局部修改"</b> —— '
                + '插入只碰 update[] 那几个指针，跟表里其它节点完全无关。'
                + '这是跳表设计里最精妙的一步权衡。',
        },
        {
            q: 'LevelDB / RocksDB 的 memtable 为什么也用跳表？',
            a: '三个原因叠一块：① memtable 要<b>按 key 有序</b>，将来才能顺序刷成 SSTable；'
                + '② 写入极其频繁，跳表插入<b>只改局部指针</b>，配上 CAS 就能做无锁并发写，'
                + '而平衡树的旋转会牵动一整条路径，加锁粒度下不去；'
                + '③ 迭代器要能顺序扫，跳表最底层天然就是有序链表。'
                + '注意这里"并发友好"是真理由，但放到 Redis 身上就不是了 —— Redis 是单线程的。',
        },
    ]));
}

function cardPitfalls() {
    return Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls([
        ['它是概率性的，最坏情况仍然是 O(n)',
            '这是跳表和红黑树的<b>本质区别</b>，不是实现细节。理论上所有节点都抛出"反面"、'
            + '整张表退化成一条单链表，是可能发生的（p=0.5、n=1000 时概率约 2⁻¹⁰⁰⁰ 量级，'
            + '比硬盘同时全坏还小得多）。<b>但"极小"不等于"没有"</b>，'
            + '需要硬实时保证的场景（航电、某些交易系统）就该老实用平衡树。'
            + '面试被问"跳表的时间复杂度"，答 O(log n) 之后最好补一句"这是期望复杂度"。'],
        ['空间不是白来的：每节点平均 1/(1-p) 个指针',
            'p=0.5 时是 <b>2 个</b>指针/节点，p=0.25 时是 <b>1.33 个</b>。'
            + '别只记住"跳表比链表快"，它是<b>拿指针换出来的</b>。'
            + '而且指针分散在堆上，<b>缓存局部性很差</b> —— 这也是数据库磁盘索引选 B+ 树不选跳表的原因：'
            + 'B+ 树一个节点就是一整个 16KB 页，一次 IO 能带回上千个 key；'
            + '跳表每跳一次都可能是一次 cache miss。'],
        ['删除必须逐层解链，还要把表高收回来',
            '删除时每一层都要检查 <code>update[i].forward[i] === 目标节点</code> 才改指针 —— '
            + '因为目标节点可能根本没到那么高，那一层的前驱指的是别人，改了就串味。'
            + '删完还要 <code>while (level>1 && !head.forward[level-1]) level--</code>，'
            + '否则最高那几层空着，<b>以后每次查找都要在空层上白白下沉几步</b>，性能悄悄劣化。'],
        ['randomLevel 千万别写成"每次 while 里 new 一个随机数生成器"',
            'Redis 的写法是 <code>(random() &amp; 0xFFFF) &lt; p * 0xFFFF</code> —— '
            + '取整数位比较，不做浮点除法，抠到这个份上是因为它在<b>每一次 ZADD 的热路径上</b>。'
            + '另外循环必须有 <code>level &lt; MAXLEVEL</code> 的上限，'
            + '否则一串极端好运会让层数飙到几十层，数组越界或者浪费一大片内存。'],
        ['跳表"有序"指的是最底层，别去遍历上层',
            '只有 L1 是完整的。想拿到全部元素、想做范围扫描，<b>永远走最底层</b>；'
            + '上层只是索引，遍历上层得到的是一个残缺的子集。'
            + '写迭代器时如果不小心停在了上层节点上，返回的数据会莫名其妙缺一大半，'
            + '而且这种 bug 在小数据量下很可能测不出来（元素少的时候上层几乎等于底层）。'],
    ]));
}

function cardFoot() {
    return h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示（口径与简化）' }),
        h('p', {
            html: '<b>随机数是假的，而且是故意的。</b>抛硬币用的是固定种子（<code>' + SK.SEED + '</code>）的'
                + '线性同余伪随机（<code>s = s×1664525 + 1013904223 mod 2³²</code>，取高 24 位），'
                + '不是 <code>Math.random()</code>。所以<b>你刷新多少次、换什么浏览器，看到的层数分布都一模一样</b> —— '
                + '这是为了让多方案严格可对照、单测能断言。真实实现当然要用真随机源。',
        }),
        h('p', {
            html: '<b>步数口径：</b>右移一次算一步，下沉一次也算一步，起点不算。'
                + '查找的比较规则用的是「右邻居 key ≤ 目标就往右」，所以命中时会直接停在目标节点上；'
                + '插入/删除内部用的是标准的「严格小于」来求 <code>update[]</code>，两处不是同一个判断，别混。',
        }),
        h('p', {
            html: '<b>「平均查找步数」的算法：</b>把表里所有 key 各查一次，取平均。'
                + '<b>没有统计查不到的 key</b>（未命中的查找会稍贵一点点，因为必须一路沉到 L1）。'
                + '曲线上每个点都是现场建一棵真跳表跑出来的，不是拟合、不是公式代入。',
        }),
        h('p', {
            html: '<b>重复 key 的语义选的是「覆盖 value」</b>（对齐 Redis <code>ZADD</code>），'
                + '不是"拒绝"也不是"允许重复"。代码注释里写明了。',
        }),
        h('p', {
            html: '<b>没画出来的部分：</b>Redis 跳表节点上的 <code>span</code>（支持 ZRANK）和 '
                + '<code>backward</code>（支持 ZREVRANGE）字段、以及小 ZSet 用的 listpack 编码，'
                + '这张图里都没有 —— 它画的是<b>教科书版跳表</b>，'
                + 'Redis 的 <code>t_zset.c</code> 在此基础上还有一层工程改造。',
        }));
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    rootEl.appendChild(cardMain());
    rootEl.appendChild(cardCompare());
    rootEl.appendChild(cardOps());
    rootEl.appendChild(cardCurve());
    rootEl.appendChild(cardP());
    rootEl.appendChild(cardRedis());
    rootEl.appendChild(cardQA());
    rootEl.appendChild(cardPitfalls());
    rootEl.appendChild(cardFoot());
}

Viz.register({
    id: 'skip-list',
    cat: 'algo',
    title: '跳表 Skip List',
    subtitle: 'Redis ZSet 的骨架',
    icon: 'fa-layer-group',
    blurb: '抛硬币抛出来的多层索引，凭什么能做到 O(log n)',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.pPct = 50;
        state.keys = BASE_KEYS.slice();
        state.extraIdx = 0;
        state.lastOp = null;
        state.stepIdx = 0;
        state.n = 512;
        rebuild();
        state.target = bestGapKey(state.list);
        render();
    },
    unmount() {
        stopPlay();
        state.dom = {};
        state.lastOp = null;
        rootEl = null;
    },
});

})();
