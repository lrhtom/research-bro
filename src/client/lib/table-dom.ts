// ============================================================
//  三线表编辑器的 DOM 操作层（只在浏览器里跑）
//
//  编辑器本体是一块 contenteditable 的 <table>，所有结构与样式操作都是
//  直接改 DOM —— 这正是它能保留任意富文本、又能一比一导出 PNG 的原因。
//  React 只管「什么时候把 HTML 灌进去 / 什么时候读出来存库」，
//  中间这些增删行列、样式统一的活儿都在这个文件里。
//
//  三线表约束：表头恒为单行；至少保留 1 表头行、1 数据行、1 列。
// ============================================================

export interface OpResult {
    changed: boolean;
    /** 需要提示用户的一句话 */
    notify?: string;
    /** 操作完成后应该聚焦并全选的单元格 */
    focus?: HTMLTableCellElement;
}

const NO_CHANGE: OpResult = { changed: false };

// ---------- 解析 ----------

/** 把一段表格 HTML 解析出行列数（用 DOMParser，不会执行脚本、不会加载资源）*/
export function tableShape(html: string): { rows: number; cols: number; caption: string } {
    try {
        const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
        const table = doc.querySelector('table');
        if (!table) return { rows: 0, cols: 0, caption: '' };
        const headRow = table.querySelector('thead tr');
        const cols = headRow ? headRow.children.length : 0;
        const rows = table.querySelectorAll('tbody tr').length;
        const cap = table.querySelector('caption');
        return { rows, cols, caption: cap ? cap.textContent!.trim() : '' };
    } catch {
        return { rows: 0, cols: 0, caption: '' };
    }
}

