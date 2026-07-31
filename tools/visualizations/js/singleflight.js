// ============================================================
//  演示：单飞锁 singleflight
//  把并发的「相同 key」请求合并成一次真实调用，其余人等结果、共享结果。
//  对应 golang.org/x/sync/singleflight 的 Group.Do。
//  上半部分 SF.simulate 是纯函数（不碰 DOM，可单独测），下半部分是界面。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const SF = {};

/**
 * 模拟一批并发请求。
 * arrivals   : 每个请求的到达时刻（ms，已排序）
 * backendMs  : 后端一次调用耗时
 * useSF      : 是否启用单飞
 *
 * 返回 { reqs, flights, maxTime, backendCalls }
 *   reqs[i]   = { i, arrive, resolve, role, flight, waited }
 *   flights[] = { id, start, end, leader, followers[] }
 *
 * 合并窗口就是「某次真实调用正在飞行」的那段时间：
 * 调用一结束，key 就从 map 里删掉，之后再来的请求会重新起飞。
 */
SF.simulate = function (arrivals, backendMs, useSF) {
    const flights = [];
    const reqs = [];

    arrivals.forEach((t, i) => {
        let flight = null;
        if (useSF) {
            // 落在 [start, end) 里才算搭上这班车；end 那一刻 key 已被删除
            flight = flights.find((f) => f.start <= t && t < f.end) || null;
        }
        if (flight) {
            flight.followers.push(i);
            reqs.push({ i, arrive: t, resolve: flight.end, role: 'follower', flight: flight.id });
        } else {
            const nf = { id: flights.length, start: t, end: t + backendMs, leader: i, followers: [] };
            flights.push(nf);
            reqs.push({ i, arrive: t, resolve: nf.end, role: useSF ? 'leader' : 'solo', flight: nf.id });
        }
    });

    reqs.forEach((r) => { r.waited = r.resolve - r.arrive; });
    const maxTime = reqs.length ? Math.max.apply(null, reqs.map((r) => r.resolve)) : 0;
    return { reqs, flights, maxTime, backendCalls: flights.length };
};

/** 某一时刻正在飞行的后端调用数（= 数据库同时承受的压力）*/
SF.concurrentAt = function (flights, t) {
    let n = 0;
    flights.forEach((f) => { if (f.start <= t && t < f.end) n++; });
    return n;
};

/** 某一时刻 g.m 里的等待者数量（含 leader 自己）*/
SF.waitersAt = function (sim, t) {
    let n = 0;
    sim.reqs.forEach((r) => { if (r.arrive <= t && t < r.resolve) n++; });
    return n;
};

if (typeof module !== 'undefined' && module.exports) module.exports = SF;
if (typeof window !== 'undefined') window.SFModel = SF;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg;

const state = {
    n: 8,
    backendMs: 600,
    spreadMs: 240,
    t: 0,
    playing: false,
    raf: null,
    lastFrame: 0,
    simSF: null,
    simNo: null,
    maxTime: 1,
    bars: [],      // 动画时要逐帧更新的元素
    dom: {},
};

function arrivals() {
    // 固定分布（不用随机，保证可复现、便于对照）：第一个在 0，其余在 spread 内均匀铺开
    const a = [];
    for (let i = 0; i < state.n; i++) {
        a.push(state.n === 1 ? 0 : (state.spreadMs * i) / (state.n - 1));
    }
    return a;
}

function build() {
    const a = arrivals();
    state.simSF = SF.simulate(a, state.backendMs, true);
    state.simNo = SF.simulate(a, state.backendMs, false);
    state.maxTime = Math.max(state.simSF.maxTime, state.simNo.maxTime) * 1.06 + 1;
}

// ---------- 泳道图 ----------

const LANE_H = 19, LANE_GAP = 3, LOAD_H = 54, PAD_L = 74, PAD_R = 18, PAD_T = 22, PAD_B = 30;

