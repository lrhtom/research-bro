// ============================================================
//  演示：KMP 字符串匹配
//  失配的时候模式串该往右滑几位？答案早就写在 next 数组里了。
//  整个 KMP 的价值只有一句话：主串指针 i 从头到尾只前进、不回退。
//  上半 KMP.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const KMP = {};

/**
 * 前缀函数 π（prefix function）。
 * π[i] = 子串 p[0..i] 的「最长公共真前后缀」长度。
 * 「真」= 不许取整个自己，所以 π[0] 恒为 0。
 * 本演示所有地方都以 π 为准；带 -1 的那种 next 由 piToNext 转出来。
 */
KMP.buildPi = function (p) {
    const m = p.length;
    const pi = new Array(m).fill(0);
    for (let i = 1; i < m; i++) {
        let k = pi[i - 1];                              // 先接着上一位的答案试
        while (k > 0 && p[i] !== p[k]) k = pi[k - 1];    // 试不通就退到「更短的那个公共前后缀」
        if (p[i] === p[k]) k++;                         // 能接上就加长 1
        pi[i] = k;
    }
    return pi;
};

/**
 * π → 「带 -1 的 next 数组」，长度 m+1：
 *     next[0] = -1,  next[j] = π[j-1]  (j >= 1)
 * 好处是失配时可以统一写成「右滑 j - next[j] 位」，
 * j = 0 时正好是 -1，滑 1 位，不用再写一个 if。
 * next[m] 也有意义：找到一次完整匹配后接着往下找，就用它。
 */
KMP.piToNext = function (pi) {
    const nxt = [-1];
    for (let j = 1; j <= pi.length; j++) nxt.push(pi[j - 1]);
    return nxt;
};

/**
 * next 数组的构造过程（模式串自己跟自己匹配），逐位留痕。
 * 返回 { pi, rows }，rows[i] = {
 *   i, ch, from(起始候选 k), tried[](回退过的候选), cmps[](每次字符比较), k(最终 π[i]), border(公共前后缀)
 * }
 */
KMP.buildTrace = function (p) {
    const m = p.length;
    const pi = new Array(m).fill(0);
    const rows = [];
    if (m === 0) return { pi, rows };

    rows.push({
        i: 0, ch: p[0], from: 0, tried: [], cmps: [], k: 0, border: '',
        base: true,
    });

    for (let i = 1; i < m; i++) {
        const from = pi[i - 1];
        let k = from;
        const tried = [], cmps = [];
        while (k > 0 && p[i] !== p[k]) {
            cmps.push({ k, a: p[i], b: p[k], eq: false });
            tried.push(k);
            k = pi[k - 1];
        }
        if (p[i] === p[k]) {
            cmps.push({ k, a: p[i], b: p[k], eq: true });
            k++;
        } else {
            cmps.push({ k, a: p[i], b: p[k], eq: false });   // 只可能是 k === 0 还不等
        }
        pi[i] = k;
        rows.push({ i, ch: p[i], from, tried, cmps, k, border: p.slice(0, k), base: false });
    }
    return { pi, rows };
};

/**
 * KMP 主匹配，把每一次字符比较都记下来。
 * 返回 {
 *   pi, nxt, steps[], matches[], comparisons, iTrace[], n, m
 * }
 * steps[t] = {
 *   i, j, align(=i-j, 模式串左端对齐到主串哪一格), tc, pc, eq, cmp,
 *   type: 'go' | 'match' | 'slide' | 'slide0',
 *   k(用到的 next 值), shift(右滑几位), i2, j2, align2, at(命中位置)
 * }
 */
KMP.search = function (text, pat) {
    const n = text.length, m = pat.length;
    const pi = KMP.buildPi(pat);
    const nxt = KMP.piToNext(pi);
    const steps = [], matches = [], iTrace = [];

    // 空模式串：约定「每个位置都算命中」，和朴素算法口径一致（indexOf('') 也返回 0）
    if (m === 0) {
        for (let s = 0; s <= n; s++) matches.push(s);
        return { pi, nxt, steps, matches, comparisons: 0, iTrace, n, m };
    }

    let i = 0, j = 0, cmp = 0;
    while (i < n) {
        const align = i - j;
        const eq = text[i] === pat[j];
        cmp++;
        iTrace.push(i);
        const st = { t: steps.length, i, j, align, tc: text[i], pc: pat[j], eq, cmp };

        if (eq) {
            i++; j++;
            if (j === m) {
                const k = nxt[m];                 // = π[m-1]
                st.type = 'match';
                st.at = i - m;
                st.k = k;
                st.shift = m - k;
                st.i2 = i; st.j2 = k; st.align2 = i - k;
                matches.push(i - m);
                j = k;                            // 不回到 0，才能找出重叠的匹配
            } else {
                st.type = 'go';
                st.k = null;
                st.shift = 0;
                st.i2 = i; st.j2 = j; st.align2 = align;
            }
        } else {
            const k = nxt[j];
            st.k = k;
            st.shift = j - k;                     // j=0 时 = 0-(-1) = 1
            if (j === 0) {
                i++;
                st.type = 'slide0';
                st.i2 = i; st.j2 = 0; st.align2 = i;
            } else {
                j = k;
                st.type = 'slide';
                st.i2 = i; st.j2 = k; st.align2 = i - k;   // i 一动不动
            }
        }
        steps.push(st);
    }
    return { pi, nxt, steps, matches, comparisons: cmp, iTrace, n, m };
};

/**
 * 朴素（暴力）匹配，作为对照。
 * ptr[] 记录每次比较时「主串指针落在哪一格」—— 用它画出暴力法的指针来回跳。
 */
KMP.naive = function (text, pat) {
    const n = text.length, m = pat.length;
    const matches = [], ptr = [];
    let cmp = 0;
    for (let s = 0; s + m <= n; s++) {
        let k = 0;
        while (k < m) {
            cmp++;
            ptr.push(s + k);
            if (text[s + k] !== pat[k]) break;
            k++;
        }
        if (k === m) matches.push(s);
    }
    return { matches, comparisons: cmp, ptr };
};

/** 指针轨迹里「往回跳」了几次（KMP 应该恒为 0）*/
KMP.retreats = function (trace) {
    let c = 0;
    for (let t = 1; t < trace.length; t++) if (trace[t] < trace[t - 1]) c++;
    return c;
};

/** 最坏用例：AAAA…AB 里找 AAA…AB —— 暴力每次都要比到最后一个字符才发现不对 */
KMP.worst = function (n, m) {
    const mm = Math.max(1, Math.min(m, n));
    return {
        text: 'A'.repeat(Math.max(0, n - 1)) + (n > 0 ? 'B' : ''),
        pat: 'A'.repeat(mm - 1) + 'B',
    };
};

/** 规模增长曲线：每个 n 造一个最坏用例，量两种算法的比较次数 */
KMP.growthSeries = function (nList, ratio) {
    return nList.map((n) => {
        const m = Math.max(2, Math.round(n * ratio));
        const c = KMP.worst(n, m);
        return {
            n, m,
            naive: KMP.naive(c.text, c.pat).comparisons,
            kmp: KMP.search(c.text, c.pat).comparisons,
        };
    });
};

