// ============================================================
//  剪贴板：从 Excel/WPS 粘贴 TSV 自动分列填充 / 复制选中区域为 TSV
//  用 copy/paste 事件 + event.clipboardData —— 不依赖安全上下文，file:// 可用。
// ============================================================

App.initClipboard = function () {
    const { tableWrapper } = App.dom;
    tableWrapper.addEventListener('paste', App.handlePaste);
    document.addEventListener('copy', App.handleCopy);
};

/** 把二维数组从 anchor 起铺进表格，行/列不够自动补齐（补的行进表体）*/
App.fillFromGrid = function (anchor, grid) {
    const table = App.dom.tableWrapper.querySelector('table');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    let allRows = Array.from(table.querySelectorAll('tr'));
    const startR = allRows.indexOf(anchor.parentElement);
    const startC = anchor.cellIndex;
    if (startR < 0) return;

    const maxCols = Math.max(...grid.map((g) => g.length));
    const needCols = startC + maxCols;

    // 补列（空内容，表头补 th、表体补 td）
    allRows.forEach((row) => {
        const isHead = row.parentElement.tagName === 'THEAD';
        while (row.children.length < needCols) {
            const cell = document.createElement(isHead ? 'th' : 'td');
            cell.setAttribute('contenteditable', 'true');
            row.appendChild(cell);
        }
    });

    // 补行（加到表体，空内容，列数对齐）
    const totalCols = allRows[0].children.length;
    const needRows = startR + grid.length;
    while (table.querySelectorAll('tr').length < needRows && tbody) {
        const tr = document.createElement('tr');
        for (let k = 0; k < totalCols; k++) {
            const td = document.createElement('td');
            td.setAttribute('contenteditable', 'true');
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    // 写入
    allRows = Array.from(table.querySelectorAll('tr'));
    for (let i = 0; i < grid.length; i++) {
        const row = allRows[startR + i];
        if (!row) break;
        for (let j = 0; j < grid[i].length; j++) {
            const cell = row.children[startC + j];
            if (cell) cell.innerText = grid[i][j];
        }
    }
};

App.handlePaste = function (event) {
    const cd = event.clipboardData || window.clipboardData;
    if (!cd) return;
    const text = cd.getData('text/plain');
    if (text === '' || text == null) return;

    const anchor = App.getCurrentCell();

    // 解析为二维数组（制表符分列、换行分行）
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // 去掉尾部空行
    const grid = lines.map((line) => line.split('\t'));
    const isMulti = grid.length > 1 || (grid[0] && grid[0].length > 1);

    // 单格纯文本：去格式化插入，避免带进 Excel 的样式
    if (!isMulti || !anchor) {
        event.preventDefault();
        document.execCommand('insertText', false, normalized);
        return;
    }

    // 多格：铺进表格
    event.preventDefault();
    App.fillFromGrid(anchor, grid);
    App.pushHistory();
    App.saveToLocalStorage(false);
    App.notify(`已粘贴 ${grid.length} 行 × ${Math.max(...grid.map((g) => g.length))} 列`);
};

App.handleCopy = function (event) {
    // 焦点在输入框/文本域里（如导入弹窗）时不劫持，走原生复制
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;

    // 单格或未选区域时走浏览器默认复制（复制格内文字）
    if (App.activeElements.length < 2) return;

    const cells = App.activeElements.filter((el) => el.tagName !== 'CAPTION');
    if (cells.length < 2) return;

    const allRows = App.getAllRows();
    const coords = cells.map((el) => ({ r: allRows.indexOf(el.parentElement), c: el.cellIndex }));
    const r1 = Math.min(...coords.map((o) => o.r)), r2 = Math.max(...coords.map((o) => o.r));
    const c1 = Math.min(...coords.map((o) => o.c)), c2 = Math.max(...coords.map((o) => o.c));

    const lines = [];
    for (let r = r1; r <= r2; r++) {
        const rowCells = allRows[r].children;
        const vals = [];
        for (let c = c1; c <= c2; c++) {
            const cell = rowCells[c];
            vals.push(cell ? cell.innerText.replace(/\t/g, ' ').replace(/\n/g, ' ') : '');
        }
        lines.push(vals.join('\t'));
    }

    event.clipboardData.setData('text/plain', lines.join('\n'));
    event.preventDefault();
    App.notify(`已复制 ${r2 - r1 + 1} 行 × ${c2 - c1 + 1} 列`);
};
