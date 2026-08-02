// ============================================================
//  演示：HashMap（照着 JDK 8 的实现来）
//  一次 put 的四步：hashCode() → 扰动 h ^ (h>>>16) → index = hash & (n-1) → 尾插。
//  三个打脸：
//   A. `& (n-1)` 在 n=16 时只用低 4 位，高 28 位全扔了 —— 扰动就是来救这个的。
//   B. 扩容只多用一个 bit，所以原桶 i 的元素只会去 i 或 i+oldCap，不用重算 hash。
//   C. 树化要「链表 ≥ 8 且桶数组 ≥ 64」，只满足前者是<b>先扩容</b>；退化阈值是 6 不是 7。
//  上半 HM.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const HM = {};

HM.DEFAULT_CAP = 16;
HM.LOAD_FACTOR = 0.75;
HM.TREEIFY_THRESHOLD = 8;
HM.UNTREEIFY_THRESHOLD = 6;
HM.MIN_TREEIFY_CAPACITY = 64;

/** Java 的 String.hashCode()：h = 31*h + c，溢出按 int32 截断 */
HM.javaHash = function (str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h;
};

/**
 * JDK 8 HashMap.hash() 的「扰动函数」：
 *   (h = key.hashCode()) ^ (h >>> 16)
 * 把高 16 位异或到低 16 位上，让高位的差异也能影响到最终的桶下标。
 * JS 的 >>> 和 Java 的 >>> 语义一致（都是按 32 位无符号右移），所以能一比一还原。
 */
HM.spread = function (h) {
    return (h ^ (h >>> 16)) | 0;
};

/** index = hash & (n-1)。n 是 2 的幂时，这一步等价于「取 hash 的低 log₂n 位」 */
HM.indexFor = function (hash, cap) {
    return (hash & (cap - 1)) >>> 0;
};

/** 32 位二进制串，用来把「扰动」这件事画出来 */
HM.bits = function (v) {
    let s = (v >>> 0).toString(2);
    while (s.length < 32) s = '0' + s;
    return s;
};

/** 建一个 key。kind='int' 时 hashCode 就是它自己（Integer.hashCode 的真实行为）*/
HM.key = function (name, kind) {
    if (kind === 'int') return { name: String(name), kind: 'int', hash: Number(name) | 0 };
    return { name: String(name), kind: 'str', hash: HM.javaHash(String(name)) };
};

/**
 * 建一张表并把 keys 依次 put 进去。
 * opt = {
 *   cap:    初始容量（2 的幂）
 *   spread: 是否启用扰动函数
 *   jdk8:   true 时严格按 JDK8 的规则自动扩容 / 树化；
 *           false 时容量锁死、不树化 —— 只看纯粹的「散列分布」，两种设置才好对照
 * }
 */
HM.build = function (keys, opt) {
    opt = opt || {};
    const map = {
        cap: opt.cap || HM.DEFAULT_CAP,
        useSpread: opt.spread !== false,
        jdk8: !!opt.jdk8,
        size: 0,
        buckets: [],
        trees: {},
        resizes: 0,
        treeified: 0,
    };
    for (let i = 0; i < map.cap; i++) map.buckets.push([]);
    const events = [];
    keys.forEach((k) => { HM.put(map, k, events); });
    return { map, events, dist: HM.dist(map) };
};

HM.hashOf = function (map, key) {
    return map.useSpread ? HM.spread(key.hash) : (key.hash | 0);
};

/** put 一个 key。events 会记下扩容 / 树化这些「大事」 */
HM.put = function (map, key, events) {
    const hs = HM.hashOf(map, key);
    const idx = HM.indexFor(hs, map.cap);
    map.buckets[idx].push({ key, raw: key.hash, hs, home: idx });
    map.size++;

    const rec = { key: key.name, raw: key.hash, hs, idx, len: map.buckets[idx].length, acts: [] };

    if (map.jdk8) {
        // ① 链表长度达到 8 → 尝试树化
        if (map.buckets[idx].length >= HM.TREEIFY_THRESHOLD && !map.trees[idx]) {
            if (map.cap < HM.MIN_TREEIFY_CAPACITY) {
                rec.acts.push({
                    kind: 'resize-not-treeify',
                    text: '桶 ' + idx + ' 的链表到了 ' + map.buckets[idx].length + ' 个，'
                        + '但桶数组只有 ' + map.cap + ' < 64 —— <b>不树化，先扩容</b>',
                });
                HM.resize(map, rec);
            } else {
                map.trees[idx] = true;
                map.treeified++;
                rec.acts.push({
                    kind: 'treeify',
                    text: '桶 ' + idx + ' 链表到 8 且桶数组 ' + map.cap + ' ≥ 64 → <b>转红黑树</b>',
                });
            }
        }
        // ② 元素总数超过 容量×0.75 → 扩容
        if (map.size > map.cap * HM.LOAD_FACTOR) {
            rec.acts.push({
                kind: 'resize-load',
                text: '元素数 ' + map.size + ' > 容量 ' + map.cap + ' × 0.75 = '
                    + (map.cap * HM.LOAD_FACTOR) + ' → <b>扩容</b>',
            });
            HM.resize(map, rec);
        }
    }
    if (events) events.push(rec);
    return rec;
};

/**
 * 扩容：容量翻倍，然后按 (hash & oldCap) 把每条链拆成 lo / hi 两条。
 *   (hash & oldCap) == 0  →  留在原下标 j
 *   否则                   →  搬到 j + oldCap
 * 完全不需要重算 hash，也不需要重新取模 —— 而且<b>链内相对顺序不变</b>。
 */
