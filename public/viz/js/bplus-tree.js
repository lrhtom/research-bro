// ============================================================
//  演示：B+ 树索引
//  插入怎么触发节点分裂、树高怎么长、为什么数据库偏偏选它。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const BP = {};

BP.create = function (order) {
    return { order, root: { leaf: true, keys: [], children: [], next: null, id: 0 }, seq: 1 };
};

/** 插入一个 key，返回本次发生的分裂记录（空数组表示没分裂）*/
BP.insert = function (tree, key) {
    const max = tree.order - 1;
    const path = [];
    let node = tree.root;

    while (!node.leaf) {
        let i = 0;
        while (i < node.keys.length && key >= node.keys[i]) i++;
        path.push({ node, idx: i });
        node = node.children[i];
    }

    let i = 0;
    while (i < node.keys.length && node.keys[i] < key) i++;
    if (node.keys[i] === key) return null;              // 已存在
    node.keys.splice(i, 0, key);

    const splits = [];
    let cur = node;
    while (cur.keys.length > max) {
        let sep, right;
        if (cur.leaf) {
            // 叶子分裂：中间 key 被「复制」上去，叶子自己也留一份
            const mid = Math.ceil(cur.keys.length / 2);
            right = { leaf: true, keys: cur.keys.slice(mid), children: [], next: cur.next, id: tree.seq++ };
            cur.keys = cur.keys.slice(0, mid);
            cur.next = right;
            sep = right.keys[0];
        } else {
            // 内部节点分裂：中间 key 被「提升」上去，自己不保留
            const mid = Math.floor(cur.keys.length / 2);
            sep = cur.keys[mid];
            right = {
                leaf: false, keys: cur.keys.slice(mid + 1),
                children: cur.children.slice(mid + 1), next: null, id: tree.seq++,
            };
            cur.keys = cur.keys.slice(0, mid);
            cur.children = cur.children.slice(0, mid + 1);
        }
        splits.push({ sep, leaf: cur.leaf, key });

        const up = path.pop();
        if (!up) {
            tree.root = { leaf: false, keys: [sep], children: [cur, right], next: null, id: tree.seq++ };
            splits[splits.length - 1].newRoot = true;
            break;
        }
        up.node.keys.splice(up.idx, 0, sep);
        up.node.children.splice(up.idx + 1, 0, right);
        cur = up.node;
    }
    return splits;
};

BP.height = function (tree) {
    let hgt = 1, n = tree.root;
    while (!n.leaf) { n = n.children[0]; hgt++; }
    return hgt;
};

BP.levels = function (tree) {
    const out = [];
    let cur = [tree.root];
    while (cur.length) {
        out.push(cur);
        const next = [];
        cur.forEach((n) => { if (!n.leaf) next.push.apply(next, n.children); });
        cur = next;
    }
    return out;
};

/** 查找路径：从根到叶经过哪些节点 */
BP.searchPath = function (tree, key) {
    const path = [tree.root];
    let node = tree.root;
    while (!node.leaf) {
        let i = 0;
        while (i < node.keys.length && key >= node.keys[i]) i++;
        node = node.children[i];
        path.push(node);
    }
    return path;
};

/** 一个 16KB 页能放多少条目 → 三层能存多少行（面试经典估算）*/
BP.capacity = function (pageKB, keyBytes, ptrBytes, rowBytes) {
    const page = pageKB * 1024;
    const fanout = Math.floor(page / (keyBytes + ptrBytes));
    const rowsPerLeaf = Math.floor(page / rowBytes);
    return {
        fanout, rowsPerLeaf,
        h2: fanout * rowsPerLeaf,
        h3: fanout * fanout * rowsPerLeaf,
    };
};

if (typeof module !== 'undefined' && module.exports) module.exports = BP;
if (typeof window !== 'undefined') window.BPModel = BP;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const state = {
    order: 4, tree: null, inserted: [], lastSplits: null, lastKey: null,
    searchKey: null, rangeFrom: null, rangeTo: null,
    pageKB: 16, keyBytes: 8, ptrBytes: 6, rowBytes: 1024,
};

