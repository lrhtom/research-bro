// ============================================================
//  演示：HTTP 缓存
//  浏览器手里有一份旧副本时，到底发不发请求、发了以后拿回什么，
//  全靠 Cache-Control / ETag / Last-Modified 这几个头决定。
//  这里把决策树一步步走出来，并当场戳破两个最常见的误解：
//  ① no-cache 不是「不缓存」；② Last-Modified 只有秒级精度，会漏判。
//  上半 HC.* 是纯函数（不碰 DOM，可单独测），下半是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const HC = {};

// 假设被请求的是一个 12 KB 左右的 JS 文件
HC.BODY = 12480;
HC.HDR_REQ = 380;    // 一次请求头大约多少字节（含 Cookie / UA）
HC.HDR_RES = 260;    // 200 响应的响应头
HC.HDR_304 = 190;    // 304 响应的响应头（没有 Content-Type / Content-Length，更短）

// 固定的基准时刻，保证任何机器上跑出来的日期字符串完全一样
HC.EPOCH = Date.UTC(2026, 7, 1, 10, 0, 0);

/** 把「相对基准的毫秒」格式化成 HTTP 日期。注意：只到秒，毫秒被截断 —— 这正是后面那个坑的根源 */
HC.gmt = function (ms) {
    return new Date(HC.EPOCH + Math.floor(ms / 1000) * 1000).toUTCString();
};

/** 解析 Cache-Control 指令串，返回结构化的指令表 */
HC.parseCC = function (cc) {
    const d = {
        raw: String(cc || ''), maxAge: null, noCache: false, noStore: false,
        mustRevalidate: false, isPrivate: false, isPublic: false, immutable: false,
    };
    d.raw.split(',').forEach((s) => {
        const t = s.trim().toLowerCase();
        if (!t) return;
        if (t === 'no-cache') d.noCache = true;
        else if (t === 'no-store') d.noStore = true;
        else if (t === 'must-revalidate') d.mustRevalidate = true;
        else if (t === 'private') d.isPrivate = true;
        else if (t === 'public') d.isPublic = true;
        else if (t === 'immutable') d.immutable = true;
        else if (t.indexOf('max-age=') === 0) d.maxAge = Number(t.slice(8));
    });
    return d;
};

/**
 * 服务器端的条件请求判定。
 * server = { etag, mtimeMs }
 * cond   = { ifNoneMatch: string|null, ifModifiedSince: number|null（秒） }
 *
 * RFC 9110 §13.2.2 规定得很清楚：只要请求里带了 If-None-Match，
 * 服务器就**必须**优先用它判断，并且忽略 If-Modified-Since。
 * 这不是「谁更准」的经验之谈，是标准写死的优先级。
 */
HC.validate = function (server, cond) {
    if (cond.ifNoneMatch != null) {
        const same = cond.ifNoneMatch === server.etag;
        return {
            status: same ? 304 : 200, by: 'etag', same,
            why: same
                ? 'If-None-Match ' + cond.ifNoneMatch + ' 和当前 ETag 一模一样 → 内容没变'
                : 'ETag 从 ' + cond.ifNoneMatch + ' 变成了 ' + server.etag + ' → 内容变了',
        };
    }
    if (cond.ifModifiedSince != null) {
        // 服务器把自己文件的 mtime 也截断到秒再比 —— 精度就是在这一步丢的
        const mtimeSec = Math.floor(server.mtimeMs / 1000);
        const same = mtimeSec <= cond.ifModifiedSince;
        return {
            status: same ? 304 : 200, by: 'lastmod', same,
            why: same
                ? '文件 mtime 取整到秒是 ' + mtimeSec + 's，不晚于 If-Modified-Since 的 '
                  + cond.ifModifiedSince + 's → 服务器认为「没变」'
                : '文件 mtime 取整到秒是 ' + mtimeSec + 's，晚于 If-Modified-Since 的 '
                  + cond.ifModifiedSince + 's → 确实变了',
        };
    }
    return { status: 200, by: 'none', same: false, why: '请求里没带任何校验器，服务器只能整份返回' };
};

/**
 * 走一次完整的缓存决策。
 * cache : null，或 { storedAt(秒), cc(已解析), etag, lastModifiedSec, bytes, version }
 * server: { url, etag, mtimeMs, bytes, cc(原始串), version }
 * now   : 当前时刻（秒，可带小数）
 * opt   : { validator: 'both'|'etag'|'lastmod' } —— 客户端手里有哪些校验器可用
 *
 * 返回 {
 *   outcome: 'full-200' | 'no-request' | 'revalidate-304' | 'revalidate-200',
 *   status, statusText, netBytes, bodyBytes,
 *   path: [节点 id...]  —— 决策树上走过的路径，界面用它高亮
 *   steps: [{ q, a, kind }]，reqHeaders, resHeaders, newCache, clientVersion, why
 * }
 */
