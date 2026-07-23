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

App.applyFontFamily = function () {
    const selectedFont = App.dom.fontFamilyInput.value;
    App.activeElements.forEach((el) => { el.style.fontFamily = selectedFont; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.applyFontSize = function () {
    const newSize = App.dom.fontSizeInput.value;
    App.activeElements.forEach((el) => { el.style.fontSize = newSize + 'px'; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.applyPadding = function () {
    const newPad = App.dom.paddingInput.value;
    App.activeElements.forEach((el) => {
        el.style.paddingTop = newPad + 'px';
        el.style.paddingBottom = newPad + 'px';
    });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.applyLineHeight = function () {
    const newLh = App.dom.lineHeightInput.value;
    App.activeElements.forEach((el) => { el.style.lineHeight = newLh; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.toggleBold = function () {
    if (App.activeElements.length === 0) return;
    const firstStyle = window.getComputedStyle(App.activeElements[0]).fontWeight;
    const shouldBold = !(firstStyle === 'bold' || parseInt(firstStyle) >= 600);
    App.activeElements.forEach((el) => { el.style.fontWeight = shouldBold ? 'bold' : 'normal'; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.toggleItalic = function () {
    if (App.activeElements.length === 0) return;
    const firstStyle = window.getComputedStyle(App.activeElements[0]).fontStyle;
    const shouldItalic = (firstStyle !== 'italic');
    App.activeElements.forEach((el) => { el.style.fontStyle = shouldItalic ? 'italic' : 'normal'; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};

App.alignText = function (alignment) {
    App.activeElements.forEach((el) => { el.style.textAlign = alignment; });
    App.pushHistory();
    App.saveToLocalStorage(false);
};
