// ============================================================
//  Markdown 表格导入
//  · 解析 GFM 管道表格（支持 :--- 对齐、\| 转义、<br> 换行、**粗体** *斜体*）
//  · 表格上方紧邻的一行短文字识别为表题（caption）
//  · 一次可识别多个表格；可新建表格或替换当前表格
//  三线表约束：只取单行表头；至少生成一行数据。
// ============================================================

// ---------- 行级解析 ----------

/** 是否可能是表格行（非空且含竖线，且不是别的块级结构）*/
App.isMdTableRow = function (line) {
    const s = String(line).trim();
    if (s === '' || s.indexOf('|') === -1) return false;
    if (/^#{1,6}\s/.test(s)) return false;          // 标题
    if (/^(```|~~~)/.test(s)) return false;         // 代码围栏
    return true;
};

/**
 * 按 | 切分一行，返回各单元格文本（已 trim）。
 * 保留 \| 转义不被当成分隔符。
 */
App.splitMdRow = function (line) {
    let s = String(line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

    const cells = [];
    let buf = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\' && s[i + 1] === '|') { buf += '\\|'; i++; continue; }
        if (ch === '|') { cells.push(buf); buf = ''; continue; }
        buf += ch;
    }
    cells.push(buf);
    return cells.map((c) => c.trim());
};

/** 是否是分隔行，形如 | --- | :---: | ---: | */
App.isMdSeparatorRow = function (line) {
    const s = String(line).trim();
    if (s === '' || s.indexOf('|') === -1) return false;
    const cells = App.splitMdRow(s);
    if (cells.length === 0) return false;
    return cells.every((c) => /^:?-+:?$/.test(c));
};

/** 从分隔行读出每列对齐方式（'' 表示未指定，沿用表格默认居中）*/
App.parseMdAlign = function (line) {
    return App.splitMdRow(line).map((c) => {
        const left = c.charAt(0) === ':';
        const right = c.charAt(c.length - 1) === ':';
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
    });
};

// ---------- 单元格内容：Markdown 行内语法 → 安全 HTML ----------

// 占位标记：用普通可打印字符，HTML 转义不会动它们，用户内容里几乎不可能撞上
App.MD_BR_MARK = '@@MDBR@@';

/**
 * 把一个单元格的 Markdown 文本转成 HTML。
 * 处理顺序很关键：先藏起反斜杠转义与 <br>，再整体 HTML 转义，
 * 之后再拼标签，保证任何用户输入都不可能注入。
 */
App.mdInlineToHtml = function (raw) {
    let s = String(raw == null ? '' : raw);

    // 1) 反斜杠转义的字符先藏成占位符，避免被当作 Markdown 语法
    const escaped = [];
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, function (m, ch) {
        escaped.push(ch);
        return '@@MDE' + (escaped.length - 1) + '@@';
    });

    // 2) <br> 换行也先占位（它是 Markdown 表格里唯一通用的换行写法）
    s = s.replace(/<br\s*\/?>/gi, App.MD_BR_MARK);

    // 3) HTML 转义 —— 此后再拼标签就安全了
    s = App.escapeHtml(s);

    // 4) 行内代码：去掉反引号只留文字（三线表里不需要代码样式）
    s = s.replace(/`([^`]*)`/g, '$1');

    // 5) 链接 [文字](地址) → 只留文字，避免表里出现裸语法
    s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');

    // 6) 粗体 / 斜体
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^A-Za-z0-9_])__([^_]+)__(?![A-Za-z0-9_])/g, '$1<strong>$2</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/(^|[^A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, '$1<em>$2</em>');

    // 7) 还原占位符
    s = s.split(App.MD_BR_MARK).join('<br>');
    s = s.replace(/@@MDE(\d+)@@/g, function (m, i) {
        const ch = escaped[Number(i)];
        return ch === undefined ? m : App.escapeHtml(ch);
    });

    return s;
};

/** 取 Markdown 文本的纯文字形态（用于表名等不该带标签的地方）*/
App.mdToPlainText = function (raw) {
    const div = document.createElement('div');
    div.innerHTML = App.mdInlineToHtml(raw);
    return (div.textContent || '').trim();
};

// ---------- 表题 ----------

/** 去掉表题行外围的 Markdown 装饰（# 标题、**粗体**、列表符号等）*/
App.cleanMdCaption = function (raw) {
    let s = String(raw).trim();
    s = s.replace(/^#{1,6}\s*/, '');
    s = s.replace(/^[>*+-]\s+/, '');
    s = s.replace(/^\*\*([\s\S]+)\*\*$/, '$1');
    s = s.replace(/^__([\s\S]+)__$/, '$1');
    s = s.replace(/^\*([\s\S]+)\*$/, '$1');
    s = s.replace(/^_([\s\S]+)_$/, '$1');
    return s.trim();
};

/** 向上找表题：跳过最多 2 个空行，取紧邻的一行短文字 */
App.findMdCaption = function (lines, headerIdx) {
    let k = headerIdx - 1;
    let blanks = 0;
    while (k >= 0) {
        const s = String(lines[k]).trim();
        if (s === '') {
            blanks++;
            if (blanks > 2) return '';
            k--;
            continue;
        }
        if (s.indexOf('|') !== -1) return '';       // 上面还是表格，不当表题
        if (/^(```|~~~)/.test(s)) return '';        // 代码围栏
        const c = App.cleanMdCaption(s);
        return (c.length > 0 && c.length <= 120) ? c : '';
    }
    return '';
};

// ---------- 文档级解析 ----------

/**
 * 从一段文本里找出所有 Markdown 表格。
 * 返回 [{ caption, header: [], align: [], rows: [[]] }, ...]
 */
App.parseMarkdownTables = function (text) {
    const lines = String(text == null ? '' : text)
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    const tables = [];
    let i = 1;
    while (i < lines.length) {
        // 分隔行必须紧跟在表头行之后
        if (App.isMdSeparatorRow(lines[i]) && App.isMdTableRow(lines[i - 1])) {
            const header = App.splitMdRow(lines[i - 1]);
            const align = App.parseMdAlign(lines[i]);
            const rows = [];
            let j = i + 1;
            while (j < lines.length && App.isMdTableRow(lines[j]) && !App.isMdSeparatorRow(lines[j])) {
                rows.push(App.splitMdRow(lines[j]));
                j++;
            }
            tables.push({ caption: App.findMdCaption(lines, i - 1), header, align, rows });
            i = j + 1;
            continue;
        }
        i++;
    }

    // 兜底：整段每一非空行都含竖线、但作者漏写了分隔行 —— 首行当表头
    if (tables.length === 0) return App.parseMdLooseTable(lines);
    return tables;
};

/** 宽松解析：没有分隔行的纯管道表格（仅在严格解析无结果时启用）*/
App.parseMdLooseTable = function (lines) {
    const rows = lines.map((l) => String(l).trim()).filter((l) => l !== '');
    if (rows.length < 2) return [];
    if (!rows.every((l) => App.isMdTableRow(l))) return [];
    if (rows.some((l) => App.isMdSeparatorRow(l))) return [];
    const grid = rows.map((l) => App.splitMdRow(l));
    return [{ caption: '', header: grid[0], align: [], rows: grid.slice(1) }];
};

// ---------- 生成三线表 HTML ----------

/** 表格实际列数（表头与所有数据行取最大，保证矩形）*/
App.mdColCount = function (t) {
    let n = t.header.length;
    t.rows.forEach((r) => { if (r.length > n) n = r.length; });
    return Math.max(n, 1);
};

/** 给这张表起个名字（用作侧边栏条目与表题兜底）*/
App.mdTableName = function (t, idx) {
    const c = App.mdToPlainText(t.caption || '');
    if (c) return c.length > 60 ? c.slice(0, 60) + '…' : c;
    return 'Markdown 表格 ' + idx;
};

/** 把解析结果渲染成本工具的三线表 HTML */
App.mdTableToHtml = function (t, captionText) {
    const colCount = App.mdColCount(t);
    const align = t.align || [];
    const styleFor = (i) => (align[i] ? ' style="text-align: ' + align[i] + ';"' : '');

    let html = '<table class="academic-table" id="main-table">';
    html += `<caption contenteditable="true">${App.mdInlineToHtml(captionText || '')}</caption>`;

    html += '<thead><tr>';
    for (let i = 0; i < colCount; i++) {
        html += `<th contenteditable="true"${styleFor(i)}>${App.mdInlineToHtml(t.header[i] || '')}</th>`;
    }
    html += '</tr></thead>';

    // 三线表至少要有一行数据；源表格没有数据行时补一行空行
    const rows = t.rows.length > 0 ? t.rows : [[]];
    html += '<tbody>';
    rows.forEach((r) => {
        html += '<tr>';
        for (let i = 0; i < colCount; i++) {
            html += `<td contenteditable="true"${styleFor(i)}>${App.mdInlineToHtml(r[i] || '')}</td>`;
        }
        html += '</tr>';
    });
    html += '</tbody></table>';

    return html;
};

// ---------- 导入执行 ----------

/**
 * 把一段 Markdown 文本导入为表格。
 * mode: 'new' = 每个表格新建一张；'replace' = 用第一个表格替换当前表格。
 * 返回导入的表格数量（0 表示没识别到）。
 */
App.importMarkdownText = function (text, mode) {
    const tables = App.parseMarkdownTables(text);
    if (tables.length === 0) return 0;

    if (mode === 'replace') {
        const t = tables[0];
        const hasCaption = !!App.mdToPlainText(t.caption || '');
        const name = hasCaption ? App.mdTableName(t, 1) : App.dom.tableNameInput.value;

        App.clearSelection();
        App.dom.tableWrapper.innerHTML = App.mdTableToHtml(t, hasCaption ? t.caption : name);
        if (hasCaption) App.dom.tableNameInput.value = name;
        App.pushHistory();
        App.saveToLocalStorage(false);
    } else {
        // 倒序创建：每次 unshift 到列表头，最终第 1 个表格排在最前且处于激活状态
        for (let i = tables.length - 1; i >= 0; i--) {
            const t = tables[i];
            const name = App.mdTableName(t, i + 1);
            App.createTableFromHtml(name, App.mdTableToHtml(t, t.caption || name));
        }
    }

    return tables.length;
};

// ---------- 弹窗交互 ----------

App.openMdImport = function () {
    const { mdMask, mdText } = App.dom;
    if (!mdMask) return;
    mdMask.classList.add('show');
    App.renderMdImportPreview();
    setTimeout(() => { if (mdText) mdText.focus(); }, 0);
};

App.closeMdImport = function () {
    if (App.dom.mdMask) App.dom.mdMask.classList.remove('show');
};

App.isMdImportOpen = function () {
    return !!(App.dom.mdMask && App.dom.mdMask.classList.contains('show'));
};

/** 当前选中的导入模式 */
App.getMdImportMode = function () {
    const checked = document.querySelector('input[name="md-import-mode"]:checked');
    return checked ? checked.value : 'new';
};

/** 实时预览：识别到几个表、各是什么样子 */
App.renderMdImportPreview = function () {
    const { mdPreview, mdText, mdConfirm } = App.dom;
    if (!mdPreview || !mdText) return;

    const setDisabled = (v) => { if (mdConfirm) mdConfirm.disabled = v; };

    if (mdText.value.trim() === '') {
        mdPreview.innerHTML = '<p class="md-preview-empty">粘贴或选择文件后，这里会显示识别到的表格。</p>';
        setDisabled(true);
        return;
    }

    const tables = App.parseMarkdownTables(mdText.value);
    if (tables.length === 0) {
        mdPreview.innerHTML = '<p class="md-preview-bad"><i class="fas fa-triangle-exclamation"></i> '
            + '没识别到表格。Markdown 表格需要一行分隔行，形如 <code>| --- | --- |</code>。</p>';
        setDisabled(true);
        return;
    }

    let html = `<p class="md-preview-ok"><i class="fas fa-circle-check"></i> 识别到 ${tables.length} 个表格</p>`;
    tables.slice(0, 5).forEach((t, i) => {
        const cols = App.mdColCount(t);
        html += '<div class="md-preview-item">';
        html += `<div class="md-preview-meta">#${i + 1} ${App.escapeHtml(App.mdTableName(t, i + 1))}`
            + ` · ${cols} 列 × ${t.rows.length} 行数据</div>`;
        html += App.mdPreviewTable(t, cols);
        html += '</div>';
    });
    if (tables.length > 5) {
        html += `<p class="md-preview-more">…另有 ${tables.length - 5} 个表格未预览，导入时同样会处理。</p>`;
    }

    mdPreview.innerHTML = html;
    setDisabled(false);
};

/** 预览用的小表格（最多显示 5 行数据）*/
App.mdPreviewTable = function (t, cols) {
    const align = t.align || [];
    const styleFor = (i) => (align[i] ? ' style="text-align: ' + align[i] + ';"' : '');

    let html = '<table class="md-preview-table"><thead><tr>';
    for (let i = 0; i < cols; i++) {
        html += `<th${styleFor(i)}>${App.mdInlineToHtml(t.header[i] || '')}</th>`;
    }
    html += '</tr></thead><tbody>';
    t.rows.slice(0, 5).forEach((r) => {
        html += '<tr>';
        for (let i = 0; i < cols; i++) {
            html += `<td${styleFor(i)}>${App.mdInlineToHtml(r[i] || '')}</td>`;
        }
        html += '</tr>';
    });
    html += '</tbody></table>';
    if (t.rows.length > 5) {
        html += `<div class="md-preview-more">…还有 ${t.rows.length - 5} 行未预览</div>`;
    }
    return html;
};

App.confirmMdImport = function () {
    const { mdText } = App.dom;
    if (!mdText) return;

    const mode = App.getMdImportMode();
    const count = App.importMarkdownText(mdText.value, mode);

    if (count === 0) {
        App.notify('没识别到 Markdown 表格，请检查是否有 | --- | 分隔行');
        return;
    }

    App.closeMdImport();
    if (mode === 'replace') {
        App.notify(count > 1 ? `已替换当前表格（识别到 ${count} 个，替换模式只用第 1 个）` : '已替换当前表格');
    } else {
        App.notify(count > 1 ? `已导入 ${count} 个表格` : '已导入 1 个表格');
    }
};

App.initMdImport = function () {
    const { mdMask, mdText, mdFile } = App.dom;
    if (!mdMask) return;

    // 输入即预览
    if (mdText) mdText.addEventListener('input', () => App.renderMdImportPreview());

    // 选择 .md 文件 → 读进文本框（仍需点“导入”确认）
    if (mdFile) {
        mdFile.addEventListener('change', () => {
            const file = mdFile.files && mdFile.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                if (mdText) mdText.value = String(reader.result || '');
                App.renderMdImportPreview();
                App.notify('已读取 ' + file.name);
            };
            reader.onerror = () => App.notify('读取文件失败');
            reader.readAsText(file, 'UTF-8');
            mdFile.value = ''; // 允许再次选择同一个文件
        });
    }

    // 点遮罩空白处关闭
    mdMask.addEventListener('mousedown', (event) => {
        if (event.target === mdMask) App.closeMdImport();
    });

    // Esc 关闭（独立监听，不受表单控件里让出键盘的规则影响）
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && App.isMdImportOpen()) {
            event.stopPropagation();
            App.closeMdImport();
        }
    }, true);
};
