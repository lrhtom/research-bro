// ============================================================
//  演示：缓存穿透 / 击穿 / 雪崩
//  三种故障打到数据库上的「流量形状」完全不同，画出来就再也记不混。
//  模型是定性模拟（不是精确排队论），目的是把形状和解法讲清楚。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const CP = {};

CP.SCENARIOS = {
    penetrate: {
        name: '缓存穿透', en: 'Penetration', color: '#a855f7',
        one: '查一个<b>数据库里根本不存在</b>的 key',
        why: '缓存查不到 → 去查库 → 库里也没有 → <b>不写缓存</b> → 下次还是查不到。'
            + '缓存形同虚设，每个请求都落到库上。常见于恶意攻击：拿随机 ID 疯狂刷接口。',
        shape: '持续的一条高位平线（不是尖峰）',
        fixes: [
            { id: 'bloom', name: '布隆过滤器', desc: '把所有存在的 key 预先放进布隆过滤器，请求先过滤一遍，不存在的直接打回，连缓存都不用查。' },
            { id: 'nullcache', name: '缓存空值', desc: '查库没查到，也往缓存写一个空值（TTL 设短，比如 60 秒），后续请求命中这个空值直接返回。' },
        ],
    },
    breakdown: {
        name: '缓存击穿', en: 'Breakdown', color: '#f97316',
        one: '一个<b>热点 key 刚好过期</b>的那一瞬间',
        why: 'key 是存在的，只是恰好过期了。偏偏它是热点，那一刻有成百上千个并发请求同时发现缓存没了，'
            + '<b>同时</b>去查库、<b>同时</b>回写缓存。库在那一瞬间被打穿。',
        shape: '一根又高又窄的尖峰',
        fixes: [
            { id: 'single', name: '单飞 / 互斥锁', desc: '只放一个请求去查库重建缓存，其余请求等它的结果 —— 就是「单飞锁」那个演示。' },
            { id: 'logical', name: '逻辑过期', desc: 'key 本身永不过期，把过期时间写进 value 里。发现逻辑过期就异步重建，请求先拿旧值返回，一点不等。' },
        ],
    },
    avalanche: {
        name: '缓存雪崩', en: 'Avalanche', color: '#ef4444',
        one: '<b>大批 key 在同一时刻集体过期</b>（或 Redis 整个挂了）',
        why: '常见于系统启动时批量预热缓存、都设了同样的 TTL，于是它们也会在同一秒集体失效。'
            + '瞬间所有请求全部落库，数据库直接被压垮 —— 而库一慢，请求堆积，可能连锁拖垮整个服务。',
        shape: '一整片塌方式的高原',
        fixes: [
            { id: 'jitter', name: 'TTL 加随机值', desc: 'TTL 设成 30 分钟 + 随机 0~5 分钟，把集体失效摊开成一段平缓的曲线。最简单最有效。' },
            { id: 'multi', name: '多级缓存 / 熔断降级', desc: '本地缓存兜一层；再配合限流熔断，宁可拒一部分请求，也不能让数据库彻底躺下。' },
        ],
    },
};

/**
 * 定性模拟：返回每个时间片打到数据库的请求数。
 * opt = { scenario, fix, qps, durationMs, dt, expireAt, rebuildMs, keys, distinctBad }
 */
CP.simulate = function (opt) {
    const dt = opt.dt, steps = Math.round(opt.durationMs / dt);
    const perStep = (opt.qps * dt) / 1000;
    const out = [];
    let badSeen = 0;

    for (let i = 0; i < steps; i++) {
        const t = i * dt;
        let db = 0;

        if (opt.scenario === 'penetrate') {
            if (opt.fix === 'bloom') {
                db = 0;                                    // 布隆过滤器直接挡在最外层
            } else if (opt.fix === 'nullcache') {
                // 只有「第一次见到的坏 key」才落库，见过的都被空值挡住
                const fresh = Math.max(0, Math.min(perStep, opt.distinctBad - badSeen));
                badSeen += fresh;
                db = fresh;
            } else {
                db = perStep;                              // 每个请求都穿到库
            }
        } else if (opt.scenario === 'breakdown') {
            const inWindow = t >= opt.expireAt && t < opt.expireAt + opt.rebuildMs;
            if (!inWindow) db = 0;
            else if (opt.fix === 'single') db = (t < opt.expireAt + dt) ? 1 : 0;   // 只放一个进去
            else if (opt.fix === 'logical') db = (t < opt.expireAt + dt) ? 1 : 0;  // 异步重建，同样只有一个
            else db = perStep;                             // 全部涌入
        } else {
            // 雪崩：keys 个 key 的过期时刻分布
            const spread = opt.fix === 'jitter' ? opt.jitterMs : 0;
            // 落在 [expireAt, expireAt+spread] 区间内均匀分布；每个 key 过期后有 rebuildMs 的空窗
            let expiredFrac;
            if (spread === 0) {
                expiredFrac = (t >= opt.expireAt && t < opt.expireAt + opt.rebuildMs) ? 1 : 0;
            } else {
                // 处于「已过期且尚未重建完」窗口内的 key 占比
                const lo = Math.max(opt.expireAt, t - opt.rebuildMs);
                const hi = Math.min(opt.expireAt + spread, t);
                expiredFrac = hi > lo ? (hi - lo) / spread : 0;
            }
            db = perStep * expiredFrac;
            if (opt.fix === 'multi') db *= 0.25;            // 本地缓存 + 限流削掉大部分
        }

        out.push({ t, db, total: perStep });
    }
    return out;
};

