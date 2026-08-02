// ============================================================
//  入口：填充 DOM 引用、渲染导航、决定先打开哪个演示
//  （本文件最后加载）
//
//  打开哪个演示的优先级：地址栏 #demo=xxx > 上次看过的 > 列表第一个。
//  地址栏优先是为了让首页搜索能直接跳到指定演示，而不是被 localStorage 抢走。
// ============================================================

/** 从 #demo=xxx 里取演示 id；没有或格式不对就返回 null */
function demoFromHash() {
    const m = /(?:^|[#&])demo=([A-Za-z0-9_-]+)/.exec(window.location.hash || '');
    return m ? m[1] : null;
}

function knownDemo(id) {
    return !!id && Viz.demos.some((d) => d.id === id);
}

document.addEventListener('DOMContentLoaded', () => {
    Viz.dom = {
        navList: document.getElementById('demo-list'),
        stage: document.getElementById('stage'),
        stageTitle: document.getElementById('stage-title'),
        stageBlurb: document.getElementById('stage-blurb'),
        sidebar: document.getElementById('sidebar'),
    };

    const toggle = document.getElementById('sidebar-toggle');
    if (toggle) toggle.addEventListener('click', () => Viz.dom.sidebar.classList.toggle('collapsed'));

    let last = null;
    try { last = localStorage.getItem('viz_last_demo'); } catch (e) { /* 隐私模式忽略 */ }

    const hashed = demoFromHash();
    const first = knownDemo(hashed) ? hashed
        : (knownDemo(last) ? last : (Viz.demos[0] && Viz.demos[0].id));

    if (first) Viz.activate(first);
    else Viz.renderNav();

    // 页面已经打开时，地址栏被改（比如从别处点了个 #demo= 链接）也要跟着切
    window.addEventListener('hashchange', () => {
        const id = demoFromHash();
        if (knownDemo(id) && id !== Viz.currentId) Viz.activate(id);
    });
});