HC.request = function (cache, server, now, opt) {
    opt = opt || {};
    const validator = opt.validator || 'both';
    const steps = [];
    const path = ['start'];
    const reqHeaders = [
        { k: '', v: 'GET ' + (server.url || '/app.js') + ' HTTP/1.1' },
        { k: 'Host', v: 'cdn.example.com' },
    ];
    const scc = HC.parseCC(server.cc);

    // 整份下载（200 带 body）
    function full(why, revalidated) {
        const resHeaders = [
            { k: '', v: 'HTTP/1.1 200 OK' },
            { k: 'Content-Type', v: 'application/javascript' },
            { k: 'Content-Length', v: String(server.bytes) },
            { k: 'Cache-Control', v: server.cc },
            { k: 'ETag', v: server.etag },
            { k: 'Last-Modified', v: HC.gmt(server.mtimeMs) },
        ];
        return {
            outcome: revalidated ? 'revalidate-200' : 'full-200',
            status: 200, statusText: '200 OK',
            netBytes: HC.HDR_REQ + HC.HDR_RES + server.bytes,
            bodyBytes: server.bytes,
            path, steps, reqHeaders, resHeaders, why,
            clientVersion: server.version,
            newCache: scc.noStore ? null : {
                storedAt: now, cc: scc, etag: server.etag,
                lastModifiedSec: Math.floor(server.mtimeMs / 1000),
                bytes: server.bytes, version: server.version,
            },
        };
    }

    // ── 决策 1：本地到底有没有这份副本 ────────────────────
    if (!cache) {
        steps.push({ q: '本地有这个 URL 的缓存副本吗？', a: '没有（第一次请求，或者上次响应带了 no-store）', kind: 'miss' });
        path.push('d1', 'o1');
        return full('本地空空如也，只能整份下载', false);
    }
    steps.push({ q: '本地有这个 URL 的缓存副本吗？', a: '有，是 ' + cache.version + ' 那一份', kind: 'ok' });
    path.push('d1', 'd2');

    // ── 决策 2：强缓存还新不新鲜 ──────────────────────────
    const age = Math.max(0, now - cache.storedAt);
    if (cache.cc.noCache) {
        steps.push({
            q: '强缓存能直接用吗？（看 Cache-Control: max-age / Expires）',
            a: '响应当初带了 no-cache —— 它的意思是「存可以存，但每次用之前必须去问一遍」，所以强缓存这条路直接跳过',
            kind: 'warn',
        });
    } else if (cache.cc.maxAge == null) {
        steps.push({
            q: '强缓存能直接用吗？',
            a: '既没有 max-age 也没有 Expires，浏览器算不出新鲜期（可能走启发式缓存）→ 保守起见去校验',
            kind: 'warn',
        });
    } else if (age < cache.cc.maxAge) {
        steps.push({
            q: '强缓存还新鲜吗？age = ' + fmtSec(age) + '，max-age = ' + fmtSec(cache.cc.maxAge),
            a: '还没到期 → 直接拿本地副本用，网络上一个字节都不发',
            kind: 'ok',
        });
        path.push('o2');
        return {
            outcome: 'no-request', status: 200, statusText: '200 (from disk cache)',
            netBytes: 0, bodyBytes: 0, path, steps,
            reqHeaders: [{ k: '', v: '（没有请求。浏览器根本没碰网络）' }],
            resHeaders: [{ k: '', v: '（没有响应。直接从磁盘/内存里读出来的）' }],
            why: '强缓存命中，DevTools 里显示 200 但是灰色的 (from disk cache)，Size 一栏不是字节数',
            clientVersion: cache.version, newCache: cache,
        };
    } else {
        steps.push({
            q: '强缓存还新鲜吗？age = ' + fmtSec(age) + '，max-age = ' + fmtSec(cache.cc.maxAge),
            a: '已经过期了 → 副本先留着别扔，去问服务器它还能不能用',
            kind: 'warn',
        });
    }
    path.push('d3');

    // ── 决策 3：带条件请求去问服务器 ──────────────────────
    const cond = { ifNoneMatch: null, ifModifiedSince: null };
    if ((validator === 'both' || validator === 'etag') && cache.etag) {
        cond.ifNoneMatch = cache.etag;
        reqHeaders.push({ k: 'If-None-Match', v: cache.etag });
    }
    if ((validator === 'both' || validator === 'lastmod') && cache.lastModifiedSec != null) {
        cond.ifModifiedSince = cache.lastModifiedSec;
        reqHeaders.push({ k: 'If-Modified-Since', v: HC.gmt(cache.lastModifiedSec * 1000) });
    }

    const v = HC.validate(server, cond);
    steps.push({
        q: '带上校验器去问服务器：这份还能用吗？',
        a: (v.by === 'etag' ? '服务器按 ETag 判断：' : v.by === 'lastmod' ? '服务器按 Last-Modified 判断：' : '') + v.why,
        kind: v.status === 304 ? 'ok' : 'warn',
    });

    if (v.status === 304) {
        path.push('o3');
        return {
            outcome: 'revalidate-304', status: 304, statusText: '304 Not Modified',
            netBytes: HC.HDR_REQ + HC.HDR_304, bodyBytes: 0,
            path, steps, reqHeaders,
            resHeaders: [
                { k: '', v: 'HTTP/1.1 304 Not Modified' },
                { k: 'Cache-Control', v: server.cc },
                { k: 'ETag', v: server.etag },
                { k: 'Last-Modified', v: HC.gmt(server.mtimeMs) },
                { k: '', v: '（没有 body。整个响应就这几行）' },
            ],
            why: '协商缓存命中：请求发了，但服务器只回了一句「你手上那份还行」，body 一个字节没传',
            clientVersion: cache.version,
            newCache: {
                // 304 会刷新新鲜度：相当于把这份副本的「出生时间」重置到现在
                storedAt: now, cc: HC.parseCC(server.cc), etag: server.etag,
                lastModifiedSec: Math.floor(server.mtimeMs / 1000),
                bytes: cache.bytes, version: cache.version,
            },
            validateBy: v.by, validateOk: true,
        };
    }
    path.push('o4');
    const r = full(v.why, true);
    r.validateBy = v.by;
    r.validateOk = false;
    return r;
};

