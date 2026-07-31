// ============================================================
//  入口：填充 DOM 引用、装配全局事件、初始化加载
//  （本文件最后加载）
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    // 集中式 DOM 引用
    App.dom = {
        tableWrapper: document.getElementById('table-export-area'),
        styleToolbar: document.getElementById('style-toolbar'),
        fontSizeInput: document.getElementById('font-size-input'),
        paddingInput: document.getElementById('padding-input'),
        lineHeightInput: document.getElementById('line-height-input'),
        fontFamilyInput: document.getElementById('font-family-input'),
        sidebar: document.getElementById('sidebar'),
        tableListContainer: document.getElementById('table-list'),
        tableNameInput: document.getElementById('current-table-name'),
        toast: document.getElementById('toast'),
        exportCaptionToggle: document.getElementById('export-caption'),
        exportScaleInput: document.getElementById('export-scale-input'),
        exportSizeHint: document.getElementById('export-size-hint'),
        // 导入 Markdown 弹窗
        mdMask: document.getElementById('md-import-mask'),
        mdText: document.getElementById('md-import-text'),
        mdFile: document.getElementById('md-import-file'),
        mdPreview: document.getElementById('md-import-preview'),
        mdConfirm: document.getElementById('md-import-confirm'),
    };

    // 交互装配
    App.initSelection();
    App.initKeyboard();
    App.initClipboard();
    App.initContextMenu();
    App.initMdImport();

    // 文字编辑防抖记录快照
    App.dom.tableWrapper.addEventListener('input', () => {
        clearTimeout(App.inputTimer);
        App.inputTimer = setTimeout(() => App.pushHistory(), 600);
    });

    // 卸载前自动保存
    window.addEventListener('beforeunload', () => App.saveToLocalStorage(false));

    // 初始化加载
    App.restoreExportScale();
    App.loadFromLocalStorage();

    // 导出尺寸提示：主路径由 pushHistory / saveToLocalStorage 驱动（见 tables.js）；
    // 这里再补上窗口缩放这类不产生历史记录的宽度变化。
    App.updateExportSizeHint();
    window.addEventListener('resize', () => App.updateExportSizeHint());
    if (typeof ResizeObserver === 'function') {
        // 存成属性，避免实例被 GC 掉导致回调静默失效
        App._exportSizeObserver = new ResizeObserver(() => App.updateExportSizeHint());
        App._exportSizeObserver.observe(App.dom.tableWrapper);
    }
});