CP.peak = function (series) { return Math.max.apply(null, series.map((p) => p.db)); };
CP.sum = function (series) { return series.reduce((a, p) => a + p.db, 0); };

if (typeof module !== 'undefined' && module.exports) module.exports = CP;
if (typeof window !== 'undefined') window.CPModel = CP;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, T = Viz.text;

const state = {
    scenario: 'breakdown', fix: 'none',
    qps: 2000, durationMs: 3000, dt: 20,
    expireAt: 1200, rebuildMs: 400, keys: 500, distinctBad: 400, jitterMs: 900,
};

function sim(fix) {
    return CP.simulate(Object.assign({}, state, { fix }));
}

function buildChart(series, color, label, maxY) {
    const W = 800, H = 150, PL = 54, PR = 14, PT = 20, PB = 26;
    const iw = W - PL - PR, ih = H - PT - PB;
    const x = (t) => PL + (t / state.durationMs) * iw;
    const y = (v) => PT + ih - (v / maxY) * ih;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'cp-svg', preserveAspectRatio: 'xMidYMid meet' });
    root.appendChild(T({ x: 0, y: 12, class: 'cp-label', fill: color }, label));

    const peakQps = CP.peak(series) * (1000 / state.dt);
    root.appendChild(T({ x: W, y: 12, 'text-anchor': 'end', class: 'cp-peak', fill: color },
        '峰值 ' + Math.round(peakQps).toLocaleString() + ' QPS'));

    // 网格
    for (let k = 0; k <= 2; k++) {
        const v = (maxY / 2) * k;
        root.appendChild(svg('line', { x1: PL, x2: W - PR, y1: y(v), y2: y(v), stroke: '#eef0f3' }));
        root.appendChild(T({ x: PL - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' },
            Math.round(v * (1000 / state.dt)).toLocaleString()));
    }

    let d = `M${x(0)} ${y(0)}`;
    series.forEach((p) => { d += `L${x(p.t).toFixed(1)} ${y(p.db).toFixed(1)}`; });
    d += `L${x(state.durationMs)} ${y(0)}Z`;
    root.appendChild(svg('path', { d, fill: color, opacity: 0.24 }));

    let ld = '';
    series.forEach((p, i) => { ld += (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.db).toFixed(1); });
    root.appendChild(svg('path', { d: ld, fill: 'none', stroke: color, 'stroke-width': 2 }));

    for (let t = 0; t <= state.durationMs; t += 500) {
        root.appendChild(T({ x: x(t), y: H - 8, 'text-anchor': 'middle', class: 'axis-label' }, t + 'ms'));
    }
    return root;
}

