// ============================================================
//  导出：高清 PNG（html2canvas）+ Markdown
// ============================================================

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

    const restore = () => {
        if (captionHidden) caption.style.display = originalCaptionDisplay;
        if (wasSidebarOpen) {
            sidebar.classList.remove('collapsed');
            void sidebar.offsetWidth;
            sidebar.style.transition = '';
        }
    };

    html2canvas(tableWrapper, {
        scale: 3,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
    }).then((canvas) => {
        restore();

        const link = document.createElement('a');
        const safeName = tableNameInput.value.replace(/[\/\\:\*\?"<>\|]/g, '');
        link.download = (safeName || '学术三线表') + '_导出.png';
        link.href = canvas.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        App.activeElements.forEach((el) => {
            if (el.isConnected) el.classList.add('selected-cell');
        });
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
    }).catch((err) => {
        restore();
        console.error('导出图片失败', err);
        alert('导出图片失败，请重试。');
        App.activeElements.forEach((el) => {
            if (el.isConnected) el.classList.add('selected-cell');
        });
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
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
        mdContent += `**${caption.innerText.trim()}**\n\n`;
    }

    let columnCount = 0;

    if (thead) {
        const headerRow = thead.querySelector('tr');
        if (headerRow) {
            const cells = Array.from(headerRow.children);
            columnCount = cells.length;
            const headerText = cells.map((cell) => cell.innerText.trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ');
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
            const rowText = cells.map((cell) => cell.innerText.trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ');
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
