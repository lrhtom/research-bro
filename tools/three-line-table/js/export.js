// ============================================================
//  导出：高清 PNG（html2canvas）+ Markdown
// ============================================================

// ---------- 分辨率（倍率）----------

// 浏览器画布硬上限：Chrome / Safari 桌面版约为单边 16384、总面积 16384²。
// 超过就会得到一张全空白的图，所以导出前必须按表格实际尺寸夹一次。
App.CANVAS_MAX_SIDE = 16384;
App.CANVAS_MAX_AREA = 16384 * 16384;
App.EXPORT_SCALE_KEY = 'academic_tables_export_scale';
App.DEFAULT_EXPORT_SCALE = 6;

/** 给定 CSS 尺寸，在不超出画布上限的前提下最多能放大多少倍 */
App.maxSafeScale = function (width, height) {
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    const bySide = Math.min(App.CANVAS_MAX_SIDE / w, App.CANVAS_MAX_SIDE / h);
    const byArea = Math.sqrt(App.CANVAS_MAX_AREA / (w * h));
    // 向下取到两位小数，避免浮点误差顶到上限
    return Math.max(1, Math.floor(Math.min(bySide, byArea) * 100) / 100);
};

/**
 * 导出前会先收起侧边栏，表格因此变宽（换行变少还可能变矮）。
 * 这里瞬时收一下量出真实导出尺寸再还原 —— 同一个任务内完成，不会闪。
 * 按当前可见尺寸做缓存：宽度没变就不重测，避免每次操作都强制重排。
 */
App.measureExportSize = function () {
    const { tableWrapper, sidebar } = App.dom;
    if (!tableWrapper) return { w: 1, h: 1 };

    const live = { w: tableWrapper.offsetWidth, h: tableWrapper.offsetHeight };
    if (!sidebar || sidebar.classList.contains('collapsed')) return live;

    const c = App._exportSizeCache;
    if (c && c.liveW === live.w && c.liveH === live.h) return { w: c.w, h: c.h };

    const prevTransition = sidebar.style.transition;
    sidebar.style.transition = 'none';
    sidebar.classList.add('collapsed');
    const w = tableWrapper.offsetWidth;
    const h = tableWrapper.offsetHeight;
    sidebar.classList.remove('collapsed');
    void sidebar.offsetWidth;
    sidebar.style.transition = prevTransition;

    App._exportSizeCache = { liveW: live.w, liveH: live.h, w, h };
    return { w, h };
};

/** 用户选的倍率（读不到就用默认值）*/
App.getExportScale = function () {
    const v = App.dom.exportScaleInput ? Number(App.dom.exportScaleInput.value) : App.DEFAULT_EXPORT_SCALE;
    return (v && v > 0) ? v : App.DEFAULT_EXPORT_SCALE;
};

/** 刷新“输出 W × H px”提示；同时返回夹过上限后的实际倍率 */
App.updateExportSizeHint = function () {
    const { exportSizeHint, tableWrapper } = App.dom;
    if (!tableWrapper) return App.DEFAULT_EXPORT_SCALE;

    const size = App.measureExportSize();
    const requested = App.getExportScale();
    const scale = Math.min(requested, App.maxSafeScale(size.w, size.h));

    if (exportSizeHint) {
        const w = Math.round(size.w * scale);
        const h = Math.round(size.h * scale);
        const mp = (w * h / 1e6).toFixed(1);
        exportSizeHint.textContent = `${w} × ${h} px · ${mp} MP`;
        exportSizeHint.title = scale < requested
            ? `${requested}× 会超出浏览器画布上限（单边 ${App.CANVAS_MAX_SIDE} px），已自动降到 ${scale}×`
            : `导出尺寸（导出时会自动收起侧边栏，表格按最大宽度渲染）`;
    }
    return scale;
};

/** 记住用户选的倍率 */
App.saveExportScale = function () {
    try { localStorage.setItem(App.EXPORT_SCALE_KEY, String(App.getExportScale())); } catch (e) { /* 隐私模式忽略 */ }
    App.updateExportSizeHint();
};

App.restoreExportScale = function () {
    const sel = App.dom.exportScaleInput;
    if (!sel) return;
    let saved = null;
    try { saved = localStorage.getItem(App.EXPORT_SCALE_KEY); } catch (e) { /* 忽略 */ }
    if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
};

// ---------- PNG ----------

