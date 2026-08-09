// ============================================================
//  演示：FSRS 间隔重复算法
//  公式依据 FSRS-5（19 个参数），逐条对照参考实现 py-fsrs 核对：
//  https://github.com/open-spaced-repetition/py-fsrs
//  下半部分是界面，上半部分 FSRS.* 是纯函数，不碰 DOM，可单独测。
// ============================================================

(function () {

// ---------- 一、模型（纯函数）----------

const FSRS = {
    // FSRS-5 默认参数 w0..w18
    DEFAULT_W: [
        0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
        1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
        2.9898, 0.51655, 0.6621,
    ],
    DECAY: -0.5,
    STABILITY_MIN: 0.001,
    GRADES: [
        { g: 1, key: 'again', label: '忘记了', en: 'Again', color: '#ef4444' },
        { g: 2, key: 'hard', label: '有点难', en: 'Hard', color: '#f59e0b' },
        { g: 3, key: 'good', label: '记住了', en: 'Good', color: '#10b981' },
        { g: 4, key: 'easy', label: '很简单', en: 'Easy', color: '#3b82f6' },
    ],
};

// FACTOR 由 DECAY 推出，作用是让「t = S 时 R 恰好 = 90%」成立
FSRS.FACTOR = Math.pow(0.9, 1 / FSRS.DECAY) - 1;   // = 19/81 ≈ 0.234568

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/** 遗忘曲线：过了 t 天之后还记得的概率 */
FSRS.retrievability = function (t, S) {
    if (S <= 0) return 0;
    return Math.pow(1 + FSRS.FACTOR * (t / S), FSRS.DECAY);
};

/** 由稳定度和目标保留率反推间隔：R 掉到目标值需要多少天 */
FSRS.interval = function (desiredRetention, S) {
    return (S / FSRS.FACTOR) * (Math.pow(desiredRetention, 1 / FSRS.DECAY) - 1);
};

/** 首次学习的稳定度：直接取 w0..w3 */
FSRS.initialStability = function (w, G) {
    return Math.max(w[G - 1], FSRS.STABILITY_MIN);
};

/** 首次学习的难度 */
FSRS.initialDifficulty = function (w, G) {
    return clamp(w[4] - Math.exp(w[5] * (G - 1)) + 1, 1, 10);
};

/** 难度更新：先按评分偏移，再线性阻尼（越难越难再变难），最后向「Easy 的初始难度」回归 */
FSRS.nextDifficulty = function (w, D, G) {
    const deltaD = -w[6] * (G - 3);
    const linearDamping = ((10 - D) * deltaD) / 9;
    const meanReversion = w[7] * FSRS.initialDifficulty(w, 4) + (1 - w[7]) * (D + linearDamping);
    return clamp(meanReversion, 1, 10);
};

/** 答对时的新稳定度：难度越低、当前 R 越低、原稳定度越小，涨得越多 */
FSRS.recallStability = function (w, D, S, R, G) {
    const hardPenalty = G === 2 ? w[15] : 1;
    const easyBonus = G === 4 ? w[16] : 1;
    const inc = Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9])
        * (Math.exp((1 - R) * w[10]) - 1) * hardPenalty * easyBonus;
    return Math.max(S * (1 + inc), FSRS.STABILITY_MIN);
};

/** 答错（遗忘）后的新稳定度；上限是「同日再答对一次」能到的水平 */
FSRS.forgetStability = function (w, D, S, R) {
    const raw = w[11] * Math.pow(D, -w[12]) * (Math.pow(S + 1, w[13]) - 1)
        * Math.exp((1 - R) * w[14]);
    const cap = S / Math.exp(w[17] * w[18]);
    return Math.max(Math.min(raw, cap), FSRS.STABILITY_MIN);
};

/** 同一天内再复习（短期记忆）走这条 */
FSRS.shortTermStability = function (w, S, G) {
    return Math.max(S * Math.exp(w[17] * (G - 3 + w[18])), FSRS.STABILITY_MIN);
};

/**
 * 走一次复习。card 为 null 表示新卡（首次学习）。
 * 返回 { card, steps } —— steps 是给流程图用的分步说明。
 */
