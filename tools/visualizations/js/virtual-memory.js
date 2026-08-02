// ============================================================
//  演示：虚拟内存 —— 地址翻译 + 缺页 + 页面置换
//  一个虚拟地址被劈成「页号 + 页内偏移」，先查 TLB、再查页表，
//  页表说「不在内存」就缺页中断、从磁盘换入、内存满了还要挑一个页赶出去。
//  重点打脸：FIFO 加页帧反而更慢（Belady 异常），以及缺页率对平均访存时间的碾压性影响。
//  上半 VM.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const VM = {};

// ===== 1. 地址拆分：这一步纯粹是位运算，没有任何查表 =====

/** 把一个虚拟地址劈成 VPN + 页内偏移。用除法/取模而不是 >>，避免 JS 位运算被截到 32 位有符号 */
VM.split = function (vaddr, pageBits, addrBits) {
    addrBits = addrBits || 32;
    const pageSize = Math.pow(2, pageBits);
    const a = Math.max(0, Math.floor(vaddr));
    return {
        vaddr: a,
        vpn: Math.floor(a / pageSize),
        offset: a % pageSize,
        pageBits: pageBits,
        vpnBits: addrBits - pageBits,
        addrBits: addrBits,
        pageSize: pageSize,
    };
};

/** 反过来：物理页号 + 偏移 → 物理地址。偏移原封不动，这是整套机制能成立的前提 */
VM.join = function (ppn, offset, pageBits) {
    return Math.max(0, Math.floor(ppn)) * Math.pow(2, pageBits) + Math.max(0, Math.floor(offset));
};

VM.hex = function (v, digits) {
    let s = Math.max(0, Math.floor(v)).toString(16).toUpperCase();
    while (digits && s.length < digits) s = '0' + s;
    return '0x' + s;
};

VM.bin = function (v, digits) {
    let s = Math.max(0, Math.floor(v)).toString(2);
    while (s.length < digits) s = '0' + s;
    return s.length > digits ? s.slice(s.length - digits) : s;
};

// ===== 2. 页面置换：这部分是本演示的算法核心，单测主要打它 =====

VM.POLICIES = ['FIFO', 'LRU', 'CLOCK', 'OPT'];

VM.POLICY_NAME = {
    FIFO: 'FIFO 先进先出',
    LRU: 'LRU 最近最少使用',
    CLOCK: 'CLOCK 时钟（二次机会）',
    OPT: 'OPT 最优（理论下界）',
};

/** 序列里出现过多少个不同的页 —— 这也是「冷启动强制缺页」的下界 */
VM.distinct = function (refs) {
    const seen = {};
    let n = 0;
    refs.forEach((p) => { if (!seen[p]) { seen[p] = 1; n++; } });
    return n;
};

/**
 * 挑一个倒霉蛋换出去。st 里存着当前所有页帧的元信息，CLOCK 会就地改 st.hand / st.rbit。
 * 返回被选中的页帧下标。
 */
function pickVictim(policy, st, t, refs, step) {
    const n = st.frames.length;

    if (policy === 'LRU') {
        // 上次被用到的时刻最早的那个
        let best = 0;
        for (let i = 1; i < n; i++) if (st.useT[i] < st.useT[best]) best = i;
        return best;
    }

    if (policy === 'CLOCK') {
        // 表针一格一格转：引用位是 1 就给它「第二次机会」（清 0 后放过），是 0 就当场处决。
        // 最多转两圈必然停下 —— 第一圈把所有 1 清成 0，第二圈一定撞到 0。
        for (let k = 0; k < 2 * n + 1; k++) {
            const i = st.hand;
            st.hand = (i + 1) % n;
            if (st.rbit[i] === 0) { step.scan.push({ slot: i, spared: false }); return i; }
            st.rbit[i] = 0;
            step.scan.push({ slot: i, spared: true });
        }
        return st.hand;
    }

    if (policy === 'OPT') {
        // 淘汰「将来最久之后才会再被用到」的那个；再也用不到的（Infinity）优先淘汰。
        // 需要预知未来，所以现实中不可实现，只能当标尺。
        let best = 0, bestNext = -1;
        for (let i = 0; i < n; i++) {
            let next = Infinity;
            for (let k = t + 1; k < refs.length; k++) {
                if (refs[k] === st.frames[i]) { next = k; break; }
            }
            if (next > bestNext) { bestNext = next; best = i; }   // 严格大于 → 平局取下标最小的
        }
        step.optNext = bestNext;
        return best;
    }

    // FIFO：装进来最早的那个，命中不会让它「变年轻」——这正是它出问题的根源
    let best = 0;
    for (let i = 1; i < n; i++) if (st.loadT[i] < st.loadT[best]) best = i;
    return best;
}

/**
 * 跑一遍访问序列。
 * refs     : 页号数组
 * nFrames  : 物理页帧数
 * policy   : FIFO / LRU / CLOCK / OPT
 * opt      : { refOnLoad, refOnHit } —— 只影响 CLOCK 的引用位。
 *            两个都设成 false 时所有引用位恒为 0，CLOCK 会精确退化成 FIFO。
 *
 * 返回 { steps, faults, hits, nFrames, policy }
 *   steps[i] = { t, page, hit, cold, slot, evicted, evictSlot, frames[], rbits[], handAfter, scan[] }
 */
VM.simulate = function (refs, nFrames, policy, opt) {
    refs = (refs || []).slice();
    opt = opt || {};
    const refOnLoad = opt.refOnLoad !== false;
    const refOnHit = opt.refOnHit !== false;
    const n = Math.max(1, Math.floor(nFrames) || 1);

    const st = {
        frames: new Array(n).fill(null),
        rbit: new Array(n).fill(0),
        loadT: new Array(n).fill(-1),
        useT: new Array(n).fill(-1),
        hand: 0,
    };

    const steps = [];
    let faults = 0, hits = 0;

    for (let t = 0; t < refs.length; t++) {
        const p = refs[t];
        const idx = st.frames.indexOf(p);
        const step = {
            t: t, page: p, hit: idx >= 0, cold: false, slot: -1,
            evicted: null, evictSlot: -1, scan: [], handBefore: st.hand,
        };

        if (idx >= 0) {
            hits++;
            st.useT[idx] = t;
            if (refOnHit) st.rbit[idx] = 1;
            step.slot = idx;
        } else {
            faults++;
            let slot = st.frames.indexOf(null);
            if (slot >= 0) {
                step.cold = true;              // 冷启动缺页：还有空帧，谁也不用被赶走
            } else {
                slot = pickVictim(policy, st, t, refs, step);
                step.evicted = st.frames[slot];
                step.evictSlot = slot;
            }
            st.frames[slot] = p;
            st.loadT[slot] = t;
            st.useT[slot] = t;
            st.rbit[slot] = refOnLoad ? 1 : 0;
            step.slot = slot;
        }

        step.frames = st.frames.slice();
        step.rbits = st.rbit.slice();
        step.handAfter = st.hand;
        steps.push(step);
    }

    return { steps: steps, faults: faults, hits: hits, nFrames: n, policy: policy, refs: refs };
};

/** 只要个数的时候用这个，省得每次都建一堆快照 */
VM.faults = function (refs, nFrames, policy, opt) {
    return VM.simulate(refs, nFrames, policy, opt).faults;
};

/**
 * 帧数从 1 加到 maxFrames，缺页次数怎么变。
 * anomaly = true 表示「多给了一个页帧，缺页反而变多了」—— 也就是 Belady 异常。
 */
VM.frameCurve = function (refs, maxFrames, policy) {
    const out = [];
    for (let f = 1; f <= maxFrames; f++) {
        const v = VM.faults(refs, f, policy);
        out.push({ frames: f, faults: v, anomaly: out.length > 0 && v > out[out.length - 1].faults });
    }
    return out;
};

/** 这条序列在这个算法下有没有 Belady 异常，有的话发生在哪几个位置 */
VM.beladyPoints = function (refs, maxFrames, policy) {
    return VM.frameCurve(refs, maxFrames, policy).filter((p) => p.anomaly);
};

// ===== 3. 平均访存时间（EAT）=====

/**
 * h  : TLB 命中率（0~1）
 * p  : 缺页率（0~1，对全部访存计），缺页只可能发生在 TLB 未命中的那一支上
 * 三条路径：
 *   TLB 命中          → tTlb + tMem
 *   TLB 未命中、页有效 → tTlb + 2·tMem   （多读一次内存拿页表项）
 *   缺页              → tTlb + 2·tMem + tFault
 * 展开合并之后就是下面这个干净的式子：
 *   EAT = tTlb + tMem + (1-h)·tMem + p·tFault
 */
VM.eat = function (o) {
    const tTlb = o.tTlb, tMem = o.tMem, tFault = o.tFault;   // 单位统一用 ns
    const h = Math.min(1, Math.max(0, o.hitRate));
    const p = Math.min(Math.max(0, 1 - h), Math.max(0, o.faultRate));
    const base = tTlb + tMem;
    const tlbMissExtra = (1 - h) * tMem;
    const faultExtra = p * tFault;
    const eat = base + tlbMissExtra + faultExtra;
    return {
        eat: eat, base: base, tlbMissExtra: tlbMissExtra, faultExtra: faultExtra,
        hitRate: h, faultRate: p,
        faultShare: eat > 0 ? faultExtra / eat : 0,
        slowdown: base > 0 ? eat / base : 1,
    };
};

// ===== 4. 页表有多大 =====

/** 二级页表里，每张下级表刚好占满一页时能索引多少项 → 每级用掉几位 */
VM.bitsPerLevel = function (pageBits, pteBytes) {
    return Math.round(Math.log2(Math.pow(2, pageBits) / pteBytes));
};

/** 让最顶层那张表也能塞进一页，至少要分几级 */
VM.minLevels = function (addrBits, pageBits, pteBytes) {
    const b = VM.bitsPerLevel(pageBits, pteBytes);
    return Math.max(1, Math.ceil((addrBits - pageBits) / b));
};

/**
 * 一级页表 vs 二级页表的实际字节数。
 * usedLeafTables = 这个进程真正用到的二级表张数（大部分地址空间没用到，那些二级表根本不用建）
 */
