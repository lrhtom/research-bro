// ============================================================
//  入口：填充 DOM 引用、渲染导航、打开上次看过的演示
//  （本文件最后加载）
// ============================================================

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

    const first = (last && Viz.demos.some((d) => d.id === last)) ? last : (Viz.demos[0] && Viz.demos[0].id);
    if (first) Viz.activate(first);
    else Viz.renderNav();
});