function fmtSec(s) {
    if (s < 60) return (Math.round(s * 10) / 10) + 's';
    if (s < 3600) return (Math.round(s / 60 * 10) / 10) + ' 分';
    return (Math.round(s / 360) / 10) + ' 小时';
}
HC.fmtSec = fmtSec;

/**
 * 同一个策略连发 n 次请求（服务器内容始终不变），统计到底发了几次网络请求、总共传了多少字节。
 * 这是「no-cache ≠ 不缓存」那一栏对比的数据来源。
 */
HC.runSeries = function (ccString, times, opt) {
    const server = {
        url: '/app.js', etag: '"v1"', mtimeMs: 0,
        bytes: HC.BODY, cc: ccString, version: 'v1',
    };
    let cache = null;
    const rows = [];
    let totalBytes = 0, netRequests = 0, bodyTransfers = 0;
    times.forEach((t, i) => {
        const r = HC.request(cache, server, t, opt);
        cache = r.newCache;
        totalBytes += r.netBytes;
        if (r.outcome !== 'no-request') netRequests++;
        if (r.bodyBytes > 0) bodyTransfers++;
        rows.push({
            n: i + 1, at: t, outcome: r.outcome, status: r.statusText,
            netBytes: r.netBytes, bodyBytes: r.bodyBytes, why: r.why,
        });
    });
    return { cc: ccString, rows, totalBytes, netRequests, bodyTransfers };
};

/**
 * 「一秒内改两次」的陷阱。
 * editMs   : 首次请求后多久服务端改了内容（毫秒）
 * recheckMs: 客户端多久之后回来重新校验（毫秒）
 * 返回 { etag: {...}, lastmod: {...} }，各自是一次 HC.request 的结果。
 *
 * 关键：Last-Modified 头只到秒。editMs < 1000 时，改前改后算出来的头字符串一模一样，
 * 服务器拿 If-Modified-Since 比较就比不出差别 → 错误地回 304。
 */
HC.subSecondTrap = function (editMs, recheckMs) {
    const cc = 'no-cache';
    const before = { url: '/app.js', etag: '"v1"', mtimeMs: 0, bytes: HC.BODY, cc, version: 'v1' };
    // 客户端在 t=0 拿到 v1
    const first = HC.request(null, before, 0, { validator: 'both' });
    // 服务端在 editMs 把内容改成 v2
    const after = {
        url: '/app.js', etag: '"v2"', mtimeMs: editMs,
        bytes: HC.BODY + 96, cc, version: 'v2',
    };
    const t = recheckMs / 1000;
    return {
        editMs, recheckMs,
        lastModHeaderBefore: HC.gmt(before.mtimeMs),
        lastModHeaderAfter: HC.gmt(after.mtimeMs),
        headerSame: HC.gmt(before.mtimeMs) === HC.gmt(after.mtimeMs),
        etag: HC.request(first.newCache, after, t, { validator: 'etag' }),
        lastmod: HC.request(first.newCache, after, t, { validator: 'lastmod' }),
        both: HC.request(first.newCache, after, t, { validator: 'both' }),
    };
};

if (typeof module !== 'undefined' && module.exports) module.exports = HC;
if (typeof window !== 'undefined') window.HCModel = HC;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const PRESETS = [
    { v: 'max-age=3600', label: 'max-age=3600', desc: '强缓存一小时' },
    { v: 'no-cache', label: 'no-cache', desc: '存但每次校验' },
    { v: 'no-store', label: 'no-store', desc: '真·不缓存' },
    { v: 'max-age=31536000, immutable', label: 'max-age=1年, immutable', desc: '带哈希的静态资源' },
];

const state = {
    cc: 'max-age=3600',
    gapSec: 10,        // 两次请求间隔
    serverChanged: false,
    validator: 'both',
    trapEdit: 400,     // 服务端在多少毫秒后改了内容
    dom: {},
};

let rootEl = null;

// ---------- 决策树 ----------

const TREE = {
    W: 720, DW: 268, OW: 300, BH: 50, ROWY: [16, 92, 168, 244],
    DX: 24, OX: 396,
};

const NODES = {
    d1: { row: 0, side: 'L', t: '① 本地有这个 URL 的副本吗？', s: '看磁盘缓存 / 内存缓存' },
    d2: { row: 1, side: 'L', t: '② 强缓存还新鲜吗？', s: 'age < max-age ？有 no-cache 就直接跳过' },
    d3: { row: 2, side: 'L', t: '③ 条件请求：服务器说变了吗？', s: 'If-None-Match / If-Modified-Since' },
    o1: { row: 0, side: 'R', t: '200 OK · 整份下载', s: '请求头 + 响应头 + 完整 body', kind: 'bad' },
    o2: { row: 1, side: 'R', t: '200 (from disk cache) · 0 字节', s: '压根没发请求，网络面板里是灰色的', kind: 'best' },
    o3: { row: 2, side: 'R', t: '304 Not Modified · 只有响应头', s: '请求发了，但 body 一个字节没传', kind: 'good' },
    o4: { row: 3, side: 'R', t: '200 OK · 带上新 body', s: '内容真变了，老老实实重下一遍', kind: 'bad' },
};

function nodeBox(id) {
    const n = NODES[id];
    const x = n.side === 'L' ? TREE.DX : TREE.OX;
    const w = n.side === 'L' ? TREE.DW : TREE.OW;
    return { x, y: TREE.ROWY[n.row], w, h: TREE.BH, cx: x + w / 2, cy: TREE.ROWY[n.row] + TREE.BH / 2 };
}

