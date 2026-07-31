// ============================================================
//  学术三线表工具 · 全局状态与工具函数
//  App 命名空间在此定义并最先加载；其余模块往 App 上挂方法。
//  纯静态、无框架、无 ES module —— 普通 <script> 顺序加载即可，file:// 可用。
// ============================================================

window.App = {
    // ---- 运行时状态 ----
    activeElements: [],      // 当前选中的单元格
    tableDataList: [],       // 所有表格数据
    currentTableId: null,    // 当前激活表格 id

    // ---- 撤销 / 重做 ----
    historyStack: [],
    historyIndex: -1,
    historyPaused: false,
    inputTimer: null,

    // ---- 区域选择（Excel 式）----
    anchorCell: null,        // 区域选择的锚点
    isDragging: false,       // 是否正在拖拽框选

    // ---- 常量 ----
    LOCAL_STORAGE_KEY: 'academic_tables_data',
    MAX_HISTORY: 50,

    // ---- DOM 引用（main.js 在 DOMContentLoaded 时填充）----
    dom: {},
};

/** HTML 转义，防止表名等用户输入破坏结构 / 注入 */
App.escapeHtml = function (str) {
    return String(str).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
};

/** 清除所有选中状态并重置 activeElements */
App.clearSelection = function () {
    App.activeElements.forEach((el) => {
        if (el.isConnected) el.classList.remove('selected-cell');
    });
    App.activeElements = [];
    App.anchorCell = null;
    App.updateToolbarState();
};

/** 从 activeElements 中移除已脱离 DOM 的僵尸引用 */
App.pruneActiveElements = function () {
    App.activeElements = App.activeElements.filter((el) => el.isConnected);
    App.updateToolbarState();
};

/** 根据当前选中单元格刷新样式工具栏显示 */
App.updateToolbarState = function () {
    const dom = App.dom;
    if (App.activeElements.length > 0) {
        dom.styleToolbar.classList.add('active');
        const firstElement = App.activeElements[0];
        const currentStyle = window.getComputedStyle(firstElement);

        // 字号
        dom.fontSizeInput.value = Math.round(parseFloat(currentStyle.fontSize));

        // 边距（修复：0 也要如实显示，不能被 || 当成假值）
        const padTop = Math.round(parseFloat(currentStyle.paddingTop));
        dom.paddingInput.value = Number.isNaN(padTop) ? 14 : padTop;

        // 行高
        const rawLineHeight = currentStyle.lineHeight;
        if (rawLineHeight === 'normal') {
            dom.lineHeightInput.value = 1.5;
        } else {
            const lhPx = parseFloat(rawLineHeight);
            const fsPx = parseFloat(currentStyle.fontSize);
            if (lhPx && fsPx) {
                dom.lineHeightInput.value = parseFloat((lhPx / fsPx).toFixed(1));
            } else {
                dom.lineHeightInput.value = 1.5;
            }
        }

        // 字体
        const currentFontFamily = currentStyle.fontFamily.toLowerCase();
        if (currentFontFamily.includes('calibri')) {
            dom.fontFamilyInput.value = 'Calibri, sans-serif';
        } else if (currentFontFamily.includes('arial')) {
            dom.fontFamilyInput.value = 'Arial, sans-serif';
        } else {
            dom.fontFamilyInput.value = "'Times New Roman', Times, serif";
        }
    } else {
        dom.styleToolbar.classList.remove('active');
    }
};

/** 取当前操作目标单元格（选中的第一个 td/th） */
App.getTargetCell = function () {
    if (App.activeElements.length > 0) {
        const cell = App.activeElements[0];
        if (cell.tagName === 'TD' || cell.tagName === 'TH') return cell;
    }
    return null;
};

/** 顶部轻提示（复用 toast 元素，1.8s 自动消失）*/
App.notify = function (msg) {
    const t = App.dom.toast;
    if (!t) return;
    t.innerHTML = '<i class="fas fa-info-circle"></i> ' + App.escapeHtml(msg);
    t.classList.add('show');
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
};

/** 样式类输入连续调整时，防抖提交历史与存储（避免每次按键都记一次快照）*/
App.commitStyleSoon = function () {
    clearTimeout(App._styleCommitTimer);
    App._styleCommitTimer = setTimeout(() => {
        App.pushHistory();
        App.saveToLocalStorage(false);
    }, 500);
};
