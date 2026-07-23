// ============================================================
//  选择模型 + 键盘导航 + 右键菜单（Excel 式，围绕三线表）
//  · 点选 / Ctrl 多选 / Shift 矩形 / 鼠标拖拽框选
//  · Tab·Enter·方向键 单元格间导航；Delete 清空选中
//  · 单元格右键上下文菜单
// ============================================================

// ---------- 选择辅助 ----------

/** 当前表格所有 tr（thead + tbody，文档顺序）*/
App.getAllRows = function () {
    const table = App.dom.tableWrapper.querySelector('table');
    return table ? Array.from(table.querySelectorAll('tr')) : [];
};

/** 单选一个单元格 */
App.setSingleSelection = function (cell) {
    App.activeElements.forEach((el) => { if (el.isConnected) el.classList.remove('selected-cell'); });
    App.activeElements = [cell];
    cell.classList.add('selected-cell');
    App.updateToolbarState();
};

/** 选中 anchor→target 的矩形区域（跨表头/表体，caption 除外）*/
App.selectRange = function (anchor, target) {
    if (anchor.tagName === 'CAPTION' || target.tagName === 'CAPTION') {
        App.setSingleSelection(target);
        return;
    }
    const allRows = App.getAllRows();
    const a = { r: allRows.indexOf(anchor.parentElement), c: anchor.cellIndex };
    const b = { r: allRows.indexOf(target.parentElement), c: target.cellIndex };
    if (a.r < 0 || b.r < 0) return;
    const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
    const c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);

    App.activeElements.forEach((el) => { if (el.isConnected) el.classList.remove('selected-cell'); });
    App.activeElements = [];
    for (let r = r1; r <= r2; r++) {
        const cells = allRows[r].children;
        for (let c = c1; c <= c2 && c < cells.length; c++) {
            cells[c].classList.add('selected-cell');
            App.activeElements.push(cells[c]);
        }
    }
    App.updateToolbarState();
};

/** 取当前应操作的单元格：优先编辑焦点，其次选中的第一个 */
App.getCurrentCell = function () {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TD' || ae.tagName === 'TH') && App.dom.tableWrapper.contains(ae)) return ae;
    return App.activeElements.find((el) => el.tagName === 'TD' || el.tagName === 'TH') || null;
};

/** 聚焦某单元格并放置光标（selectAll=true 选中全部内容，便于覆盖输入）*/
App.focusCell = function (cell, selectAll) {
    cell.focus();
    const range = document.createRange();
    range.selectNodeContents(cell);
    if (!selectAll) range.collapse(false); // 光标置于末尾
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    App.setSingleSelection(cell);
    App.anchorCell = cell;
};

/** 按文档顺序取下一/上一个单元格（Tab 用）*/
App.tabNavigate = function (cell, backward) {
    const table = App.dom.tableWrapper.querySelector('table');
    if (!table) return null;
    const cells = Array.from(table.querySelectorAll('th, td'));
    const i = cells.indexOf(cell);
    if (i < 0) return null;
    return cells[backward ? i - 1 : i + 1] || null;
};

/** 按行列坐标取相邻单元格（方向键用，不换行）*/
App.gridNavigate = function (cell, dir) {
    const allRows = App.getAllRows();
    let r = allRows.indexOf(cell.parentElement);
    let c = cell.cellIndex;
    if (dir === 'left') c--; else if (dir === 'right') c++;
    else if (dir === 'up') r--; else if (dir === 'down') r++;
    if (r < 0 || r >= allRows.length) return null;
    const row = allRows[r];
    if (c < 0 || c >= row.children.length) return null;
    return row.children[c];
};

/** 光标在单元格内的位置信息（判断是否到边界，用于方向键跨格）*/
App.caretInfo = function (cell) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return { collapsed: true, atStart: true, atEnd: true, beforeHasNL: false, afterHasNL: false };
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange(); pre.selectNodeContents(cell); pre.setEnd(range.startContainer, range.startOffset);
    const before = pre.toString();
    const post = range.cloneRange(); post.selectNodeContents(cell); post.setStart(range.endContainer, range.endOffset);
    const after = post.toString();
    return {
        collapsed: range.collapsed,
        atStart: before.length === 0,
        atEnd: after.length === 0,
        beforeHasNL: before.includes('\n'),
        afterHasNL: after.includes('\n'),
    };
};