function buildTree(result) {
    const on = new Set(result.path);
    const H = TREE.ROWY[3] + TREE.BH + 18;
    const root = svg('svg', {
        viewBox: '0 0 ' + TREE.W + ' ' + H, class: 'hc-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'HTTP 缓存决策树',
    });

    const defs = svg('defs');
    ['#c7cdd8', '#4f46e5'].forEach((c, i) => {
        const m = svg('marker', {
            id: 'hc-ar' + i, viewBox: '0 0 8 8', refX: 7, refY: 4,
            markerWidth: 7, markerHeight: 7, orient: 'auto',
        });
        m.appendChild(svg('path', { d: 'M0 0 L8 4 L0 8 Z', fill: c }));
        defs.appendChild(m);
    });
    root.appendChild(defs);

    // 连线：竖着往下（继续判断） + 横着往右（出结果）
    const edges = [
        { from: 'd1', to: 'd2', dir: 'down', label: '有' },
        { from: 'd1', to: 'o1', dir: 'right', label: '没有' },
        { from: 'd2', to: 'd3', dir: 'down', label: '过期 / no-cache' },
        { from: 'd2', to: 'o2', dir: 'right', label: '新鲜' },
        { from: 'd3', to: 'o4', dir: 'down', label: '变了' },
        { from: 'd3', to: 'o3', dir: 'right', label: '没变' },
    ];

    edges.forEach((e) => {
        const a = nodeBox(e.from), b = nodeBox(e.to);
        const lit = on.has(e.from) && on.has(e.to);
        const cls = 'hc-edge' + (lit ? ' hc-edge-on' : '');
        let d, lx, ly;
        if (e.dir === 'down') {
            d = 'M' + a.cx + ' ' + (a.y + a.h) + ' L' + a.cx + ' ' + (b.y - 4);
            lx = a.cx + 7; ly = (a.y + a.h + b.y) / 2 + 3;
        } else {
            d = 'M' + (a.x + a.w) + ' ' + a.cy + ' L' + (b.x - 5) + ' ' + b.cy;
            lx = (a.x + a.w + b.x) / 2; ly = a.cy - 7;
        }
        root.appendChild(svg('path', {
            d, class: cls, fill: 'none',
            'marker-end': 'url(#hc-ar' + (lit ? 1 : 0) + ')',
        }));
        const lb = svg('text', {
            x: lx, y: ly, class: 'hc-edge-label' + (lit ? ' hc-edge-label-on' : ''),
            'text-anchor': e.dir === 'down' ? 'start' : 'middle',
        });
        lb.textContent = e.label;
        root.appendChild(lb);
    });

    // 结点
    Object.keys(NODES).forEach((id) => {
        const n = NODES[id], b = nodeBox(id);
        const lit = on.has(id);
        const isEnd = id[0] === 'o' && result.path[result.path.length - 1] === id;
        const g = svg('g', { class: 'hc-node' + (lit ? ' on' : '') + (isEnd ? ' end' : '') });
        g.appendChild(svg('rect', {
            x: b.x, y: b.y, width: b.w, height: b.h, rx: 10,
            class: 'hc-box hc-box-' + (n.side === 'L' ? 'dec' : (n.kind || 'good')) + (lit ? ' on' : ''),
        }));
        const t1 = svg('text', { x: b.x + 13, y: b.y + 21, class: 'hc-box-t' + (lit ? ' on' : '') });
        t1.textContent = n.t;
        g.appendChild(t1);
        const t2 = svg('text', { x: b.x + 13, y: b.y + 37, class: 'hc-box-s' });
        t2.textContent = n.s;
        g.appendChild(t2);
        if (isEnd) {
            g.appendChild(svg('rect', {
                x: b.x - 4, y: b.y - 4, width: b.w + 8, height: b.h + 8, rx: 13, class: 'hc-halo',
            }));
        }
        root.appendChild(g);
    });

    return root;
}

// ---------- 报文面板 ----------

function headerBlock(title, list, cls) {
    const box = h('div.hc-msg' + (cls ? '.' + cls : ''));
    box.appendChild(h('div.hc-msg-h', { text: title }));
    const pre = h('div.hc-msg-body');
    list.forEach((it) => {
        if (!it.k) pre.appendChild(h('div.hc-line.hc-line-first', { text: it.v }));
        else pre.appendChild(h('div.hc-line', null,
            h('span.hc-hk', { text: it.k + ': ' }), h('span.hc-hv', { text: it.v })));
    });
    box.appendChild(pre);
    return box;
}

// ---------- 三栏对比 ----------