function buildPanel(sim, title, accent) {
    const n = sim.reqs.length;
    const innerW = 640;
    const lanesH = n * (LANE_H + LANE_GAP);
    const H = PAD_T + lanesH + 14 + LOAD_H + PAD_B;
    const W = PAD_L + innerW + PAD_R;

    const x = (t) => PAD_L + (t / state.maxTime) * innerW;
    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'sf-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': title,
    });

    // 标题
    const tt = svg('text', { x: 4, y: 13, class: 'sf-panel-title', fill: accent });
    tt.textContent = title;
    root.appendChild(tt);
    const bt = svg('text', { x: W - PAD_R, y: 13, class: 'sf-panel-stat', 'text-anchor': 'end' });
    bt.textContent = `后端被调用 ${sim.backendCalls} 次`;
    root.appendChild(bt);

    // 时间网格
    const step = niceStep(state.maxTime);
    for (let t = 0; t <= state.maxTime; t += step) {
        root.appendChild(svg('line', {
            x1: x(t), x2: x(t), y1: PAD_T - 6, y2: H - PAD_B,
            stroke: '#eef0f3', 'stroke-width': 1,
        }));
        const lb = svg('text', { x: x(t), y: H - PAD_B + 16, class: 'sf-axis', 'text-anchor': 'middle' });
        lb.textContent = Math.round(t) + 'ms';
        root.appendChild(lb);
    }

    // 每个请求一条泳道
    sim.reqs.forEach((r, i) => {
        const y = PAD_T + i * (LANE_H + LANE_GAP);
        root.appendChild(svg('rect', {
            x: PAD_L, y, width: innerW, height: LANE_H, rx: 4, fill: '#f6f7f9',
        }));
        const lb = svg('text', { x: PAD_L - 8, y: y + LANE_H - 5, class: 'sf-lane-label', 'text-anchor': 'end' });
        lb.textContent = '请求 ' + (r.i + 1);
        root.appendChild(lb);

        const cls = r.role === 'follower' ? 'sf-bar-wait'
            : (r.role === 'leader' ? 'sf-bar-lead' : 'sf-bar-solo');
        const bar = svg('rect', {
            x: x(r.arrive), y: y + 1, width: 0, height: LANE_H - 2, rx: 3, class: cls,
        });
        root.appendChild(bar);

        // 角色徽标 + 完成勾，随播放头出现
        const tag = svg('text', { x: x(r.arrive) + 6, y: y + LANE_H - 5.5, class: 'sf-bar-tag', opacity: 0 });
        tag.textContent = r.role === 'follower' ? '等待中（搭车）'
            : (r.role === 'leader' ? '真实调用（领头）' : '真实调用');
        root.appendChild(tag);

        const done = svg('text', { x: x(r.resolve) + 6, y: y + LANE_H - 5.5, class: 'sf-bar-done', opacity: 0 });
        done.textContent = '✓ ' + Math.round(r.waited) + 'ms';
        root.appendChild(done);

        state.bars.push({ el: bar, tag, done, r, x0: x(r.arrive), x1: x(r.resolve) });
    });

    // 后端压力面积图
    const loadTop = PAD_T + lanesH + 14;
    root.appendChild(svg('rect', {
        x: PAD_L, y: loadTop, width: innerW, height: LOAD_H, rx: 5, fill: '#fbfcfd', stroke: '#eef0f3',
    }));
    const ll = svg('text', { x: PAD_L - 8, y: loadTop + 14, class: 'sf-lane-label', 'text-anchor': 'end' });
    ll.textContent = '后端压力';
    root.appendChild(ll);
    const ll2 = svg('text', { x: PAD_L - 8, y: loadTop + 28, class: 'sf-lane-sub', 'text-anchor': 'end' });
    ll2.textContent = '(并发数)';
    root.appendChild(ll2);

    const peak = Math.max(1, state.n);
    const ly = (v) => loadTop + LOAD_H - (v / peak) * (LOAD_H - 8) - 4;

    let d = `M${x(0)} ${ly(0)}`;
    const N = 420;
    for (let k = 0; k <= N; k++) {
        const t = (state.maxTime / N) * k;
        d += `L${x(t).toFixed(1)} ${ly(SF.concurrentAt(sim.flights, t)).toFixed(1)}`;
    }
    d += `L${x(state.maxTime).toFixed(1)} ${ly(0)}Z`;
    root.appendChild(svg('path', { d, class: 'sf-load', fill: accent }));

    const maxConc = Math.max.apply(null, [0].concat(
        Array.from({ length: 200 }, (_, k) => SF.concurrentAt(sim.flights, (state.maxTime / 200) * k))));
    const pk = svg('text', { x: PAD_L + 8, y: loadTop + 15, class: 'sf-peak', fill: accent });
    pk.textContent = '峰值并发 ' + maxConc;
    root.appendChild(pk);

    // 播放头
    const head = svg('line', { x1: x(0), x2: x(0), y1: PAD_T - 8, y2: H - PAD_B, class: 'sf-head' });
    root.appendChild(head);
    state.bars.push({ head: true, el: head, x: x });

    return root;
}