FSRS.review = function (w, card, G, elapsedDays) {
    if (!card) {
        const S = FSRS.initialStability(w, G);
        const D = FSRS.initialDifficulty(w, G);
        return { card: { D, S }, R: null, first: true };
    }
    const R = FSRS.retrievability(elapsedDays, card.S);
    const D = FSRS.nextDifficulty(w, card.D, G);
    let S;
    if (elapsedDays < 1) {
        S = FSRS.shortTermStability(w, card.S, G);
    } else if (G === 1) {
        S = FSRS.forgetStability(w, card.D, card.S, R);
    } else {
        S = FSRS.recallStability(w, card.D, card.S, R, G);
    }
    return { card: { D, S }, R, first: false };
};

// 供 Node 单测使用
if (typeof module !== 'undefined' && module.exports) module.exports = FSRS;
if (typeof window !== 'undefined') window.FSRSModel = FSRS;

// ---------- 二、界面 ----------

if (typeof window === 'undefined' || !window.Viz) return;

const h = Viz.h, svg = Viz.svg, esc = Viz.esc, fmtDays = Viz.fmtDays;

const state = {
    w: FSRS.DEFAULT_W.slice(),
    desiredRetention: 0.9,
    card: null,
    today: 0,
    dueDay: 0,
    history: [],
    delayFactor: 1,
    prevCard: null,
    timers: [],
};

function reset() {
    state.card = null;
    state.prevCard = null;
    state.today = 0;
    state.dueDay = 0;
    state.history = [];
    state.delayFactor = 1;
}

function nextInterval() {
    if (!state.card) return 0;
    return FSRS.interval(state.desiredRetention, state.card.S);
}

/** 计划间隔 × 提前/推迟系数 = 实际经过的天数 */
function plannedElapsed() {
    return Math.max(nextInterval() * state.delayFactor, 0);
}

function doReview(G) {
    const w = state.w;
    const elapsed = state.card ? plannedElapsed() : 0;
    const before = state.card ? { D: state.card.D, S: state.card.S } : null;
    const res = FSRS.review(w, state.card, G, elapsed);

    state.prevCard = before;
    state.card = res.card;
    state.today = state.today + elapsed;
    const iv = nextInterval();
    state.dueDay = state.today + iv;

    state.history.push({
        n: state.history.length + 1,
        day: state.today,
        grade: G,
        elapsed,
        R: res.R,
        first: res.first,
        Dbefore: before ? before.D : null,
        Sbefore: before ? before.S : null,
        D: res.card.D,
        S: res.card.S,
        interval: iv,
    });

    render();
    animateFlow();
}

// ---------- 遗忘曲线 ----------