export function fmtSize(b: number): string {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- 建单元格 ----------

function makeCell(tag: 'th' | 'td', text = ''): HTMLTableCellElement {
    const cell = document.createElement(tag);
    cell.setAttribute('contenteditable', 'true');
    if (text) cell.innerText = text;
    return cell;
}

function isHeaderRow(row: HTMLTableRowElement): boolean {
    return row.parentElement?.tagName === 'THEAD';
}

// ---------- 末尾增删 ----------

export function addRow(table: HTMLTableElement): OpResult {
    const tbody = table.querySelector('tbody');
    const headerRow = table.querySelector('thead tr');
    if (!tbody || !headerRow) return NO_CHANGE;

    const newRow = document.createElement('tr');
    for (let i = 0; i < headerRow.children.length; i++) newRow.appendChild(makeCell('td', '新数据'));
    tbody.appendChild(newRow);
    return { changed: true };
}

export function addColumn(table: HTMLTableElement): OpResult {
    table.querySelectorAll('tr').forEach((row) => {
        const head = isHeaderRow(row);
        row.appendChild(makeCell(head ? 'th' : 'td', head ? '新表头' : '新数据'));
    });
    return { changed: true };
}

export function removeRow(table: HTMLTableElement): OpResult {
    const tbody = table.querySelector('tbody');
    if (!tbody || tbody.children.length === 0) return NO_CHANGE;
    if (tbody.children.length <= 1) return { changed: false, notify: '至少保留一行数据' };
    tbody.removeChild(tbody.lastElementChild!);
    return { changed: true };
}

export function removeColumn(table: HTMLTableElement): OpResult {
    const allRows = table.querySelectorAll('tr');
    if (allRows.length === 0) return NO_CHANGE;
    if (allRows[0].children.length <= 1) return { changed: false, notify: '至少保留一列' };
    allRows.forEach((row) => row.removeChild(row.lastElementChild!));
    return { changed: true };
}

// ---------- 基于选中的插入 / 删除 ----------

export function insertRow(
    table: HTMLTableElement,
    position: 'above' | 'below',
    targetCell: HTMLTableCellElement | null,
): OpResult {
    const tbody = table.querySelector('tbody');

    let targetRow: HTMLTableRowElement | null = null;
    let parentSection: HTMLElement | null = null;

    if (targetCell) {
        targetRow = targetCell.parentElement as HTMLTableRowElement;
        parentSection = targetRow.parentElement as HTMLElement;
    } else if (tbody && tbody.children.length > 0) {
        targetRow = tbody.lastElementChild as HTMLTableRowElement;
        parentSection = tbody;
    } else {
        return NO_CHANGE;
    }

    const newRow = document.createElement('tr');
    for (let i = 0; i < targetRow.children.length; i++) newRow.appendChild(makeCell('td', '新数据'));

    // 三线表只有单行表头，目标在表头时一律插到表体顶部
    if (parentSection.tagName === 'THEAD') {
        if (!tbody) return NO_CHANGE;
        tbody.insertBefore(newRow, tbody.firstElementChild);
    } else if (position === 'above') {
        parentSection.insertBefore(newRow, targetRow);
    } else {
        parentSection.insertBefore(newRow, targetRow.nextSibling);
    }

    return { changed: true, focus: (newRow.firstElementChild as HTMLTableCellElement) ?? undefined };
}

export function insertColumn(
    table: HTMLTableElement,
    position: 'left' | 'right',
    targetCell: HTMLTableCellElement | null,
): OpResult {
    let targetIndex: number;
    if (targetCell) {
        targetIndex = targetCell.cellIndex;
    } else {
        const firstRow = table.querySelector('tr');
        if (!firstRow) return NO_CHANGE;
        targetIndex = firstRow.children.length - 1;
    }

    const targetRow = targetCell ? targetCell.parentElement : null;
    let focus: HTMLTableCellElement | undefined;

    table.querySelectorAll('tr').forEach((row) => {
        const head = isHeaderRow(row);
        const cell = makeCell(head ? 'th' : 'td', head ? '新表头' : '新数据');
        const ref = row.children[targetIndex];
        if (!ref) { row.appendChild(cell); }
        else if (position === 'left') { row.insertBefore(cell, ref); }
        else { row.insertBefore(cell, ref.nextSibling); }
        if (row === targetRow) focus = cell;
    });

    return { changed: true, focus };
}

export function deleteRows(table: HTMLTableElement, activeEls: HTMLElement[]): OpResult {
    const tbody = table.querySelector('tbody');
    if (!tbody) return NO_CHANGE;

    // 收集要删的行（来自选中单元格；无选中则末尾数据行）
    const rowSet = new Set<HTMLTableRowElement>();
    activeEls.forEach((el) => {
        if ((el.tagName === 'TD' || el.tagName === 'TH') && el.parentElement) {
            rowSet.add(el.parentElement as HTMLTableRowElement);
        }
    });
    if (rowSet.size === 0 && tbody.children.length > 0) {
        rowSet.add(tbody.lastElementChild as HTMLTableRowElement);
    }
    if (rowSet.size === 0) return NO_CHANGE;

    const rows = Array.from(rowSet);
    const headerSelected = rows.some((r) => r.parentElement?.tagName === 'THEAD');
    const bodyRows = rows.filter((r) => r.parentElement?.tagName === 'TBODY');

    if (bodyRows.length === 0) {
        return { changed: false, notify: headerSelected ? '三线表的表头行不可删除' : undefined };
    }
    if (bodyRows.length >= tbody.children.length) return { changed: false, notify: '至少保留一行数据' };

    bodyRows.forEach((r) => r.remove());
    return { changed: true, notify: headerSelected ? '三线表的表头行不可删除，已删除选中的数据行' : undefined };
}

export function deleteColumns(table: HTMLTableElement, activeEls: HTMLElement[]): OpResult {
    const allRows = Array.from(table.querySelectorAll('tr'));
    if (allRows.length === 0) return NO_CHANGE;
    const totalCols = allRows[0].children.length;

    const colSet = new Set<number>();
    activeEls.forEach((el) => {
        if (el.tagName === 'TD' || el.tagName === 'TH') colSet.add((el as HTMLTableCellElement).cellIndex);
    });
    if (colSet.size === 0) colSet.add(totalCols - 1);

    // 从右往左删，避免删掉一列之后后面的下标全部错位
    const cols = Array.from(colSet).filter((c) => c >= 0).sort((a, b) => b - a);
    if (cols.length === 0) return NO_CHANGE;
    if (cols.length >= totalCols) return { changed: false, notify: '至少保留一列' };

    allRows.forEach((row) => {
        cols.forEach((c) => { if (row.children[c]) row.removeChild(row.children[c]); });
    });
    return { changed: true };
}

/** 在表体末尾追加一行空行（Tab 走到最后一格时用）*/
export function appendEmptyRow(table: HTMLTableElement): OpResult {
    const tbody = table.querySelector('tbody');
    const headerRow = table.querySelector('thead tr');
    if (!tbody || !headerRow) return NO_CHANGE;

    const tr = document.createElement('tr');
    for (let i = 0; i < headerRow.children.length; i++) tr.appendChild(makeCell('td'));
    tbody.appendChild(tr);
    return { changed: true };
}

/** 清空选中单元格内容（表题不清）*/
export function clearCells(activeEls: HTMLElement[]): OpResult {
    if (activeEls.length === 0) return NO_CHANGE;
    activeEls.forEach((el) => { if (el.tagName !== 'CAPTION') el.textContent = ''; });
    return { changed: true };
}

// ---------- 样式 ----------

/**
 * 清除单元格内所有子元素自带的某项内联样式（及等价的老式属性），
 * 使整格文字统一继承单元格本身的样式 —— 解决从 Word/网页粘进来的内容
 * 大小、字体不一的问题。
 */
export function unifyCellStyle(el: HTMLElement, cssProp: string, legacyAttr?: string): void {
    el.querySelectorAll<HTMLElement>('*').forEach((child) => {
        if (child.style) child.style.removeProperty(cssProp);
        if (legacyAttr && child.hasAttribute(legacyAttr)) child.removeAttribute(legacyAttr);
    });
}

// 判断单元格「看起来」是否加粗/倾斜：除单元格自身外，还要看粘贴进来的
// <b>/<strong>/<em>/<i> 等标签 —— 它们自带样式，会盖过单元格的设置。
export function isRenderedBold(el: HTMLElement): boolean {
    const w = window.getComputedStyle(el).fontWeight;
    if (w === 'bold' || parseInt(w, 10) >= 600) return true;
    return !!el.querySelector('b, strong');
}

export function isRenderedItalic(el: HTMLElement): boolean {
    if (window.getComputedStyle(el).fontStyle === 'italic') return true;
    return !!el.querySelector('em, i');
}

export function toggleBold(activeEls: HTMLElement[]): OpResult {
    if (activeEls.length === 0) return NO_CHANGE;
    const on = !isRenderedBold(activeEls[0]);
    activeEls.forEach((el) => {
        el.style.fontWeight = on ? 'bold' : 'normal';
        unifyCellStyle(el, 'font-weight');
        // <b>/<strong> 自带加粗，需显式覆盖
        el.querySelectorAll<HTMLElement>('b, strong').forEach((n) => {
            n.style.fontWeight = on ? 'bold' : 'normal';
        });
    });
    return { changed: true };
}

export function toggleItalic(activeEls: HTMLElement[]): OpResult {
    if (activeEls.length === 0) return NO_CHANGE;
    const on = !isRenderedItalic(activeEls[0]);
    activeEls.forEach((el) => {
        el.style.fontStyle = on ? 'italic' : 'normal';
        unifyCellStyle(el, 'font-style');
        // <em>/<i> 自带斜体，需显式覆盖
        el.querySelectorAll<HTMLElement>('em, i').forEach((n) => {
            n.style.fontStyle = on ? 'italic' : 'normal';
        });
    });
    return { changed: true };
}

/**
 * 清除格式：把选中单元格里从 Word / PDF / 网页粘进来的富文本还原成纯文本，
 * 只保留文字与换行，并清掉字符级装饰（斜体/加粗/下划线/颜色/底色）。
 * 字号、字体、对齐、边距、行高等工具栏里设的排版保持不变。
 */
export function clearFormatting(activeEls: HTMLElement[]): OpResult {
    if (activeEls.length === 0) return { changed: false, notify: '请先选中要清除格式的单元格' };

    activeEls.forEach((el) => {
        // 1) 拆掉所有子元素，只留文字与换行
        const lines = el.innerText.split('\n');
        el.innerHTML = '';
        lines.forEach((line, i) => {
            if (i) el.appendChild(document.createElement('br'));
            el.appendChild(document.createTextNode(line));
        });
        // 2) 清掉单元格自身的字符级装饰（排版设置保留）
        ['font-style', 'font-weight', 'text-decoration', 'color', 'background-color']
            .forEach((p) => el.style.removeProperty(p));
    });

    return { changed: true, notify: '已清除所选单元格的格式' };
}

export function alignText(activeEls: HTMLElement[], alignment: string): OpResult {
    if (activeEls.length === 0) return NO_CHANGE;
    activeEls.forEach((el) => { el.style.textAlign = alignment; });
    return { changed: true };
}

// ---------- 导航与光标 ----------

/** 当前表格所有 tr（thead + tbody，文档顺序）*/
export function getAllRows(table: HTMLTableElement | null): HTMLTableRowElement[] {
    return table ? Array.from(table.querySelectorAll('tr')) : [];
}

/** 按文档顺序取下一/上一个单元格（Tab 用）*/
export function tabNavigate(
    table: HTMLTableElement,
    cell: HTMLTableCellElement,
    backward: boolean,
): HTMLTableCellElement | null {
    const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('th, td'));
    const i = cells.indexOf(cell);
    if (i < 0) return null;
    return cells[backward ? i - 1 : i + 1] || null;
}