function niceStep(total) {
    const raw = total / 6;
    const pows = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    for (let i = 0; i < pows.length; i++) if (raw <= pows[i]) return pows[i];
    return 5000;
}

// ---------- 动画 ----------

function tick(now) {
    if (!state.playing) return;
    // 切到别的标签页时 rAF 会暂停，回来时 now 会一次跳很大；
    // 夹一下，免得播放头「瞬移」到结尾，动画白播。
    const dt = state.lastFrame ? Math.min(now - state.lastFrame, 50) : 16;
    state.lastFrame = now;
    state.t += dt;

    if (state.t >= state.maxTime) {
        state.t = state.maxTime;
        state.playing = false;
    }
    paint();
    if (state.playing) state.raf = requestAnimationFrame(tick);
    else { state.lastFrame = 0; updatePlayBtn(); }
}

function paint() {
    const t = state.t;
    state.bars.forEach((b) => {
        if (b.head) { const px = b.x(t); b.el.setAttribute('x1', px); b.el.setAttribute('x2', px); return; }
        const { r, x0, x1 } = b;
        const w = Math.max(0, Math.min(t, r.resolve) - r.arrive) / (r.resolve - r.arrive) * (x1 - x0);
        b.el.setAttribute('width', Math.max(0, w).toFixed(2));
        b.tag.setAttribute('opacity', (t > r.arrive && w > 92) ? 1 : 0);
        b.done.setAttribute('opacity', t >= r.resolve ? 1 : 0);
    });
    paintLive();
}

function paintLive() {
    const t = state.t;
    const d = state.dom;
    if (!d.liveSF) return;

    const sfWait = SF.waitersAt(state.simSF, t);
    const sfConc = SF.concurrentAt(state.simSF.flights, t);
    const noConc = SF.concurrentAt(state.simNo.flights, t);
    const flight = state.simSF.flights.find((f) => f.start <= t && t < f.end);

    d.liveClock.textContent = Math.round(t) + ' ms';
    d.liveSF.textContent = sfConc;
    d.liveNo.textContent = noConc;
    d.liveWait.textContent = Math.max(sfWait - sfConc, 0);
    d.mapState.innerHTML = flight
        ? `g.m = { <b>"user:42"</b> → &call{ dups: <b>${flight.followers.filter((i) => state.simSF.reqs[i].arrive <= t).length}</b> } }`
        : 'g.m = { }　<i>（没有正在飞行的调用，下一个请求会自己起飞）</i>';
}

function updatePlayBtn() {
    if (state.dom.playBtn) {
        state.dom.playBtn.innerHTML = state.playing
            ? '<i class="fas fa-pause"></i> 暂停'
            : (state.t >= state.maxTime ? '<i class="fas fa-rotate-left"></i> 重放' : '<i class="fas fa-play"></i> 播放');
    }
}

function play() {
    if (state.t >= state.maxTime) state.t = 0;
    state.playing = true;
    state.lastFrame = 0;
    updatePlayBtn();
    state.raf = requestAnimationFrame(tick);
}

function stop() {
    state.playing = false;
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    state.lastFrame = 0;
}

// ---------- 渲染 ----------

let rootEl = null;

