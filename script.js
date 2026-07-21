document.addEventListener('DOMContentLoaded', () => {
    let activeElements = []; 
    let tableDataList = [];
    let currentTableId = null;

    const tableWrapper = document.getElementById('table-export-area');
    const styleToolbar = document.getElementById('style-toolbar');
    const fontSizeInput = document.getElementById('font-size-input');
    const paddingInput = document.getElementById('padding-input');
    const lineHeightInput = document.getElementById('line-height-input');
    const fontFamilyInput = document.getElementById('font-family-input');
    const sidebar = document.getElementById('sidebar');
    const tableListContainer = document.getElementById('table-list');
    const tableNameInput = document.getElementById('current-table-name');
    const toast = document.getElementById('toast');

    const LOCAL_STORAGE_KEY = 'academic_tables_data';

    // ==========================================
    // 工具函数
    // ==========================================

    /** 清除所有选中状态并重置 activeElements */
    function clearSelection() {
        activeElements.forEach(el => {
            // 只操作仍在文档中的元素，避免操作已脱离 DOM 的僵尸节点
            if (el.isConnected) {
                el.classList.remove('selected-cell');
            }
        });
        activeElements = [];
        updateToolbarState();
    }

    /** 从 activeElements 中移除已脱离 DOM 的僵尸引用 */
    function pruneActiveElements() {
        activeElements = activeElements.filter(el => el.isConnected);
        updateToolbarState();
    }

    // ==========================================
    // 撤销 / 重做 (Ctrl+Z / Ctrl+Y)
    // ==========================================

    const MAX_HISTORY = 50;
    let historyStack = [];   // 快照数组
    let historyIndex = -1;   // 当前指向的位置
    let historyPaused = false; // 内部恢复时暂停记录
    let inputTimer = null;   // 文字输入防抖定时器

    /** 拍摄当前 tableWrapper 的 HTML 快照并压入历史栈 */
    function pushHistory() {
        if (historyPaused) return;

        // 拍快照前先移除选中高亮，保持快照干净
        activeElements.forEach(el => {
            if (el.isConnected) el.classList.remove('selected-cell');
        });
        const snapshot = tableWrapper.innerHTML;
        activeElements.forEach(el => {
            if (el.isConnected) el.classList.add('selected-cell');
        });

        // 如果当前不在栈顶（之前 undo 过），截断后面的记录
        if (historyIndex < historyStack.length - 1) {
            historyStack = historyStack.slice(0, historyIndex + 1);
        }

        // 避免连续压入完全相同的快照
        if (historyStack.length > 0 && historyStack[historyStack.length - 1] === snapshot) {
            return;
        }

        historyStack.push(snapshot);
        if (historyStack.length > MAX_HISTORY) {
            historyStack.shift();
        }
        historyIndex = historyStack.length - 1;
    }

    /** 撤销：回退到上一个快照 */
    function undo() {
        if (historyIndex <= 0) return;
        historyIndex--;
        restoreSnapshot(historyStack[historyIndex]);
    }

    /** 重做：前进到下一个快照 */
    function redo() {
        if (historyIndex >= historyStack.length - 1) return;
        historyIndex++;
        restoreSnapshot(historyStack[historyIndex]);
    }

    /** 用快照内容替换当前表格，恢复期间暂停历史记录 */
    function restoreSnapshot(snapshot) {
        historyPaused = true;
        clearSelection();
        tableWrapper.innerHTML = snapshot;
        historyPaused = false;
    }

    // ==========================================
    // 存储与多表格管理逻辑
    // ==========================================

    function loadFromLocalStorage() {
        const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (stored) {
            try {
                tableDataList = JSON.parse(stored);
            } catch (e) {
                console.error('解析 localStorage 数据失败', e);
                tableDataList = [];
            }
        } else {
            tableDataList = [];
        }

        if (tableDataList.length === 0) {
            createNewTable("表 1: 未命名表格");
        } else {
            switchTable(tableDataList[0].id);
        }
    }

    window.saveToLocalStorage = function(showToast = false) {
        if (currentTableId) {
            const currentTable = tableDataList.find(t => t.id === currentTableId);
            if (currentTable) {
                // 保存前移除虚线选中框，保证存储的 HTML 是干净的
                activeElements.forEach(el => {
                    if (el.isConnected) el.classList.remove('selected-cell');
                });
                currentTable.html = tableWrapper.innerHTML;
                currentTable.name = tableNameInput.value;
                // 恢复选中框
                activeElements.forEach(el => {
                    if (el.isConnected) el.classList.add('selected-cell');
                });
            }
        }
        
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(tableDataList));
        renderSidebarList();

        if (showToast) {
            toast.classList.add('show');
            setTimeout(() => {
                toast.classList.remove('show');
            }, 2000);
        }
    };

    function renderSidebarList() {
        tableListContainer.innerHTML = '';
        tableDataList.forEach(data => {
            const li = document.createElement('li');
            li.className = `table-item ${data.id === currentTableId ? 'active' : ''}`;
            li.innerHTML = `
                <span class="table-name" onclick="switchTable('${data.id}')">${data.name}</span>
                <button class="delete-btn" onclick="deleteTable('${data.id}', event)" title="删除图表"><i class="fas fa-trash"></i></button>
            `;
            tableListContainer.appendChild(li);
        });
    }

    window.switchTable = function(id) {
        // 先保存当前正活跃的（不触发 renderSidebarList，避免重复渲染）
        if (currentTableId) {
            const currentTable = tableDataList.find(t => t.id === currentTableId);
            if (currentTable) {
                activeElements.forEach(el => {
                    if (el.isConnected) el.classList.remove('selected-cell');
                });
                currentTable.html = tableWrapper.innerHTML;
                currentTable.name = tableNameInput.value;
            }
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(tableDataList));
        }
        
        currentTableId = id;
        const targetTable = tableDataList.find(t => t.id === id);
        if (targetTable) {
            tableNameInput.value = targetTable.name;
            tableWrapper.innerHTML = targetTable.html;
        }

        // 切换后旧 DOM 已销毁，必须彻底重置选中引用
        activeElements = [];
        updateToolbarState();
        renderSidebarList();

        // 重置历史记录栈并压入新表格的初始状态
        historyStack = [];
        historyIndex = -1;
        pushHistory();
    };

    window.createNewTable = function(name = "新图表") {
        const newId = 'table_' + Date.now();
        const defaultHTML = `
            <table class="academic-table" id="main-table">
                <caption contenteditable="true">${name}</caption>
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

        tableDataList.unshift({
            id: newId,
            name: name,
            html: defaultHTML
        });
        
        switchTable(newId);
    };

    window.deleteTable = function(id, event) {
        event.stopPropagation();
        if (tableDataList.length <= 1) {
            alert('至少需要保留一个表格！您可以选择清空里面的内容。');
            return;
        }
        if (confirm('确定要删除这个图表吗？此操作不可撤销。')) {
            tableDataList = tableDataList.filter(t => t.id !== id);
            if (currentTableId === id) {
                // 删除的是当前的，需要切换
                currentTableId = null; // 先置空，防止 switchTable 里再次保存已删除表格的数据
                switchTable(tableDataList[0].id);
            } else {
                saveToLocalStorage(false);
            }
        }
    };

    window.renameCurrentTable = function() {
        saveToLocalStorage(false);
    };

    window.toggleSidebar = function() {
        sidebar.classList.toggle('collapsed');
    };

    // ==========================================
    // 样式与快捷键逻辑
    // ==========================================

    function updateToolbarState() {
        if (activeElements.length > 0) {
            styleToolbar.classList.add('active');
            let firstElement = activeElements[0];
            let currentStyle = window.getComputedStyle(firstElement);
            
            // 字号
            fontSizeInput.value = Math.round(parseFloat(currentStyle.fontSize));

            // 边距
            paddingInput.value = Math.round(parseFloat(currentStyle.paddingTop)) || 14;

            // 行高
            let rawLineHeight = currentStyle.lineHeight;
            if (rawLineHeight === 'normal') {
                lineHeightInput.value = 1.5;
            } else {
                let lhPx = parseFloat(rawLineHeight);
                let fsPx = parseFloat(currentStyle.fontSize);
                if (lhPx && fsPx) {
                    lineHeightInput.value = parseFloat((lhPx / fsPx).toFixed(1));
                } else {
                    lineHeightInput.value = 1.5;
                }
            }

            // 字体
            let currentFontFamily = currentStyle.fontFamily.toLowerCase();
            if (currentFontFamily.includes('calibri')) {
                fontFamilyInput.value = "Calibri, sans-serif";
            } else if (currentFontFamily.includes('arial')) {
                fontFamilyInput.value = "Arial, sans-serif";
            } else {
                fontFamilyInput.value = "'Times New Roman', Times, serif";
            }
        } else {
            styleToolbar.classList.remove('active');
        }
    }

    // 事件代理：监听整个表格容器内的点击事件
    tableWrapper.addEventListener('click', (event) => {
        // 使用 closest 向上寻找，避免点击到单元格内部的 p、span 等标签时无法选中
        let target = event.target.closest('td, th, caption');
        
        if (target && tableWrapper.contains(target)) {
            
            if (event.ctrlKey || event.metaKey) {
                const index = activeElements.indexOf(target);
                if (index > -1) {
                    target.classList.remove('selected-cell');
                    activeElements.splice(index, 1);
                } else {
                    target.classList.add('selected-cell');
                    activeElements.push(target);
                }
            } else {
                activeElements.forEach(el => {
                    if (el.isConnected) el.classList.remove('selected-cell');
                });
                activeElements = [target];
                target.classList.add('selected-cell');
            }

            if (!target.hasAttribute('contenteditable')) {
                target.setAttribute('contenteditable', 'true');
            }

            updateToolbarState();
        }
    });

    document.addEventListener('click', (event) => {
        if (!tableWrapper.contains(event.target) && !event.target.closest('.toolbar') && !event.target.closest('.sidebar-nav')) {
            clearSelection();
        }
    });

    // 快捷键支持
    document.addEventListener('keydown', (event) => {
        const isCtrl = event.ctrlKey || event.metaKey;

        // 保存 (Ctrl + S)
        if (isCtrl && event.key.toLowerCase() === 's') {
            event.preventDefault();
            saveToLocalStorage(true);
            return;
        }

        // 全选 (Ctrl + A)
        if (isCtrl && event.key.toLowerCase() === 'a') {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') {
                return;
            }
            
            // 如果只选中了一个单元格，允许原生 Ctrl+A 选中该单元格内部的文字
            if (activeElements.length === 1) {
                return;
            }

            event.preventDefault(); 
            
            const currentTable = tableWrapper.querySelector('table');
            if (currentTable) {
                const allCells = Array.from(currentTable.querySelectorAll('td, th, caption'));
                activeElements.forEach(el => {
                    if (el.isConnected) el.classList.remove('selected-cell');
                });
                activeElements = allCells;
                activeElements.forEach(el => el.classList.add('selected-cell'));
                updateToolbarState();
            }
        }

        // 粗体 (Ctrl + B)
        if (isCtrl && event.key.toLowerCase() === 'b') {
            event.preventDefault();
            window.toggleBold();
        }

        // 斜体 (Ctrl + I)
        if (isCtrl && event.key.toLowerCase() === 'i') {
            event.preventDefault();
            window.toggleItalic();
        }

        // 撤销 (Ctrl + Z)
        if (isCtrl && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            undo();
            return;
        }

        // 重做 (Ctrl + Y)
        if (isCtrl && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            redo();
            return;
        }

        // 取消选择 (Escape)
        if (event.key === 'Escape') {
            clearSelection();
        }
    });

    // 监听文字编辑：用户在单元格内输入文字后，防抖记录快照
    tableWrapper.addEventListener('input', () => {
        clearTimeout(inputTimer);
        inputTimer = setTimeout(() => {
            pushHistory();
        }, 600); // 600ms 防抖，打字停下来后再记录
    });

    // ==========================================
    // 表格样式操作方法
    // ==========================================

    window.applyFontFamily = function() {
        const selectedFont = fontFamilyInput.value;
        activeElements.forEach(el => { el.style.fontFamily = selectedFont; });
        pushHistory();
        saveToLocalStorage(false);
    };

    window.applyFontSize = function() {
        const newSize = fontSizeInput.value;
        activeElements.forEach(el => { el.style.fontSize = newSize + 'px'; });
        pushHistory();
        saveToLocalStorage(false);
    };

    window.applyPadding = function() {
        const newPad = paddingInput.value;
        activeElements.forEach(el => { 
            el.style.paddingTop = newPad + 'px';
            el.style.paddingBottom = newPad + 'px';
        });
        pushHistory();
        saveToLocalStorage(false);
    };

    window.applyLineHeight = function() {
        const newLh = lineHeightInput.value;
        activeElements.forEach(el => { 
            el.style.lineHeight = newLh;
        });
        pushHistory();
        saveToLocalStorage(false);
    };

    window.toggleBold = function() {
        if (activeElements.length === 0) return;
        let firstStyle = window.getComputedStyle(activeElements[0]).fontWeight;
        let shouldBold = !(firstStyle === 'bold' || parseInt(firstStyle) >= 600);
        activeElements.forEach(el => { el.style.fontWeight = shouldBold ? 'bold' : 'normal'; });
        pushHistory();
        saveToLocalStorage(false);
    };

    window.toggleItalic = function() {
        if (activeElements.length === 0) return;
        let firstStyle = window.getComputedStyle(activeElements[0]).fontStyle;
        let shouldItalic = (firstStyle !== 'italic');
        activeElements.forEach(el => { el.style.fontStyle = shouldItalic ? 'italic' : 'normal'; });
        pushHistory();
        saveToLocalStorage(false);
    };

    window.alignText = function(alignment) {
        activeElements.forEach(el => { el.style.textAlign = alignment; });
        pushHistory();
        saveToLocalStorage(false);
    };

    // ==========================================
    // 表格结构操作方法 (基于当前选中)
    // ==========================================

    window.addRow = function() {
        const currentTable = tableWrapper.querySelector('table');
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
        pushHistory();
        saveToLocalStorage(false);
    };

    window.addColumn = function() {
        const currentTable = tableWrapper.querySelector('table');
        if (!currentTable) return;
        const allRows = currentTable.querySelectorAll('tr');
        
        allRows.forEach(row => {
            const isHeaderRow = row.parentElement.tagName === 'THEAD';
            const newCell = document.createElement(isHeaderRow ? 'th' : 'td');
            newCell.setAttribute('contenteditable', 'true');
            newCell.innerText = isHeaderRow ? '新表头' : '新数据';
            row.appendChild(newCell);
        });
        pushHistory();
        saveToLocalStorage(false);
    };

    window.removeRow = function() {
        const currentTable = tableWrapper.querySelector('table');
        if (!currentTable) return;
        const tbody = currentTable.querySelector('tbody');
        if (!tbody || tbody.children.length === 0) return;

        tbody.removeChild(tbody.lastElementChild);
        pushHistory();
        pruneActiveElements();
        saveToLocalStorage(false);
    };

    window.removeColumn = function() {
        const currentTable = tableWrapper.querySelector('table');
        if (!currentTable) return;
        const allRows = currentTable.querySelectorAll('tr');
        if (allRows.length === 0 || allRows[0].children.length <= 1) return;

        allRows.forEach(row => {
            row.removeChild(row.lastElementChild);
        });
        pushHistory();
        pruneActiveElements();
        saveToLocalStorage(false);
    };

    function getTargetCell() {
        if (activeElements.length > 0) {
            // 优先找第一个有效单元格
            let cell = activeElements[0];
            if (cell.tagName === 'TD' || cell.tagName === 'TH') {
                return cell;
            }
        }
        return null;
    }

    window.insertRow = function(position = 'below') {
        const currentTable = tableWrapper.querySelector('table');
        if (!currentTable) return;
        
        let targetCell = getTargetCell();
        let targetRow = null;
        let parentSection = null;
        
        if (targetCell) {
            targetRow = targetCell.parentElement;
            parentSection = targetRow.parentElement; // thead 还是 tbody
        } else {
            // 没有选中时，默认加在 tbody 最后
            const tbody = currentTable.querySelector('tbody');
            if (tbody && tbody.children.length > 0) {
                targetRow = tbody.lastElementChild;
                parentSection = tbody;
            } else {
                return;
            }
        }

        const columnCount = targetRow.children.length;
        const newRow = document.createElement('tr');
        const isHeader = parentSection.tagName === 'THEAD';

        for (let i = 0; i < columnCount; i++) {
            const newCell = document.createElement(isHeader ? 'th' : 'td');
            newCell.setAttribute('contenteditable', 'true');
            newCell.innerText = isHeader ? '新表头' : '新数据';
            newRow.appendChild(newCell);
        }

        if (position === 'above') {
            parentSection.insertBefore(newRow, targetRow);
        } else {
            parentSection.insertBefore(newRow, targetRow.nextSibling);
        }

        pushHistory();
        saveToLocalStorage(false);
    };

    window.insertColumn = function(position = 'right') {
        const currentTable = tableWrapper.querySelector('table');
        if (!currentTable) return;
        
        let targetIndex = -1;
        let targetCell = getTargetCell();
        
        if (targetCell) {
            targetIndex = targetCell.cellIndex;
        } else {
            // 没选中时默认加在最右侧
            const firstRow = currentTable.querySelector('tr');
            if (firstRow) {
                targetIndex = firstRow.children.length - 1;
            } else {
                return;
            }
        }

        const allRows = currentTable.querySelectorAll('tr');
        
        allRows.forEach(row => {
            const isHeaderRow = row.parentElement.tagName === 'THEAD';
            const newCell = document.createElement(isHeaderRow ? 'th' : 'td');
            newCell.setAttribute('contenteditable', 'true');
            newCell.innerText = isHeaderRow ? '新表头' : '新数据';
            
            if (position === 'left') {
                row.insertBefore(newCell, row.children[targetIndex]);
            } else {
                row.insertBefore(newCell, row.children[targetIndex].nextSibling);
            }
        });

        pushHistory();
        saveToLocalStorage(false);
    };

    window.deleteTargetRow = function() {
        const currentTable = tableWrapper.querySelector('table');
        if (!currentTable) return;
        
        let targetCell = getTargetCell();
        let targetRow = null;

        if (targetCell) {
            targetRow = targetCell.parentElement;
        } else {
            const tbody = currentTable.querySelector('tbody');
            if (tbody && tbody.children.length > 0) {
                targetRow = tbody.lastElementChild;
            }
        }

        if (targetRow) {
            targetRow.parentElement.removeChild(targetRow);
            pushHistory();
            pruneActiveElements();
            saveToLocalStorage(false);
        }
    };

    window.deleteTargetColumn = function() {
        const currentTable = tableWrapper.querySelector('table');
        if (!currentTable) return;
        
        let targetIndex = -1;
        let targetCell = getTargetCell();
        
        if (targetCell) {
            targetIndex = targetCell.cellIndex;
        } else {
            const firstRow = currentTable.querySelector('tr');
            if (firstRow && firstRow.children.length > 0) {
                targetIndex = firstRow.children.length - 1;
            }
        }

        if (targetIndex >= 0) {
            const allRows = currentTable.querySelectorAll('tr');
            allRows.forEach(row => {
                if (row.children[targetIndex]) {
                    row.removeChild(row.children[targetIndex]);
                }
            });
            pushHistory();
            pruneActiveElements();
            saveToLocalStorage(false);
        }
    };

    // ==========================================
    // 导出高清 PNG
    // ==========================================

    window.exportToPNG = function() {
        const exportBtn = document.getElementById('export-btn');
        const originalText = exportBtn.innerHTML;
        exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 导出中...';
        exportBtn.disabled = true;

        activeElements.forEach(el => {
            if (el.isConnected) el.classList.remove('selected-cell');
        });

        // 隐藏 caption
        const caption = tableWrapper.querySelector('caption');
        let originalCaptionDisplay = '';
        if (caption) {
            originalCaptionDisplay = caption.style.display;
            caption.style.display = 'none';
        }

        // 临时强制收起侧边栏以确保导出时表格达到最大宽度
        const wasSidebarOpen = !sidebar.classList.contains('collapsed');
        if (wasSidebarOpen) {
            sidebar.style.transition = 'none'; // 禁用动画以实现瞬间收起
            sidebar.classList.add('collapsed');
            // 触发强制重排 (reflow) 使布局即时生效
            void sidebar.offsetWidth;
        }

        html2canvas(tableWrapper, {
            scale: 3, 
            backgroundColor: '#ffffff',
            useCORS: true,
            logging: false
        }).then(canvas => {
            if (caption) {
                caption.style.display = originalCaptionDisplay;
            }

            // 恢复侧边栏状态
            if (wasSidebarOpen) {
                sidebar.classList.remove('collapsed');
                void sidebar.offsetWidth; // 触发重排
                sidebar.style.transition = ''; // 恢复动画
            }

            const link = document.createElement('a');
            const safeName = tableNameInput.value.replace(/[\/\\:\*\?"<>\|]/g, '');
            link.download = (safeName || '学术三线表') + '_导出.png';
            link.href = canvas.toDataURL('image/png');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            activeElements.forEach(el => {
                if (el.isConnected) el.classList.add('selected-cell');
            });
            exportBtn.innerHTML = originalText;
            exportBtn.disabled = false;
        }).catch(err => {
            if (caption) {
                caption.style.display = originalCaptionDisplay;
            }

            // 恢复侧边栏状态
            if (wasSidebarOpen) {
                sidebar.classList.remove('collapsed');
                void sidebar.offsetWidth;
                sidebar.style.transition = '';
            }

            console.error('导出图片失败', err);
            alert('导出图片失败，请重试。');
            activeElements.forEach(el => {
                if (el.isConnected) el.classList.add('selected-cell');
            });
            exportBtn.innerHTML = originalText;
            exportBtn.disabled = false;
        });
    };

    // 在页面卸载前自动保存
    window.addEventListener('beforeunload', () => {
        saveToLocalStorage(false);
    });

    // 初始化加载
    loadFromLocalStorage();
});
