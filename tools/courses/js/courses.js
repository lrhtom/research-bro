// ============================================================
//  网课大全 · 渲染
//  数据全在 ../../assets/js/site-data.js 的 SITE.courses / SITE.courseCats。
//  想加课程改那个文件，这里不用动。
// ============================================================

(function () {

    // 本页在 tools/courses/，站内链接要先退两级回到根目录
    SITE.base = '../../';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    // 演示 id → 标题，用来把课程和站内可视化演示串起来
    const demoTitle = {};
    SITE.demos.forEach((d) => { demoTitle[d.id] = d.t; });

    let active = 'all';

    /** 来源标记：官方频道 vs 第三方搬运。这个区别对能不能长期看到很关键 */
    function sourceTag(c) {
        return c.source === 'official'
            ? '<span class="src src-off"><i class="fas fa-circle-check"></i> 官方频道</span>'
            : '<span class="src src-mir"><i class="fas fa-circle-exclamation"></i> 第三方搬运</span>';
    }

    /** 课程关联的站内可视化演示，点了直接跳到那个演示 */
    function pairChips(c) {
        const list = (c.pairs || []).filter((id) => demoTitle[id]);
        if (!list.length) return '';
        return '<div class="pairs">'
            + '<span class="pairs-h"><i class="fas fa-wave-square"></i> 配合本站演示食用</span>'
            + '<span class="pairs-list">'
            + list.map((id) => '<a class="pair" href="'
                + esc(SITE.url('tools/visualizations/index.html#demo=' + id)) + '">'
                + esc(demoTitle[id]) + '</a>').join('')
            + '</span></div>';
    }

    function cardHTML(c) {
        return '<article class="course cat-' + esc(c.cat) + '">'
            + '<div class="course-top">'
            + '<span class="code">' + esc(c.code) + '</span>'
            + sourceTag(c)
            + '</div>'
            + '<h3 class="course-t">' + esc(c.title) + '</h3>'
            + '<p class="course-en">' + esc(c.en) + '</p>'
            + '<ul class="meta">'
            + '<li><i class="fas fa-building-columns"></i>' + esc(c.school) + '</li>'
            + '<li><i class="fas fa-calendar"></i>' + esc(c.term) + '</li>'
            + '<li><i class="fas fa-language"></i>' + esc(c.lang) + '</li>'
            + '<li><i class="fas fa-tv"></i>' + esc(c.channel) + '</li>'
            + '</ul>'
            + '<p class="course-d">' + esc(c.desc) + '</p>'
            + pairChips(c)
            + '<div class="course-foot">'
            + '<span class="verified"><i class="fas fa-shield-halved"></i> ' + esc(c.verified) + ' 已验证</span>'
            + '<a class="go" href="' + esc(c.href) + '" target="_blank" rel="noopener noreferrer">'
            + '前往观看 <i class="fas fa-arrow-up-right-from-square"></i></a>'
            + '</div>'
            + '</article>';
    }

    function render() {
        const grid = document.getElementById('course-grid');
        const list = active === 'all'
            ? SITE.courses
            : SITE.courses.filter((c) => c.cat === active);

        grid.innerHTML = list.map(cardHTML).join('');
        grid.querySelectorAll('.course').forEach((el, i) => {
            el.style.animationDelay = (i * 70) + 'ms';
        });

        const count = document.getElementById('course-count');
        if (count) {
            count.textContent = active === 'all'
                ? '共 ' + SITE.courses.length + ' 门'
                : list.length + ' / ' + SITE.courses.length + ' 门';
        }
        renderCats();
    }

    function renderCats() {
        const bar = document.getElementById('cat-bar');
        if (!bar) return;
        const btn = (id, icon, name, n) =>
            '<button class="cat-btn' + (active === id ? ' on' : '') + '" data-cat="' + esc(id) + '">'
            + '<i class="fas ' + esc(icon) + '"></i> ' + esc(name)
            + '<span class="cat-n">' + n + '</span></button>';

        let html = btn('all', 'fa-layer-group', '全部', SITE.courses.length);
        SITE.courseCats.forEach((c) => {
            const n = SITE.courses.filter((x) => x.cat === c.id).length;
            if (n) html += btn(c.id, c.icon, c.name, n);
        });
        bar.innerHTML = html;
        bar.querySelectorAll('.cat-btn').forEach((b) => {
            b.addEventListener('click', () => { active = b.dataset.cat; render(); });
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        render();
        SITE.mountSearch(document.getElementById('site-search'));
    });

})();