/** 线性同余伪随机（固定种子 → 结果可复现，方便单测对拍；全站禁用 Math.random）*/
KMP.lcg = function (seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        return s / 4294967296;
    };
};

KMP.randStr = function (rnd, len, alphabet) {
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[Math.floor(rnd() * alphabet.length) % alphabet.length];
    return out;
};

if (typeof module !== 'undefined' && module.exports) module.exports = KMP;
if (typeof window !== 'undefined') window.KMPModel = KMP;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text, E = Viz.esc;

const DEF_TEXT = 'ABABABCABABABCAB';
const DEF_PAT = 'ABABCAB';

const PRESETS = [
    { name: '默认例子', text: DEF_TEXT, pat: DEF_PAT, tip: '有失配、有滑动、有两次命中，先看这个' },
    { name: '最坏用例（打脸）', text: 'AAAAAAAAAAAAAAAAAAAB', pat: 'AAAAB', tip: '暴力法每次都要比到最后一个字符才发现不对' },
    { name: '重叠匹配', text: 'AAAAA', pat: 'AAA', tip: '命中后 j 不清零，才能找到 0/1/2 三个重叠位置' },
    { name: '完全不匹配', text: 'ABCDEFGHIJ', pat: 'XYZ', tip: '首字符就失配，KMP 也帮不上忙，退化成一格一格挪' },
    { name: '周期串', text: 'ABCABCABCABD', pat: 'ABCABD', tip: 'next 数组把「ABC 是周期」这件事记下来了' },
];

const state = {
    text: DEF_TEXT,
    pat: DEF_PAT,
    step: 0,
    bi: 1,              // next 构造看到第几位
    scale: 96,          // 规模滑块（最坏用例的主串长度）
    playing: false,
    tk: null,
    acc: 0,
    res: null,
    nv: null,
    trace: null,
    growth: null,
    dom: {},
};

const RATIO = 0.25;                  // 规模实验里 模式串长 = 主串长 × 这个比例
const N_LIST = (() => { const a = []; for (let n = 8; n <= 240; n += 8) a.push(n); return a; })();

function recompute() {
    state.res = KMP.search(state.text, state.pat);
    state.nv = KMP.naive(state.text, state.pat);
    state.trace = KMP.buildTrace(state.pat);
    if (!state.growth) state.growth = KMP.growthSeries(N_LIST, RATIO);
    state.step = Math.min(state.step, Math.max(0, state.res.steps.length - 1));
    state.bi = Math.min(state.bi, Math.max(0, state.pat.length - 1));
}

// ---------- 主视图：两行字符格子 ----------

function cellW(len) {
    if (len <= 20) return 30;
    if (len <= 30) return 24;
    if (len <= 42) return 18;
    return 14;
}

/** 一个字符格子（矩形 + 字），cls 决定配色 */
function cell(x, y, w, hh, ch, cls, fs) {
    const g = svg('g');
    g.appendChild(svg('rect', { x, y, width: w - 2, height: hh, rx: 4, class: 'kmp-cell ' + cls }));
    g.appendChild(T({
        x: x + (w - 2) / 2, y: y + hh / 2 + 4.5, 'text-anchor': 'middle',
        class: 'kmp-ch ' + cls, 'font-size': fs,
    }, ch));
    return g;
}

function buildMainSvg() {
    const res = state.res, text = state.text, pat = state.pat;
    const n = text.length, m = pat.length;
    const st = res.steps[state.step] || null;

    const align = st ? st.align : 0;
    const j = st ? st.j : 0;
    const i = st ? st.i : 0;
    const showGhost = !!(st && st.shift > 0);
    const align2 = st ? st.align2 : 0;

    const spanCells = Math.max(n, align + m, showGhost ? align2 + m : 0, 1);
    const CW = cellW(spanCells);
    const CH = Math.max(20, Math.round(CW * 0.95));
    const FS = CW >= 24 ? 13 : (CW >= 18 ? 11 : 9);

    const PAD_L = 62, PAD_R = 16;
    const Y_PTR = 2, Y_IDX = 30, Y_TEXT = 34;
    const Y_PAT = Y_TEXT + CH + 34;
    const Y_GHOST = Y_PAT + CH + 30;
    const H = (showGhost ? Y_GHOST + CH + 26 : Y_PAT + CH + 26);
    const W = PAD_L + spanCells * CW + PAD_R;

    const x = (idx) => PAD_L + idx * CW;
    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'kmp-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'KMP 匹配过程',
    });

    const defs = svg('defs');
    ['kmpArr', 'kmpArrShift'].forEach((id) => {
        const mk = svg('marker', {
            id, viewBox: '0 0 10 10', refX: '9', refY: '5',
            markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse',
        });
        mk.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', fill: id === 'kmpArr' ? '#6b7280' : '#4f46e5' }));
        defs.appendChild(mk);
    });
    root.appendChild(defs);

    // 已扫过的区域（i 左边的部分永远不会再回头）
    if (st && i > 0) {
        root.appendChild(svg('rect', {
            x: x(0), y: Y_TEXT - 6, width: i * CW - 2, height: CH + 12, rx: 5, class: 'kmp-scanned',
        }));
    }

    // 下标 + 主串
    root.appendChild(T({ x: PAD_L - 10, y: Y_TEXT + CH / 2 + 4, 'text-anchor': 'end', class: 'kmp-rowlab' }, '主串 text'));
    for (let idx = 0; idx < n; idx++) {
        if (CW >= 18 || idx % 5 === 0) {
            root.appendChild(T({ x: x(idx) + (CW - 2) / 2, y: Y_IDX - 4, 'text-anchor': 'middle', class: 'kmp-idx' }, String(idx)));
        }
        let cls = 'kmp-c-plain';
        if (st) {
            if (idx < align) cls = 'kmp-c-past';
            else if (idx < i) cls = 'kmp-c-kept';
            if (idx === i) cls = st.eq ? 'kmp-c-ok' : 'kmp-c-bad';
        }
        root.appendChild(cell(x(idx), Y_TEXT, CW, CH, text[idx], cls, FS));
    }

    // i 指针（只进不退）
    if (st) {
        const px = x(i) + (CW - 2) / 2;
        root.appendChild(svg('path', {
            d: `M${px - 5} ${Y_PTR + 3}L${px + 5} ${Y_PTR + 3}L${px} ${Y_PTR + 12}Z`, class: 'kmp-ptr-i',
        }));
        root.appendChild(T({ x: px + 9, y: Y_PTR + 12, class: 'kmp-ptr-lab' }, `i=${i}`));
        root.appendChild(T({ x: PAD_L - 10, y: Y_PTR + 12, 'text-anchor': 'end', class: 'kmp-ptr-hint' }, 'i 只进不退'));
    }

    // 已找到的匹配（画在主串下面的绿条）
    res.matches.forEach((at) => {
        const found = !st || at + m <= i || res.steps.slice(0, state.step + 1).some((s) => s.type === 'match' && s.at === at);
        if (!found || m === 0) return;
        root.appendChild(svg('rect', {
            x: x(at), y: Y_TEXT + CH + 3, width: m * CW - 2, height: 4, rx: 2, class: 'kmp-hitbar',
        }));
    });

    // 比较连线
    if (st) {
        const cx = x(i) + (CW - 2) / 2;
        root.appendChild(svg('line', {
            x1: cx, y1: Y_TEXT + CH + 8, x2: cx, y2: Y_PAT - 4,
            class: st.eq ? 'kmp-link-ok' : 'kmp-link-bad',
        }));
        root.appendChild(T({
            x: cx + 7, y: (Y_TEXT + CH + Y_PAT) / 2 + 4,
            class: st.eq ? 'kmp-cmp-ok' : 'kmp-cmp-bad',
        }, st.eq ? '相等 ✓' : '失配 ✗'));
    }

    // 模式串当前位置
    root.appendChild(T({ x: PAD_L - 10, y: Y_PAT + CH / 2 + 4, 'text-anchor': 'end', class: 'kmp-rowlab' }, '模式串 pat'));
    for (let q = 0; q < m; q++) {
        const idx = align + q;
        let cls = 'kmp-c-plain';
        if (st) {
            if (q < j) cls = 'kmp-c-kept';
            if (q === j) cls = st.eq ? 'kmp-c-ok' : 'kmp-c-bad';
        }
        root.appendChild(cell(x(idx), Y_PAT, CW, CH, pat[q], cls, FS));
        if (CW >= 24) {
            root.appendChild(T({ x: x(idx) + (CW - 2) / 2, y: Y_PAT + CH + 12, 'text-anchor': 'middle', class: 'kmp-idx' }, 'j=' + q));
        }
    }

    // 滑动：虚线画出下一次的位置 + 箭头标出滑了几位
    if (showGhost) {
        const k = st.type === 'slide0' ? 0 : st.k;
        root.appendChild(T({
            x: PAD_L - 10, y: Y_GHOST + CH / 2 + 4, 'text-anchor': 'end', class: 'kmp-rowlab kmp-rowlab-dim',
        }, '下一次'));
        for (let q = 0; q < m; q++) {
            const idx = align2 + q;
            root.appendChild(cell(x(idx), Y_GHOST, CW, CH, pat[q], q < k ? 'kmp-c-skip' : 'kmp-c-ghost', FS));
        }
        // 滑动箭头
        const ay = Y_PAT + CH + (CW >= 24 ? 18 : 10);
        root.appendChild(svg('line', {
            x1: x(align) + 2, y1: ay, x2: x(align2) + 2, y2: ay,
            class: 'kmp-shift-arrow', 'marker-end': 'url(#kmpArrShift)',
        }));
        root.appendChild(T({
            x: (x(align) + x(align2)) / 2 + 2, y: ay - 5, 'text-anchor': 'middle', class: 'kmp-shift-lab',
        }, `右滑 ${st.shift} 位`));
        if (k > 0) {
            root.appendChild(T({
                x: x(align2) + 2, y: Y_GHOST + CH + 14, class: 'kmp-skip-lab',
            }, `这 ${k} 个已知匹配，不用再比`));
        }
    }

    return root;
}