HM.resize = function (map, rec) {
    const oldCap = map.cap, newCap = oldCap * 2;
    const old = map.buckets;
    const next = [];
    for (let i = 0; i < newCap; i++) next.push([]);
    const moves = [];
    for (let j = 0; j < oldCap; j++) {
        old[j].forEach((n) => {
            const stay = (n.hs & oldCap) === 0;
            const to = stay ? j : j + oldCap;
            next[to].push(n);
            moves.push({ key: n.key.name, hs: n.hs, from: j, to, lo: stay });
        });
    }
    map.buckets = next;
    map.cap = newCap;
    map.resizes++;
    map.trees = {};   // 简化：扩容后树的形态重新判定，这里直接清掉
    if (rec) rec.resize = { oldCap, newCap, moves };
    return { oldCap, newCap, moves };
};

/** 单独把某个桶的拆分算出来（用于「扩容」那一节的可视化，不改动原表）*/
HM.splitBucket = function (map, j) {
    const oldCap = map.cap;
    const lo = [], hi = [];
    map.buckets[j].forEach((n) => {
        if ((n.hs & oldCap) === 0) lo.push(n); else hi.push(n);
    });
    return { j, oldCap, newCap: oldCap * 2, lo, hi, hiIndex: j + oldCap };
};

/** 每个桶里有几个元素 */
HM.dist = function (map) {
    return map.buckets.map((b) => b.length);
};

/** 分布的「坏」程度：最长链、非空桶数、方差 */
HM.quality = function (map) {
    const d = HM.dist(map);
    const used = d.filter((v) => v > 0).length;
    const max = d.length ? Math.max.apply(null, d) : 0;
    const mean = map.size / Math.max(1, map.cap);
    let varr = 0;
    d.forEach((v) => { varr += (v - mean) * (v - mean); });
    varr /= Math.max(1, map.cap);
    return { maxChain: max, usedBuckets: used, buckets: map.cap, variance: Math.round(varr * 1000) / 1000 };
};

/**
 * 泊松分布：良好哈希 + 默认负载因子下，λ ≈ 0.5，
 * 一个桶里恰好有 k 个元素的概率 = e^-λ · λ^k / k!
 * JDK 8 HashMap 的源码注释里就贴了这张表，这就是「阈值定成 8」的依据。
 */
HM.poisson = function (k, lambda) {
    const l = lambda == null ? 0.5 : lambda;
    let fact = 1;
    for (let i = 2; i <= k; i++) fact *= i;
    return Math.exp(-l) * Math.pow(l, k) / fact;
};

// ---------- 预设的 key 组 ----------

HM.PRESETS = {
    normal: {
        name: '普通字符串 key',
        note: '就是日常代码里那种 key，hashCode 是 String.hashCode() 算出来的。',
        keys: ['user', 'name', 'age', 'email', 'phone', 'city', 'role', 'token',
            'order', 'price', 'count', 'status'].map((s) => HM.key(s, 'str')),
    },
    collide: {
        name: '低位全相同的 key（构造出来的）',
        note: 'Integer 的 hashCode 就是它自己。这里取 65536 的倍数 —— '
            + '它们的<b>低 16 位全是 0</b>，只有高位不一样。',
        keys: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => HM.key(i * 65536, 'int')),
    },
    resize: {
        name: '同桶但高低位分开的 key',
        note: '全都 ≡ 5 (mod 16)，所以在容量 16 时挤在同一个桶里；'
            + '但它们的第 5 个 bit（值 16）不一样，扩容到 32 时正好一半一半。',
        keys: [5, 21, 37, 53, 69, 85, 101, 117].map((i) => HM.key(i, 'int')),
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = HM;
if (typeof window !== 'undefined') window.HMModel = HM;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const state = {
    preset: 'collide',
    spread: true,
    cap: 16,
    focusKey: 0,
};

let rootEl = null;

function curKeys() { return HM.PRESETS[state.preset].keys; }

// ---------- 桶数组图 ----------

function drawBuckets(built, title) {
    const map = built.map;
    const rows = map.cap;
    const ROWH = 24, PAD_L = 46, PAD_T = 24;
    const W = 700;
    const H = PAD_T + rows * ROWH + 8;
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'hm-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': title,
    });
    const t = svg('text', { x: 2, y: 13, class: 'hm-title' });
    t.textContent = title;
    root.appendChild(t);

    for (let i = 0; i < rows; i++) {
        const y = PAD_T + i * ROWH;
        const b = map.buckets[i];
        root.appendChild(svg('rect', {
            x: 4, y: y + 2, width: 34, height: ROWH - 5, rx: 4,
            class: 'hm-bidx' + (b.length ? ' hm-bidx-on' : ''),
        }));
        const bl = svg('text', { x: 21, y: y + 15, class: 'hm-bidx-t', 'text-anchor': 'middle' });
        bl.textContent = String(i);
        root.appendChild(bl);

        if (!b.length) {
            const nl = svg('text', { x: PAD_L, y: y + 15, class: 'hm-null' });
            nl.textContent = 'null';
            root.appendChild(nl);
            continue;
        }
        const isTree = !!map.trees[i];
        const nodeW = Math.min(74, (W - PAD_L - 14) / b.length - 6);
        b.forEach((n, k) => {
            const x = PAD_L + k * (nodeW + 6);
            root.appendChild(svg('rect', {
                x, y: y + 2, width: nodeW, height: ROWH - 5, rx: 4,
                class: 'hm-node' + (isTree ? ' hm-node-tree' : ''),
            }));
            const nl = svg('text', {
                x: x + nodeW / 2, y: y + 15, class: 'hm-node-t', 'text-anchor': 'middle',
            });
            nl.textContent = n.key.name;
            const ti = svg('title');
            ti.textContent = n.key.name + '  hashCode=' + n.raw + '  扰动后=' + n.hs
                + '  index=' + HM.indexFor(n.hs, map.cap);
            nl.appendChild(ti);
            root.appendChild(nl);
            if (k < b.length - 1) {
                root.appendChild(svg('line', {
                    x1: x + nodeW, y1: y + ROWH / 2 - 1.5, x2: x + nodeW + 6, y2: y + ROWH / 2 - 1.5,
                    class: 'hm-link',
                }));
            }
        });
        if (isTree) {
            const tl = svg('text', { x: W - 6, y: y + 15, class: 'hm-tree-l', 'text-anchor': 'end' });
            tl.textContent = '红黑树';
            root.appendChild(tl);
        }
    }
    return root;
}

