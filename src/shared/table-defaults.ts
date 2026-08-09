// ============================================================
//  新建表格用的默认骨架 —— 服务端与客户端共用，所以不能碰 DOM
// ============================================================

export function escapeHtml(str: unknown): string {
    return String(str ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
}

/** 一张三列两行的空三线表，caption 用表名填充 */
export function defaultTableHtml(name = '新图表'): string {
    return `<table class="academic-table" id="main-table">
    <caption contenteditable="true">${escapeHtml(name)}</caption>
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
</table>`;
}

export const BACKUP_FORMAT = 'academic-three-line-table-backup';
export const BACKUP_VERSION = 1;

export interface BackupPayload {
    format: string;
    version: number;
    exportedAt: string;
    count: number;
    tables: Array<{ id: string; name: string; html: string }>;
}