function render(autoplay) {
    if (!rootEl) return;
    stop();
    build();
    state.bars = [];
    state.t = 0;
    rootEl.innerHTML = '';

    const sfCalls = state.simSF.backendCalls, noCalls = state.simNo.backendCalls;
    const saved = noCalls > 0 ? Math.round((1 - sfCalls / noCalls) * 100) : 0;

    // 场景
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-people-group"></i> 场景：缓存刚失效，一堆请求同时来要同一个 key' }),
        h('p.sec-note', {
            html: '把它想成 <code>user:42</code> 的缓存刚过期。'
                + `${state.n} 个请求在 ${state.spreadMs}ms 内陆续到达，每次真实查库要 ${state.backendMs}ms。`
                + '<b>单飞锁的作用：让其中一个去查，其余人原地等它的结果。</b>',
        }),
        buildControls()
    ));

    // 双时间轴对照
    const panels = h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-bars-staggered"></i> 同一批请求，两种结果' }),
        h('p.sec-note', {
            html: '<span class="k k-lead"></span>实心 = 真的在查库　'
                + '<span class="k k-wait"></span>斜纹 = 在等别人的结果（没碰后端）　'
                + '<span class="k k-solo"></span>橙色 = 各查各的',
        })
    );
    panels.appendChild(h('div.sf-panel', null, buildPanel(state.simSF, '用了单飞锁 singleflight.Do', '#4f46e5')));
    panels.appendChild(h('div.sf-panel', null, buildPanel(state.simNo, '没用单飞锁', '#f97316')));
    rootEl.appendChild(panels);

    // 实时状态
    const live = h('div.sf-live');
    const cell = (label, ref, cls) => {
        const v = h('b.live-val' + (cls ? '.' + cls : ''), { text: '0' });
        state.dom[ref] = v;
        return h('div.live-cell', null, h('span.live-label', { text: label }), v);
    };
    const clock = h('b.live-val', { text: '0 ms' });
    state.dom.liveClock = clock;
    live.appendChild(h('div.live-cell', null, h('span.live-label', { text: '时间' }), clock));
    live.appendChild(cell('用单飞 · 后端并发', 'liveSF', 'ok'));
    live.appendChild(cell('不用单飞 · 后端并发', 'liveNo', 'bad'));
    live.appendChild(cell('正在搭车等待', 'liveWait'));

    const mapState = h('code.sf-map', { html: 'g.m = { }' });
    state.dom.mapState = mapState;

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-gauge-high"></i> 播放时的实时状态' }),
        live,
        h('p.sec-note', { html: '内部那张 map（<code>g.m</code>）此刻长这样：' }),
        mapState
    ));

    // 结果对比
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-scale-balanced"></i> 结果对比' }),
        h('div.sf-compare', null,
            h('div.cmp.cmp-ok', null,
                h('div.cmp-h', { text: '用了单飞锁' }),
                h('div.cmp-v', { text: sfCalls + ' 次' }),
                h('div.cmp-d', { text: '后端真实调用' })),
            h('div.cmp.cmp-bad', null,
                h('div.cmp-h', { text: '没用单飞锁' }),
                h('div.cmp-v', { text: noCalls + ' 次' }),
                h('div.cmp-d', { text: '后端真实调用' })),
            h('div.cmp.cmp-save', null,
                h('div.cmp-h', { text: '省掉' }),
                h('div.cmp-v', { text: saved + '%' }),
                h('div.cmp-d', { text: '的数据库压力' }))
        ),
        h('p.sec-note', {
            html: sfCalls > 1
                ? `注意这里单飞也发了 <b>${sfCalls}</b> 次 —— 因为请求到达跨度（${state.spreadMs}ms）超过了一次调用的耗时（${state.backendMs}ms），`
                  + '晚到的请求没赶上那班车，只能重新起飞。<b>单飞只合并「同时在飞」的请求，不是缓存。</b>'
                : '所有请求都落在同一次调用的飞行窗口内，于是只打了后端 1 次。'
                  + '把「到达分散」拉大或把「后端耗时」调小，就能看到合并窗口被错过的情况。',
        })
    ));

    // 流程
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list-ol"></i> Do() 内部这一趟怎么走' }),
        buildFlow()
    ));

    // 注意事项
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-triangle-exclamation"></i> 用之前必须知道的四个坑' }),
        buildPitfalls()
    ));

    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '对应 Go 官方扩展库 <code>golang.org/x/sync/singleflight</code> 的 <code>Group.Do</code>。'
                + '中文社区一般叫它「单飞」，最常见的用途是防<b>缓存击穿</b>：'
                + '热点 key 一过期，成百上千个请求同时穿透到数据库，用单飞把它们合并成一次。',
        }),
        h('p', {
            html: '这里的时间是等比例模拟的，请求到达时刻是均匀铺开的固定值（不用随机数，保证两条时间轴严格可对照）。',
        })
    ));

    updatePlayBtn();
    paint();
    if (autoplay) play();
}

function buildControls() {
    const box = h('div.controls');
    const slider = (label, key, min, max, step, fmt) => {
        const val = h('b.ctl-val', { text: fmt(state[key]) });
        return h('label.ctl', null,
            h('span.ctl-name', { text: label }),
            h('input', {
                type: 'range', min: String(min), max: String(max), step: String(step),
                value: String(state[key]),
                oninput: (e) => {
                    state[key] = Number(e.target.value);
                    val.textContent = fmt(state[key]);
                    render(false);
                },
            }),
            val
        );
    };
    box.appendChild(slider('并发请求数', 'n', 2, 12, 1, (v) => v + ' 个'));
    box.appendChild(slider('后端耗时', 'backendMs', 100, 1500, 50, (v) => v + ' ms'));
    box.appendChild(slider('到达分散', 'spreadMs', 0, 1500, 20, (v) => v + ' ms'));

    const play0 = h('button.mini.primary', { onclick: () => (state.playing ? (stop(), updatePlayBtn()) : play()) },
        h('i.fas.fa-play'), ' 播放');
    state.dom.playBtn = play0;
    box.appendChild(h('div.ctl-btns', null, play0,
        h('button.mini', { onclick: () => render(true) }, '重来')));
    return box;
}