function reset(order, keys) {
    state.order = order;
    state.tree = BP.create(order);
    state.inserted = [];
    state.lastSplits = null;
    state.lastKey = null;
    (keys || []).forEach((k) => { BP.insert(state.tree, k); state.inserted.push(k); });
}

function add(key) {
    const sp = BP.insert(state.tree, key);
    if (sp === null) return false;
    state.inserted.push(key);
    state.lastSplits = sp;
    state.lastKey = key;
    return true;
}

// ---------- 画树 ----------

function buildTree() {
    const levels = BP.levels(state.tree);
    const NODE_H = 30, LEVEL_GAP = 62, KEY_W = 34, PAD = 10;
    const W = 820;

    // 先量各节点宽度
    const widthOf = (n) => Math.max(n.keys.length, 1) * KEY_W + 10;

    // 叶子层等距排布，上层取子节点中点
    const pos = new Map();
    const leaves = levels[levels.length - 1];
    const totalLeafW = leaves.reduce((a, n) => a + widthOf(n), 0) + (leaves.length - 1) * 16;
    let x = Math.max(PAD, (W - totalLeafW) / 2);
    leaves.forEach((n) => { pos.set(n, x + widthOf(n) / 2); x += widthOf(n) + 16; });
    for (let L = levels.length - 2; L >= 0; L--) {
        levels[L].forEach((n) => {
            const xs = n.children.map((c) => pos.get(c));
            pos.set(n, xs.reduce((a, b) => a + b, 0) / xs.length);
        });
    }

    const H = levels.length * LEVEL_GAP + 46;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bp-svg', preserveAspectRatio: 'xMidYMid meet' });

    const path = state.searchKey != null ? BP.searchPath(state.tree, state.searchKey) : [];
    const inRange = (k) => state.rangeFrom != null && k >= state.rangeFrom && k <= state.rangeTo;

    // 先画连线
    levels.forEach((row, L) => {
        if (L === levels.length - 1) return;
        const y = 24 + L * LEVEL_GAP + NODE_H;
        row.forEach((n) => {
            n.children.forEach((c) => {
                root.appendChild(svg('line', {
                    x1: pos.get(n), y1: y, x2: pos.get(c), y2: 24 + (L + 1) * LEVEL_GAP,
                    class: (path.indexOf(n) >= 0 && path.indexOf(c) >= 0) ? 'bp-edge-hit' : 'bp-edge',
                }));
            });
        });
    });

    // 叶子之间的链表指针（B+ 树范围查询的关键）
    let lf = leaves[0];
    const leafY = 24 + (levels.length - 1) * LEVEL_GAP + NODE_H / 2;
    while (lf && lf.next) {
        const x1 = pos.get(lf) + widthOf(lf) / 2, x2 = pos.get(lf.next) - widthOf(lf.next) / 2;
        root.appendChild(svg('line', { x1, y1: leafY, x2, y2: leafY, class: 'bp-leaflink', 'marker-end': 'url(#bpArrow)' }));
        lf = lf.next;
    }

    // 再画节点
    levels.forEach((row, L) => {
        const y = 24 + L * LEVEL_GAP;
        row.forEach((n) => {
            const w = widthOf(n), cx = pos.get(n);
            const hit = path.indexOf(n) >= 0;
            const isNew = state.lastSplits && state.lastSplits.length > 0 && L === 0 && state.lastSplits.some((s) => s.newRoot);
            root.appendChild(svg('rect', {
                x: cx - w / 2, y, width: w, height: NODE_H, rx: 5,
                class: 'bp-node' + (n.leaf ? ' bp-leaf' : '') + (hit ? ' bp-hit' : '') + (isNew ? ' bp-new' : ''),
            }));
            n.keys.forEach((k, i) => {
                const kx = cx - w / 2 + 5 + i * KEY_W + KEY_W / 2;
                if (i > 0) {
                    root.appendChild(svg('line', {
                        x1: cx - w / 2 + 5 + i * KEY_W, y1: y + 3, x2: cx - w / 2 + 5 + i * KEY_W, y2: y + NODE_H - 3,
                        class: 'bp-sep',
                    }));
                }
                root.appendChild(T({
                    x: kx, y: y + NODE_H / 2 + 4, 'text-anchor': 'middle',
                    class: 'bp-key' + (n.leaf && inRange(k) ? ' bp-key-range' : '')
                        + (k === state.lastKey ? ' bp-key-new' : ''),
                }, String(k)));
            });
        });
        root.appendChild(T({ x: 4, y: y + NODE_H / 2 + 4, class: 'bp-level' },
            L === 0 ? '根' : (L === levels.length - 1 ? '叶子' : '内部')));
    });

    const defs = svg('defs');
    const mk = svg('marker', { id: 'bpArrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
        markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    mk.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', fill: '#10b981' }));
    defs.appendChild(mk);
    root.insertBefore(defs, root.firstChild);

    return root;
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const hgt = BP.height(state.tree);
    const n = state.inserted.length;

    // 树
    const inputBox = h('input', {
        type: 'number', class: 'bp-input', placeholder: '输入一个数字', value: '',
    });
    const doAdd = () => {
        const v = Number(inputBox.value);
        if (inputBox.value === '' || Number.isNaN(v)) return;
        add(v); inputBox.value = ''; render();
        const inp = rootEl.querySelector('.bp-input'); if (inp) inp.focus();
    };
    inputBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

    const ctl = h('div.controls', null,
        Viz.slider({
            label: '阶数 m', min: 3, max: 6, step: 1, value: state.order,
            fmt: (v) => `m=${v}（每节点最多 ${v - 1} 个 key）`,
            onInput: (v) => { const ks = state.inserted.slice(); reset(v, ks); render(); },
        }),
        h('div.ctl-btns', null,
            inputBox,
            h('button.mini.primary', { onclick: doAdd }, '插入'),
            h('button.mini', {
                onclick: () => { let k; do { k = Math.floor(Math.random() * 99) + 1; } while (state.inserted.indexOf(k) >= 0); add(k); render(); },
            }, '随机插一个'),
            h('button.mini', { onclick: () => { reset(state.order, [10, 20, 30, 40, 50, 60, 70]); render(); } }, '重置'))
    );

    rootEl.appendChild(Viz.card('fa-sitemap', 'B+ 树长什么样，插入怎么让它分裂',
        `当前 <b>${n}</b> 个 key，树高 <b>${hgt}</b> 层。`
        + '一直插到某个节点装不下，它就会<b>分裂</b>，并把一个 key 顶到父节点；'
        + '顶到根还装不下时，根再分裂，<b>整棵树才长高一层</b>。所以 B+ 树永远是平衡的。',
        buildTree(), ctl,
        state.lastSplits && state.lastSplits.length
            ? h('div.seq-note', {
                html: `插入 <b>${state.lastKey}</b> 触发了 <b>${state.lastSplits.length}</b> 次分裂：`
                    + state.lastSplits.map((s) => (s.leaf ? '叶子分裂，把 ' + s.sep + ' <b>复制</b>到父节点'
                        : '内部节点分裂，把 ' + s.sep + ' <b>提升</b>到父节点')
                        + (s.newRoot ? '　→　<b>根分裂了，树高 +1</b>' : '')).join('；'),
            })
            : (state.lastKey != null ? h('div.seq-note', { html: `插入 <b>${state.lastKey}</b>，没有触发分裂。` }) : null)
    ));

    // 查找 / 范围查询
    const sInput = h('input', { type: 'number', class: 'bp-input', placeholder: '要查的值' });
    const rFrom = h('input', { type: 'number', class: 'bp-input', placeholder: '从' });
    const rTo = h('input', { type: 'number', class: 'bp-input', placeholder: '到' });

    rootEl.appendChild(Viz.card('fa-magnifying-glass', '查找与范围查询',
        '<b>等值查找</b>会高亮从根到叶的路径 —— 路径长度就是树高，也就是<b>磁盘 IO 次数</b>。<br>'
        + '<b>范围查询</b>只需定位到起点叶子，然后<b>顺着叶子链表往右扫</b>，不用回到根 —— '
        + '这正是 B+ 树把数据全放叶子、并把叶子串成链表的原因。',
        h('div.controls', null,
            h('div.ctl-btns', null, sInput,
                h('button.mini.primary', {
                    onclick: () => { state.searchKey = Number(sInput.value); state.rangeFrom = null; render(); },
                }, '查找路径')),
            h('div.ctl-btns', null, rFrom, rTo,
                h('button.mini.primary', {
                    onclick: () => {
                        state.rangeFrom = Number(rFrom.value); state.rangeTo = Number(rTo.value);
                        state.searchKey = null; render();
                    },
                }, '范围查询'),
                h('button.mini', { onclick: () => { state.searchKey = null; state.rangeFrom = null; render(); } }, '清除'))
        )
    ));

    // 为什么是 B+ 树
    rootEl.appendChild(buildWhy());

    // 容量估算
    rootEl.appendChild(buildCapacity());

    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        { q: 'B 树和 B+ 树的区别？',
            a: '① <b>B+ 树只有叶子存数据</b>，内部节点只存索引 key —— 于是同样大小的页能塞下更多 key，扇出更大、树更矮。'
                + '② <b>B+ 树叶子之间有链表</b>，范围查询和全表扫描只需顺序遍历叶子；B 树得中序遍历、来回跳。'
                + '③ B+ 树<b>查询性能稳定</b>，任何 key 都要走到叶子；B 树可能在内部节点就命中，快慢不均。' },
        { q: '为什么不用哈希索引？',
            a: '哈希是 O(1)，等值查询确实更快。但它<b>不支持范围查询、排序、最左前缀匹配</b>，'
                + '而这些在业务 SQL 里极其常见（<code>ORDER BY</code>、<code>BETWEEN</code>、<code>&gt;</code>）。'
                + '另外哈希冲突严重时会退化。Memory 引擎支持哈希索引，InnoDB 只有<b>自适应哈希</b>（内部自动优化，不可控）。' },
        { q: '聚簇索引和二级索引的区别？回表是什么？',
            a: '<b>聚簇索引</b>的叶子直接存整行数据（InnoDB 主键就是聚簇索引，所以一张表只能有一个）。'
                + '<b>二级索引</b>的叶子存的是<b>主键值</b>。'
                + '走二级索引查到主键后，还得再回聚簇索引查一次完整行，这个动作就叫 <b>回表</b>。'
                + '如果要查的列刚好都在二级索引里（<b>覆盖索引</b>），就不用回表，性能显著提升。' },
        { q: '最左前缀匹配是什么？',
            a: '联合索引 <code>(a,b,c)</code> 的 B+ 树是先按 a 排、a 相同再按 b 排、再按 c 排。'
                + '所以只有从最左边连续用起才走得了索引：<code>(a)</code>、<code>(a,b)</code>、<code>(a,b,c)</code> 可以，'
                + '<code>(b)</code>、<code>(b,c)</code> 不行。'
                + '而且<b>范围查询之后的列会失效</b> —— <code>a=1 AND b&gt;2 AND c=3</code> 里 c 用不上索引，因为 b 范围内 c 是无序的。' },
        { q: '为什么建议主键用自增整数？',
            a: '聚簇索引按主键顺序存放。自增主键让插入永远发生在<b>最右边</b>，只会顺序追加、页分裂少。'
                + '如果用 UUID 这类随机主键，插入位置随机分布，会频繁触发<b>页分裂和页内数据搬移</b>，'
                + '导致碎片多、写入慢。而且 UUID 更长，会让所有二级索引都跟着变大。' },
    ])));
}