let rootEl = null;

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';
    const sc = CP.SCENARIOS[state.scenario];
    const base = sim('none');
    const fixed = state.fix === 'none' ? null : sim(state.fix);
    const maxY = Math.max(CP.peak(base), 0.001) * 1.12;

    rootEl.appendChild(Viz.card('fa-triangle-exclamation', '三兄弟：先分清它们到底不一样在哪',
        '名字都带「缓存」，很多人背混。<b>区分点其实很简单：数据在不在、有几个 key。</b>',
        buildMatrix()
    ));

    rootEl.appendChild(Viz.card('fa-hand-pointer', '选一个来看',
        `<b>${sc.name}</b> —— ${sc.one}。<br>${sc.why}`,
        Viz.segmented({
            value: state.scenario,
            options: Object.keys(CP.SCENARIOS).map((k) => ({ v: k, label: CP.SCENARIOS[k].name })),
            onPick: (v) => { state.scenario = v; state.fix = 'none'; render(); },
        })
    ));

    const charts = Viz.card('fa-chart-area', '数据库承受的流量形状',
        `不加防护时，<b>${sc.name}</b>打在库上的形状是：<b>${sc.shape}</b>。`
        + '下面选一个解法，对比曲线立刻出现。');
    charts.appendChild(buildChart(base, sc.color, '不做任何防护', maxY));
    if (fixed) {
        const fixName = sc.fixes.find((f) => f.id === state.fix).name;
        charts.appendChild(buildChart(fixed, '#10b981', '用了「' + fixName + '」', maxY));
    }
    charts.appendChild(Viz.segmented({
        value: state.fix,
        options: [{ v: 'none', label: '不防护' }].concat(sc.fixes.map((f) => ({ v: f.id, label: f.name }))),
        onPick: (v) => { state.fix = v; render(); },
    }));
    charts.appendChild(h('div.controls', null,
        Viz.slider({ label: '请求量', min: 200, max: 8000, step: 200, value: state.qps,
            fmt: (v) => v.toLocaleString() + ' QPS', onInput: (v) => { state.qps = v; render(); } }),
        Viz.slider({ label: '查库耗时', min: 100, max: 1200, step: 50, value: state.rebuildMs,
            fmt: (v) => v + ' ms', onInput: (v) => { state.rebuildMs = v; render(); } })
    ));
    rootEl.appendChild(charts);

    if (fixed) {
        const p0 = CP.peak(base) * (1000 / state.dt), p1 = CP.peak(fixed) * (1000 / state.dt);
        const s0 = CP.sum(base), s1 = CP.sum(fixed);
        const peakCut = p0 > 0 ? Math.round((1 - p1 / p0) * 100) : 0;
        const totalCut = s0 > 0 ? Math.round((1 - s1 / s0) * 100) : 0;
        const card = Viz.card('fa-scale-balanced', '效果', null, Viz.cmpGrid([
            { h: '防护前峰值', v: Math.round(p0).toLocaleString(), d: 'QPS 打到数据库', cls: 'cmp-bad' },
            { h: '防护后峰值', v: Math.round(p1).toLocaleString(), d: 'QPS 打到数据库', cls: 'cmp-ok' },
            { h: '峰值削减', v: peakCut + '%', d: '数据库最难受的那一刻', cls: 'cmp-save' },
        ]));
        // 「削峰」和「减总量」是两回事，别让人以为随机 TTL 没用
        card.appendChild(h('p.sec-note', {
            html: totalCut < 10
                ? `注意：整个时间窗内的<b>总查库次数几乎没变</b>（减少 ${totalCut}%），`
                  + '但峰值被削掉了 <b>' + peakCut + '%</b>。'
                  + '<b>这正是这类解法的本质 —— 它不减少工作量，只是把同一堆工作摊开，避免瞬时压垮数据库。</b>'
                  + '数据库怕的从来不是总量，是那一瞬间的并发。'
                : `总查库次数减少了 <b>${totalCut}%</b>，峰值削减 <b>${peakCut}%</b> —— `
                  + '这类解法是<b>真正消除了重复工作</b>，不只是削峰。',
        }));
        rootEl.appendChild(card);
    }

    // 解法详解
    const fixCard = Viz.card('fa-shield-halved', sc.name + ' 的解法', null);
    fixCard.appendChild(Viz.flowList(sc.fixes.map((f) => ({
        t: f.name, r: f.desc,
    }))));
    if (state.scenario === 'penetrate') fixCard.appendChild(buildBloom());
    if (state.scenario === 'breakdown') {
        fixCard.appendChild(h('p.sec-note', {
            html: '左边侧栏的<b>「单飞锁 singleflight」</b>就是这个解法的完整拆解 —— '
                + '那个演示画的正是「只放一个进去查库、其余人等结果」的内部过程。',
        }));
    }
    rootEl.appendChild(fixCard);

    rootEl.appendChild(Viz.card('fa-comments', '面试这么答', null, Viz.qa([
        { q: '一句话区分这三个？',
            a: '<b>穿透</b>：查的数据<b>根本不存在</b>，缓存永远挡不住。'
                + '<b>击穿</b>：数据存在，但<b>某一个热点 key 正好过期</b>，瞬时并发全打到库。'
                + '<b>雪崩</b>：<b>大批 key 同时过期</b>（或 Redis 宕机），库被整片压垮。'
                + '记忆锚点：<b>穿透没数据、击穿一个点、雪崩一大片</b>。' },
        { q: '布隆过滤器的原理和缺点？',
            a: '一个长 bit 数组 + k 个哈希函数。插入时把 k 个位置置 1；查询时若<b>任一位为 0 则一定不存在</b>，'
                + '全为 1 则<b>可能存在</b>。'
                + '缺点：① 有<b>假阳性</b>（误判存在，但绝无假阴性）；② <b>不支持删除</b>'
                + '（置 0 会影响其它 key，要删得用计数布隆过滤器）。'
                + '用在这里正合适 —— 假阳性只是漏放一个请求到缓存，不影响正确性。' },
        { q: '互斥锁重建缓存要注意什么？',
            a: '① 锁必须设<b>过期时间</b>，否则持锁进程崩了会死锁；'
                + '② 没抢到锁的请求不要空转，应短暂 sleep 后重试读缓存，或直接返回降级数据；'
                + '③ 释放锁要校验<b>锁是不是自己的</b>（value 存唯一标识 + Lua 脚本原子删除），'
                + '否则可能误删别人的锁。' },
        { q: '逻辑过期和物理过期怎么选？',
            a: '<b>物理过期 + 互斥锁</b>：保证数据新鲜，但重建期间部分请求要等待。一致性优先选它。'
                + '<b>逻辑过期</b>：key 永不过期，发现逻辑上过期就异步重建、当前请求直接返回旧值 —— '
                + '<b>永远不阻塞，但会读到短暂的脏数据</b>。可用性优先选它（秒杀、首页这类场景）。' },
        { q: '雪崩除了随机 TTL 还能怎么防？',
            a: '① <b>多级缓存</b>（本地 Caffeine + Redis），Redis 挂了本地还能扛一阵；'
                + '② <b>限流熔断</b>（Sentinel / Hystrix），宁可拒一部分也不能让库躺下；'
                + '③ <b>Redis 高可用</b>（主从 + 哨兵 / Cluster），避免整体宕机这个雪崩诱因；'
                + '④ <b>热点数据永不过期</b> + 后台定时刷新。' },
    ])));

    rootEl.appendChild(Viz.card('fa-circle-info', '关于这个演示',
        '这是<b>定性模拟</b>：目的是把三种故障的「流量形状」和解法效果画清楚，'
        + '不是精确的排队论模型（没有模拟数据库饱和后的响应时间劣化、请求堆积、线程池耗尽等二阶效应）。'
        + '真实雪崩中最可怕的恰恰是这些二阶效应带来的连锁反应。'));
}