function seriesCols() {
    const times = [0, 10, 20];
    const cols = ['max-age=3600', 'no-cache', 'no-store'].map((cc) => HC.runSeries(cc, times));
    const wrap = h('div.hc-cols');
    const tone = ['hc-c-a', 'hc-c-b', 'hc-c-c'];
    const cap = [
        '第 1 次下载完就存住了。后面两次浏览器<b>连请求都不发</b>。',
        '也存住了！只是每次用之前都去问一句。<b>命中照样是 304，body 没传。</b>',
        '真的一份都不留。三次全是完整下载，<b>三倍流量</b>。',
    ];
    cols.forEach((s, i) => {
        const col = h('div.hc-col.' + tone[i]);
        col.appendChild(h('div.hc-col-h', null,
            h('code.hc-cc', { text: 'Cache-Control: ' + s.cc })));
        const tbl = h('div.hc-col-rows');
        s.rows.forEach((r) => {
            const badge = r.outcome === 'no-request' ? 'hc-b-none'
                : r.outcome === 'revalidate-304' ? 'hc-b-304' : 'hc-b-200';
            tbl.appendChild(h('div.hc-col-row', null,
                h('span.hc-rn', { text: '第 ' + r.n + ' 次' }),
                h('span.hc-badge.' + badge, { text: r.outcome === 'no-request' ? '不发请求' : r.status }),
                h('span.hc-rb', { text: r.netBytes === 0 ? '0 B' : Viz.fmtBytes(r.netBytes) })
            ));
        });
        col.appendChild(tbl);
        col.appendChild(h('div.hc-col-sum', null,
            h('div', null, h('b', { text: String(s.netRequests) }), ' 次网络请求'),
            h('div', null, h('b', { text: String(s.bodyTransfers) }), ' 次传了 body'),
            h('div.hc-col-total', { text: '共 ' + Viz.fmtBytes(s.totalBytes) })
        ));
        col.appendChild(h('div.hc-col-cap', { html: cap[i] }));
        wrap.appendChild(col);
    });
    return wrap;
}

// ---------- Last-Modified 秒级精度陷阱 ----------

function trapPanel() {
    const trap = HC.subSecondTrap(state.trapEdit, state.trapEdit + 400);
    const box = h('div.hc-trap');

    // 时间轴
    const W = 700, H = 118;
    const x0 = 46, x1 = W - 24;
    const span = Math.max(2000, trap.recheckMs + 400);
    const X = (ms) => x0 + (ms / span) * (x1 - x0);
    const sv = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, class: 'hc-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': '一秒内改两次的时间轴',
    });
    // 秒格
    for (let s = 0; s * 1000 <= span; s++) {
        const px = X(s * 1000);
        sv.appendChild(svg('rect', {
            x: px, y: 22, width: Math.min(X((s + 1) * 1000), x1) - px, height: 34,
            fill: s % 2 ? '#f6f7f9' : '#eef2ff', stroke: '#e0e4ea',
        }));
        const lb = svg('text', { x: px + 5, y: 68, class: 'hc-axis' });
        lb.textContent = '第 ' + s + ' 秒';
        sv.appendChild(lb);
    }
    const evs = [
        { at: 0, t: 'GET → 200', s: 'ETag "v1"', cls: 'a' },
        { at: trap.editMs, t: '服务端改了内容', s: 'ETag 变 "v2"', cls: 'b' },
        { at: trap.recheckMs, t: '带条件请求回来问', s: '还能用旧的吗？', cls: 'c' },
    ];
    evs.forEach((e, i) => {
        const px = X(e.at);
        sv.appendChild(svg('line', { x1: px, x2: px, y1: 14, y2: 60, class: 'hc-ev hc-ev-' + e.cls }));
        sv.appendChild(svg('circle', { cx: px, cy: 14, r: 4, class: 'hc-evdot hc-ev-' + e.cls }));
        const t1 = svg('text', { x: px + 5, y: 88 + (i % 2) * 22, class: 'hc-ev-t' });
        t1.textContent = e.t + '  (' + (e.at / 1000).toFixed(2) + 's)';
        sv.appendChild(t1);
        const t2 = svg('text', { x: px + 5, y: 100 + (i % 2) * 22, class: 'hc-ev-s' });
        t2.textContent = e.s;
        sv.appendChild(t2);
    });
    box.appendChild(sv);

    box.appendChild(h('p.sec-note', {
        html: '两次修改的 <code>Last-Modified</code> 头长这样：<br>'
            + '<code>' + Viz.esc(trap.lastModHeaderBefore) + '</code>（改之前）<br>'
            + '<code>' + Viz.esc(trap.lastModHeaderAfter) + '</code>（改之后）<br>'
            + (trap.headerSame
                ? '<b class="hc-red">两行一模一样。</b>HTTP 日期格式最细就到秒，'
                  + Math.round(trap.editMs) + 'ms 这个差值在头里根本表示不出来。'
                : '<b class="hc-green">这次跨秒了，两行不一样</b>，Last-Modified 也能分辨出来 —— '
                  + '所以这个坑只在「同一秒内改」时才踩得到，平时测不出来，上线才炸。'),
    }));

    const two = h('div.hc-two');
    [['只用 If-None-Match（ETag）', trap.etag, 'etag'],
     ['只用 If-Modified-Since（Last-Modified）', trap.lastmod, 'lastmod']].forEach(([name, r, key]) => {
        const correct = r.status === 200;   // 内容确实变成 v2 了，正确行为是 200
        const p = h('div.hc-tcase.' + (correct ? 'ok' : 'bad'));
        p.appendChild(h('div.hc-tcase-h', { text: name }));
        p.appendChild(h('div.hc-tcase-v', { text: r.statusText }));
        p.appendChild(h('div.hc-tcase-d', { text: r.why }));
        p.appendChild(h('div.hc-tcase-r', {
            html: correct
                ? '✅ 正确：客户端拿到了 <b>v2</b>'
                : '❌ <b>误判</b>：客户端以为没变，继续用着 <b>v1</b> 这份旧内容',
        }));
        two.appendChild(p);
    });
    box.appendChild(two);

    box.appendChild(h('div.seq-note', {
        html: '这就是为什么 RFC 9110 规定：<b>请求里同时带了两个校验器时，服务器必须优先看 If-None-Match，'
            + '并且忽略 If-Modified-Since</b>。不是「一般 ETag 更准」的经验之谈，是标准写死的优先级。'
            + '浏览器也会把两个头都带上，把选择权交给服务器。',
    }));
    return box;
}