VM.ptCost = function (o) {
    const addrBits = o.addrBits, pageBits = o.pageBits, pteBytes = o.pteBytes;
    const vpnBits = addrBits - pageBits;
    const flatEntries = Math.pow(2, vpnBits);
    const flatBytes = flatEntries * pteBytes;

    const l2Bits = VM.bitsPerLevel(pageBits, pteBytes);
    const l1Bits = vpnBits - l2Bits;
    const dirBytes = Math.pow(2, Math.max(0, l1Bits)) * pteBytes;
    const leafBytes = Math.pow(2, l2Bits) * pteBytes;
    const coverPerLeaf = Math.pow(2, l2Bits + pageBits);
    const used = Math.max(0, Math.floor(o.usedLeafTables || 0));
    const twoBytes = dirBytes + used * leafBytes;

    return {
        vpnBits: vpnBits, flatEntries: flatEntries, flatBytes: flatBytes,
        l1Bits: l1Bits, l2Bits: l2Bits, dirBytes: dirBytes, leafBytes: leafBytes,
        coverPerLeaf: coverPerLeaf, usedLeafTables: used, twoBytes: twoBytes,
        ratio: twoBytes > 0 ? flatBytes / twoBytes : Infinity,
        minLevels: VM.minLevels(addrBits, pageBits, pteBytes),
    };
};

// ===== 5. 一台迷你机器：TLB + 页表 + 物理内存，跑一串真实地址 =====

VM.newMachine = function (o) {
    o = o || {};
    const nFrames = o.nFrames || 3;
    const m = {
        pageBits: o.pageBits || 12,
        addrBits: o.addrBits || 32,
        pteBytes: o.pteBytes || 4,
        tlbSize: o.tlbSize || 4,
        nFrames: nFrames,
        tlb: [],                               // [{ vpn, ppn, t }]，满了按 LRU 换
        pt: {},                                // vpn → { valid, ppn, ref }
        frames: new Array(nFrames).fill(null), // ppn → vpn
        loadT: new Array(nFrames).fill(-1),
        clock: 0,
        stats: { access: 0, tlbHit: 0, tlbMiss: 0, fault: 0, evict: 0 },
    };
    // 预先把几个页「已经在内存里」的状态摆好，这样第一步就能演示「TLB 未命中但页表有效」
    (o.preload || []).forEach((vpn, i) => {
        if (i >= nFrames) return;
        m.frames[i] = vpn;
        m.loadT[i] = i - 1000;                 // 比任何真实访问都早，FIFO 会先淘汰它们
        m.pt[vpn] = { valid: true, ppn: i, ref: 0 };
    });
    return m;
};

function tlbInsert(m, vpn, ppn, now) {
    let evicted = null;
    if (m.tlb.length >= m.tlbSize) {
        let worst = 0;
        for (let i = 1; i < m.tlb.length; i++) if (m.tlb[i].t < m.tlb[worst].t) worst = i;
        evicted = m.tlb[worst].vpn;
        m.tlb.splice(worst, 1);
    }
    m.tlb.push({ vpn: vpn, ppn: ppn, t: now });
    return evicted;
}

/**
 * 走一次完整的地址翻译，过程记进 steps（结构化的，不含任何文案，由界面层去渲染）。
 * 会改动 m（TLB / 页表 / 物理帧），这就是真机器里发生的事。
 */
VM.access = function (m, vaddr) {
    const sp = VM.split(vaddr, m.pageBits, m.addrBits);
    const vpn = sp.vpn, off = sp.offset;
    const steps = [];
    const now = ++m.clock;

    steps.push({ kind: 'split', vpn: vpn, off: off, vpnBits: sp.vpnBits, offBits: sp.pageBits });

    let ppn = -1, tlbHit = false, fault = false, evicted = null, tlbFilled = null;

    const te = m.tlb.filter((e) => e.vpn === vpn)[0];
    if (te) {
        tlbHit = true;
        ppn = te.ppn;
        te.t = now;
        steps.push({ kind: 'tlb', hit: true, vpn: vpn, ppn: ppn });
    } else {
        steps.push({ kind: 'tlb', hit: false, vpn: vpn });

        if (!m.pt[vpn]) m.pt[vpn] = { valid: false, ppn: -1, ref: 0 };
        const pte = m.pt[vpn];
        steps.push({ kind: 'pte', vpn: vpn, byteOff: vpn * m.pteBytes, valid: !!pte.valid, ppn: pte.ppn });

        if (pte.valid) {
            ppn = pte.ppn;
        } else {
            fault = true;
            steps.push({ kind: 'fault', vpn: vpn });

            let f = m.frames.indexOf(null);
            if (f < 0) {
                // 物理内存满了 —— 这里用 FIFO 挑受害者（第二个视图里可以换算法看效果）
                f = 0;
                for (let i = 1; i < m.nFrames; i++) if (m.loadT[i] < m.loadT[f]) f = i;
                const victim = m.frames[f];
                m.pt[victim].valid = false;
                m.pt[victim].ppn = -1;
                // 关键且最容易被忘：页表项失效了，TLB 里那份缓存也必须一起抹掉
                let flushed = false;
                for (let i = m.tlb.length - 1; i >= 0; i--) {
                    if (m.tlb[i].vpn === victim) { m.tlb.splice(i, 1); flushed = true; }
                }
                evicted = { vpn: victim, ppn: f, tlbFlushed: flushed };
                m.stats.evict++;
                steps.push({ kind: 'evict', vpn: victim, ppn: f, tlbFlushed: flushed });
            } else {
                steps.push({ kind: 'free', ppn: f });
            }

            m.frames[f] = vpn;
            m.loadT[f] = now;
            pte.valid = true;
            pte.ppn = f;
            ppn = f;
            steps.push({ kind: 'swapin', vpn: vpn, ppn: f });
        }

        tlbFilled = tlbInsert(m, vpn, ppn, now);
        steps.push({ kind: 'tlbfill', vpn: vpn, ppn: ppn, evicted: tlbFilled });
    }

    m.pt[vpn].ref = 1;
    const paddr = VM.join(ppn, off, m.pageBits);
    steps.push({ kind: 'phys', ppn: ppn, off: off, paddr: paddr });

    m.stats.access++;
    if (tlbHit) m.stats.tlbHit++; else m.stats.tlbMiss++;
    if (fault) m.stats.fault++;

    return {
        vaddr: sp.vaddr, vpn: vpn, off: off, ppn: ppn, paddr: paddr,
        tlbHit: tlbHit, fault: fault, evicted: evicted, steps: steps,
    };
};

VM.snapshot = function (m) {
    return {
        tlb: m.tlb.map((e) => ({ vpn: e.vpn, ppn: e.ppn, t: e.t })),
        frames: m.frames.slice(),
        pt: Object.keys(m.pt).map((k) => ({
            vpn: Number(k), valid: !!m.pt[k].valid, ppn: m.pt[k].ppn, ref: m.pt[k].ref,
        })).sort((a, b) => a.vpn - b.vpn),
        stats: Object.assign({}, m.stats),
    };
};

/** 按顺序跑一串地址，每一步都留一份状态快照，界面靠它做「上一步 / 下一步」 */
VM.runScript = function (opt, addrs) {
    const m = VM.newMachine(opt);
    const out = [];
    (addrs || []).forEach((a) => {
        const r = VM.access(m, a);
        r.snapshot = VM.snapshot(m);
        out.push(r);
    });
    return { machine: m, accesses: out };
};

/** 线性同余伪随机 —— 单测里要可复现，绝不用 Math.random */
VM.lcg = function (seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
    };
};

if (typeof module !== 'undefined' && module.exports) module.exports = VM;
if (typeof window !== 'undefined') window.VMModel = VM;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

// Belady 的教科书经典序列，写死在这里，Belady 卡片永远拿它算一遍
const BELADY_SEQ = [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5];

// 视图 A 的固定访问脚本。地址挑得很讲究：
// 前两个落在同一页（1KB / 4KB / 8KB 三种页大小下都同页），后面几个在三种页大小下页号都互不相同。
const SCRIPT = [0x00002004, 0x000023F0, 0x00006010, 0x0000A048, 0x0000E1BC, 0x00002004];

const PRESETS = {
    belady: { name: 'Belady 异常', refs: BELADY_SEQ.slice(), frames: 3, policy: 'FIFO' },
    classic: { name: '课本经典序列', refs: [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2, 1, 2, 0, 1, 7, 0, 1], frames: 3, policy: 'LRU' },
    cycle: { name: '循环扫描（LRU 最怕）', refs: [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4], frames: 3, policy: 'LRU' },
    local: { name: '局部性良好', refs: [1, 1, 2, 1, 2, 3, 2, 1, 3, 3, 2, 1], frames: 3, policy: 'LRU' },
};

const state = {
    // 视图 A
    pageBits: 12,
    addrBits: 32,
    addrs: SCRIPT.slice(),
    aStep: 4,
    // 视图 B
    refs: BELADY_SEQ.slice(),
    bFrames: 3,
    policy: 'FIFO',
    bStep: -1,
    // EAT 计算器
    tTlb: 1,
    tMem: 100,
    tFaultMs: 8,
    hitPct: 99,
    faultExp: -4,
    // 多级页表
    mlAddrBits: 32,
    mlUsed: 4,
};

const POLICY_COLOR = { FIFO: '#f97316', CLOCK: '#a855f7', LRU: '#4f46e5', OPT: '#10b981' };

function pageSize() { return Math.pow(2, state.pageBits); }

function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024) % 1 === 0 ? (b / 1024) + ' KB' : (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1048576) % 1 === 0 ? (b / 1048576) + ' MB' : (b / 1048576).toFixed(2) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
}

function fmtNs(v) {
    if (v < 1000) return v.toFixed(1) + ' ns';
    if (v < 1e6) return (v / 1000).toFixed(2) + ' µs';
    return (v / 1e6).toFixed(2) + ' ms';
}

// ---------- 视图 A：地址翻译流水线 ----------

function runScriptA() {
    // 让脚本里第 1 个和第 3 个地址所在的页「一开始就在内存里」，
    // 这样不管页大小怎么调，剧情都是：命中 → TLB 命中 → 命中 → 缺页 → 缺页+置换 → 缺页+置换
    const preload = [
        VM.split(state.addrs[0], state.pageBits, state.addrBits).vpn,
        VM.split(state.addrs[2] == null ? state.addrs[0] : state.addrs[2], state.pageBits, state.addrBits).vpn,
    ];
    const uniq = preload.filter((v, i) => preload.indexOf(v) === i);
    return VM.runScript({
        pageBits: state.pageBits, addrBits: state.addrBits,
        nFrames: 3, tlbSize: 4, pteBytes: 4, preload: uniq,
    }, state.addrs);
}

