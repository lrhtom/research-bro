// ============================================================
//  可视化演示 · 外壳
//  演示模块往 Viz 上注册自己；外壳负责「分类折叠导航」与挂载/卸载。
//  这里还放了各演示共用的 UI 构件（卡片/流程/滑块/对比格），
//  这样每个演示文件只需要专心写它自己的模型和图。
//  纯静态、无框架、无 ES module —— 普通 <script> 顺序加载，file:// 可用。
// ============================================================

window.Viz = {
    demos: [],
    currentId: null,
    openCats: null,     // Set，展开着的分类
    dom: {},
};

// 侧边栏分类（顺序即显示顺序）
Viz.categories = [
    { id: 'net', name: '计算机网络', icon: 'fa-network-wired' },
    { id: 'db', name: '数据库', icon: 'fa-database' },
    { id: 'cache', name: '缓存与并发', icon: 'fa-bolt' },
    { id: 'algo', name: '算法与其它', icon: 'fa-shapes' },
];

/**
 * 注册一个演示。
 * demo = { id, cat, title, subtitle, icon, blurb, tags[], mount(container), unmount() }
 */
Viz.register = function (demo) {
    Viz.demos.push(demo);
};

Viz.esc = function (str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
};

// ---------- 导航 ----------

Viz.loadOpenCats = function () {
    if (Viz.openCats) return Viz.openCats;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('viz_open_cats')); } catch (e) { /* 忽略 */ }
    Viz.openCats = new Set(Array.isArray(saved) ? saved : []);
    return Viz.openCats;
};

Viz.saveOpenCats = function () {
    try { localStorage.setItem('viz_open_cats', JSON.stringify([...Viz.openCats])); } catch (e) { /* 忽略 */ }
};

Viz.toggleCat = function (catId) {
    const open = Viz.loadOpenCats();
    if (open.has(catId)) open.delete(catId); else open.add(catId);
    Viz.saveOpenCats();
    Viz.renderNav();
};

Viz.renderNav = function () {
    const nav = Viz.dom.navList;
    if (!nav) return;
    const open = Viz.loadOpenCats();
    nav.innerHTML = '';

    Viz.categories.forEach((cat) => {
        const items = Viz.demos.filter((d) => d.cat === cat.id);
        if (!items.length) return;

        const isOpen = open.has(cat.id);
        const hasActive = items.some((d) => d.id === Viz.currentId);

        const group = document.createElement('li');
        group.className = 'cat-group' + (isOpen ? ' open' : '') + (hasActive ? ' has-active' : '');

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'cat-head';
        head.setAttribute('aria-expanded', String(isOpen));
        head.innerHTML = `
            <i class="fas ${Viz.esc(cat.icon)} cat-icon"></i>
            <span class="cat-name">${Viz.esc(cat.name)}</span>
            <span class="cat-count">${items.length}</span>
            <i class="fas fa-chevron-right cat-arrow"></i>`;
        head.addEventListener('click', () => Viz.toggleCat(cat.id));
        group.appendChild(head);

        const ul = document.createElement('ul');
        ul.className = 'cat-items';
        items.forEach((d) => {
            const li = document.createElement('li');
            li.className = 'demo-item' + (d.id === Viz.currentId ? ' active' : '');
            li.innerHTML = `
                <i class="fas ${Viz.esc(d.icon || 'fa-play')}"></i>
                <span class="demo-item-text">
                    <b>${Viz.esc(d.title)}</b>
                    <small>${Viz.esc(d.subtitle || '')}</small>
                </span>`;
            li.addEventListener('click', () => Viz.activate(d.id));
            ul.appendChild(li);
        });
        group.appendChild(ul);
        nav.appendChild(group);
    });
};