/** 当前这一步在干什么 —— 讲人话 */
function stepNoteHtml() {
    const res = state.res, pat = state.pat;
    const st = res.steps[state.step];
    if (!st) {
        if (state.pat.length === 0) return '模式串是空的，约定「每个位置都算命中」，一次字符比较都不用做。';
        return '没有可比较的字符（主串是空的）。';
    }
    const head = `第 <b>${state.step + 1}</b> / ${res.steps.length} 次字符比较：`
        + `<code>text[${st.i}]='${E(st.tc)}'</code> 对 <code>pat[${st.j}]='${E(st.pc)}'</code> → `
        + (st.eq ? '<b class="kmp-ok">相等</b>' : '<b class="kmp-bad">失配</b>');

    if (st.type === 'go') {
        return head + `。两个指针一起往右挪一格，已经连续对上 <b>${st.j + 1}</b> 个字符。`;
    }
    if (st.type === 'match') {
        return head + `。模式串 <b>${state.pat.length}</b> 个字符全部对上 —— `
            + `<b class="kmp-ok">在主串下标 ${st.at} 命中一次！</b><br>`
            + `接着 j 退到 <code>next[${state.pat.length}] = π[${state.pat.length - 1}] = ${st.k}</code>，`
            + `模式串右滑 <b>${st.shift}</b> 位继续找。`
            + (st.k > 0
                ? `注意 j <b>没有清零</b>，前 ${st.k} 个字符（<code>${E(pat.slice(0, st.k))}</code>）留着 —— 重叠的匹配就是这么找出来的。`
                : '模式串自己没有公共前后缀，所以这次是整个滑过去。');
    }
    if (st.type === 'slide0') {
        return head + `。这是模式串的<b>第一个</b>字符就不对（j=0），手上没有任何「已匹配的前缀」可以利用，`
            + `只能老老实实整体右滑 1 位（<code>j - next[0] = 0 - (-1) = 1</code>），i 往前走一格。`;
    }
    // slide
    const matched = pat.slice(0, st.j);
    return head + `。已经匹配上的前缀是 <code>${E(matched)}</code>（长 ${st.j}）。`
        + `查表：<code>next[${st.j}] = π[${st.j - 1}] = ${st.k}</code> —— `
        + (st.k > 0
            ? `意思是 <code>${E(matched)}</code> 的<b>最长公共真前后缀</b>是 <code>${E(pat.slice(0, st.k))}</code>，长度 ${st.k}。`
                + `所以模式串直接右滑 <b>${st.j} − ${st.k} = ${st.shift}</b> 位，`
                + `滑过去以后前 <b>${st.k}</b> 个字符必然还是对的，<b>一个都不用再比</b>，下一次直接从 <code>pat[${st.k}]</code> 接着比。`
            : `<code>${E(matched)}</code> 没有任何公共真前后缀，前面这 ${st.j} 个字符白比了，模式串整体滑 <b>${st.shift}</b> 位。`)
        + `<br><b class="kmp-ok">关键：i 停在 ${st.i} 一动不动，绝不回退。</b>`
        + '暴力法这时候会把 i 拽回到 ' + (st.align + 1) + '，一切从头再来。';
}

// ---------- 指针轨迹条 ----------

