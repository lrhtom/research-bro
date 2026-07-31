// ============================================================
//  多表格管理 + localStorage 持久化 + 撤销/重做
// ============================================================

// ---------- 撤销 / 重做（HTML 快照栈）----------

/** 拍摄当前 tableWrapper 的 HTML 快照并压入历史栈 */
App.pushHistory = function () {
    // 表格结构/样式一变，导出尺寸提示就得跟着变（放在 historyPaused 判断之前）
    if (App.updateExportSizeHint) App.updateExportSizeHint();
    if (App.historyPaused) return;
    const { tableWrapper } = App.dom;

    // 拍快照前先移除选中高亮，保持快照干净
    App.activeElements.forEach((el) => {
        if (el.isConnected) el.classList.remove('selected-cell');
    });
    const snapshot = tableWrapper.innerHTML;
    App.activeElements.forEach((el) => {
        if (el.isConnected) el.classList.add('selected-cell');
    });

    // 若之前 undo 过，截断后面的记录
    if (App.historyIndex < App.historyStack.length - 1) {
        App.historyStack = App.historyStack.slice(0, App.historyIndex + 1);
    }

    // 避免连续压入完全相同的快照
    if (App.historyStack.length > 0 && App.historyStack[App.historyStack.length - 1] === snapshot) {
        return;
    }

    App.historyStack.push(snapshot);
    if (App.historyStack.length > App.MAX_HISTORY) {
        App.historyStack.shift();
    }
    App.historyIndex = App.historyStack.length - 1;
};

/** 撤销 */
App.undo = function () {
    if (App.historyIndex <= 0) return;
    App.historyIndex--;
    App.restoreSnapshot(App.historyStack[App.historyIndex]);
};

/** 重做 */
App.redo = function () {
    if (App.historyIndex >= App.historyStack.length - 1) return;
    App.historyIndex++;
    App.restoreSnapshot(App.historyStack[App.historyIndex]);
};

/** 用快照内容替换当前表格 */
App.restoreSnapshot = function (snapshot) {
    App.historyPaused = true;
    App.clearSelection();
    App.dom.tableWrapper.innerHTML = snapshot;
    App.historyPaused = false;
    // 修复(B7)：撤销/重做后即时写回 localStorage
    App.saveToLocalStorage(false);
};

// ---------- 存储与多表管理 ----------

App.loadFromLocalStorage = function () {
    const stored = localStorage.getItem(App.LOCAL_STORAGE_KEY);
    if (stored) {
        try {
            App.tableDataList = JSON.parse(stored);
        } catch (e) {
            console.error('解析 localStorage 数据失败', e);
            App.tableDataList = [];
        }
    } else {
        App.tableDataList = [];
    }

    if (App.tableDataList.length === 0) {
        App.createNewTable('表 1: 未命名表格');
    } else {
        App.switchTable(App.tableDataList[0].id);
    }
};

App.saveToLocalStorage = function (showToast = false) {
    const { tableWrapper, tableNameInput, toast } = App.dom;

    if (App.currentTableId) {
        const currentTable = App.tableDataList.find((t) => t.id === App.currentTableId);
        if (currentTable) {
            App.activeElements.forEach((el) => {
                if (el.isConnected) el.classList.remove('selected-cell');
            });
            currentTable.html = tableWrapper.innerHTML;
            currentTable.name = tableNameInput.value;
            App.activeElements.forEach((el) => {
                if (el.isConnected) el.classList.add('selected-cell');
            });
        }
    }

    localStorage.setItem(App.LOCAL_STORAGE_KEY, JSON.stringify(App.tableDataList));
    App.renderSidebarList();
    // 覆盖撤销/重做（restoreSnapshot 不走 pushHistory）等路径
    if (App.updateExportSizeHint) App.updateExportSizeHint();

    if (showToast) {
        toast.innerHTML = '<i class="fas fa-check-circle"></i> 保存成功';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    }
};