function buildCurve() {
    const W = 760, H = 268, PAD_L = 56, PAD_R = 24, PAD_T = 18, PAD_B = 42;
    const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;

    const iv = nextInterval();
    // 取 5 倍间隔：既能看出曲线真的在往下掉（约掉到 68%），
    // 又不至于把「下次复习」那个交点挤到最左边看不清。
    const xMax = Math.max(iv * 5, 1);
    const x = (t) => PAD_L + (t / xMax) * innerW;
    const y = (r) => PAD_T + (1 - r) * innerH;

    const root = svg('svg', {
        viewBox: `0 0 ${W} ${H}`, class: 'fsrs-svg',
        preserveAspectRatio: 'xMidYMid meet', role: 'img',
        'aria-label': '遗忘曲线',
    });

    // 网格 + Y 轴刻度
    [0, 0.2, 0.4, 0.6, 0.8, 1].forEach((r) => {
        root.appendChild(svg('line', {
            x1: PAD_L, x2: W - PAD_R, y1: y(r), y2: y(r),
            stroke: '#e5e7eb', 'stroke-width': 1,
        }));
        const lb = svg('text', { x: PAD_L - 10, y: y(r) + 4, class: 'axis-label', 'text-anchor': 'end' });
        lb.textContent = Math.round(r * 100) + '%';
        root.appendChild(lb);
    });

    // X 轴刻度
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
        const t = (xMax / ticks) * i;
        root.appendChild(svg('line', {
            x1: x(t), x2: x(t), y1: PAD_T, y2: PAD_T + innerH,
            stroke: '#f3f4f6', 'stroke-width': 1,
        }));
        const lb = svg('text', { x: x(t), y: H - PAD_B + 20, class: 'axis-label', 'text-anchor': 'middle' });
        lb.textContent = t < 10 ? t.toFixed(1) : Math.round(t);
        root.appendChild(lb);
    }
    const xTitle = svg('text', { x: PAD_L + innerW / 2, y: H - 6, class: 'axis-title', 'text-anchor': 'middle' });
    xTitle.textContent = '距离这次复习过去的天数';
    root.appendChild(xTitle);

    const curveD = (S) => {
        let d = '';
        const N = 240;
        for (let i = 0; i <= N; i++) {
            const t = (xMax / N) * i;
            const r = FSRS.retrievability(t, S);
            d += (i ? 'L' : 'M') + x(t).toFixed(2) + ' ' + y(r).toFixed(2);
        }
        return d;
    };
    const path = (S, cls) => svg('path', { d: curveD(S), class: cls, fill: 'none' });

    // 曲线下方填色：让「还记得多少」这块面积可读，顺带填掉大片空白
    const defs = svg('defs');
    const grad = svg('linearGradient', { id: 'fsrsFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svg('stop', { offset: '0%', 'stop-color': '#4f46e5', 'stop-opacity': '0.20' }));
    grad.appendChild(svg('stop', { offset: '100%', 'stop-color': '#4f46e5', 'stop-opacity': '0.02' }));
    defs.appendChild(grad);
    root.appendChild(defs);

    if (!state.card) {
        const tip = svg('text', { x: PAD_L + innerW / 2, y: PAD_T + innerH / 2, class: 'curve-empty', 'text-anchor': 'middle' });
        tip.textContent = '这是一张还没学过的新卡片 —— 先在下面给它评个分';
        root.appendChild(tip);
        return root;
    }

    // 面积 → 上一次的曲线（虚线，用来对比「这次复习把曲线拉平了多少」）→ 这次的曲线
    root.appendChild(svg('path', {
        d: curveD(state.card.S) + `L${x(xMax).toFixed(2)} ${y(0).toFixed(2)}L${x(0).toFixed(2)} ${y(0).toFixed(2)}Z`,
        fill: 'url(#fsrsFill)', stroke: 'none',
    }));
    if (state.prevCard) root.appendChild(path(state.prevCard.S, 'curve-prev'));
    root.appendChild(path(state.card.S, 'curve-now'));

    // 目标保留率横线
    const dr = state.desiredRetention;
    root.appendChild(svg('line', {
        x1: PAD_L, x2: W - PAD_R, y1: y(dr), y2: y(dr),
        class: 'line-target',
    }));
    const drLabel = svg('text', { x: W - PAD_R - 4, y: y(dr) - 8, class: 'target-label', 'text-anchor': 'end' });
    drLabel.textContent = `目标保留率 ${(dr * 100).toFixed(0)}%`;
    root.appendChild(drLabel);

    // 交点 = 下次复习时间
    const iv2 = nextInterval();
    if (iv2 <= xMax) {
        root.appendChild(svg('line', {
            x1: x(iv2), x2: x(iv2), y1: y(dr), y2: PAD_T + innerH, class: 'line-due',
        }));
        root.appendChild(svg('circle', { cx: x(iv2), cy: y(dr), r: 6, class: 'dot-due' }));
        const t1 = svg('text', { x: x(iv2), y: y(dr) - 16, class: 'due-label', 'text-anchor': 'middle' });
        t1.textContent = '下次复习 · ' + fmtDays(iv2);
        root.appendChild(t1);
    }

    // 稳定度 S 的位置（R = 90% 处），点明 S 的定义
    const S = state.card.S;
    if (S <= xMax && Math.abs(dr - 0.9) > 0.005) {
        root.appendChild(svg('circle', { cx: x(S), cy: y(0.9), r: 4, class: 'dot-s' }));
        const t2 = svg('text', { x: x(S), y: y(0.9) - 10, class: 's-label', 'text-anchor': 'middle' });
        t2.textContent = 'S = ' + fmtDays(S);
        root.appendChild(t2);
    }

    return root;
}

// ---------- 流程步骤 ----------

function buildFlow() {
    const box = h('div.flow');
    const last = state.history[state.history.length - 1];

    if (!last) {
        box.appendChild(h('p.flow-empty', {
            text: '点下面任意一个评分，这里会一步一步拆开 FSRS 算下次复习时间的全过程。',
        }));
        return box;
    }

    const gm = FSRS.GRADES.find((x) => x.g === last.grade);
    const w = state.w;
    const steps = [];

    if (last.first) {
        steps.push({
            t: '首次学习，直接查表定初始值',
            f: `S₀(${last.grade}) = w${last.grade - 1} = ${w[last.grade - 1]}`,
            r: `稳定度 S = ${last.S.toFixed(2)} 天`,
        });
        steps.push({
            t: '初始难度由评分算出',
            f: `D₀(G) = w₄ − e^(w₅·(G−1)) + 1 = ${w[4]} − e^(${w[5]}×${last.grade - 1}) + 1`,
            r: `难度 D = ${last.D.toFixed(2)} / 10`,
        });
    } else {
        steps.push({
            t: `距上次复习过了 ${fmtDays(last.elapsed)}，先算此刻还记得多少`,
            f: `R = (1 + ${FSRS.FACTOR.toFixed(4)} × t/S)^${FSRS.DECAY} = (1 + ${FSRS.FACTOR.toFixed(4)} × ${last.elapsed.toFixed(2)}/${last.Sbefore.toFixed(2)})^${FSRS.DECAY}`,
            r: `复习前的记忆保持率 R = ${(last.R * 100).toFixed(1)}%`,
        });
        steps.push({
            t: `你的评分是「${gm.label}」(G = ${last.grade})，更新难度`,
            f: `ΔD = −w₆·(G−3) = ${(-w[6] * (last.grade - 3)).toFixed(4)}　→　线性阻尼 + 向 D₀(Easy) 回归`,
            r: `D: ${last.Dbefore.toFixed(2)} → ${last.D.toFixed(2)}`,
        });
        if (last.elapsed < 1) {
            steps.push({
                t: '同一天内的复习，走短期记忆公式',
                f: `S' = S · e^(w₁₇·(G−3+w₁₈))`,
                r: `S: ${last.Sbefore.toFixed(2)} → ${last.S.toFixed(2)} 天`,
            });
        } else if (last.grade === 1) {
            steps.push({
                t: '答错了 —— 走遗忘分支，稳定度大幅回落',
                f: `S' = w₁₁·D^(−w₁₂)·((S+1)^w₁₃ − 1)·e^((1−R)·w₁₄)，再取 min(·, S/e^(w₁₇w₁₈))`,
                r: `S: ${last.Sbefore.toFixed(2)} → ${last.S.toFixed(2)} 天`,
            });
        } else {
            steps.push({
                t: last.grade === 2
                    ? '「有点难」在 FSRS 里也算答对（只有 Again 才是遗忘）—— 稳定度仍增长，但有 w₁₅ 惩罚'
                    : '答对了 —— 稳定度增长',
                f: `S' = S·(1 + e^w₈·(11−D)·S^(−w₉)·(e^((1−R)·w₁₀) − 1)·惩罚·奖励)`,
                r: `S: ${last.Sbefore.toFixed(2)} → ${last.S.toFixed(2)} 天（×${(last.S / last.Sbefore).toFixed(2)}）`,
            });
        }
    }

    steps.push({
        t: `由新的 S 和目标保留率 ${(state.desiredRetention * 100).toFixed(0)}% 反推间隔`,
        f: `I = S/${FSRS.FACTOR.toFixed(4)} × (${state.desiredRetention.toFixed(2)}^(1/${FSRS.DECAY}) − 1)`,
        r: `下次间隔 = ${fmtDays(last.interval)}`,
    });
    steps.push({
        t: '排进日程',
        f: `下次复习日 = 今天(第 ${last.day.toFixed(1)} 天) + ${last.interval.toFixed(1)} 天`,
        r: `第 ${state.dueDay.toFixed(1)} 天`,
    });

    steps.forEach((s, i) => {
        box.appendChild(h('div.flow-step',
            { 'data-i': i },
            h('div.flow-num', { text: String(i + 1) }),
            h('div.flow-body', null,
                h('div.flow-title', { text: s.t }),
                h('code.flow-formula', { text: s.f }),
                h('div.flow-result', { text: s.r })
            )
        ));
    });

    return box;
}

function animateFlow() {
    state.timers.forEach(clearTimeout);
    state.timers = [];
    const steps = document.querySelectorAll('.fsrs-root .flow-step');
    steps.forEach((el, i) => {
        el.classList.remove('lit');
        state.timers.push(setTimeout(() => el.classList.add('lit'), 90 * i));
    });
}

// ---------- 时间轴 ----------

function buildTimeline() {
    const box = h('div.timeline');
    if (!state.history.length) {
        box.appendChild(h('p.flow-empty', { text: '复习记录会画在这里，能直观看到间隔怎么被一点点拉长。' }));
        return box;
    }
    const maxIv = Math.max.apply(null, state.history.map((r) => r.interval));
    state.history.forEach((r) => {
        const gm = FSRS.GRADES.find((x) => x.g === r.grade);
        // 开方压缩：早期几小时的间隔和后期几年的间隔能同框看
        const pct = Math.max(Math.sqrt(r.interval / maxIv) * 100, 3);
        box.appendChild(h('div.tl-row', null,
            h('div.tl-n', { text: '#' + r.n }),
            h('div.tl-grade', { style: `background:${gm.color}`, title: gm.en, text: gm.label }),
            h('div.tl-bar-wrap', null,
                h('div.tl-bar', { style: `width:${pct.toFixed(1)}%;background:${gm.color}` })
            ),
            h('div.tl-iv', { text: fmtDays(r.interval) }),
            h('div.tl-s', { text: 'S ' + r.S.toFixed(1) + ' · D ' + r.D.toFixed(1) })
        ));
    });
    return box;
}

// ---------- 状态卡 ----------

function buildStats() {
    const box = h('div.stats');
    const c = state.card;
    const stat = (cls, name, en, val, desc) => h('div.stat.' + cls, null,
        h('div.stat-name', null, h('b', { text: name }), h('small', { text: en })),
        h('div.stat-val', { text: val }),
        h('div.stat-desc', { text: desc })
    );

    box.appendChild(stat('s-d', '难度', 'Difficulty',
        c ? c.D.toFixed(2) + ' / 10' : '—',
        '这张卡本身有多难记。越高，同样答对涨的稳定度越少。'));
    box.appendChild(stat('s-s', '稳定度', 'Stability',
        c ? fmtDays(c.S) : '—',
        '记忆能撑多久：记忆保持率从 100% 掉到 90% 所需的天数。'));
    box.appendChild(stat('s-r', '当前保持率', 'Retrievability',
        c ? (FSRS.retrievability(0, c.S) * 100).toFixed(0) + '%' : '—',
        '此刻能想起来的概率。刚复习完是 100%，随时间沿曲线下滑。'));
    return box;
}

// ---------- 装配 ----------

let rootEl = null;

function render() {
    if (!rootEl) return;
    rootEl.innerHTML = '';

    const c = state.card;
    const iv = nextInterval();

    // 顶部：当前状态
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-brain"></i> 记忆状态：FSRS 用三个数描述一张卡片' }),
        buildStats()
    ));

    // 曲线
    const chart = h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-chart-line"></i> 遗忘曲线：什么时候该复习' }),
        h('p.sec-note', {
            html: state.prevCard
                ? '实线是这次复习后的新曲线，<b>灰色虚线是上一次的</b> —— 曲线被压平了多少，就是这次复习的收益。'
                : '曲线掉到「目标保留率」那条横线时，就是 FSRS 安排的下次复习时间。',
        }),
        buildCurve()
    );
    rootEl.appendChild(chart);

    // 评分按钮 + 控制
    const grades = h('div.grades');
    FSRS.GRADES.forEach((gm) => {
        const preview = c ? previewInterval(gm.g) : FSRS.interval(state.desiredRetention, FSRS.initialStability(state.w, gm.g));
        grades.appendChild(h('button.grade-btn', {
            style: `--gc:${gm.color}`,
            onclick: () => doReview(gm.g),
        },
            h('span.g-label', { text: gm.label }),
            h('span.g-en', { text: gm.en }),
            h('span.g-iv', { text: '→ ' + fmtDays(preview) })
        ));
    });

    const controls = h('div.controls');
    controls.appendChild(h('label.ctl', null,
        h('span.ctl-name', { text: '目标保留率' }),
        h('input', {
            type: 'range', min: '70', max: '98', step: '1',
            value: String(Math.round(state.desiredRetention * 100)),
            oninput: (e) => { state.desiredRetention = Number(e.target.value) / 100; render(); },
        }),
        h('b.ctl-val', { text: (state.desiredRetention * 100).toFixed(0) + '%' })
    ));
    controls.appendChild(h('label.ctl', null,
        h('span.ctl-name', { text: '实际复习时机' }),
        h('input', {
            type: 'range', min: '30', max: '250', step: '5',
            value: String(Math.round(state.delayFactor * 100)),
            oninput: (e) => { state.delayFactor = Number(e.target.value) / 100; render(); },
        }),
        h('b.ctl-val', {
            text: state.delayFactor === 1 ? '准时'
                : (state.delayFactor < 1 ? '提前 ' : '推迟 ') + Math.abs(Math.round((state.delayFactor - 1) * 100)) + '%',
        })
    ));
    controls.appendChild(h('div.ctl-btns', null,
        h('button.mini', { onclick: () => { autoRun(8); } }, '自动复习 8 次'),
        h('button.mini.danger', { onclick: () => { reset(); render(); } }, '重置')
    ));

    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-hand-pointer"></i> 复习一次：给这张卡打个分' }),
        h('p.sec-note', {
            text: c
                ? `按钮上的时间是「如果这次这么评分，下次会隔多久」。当前已复习 ${state.history.length} 次，累计到第 ${state.today.toFixed(1)} 天。`
                : '这是一张新卡。第一次评分决定它的初始稳定度和难度。',
        }),
        grades, controls
    ));

    // 流程
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-list-ol"></i> 这一步算法做了什么' }),
        buildFlow()
    ));

    // 时间轴
    rootEl.appendChild(h('section.card', null,
        h('h3.sec-title', { html: '<i class="fas fa-timeline"></i> 复习历史：间隔怎么被拉长的' }),
        buildTimeline()
    ));

    // 说明
    rootEl.appendChild(h('section.card.foot-note', null,
        h('h3.sec-title', { html: '<i class="fas fa-circle-info"></i> 关于这个演示' }),
        h('p', {
            html: '公式采用 <b>FSRS-5</b>（19 个参数），逐条对照参考实现 '
                + '<a href="https://github.com/open-spaced-repetition/py-fsrs" target="_blank" rel="noopener noreferrer">py-fsrs</a> 核对。'
                + '这里用的是官方默认参数；真实使用中 FSRS 会用你自己的复习历史训练出一套专属参数。',
        }),
        h('p', {
            html: '常数：<code>DECAY = −0.5</code>，<code>FACTOR = 0.9^(1/DECAY) − 1 = 19/81 ≈ 0.2346</code>。'
                + 'FACTOR 的作用是让「t = S 时 R 恰好等于 90%」成立 —— 这正是稳定度 S 的定义。',
        })
    ));
}