// ---------- 分布柱状图 ----------

function drawDist(built, title, cls) {
    const d = HM.dist(built.map);
    const W = 340, H = 148, PAD_L = 24, PAD_B = 24, PAD_T = 26;
    const iw = W - PAD_L - 8, ih = H - PAD_T - PAD_B;
    const bw = iw / d.length;
    const maxV = Math.max(1, Math.max.apply(null, d));
    const root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'hm-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': title,
    });
    const t = svg('text', { x: 2, y: 12, class: 'hm-title' });
    t.textContent = title;
    root.appendChild(t);
    const q = HM.quality(built.map);
    const s = svg('text', { x: 2, y: 22, class: 'hm-sub' });
    s.textContent = '最长链 ' + q.maxChain + '　用到 ' + q.usedBuckets + '/' + q.buckets + ' 个桶';
    root.appendChild(s);

    for (let v = 0; v <= maxV; v++) {
        const y = PAD_T + ih - (v / maxV) * ih;
        root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L + iw, y1: y, y2: y, class: 'hm-grid' }));
        if (v === maxV || v === 0) {
            const lb = svg('text', { x: PAD_L - 4, y: y + 3.5, class: 'hm-ax', 'text-anchor': 'end' });
            lb.textContent = String(v);
            root.appendChild(lb);
        }
    }
    d.forEach((v, i) => {
        const x = PAD_L + i * bw;
        const hh = (v / maxV) * ih;
        root.appendChild(svg('rect', {
            x: x + bw * 0.14, y: PAD_T + ih - hh, width: bw * 0.72, height: Math.max(v ? 2 : 0, hh),
            rx: 2, class: cls,
        }));
        if (i % 4 === 0) {
            const lb = svg('text', { x: x + bw / 2, y: H - 8, class: 'hm-ax', 'text-anchor': 'middle' });
            lb.textContent = String(i);
            root.appendChild(lb);
        }
    });
    const xl = svg('text', { x: PAD_L + iw / 2, y: H - 1, class: 'hm-ax', 'text-anchor': 'middle' });
    xl.textContent = '桶下标';
    root.appendChild(xl);
    return root;
}

// ---------- 位运算图 ----------

function bitRow(label, value, opt) {
    opt = opt || {};
    const bits = HM.bits(value);
    const row = h('div.hm-bitrow');
    row.appendChild(h('span.hm-bitlabel', { text: label }));
    const box = h('span.hm-bits');
    for (let i = 0; i < 32; i++) {
        const lowN = opt.lowBits || 0;
        const isLow = i >= 32 - lowN;
        const isHigh = opt.markHigh && i < 16;
        box.appendChild(h('span.hm-bit'
            + (bits[i] === '1' ? '.on' : '')
            + (isLow ? '.low' : '')
            + (isHigh ? '.high' : ''), { text: bits[i] }));
        if (i % 8 === 7 && i < 31) box.appendChild(h('span.hm-bitgap'));
    }
    row.appendChild(box);
    row.appendChild(h('span.hm-bitval', { text: opt.note || String(value) }));
    return row;
}