function buildBitSvg(r) {
    const AB = state.addrBits, PB = state.pageBits;
    const CW = 21, CH = 24, PAD = 16;
    const W = PAD * 2 + AB * CW;
    const H = 250;
    const splitAt = AB - PB;                 // 前 splitAt 个格子是页号
    const x = (i) => PAD + i * CW;
    const yV = 48, yP = 168;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'vm-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': '虚拟地址位拆分与物理地址拼接',
    });

    root.appendChild(Viz.text({ x: PAD, y: 16, class: 'vm-addr' },
        '虚拟地址 ' + VM.hex(r.vaddr, 8)));
    root.appendChild(Viz.text({ x: W - PAD, y: 16, class: 'vm-hint', 'text-anchor': 'end' },
        `${AB} 位地址空间 · 页大小 ${fmtSize(pageSize())} → 高 ${splitAt} 位页号 + 低 ${PB} 位偏移`));

    const drawRow = (y, bits, splitFill, offFill, hlSplit) => {
        for (let i = 0; i < AB; i++) {
            root.appendChild(svg('rect', {
                x: x(i), y: y, width: CW, height: CH,
                fill: i < splitAt ? splitFill : offFill,
                stroke: '#e3e7ee', 'stroke-width': 1,
            }));
            root.appendChild(Viz.text({
                x: x(i) + CW / 2, y: y + CH - 7, class: 'vm-bit', 'text-anchor': 'middle',
            }, bits[i]));
        }
        // 每 4 位一条稍重的分隔线，方便按 16 进制读
        for (let i = 4; i < AB; i += 4) {
            root.appendChild(svg('line', {
                x1: x(i), x2: x(i), y1: y, y2: y + CH, stroke: '#cbd2dc', 'stroke-width': 1,
            }));
        }
        if (hlSplit) {
            root.appendChild(svg('line', {
                x1: x(splitAt), x2: x(splitAt), y1: y - 10, y2: y + CH + 8,
                stroke: '#ec4899', 'stroke-width': 2.2,
            }));
        }
    };

    // 位序号（每 4 位标一次）
    for (let i = 0; i < AB; i += 4) {
        root.appendChild(Viz.text({ x: x(i) + 1, y: yV - 6, class: 'vm-bitidx' }, String(AB - 1 - i)));
    }

    drawRow(yV, VM.bin(r.vaddr, AB), '#eef2ff', '#fff7ed', true);

    // 两段的说明
    const midV = (x(0) + x(splitAt)) / 2, midO = (x(splitAt) + x(AB)) / 2;
    root.appendChild(svg('line', { x1: x(0) + 2, x2: x(splitAt) - 2, y1: yV + CH + 6, y2: yV + CH + 6, stroke: '#4f46e5', 'stroke-width': 1.4 }));
    root.appendChild(svg('line', { x1: x(splitAt) + 2, x2: x(AB) - 2, y1: yV + CH + 6, y2: yV + CH + 6, stroke: '#f59e0b', 'stroke-width': 1.4 }));
    root.appendChild(Viz.text({ x: midV, y: yV + CH + 22, class: 'vm-lab vm-lab-vpn', 'text-anchor': 'middle' },
        `VPN 虚拟页号（${splitAt} 位）= ${VM.hex(r.vpn)}，十进制 ${r.vpn}`));
    root.appendChild(Viz.text({ x: midO, y: yV + CH + 22, class: 'vm-lab vm-lab-off', 'text-anchor': 'middle' },
        `页内偏移（${PB} 位）= ${VM.hex(r.off)}`));

    // 中间：查表把 VPN 换成 PPN
    const boxW = 268, boxH = 30, boxX = midV - boxW / 2, boxY = yV + CH + 34;
    root.appendChild(svg('rect', {
        x: Math.max(PAD, boxX), y: boxY, width: boxW, height: boxH, rx: 8,
        fill: r.fault ? '#fef2f2' : '#f5f3ff', stroke: r.fault ? '#fca5a5' : '#c7d2fe',
    }));
    root.appendChild(Viz.text({ x: midV, y: boxY + 19, class: 'vm-map-t', 'text-anchor': 'middle' },
        (r.tlbHit ? 'TLB 命中' : (r.fault ? '缺页 → 换入后' : '查页表')) + `：VPN ${r.vpn} → PPN ${r.ppn}`));
    root.appendChild(svg('path', {
        d: `M${midV} ${boxY + boxH}L${midV} ${yP - 6}`,
        stroke: r.fault ? '#ef4444' : '#4f46e5', 'stroke-width': 1.6, 'stroke-dasharray': '4 3', fill: 'none',
    }));

    // 偏移那一段：原样抄下来
    root.appendChild(svg('path', {
        d: `M${x(splitAt) + 3} ${yV + CH + 30}L${x(splitAt) + 3} ${yP - 4}`,
        stroke: '#f59e0b', 'stroke-width': 1.3, 'stroke-dasharray': '3 3', fill: 'none',
    }));
    root.appendChild(svg('path', {
        d: `M${x(AB) - 3} ${yV + CH + 30}L${x(AB) - 3} ${yP - 4}`,
        stroke: '#f59e0b', 'stroke-width': 1.3, 'stroke-dasharray': '3 3', fill: 'none',
    }));
    root.appendChild(Viz.text({ x: midO, y: yP - 12, class: 'vm-hint vm-hint-warn', 'text-anchor': 'middle' },
        '这 ' + PB + ' 位一个 bit 都不改，直接抄下来'));

    drawRow(yP, VM.bin(r.paddr, AB), '#ecfdf5', '#fff7ed', true);

    root.appendChild(svg('line', { x1: x(0) + 2, x2: x(splitAt) - 2, y1: yP + CH + 6, y2: yP + CH + 6, stroke: '#10b981', 'stroke-width': 1.4 }));
    root.appendChild(Viz.text({ x: midV, y: yP + CH + 22, class: 'vm-lab vm-lab-ppn', 'text-anchor': 'middle' },
        `PPN 物理页号（${splitAt} 位）= ${VM.hex(r.ppn)}`));
    root.appendChild(Viz.text({ x: midO, y: yP + CH + 22, class: 'vm-lab vm-lab-off', 'text-anchor': 'middle' },
        '偏移不变'));
    root.appendChild(Viz.text({ x: PAD, y: H - 8, class: 'vm-addr vm-addr-p' },
        '物理地址 ' + VM.hex(r.paddr, 8)));

    return root;
}

function walkSteps(r) {
    const PB = state.pageBits, AB = state.addrBits;
    const mask = pageSize() - 1;
    const out = [];

    out.push({
        t: '硬件先把地址劈成两半 —— 这一步不查任何表，纯位运算',
        f: `VPN    = 0x${r.vaddr.toString(16).toUpperCase()} >> ${PB}      = ${VM.hex(r.vpn)}  (${r.vpn})\n`
            + `offset = 0x${r.vaddr.toString(16).toUpperCase()} & ${VM.hex(mask)}  = ${VM.hex(r.off)}  (${r.off})`,
        r: `${AB} 位地址、${fmtSize(pageSize())} 的页 → 高 ${AB - PB} 位是页号，低 ${PB} 位是页内偏移`,
        hi: '为什么偏移不用翻译？因为<b>虚拟页和物理页一样大</b>，页内第几个字节，换到哪个物理页里还是第几个字节。'
            + '所以整套地址翻译要做的事只有一件：把页号换掉。',
    });

    if (r.tlbHit) {
        out.push({
            t: '查 TLB —— 命中',
            f: `TLB 是页表的一小块硬件缓存（这里 4 项，全相联）\nTLB[VPN=${r.vpn}] → PPN=${r.ppn}`,
            r: '一次内存都没访问就拿到了 PPN，代价约 1 ns',
            hi: 'TLB 命中是<b>绝对主路径</b>。真实程序的 TLB 命中率通常 98%~99.9%，'
                + '因为一个 4KB 的页能装下上千条指令或一大片数组，局部性极好。',
        });
    } else {
        out.push({
            t: '查 TLB —— 未命中',
            f: `TLB 里没有 VPN=${r.vpn} 这一项`,
            r: '只能老老实实去内存里翻页表',
        });
        const pte = r.steps.filter((s) => s.kind === 'pte')[0] || {};
        out.push({
            t: '走页表：页表基址寄存器 + VPN × 页表项大小',
            f: `PTE 地址 = CR3 + ${r.vpn} × 4 B = CR3 + ${pte.byteOff} B\n读一次内存，把这个页表项取回来`,
            r: '注意这里<b>多花了一次完整的内存访问</b>（约 100 ns）',
        });

        if (!r.fault) {
            out.push({
                t: '检查有效位：valid = 1，页就在内存里',
                f: `PTE = { valid:1, PPN:${r.ppn}, ref:1, dirty:0 }`,
                r: `拿到 PPN = ${r.ppn}`,
            });
        } else {
            out.push({
                t: '检查有效位：valid = 0 → 缺页中断（Page Fault）',
                f: 'PTE = { valid:0, ... }\n→ 硬件产生异常，陷入内核，控制权交给缺页处理程序',
                r: '这一下从纳秒级掉到毫秒级，慢了五个数量级',
                hi: '<b>缺页不等于程序出错。</b>valid=0 只说明「这个页现在不在物理内存里」，'
                    + '至于它是被换到磁盘了、还是根本没分配、还是非法地址，要由内核查进程的虚拟内存区域表才知道。',
            });

            const ev = r.steps.filter((s) => s.kind === 'evict')[0];
            const fr = r.steps.filter((s) => s.kind === 'free')[0];
            if (fr) {
                out.push({
                    t: '内核找一个空闲物理页帧',
                    f: `还有空帧：PPN = ${fr.ppn}`,
                    r: '不用淘汰任何人，这叫<b>冷启动缺页</b>（强制缺页）',
                });
            } else if (ev) {
                out.push({
                    t: '物理内存已经满了 → 触发页面置换',
                    f: `按 FIFO 挑出装入最早的那页：VPN ${ev.vpn}（在 PPN ${ev.ppn}）\n`
                        + `页表项改成 valid=0；如果它是脏页，还要先写回磁盘\n`
                        + (ev.tlbFlushed ? `TLB 里 VPN ${ev.vpn} 那一项必须一起抹掉` : 'TLB 里没有它，不用额外处理'),
                    r: `淘汰 VPN ${ev.vpn}，腾出 PPN ${ev.ppn}`,
                    hi: '<b>最容易被忘的是最后一句。</b>页表项失效了，TLB 里那份缓存不抹掉，'
                        + '下次访问就会拿着一个已经属于别人的物理页号去读数据。多核机器上还得给其它核发中断，'
                        + '让它们也把自己的 TLB 项作废 —— 这就是所谓的 <b>TLB shootdown</b>，很贵。',
                });
            }
            out.push({
                t: '从磁盘把页读进来，更新页表项',
                f: `读磁盘 → 写入 PPN ${r.ppn}\nPTE[${r.vpn}] = { valid:1, PPN:${r.ppn}, ref:1 }`,
                r: '磁盘 I/O 期间进程被挂起，CPU 去跑别的进程',
            });
        }

        const tf = r.steps.filter((s) => s.kind === 'tlbfill')[0] || {};
        out.push({
            t: '把这条映射填进 TLB，然后重新执行刚才那条指令',
            f: `TLB ← (VPN ${r.vpn} → PPN ${r.ppn})`
                + (tf.evicted != null ? `\nTLB 满了，按 LRU 挤掉 VPN ${tf.evicted}` : ''),
            r: '下次再访问同一页就走 1 ns 的快路了',
        });
    }

    out.push({
        t: '拼出物理地址，真正去访存',
        f: `物理地址 = (PPN << ${PB}) | offset\n         = (${VM.hex(r.ppn)} << ${PB}) | ${VM.hex(r.off)}\n         = ${VM.hex(r.paddr, 8)}`,
        r: '拿到数据，这条指令才算走完',
    });

    return out;
}

