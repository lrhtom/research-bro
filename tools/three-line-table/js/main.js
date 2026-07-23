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
    };

    // 交互装配
    App.initSelection();
    App.initKeyboard();
    App.initClipboard();
    App.initContextMenu();

    // 文字编辑防抖记录快照
    App.dom.tableWrapper.addEventListener('input', () => {
        clearTimeout(App.inputTimer);
        App.inputTimer = setTimeout(() => App.pushHistory(), 600);
    });

    // 卸载前自动保存
    window.addEventListener('beforeunload', () => App.saveToLocalStorage(false));

    // 初始化加载
    App.loadFromLocalStorage();
});