function buildWhy() {
    const N = 20000000;
    const bstH = Math.ceil(Math.log2(N));
    return Viz.card('fa-scale-balanced', '为什么数据库都用 B+ 树，不用二叉树 / 红黑树',
        '一句话：<b>因为瓶颈是磁盘 IO 次数，而 IO 次数 ≈ 树高</b>。'
        + '内存里的数据结构比的是比较次数，磁盘上的比的是「读了几个页」，两者优化目标完全不同。',
        Viz.cmpGrid([
            { h: '红黑树 / AVL（二叉）', v: bstH + ' 层', d: `2000 万行 → 约 ${bstH} 次磁盘 IO`, cls: 'cmp-bad' },
            { h: 'B+ 树（扇出上千）', v: '3 层', d: '2000 万行 → 3 次磁盘 IO', cls: 'cmp-ok' },
            { h: '差距', v: Math.round(bstH / 3) + ' 倍', d: '每次随机 IO 约 10ms', cls: 'cmp-save' },
        ]),
        Viz.flowList([
            { t: '① 磁盘是按「页」读的，不是按字节',
                f: 'InnoDB 页大小 = 16KB\n读 1 个字节和读 16KB，磁盘开销几乎一样',
                r: '所以要在一次 IO 里尽可能多带信息 —— 让节点尽量「胖」' },
            { t: '② 二叉树太「瘦」，每个节点只有 2 个分支',
                f: '一个 16KB 的页里只放 1 个 key + 2 个指针，浪费掉 99.9% 的空间\n树高 = log₂(N)，2000 万行要 ' + bstH + ' 层',
                r: bstH + ' 次随机 IO ≈ ' + (bstH * 10) + 'ms，慢到不可接受' },
            { t: '③ B+ 树把节点撑满一整页，扇出上千',
                f: '16KB ÷ (8 字节 key + 6 字节指针) ≈ 1170 个分支\n树高 = log₁₁₇₀(N)',
                r: '2000 万行只要 3 层',
                hi: '而且<b>根节点和内部节点常驻内存</b>（Buffer Pool 里），'
                    + '实际只有最后一层叶子需要真的读磁盘 —— 通常 <b>1 次 IO</b> 就够了。' },
        ])
    );
}