function buildStatePanels(snap, r) {
    const box = h('div.vm-panels');

    // TLB
    const tlbTb = h('table.vm-tbl', null,
        h('tr', null, h('th', { text: 'VPN' }), h('th', { text: 'PPN' })));
    for (let i = 0; i < 4; i++) {
        const e = snap.tlb[i];
        const on = e && e.vpn === r.vpn && r.tlbHit;
        tlbTb.appendChild(h('tr' + (on ? '.vm-on' : ''), null,
            h('td', { text: e ? String(e.vpn) : '—' }),
            h('td', { text: e ? String(e.ppn) : '—' })));
    }
    box.appendChild(h('div.vm-panel', null,
        h('div.vm-panel-h', { html: '<i class="fas fa-bolt"></i> TLB（4 项）' }),
        tlbTb,
        h('div.vm-panel-n', { text: '页表的硬件缓存，命中就不用访内存' })));

    // 页表（只画被碰过的项）
    const ptTb = h('table.vm-tbl', null,
        h('tr', null, h('th', { text: 'VPN' }), h('th', { text: '有效' }),
            h('th', { text: 'PPN' }), h('th', { text: '访问位' })));
    snap.pt.forEach((e) => {
        ptTb.appendChild(h('tr' + (e.vpn === r.vpn ? '.vm-on' : '') + (e.valid ? '' : '.vm-invalid'), null,
            h('td', { text: String(e.vpn) }),
            h('td', { text: e.valid ? '1' : '0' }),
            h('td', { text: e.valid ? String(e.ppn) : '—' }),
            h('td', { text: String(e.ref) })));
    });
    box.appendChild(h('div.vm-panel', null,
        h('div.vm-panel-h', { html: '<i class="fas fa-table-list"></i> 页表（只画碰过的项）' }),
        ptTb,
        h('div.vm-panel-n', {
            text: `实际上有 2^${state.addrBits - state.pageBits} 项，一个进程一张，全在内存里`,
        })));

    // 物理页帧
    const frTb = h('table.vm-tbl', null,
        h('tr', null, h('th', { text: 'PPN' }), h('th', { text: '装的是谁' })));
    snap.frames.forEach((v, i) => {
        const cls = (i === r.ppn ? '.vm-on' : '') + (v == null ? '.vm-invalid' : '');
        frTb.appendChild(h('tr' + cls, null,
            h('td', { text: String(i) }),
            h('td', { text: v == null ? '空闲' : ('VPN ' + v) })));
    });
    box.appendChild(h('div.vm-panel', null,
        h('div.vm-panel-h', { html: '<i class="fas fa-server"></i> 物理内存（3 个页帧）' }),
        frTb,
        h('div.vm-panel-n', { text: '故意只给 3 个帧，好让置换很快发生' })));

    return box;
}

function buildViewA() {
    const run = runScriptA();
    if (state.aStep >= run.accesses.length) state.aStep = run.accesses.length - 1;
    if (state.aStep < 0) state.aStep = 0;
    const r = run.accesses[state.aStep];

    const addrInput = h('input', {
        type: 'text', class: 'bp-input vm-addr-input', value: VM.hex(r.vaddr, 8),
        onchange: (e) => {
            const v = parseInt(String(e.target.value).trim().replace(/^0x/i, ''), 16);
            if (!isNaN(v) && v >= 0) { state.addrs[state.aStep] = v % Math.pow(2, state.addrBits); render(); }
        },
    });

    const ctl = h('div.controls', null,
        h('label.ctl', null,
            h('span.ctl-name', { text: '页大小' }),
            Viz.segmented({
                value: state.pageBits,
                options: [{ v: 10, label: '1 KB' }, { v: 12, label: '4 KB' }, { v: 13, label: '8 KB' }],
                onPick: (v) => { state.pageBits = v; render(); },
            })),
        h('div.ctl-btns', null,
            h('span.ctl-name', { text: '这一步访问的地址' }), addrInput,
            h('button.mini', { onclick: () => { state.addrs = SCRIPT.slice(); render(); } }, '还原脚本'))
    );

    const nav = h('div.seq-nav', null,
        h('button.mini', { onclick: () => { state.aStep = Math.max(0, state.aStep - 1); render(); } }, '← 上一次访问'),
        h('span.seq-progress', { text: `${state.aStep + 1} / ${run.accesses.length}` }),
        h('button.mini.primary', {
            onclick: () => { state.aStep = Math.min(run.accesses.length - 1, state.aStep + 1); render(); },
        }, '下一次访问 →'),
        h('button.mini', { onclick: () => { state.aStep = 0; render(); } }, '回到第一步')
    );

    // 六次访问的小结（点一下跳过去）
    const tape = h('div.vm-tape');
    run.accesses.forEach((a, i) => {
        const kind = a.fault ? (a.evicted ? 'evict' : 'fault') : (a.tlbHit ? 'tlb' : 'pt');
        const label = { tlb: 'TLB 命中', pt: '页表命中', fault: '缺页·有空帧', evict: '缺页·要置换' }[kind];
        tape.appendChild(h('button.vm-tape-i.vm-k-' + kind + (i === state.aStep ? '.on' : ''), {
            onclick: () => { state.aStep = i; render(); },
        },
            h('b', { text: VM.hex(a.vaddr, 8) }),
            h('small', { text: label })));
    });

    const badge = r.fault
        ? h('div.vm-badge.vm-badge-bad', {
            html: `<i class="fas fa-bolt"></i> 第 ${state.aStep + 1} 次访问 <b>缺页</b>了`
                + (r.evicted ? `，物理内存已满，被换出去的是 <b>VPN ${r.evicted.vpn}</b>` : '，好在还有空闲页帧'),
        })
        : h('div.vm-badge.vm-badge-ok', {
            html: `<i class="fas fa-check"></i> 第 ${state.aStep + 1} 次访问顺利拿到物理地址，`
                + (r.tlbHit ? '而且是 <b>TLB 命中</b>，一次内存都没多访' : '走了页表（多访一次内存）'),
        });

    return Viz.card('fa-right-left', '视图一：一个虚拟地址是怎么变成物理地址的',
        '下面这条 6 次访问的脚本刻意安排了全部四种结局：'
        + '<b>TLB 命中</b> → <b>TLB 未命中但页表有效</b> → <b>缺页但有空帧</b> → <b>缺页且必须置换</b>。'
        + '点上面的方块或用下一步按钮走一遍。地址框可以直接改成任意十六进制地址。',
        ctl, tape, badge, buildBitSvg(r),
        buildStatePanels(r.snapshot, r),
        h('h4.vm-sub', { text: '这一次访问，硬件和内核依次做了这些事' }),
        Viz.flowList(walkSteps(r)),
        nav
    );
}

// ---------- 视图 B：访问序列 + 页帧状态表 ----------

function buildRefTable(sim) {
    const n = sim.nFrames, steps = sim.steps;
    const tb = h('table.mv-matrix.vm-grid');

    const pick = (i) => () => { state.bStep = (state.bStep === i ? -1 : i); render(); };

    const hr = h('tr', null, h('th.vm-rowh', { text: '访问序列' }));
    steps.forEach((s, i) => hr.appendChild(
        h('th' + (i === state.bStep ? '.vm-col-on' : ''), { text: String(s.page), onclick: pick(i) })));
    tb.appendChild(hr);

    for (let f = 0; f < n; f++) {
        const tr = h('tr', null, h('td.vm-rowh', { text: '页帧 ' + f }));
        steps.forEach((s, i) => {
            const v = s.frames[f];
            let cls = '';
            if (v == null) cls = '.vm-c-empty';
            else if (s.slot === f && !s.hit) cls = '.vm-c-new';
            else if (s.slot === f && s.hit) cls = '.vm-c-hit';
            if (i === state.bStep) cls += '.vm-col-on';
            if (state.policy === 'CLOCK' && s.handAfter === f) cls += '.vm-hand';
            const td = h('td' + cls, { onclick: pick(i) });
            td.appendChild(h('span.vm-page', { text: v == null ? '·' : String(v) }));
            if (state.policy === 'CLOCK' && v != null) {
                td.appendChild(h('sup.vm-rbit', { text: String(s.rbits[f]) }));
            }
            tr.appendChild(td);
        });
        tb.appendChild(tr);
    }

    const rr = h('tr', null, h('td.vm-rowh', { text: '结果' }));
    steps.forEach((s, i) => rr.appendChild(
        h('td' + (s.hit ? '.vm-res-hit' : '.vm-res-fault') + (i === state.bStep ? '.vm-col-on' : ''),
            { text: s.hit ? '中' : '缺', onclick: pick(i) })));
    tb.appendChild(rr);

    const er = h('tr', null, h('td.vm-rowh', { text: '换出' }));
    steps.forEach((s, i) => er.appendChild(
        h('td.vm-evict' + (i === state.bStep ? '.vm-col-on' : ''),
            { text: s.evicted == null ? '' : String(s.evicted), onclick: pick(i) })));
    tb.appendChild(er);

    return h('div.mv-matrix-wrap', null, tb);
}