Viz.activate = function (id) {
    const demo = Viz.demos.find((d) => d.id === id);
    if (!demo) return;

    const prev = Viz.demos.find((d) => d.id === Viz.currentId);
    if (prev && typeof prev.unmount === 'function') prev.unmount();

    Viz.currentId = id;
    // 自动展开它所在的分类，免得看不到自己在哪
    Viz.loadOpenCats().add(demo.cat);
    Viz.saveOpenCats();

    const stage = Viz.dom.stage;
    stage.innerHTML = '';
    stage.scrollTop = 0;
    demo.mount(stage);

    Viz.renderNav();
    if (Viz.dom.stageTitle) Viz.dom.stageTitle.textContent = demo.title;
    if (Viz.dom.stageBlurb) Viz.dom.stageBlurb.textContent = demo.blurb || '';
    try { localStorage.setItem('viz_last_demo', id); } catch (e) { /* 忽略 */ }
};

// ---------- 基础构件 ----------

/** 建元素：h('div.foo', { title:'x' }, child1, child2...) */
Viz.h = function (spec, attrs) {
    const [tag, ...classes] = String(spec).split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (attrs) {
        Object.keys(attrs).forEach((k) => {
            if (k === 'html') el.innerHTML = attrs[k];
            else if (k === 'text') el.textContent = attrs[k];
            else if (k.startsWith('on') && typeof attrs[k] === 'function') {
                el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
            } else el.setAttribute(k, attrs[k]);
        });
    }
    for (let i = 2; i < arguments.length; i++) {
        const c = arguments[i];
        if (c == null || c === false) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
};

/** SVG 版的 h（SVG 元素必须用命名空间创建）*/
Viz.svg = function (tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
    for (let i = 2; i < arguments.length; i++) {
        if (arguments[i] != null) el.appendChild(arguments[i]);
    }
    return el;
};

/** SVG 文本（textContent 不能用属性设置，单独包一层省事）*/
Viz.text = function (attrs, str) {
    const t = Viz.svg('text', attrs);
    t.textContent = str;
    return t;
};

// ---------- 共用版块 ----------

/** 一张标准卡片：图标标题 + 说明 + 内容 */
Viz.card = function (icon, title, noteHtml) {
    const sec = Viz.h('section.card', null,
        Viz.h('h3.sec-title', { html: `<i class="fas ${Viz.esc(icon)}"></i> ${Viz.esc(title)}` })
    );
    if (noteHtml) sec.appendChild(Viz.h('p.sec-note', { html: noteHtml }));
    for (let i = 3; i < arguments.length; i++) {
        if (arguments[i]) sec.appendChild(arguments[i]);
    }
    return sec;
};

/** 编号流程步骤：steps = [{ t, f, r, hi }]，t 标题 / f 代码 / r 结论 / hi 黄框提示 */
Viz.flowList = function (steps, dim) {
    const box = Viz.h('div.flow');
    steps.forEach((s, i) => {
        const body = Viz.h('div.flow-body', null, Viz.h('div.flow-title', { text: s.t }));
        if (s.f) body.appendChild(Viz.h('code.flow-formula', { text: s.f }));
        if (s.r) body.appendChild(Viz.h('div.flow-result', { text: s.r }));
        if (s.hi) body.appendChild(Viz.h('div.flow-hi', { html: s.hi }));
        box.appendChild(Viz.h('div.flow-step' + (dim ? '' : '.lit'), { 'data-i': i },
            Viz.h('div.flow-num', { text: String(i + 1) }), body));
    });
    return box;
};

/** 滑块。opt = { label, min, max, step, value, fmt, onInput } */
Viz.slider = function (opt) {
    const val = Viz.h('b.ctl-val', { text: (opt.fmt || String)(opt.value) });
    return Viz.h('label.ctl', null,
        Viz.h('span.ctl-name', { text: opt.label }),
        Viz.h('input', {
            type: 'range', min: String(opt.min), max: String(opt.max),
            step: String(opt.step == null ? 1 : opt.step), value: String(opt.value),
            oninput: (e) => {
                const v = Number(e.target.value);
                val.textContent = (opt.fmt || String)(v);
                opt.onInput(v);
            },
        }),
        val
    );
};

/** 一组互斥的小标签按钮。opt = { options:[{v,label}], value, onPick } */
Viz.segmented = function (opt) {
    const box = Viz.h('div.segmented');
    opt.options.forEach((o) => {
        box.appendChild(Viz.h('button.seg' + (o.v === opt.value ? '.on' : ''), {
            onclick: () => opt.onPick(o.v),
        }, o.label));
    });
    return box;
};

/** 结果对比格：items = [{ h, v, d, cls }] */
Viz.cmpGrid = function (items) {
    const box = Viz.h('div.sf-compare');
    items.forEach((it) => {
        box.appendChild(Viz.h('div.cmp.' + (it.cls || 'cmp-save'), null,
            Viz.h('div.cmp-h', { text: it.h }),
            Viz.h('div.cmp-v', { text: it.v }),
            Viz.h('div.cmp-d', { text: it.d })
        ));
    });
    return box;
};

/** 图例：items = [{ cls, text }] */
Viz.legend = function (items) {
    const box = Viz.h('div.legend');
    items.forEach((it) => {
        box.appendChild(Viz.h('span.lg', null,
            Viz.h('span.k.' + it.cls), it.text));
    });
    return box;
};

/** 要点清单（黄色警示条）：items = [[标题, 说明html], ...] */
Viz.pitfalls = function (items) {
    const box = Viz.h('div.pitfalls');
    items.forEach((it, i) => {
        box.appendChild(Viz.h('div.pit', null,
            Viz.h('div.pit-n', { text: String(i + 1) }),
            Viz.h('div.pit-body', null,
                Viz.h('div.pit-t', { text: it[0] }),
                Viz.h('div.pit-d', { html: it[1] })
            )
        ));
    });
    return box;
};

/** 面试怎么答：question → 要点数组 */
Viz.qa = function (items) {
    const box = Viz.h('div.qa');
    items.forEach((it) => {
        box.appendChild(Viz.h('div.qa-item', null,
            Viz.h('div.qa-q', { html: '<i class="fas fa-circle-question"></i> ' + Viz.esc(it.q) }),
            Viz.h('div.qa-a', { html: it.a })
        ));
    });
    return box;
};

// ---------- 小工具 ----------

Viz.fmtDays = function (d) {
    if (d < 1) return (d * 24).toFixed(1) + ' 小时';
    if (d < 30) return d.toFixed(1) + ' 天';
    if (d < 365) return (d / 30.44).toFixed(1) + ' 个月';
    return (d / 365.25).toFixed(2) + ' 年';
};

Viz.fmtBytes = function (b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
};

Viz.fmtMs = function (ms) {
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
};

/** 坐标轴上取一个「好看」的刻度间隔 */
Viz.niceStep = function (total, want) {
    const raw = total / (want || 6);
    const cand = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500,
        1000, 2000, 2500, 5000, 10000, 20000, 50000];
    for (let i = 0; i < cand.length; i++) if (raw <= cand[i]) return cand[i];
    return cand[cand.length - 1];
};

/** 简单的动画循环封装：cb(dt) 返回 false 就停 */
Viz.ticker = function (cb) {
    let raf = null, last = 0, running = false;
    const step = (now) => {
        if (!running) return;
        // 切标签页回来时 now 会一次跳很大，夹一下免得画面瞬移
        const dt = last ? Math.min(now - last, 50) : 16;
        last = now;
        if (cb(dt) === false) { running = false; last = 0; return; }
        raf = requestAnimationFrame(step);
    };
    return {
        start() { if (running) return; running = true; last = 0; raf = requestAnimationFrame(step); },
        stop() { running = false; last = 0; if (raf) cancelAnimationFrame(raf); raf = null; },
        get running() { return running; },
    };
};