function buildCapacity() {
    const c = BP.capacity(state.pageKB, state.keyBytes, state.ptrBytes, state.rowBytes);
    const fmt = (v) => v >= 1e8 ? (v / 1e8).toFixed(2) + ' 亿' : (v >= 1e4 ? (v / 1e4).toFixed(1) + ' 万' : String(v));
    return Viz.card('fa-calculator', '经典估算：三层 B+ 树能存多少行',
        '这是被问烂了的一题，但很多人只会背「2000 万」而不会算。自己拖一下就明白这个数是怎么来的。',
        h('div.controls', null,
            Viz.slider({ label: '页大小', min: 4, max: 64, step: 4, value: state.pageKB, fmt: (v) => v + ' KB',
                onInput: (v) => { state.pageKB = v; render(); } }),
            Viz.slider({ label: '主键大小', min: 4, max: 36, step: 2, value: state.keyBytes, fmt: (v) => v + ' 字节',
                onInput: (v) => { state.keyBytes = v; render(); } }),
            Viz.slider({ label: '单行大小', min: 128, max: 4096, step: 128, value: state.rowBytes, fmt: (v) => v + ' 字节',
                onInput: (v) => { state.rowBytes = v; render(); } })
        ),
        Viz.cmpGrid([
            { h: '一个内部节点的扇出', v: String(c.fanout), d: `${state.pageKB}KB ÷ (${state.keyBytes}+${state.ptrBytes}) 字节`, cls: 'cmp-save' },
            { h: '一个叶子页放几行', v: String(c.rowsPerLeaf), d: `${state.pageKB}KB ÷ ${state.rowBytes} 字节`, cls: 'cmp-save' },
            { h: '三层能存', v: fmt(c.h3) + ' 行', d: `${c.fanout} × ${c.fanout} × ${c.rowsPerLeaf}`, cls: 'cmp-ok' },
        ]),
        h('p.sec-note', {
            html: '默认参数（16KB 页、8 字节 bigint 主键、6 字节指针、1KB 行）算出来正好是<b>两千万量级</b>，'
                + '这就是那个常被引用的数字的由来。<b>把「单行大小」拖大会看到它迅速下降</b> —— '
                + '所以宽表、大字段会显著削弱索引效率。',
        })
    );
}

Viz.register({
    id: 'bplus-tree',
    cat: 'db',
    title: 'B+ 树索引',
    subtitle: '分裂 / 树高 / 回表 / 最左匹配',
    icon: 'fa-sitemap',
    blurb: '插入怎么触发分裂，以及为什么数据库不用红黑树',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.searchKey = null; state.rangeFrom = null;
        reset(4, [10, 20, 30, 40, 50, 60, 70]);
        render();
    },
    unmount() { rootEl = null; },
});

})();