App.exportToPNG = function () {
    const { tableWrapper, tableNameInput, sidebar } = App.dom;
    const exportBtn = document.getElementById('export-btn');
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 导出中...';
    exportBtn.disabled = true;

    App.activeElements.forEach((el) => {
        if (el.isConnected) el.classList.remove('selected-cell');
    });

    // 修复(B1)：表题默认包含；仅当“导出含表题”开关关闭时才隐藏
    const includeCaption = App.dom.exportCaptionToggle ? App.dom.exportCaptionToggle.checked : true;
    const caption = tableWrapper.querySelector('caption');
    let originalCaptionDisplay = '';
    let captionHidden = false;
    if (caption && !includeCaption) {
        originalCaptionDisplay = caption.style.display;
        caption.style.display = 'none';
        captionHidden = true;
    }

    // 临时收起侧边栏，保证导出时表格达到最大宽度
    const wasSidebarOpen = !sidebar.classList.contains('collapsed');
    if (wasSidebarOpen) {
        sidebar.style.transition = 'none';
        sidebar.classList.add('collapsed');
        void sidebar.offsetWidth; // 强制重排
    }

    let restored = false;
    const restore = () => {
        if (restored) return;          // 重试链路上可能被调两次，做成幂等
        restored = true;
        if (captionHidden) caption.style.display = originalCaptionDisplay;
        if (wasSidebarOpen) {
            sidebar.classList.remove('collapsed');
            void sidebar.offsetWidth;
            sidebar.style.transition = '';
        }
    };

    const done = () => {
        App.activeElements.forEach((el) => {
            if (el.isConnected) el.classList.add('selected-cell');
        });
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
        App.updateExportSizeHint();
    };

    // 侧边栏已收起并重排，这里量到的就是最终渲染尺寸
    const requested = App.getExportScale();
    const maxScale = App.maxSafeScale(tableWrapper.offsetWidth, tableWrapper.offsetHeight);
    const scale = Math.min(requested, maxScale);
    if (scale < requested) {
        App.notify(`${requested}× 会超出浏览器画布上限，已自动降到 ${scale}×`);
    }

    const render = (s) => html2canvas(tableWrapper, {
        scale: s,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        imageTimeout: 0,
    }).then((canvas) => {
        // 超限时 html2canvas 不报错，只会给一张空画布 —— 得自己判出来
        if (!canvas || !canvas.width || !canvas.height) throw new Error('画布为空（可能超出浏览器上限）');
        return canvas;
    });

    const save = (canvas, usedScale) => {
        const link = document.createElement('a');
        const safeName = tableNameInput.value.replace(/[\/\\:\*\?"<>\|]/g, '');
        link.download = `${safeName || '学术三线表'}_导出@${usedScale}x.png`;
        link.href = canvas.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        App.notify(`已导出 ${canvas.width} × ${canvas.height} px（${usedScale}×）`);
    };

    render(scale)
        .then((canvas) => { restore(); save(canvas, scale); done(); })
        .catch(() => {
            // 高倍率失败多半是显存/画布上限，自动降一半再试一次
            const fallback = Math.max(2, Math.floor(scale / 2));
            if (fallback >= scale) throw new Error('render failed');
            App.notify(`${scale}× 渲染失败，正在用 ${fallback}× 重试`);
            return render(fallback).then((canvas) => { restore(); save(canvas, fallback); done(); });
        })
        .catch((err) => {
            restore();
            console.error('导出图片失败', err);
            alert('导出图片失败。表格很大时请把“分辨率”调低一档再试。');
            done();
        });
};

App.exportToMarkdown = function () {
    const { tableWrapper, tableNameInput } = App.dom;
    const currentTable = tableWrapper.querySelector('table');
    if (!currentTable) return;

    const exportBtn = document.getElementById('export-md-btn');
    const originalText = exportBtn.innerHTML;
    exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 导出中...';
    exportBtn.disabled = true;

    const caption = currentTable.querySelector('caption');
    const thead = currentTable.querySelector('thead');
    const tbody = currentTable.querySelector('tbody');

    let mdContent = '';

    if (caption && caption.innerText.trim() !== '') {
        // 表题里的换行必须转成 <br>，否则会把 Markdown 的 **...** 截成两行
        mdContent += `**${caption.innerText.trim().replace(/\n/g, '<br>')}**\n\n`;
    }

    let columnCount = 0;

    if (thead) {
        const headerRow = thead.querySelector('tr');
        if (headerRow) {
            const cells = Array.from(headerRow.children);
            columnCount = cells.length;
            const headerText = cells.map((cell) => cell.innerText.trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ');
            mdContent += `| ${headerText} |\n`;
            const separatorText = cells.map(() => '---').join(' | ');
            mdContent += `| ${separatorText} |\n`;
        }
    }

    if (tbody) {
        const rows = tbody.querySelectorAll('tr');
        rows.forEach((row) => {
            const cells = Array.from(row.children);
            if (columnCount === 0) columnCount = cells.length;
            const rowText = cells.map((cell) => cell.innerText.trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ');
            mdContent += `| ${rowText} |\n`;
        });
    }

    try {
        const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const safeName = tableNameInput.value.replace(/[\/\\:\*\?"<>\|]/g, '');
        link.download = (safeName || '学术三线表') + '.md';
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('导出 Markdown 失败', err);
        alert('导出 Markdown 失败，请重试。');
    } finally {
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
    }
};
