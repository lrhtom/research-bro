// ============================================================
//  数据备份与迁移
//  · 看清 localStorage 里到底存了什么（表名 / 结构 / 占用）
//  · 导出全部表格为 JSON 备份文件
//  · 从备份文件恢复（合并追加 / 覆盖全部）
//
//  为什么需要：表格存在浏览器的 localStorage 里，它是按「源」隔离的 ——
//  换浏览器、换电脑、甚至从 file:// 换成 http:// 打开，数据都带不过去；
//  清理浏览数据也会把它抹掉。导出成文件才是真正的备份。
// ============================================================

App.BACKUP_FORMAT = 'academic-three-line-table-backup';
App.BACKUP_VERSION = 1;
App.STORAGE_QUOTA = 5 * 1024 * 1024;   // 多数浏览器给每个源约 5MB

// ---------- 统计 ----------

/** 把一段表格 HTML 解析出行列数（用 DOMParser，不会执行脚本、不会加载资源）*/
App.tableShape = function (html) {
    try {
        const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
        const table = doc.querySelector('table');
        if (!table) return { rows: 0, cols: 0, caption: '' };
        const headRow = table.querySelector('thead tr');
        const cols = headRow ? headRow.children.length : 0;
        const rows = table.querySelectorAll('tbody tr').length;
        const cap = table.querySelector('caption');
        return { rows, cols, caption: cap ? cap.textContent.trim() : '' };
    } catch (e) {
        return { rows: 0, cols: 0, caption: '' };
    }
};

App.storageStats = function () {
    const raw = localStorage.getItem(App.LOCAL_STORAGE_KEY) || '';
    // localStorage 按 UTF-16 计，一个字符约 2 字节
    const bytes = raw.length * 2;
    const tables = App.tableDataList.map((t) => {
        const shape = App.tableShape(t.html || '');
        return {
            id: t.id,
            name: t.name || '(未命名)',
            bytes: ((t.html || '').length + (t.name || '').length) * 2,
            rows: shape.rows,
            cols: shape.cols,
            current: t.id === App.currentTableId,
        };
    });
    return { count: tables.length, bytes, tables };
};

App.fmtSize = function (b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
};

// ---------- 导出 ----------

App.exportAllTables = function () {
    // 先把当前编辑中的内容落盘，免得导出的是旧快照
    App.saveToLocalStorage(false);

    const payload = {
        format: App.BACKUP_FORMAT,
        version: App.BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        count: App.tableDataList.length,
        tables: App.tableDataList.map((t) => ({ id: t.id, name: t.name, html: t.html })),
    };

    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const d = new Date();
        const stamp = d.getFullYear()
            + String(d.getMonth() + 1).padStart(2, '0')
            + String(d.getDate()).padStart(2, '0')
            + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
        const link = document.createElement('a');
        link.download = `三线表备份_${stamp}_${payload.count}张.json`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        App.notify(`已导出 ${payload.count} 张表`);
    } catch (err) {
        console.error('导出备份失败', err);
        alert('导出备份失败，请重试。');
    }
};

// ---------- 清洗 ----------

/**
 * 备份文件可能来自别人，里面的 HTML 会被塞进页面，必须先洗一遍。
 * DOMParser 解析出来的是游离文档：不执行脚本、不加载资源，洗完再用才安全。
 */
App.sanitizeTableHtml = function (html) {
    const doc = new DOMParser().parseFromString('<div id="r">' + String(html || '') + '</div>', 'text/html');
    const root = doc.getElementById('r');
    if (!root) return '';

    root.querySelectorAll('script, iframe, object, embed, link, meta, base, form, svg, audio, video')
        .forEach((n) => n.remove());

    root.querySelectorAll('*').forEach((el) => {
        Array.prototype.slice.call(el.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            const val = String(attr.value || '');
            // on* 事件处理器；以及 javascript: 协议
            if (name.indexOf('on') === 0) el.removeAttribute(attr.name);
            else if (/^(src|href|xlink:href|action|formaction)$/.test(name) && /^\s*javascript:/i.test(val)) {
                el.removeAttribute(attr.name);
            }
        });
    });

    return root.innerHTML;
};

// ---------- 解析备份文件 ----------

/** 返回 { ok, tables, error, warnings } */
App.parseBackup = function (text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        return { ok: false, error: '不是合法的 JSON 文件。' };
    }
    if (!data || typeof data !== 'object') return { ok: false, error: '文件内容不是一个对象。' };
    if (data.format !== App.BACKUP_FORMAT) {
        return { ok: false, error: '这不像是本工具导出的备份文件（format 字段对不上）。' };
    }
    if (!Array.isArray(data.tables)) return { ok: false, error: '缺少 tables 数组。' };

    const warnings = [];
    const tables = [];
    data.tables.forEach((t, i) => {
        if (!t || typeof t !== 'object') { warnings.push(`第 ${i + 1} 条不是对象，已跳过`); return; }
        const html = App.sanitizeTableHtml(t.html);
        if (!/<table[\s>]/i.test(html)) { warnings.push(`第 ${i + 1} 条里没有表格，已跳过`); return; }
        const shape = App.tableShape(html);
        tables.push({
            name: String(t.name || '未命名表格').slice(0, 120),
            html,
            rows: shape.rows,
            cols: shape.cols,
        });
    });

    if (tables.length === 0) return { ok: false, error: '文件里没有可用的表格。', warnings };
    return { ok: true, tables, warnings, exportedAt: data.exportedAt || '' };
};

// ---------- 应用备份 ----------