/** 按行列坐标取相邻单元格（方向键用，不换行）*/
export function gridNavigate(
    table: HTMLTableElement,
    cell: HTMLTableCellElement,
    dir: 'left' | 'right' | 'up' | 'down',
): HTMLTableCellElement | null {
    const allRows = getAllRows(table);
    let r = allRows.indexOf(cell.parentElement as HTMLTableRowElement);
    let c = cell.cellIndex;
    if (dir === 'left') c--;
    else if (dir === 'right') c++;
    else if (dir === 'up') r--;
    else if (dir === 'down') r++;
    if (r < 0 || r >= allRows.length) return null;
    const row = allRows[r];
    if (c < 0 || c >= row.children.length) return null;
    return row.children[c] as HTMLTableCellElement;
}

export interface CaretInfo {
    collapsed: boolean;
    atStart: boolean;
    atEnd: boolean;
    beforeHasNL: boolean;
    afterHasNL: boolean;
}

/**
 * 光标在单元格内的位置信息（判断是否到边界，用于方向键跨格）。
 * 注意：格内换行在 DOM 里是 <br>，而 Range.toString() 只拼文本节点、不会产出 \n，
 * 所以判断「前面/后面有没有换行」必须额外查 <br>，否则多行单元格里按上下键会直接跳出格子。
 */