/** 试算：如果这次评分是 G，下次间隔会是多久（不改状态）*/
function previewInterval(G) {
    const elapsed = plannedElapsed();
    const res = FSRS.review(state.w, state.card, G, elapsed);
    return FSRS.interval(state.desiredRetention, res.card.S);
}

/** 自动复习：85% 概率答对，模拟真实使用 */
function autoRun(n) {
    for (let i = 0; i < n; i++) {
        const c = state.card;
        const R = c ? FSRS.retrievability(plannedElapsed(), c.S) : 1;
        // 答对与否按当下的记忆保持率抽样，接近真实行为
        const recalled = Math.random() < (c ? R : 1);
        const G = recalled ? (Math.random() < 0.22 ? 2 : (Math.random() < 0.85 ? 3 : 4)) : 1;
        doReview(G);
    }
}

Viz.register({
    id: 'fsrs',
    cat: 'algo',
    title: 'FSRS 间隔重复算法',
    subtitle: 'Free Spaced Repetition Scheduler',
    icon: 'fa-brain',
    blurb: '一张卡片被复习一次，算法是怎么算出「下次什么时候再看」的',
    mount(container) {
        rootEl = h('div.fsrs-root');
        container.appendChild(rootEl);
        reset();
        render();
    },
    unmount() {
        state.timers.forEach(clearTimeout);
        state.timers = [];
        rootEl = null;
    },
});

})();