/** mode: 'merge' 追加到现有表之后 / 'replace' 覆盖全部 */
App.applyBackup = function (tables, mode) {
    const stamp = Date.now();
    const fresh = tables.map((t, i) => ({
        // 重新发 id，避免和现有表撞车
        id: 'table_' + stamp + '_' + i + '_' + Math.random().toString(36).slice(2, 7),
        name: t.name,
        html: t.html,
    }));

    if (mode === 'replace') {
        App.tableDataList = fresh;
    } else {
        App.tableDataList = App.tableDataList.concat(fresh);
    }

    App.currentTableId = null;      // 防止 switchTable 往已经不存在的表里回写
    localStorage.setItem(App.LOCAL_STORAGE_KEY, JSON.stringify(App.tableDataList));
    App.switchTable(fresh[0].id);
    return fresh.length;
};

// ---------- 弹窗 ----------

App.openBackup = function () {
    const mask = App.dom.backupMask;
    if (!mask) return;
    mask.classList.add('show');
    App.renderBackupBody();
};

App.closeBackup = function () {
    if (App.dom.backupMask) App.dom.backupMask.classList.remove('show');
};

App.isBackupOpen = function () {
    return !!(App.dom.backupMask && App.dom.backupMask.classList.contains('show'));
};

App.getBackupMode = function () {
    const c = document.querySelector('input[name="backup-mode"]:checked');
    return c ? c.value : 'merge';
};

/** 渲染「当前存了什么」那一块 */
App.renderBackupBody = function () {
    const box = App.dom.backupList;
    if (!box) return;
    App.saveToLocalStorage(false);
    const s = App.storageStats();

    const pct = Math.min((s.bytes / App.STORAGE_QUOTA) * 100, 100);
    let html = `<div class="bk-summary">
        当前这个浏览器里存了 <b>${s.count}</b> 张表，占用 <b>${App.fmtSize(s.bytes)}</b>
        <span class="bk-quota">/ 约 ${App.fmtSize(App.STORAGE_QUOTA)} 上限</span>
        <div class="bk-bar"><div class="bk-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
    </div>`;

    html += '<table class="bk-table"><tr><th>表名</th><th>结构</th><th>大小</th></tr>';
    s.tables.forEach((t) => {
        html += `<tr${t.current ? ' class="cur"' : ''}>
            <td>${App.escapeHtml(t.name)}${t.current ? ' <span class="bk-cur">当前</span>' : ''}</td>
            <td>${t.cols} 列 × ${t.rows} 行</td>
            <td>${App.fmtSize(t.bytes)}</td></tr>`;
    });
    html += '</table>';

    box.innerHTML = html;
};

/** 选好文件后的预览 */
App.renderBackupPreview = function (result) {
    const box = App.dom.backupPreview;
    if (!box) return;
    if (!result) {
        box.innerHTML = '<p class="bk-hint">选择一个备份文件后，这里会显示它里面有什么。</p>';
        App.dom.backupConfirm.disabled = true;
        return;
    }
    if (!result.ok) {
        box.innerHTML = `<p class="bk-bad"><i class="fas fa-circle-xmark"></i> ${App.escapeHtml(result.error)}</p>`;
        App.dom.backupConfirm.disabled = true;
        return;
    }
    let html = `<p class="bk-ok"><i class="fas fa-circle-check"></i> 识别到 <b>${result.tables.length}</b> 张表`;
    if (result.exportedAt) {
        html += `　<span class="bk-quota">备份于 ${App.escapeHtml(result.exportedAt.slice(0, 16).replace('T', ' '))}</span>`;
    }
    html += '</p><table class="bk-table"><tr><th>表名</th><th>结构</th></tr>';
    result.tables.slice(0, 12).forEach((t) => {
        html += `<tr><td>${App.escapeHtml(t.name)}</td><td>${t.cols} 列 × ${t.rows} 行</td></tr>`;
    });
    html += '</table>';
    if (result.tables.length > 12) html += `<p class="bk-hint">…另有 ${result.tables.length - 12} 张未列出</p>`;
    if (result.warnings && result.warnings.length) {
        html += `<p class="bk-warn"><i class="fas fa-triangle-exclamation"></i> ${
            result.warnings.map(App.escapeHtml).join('；')}</p>`;
    }
    box.innerHTML = html;
    App.dom.backupConfirm.disabled = false;
};

App.confirmBackupRestore = function () {
    const r = App._pendingBackup;
    if (!r || !r.ok) return;
    const mode = App.getBackupMode();

    if (mode === 'replace') {
        const ok = confirm(
            `确定要用备份里的 ${r.tables.length} 张表\n覆盖当前的 ${App.tableDataList.length} 张表吗？\n\n`
            + '当前数据会被全部删除，且无法撤销。\n建议先点上面的「导出全部」备份一份。');
        if (!ok) return;
    }

    const n = App.applyBackup(r.tables, mode);
    App.closeBackup();
    App.notify(mode === 'replace' ? `已覆盖恢复 ${n} 张表` : `已追加 ${n} 张表`);
};

App.initBackup = function () {
    const { backupMask, backupFile } = App.dom;
    if (!backupMask) return;

    if (backupFile) {
        backupFile.addEventListener('change', () => {
            const file = backupFile.files && backupFile.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                App._pendingBackup = App.parseBackup(String(reader.result || ''));
                App.renderBackupPreview(App._pendingBackup);
            };
            reader.onerror = () => App.notify('读取文件失败');
            reader.readAsText(file, 'UTF-8');
            backupFile.value = '';   // 允许再次选择同一个文件
        });
    }

    backupMask.addEventListener('mousedown', (event) => {
        if (event.target === backupMask) App.closeBackup();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && App.isBackupOpen()) {
            event.stopPropagation();
            App.closeBackup();
        }
    }, true);
};