function stepNote(sim) {
    if (state.bStep < 0 || state.bStep >= sim.steps.length) {
        return h('div.seq-note', {
            html: '点表格里任意一列，看那一次访问到底发生了什么。'
                + `当前：<b>${VM.POLICY_NAME[state.policy]}</b>，<b>${sim.nFrames}</b> 个页帧，`
                + `共 <b>${sim.faults}</b> 次缺页 / <b>${sim.steps.length}</b> 次访问。`,
        });
    }
    const s = sim.steps[state.bStep];
    let txt = `<b>第 ${s.t + 1} 次访问，页 ${s.page}：</b>`;
    if (s.hit) {
        txt += `它已经在页帧 ${s.slot} 里 → <b>命中</b>，不需要任何磁盘 I/O。`;
        if (state.policy === 'LRU') txt += '同时刷新它的「最近使用时刻」，LRU 靠这个排序。';
        if (state.policy === 'CLOCK') txt += '同时把它的<b>引用位置 1</b> —— 这就是它下次能捡回一条命的资本。';
        if (state.policy === 'FIFO') txt += '<b>注意 FIFO 不会因为命中而让它变年轻</b>，它照样按装入顺序排队等死。';
    } else if (s.cold) {
        txt += `不在内存里 → <b>缺页</b>。好在还有空页帧 ${s.slot}，直接装进去。`
            + '这种叫<b>冷启动缺页（强制缺页）</b>，任何算法都躲不掉，是缺页次数的理论下界。';
    } else {
        txt += `不在内存里 → <b>缺页</b>，而且物理内存已满，必须挑一个换出去。`;
        if (state.policy === 'FIFO') txt += `FIFO 选中<b>装入最早</b>的页 ${s.evicted}（页帧 ${s.evictSlot}）。`;
        if (state.policy === 'LRU') txt += `LRU 选中<b>最久没被用过</b>的页 ${s.evicted}（页帧 ${s.evictSlot}）。`;
        if (state.policy === 'CLOCK') {
            const spared = s.scan.filter((x) => x.spared);
            txt += `表针从页帧 ${s.handBefore} 出发，`
                + (spared.length
                    ? `先给页帧 ${spared.map((x) => x.slot).join('、')} 各清了一次引用位（放它们一马），然后`
                    : '第一格引用位就是 0，')
                + `在页帧 ${s.evictSlot} 处决了页 ${s.evicted}。`;
        }
        if (state.policy === 'OPT') {
            txt += `OPT 偷看未来，发现页 ${s.evicted} `
                + (s.optNext === Infinity ? '<b>以后再也不会被用到</b>' : `要等到第 ${s.optNext + 1} 次访问才再用到，是最晚的`)
                + '，所以换它。';
        }
    }
    return h('div.seq-note', { html: txt });
}

function buildViewB(sim) {
    const refInput = h('input', {
        type: 'text', class: 'bp-input vm-ref-input', value: state.refs.join(' '),
        onchange: (e) => {
            const arr = String(e.target.value).split(/[^0-9]+/).filter((x) => x !== '')
                .map(Number).filter((x) => isFinite(x) && x >= 0 && x <= 99).slice(0, 24);
            if (arr.length) { state.refs = arr; state.bStep = -1; render(); }
        },
    });

    const presets = h('div.ctl-btns');
    Object.keys(PRESETS).forEach((k) => {
        const p = PRESETS[k];
        const same = p.refs.join(',') === state.refs.join(',');
        presets.appendChild(h('button.mini' + (k === 'belady' ? '.primary' : '') + (same ? '.vm-preset-on' : ''), {
            onclick: () => {
                state.refs = p.refs.slice(); state.bFrames = p.frames;
                state.policy = p.policy; state.bStep = -1; render();
            },
        }, p.name));
    });

    const ctl = h('div.controls', null,
        Viz.slider({
            label: '物理页帧数', min: 1, max: 6, step: 1, value: state.bFrames,
            fmt: (v) => v + ' 个',
            onInput: (v) => { state.bFrames = v; render(); },
        }),
        h('div.ctl-btns', null, h('span.ctl-name', { text: '访问序列' }), refInput)
    );

    const hitRate = sim.steps.length ? (sim.hits / sim.steps.length * 100) : 0;

    return Viz.card('fa-table-cells', '视图二：同一串访问，四种置换算法各是什么下场',
        '每一列是一次页面访问，格子里是那个页帧当时装着谁。'
        + '<b>绿底</b>＝这次命中，<b>红底</b>＝这次刚换进来。'
        + '拖页帧数滑块、换算法，看缺页次数怎么变。',
        Viz.segmented({
            value: state.policy,
            options: VM.POLICIES.map((p) => ({ v: p, label: VM.POLICY_NAME[p] })),
            onPick: (v) => { state.policy = v; render(); },
        }),
        ctl, presets,
        buildRefTable(sim),
        Viz.cmpGrid([
            { h: '缺页次数', v: String(sim.faults), d: `共 ${sim.steps.length} 次访问`, cls: 'cmp-bad' },
            { h: '命中率', v: hitRate.toFixed(1) + '%', d: `命中 ${sim.hits} 次`, cls: 'cmp-ok' },
            { h: '强制缺页下界', v: String(VM.distinct(state.refs)), d: '序列里有几个不同的页，就至少缺几次', cls: 'cmp-save' },
        ]),
        stepNote(sim),
        state.policy === 'CLOCK'
            ? h('p.sec-note', {
                html: '<b>CLOCK 模式下格子右上角的小数字是引用位。</b>'
                    + '被访问过就置 1；表针扫到 1 时不杀它，只把 1 清成 0 —— 这就是「二次机会」。'
                    + '带 <span class="vm-hand-demo">紫色左框</span> 的格子是表针现在停的位置。',
            })
            : null
    );
}

// ---------- Belady 异常 ----------

function buildCurveSvg(refs, maxF) {
    const W = 700, H = 250, PAD_L = 44, PAD_R = 132, PAD_T = 20, PAD_B = 40;
    const series = ['OPT', 'LRU', 'CLOCK', 'FIFO'].map((p) => ({ p: p, pts: VM.frameCurve(refs, maxF, p) }));
    let maxV = 1;
    series.forEach((s) => s.pts.forEach((q) => { if (q.faults > maxV) maxV = q.faults; }));
    maxV = Math.ceil(maxV / 2) * 2;

    const x = (f) => PAD_L + (maxF > 1 ? (f - 1) / (maxF - 1) : 0.5) * (W - PAD_L - PAD_R);
    const y = (v) => H - PAD_B - (v / maxV) * (H - PAD_T - PAD_B);

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'vm-svg', preserveAspectRatio: 'xMidYMid meet',
        role: 'img', 'aria-label': '页帧数与缺页次数的关系曲线',
    });

    const stepY = Viz.niceStep(maxV, 5);
    for (let v = 0; v <= maxV; v += stepY) {
        root.appendChild(svg('line', { x1: PAD_L, x2: W - PAD_R, y1: y(v), y2: y(v), stroke: '#eef0f3', 'stroke-width': 1 }));
        root.appendChild(Viz.text({ x: PAD_L - 8, y: y(v) + 4, class: 'vm-axis', 'text-anchor': 'end' }, String(v)));
    }
    for (let f = 1; f <= maxF; f++) {
        root.appendChild(Viz.text({ x: x(f), y: H - PAD_B + 17, class: 'vm-axis', 'text-anchor': 'middle' }, String(f)));
    }
    root.appendChild(Viz.text({ x: (PAD_L + W - PAD_R) / 2, y: H - 8, class: 'vm-axis-t', 'text-anchor': 'middle' },
        '物理页帧数 →'));
    root.appendChild(Viz.text({ x: PAD_L - 8, y: PAD_T - 6, class: 'vm-axis-t', 'text-anchor': 'end' }, '缺页次数'));

    // 当前帧数的竖线
    if (state.bFrames <= maxF) {
        root.appendChild(svg('line', {
            x1: x(state.bFrames), x2: x(state.bFrames), y1: PAD_T - 4, y2: H - PAD_B,
            stroke: '#ec4899', 'stroke-width': 1.2, 'stroke-dasharray': '4 3',
        }));
    }

    series.forEach((s) => {
        const c = POLICY_COLOR[s.p];
        const d = s.pts.map((q, i) => (i ? 'L' : 'M') + x(q.frames) + ' ' + y(q.faults)).join('');
        root.appendChild(svg('path', { d: d, fill: 'none', stroke: c, 'stroke-width': 2, opacity: 0.9 }));
        s.pts.forEach((q, i) => {
            root.appendChild(svg('circle', { cx: x(q.frames), cy: y(q.faults), r: q.anomaly ? 5.5 : 3.4, fill: c }));
            if (q.anomaly) {
                // 打脸时刻：把「加了帧反而更缺页」的那一段用红色粗线重画一遍
                const prev = s.pts[i - 1];
                root.appendChild(svg('path', {
                    d: `M${x(prev.frames)} ${y(prev.faults)}L${x(q.frames)} ${y(q.faults)}`,
                    stroke: '#ef4444', 'stroke-width': 4, fill: 'none', opacity: 0.85,
                }));
                root.appendChild(svg('circle', {
                    cx: x(q.frames), cy: y(q.faults), r: 9, fill: 'none', stroke: '#ef4444', 'stroke-width': 2,
                }));
                root.appendChild(Viz.text({
                    x: x(q.frames) + 12, y: y(q.faults) - 10, class: 'vm-anom',
                }, `${s.p}：${prev.frames}→${q.frames} 帧，缺页 ${prev.faults}→${q.faults}`));
            }
        });
    });

    // 右侧图例：顺便标出当前帧数下各算法的成绩
    series.slice().reverse().forEach((s, i) => {
        const ly = PAD_T + 14 + i * 22;
        const cur = s.pts[Math.min(state.bFrames, maxF) - 1];
        root.appendChild(svg('rect', { x: W - PAD_R + 10, y: ly - 8, width: 11, height: 11, rx: 3, fill: POLICY_COLOR[s.p] }));
        root.appendChild(Viz.text({ x: W - PAD_R + 27, y: ly + 1, class: 'vm-lgd' },
            s.p + (cur ? '  ' + cur.faults + ' 次' : '')));
    });

    return root;
}

