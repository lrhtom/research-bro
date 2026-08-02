// ============================================================
//  工具箱 · 首页渲染
//
//  卡片数据不在这里 —— 在 assets/js/site-data.js 的 SITE.tools。
//  那个文件同时也是网课页、格式转换页和全站搜索的数据源，改一处四处生效。
//  本文件只负责把它画成卡片。
// ============================================================

(function () {

    // 首页就在站点根目录，站内链接不用加前缀
    SITE.base = '';

    function esc(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function cardHTML(tool) {
        const badges = (tool.badges || [])
            .map((b) => '<span class="badge">' + esc(b) + '</span>').join('');

        return '<a class="card accent-' + esc(tool.accent || 'indigo') + '"'
            + ' href="' + esc(SITE.url(tool.href)) + '">'
            + '<div class="card-top">'
            + '<div class="card-icon"><i class="fas ' + esc(tool.icon) + '"></i></div>'
            + '<span class="kind kind-self">'
            + '<i class="fas fa-screwdriver-wrench"></i> 自建工具</span>'
            + '</div>'
            + '<h3 class="card-title">' + esc(tool.title) + '</h3>'
            + '<p class="card-subtitle">' + esc(tool.subtitle) + '</p>'
            + '<p class="card-desc">' + esc(tool.desc) + '</p>'
            + '<div class="card-foot">'
            + '<div class="badges">' + badges + '</div>'
            + '<span class="cta">打开工具 <i class="fas fa-arrow-right"></i></span>'
            + '</div></a>';
    }

    document.addEventListener('DOMContentLoaded', () => {
        const grid = document.getElementById('card-grid');
        grid.innerHTML = SITE.tools.map(cardHTML).join('');

        // 交错淡入
        grid.querySelectorAll('.card').forEach((card, i) => {
            card.style.animationDelay = (i * 80) + 'ms';
        });

        const count = document.getElementById('tool-count');
        if (count) count.textContent = '共 ' + SITE.tools.length + ' 个';

        // 搜索范围 = 工具 + 30 个可视化演示 + 网课 + 格式转换
        SITE.mountSearch(document.getElementById('site-search'), {
            placeholder: '搜索工具、演示、网课…（按 / 聚焦）',
        });

        // 底部统计，让人一眼知道站里到底有多少东西
        const stat = document.getElementById('site-stat');
        if (stat) {
            stat.textContent = SITE.tools.length + ' 个工具 · '
                + SITE.demos.length + ' 个可视化演示 · '
                + SITE.courses.length + ' 门网课 · '
                + SITE.converters.length + ' 个转换服务';
        }
    });

})();
