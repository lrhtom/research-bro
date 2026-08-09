// ============================================================
//  Markdown 表格解析 → 三线表 HTML
//
//  · 解析 GFM 管道表格（支持 :--- 对齐、\| 转义、<br> 换行、**粗体** *斜体*）
//  · 表格上方紧邻的一行短文字识别为表题（caption）
//  · 一次可识别多个表格
//  三线表约束：只取单行表头；至少生成一行数据。
//
//  整个模块是纯函数，不碰 DOM —— 预览和导入两条路都用它。
// ============================================================

import { escapeHtml } from '../../shared/table-defaults';

export interface MdTable {
    caption: string;
    header: string[];
    align: string[];
    rows: string[][];
}

// ---------- 行级解析 ----------

/** 是否可能是表格行（非空且含竖线，且不是别的块级结构）*/
export function isMdTableRow(line: string): boolean {
    const s = String(line).trim();
    if (s === '' || s.indexOf('|') === -1) return false;
    if (/^#{1,6}\s/.test(s)) return false;          // 标题
    if (/^(```|~~~)/.test(s)) return false;         // 代码围栏
    return true;
}

/**
 * 按 | 切分一行，返回各单元格文本（已 trim）。
 * 保留 \| 转义不被当成分隔符。
 */
export function splitMdRow(line: string): string[] {
    let s = String(line).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

    const cells: string[] = [];
    let buf = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '\\' && s[i + 1] === '|') { buf += '\\|'; i++; continue; }
        if (ch === '|') { cells.push(buf); buf = ''; continue; }
        buf += ch;
    }
    cells.push(buf);
    return cells.map((c) => c.trim());
}

/** 是否是分隔行，形如 | --- | :---: | ---: | */
export function isMdSeparatorRow(line: string): boolean {
    const s = String(line).trim();
    if (s === '' || s.indexOf('|') === -1) return false;
    const cells = splitMdRow(s);
    if (cells.length === 0) return false;
    return cells.every((c) => /^:?-+:?$/.test(c));
}

/** 从分隔行读出每列对齐方式（'' 表示未指定，沿用表格默认居中）*/
export function parseMdAlign(line: string): string[] {
    return splitMdRow(line).map((c) => {
        const left = c.charAt(0) === ':';
        const right = c.charAt(c.length - 1) === ':';
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
    });
}

// ---------- 单元格内容：Markdown 行内语法 → 安全 HTML ----------

// 占位标记：用普通可打印字符，HTML 转义不会动它们，用户内容里几乎不可能撞上
const MD_BR_MARK = '@@MDBR@@';

/**
 * 把一个单元格的 Markdown 文本转成 HTML。
 * 处理顺序很关键：先藏起反斜杠转义与 <br>，再整体 HTML 转义，
 * 之后再拼标签，保证任何用户输入都不可能注入。
 */
export function mdInlineToHtml(raw: unknown): string {
    let s = String(raw ?? '');

    // 1) 反斜杠转义的字符先藏成占位符，避免被当作 Markdown 语法
    const escaped: string[] = [];
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_m, ch: string) => {
        escaped.push(ch);
        return '@@MDE' + (escaped.length - 1) + '@@';
    });

    // 2) <br> 换行也先占位（它是 Markdown 表格里唯一通用的换行写法）
    s = s.replace(/<br\s*\/?>/gi, MD_BR_MARK);

    // 3) HTML 转义 —— 此后再拼标签就安全了
    s = escapeHtml(s);

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
    s = s.split(MD_BR_MARK).join('<br>');
    s = s.replace(/@@MDE(\d+)@@/g, (m, i: string) => {
        const ch = escaped[Number(i)];
        return ch === undefined ? m : escapeHtml(ch);
    });

    return s;
}

/**
 * 取 Markdown 文本的纯文字形态（用于表名等不该带标签的地方）。
 * mdInlineToHtml 只会产出 <strong>/<em>/<br> 和那五个转义实体，
 * 所以「去标签 + 反转义」就是精确的逆运算，不需要动用 DOM。
 */
export function mdToPlainText(raw: unknown): string {
    return mdInlineToHtml(raw)
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')     // & 必须最后还原，否则 &amp;lt; 会被二次解码
        .trim();
}

// ---------- 表题 ----------

/** 去掉表题行外围的 Markdown 装饰（# 标题、**粗体**、列表符号等）*/
export function cleanMdCaption(raw: string): string {
    let s = String(raw).trim();
    s = s.replace(/^#{1,6}\s*/, '');
    s = s.replace(/^[>*+-]\s+/, '');
    s = s.replace(/^\*\*([\s\S]+)\*\*$/, '$1');
    s = s.replace(/^__([\s\S]+)__$/, '$1');
    s = s.replace(/^\*([\s\S]+)\*$/, '$1');
    s = s.replace(/^_([\s\S]+)_$/, '$1');
    return s.trim();
}

/** 向上找表题：跳过最多 2 个空行，取紧邻的一行短文字 */
export function findMdCaption(lines: string[], headerIdx: number): string {
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
        const c = cleanMdCaption(s);
        return (c.length > 0 && c.length <= 120) ? c : '';
    }
    return '';
}

// ---------- 文档级解析 ----------

/** 从一段文本里找出所有 Markdown 表格 */
export function parseMarkdownTables(text: unknown): MdTable[] {
    const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    const tables: MdTable[] = [];
    let i = 1;
    while (i < lines.length) {
        // 分隔行必须紧跟在表头行之后
        if (isMdSeparatorRow(lines[i]) && isMdTableRow(lines[i - 1])) {
            const header = splitMdRow(lines[i - 1]);
            const align = parseMdAlign(lines[i]);
            const rows: string[][] = [];
            let j = i + 1;
            while (j < lines.length && isMdTableRow(lines[j]) && !isMdSeparatorRow(lines[j])) {
                rows.push(splitMdRow(lines[j]));
                j++;
            }
            tables.push({ caption: findMdCaption(lines, i - 1), header, align, rows });
            i = j + 1;
            continue;
        }
        i++;
    }

    // 兜底：整段每一非空行都含竖线、但作者漏写了分隔行 —— 首行当表头
    if (tables.length === 0) return parseMdLooseTable(lines);
    return tables;
}

/** 宽松解析：没有分隔行的纯管道表格（仅在严格解析无结果时启用）*/
function parseMdLooseTable(lines: string[]): MdTable[] {
    const rows = lines.map((l) => String(l).trim()).filter((l) => l !== '');
    if (rows.length < 2) return [];
    if (!rows.every((l) => isMdTableRow(l))) return [];
    if (rows.some((l) => isMdSeparatorRow(l))) return [];
    const grid = rows.map((l) => splitMdRow(l));
    return [{ caption: '', header: grid[0], align: [], rows: grid.slice(1) }];
}

// ---------- 生成三线表 HTML ----------

/** 表格实际列数（表头与所有数据行取最大，保证矩形）*/
export function mdColCount(t: MdTable): number {
    let n = t.header.length;
    t.rows.forEach((r) => { if (r.length > n) n = r.length; });
    return Math.max(n, 1);
}

/** 给这张表起个名字（用作侧边栏条目与表题兜底）*/
export function mdTableName(t: MdTable, idx: number): string {
    const c = mdToPlainText(t.caption || '');
    if (c) return c.length > 60 ? c.slice(0, 60) + '…' : c;
    return 'Markdown 表格 ' + idx;
}

/** 把解析结果渲染成本工具的三线表 HTML */
export function mdTableToHtml(t: MdTable, captionText: string): string {
    const colCount = mdColCount(t);
    const align = t.align || [];
    const styleFor = (i: number) => (align[i] ? ` style="text-align: ${align[i]};"` : '');

    let html = '<table class="academic-table" id="main-table">';
    html += `<caption contenteditable="true">${mdInlineToHtml(captionText || '')}</caption>`;

    html += '<thead><tr>';
    for (let i = 0; i < colCount; i++) {
        html += `<th contenteditable="true"${styleFor(i)}>${mdInlineToHtml(t.header[i] || '')}</th>`;
    }
    html += '</tr></thead>';

    // 三线表至少要有一行数据；源表格没有数据行时补一行空行
    const rows = t.rows.length > 0 ? t.rows : [[]];
    html += '<tbody>';
    rows.forEach((r) => {
        html += '<tr>';
        for (let i = 0; i < colCount; i++) {
            html += `<td contenteditable="true"${styleFor(i)}>${mdInlineToHtml(r[i] || '')}</td>`;
        }
        html += '</tr>';
    });
    html += '</tbody></table>';

    return html;
}