// ---------- 鼠标选择（含拖拽框选）----------

App.initSelection = function () {
    const { tableWrapper } = App.dom;

    tableWrapper.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return; // 只有左键触发选择/拖拽；右键交给上下文菜单
        const target = event.target.closest('td, th, caption');
        if (!target || !tableWrapper.contains(target)) return;

        // Ctrl/Cmd 逐个切换
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const idx = App.activeElements.indexOf(target);
            if (idx > -1) {
                target.classList.remove('selected-cell');
                App.activeElements.splice(idx, 1);
            } else {
                target.classList.add('selected-cell');
                App.activeElements.push(target);
            }
            App.anchorCell = target;
            App.updateToolbarState();
            return;
        }

        // Shift 矩形选择
        if (event.shiftKey && App.anchorCell) {
            event.preventDefault();
            App.selectRange(App.anchorCell, target);
            return;
        }

        // 普通按下：记录拖拽起点（不 preventDefault，保留点击进入编辑）
        App.dragStart = target;
        App.isDragging = false;
        App.setSingleSelection(target);
        App.anchorCell = target;
    });

    // 拖拽经过其它单元格 → 框选
    document.addEventListener('mousemove', (event) => {
        if (!App.dragStart) return;
        const target = event.target.closest('td, th');
        if (!target || target === App.dragStart) return;
        if (App.dragStart.tagName === 'CAPTION' || target.tagName === 'CAPTION') return;
        App.isDragging = true;
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges(); // 抑制文本选区
        App.selectRange(App.dragStart, target);
    });

    document.addEventListener('mouseup', () => {
        App.dragStart = null;
        setTimeout(() => { App.isDragging = false; }, 0);
    });

    // 点击表格/工具栏/侧边栏/右键菜单之外 → 清除选中
    document.addEventListener('mousedown', (event) => {
        const t = event.target;
        if (!t || typeof t.closest !== 'function') return;
        if (!tableWrapper.contains(t)
            && !t.closest('.toolbar')
            && !t.closest('.sidebar-nav')
            && !t.closest('.context-menu')) {
            App.clearSelection();
        }
    });
};

// ---------- 键盘：快捷键 + 导航 ----------

App.flushPendingHistory = function () {
    if (App.inputTimer) {
        clearTimeout(App.inputTimer);
        App.inputTimer = null;
        App.pushHistory();
    }
};

App.initKeyboard = function () {
    document.addEventListener('keydown', (event) => {
        const isCtrl = event.ctrlKey || event.metaKey;
        const ae = document.activeElement;
        const inFormField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA');

        // 保存 (Ctrl + S) —— 全局有效
        if (isCtrl && event.key.toLowerCase() === 's') {
            event.preventDefault();
            App.saveToLocalStorage(true);
            return;
        }

        // 修复(B6)：焦点在表单控件里时，让出原生行为（撤销/全选/加粗等）
        if (inFormField) return;

        // 全选 (Ctrl + A)
        if (isCtrl && event.key.toLowerCase() === 'a') {
            if (App.activeElements.length === 1) return; // 放行格内文字全选
            event.preventDefault();
            const currentTable = App.dom.tableWrapper.querySelector('table');
            if (currentTable) {
                const allCells = Array.from(currentTable.querySelectorAll('td, th, caption'));
                App.activeElements.forEach((el) => { if (el.isConnected) el.classList.remove('selected-cell'); });
                App.activeElements = allCells;
                App.activeElements.forEach((el) => el.classList.add('selected-cell'));
                App.updateToolbarState();
            }
            return;
        }

        if (isCtrl && event.key.toLowerCase() === 'b') { event.preventDefault(); App.toggleBold(); return; }
        if (isCtrl && event.key.toLowerCase() === 'i') { event.preventDefault(); App.toggleItalic(); return; }
        if (isCtrl && event.key.toLowerCase() === 'z') { event.preventDefault(); App.flushPendingHistory(); App.undo(); return; }
        if (isCtrl && event.key.toLowerCase() === 'y') { event.preventDefault(); App.redo(); return; }

        if (event.key === 'Escape') { App.clearSelection(); return; }

        // ---- 以下为单元格导航 / 清空（不与 Ctrl 组合）----
        if (isCtrl) return;

        const cell = App.getCurrentCell();

        // Tab / Shift+Tab
        if (event.key === 'Tab') {
            if (!cell) return;
            event.preventDefault();
            const t = App.tabNavigate(cell, event.shiftKey);
            if (t) App.focusCell(t, true);
            return;
        }

        // Enter 下移；Shift+Enter 换行（放行默认）
        if (event.key === 'Enter' && !event.shiftKey) {
            if (!cell) return;
            event.preventDefault();
            let t = App.gridNavigate(cell, 'down');
            if (!t && cell.parentElement.parentElement.tagName === 'TBODY') {
                App.appendEmptyRow();
                t = App.gridNavigate(cell, 'down');
            }
            if (t) App.focusCell(t, true);
            return;
        }

        // Delete / Backspace：多选时清空所有选中单元格
        if ((event.key === 'Delete' || event.key === 'Backspace') && App.activeElements.length >= 2) {
            event.preventDefault();
            App.activeElements.forEach((el) => { if (el.tagName !== 'CAPTION') el.textContent = ''; });
            App.pushHistory();
            App.saveToLocalStorage(false);
            return;
        }

        // 方向键：光标到达文本边界时跨格
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            if (!cell) return;
            const info = App.caretInfo(cell);
            if (!info.collapsed) return;
            let dir = '';
            if (event.key === 'ArrowRight' && info.atEnd) dir = 'right';
            else if (event.key === 'ArrowLeft' && info.atStart) dir = 'left';
            else if (event.key === 'ArrowDown' && !info.afterHasNL) dir = 'down';
            else if (event.key === 'ArrowUp' && !info.beforeHasNL) dir = 'up';
            if (dir) {
                const t = App.gridNavigate(cell, dir);
                if (t) { event.preventDefault(); App.focusCell(t, false); }
            }
        }
    });
};