// ---------- 渲染 ----------

function currentWalk() {
    // 用当前控制面板的参数，走「第二次请求」这一趟
    const cc = state.cc;
    const v1 = { url: '/app.js', etag: '"v1"', mtimeMs: 0, bytes: HC.BODY, cc, version: 'v1' };
    const first = HC.request(null, v1, 0, { validator: state.validator });
    const server = state.serverChanged
        ? { url: '/app.js', etag: '"v2"', mtimeMs: 5000, bytes: HC.BODY + 640, cc, version: 'v2' }
        : v1;
    const second = HC.request(first.newCache, server, state.gapSec, { validator: state.validator });
    return { first, second, server };
}

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const walk = currentWalk();
    const r = walk.second;

    // ── 场景 + 控制 ──
    const ctl = h('div.controls');
    ctl.appendChild(Viz.slider({
        label: '两次请求间隔', min: 1, max: 7200, step: 1, value: state.gapSec,
        fmt: (v) => HC.fmtSec(v),
        onInput: (v) => { state.gapSec = v; render(); },
    }));
    ctl.appendChild(h('div.ctl-btns', null,
        h('button.mini' + (state.serverChanged ? '' : '.primary'), {
            onclick: () => { state.serverChanged = false; render(); },
        }, '服务端没改'),
        h('button.mini' + (state.serverChanged ? '.primary' : ''), {
            onclick: () => { state.serverChanged = true; render(); },
        }, '服务端改了内容')
    ));

    const segs = Viz.segmented({
        options: PRESETS.map((p) => ({ v: p.v, label: p.label })),
        value: state.cc,
        onPick: (v) => { state.cc = v; render(); },
    });

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-box-archive"></i> 场景：同一个 /app.js，浏览器第二次来要它' }),
        h('p.sec-note', {
            html: '第一次请求肯定是整份下载 —— 没什么好说的。<b>有意思的是第二次</b>：'
                + '发不发请求、发了拿回什么，全看第一次那个响应带了什么头。'
                + '下面先挑一个 <code>Cache-Control</code>，再拖间隔，看决策树往哪走。',
        }),
        h('p.sec-note', { html: '服务器当初回的 <code>Cache-Control</code>：' }),
        segs,
        ctl
    ));

    // ── 决策树 ──
    const kindWord = {
        'full-200': '整份下载', 'no-request': '不发请求',
        'revalidate-304': '304 空手而归', 'revalidate-200': '重新下载',
    }[r.outcome];
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-diagram-project"></i> 第二次请求走了哪条路' }),
        h('p.sec-note', {
            html: '亮起来的就是这一趟实际走的路径，最后那个框是结局。'
                + '当前结局：<b>' + Viz.esc(kindWord) + '</b>，网络上一共传了 <b>'
                + (r.netBytes === 0 ? '0 字节' : Viz.fmtBytes(r.netBytes)) + '</b>。',
        }),
        buildTree(r),
        buildSteps(r)
    ));

    // ── 真实报文 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-file-lines"></i> 这一趟的真实报文' }),
        h('p.sec-note', {
            html: '别背概念，看头。<b>请求头里有没有 If-None-Match，响应是 200 还是 304，'
                + '有没有 Content-Length</b> —— 这三件事看一眼就知道命中的是哪种缓存。',
        }),
        h('div.hc-msgs', null,
            headerBlock('浏览器发出去的', r.reqHeaders, 'req'),
            headerBlock('服务器回来的', r.resHeaders, r.status === 304 ? 'res304' : 'res')
        ),
        h('div.hc-bytes', null,
            h('div.hc-byte-cell', null,
                h('span.live-label', { text: '这次传输' }),
                h('b.live-val' + (r.netBytes === 0 ? '.ok' : (r.bodyBytes ? '.bad' : '')), {
                    text: r.netBytes === 0 ? '0 B' : Viz.fmtBytes(r.netBytes),
                })),
            h('div.hc-byte-cell', null,
                h('span.live-label', { text: '其中 body' }),
                h('b.live-val', { text: r.bodyBytes ? Viz.fmtBytes(r.bodyBytes) : '0 B' })),
            h('div.hc-byte-cell', null,
                h('span.live-label', { text: '浏览器手上是' }),
                h('b.live-val', { text: r.clientVersion })),
            h('div.hc-byte-cell', null,
                h('span.live-label', { text: 'DevTools 里显示' }),
                h('b.live-val.hc-small', { text: r.statusText }))
        ),
        h('div.seq-note', { html: '<b>结论：</b>' + Viz.esc(r.why) })
    ));

    // ── 打脸一：no-cache ≠ 不缓存 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻：no-cache 根本不是「不缓存」' }),
        h('p.sec-note', {
            html: '同一个资源、同一批请求（第 0 / 10 / 20 秒各来一次，服务端内容全程没变），换三种 '
                + '<code>Cache-Control</code>，结果差得离谱：',
        }),
        seriesCols(),
        h('div.seq-note', {
            html: '<b>no-cache 的意思是「可以存，但每次用之前必须去服务器验一下」</b>，'
                + '所以它照样把副本存在磁盘上，命中时回的是 <b>304</b>，body 一个字节都不传 —— '
                + '省的是<b>带宽</b>，花的是<b>一次 RTT</b>。<br>'
                + '真正「一份都别留」的是 <code>no-store</code>：每次都完整重下，'
                + '流量是 no-cache 的近 3 倍。<br>'
                + '记法：<b>no-cache 管的是「能不能直接用」，no-store 管的是「能不能存」</b>。'
                + '名字起反了，这锅是 HTTP/1.1 的。',
        })
    ));

    // ── 打脸二：Last-Modified 秒级精度 ──
    const trapCtl = h('div.controls');
    trapCtl.appendChild(Viz.slider({
        label: '改动发生在', min: 100, max: 1800, step: 100, value: state.trapEdit,
        fmt: (v) => '+' + (v / 1000).toFixed(1) + 's',
        onInput: (v) => { state.trapEdit = v; render(); },
    }));
    trapCtl.appendChild(h('div.ctl-btns', null,
        h('button.mini.danger', { onclick: () => { state.trapEdit = 400; render(); } }, '同一秒内改两次'),
        h('button.mini', { onclick: () => { state.trapEdit = 1400; render(); } }, '跨秒再改')
    ));
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-face-flushed"></i> 打脸时刻二：Last-Modified 只有秒级精度，会漏判' }),
        h('p.sec-note', {
            html: '构造一个很具体的场景：文件在 <b>同一秒内被改了两次</b>（CI 连着跑两次、'
                + '或者一个脚本先写模板再写内容）。拖滑块或者点下面两个按钮换场景。',
        }),
        trapCtl,
        trapPanel()
    ));

    // ── 机制细节 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list-ol"></i> 这几个头到底谁管谁' }),
        Viz.flowList([
            {
                t: '① 强缓存：max-age / Expires —— 决定「要不要发请求」',
                f: 'Cache-Control: max-age=3600\n// age = now - 响应到达时刻；age < 3600 就直接用本地的',
                r: '命中时零请求、零字节、零延迟，是最省的一档',
                hi: 'Expires 是 HTTP/1.0 遗产，写的是绝对时间，客户端时钟不准就会失效。'
                    + '两个都在时 max-age 赢。新代码只写 Cache-Control 就够了。',
            },
            {
                t: '② 协商缓存：ETag / Last-Modified —— 决定「发了以后传不传 body」',
                f: '请求：If-None-Match: "v1"\n响应：304 Not Modified（没有 body）',
                r: '请求还是发了（一个 RTT 跑不掉），但省下了 body 的字节',
            },
            {
                t: '③ 服务端先看 If-None-Match，再看 If-Modified-Since',
                f: 'if (req.ifNoneMatch) { 只按 ETag 判，忽略 IMS }\nelse if (req.ifModifiedSince) { 按 mtime 判 }',
                r: 'RFC 9110 §13.2.2 明确规定的优先级，不是习惯',
                hi: '所以给 CDN / nginx 配 ETag 时别乱关。关了 ETag 就只剩秒级精度的 Last-Modified 兜底了。',
            },
            {
                t: '④ 304 会顺手刷新新鲜度',
                f: '304 响应里可以带新的 Cache-Control / ETag / Expires\n浏览器拿它更新本地那份元数据，age 重新从 0 算',
                r: '所以一次 304 之后，接下来一段时间可能连请求都不发了',
            },
            {
                t: '⑤ 带内容哈希的文件名 + 一年强缓存 = 现代前端的标准姿势',
                f: 'app.4f3a9c1.js  ←  Cache-Control: max-age=31536000, immutable\nindex.html    ←  Cache-Control: no-cache',
                r: '内容变了文件名就变，永远不用担心用户拿到旧的',
                hi: '<code>immutable</code> 的作用是：连用户按 F5 刷新时都别去发条件请求。'
                    + '入口 HTML 必须 no-cache，否则新版本发不出去 —— HTML 是那根「引线」。',
            },
        ])
    ));

    // ── 面试 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-comments"></i> 面试怎么答' }),
        Viz.qa([
            {
                q: '强缓存和协商缓存的区别？',
                a: '一句话：<b>强缓存决定要不要发请求，协商缓存决定发了以后传不传 body</b>。'
                    + '强缓存命中 → 0 请求 0 字节，DevTools 里是灰色的 <code>200 (from disk cache)</code>；'
                    + '协商缓存命中 → 请求发出去了，但服务器回 <code>304</code>，省的是 body 不是 RTT。'
                    + '两者是<b>串联</b>的：先判强缓存，过期了才轮到协商缓存。',
            },
            {
                q: 'no-cache 和 no-store 有什么区别？',
                a: '这题就是在等你踩坑。<code>no-cache</code> = <b>可以存，但每次用之前必须去服务器验</b>，'
                    + '验过了照样回 304 用本地副本，body 不传；'
                    + '<code>no-store</code> = <b>一份都别留</b>，每次完整重下。'
                    + '演示里三次请求的流量：max-age 约 13 KB、no-cache 约 14 KB、no-store 约 38 KB。',
            },
            {
                q: '为什么 ETag 优先级比 Last-Modified 高？',
                a: '三条：① <b>精度</b> —— HTTP 日期只到秒，一秒内改两次检测不到（本演示第二个打脸就是这个）；'
                    + '② <b>语义</b> —— 有些文件被重写但内容没变（比如重新构建），mtime 变了但 ETag 可以不变；'
                    + '③ <b>标准</b> —— RFC 9110 明确要求服务器优先用 If-None-Match 并忽略 If-Modified-Since。',
            },
            {
                q: '强缓存期内想让用户马上拿到新版本，怎么办？',
                a: '<b>没办法「撤回」已经发出去的强缓存</b> —— 那份副本就在用户磁盘上躺着，'
                    + '你在服务端改什么都没用。所以正确姿势是<b>提前设计</b>：'
                    + '静态资源用<b>内容哈希文件名</b> + 一年强缓存（改了就是新 URL，天然不冲突），'
                    + '入口 HTML 用 <code>no-cache</code> 让它每次都校验。'
                    + '实在要救急只能换 URL（加 query 也算换 URL）。',
            },
            {
                q: 'Ctrl+F5 和普通 F5 有什么区别？',
                a: '普通 <b>F5</b>：跳过强缓存，但会带上 <code>If-None-Match</code> 去校验，能吃到 304。'
                    + '<b>Ctrl+F5 / 硬刷新</b>：请求头里带 <code>Cache-Control: no-cache</code>，'
                    + '校验器也不带了，强制整份重下。'
                    + '（<code>immutable</code> 就是专门用来让 F5 也别去校验的。）',
            },
        ])
    ));

    // ── 坑 ──
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 必须知道的坑' }),
        Viz.pitfalls([
            ['强缓存一旦发出去就收不回来',
             '你在服务端怎么改都没用 —— 那份副本连同 max-age 一起躺在用户磁盘上，'
             + '到期之前浏览器根本不会来问你。<b>给 HTML 设长 max-age 是新手最贵的一次事故</b>，'
             + '通常只能等它自然过期，或者引导用户硬刷新。'],
            ['多机部署时 ETag 可能对不上',
             'nginx 默认用 <code>inode-mtime-size</code> 生成 ETag。同一份文件部署到多台机器，'
             + 'inode 不同 → ETag 不同 → 用户在机器 A 和 B 之间来回被负载均衡时，'
             + '<b>每次都是 200 全量</b>，缓存等于没有。'
             + '解决办法是改成基于内容哈希的 ETag，或者干脆关掉 ETag 只用 Last-Modified。'],
            ['带 query 的 URL 不一定不缓存',
             '「加个时间戳就不会被缓存」这个说法只对了一半。'
             + '浏览器把整个 URL（含 query）当 key，所以换 query 确实是新 key；'
             + '但中间的 CDN / 代理未必这么想，有些配置会<b>忽略 query 做缓存键</b>，'
             + '结果就是加了时间戳照样拿到旧的。'],
            ['Vary 头忘了写会串味',
             '同一个 URL 对不同 <code>Accept-Encoding</code> / <code>Accept-Language</code> 返回不同内容时，'
             + '必须写 <code>Vary</code>，否则代理会把 gzip 版本喂给不支持 gzip 的客户端。'
             + '反过来 <code>Vary: User-Agent</code> 又会让缓存命中率暴跌（UA 千奇百怪），要克制。'],
            ['私有数据别忘了 private',
             '<code>Cache-Control: max-age=600</code> 不带 <code>private</code>，'
             + 'CDN 和公司代理是<b>可以</b>缓存它的。'
             + '登录后的个人页面如果这么配，A 用户的数据可能被 B 用户拿到 —— 这是真实发生过的事故。'
             + '涉及用户数据的接口要么 <code>private</code>，要么 <code>no-store</code>。'],
        ])
    ));

    // ── 说明 ──
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '做了这些简化：① 字节数是<b>估算</b>的 —— 请求头按 380 B、200 响应头按 260 B、'
                + '304 响应头按 190 B、body 按 12 KB 的 JS 文件算，真实值取决于你的 Cookie 大小和头字段数量，'
                + '这里只为了让三栏对比有量级上的可比性。② 没有模拟 <code>Vary</code>、'
                + '<code>s-maxage</code>、CDN 多级缓存和「启发式缓存」（没有任何新鲜度头时浏览器会自己猜一个）。'
                + '③ 时间是抽象的秒，没有模拟 RTT 和 TCP 连接建立的开销 —— '
                + '实际上 304 虽然省了 body，但那一个 RTT 在弱网下可能比 body 还贵。',
        }),
        h('p', {
            html: '关于「同一秒内改两次」：这不是编出来的场景。'
                + 'CI 流水线连着跑、编辑器保存时先清空再写入、脚本里 <code>cp</code> 完再 <code>sed</code>，'
                + '都可能在一秒内产生两次写。这类 bug 的可怕之处在于<b>本地手动测永远复现不了</b>'
                + '（人手速没那么快），只有自动化流程才踩得到。',
        }),
        h('p', {
            html: '所有数据都是确定的：没有用随机数，时间基准固定在 '
                + '<code>2026-08-01T10:00:00Z</code>，你刷新多少次结果都一样。',
        })
    ));
}

function buildSteps(r) {
    const box = h('div.hc-steps');
    r.steps.forEach((s, i) => {
        box.appendChild(h('div.hc-step.hc-s-' + s.kind, null,
            h('div.hc-step-n', { text: String(i + 1) }),
            h('div.hc-step-b', null,
                h('div.hc-step-q', { text: s.q }),
                h('div.hc-step-a', { text: s.a })
            )
        ));
    });
    return box;
}

Viz.register({
    id: 'http-cache',
    cat: 'net',
    title: 'HTTP 缓存',
    subtitle: '强缓存 · 协商缓存 · ETag',
    icon: 'fa-box-archive',
    blurb: '第二次请求到底发不发、发了以后传不传 body，全看这几个头',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.cc = 'max-age=3600';
        state.gapSec = 10;
        state.serverChanged = false;
        state.validator = 'both';
        state.trapEdit = 400;
        render();
    },
    unmount() {
        state.dom = {};
        rootEl = null;
    },
});

})();
