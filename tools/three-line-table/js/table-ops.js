// ============================================================
//  表格结构操作（增删行列 / 插入）+ 样式操作
//  三线表约束：表头恒为单行；至少保留 1 表头行、1 数据行、1 列。
// ============================================================

// ---------- 末尾增删 ----------

App.addRow = function () {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const tbody = currentTable.querySelector('tbody');
    if (!tbody) return;
    const headerRow = currentTable.querySelector('thead tr');
    if (!headerRow) return;

    const columnCount = headerRow.children.length;
    const newRow = document.createElement('tr');
    for (let i = 0; i < columnCount; i++) {
        const newCell = document.createElement('td');
        newCell.setAttribute('contenteditable', 'true');
        newCell.innerText = '新数据';
        newRow.appendChild(newCell);
    }
    tbody.appendChild(newRow);
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.addColumn = function () {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const allRows = currentTable.querySelectorAll('tr');
    allRows.forEach((row) => {
        const isHeaderRow = row.parentElement.tagName === 'THEAD';
        const newCell = document.createElement(isHeaderRow ? 'th' : 'td');
        newCell.setAttribute('contenteditable', 'true');
        newCell.innerText = isHeaderRow ? '新表头' : '新数据';
        row.appendChild(newCell);
    });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.removeRow = function () {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const tbody = currentTable.querySelector('tbody');
    if (!tbody || tbody.children.length === 0) return;
    // 修复(B4)：至少保留一行数据
    if (tbody.children.length <= 1) { App.notify('至少保留一行数据'); return; }

    tbody.removeChild(tbody.lastElementChild);
    App.pushHistory();
    App.pruneActiveElements();
    App.saveToLocalStorage(false);
};

App.removeColumn = function () {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const allRows = currentTable.querySelectorAll('tr');
    if (allRows.length === 0) return;
    // 修复(B4)：至少保留一列
    if (allRows[0].children.length <= 1) { App.notify('至少保留一列'); return; }

    allRows.forEach((row) => row.removeChild(row.lastElementChild));
    App.pushHistory();
    App.pruneActiveElements();
    App.saveToLocalStorage(false);
};

// ---------- 基于选中的插入 / 删除 ----------

App.insertRow = function (position = 'below') {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const tbody = currentTable.querySelector('tbody');

    let targetCell = App.getTargetCell();
    let targetRow = null;
    let parentSection = null;

    if (targetCell) {
        targetRow = targetCell.parentElement;
        parentSection = targetRow.parentElement;
    } else if (tbody && tbody.children.length > 0) {
        targetRow = tbody.lastElementChild;
        parentSection = tbody;
    } else {
        return;
    }

    const columnCount = targetRow.children.length;
    const newRow = document.createElement('tr');
    for (let i = 0; i < columnCount; i++) {
        const cell = document.createElement('td');
        cell.setAttribute('contenteditable', 'true');
        cell.innerText = '新数据';
        newRow.appendChild(cell);
    }

    // 修复(B5)：三线表只有单行表头，目标在表头时一律插到表体顶部
    if (parentSection.tagName === 'THEAD') {
        if (tbody) tbody.insertBefore(newRow, tbody.firstElementChild);
    } else if (position === 'above') {
        parentSection.insertBefore(newRow, targetRow);
    } else {
        parentSection.insertBefore(newRow, targetRow.nextSibling);
    }

    App.pushHistory();
    App.saveToLocalStorage(false);
    if (newRow.firstElementChild) App.focusCell(newRow.firstElementChild, true); // 自动聚焦，可即输入
};

App.insertColumn = function (position = 'right') {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;

    let targetIndex = -1;
    const targetCell = App.getTargetCell();
    if (targetCell) {
        targetIndex = targetCell.cellIndex;
    } else {
        const firstRow = currentTable.querySelector('tr');
        if (firstRow) targetIndex = firstRow.children.length - 1; else return;
    }

    const targetRow = targetCell ? targetCell.parentElement : null;
    let focusTarget = null;

    currentTable.querySelectorAll('tr').forEach((row) => {
        const isHeaderRow = row.parentElement.tagName === 'THEAD';
        const newCell = document.createElement(isHeaderRow ? 'th' : 'td');
        newCell.setAttribute('contenteditable', 'true');
        newCell.innerText = isHeaderRow ? '新表头' : '新数据';
        if (position === 'left') {
            row.insertBefore(newCell, row.children[targetIndex]);
        } else {
            row.insertBefore(newCell, row.children[targetIndex].nextSibling);
        }
        if (row === targetRow) focusTarget = newCell;
    });

    App.pushHistory();
    App.saveToLocalStorage(false);
    if (focusTarget) App.focusCell(focusTarget, true);
};

App.deleteTargetRow = function () {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const tbody = currentTable.querySelector('tbody');
    if (!tbody) return;

    // 收集要删的行（来自选中单元格；无选中则末尾数据行）
    const rowSet = new Set();
    App.activeElements.forEach((el) => {
        if ((el.tagName === 'TD' || el.tagName === 'TH') && el.parentElement) rowSet.add(el.parentElement);
    });
    if (rowSet.size === 0 && tbody.children.length > 0) rowSet.add(tbody.lastElementChild);
    if (rowSet.size === 0) return;

    const rows = Array.from(rowSet);
    const headerSelected = rows.some((r) => r.parentElement.tagName === 'THEAD');
    const bodyRowsToDelete = rows.filter((r) => r.parentElement.tagName === 'TBODY');

    // 修复(B4)：表头行不可删；至少保留一行数据
    if (headerSelected) App.notify('三线表的表头行不可删除');
    if (bodyRowsToDelete.length === 0) return;
    if (bodyRowsToDelete.length >= tbody.children.length) { App.notify('至少保留一行数据'); return; }

    bodyRowsToDelete.forEach((r) => r.remove());
    App.pushHistory();
    App.pruneActiveElements();
    App.saveToLocalStorage(false);
};

App.deleteTargetColumn = function () {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const allRows = Array.from(currentTable.querySelectorAll('tr'));
    if (allRows.length === 0) return;
    const totalCols = allRows[0].children.length;

    // 收集要删的列下标（多选支持）
    const colSet = new Set();
    App.activeElements.forEach((el) => {
        if (el.tagName === 'TD' || el.tagName === 'TH') colSet.add(el.cellIndex);
    });
    if (colSet.size === 0) colSet.add(totalCols - 1);

    const cols = Array.from(colSet).filter((c) => c >= 0).sort((a, b) => b - a); // 从右往左删避免错位
    if (cols.length === 0) return;
    // 修复(B4)：至少保留一列
    if (cols.length >= totalCols) { App.notify('至少保留一列'); return; }

    allRows.forEach((row) => {
        cols.forEach((c) => { if (row.children[c]) row.removeChild(row.children[c]); });
    });
    App.pushHistory();
    App.pruneActiveElements();
    App.saveToLocalStorage(false);
};

/** 清空所有选中单元格内容（右键菜单 / 供其它模块调用）*/
App.clearCells = function () {
    if (App.activeElements.length === 0) return;
    App.activeElements.forEach((el) => { if (el.tagName !== 'CAPTION') el.textContent = ''; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

/** 在表体末尾追加一行空行（Enter 到底部时用）*/
App.appendEmptyRow = function () {
    const currentTable = App.dom.tableWrapper.querySelector('table');
    if (!currentTable) return;
    const tbody = currentTable.querySelector('tbody');
    const headerRow = currentTable.querySelector('thead tr');
    if (!tbody || !headerRow) return;

    const cols = headerRow.children.length;
    const tr = document.createElement('tr');
    for (let i = 0; i < cols; i++) {
        const td = document.createElement('td');
        td.setAttribute('contenteditable', 'true');
        tr.appendChild(td);
    }
    tbody.appendChild(tr);
    App.pushHistory();
    App.saveToLocalStorage(false);
};

// ---------- 样式操作 ----------

// 清除单元格内所有子元素自带的某项内联样式（及等价的老式属性），
// 使整格文字统一继承单元格本身的样式——解决粘贴/富文本内容大小、字体不一的问题。
App.unifyCellStyle = function (el, cssProp, legacyAttr) {
    el.querySelectorAll('*').forEach((child) => {
        if (child.style) child.style.removeProperty(cssProp);
        if (legacyAttr && child.hasAttribute(legacyAttr)) child.removeAttribute(legacyAttr);
    });
};

App.applyFontFamily = function () {
    const selectedFont = App.dom.fontFamilyInput.value;
    App.activeElements.forEach((el) => {
        el.style.fontFamily = selectedFont;
        App.unifyCellStyle(el, 'font-family', 'face'); // 清掉子元素自带字体，整格统一
    });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

// 字号/边距/行高 走 oninput 实时应用（避免依赖 blur 提交，配合防抖记录历史）
App.applyFontSize = function () {
    const newSize = App.dom.fontSizeInput.value;
    if (newSize === '') return;
    App.activeElements.forEach((el) => {
        el.style.fontSize = newSize + 'px';
        App.unifyCellStyle(el, 'font-size', 'size'); // 清掉子元素自带字号，整格统一大小
    });
    App.commitStyleSoon();
};

App.applyPadding = function () {
    const newPad = App.dom.paddingInput.value;
    if (newPad === '') return;
    App.activeElements.forEach((el) => {
        el.style.paddingTop = newPad + 'px';
        el.style.paddingBottom = newPad + 'px';
    });
    App.commitStyleSoon();
};

App.applyLineHeight = function () {
    const newLh = App.dom.lineHeightInput.value;
    if (newLh === '') return;
    App.activeElements.forEach((el) => { el.style.lineHeight = newLh; });
    App.commitStyleSoon();
};

// 判断单元格“看起来”是否加粗/倾斜：除单元格自身外，还要看粘贴进来的
// <b>/<strong>/<em>/<i> 等标签——它们自带样式，会盖过单元格的设置。
App.isRenderedBold = function (el) {
    const w = window.getComputedStyle(el).fontWeight;
    if (w === 'bold' || parseInt(w, 10) >= 600) return true;
    return !!el.querySelector('b, strong');
};

App.isRenderedItalic = function (el) {
    if (window.getComputedStyle(el).fontStyle === 'italic') return true;
    return !!el.querySelector('em, i');
};

App.toggleBold = function () {
    if (App.activeElements.length === 0) return;
    const shouldBold = !App.isRenderedBold(App.activeElements[0]);
    App.activeElements.forEach((el) => {
        el.style.fontWeight = shouldBold ? 'bold' : 'normal';
        App.unifyCellStyle(el, 'font-weight');                    // 清掉子元素内联字重
        el.querySelectorAll('b, strong').forEach((n) => {         // <b>/<strong> 自带加粗，需显式覆盖
            n.style.fontWeight = shouldBold ? 'bold' : 'normal';
        });
    });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.toggleItalic = function () {
    if (App.activeElements.length === 0) return;
    const shouldItalic = !App.isRenderedItalic(App.activeElements[0]);
    App.activeElements.forEach((el) => {
        el.style.fontStyle = shouldItalic ? 'italic' : 'normal';
        App.unifyCellStyle(el, 'font-style');                     // 清掉子元素内联斜体
        el.querySelectorAll('em, i').forEach((n) => {             // <em>/<i> 自带斜体，需显式覆盖
            n.style.fontStyle = shouldItalic ? 'italic' : 'normal';
        });
    });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

/**
 * 清除格式：把选中单元格里从 Word / PDF / 网页粘进来的富文本还原成纯文本，
 * 只保留文字与换行，并清掉字符级装饰（斜体/加粗/下划线/颜色/底色）。
 * 字号、字体、对齐、边距、行高等你在工具栏里设的排版保持不变。
 */
App.clearFormatting = function () {
    if (App.activeElements.length === 0) {
        App.notify('请先选中要清除格式的单元格');
        return;
    }
    App.activeElements.forEach((el) => {
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
    App.pushHistory();
    App.saveToLocalStorage(false);
    App.notify('已清除所选单元格的格式');
};

App.alignText = function (alignment) {
    App.activeElements.forEach((el) => { el.style.textAlign = alignment; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};