function buildTrackSvg() {
    const res = state.res, nv = state.nv;
    const kt = res.iTrace, nt = nv.ptr;
    const maxSteps = Math.max(kt.length, nt.length, 1);
    const maxIdx = Math.max(state.text.length - 1, 1);

    const W = 700, H = 190, PAD_L = 58, PAD_R = 92, PAD_T = 18, PAD_B = 30;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
    const x = (t) => PAD_L + (maxSteps <= 1 ? 0 : (t / (maxSteps - 1)) * iw);
    const y = (v) => PAD_T + ih - (v / maxIdx) * ih;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'kmp-track-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '主串指针轨迹',
    });

    // 网格
    for (let g = 0; g <= 4; g++) {
        const v = (maxIdx / 4) * g;
        root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L + iw, y1: y(v), y2: y(v), class: 'kmp-grid' }));
        root.appendChild(T({ x: PAD_L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'kmp-axis' }, String(Math.round(v))));
    }
    root.appendChild(T({ x: 4, y: PAD_T - 6, class: 'kmp-axis' }, '主串下标'));
    root.appendChild(T({ x: PAD_L + iw / 2, y: H - 6, 'text-anchor': 'middle', class: 'kmp-axis' }, '第几次字符比较 →'));

    const poly = (arr, cls) => {
        if (!arr.length) return null;
        return svg('polyline', {
            points: arr.map((v, t) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
            class: cls, fill: 'none',
        });
    };

    const pn = poly(nt, 'kmp-line-naive'); if (pn) root.appendChild(pn);
    const pk = poly(kt, 'kmp-line-kmp'); if (pk) root.appendChild(pk);

    // 暴力法每一次「往回跳」都点出来
    for (let t = 1; t < nt.length; t++) {
        if (nt[t] < nt[t - 1]) {
            root.appendChild(svg('circle', { cx: x(t), cy: y(nt[t]), r: 2.6, class: 'kmp-dot-back' }));
        }
    }
    // KMP 当前所在位置
    if (state.step < kt.length) {
        root.appendChild(svg('circle', { cx: x(state.step), cy: y(kt[state.step]), r: 4.2, class: 'kmp-dot-now' }));
    }

    const backs = KMP.retreats(nt);
    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 12, class: 'kmp-lab-kmp' }, 'KMP：0 次回退'));
    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 30, class: 'kmp-lab-naive' }, `暴力：回退 ${backs} 次`));
    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 48, class: 'kmp-axis' }, `共比 ${nt.length} 次`));
    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 64, class: 'kmp-axis' }, `KMP ${kt.length} 次`));

    return root;
}

// ---------- 规模实验：增长曲线 ----------

