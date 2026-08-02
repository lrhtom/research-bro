// ============================================================
//  工具箱 · 全站搜索
//
//  数据全部来自 assets/js/site-data.js（工具 / 30 个可视化演示 / 网课 / 格式转换）。
//  纯前端子串匹配，没有后端也没有索引文件 —— 条目总共几十条，直接线性扫最省事。
//
//  用法：页面里放一个空容器，然后
//      SITE.base = '../../';            // 工具页要先回到站点根目录
//      SITE.mountSearch(document.getElementById('site-search'));
//
//  快捷键：/ 或 Ctrl+K 聚焦，↑↓ 选择，Enter 打开，Esc 关闭。
// ============================================================

(function () {

    const MAX_SHOW = 12;

    function esc(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    /**
     * 把查询词在文本里出现的地方套上 <mark>。
     * 做法：先在原串上算出命中区间、合并重叠，再逐段转义拼接。
     * 这样插进去的标签只可能是我们自己写的那两个，原文里的 < > 全被转义，不存在 XSS。
     */
    function highlight(text, terms) {
        const src = String(text == null ? '' : text);
        if (!terms || !terms.length) return esc(src);

        const low = src.toLowerCase();
        const hits = [];
        terms.forEach((t) => {
            if (!t) return;
            const asciiWord = ASCII_WORD.test(t);
            let i = low.indexOf(t);
            while (i >= 0) {
                // 跟 hasTerm 用同一套规则：英文词只标词首命中，
                // 免得搜 MIT 时把 limit 中间那三个字母也涂黄
                const p = i > 0 ? low.charCodeAt(i - 1) : 0;
                const inWord = (p >= 97 && p <= 122) || (p >= 48 && p <= 57);
                if (!asciiWord || !inWord) hits.push([i, i + t.length]);
                i = low.indexOf(t, i + 1);
            }
        });
        if (!hits.length) return esc(src);

        hits.sort((a, b) => a[0] - b[0]);
        const merged = [hits[0].slice()];
        for (let k = 1; k < hits.length; k++) {
            const last = merged[merged.length - 1];
            if (hits[k][0] <= last[1]) last[1] = Math.max(last[1], hits[k][1]);
            else merged.push(hits[k].slice());
        }

        let out = '', pos = 0;
        merged.forEach((r) => {
            out += esc(src.slice(pos, r[0])) + '<mark>' + esc(src.slice(r[0], r[1])) + '</mark>';
            pos = r[1];
        });
        return out + esc(src.slice(pos));
    }

    const ASCII_WORD = /^[a-z0-9]+$/;

    /**
     * 判断 text 里有没有 term。
     *
     * 纯英文数字的词按「词首」匹配，不按裸子串 ——
     * 否则搜 MIT 会命中 rate limit 里的 li-MIT，搜 AI 会命中一堆 cont-AI-ner。
     * 词首匹配同时保留了前缀搜索（打一半 "data" 也能搜到 database）。
     * 含中文的词没有词边界可言，仍旧按子串匹配。
     */
    function hasTerm(text, t) {
        if (!ASCII_WORD.test(t)) return text.indexOf(t) >= 0;
        let i = text.indexOf(t);
        while (i >= 0) {
            const p = i > 0 ? text.charCodeAt(i - 1) : 0;
            const inWord = (p >= 97 && p <= 122) || (p >= 48 && p <= 57);
            if (!inWord) return true;
            i = text.indexOf(t, i + 1);
        }
        return false;
    }

    /**
     * 打分：命中标题比命中正文值钱得多，
     * 否则搜「缓存」会被一堆正文里顺口提到缓存的条目淹掉。
     * 返回 0 表示没命中。
     */
    function score(row, terms) {
        let s = 0;
        const title = row.title.toLowerCase();
        const sub = (row.sub || '').toLowerCase();
        for (let i = 0; i < terms.length; i++) {
            const t = terms[i];
            if (!hasTerm(row.text, t)) return 0;      // 所有词都得命中（AND 语义）
            if (title === t) s += 100;
            else if (title.startsWith(t)) s += 60;
            else if (hasTerm(title, t)) s += 40;
            else if (hasTerm(sub, t)) s += 15;
            else s += 5;
        }
        if (!row.external) s += 2;                     // 同分时站内内容优先
        return s;
    }

    SITE.search = function (q, index) {
        const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) return [];
        return index
            .map((row) => ({ row: row, s: score(row, terms) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || a.row.title.length - b.row.title.length)
            .slice(0, MAX_SHOW)
            .map((x) => x.row);
    };

    SITE.mountSearch = function (host, opts) {
        if (!host) return;
        opts = opts || {};
        const index = SITE.buildIndex();

        host.classList.add('search');
        host.innerHTML =
            '<div class="search-box">'
            + '<i class="fas fa-magnifying-glass search-ico"></i>'
            + '<input type="search" class="search-input" autocomplete="off" spellcheck="false"'
            + ' placeholder="' + esc(opts.placeholder || '搜索工具、演示、网课…') + '"'
            + ' aria-label="全站搜索">'
            + '<kbd class="search-kbd">/</kbd>'
            + '</div>'
            + '<div class="search-panel" hidden></div>';

        const input = host.querySelector('.search-input');
        const panel = host.querySelector('.search-panel');
        const kbd = host.querySelector('.search-kbd');
        let rows = [], cur = -1;

        function close() {
            panel.hidden = true;
            panel.innerHTML = '';
            rows = []; cur = -1;
        }

        function open(list, q) {
            rows = list;
            cur = list.length ? 0 : -1;
            const terms = q.toLowerCase().split(/\s+/).filter(Boolean);

            if (!list.length) {
                panel.innerHTML = '<div class="search-empty">没有匹配「' + esc(q) + '」的内容'
                    + '<span>试试「TCP」「缓存」「数据库」「MIT」这类关键词</span></div>';
            } else {
                panel.innerHTML = '<div class="search-count">' + list.length + ' 条结果</div>'
                    + list.map((r, i) => (
                        '<a class="search-hit' + (i === 0 ? ' on' : '') + '" data-i="' + i + '"'
                        + ' href="' + esc(SITE.url(r.href)) + '"'
                        + (r.external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>'
                        + '<span class="hit-ico"><i class="fas ' + esc(r.icon) + '"></i></span>'
                        + '<span class="hit-body">'
                        + '<span class="hit-t">' + highlight(r.title, terms) + '</span>'
                        + '<span class="hit-s">' + highlight(r.sub || '', terms) + '</span>'
                        + '</span>'
                        + '<span class="hit-tag' + (r.external ? ' out' : '') + '">'
                        + esc(r.tag) + (r.external ? ' <i class="fas fa-arrow-up-right-from-square"></i>' : '')
                        + '</span></a>'
                    )).join('');
            }
            panel.hidden = false;
        }

        function move(delta) {
            if (!rows.length) return;
            const items = panel.querySelectorAll('.search-hit');
            if (cur >= 0 && items[cur]) items[cur].classList.remove('on');
            cur = (cur + delta + rows.length) % rows.length;
            items[cur].classList.add('on');
            items[cur].scrollIntoView({ block: 'nearest' });
        }

        input.addEventListener('input', () => {
            const q = input.value.trim();
            kbd.hidden = !!q;
            if (!q) { close(); return; }
            open(SITE.search(q, index), q);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') {
                const items = panel.querySelectorAll('.search-hit');
                if (cur >= 0 && items[cur]) { e.preventDefault(); items[cur].click(); }
            } else if (e.key === 'Escape') { close(); input.blur(); }
        });

        input.addEventListener('focus', () => {
            const q = input.value.trim();
            if (q) open(SITE.search(q, index), q);
        });

        // 点面板外面就关掉。用 mousedown 而不是 click：
        // 如果等到 click，blur 会先触发把面板清空，结果链接点了个空。
        document.addEventListener('mousedown', (e) => {
            if (!host.contains(e.target)) close();
        });

        // 全局快捷键：/ 聚焦（正在别的输入框打字时不抢），Ctrl/Cmd+K 同效
        document.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
            if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
                e.preventDefault();
                input.focus();
                input.select();
            }
        });
    };

})();