function buildBelady(sim) {
    const F = state.bFrames;
    const cur = VM.faults(state.refs, F, state.policy);
    const more = VM.faults(state.refs, F + 1, state.policy);
    const maxF = Math.min(8, Math.max(3, VM.distinct(state.refs) + 1));

    // 经典序列的数字永远算一遍，不管用户把序列改成了什么
    const f3 = VM.faults(BELADY_SEQ, 3, 'FIFO');
    const f4 = VM.faults(BELADY_SEQ, 4, 'FIFO');
    const l3 = VM.faults(BELADY_SEQ, 3, 'LRU');
    const l4 = VM.faults(BELADY_SEQ, 4, 'LRU');
    const o3 = VM.faults(BELADY_SEQ, 3, 'OPT');
    const o4 = VM.faults(BELADY_SEQ, 4, 'OPT');

    const anom = ['FIFO', 'CLOCK', 'LRU', 'OPT'].map((p) => ({
        p: p, pts: VM.beladyPoints(state.refs, maxF, p),
    })).filter((a) => a.pts.length);

    const tb = h('table.mv-matrix', null,
        h('tr', null, h('th', { text: '算法' }), h('th', { text: '3 个页帧' }),
            h('th', { text: '4 个页帧' }), h('th', { text: '加了一个页帧之后' })));
    [['FIFO', f3, f4], ['LRU', l3, l4], ['OPT', o3, o4]].forEach((r) => {
        const worse = r[2] > r[1];
        tb.appendChild(h('tr' + (worse ? '.vm-row-bad' : ''), null,
            h('td.mv-strong', { text: VM.POLICY_NAME[r[0]] }),
            h('td', { text: r[1] + ' 次缺页' }),
            h('td', { text: r[2] + ' 次缺页' }),
            h('td' + (worse ? '.bad' : '.ok'), {
                text: worse ? `反而多了 ${r[2] - r[1]} 次 ← 就是这里` : `少了 ${r[1] - r[2]} 次（正常）`,
            })));
    });

    return Viz.card('fa-face-frown-open', '打脸时刻：给 FIFO 多加一个页帧，它反而更慢了',
        '这就是 <b>Belady 异常（Belady\'s Anomaly）</b>。'
        + '点上面视图二里的「Belady 异常」按钮切到经典序列 <code>1 2 3 4 1 2 5 1 2 3 4 5</code>，'
        + '把页帧数滑块从 3 拖到 4，看缺页次数往哪边走。',
        Viz.cmpGrid([
            { h: `FIFO · 3 个页帧`, v: f3 + ' 次', d: '经典序列的缺页次数', cls: 'cmp-ok' },
            { h: `FIFO · 4 个页帧`, v: f4 + ' 次', d: '内存多了，缺页反而多了', cls: 'cmp-bad' },
            { h: '加内存的收益', v: `+${f4 - f3}`, d: '负收益：花钱买了更慢', cls: 'cmp-bad' },
        ]),
        h('div.mv-matrix-wrap', null, tb),
        h('div.seq-note', {
            html: '<b>为什么会这样？</b>FIFO 只看「谁进来得早」，完全不看「谁还有用」。'
                + '页帧变多之后，每个页在队列里待的时间变长，'
                + '于是<b>被淘汰的时间点整体后移</b>，恰好错开了后续访问 —— 淘汰顺序被打乱成了更差的组合。'
                + '<br><b>LRU 和 OPT 不会有这个问题</b>，因为它们满足<b>栈式性质（stack property）</b>：'
                + '用 n 个页帧时驻留的页集合，永远是用 n+1 个页帧时驻留集合的<b>子集</b>。'
                + '既然多给的页帧只会「多留住一些页、绝不赶走本来留得住的页」，缺页次数就只可能少、不可能多。'
                + '<br><b>CLOCK 也会出 Belady 异常</b> —— 它本质上是 FIFO 加了一个引用位，同样不是栈式算法。'
                + '在上面这条经典序列上，CLOCK 的 3 帧 / 4 帧结果是 '
                + `<b>${VM.faults(BELADY_SEQ, 3, 'CLOCK')} 次 / ${VM.faults(BELADY_SEQ, 4, 'CLOCK')} 次</b>，同样是加了内存更慢。`,
        }),
        h('h4.vm-sub', { text: '页帧数 → 缺页次数（当前这条访问序列，四种算法一起画）' }),
        buildCurveSvg(state.refs, maxF),
        h('p.sec-note', {
            html: anom.length
                ? `<b>当前序列上，红圈标出的就是异常点</b>：${anom.map((a) => a.p).join(' 和 ')} 出现了「加帧反而更缺页」。`
                    + '把序列改回默认的 Belady 经典序列，异常最明显。'
                : '当前这条序列没有触发 Belady 异常 —— <b>异常不是必然发生的</b>，'
                    + '它需要特定的访问模式才会被逼出来。点「Belady 异常」按钮换回经典序列试试。',
        }),
        h('p.sec-note', {
            html: `当前设置（${VM.POLICY_NAME[state.policy]}，${F} → ${F + 1} 帧）：`
                + `<b>${cur} 次 → ${more} 次</b>，`
                + (more > cur ? '<b class="vm-red">缺页变多了，这就是异常</b>。' : '缺页没有变多，符合直觉。'),
        })
    );
}

// ---------- TLB 命中率 / 缺页率的杠杆 ----------

function buildEatBar(e) {
    const W = 700, H = 108, PAD = 10;
    const inner = W - PAD * 2;
    const segs = [
        { v: e.base, cls: '#4f46e5', label: 'TLB + 一次内存访问（基础开销）' },
        { v: e.tlbMissExtra, cls: '#f59e0b', label: 'TLB 未命中：多读一次内存查页表' },
        { v: e.faultExtra, cls: '#ef4444', label: '缺页：磁盘 I/O' },
    ];
    const total = segs.reduce((a, s) => a + s.v, 0) || 1;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'vm-svg', preserveAspectRatio: 'xMidYMid meet',
        role: 'img', 'aria-label': '平均访存时间的构成',
    });

    let cx = PAD;
    segs.forEach((s) => {
        const w = Math.max(s.v > 0 ? 2 : 0, (s.v / total) * inner);
        if (w <= 0) return;
        root.appendChild(svg('rect', { x: cx, y: 14, width: w, height: 30, fill: s.cls, rx: 2 }));
        const pct = (s.v / total) * 100;
        if (w > 58) {
            root.appendChild(Viz.text({ x: cx + w / 2, y: 34, class: 'vm-barpct', 'text-anchor': 'middle' },
                pct.toFixed(1) + '%'));
        }
        cx += w;
    });

    // 图例一行一条，长标签在窄屏上也不会挤成一团
    segs.forEach((s, i) => {
        const ly = 62 + i * 16;
        root.appendChild(svg('rect', { x: PAD, y: ly - 8, width: 10, height: 10, rx: 2, fill: s.cls }));
        root.appendChild(Viz.text({ x: PAD + 15, y: ly + 1, class: 'vm-lgd' }, s.label + '：' + fmtNs(s.v)));
    });

    return root;
}

function buildEat() {
    const p = Math.pow(10, state.faultExp);
    const o = {
        tTlb: state.tTlb, tMem: state.tMem, tFault: state.tFaultMs * 1e6,
        hitRate: state.hitPct / 100, faultRate: p,
    };
    const e = VM.eat(o);
    const noFault = VM.eat(Object.assign({}, o, { faultRate: 0 }));
    const h99 = VM.eat(Object.assign({}, o, { hitRate: 0.99, faultRate: 0 }));
    const h90 = VM.eat(Object.assign({}, o, { hitRate: 0.90, faultRate: 0 }));
    const eat4 = VM.eat(Object.assign({}, o, { hitRate: 0.99, faultRate: 1e-4 }));

    // 对照矩阵：行是缺页率，列是 TLB 命中率
    const hits = [0.999, 0.99, 0.95, 0.90];
    const ps = [0, 1e-7, 1e-6, 1e-5, 1e-4];
    const tb = h('table.mv-matrix', null,
        h('tr', null, h('th', { text: '缺页率 ＼ TLB 命中率' }),
            ...hits.map((x) => h('th', { text: (x * 100).toFixed(1) + '%' }))));
    ps.forEach((pp) => {
        const label = pp === 0 ? '0（页全在内存）'
            : '10⁻' + String(Math.round(-Math.log10(pp))) + '（' + fmtRate(pp) + '）';
        const tr = h('tr', null, h('td.mv-strong', { text: label }));
        hits.forEach((hh) => {
            const v = VM.eat(Object.assign({}, o, { hitRate: hh, faultRate: pp }));
            tr.appendChild(h('td' + (v.faultShare > 0.5 ? '.bad' : (pp === 0 ? '.ok' : '')), { text: fmtNs(v.eat) }));
        });
        tb.appendChild(tr);
    });

    return Viz.card('fa-gauge-high', '第二个反直觉点：TLB 命中率根本不是重点，缺页率才是',
        '直觉上「TLB 命中率从 99% 掉到 90%」听起来很严重。'
        + '但把数字算出来会发现：这点损失和<b>万分之一的缺页率</b>比起来完全不值一提。'
        + '原因很粗暴 —— 磁盘 I/O 比内存访问大了整整<b>五个数量级</b>。',
        h('div.controls', null,
            Viz.slider({
                label: 'TLB 命中率', min: 80, max: 100, step: 0.5, value: state.hitPct,
                fmt: (v) => v.toFixed(1) + '%', onInput: (v) => { state.hitPct = v; render(); },
            }),
            Viz.slider({
                label: '缺页率', min: -8, max: -2, step: 1, value: state.faultExp,
                fmt: (v) => '10^' + v, onInput: (v) => { state.faultExp = v; render(); },
            }),
            Viz.slider({
                label: 'TLB 访问', min: 1, max: 5, step: 1, value: state.tTlb,
                fmt: (v) => v + ' ns', onInput: (v) => { state.tTlb = v; render(); },
            }),
            Viz.slider({
                label: '内存访问', min: 50, max: 200, step: 10, value: state.tMem,
                fmt: (v) => v + ' ns', onInput: (v) => { state.tMem = v; render(); },
            }),
            Viz.slider({
                label: '缺页处理', min: 1, max: 20, step: 1, value: state.tFaultMs,
                fmt: (v) => v + ' ms', onInput: (v) => { state.tFaultMs = v; render(); },
            })
        ),
        Viz.flowList([{
            t: '平均访存时间 EAT 的三条路径',
            f: 'TLB 命中           : tTLB + tMem\n'
                + 'TLB 未命中、页有效 : tTLB + 2·tMem      （多读一次内存拿页表项）\n'
                + '缺页               : tTLB + 2·tMem + tFault\n'
                + '合并化简后 →  EAT = tTLB + tMem + (1-h)·tMem + p·tFault',
            r: `当前：${state.tTlb} + ${state.tMem} + ${(1 - state.hitPct / 100).toFixed(3)}×${state.tMem} + ${p.toExponential(0)}×${state.tFaultMs}ms = ${fmtNs(e.eat)}`,
        }]),
        Viz.cmpGrid([
            { h: '当前平均访存时间', v: fmtNs(e.eat), d: `比理想的 ${fmtNs(e.base)} 慢 ${e.slowdown.toFixed(1)} 倍`, cls: e.faultShare > 0.5 ? 'cmp-bad' : 'cmp-ok' },
            { h: '缺页占了多少', v: (e.faultShare * 100).toFixed(1) + '%', d: '这一小撮访问吃掉的时间比例', cls: 'cmp-bad' },
            { h: '假装没有缺页', v: fmtNs(noFault.eat), d: '只有 TLB 未命中的损失', cls: 'cmp-save' },
        ]),
        buildEatBar(e),
        h('div.seq-note', {
            html: '<b>把两件事摆在一起比：</b><br>'
                + `① TLB 命中率 99% → 90%（缺页率为 0）：${fmtNs(h99.eat)} → ${fmtNs(h90.eat)}，`
                + `只慢了 <b>${((h90.eat / h99.eat - 1) * 100).toFixed(1)}%</b>。<br>`
                + '② 保持 99% 命中率，但缺页率从 0 变成 10⁻⁴（一万次访存缺一次页）：'
                + `${fmtNs(h99.eat)} → ${fmtNs(eat4.eat)}，`
                + `慢了 <b>${(eat4.eat / h99.eat).toFixed(1)} 倍</b>。<br>`
                + `<b>结论：想让性能损失控制在 10% 以内，缺页率必须压到 ${(0.1 * h99.eat / (state.tFaultMs * 1e6)).toExponential(1)} 以下</b>`
                + '，也就是<b>百万分之几</b>。这就是为什么操作系统宁可花大力气做预取、工作集管理，'
                + '也不愿意让程序真的去碰磁盘。',
        }),
        h('h4.vm-sub', { text: '横竖两个方向拉一遍，数量级碾压看得更清楚' }),
        h('div.mv-matrix-wrap', null, tb),
        h('p.sec-note', {
            html: '<b>横着看</b>（TLB 命中率从 99.9% 掉到 90%）：数字几乎不动。'
                + '<b>竖着看</b>（缺页率每涨 10 倍）：数字直接乘 10。'
                + '红色格子表示<b>缺页开销已经占了一半以上</b> —— 到这一步，TLB 调得再好也没意义了。',
        })
    );
}