// ---------- 渲染 ----------

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const keys = curKeys();
    const preset = HM.PRESETS[state.preset];
    // 分布对照用「锁死容量、不树化」的口径，否则两边容量都不一样，没法比
    const withS = HM.build(keys, { cap: state.cap, spread: true, jdk8: false });
    const noS = HM.build(keys, { cap: state.cap, spread: false, jdk8: false });
    const cur = state.spread ? withS : noS;

    // ── 场景 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-table-cells"></i> 场景：一个 key 进来，它落到哪个桶？' }),
        h('p.sec-note', {
            html: 'JDK 8 的 HashMap 就是「<b>一个数组 + 每格挂一条链表（长了转红黑树）</b>」。'
                + '一次 <code>put</code> 只有四步：<br>'
                + '<b>① 算 hashCode</b> → <b>② 扰动 <code>h ^ (h&gt;&gt;&gt;16)</code></b> → '
                + '<b>③ 定位 <code>index = hash &amp; (n-1)</code></b> → <b>④ 尾插</b>。<br>'
                + '第 ② 步看着莫名其妙，它其实是在给第 ③ 步擦屁股 —— 下面就讲这个。',
        }),
        Viz.segmented({
            options: Object.keys(HM.PRESETS).map((k) => ({ v: k, label: HM.PRESETS[k].name })),
            value: state.preset,
            onPick: (v) => { state.preset = v; state.focusKey = 0; render(); },
        }),
        h('p.sec-note', { html: preset.note }),
        h('div.controls', null,
            Viz.slider({
                label: '桶数组容量 n', min: 4, max: 6, step: 1, value: Math.log2(state.cap),
                fmt: (v) => Math.pow(2, v) + ' 个桶',
                onInput: (v) => { state.cap = Math.pow(2, v); render(); },
            }),
            h('div.ctl-btns', null,
                h('button.mini' + (state.spread ? '.primary' : ''), {
                    onclick: () => { state.spread = true; render(); },
                }, '开启扰动'),
                h('button.mini' + (state.spread ? '.danger' : ''), {
                    onclick: () => { state.spread = false; render(); },
                }, '关闭扰动')
            )
        )
    ));

    // ── 主视图：桶数组 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list"></i> 桶数组现在长这样' }),
        h('p.sec-note', {
            html: '鼠标停在某个 key 上能看到它的 hashCode、扰动后的值和最终下标。'
                + '（这一节为了让「开扰动 / 关扰动」能严格对照，'
                + '<b>锁死了容量、也关掉了自动扩容和树化</b>，只看纯粹的散列分布。）',
        }),
        drawBuckets(cur, (state.spread ? '开启扰动' : '关闭扰动')
            + '　容量 ' + state.cap + '　' + keys.length + ' 个 key')
    ));

    // ── 打脸 A ──
    rootEl.appendChild(spreadCard(withS, noS, keys));

    // ── 打脸 B：扩容 ──
    rootEl.appendChild(resizeCard());

    // ── 打脸 C：树化 ──
    rootEl.appendChild(treeifyCard());

    // ── 四步流程 ──
    const k0 = keys[Math.min(state.focusKey, keys.length - 1)];
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list-ol"></i> 一次 put 的完整四步' }),
        Viz.flowList([
            {
                t: '① 拿 key 的 hashCode()',
                f: (k0.kind === 'int'
                    ? 'Integer.hashCode() 直接返回它自己\n' + k0.name + '.hashCode() = ' + k0.hash
                    : 'String.hashCode(): h = 31*h + c\n"' + k0.name + '".hashCode() = ' + k0.hash),
                r: 'hashCode = ' + k0.hash,
                hi: '注意 hashCode 是 <b>int（32 位有符号）</b>，可能是负数。'
                    + '如果这里直接对容量取模，负数会出问题 —— 这也是为什么下一步用位与而不是 %。',
            },
            {
                t: '② 扰动：h ^ (h >>> 16)',
                f: 'static final int hash(Object key) {\n'
                    + '    int h;\n'
                    + '    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);\n'
                    + '}',
                r: '扰动后 = ' + HM.spread(k0.hash),
                hi: '把高 16 位异或到低 16 位上。<b>成本只有一次移位一次异或</b>，'
                    + '却能让高位的差异参与到下标计算里 —— 这是个非常便宜的保险。',
            },
            {
                t: '③ 定位：index = hash & (n-1)',
                f: 'index = (n - 1) & hash;   // n = ' + state.cap + '，n-1 = '
                    + (state.cap - 1) + ' = 0b' + (state.cap - 1).toString(2),
                r: 'index = ' + HM.indexFor(HM.hashOf(cur.map, k0), state.cap),
                hi: '<b>因为容量恒为 2 的幂，位与才等价于取模，而且比 % 快得多、还天然非负。</b>'
                    + '代价就是：它<b>只看低 log₂n 位</b>，高位全被扔掉 —— 所以才需要第 ② 步。',
            },
            {
                t: '④ 放进桶：空桶直接放；有冲突就比 hash 和 equals，都不同就尾插',
                f: 'if (p.hash == hash && (p.key == key || key.equals(p.key)))\n'
                    + '    覆盖旧值;\nelse\n    尾插到链表末尾;',
                r: '当前这个桶里有 ' + cur.map.buckets[HM.indexFor(HM.hashOf(cur.map, k0), state.cap)].length + ' 个元素',
                hi: '<b>JDK 8 改成了尾插</b>，JDK 7 是头插。'
                    + '改这个不是为了性能，是为了避免 JDK 7 里「多线程同时扩容导致链表成环、'
                    + '之后所有 get 都死循环、CPU 打满 100%」那个著名的 bug。'
                    + '（注意：<b>尾插只是让「成环」不再发生，HashMap 依然不是线程安全的</b>，'
                    + '并发下照样会丢数据。）',
            },
        ])
    ));

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: '为什么 HashMap 的容量必须是 2 的幂？',
                a: '因为这样 <code>hash &amp; (n-1)</code> 才等价于 <code>hash % n</code>，'
                    + '而位与比取模快得多，还<b>天然非负</b>（hashCode 可能是负数，'
                    + '直接 % 会得到负下标）。<br>'
                    + '第二个原因在<b>扩容</b>时：容量翻倍等于「掩码多一个 bit」，'
                    + '所以每个元素要么不动、要么整体挪 oldCap，'
                    + '<b>一个 bit 就能判断，不用重算 hash</b>。<br>'
                    + '所以你 <code>new HashMap&lt;&gt;(10)</code> 时，它实际会用 '
                    + '<code>tableSizeFor(10) = 16</code>。',
            },
            {
                q: '扰动函数是干什么的？不要行不行？',
                a: '因为 <code>&amp; (n-1)</code> <b>只用得上低 log₂n 位</b> —— '
                    + 'n=16 时只看低 4 位，高 28 位<b>完全被扔掉</b>。'
                    + '如果一批 key 的 hashCode 恰好低位相同、只有高位不同，'
                    + '它们就会全挤进同一个桶。<br>'
                    + '<code>h ^ (h &gt;&gt;&gt; 16)</code> 把高 16 位异或到低 16 位，'
                    + '让高位的差异也能影响下标。<b>成本是一次移位一次异或，'
                    + '收益是在最坏情况下不至于退化。</b><br>'
                    + '（JDK 7 的扰动做了 4 次移位异或，JDK 8 简化成 1 次 —— '
                    + '因为有了红黑树兜底，不需要那么用力了。）',
            },
            {
                q: '扩容时元素怎么迁移？',
                a: '<b>不需要重新计算 hash，也不需要重新取模。</b>'
                    + '容量从 n 翻到 2n，掩码从 <code>n-1</code> 变成 <code>2n-1</code>，'
                    + '只多用了一个 bit（值恰好是 oldCap）。所以原来在桶 j 的元素：<br>'
                    + '<code>(hash &amp; oldCap) == 0</code> → 还在桶 <b>j</b>（lo 链）<br>'
                    + '否则 → 去桶 <b>j + oldCap</b>（hi 链）<br>'
                    + 'JDK 8 用两个指针一趟扫完，把链拆成 lo 和 hi 两条，'
                    + '<b>链内的相对顺序完全不变</b>（这也是尾插的一个好处）。',
            },
            {
                q: '什么时候转红黑树？为什么阈值是 8？',
                a: '<b>两个条件必须同时满足</b>：链表长度 ≥ 8 <b>且</b> 桶数组长度 ≥ 64。'
                    + '只满足前者时 JDK 8 <b>会先扩容而不是树化</b> —— '
                    + '因为表太小时链表长多半是「桶不够用」而不是「哈希质量差」，扩容更划算。<br>'
                    + '<b>8 这个数来自泊松分布</b>：良好哈希 + 默认负载因子 0.75 时，'
                    + '一个桶里有 k 个元素近似服从 λ=0.5 的泊松分布，'
                    + 'k=8 的概率约 <b>6×10⁻⁸</b>（千万分之一都不到）。'
                    + '也就是说<b>正常情况下永远不该走到树化这一步</b> —— 它是防御性的兜底。<br>'
                    + '<b>退化阈值是 6 不是 7</b>：留一个空档，'
                    + '免得在 7 附近反复插入删除时来回横跳（树↔链的转换本身很贵）。',
            },
            {
                q: 'HashMap 线程不安全体现在哪？',
                a: 'JDK 7 最出名的是<b>头插法在并发扩容时会把链表接成环</b>，'
                    + '之后任何 get 命中那个桶都会<b>死循环，CPU 打满 100%</b>。'
                    + 'JDK 8 改成尾插消除了成环。<br>'
                    + '<b>但它依然不是线程安全的</b>：并发 put 到同一个桶会<b>丢数据</b>'
                    + '（两个线程都读到桶为空，各自写入，后写的覆盖先写的）；'
                    + '<code>size</code> 也会算错；并发扩容还可能丢整条链。<br>'
                    + '要并发就用 <code>ConcurrentHashMap</code>（JDK 8 是 CAS + synchronized 锁单个桶头节点），'
                    + '别用 <code>Collections.synchronizedMap</code>（全表一把锁，性能差很多）。',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['重写 equals 必须重写 hashCode',
             '两个 equals 相等的对象如果 hashCode 不同，会被算到<b>不同的桶</b>里 —— '
             + '于是 <code>map.put(a, 1); map.get(b)</code>（a.equals(b)）返回 null，'
             + '而且 map 里会同时存在两个「相等」的 key。'
             + '这是 Java 里最经典的坑，IDE 都会警告，但用 Lombok 时'
             + '<b>忘了加 <code>@EqualsAndHashCode</code> 照样中招</b>。'],
            ['key 放进去以后不能再改',
             '如果 key 是可变对象，put 之后修改了参与 hashCode 计算的字段，'
             + '它的 hashCode 就变了 —— <b>但它还躺在按旧 hash 算出来的那个桶里</b>。'
             + '结果是 <code>map.get(那个 key)</code> 找不到它，'
             + '<code>containsKey</code> 返回 false，但遍历时它明明在。'
             + '<b>key 应该用不可变对象。</b>'],
            ['指定初始容量时别忘了负载因子',
             '要装 100 个元素，写 <code>new HashMap&lt;&gt;(100)</code> 是不够的：'
             + '实际容量会是 128，而阈值是 128×0.75 = 96 —— '
             + '<b>装到第 97 个就扩容了</b>。'
             + '正确的算法是 <code>(int)(预期个数 / 0.75f) + 1</code>，'
             + '也就是 134 → 实际容量 256。Guava 的 '
             + '<code>Maps.newHashMapWithExpectedSize()</code> 就是干这个的。'],
            ['树化用的红黑树需要 key 可比较，否则退化',
             '转成红黑树后要靠比较来定位。如果 key 没实现 <code>Comparable</code>，'
             + 'JDK 会退而求其次用 <code>System.identityHashCode</code> 做「仲裁比较」—— '
             + '<b>这只保证有序，不保证查找有意义</b>，实际还是要遍历。'
             + '所以「树化了就一定是 O(log n)」这句话有前提。'],
            ['遍历顺序完全不做保证，别依赖它',
             'HashMap 的遍历顺序取决于 hash 分布和容量，<b>扩容后顺序会变</b>，'
             + '换个 JDK 版本也可能变。'
             + '写测试时 <code>assertEquals(map.toString(), "...")</code> 这种断言'
             + '<b>今天过明天挂</b>。需要顺序就用 <code>LinkedHashMap</code>（插入序/访问序）'
             + '或 <code>TreeMap</code>（key 的自然序）。'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '哪些是<b>真的</b>：<code>String.hashCode()</code>（h = 31h + c，int32 溢出截断）、'
                + '<code>Integer.hashCode()</code>（就是值本身）、'
                + '扰动函数 <code>h ^ (h&gt;&gt;&gt;16)</code>、'
                + '<code>index = hash &amp; (n-1)</code>、'
                + '扩容的 <code>(hash &amp; oldCap)</code> 拆分规则、'
                + '树化的三个常量（8 / 6 / 64）、泊松分布那张表 —— 都和 JDK 8 源码一致，'
                + 'JS 的 <code>&gt;&gt;&gt;</code>、<code>^</code>、<code>|0</code> 和 Java 的 int 语义能一比一对上。<br>'
                + '哪些<b>简化了</b>：<br>'
                + '① 不处理 key 重复覆盖（每次 put 都当成新 key 追加），也没有 remove。<br>'
                + '② 红黑树只画成一个标记，<b>没有实现真正的树结构和树内查找</b>；'
                + '也没有实现「树太小时退化回链表」的 untreeify 过程（只讲了阈值 6）。<br>'
                + '③ 扩容时把树的标记直接清掉了，真实 JDK 会在拆分时判断 lo/hi 链的长度'
                + '再决定是保持树、退化成链、还是重新树化。<br>'
                + '④ 「桶数组」那一节为了让开/关扰动能严格对照，<b>锁死了容量、关掉了自动扩容和树化</b>；'
                + '「树化」那一节才是按 JDK8 规则跑的。<br>'
                + '⑤ 没有模拟并发 —— 那个「JDK7 头插成环」只讲了原理，没做出来。',
        }),
        h('p', {
            html: '所有 key 都是写死的，没有用随机数。'
                + '「低位全相同」那组用的是 65536 的倍数（Integer 的 hashCode 就是它自己），'
                + '这不是编出来的巧合，是可以在真实 Java 里复现的。',
        }),
        h('p', {
            html: '<b>一个小发现</b>：上面那张泊松分布表是现算的（<code>e⁻ᐩ·λᵏ/k!</code>），'
                + '9 项里有 8 项和 JDK 8 源码注释里贴的那张表<b>逐位相同</b>，'
                + '只有 <code>k=4</code> 对不上 —— 注释写的是 <code>0.00157952</code>，'
                + '而精确值是 <code>0.001579506926…</code>，八位四舍五入应该是 '
                + '<code>0.00157951</code>。<b>是 JDK 那张表的末位舍入有点小误差</b>，'
                + '不影响任何结论，但如果你拿着源码注释来对，会发现这里差一个数字。',
        })
    ));
}