function buildMatrix() {
    const rows = [
        ['缓存穿透', '不存在', '任意多个', '持续高位', '布隆过滤器 / 缓存空值'],
        ['缓存击穿', '存在', '单个热点 key', '瞬时尖峰', '单飞锁 / 互斥锁 / 逻辑过期'],
        ['缓存雪崩', '存在', '大批 key', '大片塌方', 'TTL 加随机 / 多级缓存 / 熔断'],
    ];
    const tb = h('table.mv-matrix');
    tb.appendChild(h('tr', null, h('th', { text: '' }), h('th', { text: '数据在库里吗' }),
        h('th', { text: '涉及几个 key' }), h('th', { text: 'DB 流量形状' }), h('th', { text: '主要解法' })));
    rows.forEach((r, i) => {
        const key = Object.keys(CP.SCENARIOS)[i];
        const tr = h('tr' + (key === state.scenario ? '.on' : ''), {
            onclick: () => { state.scenario = key; state.fix = 'none'; render(); },
        });
        r.forEach((c, j) => tr.appendChild(h('td' + (j === 0 ? '.mv-strong' : ''), { text: c })));
        tb.appendChild(tr);
    });
    return h('div.mv-matrix-wrap', null, tb);
}

function buildBloom() {
    const bits = 32;
    const arr = new Array(bits).fill(0);
    ['user:1', 'user:7', 'user:42'].forEach((k, ki) => {
        [(ki * 7 + 3) % bits, (ki * 11 + 9) % bits, (ki * 5 + 21) % bits].forEach((p) => { arr[p] = 1; });
    });
    const row = h('div.bloom');
    arr.forEach((b, i) => row.appendChild(h('span.bloom-bit' + (b ? '.on' : ''), { text: String(b) })));
    return h('div', null,
        h('p.sec-note', {
            html: '<b>布隆过滤器长这样</b>：一条 bit 数组。存入 key 时用 k 个哈希函数把 k 个位置置 1；'
                + '查询时<b>只要有一位是 0，就一定不存在</b>（可以放心打回）；全是 1 则「可能存在」，放行去查缓存。',
        }),
        row,
        h('p.sec-note', {
            html: '所以它<b>有假阳性、无假阴性</b> —— 会误放一小部分不存在的 key 进来，但绝不会误杀真实存在的 key。'
                + '对防穿透来说，这个特性刚好够用。',
        })
    );
}

Viz.register({
    id: 'cache-problems',
    cat: 'cache',
    title: '缓存穿透 / 击穿 / 雪崩',
    subtitle: '三种故障的流量形状与解法',
    icon: 'fa-chart-area',
    blurb: '三兄弟到底差在哪，各自把数据库打成什么样',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.scenario = 'breakdown'; state.fix = 'none'; state.qps = 2000;
        render();
    },
    unmount() { rootEl = null; },
});

})();