export function caretInfo(cell: HTMLElement): CaretInfo {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
        return { collapsed: true, atStart: true, atEnd: true, beforeHasNL: false, afterHasNL: false };
    }
    const range = sel.getRangeAt(0);

    const pre = range.cloneRange();
    pre.selectNodeContents(cell);
    pre.setEnd(range.startContainer, range.startOffset);

    const post = range.cloneRange();
    post.selectNodeContents(cell);
    post.setStart(range.endContainer, range.endOffset);

    const hasBreak = (r: Range) => {
        const frag = r.cloneContents();
        if (frag && frag.querySelector && frag.querySelector('br')) return true;
        return r.toString().includes('\n');
    };

    const beforeNL = hasBreak(pre);
    const afterNL = hasBreak(post);

    return {
        collapsed: range.collapsed,
        atStart: pre.toString().length === 0 && !beforeNL,
        atEnd: post.toString().length === 0 && !afterNL,
        beforeHasNL: beforeNL,
        afterHasNL: afterNL,
    };
}

/** 聚焦某单元格并放置光标（selectAll=true 选中全部内容，便于覆盖输入）*/
export function placeCaret(cell: HTMLElement, selectAll: boolean): void {
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    if (!selectAll) range.collapse(false);   // 光标置于末尾
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
}

/**
 * 在光标处插入一个换行（格内换行，不跳格）。
 * contenteditable 里「末尾的 <br> 不显示」是老毛病，优先交给浏览器原生命令处理，
 * 原生命令不认再手工插入并补一个 <br>，保证新起的这一行看得见。
 */
export function insertLineBreak(target: HTMLElement): boolean {
    // 只选中还没进编辑态时，先把光标放进去（放到末尾）
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !target.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        placeCaret(target, false);
    }

    let ok = false;
    try { ok = document.execCommand('insertLineBreak'); } catch { ok = false; }
    if (!ok) { try { ok = document.execCommand('insertHTML', false, '<br>'); } catch { ok = false; } }

    if (!ok) {
        const s = window.getSelection();
        if (!s || !s.rangeCount) return false;
        const range = s.getRangeAt(0);
        range.deleteContents();
        const br = document.createElement('br');
        range.insertNode(br);
        if (!br.nextSibling) br.parentNode?.appendChild(document.createElement('br'));
        range.setStartAfter(br);
        range.collapse(true);
        s.removeAllRanges();
        s.addRange(range);
    }
    return true;
}

// ---------- 剪贴板 ----------