function spreadCard(withS, noS, keys) {
    const qW = HM.quality(withS.map), qN = HM.quality(noS.map);
    const bitBox = h('div.hm-bitbox');
    keys.slice(0, 5).forEach((k) => {
        const sp = HM.spread(k.hash);
        const idxNo = HM.indexFor(k.hash, state.cap);
        const idxYes = HM.indexFor(sp, state.cap);
        const lowN = Math.log2(state.cap);
        bitBox.appendChild(h('div.hm-bitgroup', null,
            h('div.hm-bitkey', {
                html: '<b>key = ' + Viz.esc(k.name) + '</b>　hashCode = ' + k.hash,
            }),
            bitRow('h', k.hash, { lowBits: lowN, markHigh: true, note: '原始 hashCode' }),
            bitRow('h >>> 16', k.hash >>> 16, { lowBits: lowN, note: '高 16 位挪下来' }),
            bitRow('h ^ (h>>>16)', HM.spread(k.hash), { lowBits: lowN, note: '扰动结果' }),
            h('div.hm-bitres', {
                html: '低 ' + lowN + ' 位（就是最终下标）：<b class="hm-bad">不扰动 → ' + idxNo
                    + '</b>　<b class="hm-good">扰动后 → ' + idxYes + '</b>',
            })
        ));
    });

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻 A：<code>&amp; (n-1)</code> 把高 28 位全扔了' }),
        h('p.sec-note', {
            html: 'n = 16 时 <code>n-1 = 15 = 0b1111</code>，'
                + '<code>hash &amp; 15</code> <b>只保留最低 4 位</b>，另外 28 位一点用没有。<br>'
                + '所以只要一批 key 的 hashCode 低位相同（哪怕高位差得离谱），它们就会全挤在一个桶里。'
                + '下面用的这组 key 是 65536 的倍数 —— <b>低 16 位全是 0，只有高位不同</b>。'
                + '<span class="hm-lg-high"></span>灰底 = 被丢掉的高 16 位，'
                + '<span class="hm-lg-low"></span>粉底 = 真正决定下标的那几位。',
        }),
        bitBox,
        h('div.hm-two', null,
            drawDist(noS, '关闭扰动', 'hm-bar-bad'),
            drawDist(withS, '开启扰动', 'hm-bar-good')
        ),
        Viz.cmpGrid([
            { h: '关扰动 · 最长链', v: String(qN.maxChain), d: '用到 ' + qN.usedBuckets + ' 个桶', cls: 'cmp-bad' },
            { h: '开扰动 · 最长链', v: String(qW.maxChain), d: '用到 ' + qW.usedBuckets + ' 个桶', cls: 'cmp-ok' },
            {
                h: '查找退化成', v: qN.maxChain > 1 ? 'O(' + qN.maxChain + ')' : 'O(1)',
                d: '关扰动时最坏要比 ' + qN.maxChain + ' 次', cls: 'cmp-save',
            },
        ]),
        h('div.seq-note', {
            html: qN.maxChain > qW.maxChain
                ? '<b>关掉扰动，' + keys.length + ' 个 key 全挤进了 ' + qN.usedBuckets
                  + ' 个桶（最长链 ' + qN.maxChain + '）；开启扰动后散到了 '
                  + qW.usedBuckets + ' 个桶（最长链 ' + qW.maxChain + '）。</b><br>'
                  + '注意扰动<b>并没有让 hash 变得「更随机」</b> —— 它只是把高位的信息'
                  + '「搬」到了低位，让本来会被丢弃的那 16 位也能参与决策。'
                  + '一次移位一次异或，成本几乎为零。<br>'
                  + '把上面的 key 组换成「普通字符串 key」，会发现开不开扰动几乎没区别 —— '
                  + '<b>扰动是给最坏情况买的保险，正常情况下它什么也不干。</b>'
                : '当前这组 key 开不开扰动区别不大 —— 说明它们的 hashCode 低位本来就足够分散。'
                  + '<b>把 key 组换成「低位全相同的 key」，才能看到扰动救场。</b>',
        })
    );
}