App.renderSidebarList = function () {
    const { tableListContainer } = App.dom;
    tableListContainer.innerHTML = '';
    App.tableDataList.forEach((data) => {
        const li = document.createElement('li');
        li.className = `table-item ${data.id === App.currentTableId ? 'active' : ''}`;
        // 修复(B3)：表名转义，避免含 < / 引号时破版或注入
        li.innerHTML = `
            <span class="table-name" onclick="App.switchTable('${data.id}')">${App.escapeHtml(data.name)}</span>
            <button class="delete-btn" onclick="App.deleteTable('${data.id}', event)" title="删除图表"><i class="fas fa-trash"></i></button>
        `;
        tableListContainer.appendChild(li);
    });
};

App.switchTable = function (id) {
    const { tableWrapper, tableNameInput } = App.dom;

    // 先保存当前活跃表
    if (App.currentTableId) {
        const currentTable = App.tableDataList.find((t) => t.id === App.currentTableId);
        if (currentTable) {
            App.activeElements.forEach((el) => {
                if (el.isConnected) el.classList.remove('selected-cell');
            });
            currentTable.html = tableWrapper.innerHTML;
            currentTable.name = tableNameInput.value;
        }
        localStorage.setItem(App.LOCAL_STORAGE_KEY, JSON.stringify(App.tableDataList));
    }

    App.currentTableId = id;
    const targetTable = App.tableDataList.find((t) => t.id === id);
    if (targetTable) {
        tableNameInput.value = targetTable.name;
        tableWrapper.innerHTML = targetTable.html;
    }

    // 旧 DOM 已销毁，彻底重置选中引用
    App.activeElements = [];
    App.anchorCell = null;
    App.updateToolbarState();
    App.renderSidebarList();

    // 重置历史栈并压入初始状态
    App.historyStack = [];
    App.historyIndex = -1;
    App.pushHistory();
};

/** 用现成的表格 HTML 新建一张表并切过去（Markdown 导入等复用）*/
App.createTableFromHtml = function (name, html) {
    // 加随机后缀：同一毫秒内连续创建多张表也不会撞 id
    const newId = 'table_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    App.tableDataList.unshift({ id: newId, name, html });
    App.switchTable(newId);
    return newId;
};

App.createNewTable = function (name = '新图表') {
    const defaultHTML = `
        <table class="academic-table" id="main-table">
            <caption contenteditable="true">${App.escapeHtml(name)}</caption>
            <thead>
                <tr>
                    <th contenteditable="true">字段名称</th>
                    <th contenteditable="true">数据类型</th>
                    <th contenteditable="true">描述说明</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td contenteditable="true">id</td>
                    <td contenteditable="true">BIGINT</td>
                    <td contenteditable="true">用户唯一标识</td>
                </tr>
                <tr>
                    <td contenteditable="true">username</td>
                    <td contenteditable="true">VARCHAR</td>
                    <td contenteditable="true">用户登录名</td>
                </tr>
            </tbody>
        </table>
    `;

    App.createTableFromHtml(name, defaultHTML);
};

App.deleteTable = function (id, event) {
    event.stopPropagation();
    if (App.tableDataList.length <= 1) {
        alert('至少需要保留一个表格！您可以选择清空里面的内容。');
        return;
    }
    if (confirm('确定要删除这个图表吗？此操作不可撤销。')) {
        App.tableDataList = App.tableDataList.filter((t) => t.id !== id);
        if (App.currentTableId === id) {
            App.currentTableId = null; // 防止 switchTable 再次保存已删除表
            App.switchTable(App.tableDataList[0].id);
        } else {
            App.saveToLocalStorage(false);
        }
    }
};

App.renameCurrentTable = function () {
    App.saveToLocalStorage(false);
};

App.toggleSidebar = function () {
    App.dom.sidebar.classList.toggle('collapsed');
};