/** 把二维数组从 anchor 起铺进表格，行/列不够自动补齐（补的行进表体）*/
export function fillFromGrid(
    table: HTMLTableElement,
    anchor: HTMLTableCellElement,
    grid: string[][],
): void {
    const tbody = table.querySelector('tbody');
    let allRows = Array.from(table.querySelectorAll('tr'));
    const startR = allRows.indexOf(anchor.parentElement as HTMLTableRowElement);
    const startC = anchor.cellIndex;
    if (startR < 0) return;

    const maxCols = Math.max(...grid.map((g) => g.length));
    const needCols = startC + maxCols;

    // 补列（空内容，表头补 th、表体补 td）
    allRows.forEach((row) => {
        const head = isHeaderRow(row);
        while (row.children.length < needCols) row.appendChild(makeCell(head ? 'th' : 'td'));
    });

    // 补行（加到表体，空内容，列数对齐）
    const totalCols = allRows[0].children.length;
    const needRows = startR + grid.length;
    while (table.querySelectorAll('tr').length < needRows && tbody) {
        const tr = document.createElement('tr');
        for (let k = 0; k < totalCols; k++) tr.appendChild(makeCell('td'));
        tbody.appendChild(tr);
    }

    // 写入
    allRows = Array.from(table.querySelectorAll('tr'));
    for (let i = 0; i < grid.length; i++) {
        const row = allRows[startR + i];
        if (!row) break;
        for (let j = 0; j < grid[i].length; j++) {
            const cell = row.children[startC + j] as HTMLTableCellElement | undefined;
            if (cell) cell.innerText = grid[i][j];
        }
    }
}

// ---------- 导出 Markdown ----------

export function tableToMarkdown(table: HTMLTableElement): string {
    const esc = (cell: Element) =>
        (cell as HTMLElement).innerText.trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>');

    let md = '';

    const caption = table.querySelector('caption');
    if (caption && caption.innerText.trim() !== '') {
        // 表题里的换行必须转成 <br>，否则会把 Markdown 的 **...** 截成两行
        md += `**${caption.innerText.trim().replace(/\n/g, '<br>')}**\n\n`;
    }

    const headerRow = table.querySelector('thead tr');
    if (headerRow) {
        const cells = Array.from(headerRow.children);
        md += `| ${cells.map(esc).join(' | ')} |\n`;
        md += `| ${cells.map(() => '---').join(' | ')} |\n`;
    }

    table.querySelectorAll('tbody tr').forEach((row) => {
        md += `| ${Array.from(row.children).map(esc).join(' | ')} |\n`;
    });

    return md;
}

// ---------- 备份文件解析（客户端预览用）----------

/**
 * 备份文件可能来自别人，先在浏览器里洗一遍再预览。
 * 真正入库时服务端还会用 node-html-parser 再洗一次（见 src/lib/table-html.ts），
 * 两道关都过才写进 SQLite。
 */
export function sanitizeTableHtml(html: unknown): string {
    const doc = new DOMParser().parseFromString('<div id="r">' + String(html ?? '') + '</div>', 'text/html');
    const root = doc.getElementById('r');
    if (!root) return '';

    root.querySelectorAll('script, iframe, object, embed, link, meta, base, form, svg, audio, video')
        .forEach((n) => n.remove());

    root.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            const val = String(attr.value || '');
            if (name.indexOf('on') === 0) el.removeAttribute(attr.name);
            else if (/^(src|href|xlink:href|action|formaction)$/.test(name) && /^\s*javascript:/i.test(val)) {
                el.removeAttribute(attr.name);
            }
        });
    });

    return root.innerHTML;
}

export interface ParsedBackup {
    ok: boolean;
    error?: string;
    warnings?: string[];
    exportedAt?: string;
    tables?: Array<{ name: string; html: string; rows: number; cols: number }>;
}

export function parseBackup(text: string, format: string): ParsedBackup {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return { ok: false, error: '不是合法的 JSON 文件。' };
    }
    if (!data || typeof data !== 'object') return { ok: false, error: '文件内容不是一个对象。' };

    const d = data as { format?: unknown; tables?: unknown; exportedAt?: unknown };
    if (d.format !== format) {
        return { ok: false, error: '这不像是本工具导出的备份文件（format 字段对不上）。' };
    }
    if (!Array.isArray(d.tables)) return { ok: false, error: '缺少 tables 数组。' };

    const warnings: string[] = [];
    const tables: NonNullable<ParsedBackup['tables']> = [];

    d.tables.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object') { warnings.push(`第 ${i + 1} 条不是对象，已跳过`); return; }
        const t = raw as { name?: unknown; html?: unknown };
        const html = sanitizeTableHtml(t.html);
        if (!/<table[\s>]/i.test(html)) { warnings.push(`第 ${i + 1} 条里没有表格，已跳过`); return; }
        const shape = tableShape(html);
        tables.push({
            name: String(t.name || '未命名表格').slice(0, 120),
            html,
            rows: shape.rows,
            cols: shape.cols,
        });
    });

    if (tables.length === 0) return { ok: false, error: '文件里没有可用的表格。', warnings };
    return { ok: true, tables, warnings, exportedAt: String(d.exportedAt || '') };
}