function resizeCard() {
    const keys = HM.PRESETS.resize.keys;
    const built = HM.build(keys, { cap: 16, spread: true, jdk8: false });
    // 这组 key 全都落在桶 5
    const j = HM.indexFor(HM.spread(keys[0].hash), 16);
    const sp = HM.splitBucket(built.map, j);

    const rows = h('div.hm-split');
    built.map.buckets[j].forEach((n) => {
        const bit = (n.hs & 16) !== 0;
        rows.appendChild(h('div.hm-split-row' + (bit ? '.hi' : '.lo'), null,
            h('span.hm-sk', { text: 'key ' + n.key.name }),
            h('code.hm-sb', { text: 'hash & 16 = ' + (n.hs & 16) }),
            h('span.hm-sarrow', { text: bit ? '→ 搬到桶 ' + sp.hiIndex : '→ 留在桶 ' + j }),
            h('code.hm-sb2', { text: 'hash & 31 = ' + HM.indexFor(n.hs, 32) })
        ));
    });

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻 B：扩容不用重算 hash，一个 bit 就够了' }),
        h('p.sec-note', {
            html: '很多人以为扩容要「把每个 key 重新 hash 一遍再取模」。'
                + '<b>不用。</b>容量 16 → 32，掩码从 <code>0b01111</code> 变成 <code>0b11111</code>，'
                + '<b>只多用了第 5 个 bit（值恰好 = oldCap = 16）</b>。<br>'
                + '所以原来在桶 j 的元素，新下标只有两种可能：还是 j，或者 j + 16。'
                + '判断依据就一句 <code>(hash &amp; oldCap) == 0</code>。',
        }),
        h('div.hm-maskrow', null,
            bitRow('n=16 掩码', 15, { lowBits: 5, note: 'n-1 = 0b01111' }),
            bitRow('n=32 掩码', 31, { lowBits: 5, note: 'n-1 = 0b11111　← 只多了一位' })
        ),
        h('p.sec-note', {
            html: '这组 key 全都 ≡ 5 (mod 16)，所以在容量 16 时挤在桶 ' + j + '。扩容到 32 时：',
        }),
        rows,
        Viz.cmpGrid([
            { h: 'lo 链（留原地）', v: sp.lo.length + ' 个', d: '留在桶 ' + j, cls: 'cmp-ok' },
            { h: 'hi 链（整体搬走）', v: sp.hi.length + ' 个', d: '搬到桶 ' + sp.hiIndex, cls: 'cmp-save' },
            { h: '重算 hash 次数', v: '0 次', d: '只做了一次位与', cls: 'cmp-ok' },
        ]),
        h('code.hm-code', {
            text: 'do {\n'
                + '    next = e.next;\n'
                + '    if ((e.hash & oldCap) == 0) {          // 留在原位\n'
                + '        if (loTail == null) loHead = e; else loTail.next = e;\n'
                + '        loTail = e;\n'
                + '    } else {                                // 搬到 j + oldCap\n'
                + '        if (hiTail == null) hiHead = e; else hiTail.next = e;\n'
                + '        hiTail = e;\n'
                + '    }\n'
                + '} while ((e = next) != null);\n'
                + 'newTab[j] = loHead;\n'
                + 'newTab[j + oldCap] = hiHead;',
        }),
        h('div.seq-note', {
            html: '<b>注意这段代码里的 loTail / hiTail —— 这是尾插。</b>'
                + '拆完之后 <b>lo 链和 hi 链内部的相对顺序，和原来完全一致</b>。<br>'
                + '而 JDK 7 用的是<b>头插</b>：迁移时链表会被<b>整个倒过来</b>。'
                + '单线程下这只是顺序变了没关系，<b>但两个线程同时扩容时，'
                + '一个线程刚把 A→B 倒成 B→A，另一个线程还按 A→B 的旧视角接指针，'
                + '就会接出 A→B→A 这样的环</b>。'
                + '之后任何 <code>get</code> 落到这个桶就是<b>无限循环，CPU 直接打满 100%</b>，'
                + '而且线上表现是「进程没死、就是不响应」，极难排查。<br>'
                + 'JDK 8 改成尾插<b>消除了成环</b>，但请记住：'
                + '<b>它没有让 HashMap 变成线程安全的</b>，并发 put 照样丢数据。',
        })
    );
}

