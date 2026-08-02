// ============================================================
//  格式转换 · 渲染
//  数据在 ../../assets/js/site-data.js 的 SITE.converters。
//  卡片外观直接复用首页 home.css 里的 .card 那一套。
// ============================================================

(function () {

    // 本页在 tools/converters/，站内链接要先退两级
    SITE.base = '../../';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    function cardHTML(c) {
        const badges = (c.badges || [])
            .map((b) => '<span class="badge">' + esc(b) + '</span>').join('');

        return '<a class="card accent-' + esc(c.accent) + '" href="' + esc(c.href) + '"'
            + ' target="_blank" rel="noopener noreferrer">'
            + '<div class="card-top">'
            + '<div class="card-icon"><i class="fas ' + esc(c.icon) + '"></i></div>'
            + '<span class="kind kind-link">'
            + '<i class="fas fa-arrow-up-right-from-square"></i> ' + esc(c.site)
            + '</span>'
            + '</div>'
            + '<h3 class="card-title">' + esc(c.title) + '</h3>'
            + '<p class="card-subtitle">' + esc(c.en) + '</p>'
            + '<p class="card-desc">' + esc(c.desc) + '</p>'
            + '<div class="card-foot">'
            + '<div class="badges">' + badges + '</div>'
            + '<span class="cta">前往使用 <i class="fas fa-arrow-up-right-from-square"></i></span>'
            + '</div></a>';
    }

    document.addEventListener('DOMContentLoaded', () => {
        const grid = document.getElementById('conv-grid');
        grid.innerHTML = SITE.converters.map(cardHTML).join('');
        grid.querySelectorAll('.card').forEach((el, i) => {
            el.style.animationDelay = (i * 80) + 'ms';
        });

        const count = document.getElementById('conv-count');
        if (count) count.textContent = '共 ' + SITE.converters.length + ' 个';

        SITE.mountSearch(document.getElementById('site-search'));
    });

})();