function buildFlow() {
    const steps = [
        {
            t: '① 请求 1 到达，先抢锁看 map 里有没有这个 key',
            f: 'g.mu.Lock()\nif c, ok := g.m[key]; ok { … }   // 没有',
            r: 'map 是空的 → 它成为「领头的」',
        },
        {
            t: '② 领头的建一个 call、把 WaitGroup 计数加 1、登记进 map，然后放锁',
            f: 'c := new(call)\nc.wg.Add(1)\ng.m[key] = c\ng.mu.Unlock()',
            r: '锁只保护那张 map，马上就放开了',
        },
        {
            t: '③ 领头的在锁外执行真实调用',
            f: 'c.val, c.err = fn()      // ← 注意：不持锁',
            r: `真去查库，耗时 ${state.backendMs}ms`,
            hi: '这是整个设计的关键：如果在锁里调 fn()，就退化成串行排队了，后面的人一个个轮流查库，什么也没省下。',
        },
        {
            t: '④ 这期间到达的相同 key 请求，发现 map 里已经有了，dups++ 然后阻塞等待',
            f: 'c.dups++\ng.mu.Unlock()\nc.wg.Wait()              // 挂在这里，完全没碰后端',
            r: `${Math.max(state.simSF.reqs.filter((r) => r.role === 'follower').length, 0)} 个请求在等，后端压力仍是 1`,
        },
        {
            t: '⑤ 调用返回，唤醒所有等待者，并把 key 从 map 删掉',
            f: 'c.wg.Done()\ng.mu.Lock()\ndelete(g.m, key)\ng.mu.Unlock()',
            r: '全员同时拿到同一个结果（shared = true）',
        },
        {
            t: '⑥ key 已删除 —— 此后再来的请求会重新起飞',
            f: '// 合并窗口 = fn() 执行的那段时间，仅此而已',
            r: '所以单飞不是缓存，它只压缩「同时在飞」的那一撮',
        },
    ];

    const box = h('div.flow');
    steps.forEach((s, i) => {
        const body = h('div.flow-body', null,
            h('div.flow-title', { text: s.t }),
            h('code.flow-formula', { text: s.f }),
            h('div.flow-result', { text: s.r })
        );
        if (s.hi) body.appendChild(h('div.flow-hi', { text: s.hi }));
        box.appendChild(h('div.flow-step.lit', null, h('div.flow-num', { text: String(i + 1) }), body));
    });
    return box;
}

function buildPitfalls() {
    const items = [
        ['所有人拿到的是同一个值', '返回的 <code>val</code> 是同一个引用。如果它是 map 或指针，某个调用方改了它，其他人手里的数据跟着变，还会 data race。要么返回副本，要么约定只读。'],
        ['领头的失败，全员一起失败', '共享结果也共享错误。一次抖动会让这一批请求全部报错。真正需要重试的话，得在 Do 外面做，或者用 <code>Forget</code> 让下一批重新起飞。'],
        ['领头的卡住，全员一起卡住', '等待者被 <code>wg.Wait()</code> 挂着，没有超时。想要能超时就用 <code>DoChan</code> 拿 channel，再配 <code>select</code> + <code>context</code>。'],
        ['它不是缓存，别当缓存用', '合并窗口只有 <code>fn()</code> 执行的那一瞬。调用一结束 key 就被删了，下一个请求照样打后端。真要挡住持续流量，还是得有真正的缓存层，单飞只负责削掉「同一时刻」的重复。'],
    ];
    const box = h('div.pitfalls');
    items.forEach((it, i) => {
        box.appendChild(h('div.pit', null,
            h('div.pit-n', { text: String(i + 1) }),
            h('div.pit-body', null,
                h('div.pit-t', { text: it[0] }),
                h('div.pit-d', { html: it[1] })
            )
        ));
    });
    return box;
}

Viz.register({
    id: 'singleflight',
    cat: 'cache',
    title: '单飞锁 singleflight',
    subtitle: '并发相同请求合并为一次',
    icon: 'fa-layer-group',
    blurb: '一堆请求同时要同一个 key，怎么让后端只被打一次',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        state.n = 8; state.backendMs = 600; state.spreadMs = 240;
        render(true);
    },
    unmount() {
        stop();
        state.bars = [];
        state.dom = {};
        rootEl = null;
    },
});

})();