function treeifyCard() {
    // 严格按 JDK8 规则跑：8 个落在同一个桶的 key
    const keys = HM.PRESETS.collide.keys;
    const small = HM.build(keys, { cap: 16, spread: false, jdk8: true });
    const big = HM.build(keys, { cap: 64, spread: false, jdk8: true });

    const log = h('div.hm-log');
    small.events.forEach((e, i) => {
        const row = h('div.hm-log-row' + (e.acts.length ? '.hit' : ''), null,
            h('span.hm-log-n', { text: '#' + (i + 1) }),
            h('span.hm-log-t', {
                html: 'put(<b>' + Viz.esc(e.key) + '</b>) → 桶 ' + e.idx
                    + '，该桶链表长度 ' + e.len,
            })
        );
        e.acts.forEach((a) => {
            row.appendChild(h('div.hm-log-act.hm-act-' + a.kind, { html: a.text }));
        });
        log.appendChild(row);
    });

    // 泊松分布表
    const wrap = h('div.mv-matrix-wrap');
    const tbl = h('table.mv-matrix');
    tbl.appendChild(h('tr', null,
        h('th', { text: '一个桶里有 k 个元素' }), h('th', { text: '概率（λ=0.5 的泊松分布）' }),
        h('th', { text: '大约多少分之一' })
    ));
    for (let k = 0; k <= 8; k++) {
        const p = HM.poisson(k, 0.5);
        tbl.appendChild(h('tr' + (k === 8 ? '.on' : ''), null,
            h('td.mv-strong', { text: 'k = ' + k }),
            h('td.dl-num', { text: p.toFixed(8) }),
            h('td', { text: p > 0 ? '约 ' + fmtOneIn(1 / p) : '—' })
        ));
    }
    wrap.appendChild(tbl);

    return h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻 C：链表到 8 <b>不一定</b>树化' }),
        h('p.sec-note', {
            html: '树化的条件是<b>两个</b>，而且必须同时满足：<br>'
                + '<b>① 链表长度 ≥ TREEIFY_THRESHOLD (8)</b>　'
                + '<b>② 桶数组长度 ≥ MIN_TREEIFY_CAPACITY (64)</b><br>'
                + '只满足 ① 时，<code>treeifyBin()</code> 里做的事是 —— <b>调用 resize() 扩容，'
                + '然后直接 return</b>，压根不建树。<br>'
                + '下面这段日志是把 8 个必然冲突的 key 依次 put 进一个初始容量 16 的表：',
        }),
        log,
        Viz.cmpGrid([
            {
                h: '初始容量 16', v: small.map.treeified ? '树化了' : '没树化',
                d: '扩容了 ' + small.map.resizes + ' 次，最终容量 ' + small.map.cap, cls: 'cmp-bad',
            },
            {
                h: '初始容量 64', v: big.map.treeified ? '树化了' : '没树化',
                d: '扩容 ' + big.map.resizes + ' 次，容量 ' + big.map.cap, cls: 'cmp-ok',
            },
            { h: '退化阈值', v: '6', d: '不是 7 —— 留了个缓冲带', cls: 'cmp-save' },
        ]),
        h('div.seq-note', {
            html: '<b>为什么表小的时候宁可扩容也不树化？</b>'
                + '因为表小的时候链表长，多半是「<b>桶不够用</b>」而不是「哈希质量差」——'
                + '扩容能把元素重新摊开，成本低、效果好；'
                + '而红黑树每个节点要多存父/左/右/颜色，内存开销大约是链表节点的 <b>2 倍</b>，'
                + '维护也贵。<b>能靠扩容解决就别上树。</b><br>'
                + '<b>退化阈值为什么是 6 不是 7？</b>因为 7 会导致在 7↔8 边界反复插入删除时'
                + '<b>树和链表来回横跳</b>，而这两种转换本身都不便宜。'
                + '空出 7 这一档当缓冲带，就不会抖了 —— <b>这是典型的迟滞（hysteresis）设计</b>，'
                + '和恒温器不在同一个温度点开关是一个道理。',
        }),
        h('h3.sec-title.hm-sub', { html: '<i class="fas fa-chart-simple"></i> 8 这个数是怎么来的：泊松分布' }),
        h('p.sec-note', {
            html: 'JDK 8 的 HashMap 源码注释里直接贴了这张表。'
                + '假设哈希函数质量良好、负载因子是默认的 0.75，'
                + '那么一个桶里的元素个数近似服从 <b>λ ≈ 0.5 的泊松分布</b>：',
        }),
        wrap,
        h('div.seq-note', {
            html: '<b>k=8 的概率是 0.00000006，也就是不到千万分之一。</b>'
                + '换句话说：<b>只要你的 hashCode 写得不算太差，这辈子都走不到树化那一步。</b><br>'
                + '所以红黑树<b>不是为了优化常规性能</b>，而是为了防御两种情况：'
                + '① 有人写了个烂的 <code>hashCode()</code>（比如直接 <code>return 1</code>）；'
                + '② <b>哈希碰撞攻击</b> —— 攻击者故意构造大量同桶的 key'
                + '（比如往一个用 HashMap 存 HTTP 参数的服务发几万个精心构造的参数名），'
                + '让每次查找退化成 O(n)，几个请求就能打满 CPU。'
                + '这类攻击在 2011 年被公开后，各语言的哈希表都做了加固 —— '
                + '<b>Java 选了红黑树（把最坏情况从 O(n) 压到 O(log n)），'
                + 'Python / Rust 则选了给哈希加随机种子</b>。',
        })
    );
}

function fmtOneIn(v) {
    if (v >= 1e7) return (v / 1e7).toFixed(1) + ' 千万分之一';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万分之一';
    if (v >= 100) return Math.round(v) + ' 分之一';
    return v.toFixed(1) + ' 分之一';
}

Viz.register({
    id: 'hashmap',
    cat: 'algo',
    title: 'HashMap',
    subtitle: '扰动 · 扩容 · 树化',
    icon: 'fa-table-cells',
    blurb: '一个 key 落到哪个桶，以及那句 h ^ (h>>>16) 到底在救什么',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.preset = 'collide';
        state.spread = true;
        state.cap = 16;
        state.focusKey = 0;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