function fmtRate(p) {
    if (p >= 1e-4) return '万分之一';
    if (p >= 1e-5) return '十万分之一';
    if (p >= 1e-6) return '百万分之一';
    if (p >= 1e-7) return '千万分之一';
    return p.toExponential(0);
}

// ---------- 多级页表 ----------

function buildMultiLevel() {
    const pteBytes = state.mlAddrBits === 32 ? 4 : 8;
    const c = VM.ptCost({
        addrBits: state.mlAddrBits, pageBits: state.pageBits,
        pteBytes: pteBytes, usedLeafTables: state.mlUsed,
    });
    const procs = 100;

    const canTwo = c.l1Bits > 0 && c.dirBytes <= Math.pow(2, state.pageBits);

    return Viz.card('fa-layer-group', '第三个点：为什么非要搞多级页表',
        `<b>${state.mlAddrBits} 位地址空间、${fmtSize(pageSize())} 的页</b> → 一级页表要有 `
        + `2^${c.vpnBits} = ${c.flatEntries.toLocaleString('en-US')} 项，每项 ${pteBytes} 字节，`
        + `<b>每个进程 ${fmtSize(c.flatBytes)} 的页表</b>。而且这张表必须<b>整块连续地待在物理内存里</b>，`
        + '不管进程实际用了多少地址空间 —— 哪怕它只用了 1MB。',
        h('div.controls', null,
            h('label.ctl', null,
                h('span.ctl-name', { text: '地址位数' }),
                Viz.segmented({
                    value: state.mlAddrBits,
                    options: [{ v: 32, label: '32 位（PTE 4B）' }, { v: 48, label: '48 位（x86-64，PTE 8B）' }],
                    onPick: (v) => { state.mlAddrBits = v; render(); },
                })),
            Viz.slider({
                label: '进程实际用到几张二级表', min: 1, max: 16, step: 1, value: state.mlUsed,
                fmt: (v) => v + ' 张（覆盖 ' + fmtSize(v * c.coverPerLeaf) + '）',
                onInput: (v) => { state.mlUsed = v; render(); },
            })
        ),
        Viz.cmpGrid([
            { h: '一级页表', v: fmtSize(c.flatBytes), d: '每个进程都要这么多', cls: 'cmp-bad' },
            { h: '二级页表', v: canTwo ? fmtSize(c.twoBytes) : '装不下', d: canTwo ? `1 张目录 + ${c.usedLeafTables} 张二级表` : '顶层目录本身就超过一页了', cls: canTwo ? 'cmp-ok' : 'cmp-bad' },
            { h: '缩小倍数', v: canTwo ? '×' + Math.round(c.ratio) : '—', d: canTwo ? '同样能寻址整个空间' : '必须再多分几级', cls: 'cmp-save' },
        ]),
        Viz.flowList([
            {
                t: '拆法：把 VPN 再劈成两段',
                f: `虚拟地址 = [ 页目录索引 ${c.l1Bits} 位 | 二级表索引 ${c.l2Bits} 位 | 页内偏移 ${state.pageBits} 位 ]\n`
                    + `每张二级表 2^${c.l2Bits} 项 × ${pteBytes} B = ${fmtSize(c.leafBytes)}，刚好占满一页\n`
                    + `一张二级表能覆盖 2^${c.l2Bits} × ${fmtSize(pageSize())} = ${fmtSize(c.coverPerLeaf)} 的地址空间`,
                r: `页目录本身 2^${c.l1Bits} 项 × ${pteBytes} B = ${fmtSize(c.dirBytes)}`,
            },
            {
                t: '省在哪：没用到的那片地址空间，二级表根本不建',
                f: `一个普通进程的地址空间是「代码段 + 堆 + 栈 + 库」几块，中间全是空洞\n`
                    + `实际用到 ${c.usedLeafTables} 张二级表 → ${fmtSize(c.dirBytes)}（目录）+ ${c.usedLeafTables} × ${fmtSize(c.leafBytes)} = ${fmtSize(c.twoBytes)}`,
                r: canTwo ? `${fmtSize(c.flatBytes)} → ${fmtSize(c.twoBytes)}，缩小到原来的 ${(100 / c.ratio).toFixed(2)}%` : '这个参数组合下二级不够，见下一条',
                hi: `${procs} 个进程一起算：一级页表要 <b>${fmtSize(c.flatBytes * procs)}</b> 全是页表，`
                    + (canTwo ? `二级只要 <b>${fmtSize(c.twoBytes * procs)}</b>。` : '')
                    + '这就是多级页表存在的全部理由：<b>用「查表多走一跳」换「不用为空洞掏钱」</b>。',
            },
            {
                t: '代价：翻译一次要多访几次内存',
                f: `一级：1 次内存读页表项 + 1 次读数据 = 2 次\n`
                    + `${c.minLevels} 级：${c.minLevels} 次读页表 + 1 次读数据 = ${c.minLevels + 1} 次`,
                r: 'TLB 命中时这些全部省掉 —— 所以多级页表能成立，前提是 TLB 命中率够高',
                hi: '这两件事是配套的：<b>多级页表把空间省下来，TLB 把时间补回去。</b>'
                    + '少了任何一个，虚拟内存都跑不动。',
            },
        ]),
        h('div.seq-note', {
            html: `<b>为什么 x86-64 是四级（现在还有五级）？</b>`
                + `让每一级的表都刚好占一页，每级就只能用 log2(页大小 / 页表项大小) = <b>${VM.bitsPerLevel(state.pageBits, 8)} 位</b>。`
                + `48 位虚拟地址去掉 ${state.pageBits} 位偏移还剩 ${48 - state.pageBits} 位，`
                + `${48 - state.pageBits} ÷ ${VM.bitsPerLevel(state.pageBits, 8)} = <b>${VM.minLevels(48, state.pageBits, 8)} 级</b> —— `
                + '不是拍脑袋定的，是除出来的。'
                + `顺便算一下：48 位如果硬要用一级页表，是 2^${48 - state.pageBits} × 8 B = `
                + `<b>${fmtSize(Math.pow(2, 48 - state.pageBits) * 8)}</b> 每进程，荒谬到没法讨论。`
                + '（Intel 5-level paging 把虚拟地址扩到 57 位，于是变成五级。）',
        })
    );
}