function buildGrowthSvg() {
    const data = state.growth;
    const W = 700, H = 210, PAD_L = 62, PAD_R = 96, PAD_T = 16, PAD_B = 32;
    const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
    const maxN = data[data.length - 1].n;
    const maxY = Math.max.apply(null, data.map((d) => d.naive)) || 1;
    const x = (n) => PAD_L + (n / maxN) * iw;
    const y = (v) => PAD_T + ih - (v / maxY) * ih;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'kmp-growth-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '比较次数随规模增长',
    });

    for (let g = 0; g <= 4; g++) {
        const v = (maxY / 4) * g;
        root.appendChild(svg('line', { x1: PAD_L, x2: PAD_L + iw, y1: y(v), y2: y(v), class: 'kmp-grid' }));
        root.appendChild(T({ x: PAD_L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'kmp-axis' },
            v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v))));
    }
    root.appendChild(T({ x: 4, y: PAD_T - 4, class: 'kmp-axis' }, '字符比较次数'));
    root.appendChild(T({ x: PAD_L + iw / 2, y: H - 6, 'text-anchor': 'middle', class: 'kmp-axis' }, '主串长度 n（模式串长 = n/4）'));

    const line = (key, cls) => svg('polyline', {
        points: data.map((d) => `${x(d.n).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' '),
        class: cls, fill: 'none',
    });
    root.appendChild(line('naive', 'kmp-line-naive'));
    root.appendChild(line('kmp', 'kmp-line-kmp'));

    // 当前规模
    const cur = pickScale();
    root.appendChild(svg('line', { x1: x(cur.n), x2: x(cur.n), y1: PAD_T, y2: PAD_T + ih, class: 'kmp-now-line' }));
    root.appendChild(svg('circle', { cx: x(cur.n), cy: y(cur.naive), r: 4, class: 'kmp-dot-naive' }));
    root.appendChild(svg('circle', { cx: x(cur.n), cy: y(cur.kmp), r: 4, class: 'kmp-dot-now' }));

    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 14, class: 'kmp-lab-naive' }, '暴力 O(n·m)'));
    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 30, class: 'kmp-axis' }, `n=${cur.n} → ${cur.naive}`));
    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 54, class: 'kmp-lab-kmp' }, 'KMP O(n+m)'));
    root.appendChild(T({ x: PAD_L + iw + 8, y: PAD_T + 70, class: 'kmp-axis' }, `n=${cur.n} → ${cur.kmp}`));

    return root;
}

function pickScale() {
    const n = state.scale;
    let best = state.growth[0];
    state.growth.forEach((d) => { if (Math.abs(d.n - n) < Math.abs(best.n - n)) best = d; });
    return best;
}

// ---------- next 数组构造：模式串自己跟自己匹配 ----------

function buildPiSvg() {
    const pat = state.pat, m = pat.length;
    const row = state.trace.rows[state.bi];
    if (!row) return h('p.sec-note', { html: '模式串是空的，没有 next 数组可算。' });

    const i = row.i, k = row.k;
    const shift = i + 1 - k;                       // 自己跟自己对齐时，下面那一份右移多少格
    const span = Math.max(m, shift + m);
    const CW = cellW(span);
    const CH = Math.max(20, Math.round(CW * 0.95));
    const FS = CW >= 24 ? 13 : (CW >= 18 ? 11 : 9);
    const PAD_L = 74, PAD_R = 16, Y_A = 26, Y_B = Y_A + CH + 34;
    const W = PAD_L + span * CW + PAD_R, H = Y_B + CH + 26;
    const x = (idx) => PAD_L + idx * CW;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'kmp-pi-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'next 数组的构造',
    });

    // 上面一行：模式串本身，只点亮 p[0..i]
    root.appendChild(T({ x: PAD_L - 10, y: Y_A + CH / 2 + 4, 'text-anchor': 'end', class: 'kmp-rowlab' }, '模式串'));
    for (let q = 0; q < m; q++) {
        let cls = q > i ? 'kmp-c-ghost' : 'kmp-c-plain';
        if (q <= i && k > 0 && q < k) cls = 'kmp-c-pre';                 // 前缀
        if (q <= i && k > 0 && q > i - k) cls = 'kmp-c-suf';             // 后缀
        if (q === i) cls = 'kmp-c-cur';
        root.appendChild(cell(x(q), Y_A, CW, CH, pat[q], cls, FS));
        if (CW >= 24) root.appendChild(T({ x: x(q) + (CW - 2) / 2, y: Y_A - 5, 'text-anchor': 'middle', class: 'kmp-idx' }, String(q)));
    }
    if (k > 0) {
        root.appendChild(T({ x: x(0) + 2, y: Y_A + CH + 13, class: 'kmp-pre-lab' }, `前缀 ${pat.slice(0, k)}`));
        root.appendChild(T({ x: x(i - k + 1) + 2, y: Y_A + CH + 13, class: 'kmp-suf-lab' }, `后缀 ${pat.slice(i - k + 1, i + 1)}`));
    }

    // 下面一行：模式串自己右移 shift 位，正好前 k 个和上面的后 k 个重合
    root.appendChild(T({ x: PAD_L - 10, y: Y_B + CH / 2 + 4, 'text-anchor': 'end', class: 'kmp-rowlab kmp-rowlab-dim' }, '自己右移'));
    for (let q = 0; q < m; q++) {
        const cls = q < k ? 'kmp-c-skip' : 'kmp-c-ghost';
        root.appendChild(cell(x(shift + q), Y_B, CW, CH, pat[q], cls, FS));
    }
    root.appendChild(T({
        x: PAD_L - 10, y: Y_B + CH + 16, 'text-anchor': 'end', class: 'kmp-axis',
    }, `右移 ${shift} 位`));
    if (k > 0) {
        root.appendChild(T({ x: x(shift) + 2, y: Y_B + CH + 16, class: 'kmp-skip-lab' },
            `这 ${k} 格和上面完全重合 → π[${i}] = ${k}`));
    } else {
        root.appendChild(T({ x: x(shift) + 2, y: Y_B + CH + 16, class: 'kmp-axis' },
            `没有任何重合 → π[${i}] = 0`));
    }
    return root;
}

function piNoteHtml() {
    const row = state.trace.rows[state.bi];
    const pat = state.pat;
    if (!row) return '';
    if (row.base) {
        return `π[0] 恒等于 <b>0</b>：单个字符 <code>${E(pat[0])}</code> 的前后缀必须是「真」的（不能取整个自己），`
            + '所以只剩空串，长度 0。这是整个递推的地基。';
    }
    const parts = [];
    parts.push(`算 π[${row.i}]：先接着上一位的答案试 —— <code>k = π[${row.i - 1}] = ${row.from}</code>。`);
    row.cmps.forEach((c, idx) => {
        if (c.eq) {
            parts.push(`比 <code>pat[${row.i}]='${E(c.a)}'</code> 和 <code>pat[${c.k}]='${E(c.b)}'</code> → `
                + `<b class="kmp-ok">相等</b>，公共前后缀能接长一位：<code>π[${row.i}] = ${c.k} + 1 = ${row.k}</code>。`);
        } else if (c.k > 0) {
            parts.push(`比 <code>pat[${row.i}]='${E(c.a)}'</code> 和 <code>pat[${c.k}]='${E(c.b)}'</code> → `
                + `<b class="kmp-bad">不等</b>，长度 ${c.k} 接不上，`
                + `退到<b>更短的那个</b>公共前后缀：<code>k = π[${c.k - 1}] = ${state.trace.pi[c.k - 1]}</code>`
                + `${idx === 0 ? '（这一步就是「自己跟自己用 KMP」）' : ''}。`);
        } else {
            parts.push(`比 <code>pat[${row.i}]='${E(c.a)}'</code> 和 <code>pat[0]='${E(c.b)}'</code> → `
                + `<b class="kmp-bad">不等</b>，且已经退无可退（k=0），所以 <code>π[${row.i}] = 0</code>。`);
        }
    });
    if (row.k > 0) {
        parts.push(`结论：<code>${E(pat.slice(0, row.i + 1))}</code> 的最长公共真前后缀是 `
            + `<code>${E(row.border)}</code>，长度 <b>${row.k}</b>。`);
    }
    return parts.join('<br>');
}

// ---------- 渲染 ----------

let rootEl = null;

function paintStep() {
    const d = state.dom;
    if (!d.mainBox) return;
    d.mainBox.innerHTML = '';
    d.mainBox.appendChild(buildMainSvg());
    d.note.innerHTML = stepNoteHtml();
    const K = state.res.steps.length;
    d.prog.textContent = K ? `${state.step + 1} / ${K}` : '0 / 0';
    if (d.scrub) d.scrub.value = String(state.step);
    if (d.trackBox) { d.trackBox.innerHTML = ''; d.trackBox.appendChild(buildTrackSvg()); }
    if (d.playBtn) {
        d.playBtn.innerHTML = state.playing
            ? '<i class="fas fa-pause"></i> 暂停'
            : '<i class="fas fa-play"></i> 自动走';
    }
}

function paintBuild() {
    const d = state.dom;
    if (!d.piBox) return;
    d.piBox.innerHTML = '';
    d.piBox.appendChild(buildPiSvg());
    d.piNote.innerHTML = piNoteHtml();
    if (d.piChips) {
        [].forEach.call(d.piChips.children, (el, idx) => {
            el.className = 'kmp-chip' + (idx === state.bi ? ' on' : '');
        });
    }
    if (d.piTable) {
        [].forEach.call(d.piTable.querySelectorAll('tr[data-i]'), (tr) => {
            tr.classList.toggle('on', Number(tr.getAttribute('data-i')) === state.bi);
        });
    }
}

function paintScale() {
    const d = state.dom;
    const cur = pickScale();
    if (d.growthBox) { d.growthBox.innerHTML = ''; d.growthBox.appendChild(buildGrowthSvg()); }
    if (d.scaleCmp) {
        d.scaleCmp.innerHTML = '';
        d.scaleCmp.appendChild(Viz.cmpGrid([
            { h: `暴力（n=${cur.n}, m=${cur.m}）`, v: String(cur.naive), d: '次字符比较', cls: 'cmp-bad' },
            { h: `KMP（n=${cur.n}, m=${cur.m}）`, v: String(cur.kmp), d: '次字符比较', cls: 'cmp-ok' },
            { h: '差距', v: (cur.naive / cur.kmp).toFixed(1) + '×', d: 'n 越大差得越离谱', cls: 'cmp-save' },
        ]));
    }
}

function stepTo(v) {
    const K = state.res.steps.length;
    state.step = Math.max(0, Math.min(K - 1, v));
    paintStep();
}

function stopPlay() {
    state.playing = false;
    if (state.tk) state.tk.stop();
}

function togglePlay() {
    if (state.playing) { stopPlay(); paintStep(); return; }
    const K = state.res.steps.length;
    if (!K) return;
    if (state.step >= K - 1) state.step = 0;
    state.playing = true;
    state.acc = 0;
    if (!state.tk) {
        state.tk = Viz.ticker((dt) => {
            state.acc += dt;
            if (state.acc < 520) return true;
            state.acc = 0;
            if (state.step >= state.res.steps.length - 1) { state.playing = false; paintStep(); return false; }
            state.step++;
            paintStep();
            return true;
        });
    }
    state.tk.start();
    paintStep();
}

function applyInputs(t, p) {
    stopPlay();
    state.text = t.slice(0, 60);
    state.pat = p.slice(0, 24);
    state.step = 0;
    state.bi = Math.min(1, Math.max(0, state.pat.length - 1));
    render();
}

function render() {
    if (!rootEl) return;
    stopPlay();
    recompute();
    rootEl.innerHTML = '';
    state.dom = {};

    rootEl.appendChild(buildSceneCard());
    rootEl.appendChild(buildMainCard());
    rootEl.appendChild(buildTrackCard());
    rootEl.appendChild(buildCounterCard());
    rootEl.appendChild(buildPiCard());
    rootEl.appendChild(buildDefCard());
    rootEl.appendChild(buildQaCard());
    rootEl.appendChild(buildPitCard());
    rootEl.appendChild(buildFootCard());

    paintStep();
    paintBuild();
    paintScale();
}

function buildSceneCard() {
    const tIn = h('input.kmp-input.kmp-input-wide', { type: 'text', value: state.text, spellcheck: 'false' });
    const pIn = h('input.kmp-input', { type: 'text', value: state.pat, spellcheck: 'false' });
    const apply = () => applyInputs(tIn.value.trim(), pIn.value.trim());
    [tIn, pIn].forEach((el) => {
        el.addEventListener('change', apply);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    });

    const presets = h('div.segmented');
    PRESETS.forEach((p) => {
        presets.appendChild(h('button.seg' + (p.text === state.text && p.pat === state.pat ? '.on' : ''), {
            title: p.tip, onclick: () => applyInputs(p.text, p.pat),
        }, p.name));
    });

    const res = state.res;
    const hits = res.matches.length
        ? `找到 <b>${res.matches.length}</b> 处匹配，位置：<b>${res.matches.slice(0, 12).join(', ')}</b>`
            + (res.matches.length > 12 ? ' …' : '')
        : '一处都没匹配上';

    return Viz.card('fa-magnifying-glass', '在主串里找模式串',
        '两个串都能改（回车生效）。下面每一步都跟着你输入的串重新算，'
        + '<b>没有随机数，刷新前后结果完全一样</b>。',
        h('div.kmp-inputs', null,
            h('label.kmp-field', null, h('span', { text: '主串 text' }), tIn),
            h('label.kmp-field', null, h('span', { text: '模式串 pat' }), pIn)),
        presets,
        h('div.seq-note', {
            html: `主串长 ${state.text.length}，模式串长 ${state.pat.length}。${hits}。`
                + `<br>π 数组（前缀函数）：<code>[${res.pi.join(', ')}]</code>`
                + `　带 -1 的 next：<code>[${res.nxt.join(', ')}]</code>`,
        })
    );
}

function buildMainCard() {
    const K = state.res.steps.length;
    const box = h('div.kmp-main-box');
    const note = h('div.seq-note');
    const prog = h('span.seq-progress');
    state.dom.mainBox = box;
    state.dom.note = note;
    state.dom.prog = prog;

    const scrub = h('input.kmp-scrub', {
        type: 'range', min: '0', max: String(Math.max(0, K - 1)), step: '1', value: String(state.step),
        oninput: (e) => { stopPlay(); stepTo(Number(e.target.value)); },
    });
    state.dom.scrub = scrub;

    const playBtn = h('button.mini', { onclick: togglePlay }, '自动走');
    state.dom.playBtn = playBtn;

    const nav = h('div.seq-nav', null,
        h('button.mini', { onclick: () => { stopPlay(); stepTo(0); } }, h('i.fas.fa-backward-fast'), ' 重置'),
        h('button.mini', { onclick: () => { stopPlay(); stepTo(state.step - 1); } }, h('i.fas.fa-chevron-left'), ' 上一步'),
        h('button.mini.primary', { onclick: () => { stopPlay(); stepTo(state.step + 1); } }, '下一步 ', h('i.fas.fa-chevron-right')),
        prog,
        playBtn,
        h('button.mini', { onclick: () => { stopPlay(); stepTo(K - 1); } }, '跳到最后'),
        scrub
    );

    return Viz.card('fa-shoe-prints', '一步一步走：失配了就查表往右滑',
        '每按一次「下一步」= <b>一次字符比较</b>。'
        + '<span class="k kmp-k-ok"></span>绿=这一格对上了　'
        + '<span class="k kmp-k-bad"></span>红=失配　'
        + '<span class="k kmp-k-kept"></span>浅绿=已经确认匹配的前缀　'
        + '<span class="k kmp-k-skip"></span>蓝=滑过去以后<b>不用再比</b>的部分',
        box, nav, note);
}

function buildTrackCard() {
    const box = h('div.kmp-track-box');
    state.dom.trackBox = box;
    const backs = KMP.retreats(state.nv.ptr);
    return Viz.card('fa-arrow-right-long', '主串指针的轨迹：KMP 这条线只升不降',
        '横轴是「第几次字符比较」，纵轴是「这次比较落在主串的哪一格」。'
        + '<b class="kmp-bad">橙线是暴力法</b>：一失配就把指针拽回去重来，'
        + `这个例子里它往回跳了 <b>${backs}</b> 次。`
        + '<b class="kmp-ok">紫线是 KMP</b>：从左下角一路走到右上角，<b>一次也没有往下掉</b>。'
        + '这就是 KMP 唯一的、也是全部的价值。',
        box,
        h('div.seq-note', {
            html: '为什么「不回退」这么重要？因为主串<b>可以是一条流</b>（网络包、日志、文件流）。'
                + 'i 不回退意味着读过的字符可以直接扔掉，<b>不需要任何回溯缓冲区</b>，'
                + '这才是 KMP 在工程上真正不可替代的地方 —— 比省下的那点比较次数值钱多了。',
        })
    );
}

function buildCounterCard() {
    const res = state.res, nv = state.nv;
    const saved = nv.comparisons > 0 ? Math.round((1 - res.comparisons / nv.comparisons) * 100) : 0;

    const scaleCmp = h('div.kmp-scale-cmp');
    const growthBox = h('div.kmp-growth-box');
    state.dom.scaleCmp = scaleCmp;
    state.dom.growthBox = growthBox;

    const slider = Viz.slider({
        label: '规模 n', min: 8, max: 240, step: 8, value: state.scale,
        fmt: (v) => `主串 ${v} 字符`,
        onInput: (v) => { state.scale = v; paintScale(); },
    });

    return Viz.card('fa-stopwatch', '打脸时刻：字符比较次数，暴力 vs KMP',
        `当前这两个串（主串 ${state.text.length}，模式串 ${state.pat.length}）实际比了多少次 —— `
        + '口径是「执行了几次字符 <code>===</code>」，失败的那次也算。',
        Viz.cmpGrid([
            { h: '暴力匹配', v: String(nv.comparisons), d: '次字符比较', cls: 'cmp-bad' },
            { h: 'KMP', v: String(res.comparisons), d: `次字符比较（上限 2n = ${2 * state.text.length}）`, cls: 'cmp-ok' },
            { h: '省掉', v: saved + '%', d: saved <= 5 ? '几乎没省 —— 见下面说明' : '的比较次数', cls: 'cmp-save' },
        ]),
        h('p.sec-note', {
            html: saved <= 5
                ? '<b>看，差不多。</b>随便挑个串，KMP 并不会比暴力法快多少 —— 因为普通串一失配就走人，'
                    + '暴力法根本没机会退化。点上面的「最坏用例（打脸）」按钮，或者拖下面的规模滑块，才看得到真正的差距。'
                : '差距已经出来了。想看更夸张的，拖下面的规模滑块。',
        }),
        h('h4.kmp-sub', { text: '把规模拉大：差距怎么从「差不多」变成「差一个量级」' }),
        h('p.sec-note', {
            html: `固定用最坏用例：主串 <code>AAA…AB</code>，模式串 <code>AAA…AB</code>（长度取主串的 1/4）。`
                + '暴力法每一次对齐都要一路比到最后一个字符才发现不对，白干 m−1 次；KMP 靠 next 一次都不重比。',
        }),
        h('div.controls', null, slider),
        scaleCmp,
        growthBox,
        h('div.seq-note', {
            html: '纵轴是<b>线性刻度</b>，不是对数 —— KMP 那条紫线几乎贴着横轴，'
                + '不是因为画错了，是因为 O(n+m) 和 O(n·m) 本来就不在一个世界。'
                + '把滑块拖到最左边（n=8）看：两条线基本重合，<b>小规模上 KMP 一点都不快</b>。',
        })
    );
}

function buildPiCard() {
    const m = state.pat.length;
    const piBox = h('div.kmp-pi-box');
    const piNote = h('div.seq-note');
    state.dom.piBox = piBox;
    state.dom.piNote = piNote;

    const chips = h('div.kmp-chips');
    for (let idx = 0; idx < m; idx++) {
        chips.appendChild(h('button.kmp-chip', {
            onclick: () => { state.bi = idx; paintBuild(); },
        }, `π[${idx}]`));
    }
    state.dom.piChips = chips;

    const nav = h('div.seq-nav', null,
        h('button.mini', { onclick: () => { state.bi = Math.max(0, state.bi - 1); paintBuild(); } },
            h('i.fas.fa-chevron-left'), ' 上一位'),
        h('button.mini.primary', { onclick: () => { state.bi = Math.min(m - 1, state.bi + 1); paintBuild(); } },
            '下一位 ', h('i.fas.fa-chevron-right'))
    );

    // 表格：每一位的结果一览
    const wrap = h('div.mv-matrix-wrap');
    const tb = h('table.mv-matrix');
    const head = h('tr', null,
        h('th', { text: 'i' }), h('th', { text: 'pat[i]' }), h('th', { text: '前缀 pat[0..i]' }),
        h('th', { text: 'π[i]' }), h('th', { text: '最长公共真前后缀' }), h('th', { text: 'next[i]（带 -1）' }));
    tb.appendChild(head);
    state.trace.rows.forEach((r) => {
        const tr = h('tr', { 'data-i': String(r.i), onclick: () => { state.bi = r.i; paintBuild(); } },
            h('td', { text: String(r.i) }),
            h('td', { html: `<code>${E(r.ch)}</code>` }),
            h('td', { html: `<code>${E(state.pat.slice(0, r.i + 1))}</code>` }),
            h('td', { html: `<b>${r.k}</b>` }),
            h('td', { html: r.k ? `<code>${E(r.border)}</code>` : '<span class="kmp-none">（无）</span>' }),
            h('td', { text: String(state.res.nxt[r.i]) })
        );
        tb.appendChild(tr);
    });
    wrap.appendChild(tb);
    state.dom.piTable = tb;

    return Viz.card('fa-diagram-project', 'next 数组是怎么算出来的：模式串自己跟自己匹配',
        'KMP 最难懂的一半在这里。要求的东西只有一个：'
        + '<b>对每个前缀 pat[0..i]，它的「最长公共真前后缀」有多长</b>（真 = 不能整个自己算）。'
        + '而算这个东西用的<b>还是 KMP 本身</b> —— 接不上就退到更短的那个公共前后缀继续试，这是整个算法最绕的一步。',
        piBox, nav, chips, piNote, wrap,
        h('div.seq-note', {
            html: '为什么「接不上就退到 π[k-1]」是对的？因为如果长度 k 的那个公共前后缀接不下去，'
                + '次长的候选<b>只可能</b>是「k 这个前缀自己的公共前后缀」—— 它同时还是原串的前后缀。'
                + '所以候选按 <code>k → π[k-1] → π[π[k-1]-1] → …</code> 一路缩短，'
                + '这条链叫 <b>失配链（border chain）</b>，长度之和是均摊 O(m) 的。',
        })
    );
}

function buildDefCard() {
    const wrap = h('div.mv-matrix-wrap');
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null,
        h('th', { text: '口径' }), h('th', { text: '定义' }), h('th', { text: '本例的值' }), h('th', { text: '失配时怎么用' })));
    const rows = [
        ['π 数组（前缀函数）', 'π[i] = pat[0..i] 的最长公共真前后缀长度，长度 m',
            `[${state.res.pi.join(', ')}]`, 'j = π[j−1]'],
        ['next 数组（带 -1）', 'next[0] = −1，next[j] = π[j−1]，长度 m+1',
            `[${state.res.nxt.join(', ')}]`, 'j = next[j]，右滑 j − next[j]'],
    ];
    rows.forEach((r) => {
        tb.appendChild(h('tr', null,
            h('td', { html: `<b>${r[0]}</b>` }),
            h('td', { text: r[1] }),
            h('td', { html: `<code>${E(r[2])}</code>` }),
            h('td', { html: `<code>${E(r[3])}</code>` })));
    });
    wrap.appendChild(tb);

    return Viz.card('fa-code-branch', '两种「next 数组」，别跟别的资料对不上',
        '这是初学 KMP 最容易崩溃的地方：翻三本书能看到三种下标。其实只有两种，而且可以互相换算。',
        wrap,
        h('div.seq-note', {
            html: '<b>换算关系：</b><code>next[j] = π[j−1]</code>，反过来 <code>π[i] = next[i+1]</code>。'
                + '本演示<b>内部一律用 π</b>，界面上凡是写「右滑 j − next[j]」的地方用的是带 −1 的那份。'
                + '<br>还有第三种写法叫 <b>nextval / 优化版 next</b>：如果 <code>pat[j] == pat[next[j]]</code>，'
                + '滑过去必然还是同一个字符、注定再失配一次，于是直接令 <code>next[j] = next[next[j]]</code> 把这次白比省掉。'
                + '国内教材（严蔚敏）特别爱考这个，但它<b>只影响常数</b>，不改变 O(n+m)。本演示用的是<b>未优化</b>的版本，'
                + '这样每一步的含义更直白。',
        })
    );
}

function buildQaCard() {
    return Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        { q: '一句话说清 KMP 在干什么？',
            a: '失配的时候，暴力法把主串指针 i 拽回去从头再来；KMP 说「<b>不用</b>，刚才已经匹配上的那段前缀我认识它，'
                + '它的最长公共真前后缀有多长我提前算好了（next 数组），直接把模式串往右滑 <code>j − next[j]</code> 位，'
                + '滑完前 next[j] 个字符必然还是对的，<b>i 一格都不用退</b>」。'
                + '所以 KMP = <b>预处理模式串</b> + <b>主串只扫一遍</b>。' },
        { q: '为什么时间复杂度是 O(n+m)？请给出证明思路。',
            a: '看每一次循环：要么 i 前进 1（匹配成功，或 j=0 时失配），要么 j 变小（失配回退，i 不动）。'
                + 'i 最多前进 n 次；j 每次最多 +1（只在 i 前进时），所以 j 的总增量 ≤ n，总减量也 ≤ n。'
                + '两类循环加起来 ≤ 2n 次比较 —— 这就是<b>均摊分析</b>。构造 next 同理是 O(m)。'
                + '注意上界是 <b>2n 不是 n</b>：失配回退时同一个主串字符会被重新比一次。' },
        { q: 'KMP 一定比 indexOf 快吗？',
            a: '<b>大概率更慢。</b>V8 的 <code>indexOf</code> 短模式串走朴素/memchr（有 SIMD 加速），长的走 Two-Way 算法。'
                + '真实文本里失配来得很快，暴力法几乎不会退化，而它<b>没有额外内存访问、缓存极其友好</b>；'
                + 'KMP 每次失配都要随机访问一次 next 数组，反而更慢。同理 Boyer-Moore 靠「跳着比」在长模式串上通常吊打 KMP。'
                + '<b>KMP 的价值是最坏情况有保证（永不退化成 O(n·m)），以及流式匹配不需要回溯缓冲区</b>，不是平均更快。' },
        { q: 'next 数组和 AC 自动机是什么关系？',
            a: 'next 就是 AC 自动机 <b>fail 指针的单串版本</b>。'
                + 'KMP 可以看成「把模式串建成一条链状的自动机，next[j] 指出失配后该跳到哪个状态」；'
                + '多模式串时把所有串塞进一棵 Trie，每个节点的 fail 指针 = 「当前已匹配后缀的最长的、也是某个模式串前缀的那一段」，'
                + '构造方式（BFS + 沿 fail 链回退）和 next 的递推一模一样。<b>先把 KMP 的 next 想通，AC 自动机就只剩工程量了。</b>' },
        { q: '除了找子串，next 数组还能干什么？',
            a: '① <b>求最小循环节</b>：若 <code>m % (m − π[m−1]) == 0</code>，则 <code>m − π[m−1]</code> 就是最小循环节长度'
                + '（本例模式串 <code>ABCABD</code> 类的题目常考）。'
                + '② <b>求一个串的所有 border</b>：沿 <code>π[m−1] → π[π[m−1]−1] → …</code> 这条失配链走一遍。'
                + '③ <b>判回文/最短扩展</b>：把串和它的反串拼起来跑 π。'
                + '④ 统计每个前缀出现次数（逆序累加 π）。面试里 next 的应用题比 KMP 本体考得还多。' },
    ]));
}

function buildPitCard() {
    return Viz.card('fa-triangle-exclamation', '必须知道的坑', null, Viz.pitfalls([
        ['「i 不回退」≠「每个字符只比一次」',
            '失配回退时 i 是不动，但<b>同一个主串字符会被重新比一次</b>（拿它去比模式串更靠前的那个字符）。'
                + '所以比较次数的上界是 <b>2n</b> 而不是 n。上面的轨迹图里，紫线出现「水平段」就是这种情况 —— '
                + '横坐标（比较次数）往前走了，纵坐标（i）没动。'],
        ['两种 next 定义混着用，下标一定错',
            '<code>π[i]</code> 的长度是 m，<code>next[j]</code> 的长度是 m+1、第 0 位是 −1。'
                + '照着 A 资料写递推、照着 B 资料写主循环，必然差一位。'
                + '<b>先确定用哪一种，全程只用那一种</b>，另一种当换算公式记：<code>next[j] = π[j−1]</code>。'],
        ['找重叠匹配时，命中后 j 千万别清零',
            '找到一次匹配后应该 <code>j = π[m−1]</code>，不是 <code>j = 0</code>。'
                + '清零的话在 <code>AAAAA</code> 里找 <code>AAA</code> 只能找到 1 个（应该是 0/1/2 三个）。'
                + '点上面的「重叠匹配」预设按钮就能看到。（反过来，如果业务上要的是<b>不重叠</b>计数，那才该清零 —— 先想清楚要哪种。）'],
        ['真实项目里别手写 KMP',
            '需要找子串就用 <code>indexOf</code> / <code>strstr</code> / <code>str.find</code>：标准库实现（Two-Way、SIMD memchr）'
                + '在真实数据上通常比手写 KMP 快，而且没 bug。'
                + '手写 KMP 的正当理由只有三个：<b>面试</b>、<b>流式/分块输入没法回退</b>、'
                + '<b>对抗恶意构造的最坏输入</b>（比如用户可控的模式串，要防 ReDoS 式的退化）。'],
        ['多模式串别用 KMP 串行跑',
            '要在一段文本里同时找几百个关键词（敏感词过滤、日志告警），'
                + '拿 KMP 对每个词跑一遍是 O(n × 词数)。这时候该上 <b>AC 自动机</b>（Trie + fail 指针），一遍扫完，'
                + 'O(n + 总模式长度 + 命中数)。next 数组就是它的雏形。'],
    ]));
}

function buildFootCard() {
    return h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示（口径与简化）' }),
        h('p', {
            html: '<b>① 计数口径</b>：所谓「一次字符比较」= 代码里执行了一次 <code>text[i] === pat[j]</code>，'
                + '<b>失败的那次也算</b>。两种算法用的是同一把尺子（都只数这一处比较），所以可以直接对照。'
                + '构造 next 数组本身的比较次数<b>没有</b>计入 KMP 那一栏 —— 它是 O(m) 的一次性预处理，'
                + '如果计入，短主串上 KMP 会更难看。',
        }),
        h('p', {
            html: '<b>② next 口径</b>：内部一律用<b>前缀函数 π</b>（π[0]=0，长度 m），'
                + '展示「右滑 j − next[j]」时用的是<b>带 −1 的 next</b>（长度 m+1，next[0]=−1，next[j]=π[j−1]）。'
                + '两者可互相换算，见上面那张对照表。<b>没有</b>做 nextval 优化。',
        }),
        h('p', {
            html: '<b>③ 空模式串</b>：约定「每个位置都算命中」（和 <code>"abc".indexOf("") === 0</code> 一致），'
                + '不做一次字符比较。模式串比主串长时结果为空。',
        }),
        h('p', {
            html: '<b>④ 这里比的是「字符比较次数」，不是墙上时间</b>。真实性能还取决于缓存命中、分支预测、SIMD，'
                + '所以图上 KMP 赢 20 倍，不代表实测就快 20 倍 —— 反过来，在普通文本上实测 <code>indexOf</code> 更快才是常态。'
                + '这个演示要说明的是<b>最坏情况的复杂度差异</b>，以及<b>指针不回退</b>这件事本身。',
        }),
        h('p', {
            html: '<b>⑤ 无随机</b>：所有数据都由输入串确定性推导，规模实验用固定构造的 <code>AAA…AB</code>，'
                + '刷新前后完全一致，便于和单测对拍。',
        })
    );
}

Viz.register({
    id: 'kmp',
    cat: 'algo',
    title: 'KMP 字符串匹配',
    subtitle: 'next 数组 · 主串指针不回退',
    icon: 'fa-magnifying-glass',
    blurb: '失配了该往右滑几位？以及为什么主串指针一次都不用回退',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.text = DEF_TEXT;
        state.pat = DEF_PAT;
        state.step = 0;
        state.bi = 1;
        state.scale = 96;
        render();
    },
    unmount() {
        stopPlay();
        state.tk = null;
        state.dom = {};
        rootEl = null;
    },
});

})();