// ---------- 右键上下文菜单 ----------

App.initContextMenu = function () {
    const { tableWrapper } = App.dom;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.display = 'none';
    menu.innerHTML = `
        <button type="button" data-action="insert-row-above"><i class="fas fa-arrow-up"></i> 上方插入行</button>
        <button type="button" data-action="insert-row-below"><i class="fas fa-arrow-down"></i> 下方插入行</button>
        <div class="context-sep"></div>
        <button type="button" data-action="insert-col-left"><i class="fas fa-arrow-left"></i> 左侧插入列</button>
        <button type="button" data-action="insert-col-right"><i class="fas fa-arrow-right"></i> 右侧插入列</button>
        <div class="context-sep"></div>
        <button type="button" data-action="delete-row" class="danger"><i class="fas fa-trash-alt"></i> 删除行</button>
        <button type="button" data-action="delete-col" class="danger"><i class="fas fa-trash-alt"></i> 删除列</button>
        <button type="button" data-action="clear"><i class="fas fa-eraser"></i> 清空内容</button>
    `;
    document.body.appendChild(menu);
    App.dom.contextMenu = menu;

    const hide = () => { menu.style.display = 'none'; };

    tableWrapper.addEventListener('contextmenu', (event) => {
        const cell = event.target.closest('td, th');
        if (!cell || !tableWrapper.contains(cell)) return;
        event.preventDefault();
        // 右键的单元格若不在当前选区，则单选它
        if (!App.activeElements.includes(cell)) App.setSingleSelection(cell);
        App.anchorCell = cell;

        menu.style.display = 'block';
        // 防止菜单超出视口
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        let x = event.pageX, y = event.pageY;
        if (x + mw > window.scrollX + window.innerWidth) x -= mw;
        if (y + mh > window.scrollY + window.innerHeight) y -= mh;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    });

    menu.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        switch (action) {
            case 'insert-row-above': App.insertRow('above'); break;
            case 'insert-row-below': App.insertRow('below'); break;
            case 'insert-col-left': App.insertColumn('left'); break;
            case 'insert-col-right': App.insertColumn('right'); break;
            case 'delete-row': App.deleteTargetRow(); break;
            case 'delete-col': App.deleteTargetColumn(); break;
            case 'clear': App.clearCells(); break;
        }
        hide();
    });

    document.addEventListener('mousedown', (event) => {
        const t = event.target;
        if (!t || typeof t.closest !== 'function' || !t.closest('.context-menu')) hide();
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
};