// ---------- 渲染 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const sim = VM.simulate(state.refs, state.bFrames, state.policy);

    rootEl.appendChild(Viz.card('fa-memory', '虚拟内存到底在解决什么问题',
        '每个进程都以为自己独占一整块从 0 开始的连续内存 —— 这是假的。'
        + '真实情况是：<b>程序里的地址全是虚拟的</b>，每次访存都要被 MMU 硬件翻译成物理地址；'
        + '而且物理内存装不下所有页，装不下的部分被扔在磁盘上，用到时才换回来。'
        + '<br>下面按三条线走：<b>① 一次翻译具体怎么走</b>（视图一）→ '
        + '<b>② 内存满了该赶谁走</b>（视图二）→ <b>③ 这套机制的两个反直觉后果</b>（Belady 异常 + 缺页率的碾压）。'));

    rootEl.appendChild(buildViewA());
    rootEl.appendChild(buildViewB(sim));
    rootEl.appendChild(buildBelady(sim));
    rootEl.appendChild(buildEat());
    rootEl.appendChild(buildMultiLevel());

    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        {
            q: 'TLB 和 CPU Cache 是一回事吗？',
            a: '<b>不是，缓存的东西完全不同。</b>'
                + '<b>TLB</b> 缓存的是<b>地址映射</b>（VPN → PPN），属于 MMU 的一部分，'
                + '命中的结果是「我知道这个虚拟页在哪个物理页」。'
                + '<b>Cache</b> 缓存的是<b>内存里的数据本身</b>，命中的结果是「数据我这儿就有，不用去内存拿」。'
                + '两者串在同一条访存路径上：先用 TLB 拿到物理地址，再用物理地址去查 Cache。'
                + '（现代 CPU 为了省时间会做 <b>VIPT</b>：用虚拟地址的低位并行去索引 Cache 组，'
                + '同时查 TLB 拿物理地址来比对 tag，把两步重叠起来。）'
                + '硬要说共同点，就是它们都是「用小而快的硬件缓存大而慢的东西」。',
        },
        {
            q: '缺页（Page Fault）和段错误（Segmentation Fault）什么关系？',
            a: '<b>缺页是机制，段错误是缺页处理失败后的一种结局。</b>'
                + '硬件发现 PTE 的 valid=0 就产生缺页异常，控制权交给内核。'
                + '内核这时才去查这个地址<b>属不属于该进程的合法虚拟内存区域</b>：'
                + '① 合法、内容在磁盘上 → 换入，这叫 <b>major fault</b>（要真的做 I/O）；'
                + '② 合法、页就在内存里只是没建映射（比如刚 fork 完、或者被回收了页表项）→ 直接补映射，'
                + '这叫 <b>minor fault</b>，很便宜；'
                + '③ <b>不合法</b>（越界、访问空指针、往只读段写）→ 内核给进程发 <code>SIGSEGV</code>，'
                + '这才是段错误。'
                + '所以：<b>每个段错误都始于一次缺页，但绝大多数缺页跟段错误没关系。</b>'
                + '用 <code>/usr/bin/time -v</code> 或 <code>ps -o min_flt,maj_flt</code> 能看到这两类计数。',
        },
        {
            q: '为什么现代 x86-64 用四级页表？',
            a: '算出来的。约束是<b>每一级的页表本身也必须刚好装进一个页</b>（这样它自己也能被换、被分配）。'
                + '4KB 页 ÷ 8 字节的页表项 = 512 项 = <b>每级只能用 9 位索引</b>。'
                + '而 x86-64 目前只用 48 位虚拟地址（高 16 位是符号扩展，不能乱填），'
                + '去掉 12 位页内偏移还剩 36 位，<b>36 ÷ 9 = 4</b>，所以是四级：'
                + 'PGD → PUD → PMD → PTE。'
                + 'Intel 后来的 <b>5-level paging</b> 把虚拟地址扩到 57 位，45 ÷ 9 = 5，就多了一级 P4D。'
                + '代价是 TLB 未命中时要走更多跳（最多 4~5 次内存访问），'
                + '所以 CPU 又加了 <b>页表游走缓存（paging-structure cache）</b>来缓存中间层。',
        },
        {
            q: '写时复制 COW 是怎么用缺页机制实现的？',
            a: '<code>fork()</code> 的时候<b>不复制任何物理页</b>，只复制页表，'
                + '并把父子双方的相关页表项<b>全部改成只读</b>（同时在内核的 VMA 里标记这是 COW 页）。'
                + '于是：只读就一直共享，谁都没多花内存。'
                + '一旦某一方尝试<b>写</b>，硬件发现「只读页被写」→ 产生<b>保护型缺页</b>（这也是 page fault 的一种）；'
                + '内核在处理程序里看到这是 COW 页，就<b>真的分配一个新物理页、把内容拷过去、'
                + '把写者的 PTE 改成可写</b>，然后<b>重新执行那条写指令</b>。'
                + '这就是为什么 <code>fork()</code> 后马上 <code>exec()</code> 几乎不花钱，'
                + '也是为什么 Redis 做 RDB 持久化时用 fork —— 子进程拿到的是一份「逻辑快照」。'
                + '副作用是：如果 fork 之后父进程疯狂写数据，COW 会被大面积触发，'
                + '内存占用可能接近翻倍，这就是 Redis 那个著名的<b>持久化期间内存暴涨</b>问题。',
        },
        {
            q: '为什么页内偏移不需要翻译？',
            a: '因为<b>虚拟页和物理页大小完全一样</b>。'
                + '页是搬运的最小单位，一整页被原封不动搬到某个物理页帧里，页内第 837 个字节，'
                + '搬完之后还是第 837 个字节。'
                + '所以翻译只需要换掉「页号」这一段，低位偏移直接照抄。'
                + '这个设计还有个副产品：<b>页表项里只存 PPN 就够了</b>，'
                + '不用存完整物理地址，页表体积因此小了一大截。',
        },
    ])));

    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls([
        ['Belady 异常只出现在「非栈式」算法上',
            'FIFO 和 CLOCK 会出，<b>LRU 和 OPT 不会</b>。判据是<b>栈式性质</b>：'
            + 'n 个页帧时的驻留集必须永远是 n+1 个页帧时驻留集的子集。'
            + 'LRU 满足（多一个帧只是多留住一个更老的页），FIFO 不满足（队列长度一变，整个淘汰时序全变）。'
            + '面试被问「加内存一定更快吗」，答「不一定，FIFO 有 Belady 异常」只是及格；'
            + '能补一句「因为它不是栈式算法」才算答到点上。'],
        ['CLOCK 是 LRU 的<b>廉价近似</b>，不是等价物',
            'LRU 要维护完整的访问顺序，硬件上做不起（每次访存都要更新链表）。'
            + 'CLOCK 只用 <b>1 个比特</b>的信息：最近有没有被访问过。'
            + '它能区分「碰过 / 没碰过」，但<b>完全无法排序</b> —— 三个都被碰过的页在它眼里一模一样。'
            + '所以 CLOCK 的结果经常跟 FIFO 相同（本演示的经典序列上就是），'
            + '只有在「有明显冷页」的场景下才体现出优势。'
            + 'Linux 实际用的是更复杂的<b>双链表 LRU（active / inactive）</b>加上访问位老化。'],
        ['OPT 不可实现，它只是一把尺子',
            'OPT 要求预知整个未来的访问序列，现实中不可能。'
            + '它的唯一用途是<b>给出理论下界</b>：拿你的算法和 OPT 比，就知道还有多少提升空间。'
            + '如果你的 LRU 已经接近 OPT，那再换算法是白费劲，'
            + '真正该做的是<b>改访问模式</b>（比如把随机访问改成顺序访问）或者<b>加内存</b>。'],
        ['真正的杀手是抖动（thrashing），不是某次缺页',
            '当所有活跃进程的<b>工作集</b>（一段时间内实际用到的页集合）加起来超过物理内存，'
            + '系统就会进入抖动：刚换进来的页马上又被换出去，CPU 大部分时间在等磁盘。'
            + '现象很有辨识度：<b>CPU 利用率断崖式下跌</b>，而这时如果调度器误以为「CPU 闲着」'
            + '再放更多进程进来，会跌得更快。'
            + '解法是<b>工作集模型</b>或<b>缺页率控制（PFF）</b>：缺页率高就多给页帧，'
            + '实在不行就整个进程 swap out。'
            + '所以性能调优时该看的不是单次缺页耗时，而是 <b>major fault 的速率</b>。'],
        ['换出页时忘了作废 TLB = 读到别人的数据',
            'TLB 是页表的缓存，页表项改了必须同步。'
            + '单核上 <code>invlpg</code> 一条指令的事；'
            + '<b>多核上麻烦得多</b> —— 别的核 TLB 里也可能缓存着这条映射，'
            + '得给它们发核间中断让它们各自作废，这就是 <b>TLB shootdown</b>，'
            + '开销大到会成为高并发场景的瓶颈（大量 <code>munmap</code> / 内存回收时尤其明显）。'],
        ['缺页机制不只是「内存不够时才用」',
            '很多功能都是搭着缺页实现的：<b>mmap 文件的懒加载</b>（映射时不读数据，访问到哪页才读哪页）、'
            + '<b>写时复制 COW</b>、<b>按需清零的匿名页</b>（先全部指向同一个零页，写的时候才真分配）、'
            + '<b>guard page 检测栈溢出</b>。'
            + '把缺页只当成「内存不够的补救措施」，就理解窄了 —— 它更像操作系统给自己留的一个<b>通用回调钩子</b>。'],
    ])));

    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示：做了哪些简化' }),
        h('p', {
            html: '<b>① 页表项只画了有效位、PPN 和访问位。</b>真实 PTE 还有脏位、只读/可写、'
                + '用户/内核、NX（不可执行）、全局位、缓存策略位等等，本演示一律忽略，'
                + '换出脏页要先写回磁盘这件事只在文字里提了一句，没在图上体现。',
        }),
        h('p', {
            html: '<b>② 忽略了多核 TLB 一致性。</b>视图一里换出页时只抹掉了本机的 TLB 项，'
                + '真实多核系统还要做 TLB shootdown（发核间中断）。这部分只写进「坑」里，没建模。',
        }),
        h('p', {
            html: '<b>③ 忽略了大页（huge page）。</b>x86-64 支持 2MB / 1GB 大页，'
                + '它会让页表少走一级、TLB 覆盖范围暴增，是真实系统里的重要优化，本演示统一按 4KB 小页处理。',
        }),
        h('p', {
            html: '<b>④ 置换算法作用在「全局页帧池」上。</b>真实内核区分<b>局部置换</b>（只在本进程的页里挑）'
                + '和<b>全局置换</b>（在全系统页里挑），Linux 还有 active/inactive 双链表、'
                + 'kswapd 后台回收、page cache 与匿名页的不同待遇 —— 全都没建模。',
        }),
        h('p', {
            html: '<b>⑤ EAT 公式是教科书口径。</b>假设「缺页只发生在 TLB 未命中的分支上」'
                + '（这是对的，TLB 命中意味着页一定驻留），并且把缺页处理时间当成一个常数。'
                + '真实缺页耗时取决于是 major 还是 minor、是 SSD 还是 HDD、有没有排队，差异极大。'
                + '这里默认的 8 ms 是机械硬盘量级；NVMe SSD 大约是 50~100 µs，缺页的碾压效应会弱很多，'
                + '但仍然比内存访问慢三个数量级。',
        }),
        h('p', {
            html: '<b>⑥ 所有数字都是确定性算出来的</b>，没有用随机数：'
                + 'Belady 的 9/10、各算法的缺页次数、EAT 的每一个值，都由页面上同一套纯函数实时计算，'
                + '刷新前后完全一致，也能被单元测试逐条对拍。',
        })
    ));
}

Viz.register({
    id: 'virtual-memory',
    cat: 'os',
    title: '虚拟内存',
    subtitle: '地址翻译 · 缺页 · 页面置换',
    icon: 'fa-memory',
    blurb: '地址怎么翻译、内存满了赶谁走，以及为什么加内存反而可能更慢',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.pageBits = 12;
        state.addrs = SCRIPT.slice();
        state.aStep = 4;
        state.refs = BELADY_SEQ.slice();
        state.bFrames = 3;
        state.policy = 'FIFO';
        state.bStep = -1;
        state.hitPct = 99;
        state.faultExp = -4;
        state.tTlb = 1;
        state.tMem = 100;
        state.tFaultMs = 8;
        state.mlAddrBits = 32;
        state.mlUsed = 4;
        render();
    },
    unmount() {
        rootEl = null;
    },
});

})();
