// ============================================================
//  学术三线表的数据访问层
//
//  整表存 HTML + 派生的 caption / row_count / col_count 三列。
//  写入前一律过一遍 sanitize，不管内容是从编辑器来的还是从备份文件恢复的。
// ============================================================

import { db, nowIso } from './db.js';
import { sanitizeTableHtml, tableShape } from './table-html.js';
import type { TableFull, TableSummary } from '../shared/types.js';

interface TableRecord {
    id: string;
    name: string;
    html: string;
    caption: string;
    row_count: number;
    col_count: number;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

export function newTableId(): string {
    return 'table_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function toFull(r: TableRecord): TableFull {
    return {
        id: r.id,
        name: r.name,
        html: r.html,
        caption: r.caption,
        rows: r.row_count,
        cols: r.col_count,
        updatedAt: r.updated_at,
    };
}

/** 新表排到最前：拿当前最小 sort_order 再减一 */
function nextTopOrder(): number {
    const row = db().prepare('SELECT MIN(sort_order) AS m FROM tables').get() as { m: number | null };
    return (row.m ?? 0) - 1;
}

export function listTables(): TableSummary[] {
    const rows = db().prepare(
        `SELECT id, name, caption, row_count, col_count, updated_at,
                LENGTH(CAST(html AS BLOB)) + LENGTH(CAST(name AS BLOB)) AS bytes
         FROM tables
         ORDER BY sort_order ASC, created_at DESC`,
    ).all() as Array<TableRecord & { bytes: number }>;

    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        caption: r.caption,
        rows: r.row_count,
        cols: r.col_count,
        bytes: r.bytes,
        updatedAt: r.updated_at,
    }));
}

export function getTable(id: string): TableFull | null {
    const row = db().prepare('SELECT * FROM tables WHERE id = ?').get(id) as TableRecord | undefined;
    return row ? toFull(row) : null;
}

/** 所有表的完整内容，按显示顺序 —— 导出备份用 */
export function allTables(): TableFull[] {
    const rows = db().prepare(
        'SELECT * FROM tables ORDER BY sort_order ASC, created_at DESC',
    ).all() as TableRecord[];
    return rows.map(toFull);
}

export function countTables(): number {
    return (db().prepare('SELECT COUNT(*) AS n FROM tables').get() as { n: number }).n;
}

export function createTable(input: {
    name?: string; html: string; id?: string; sortOrder?: number;
}): TableFull {
    const html = sanitizeTableHtml(input.html);
    const shape = tableShape(html);
    const ts = nowIso();
    const rec: TableRecord = {
        id: input.id ?? newTableId(),
        name: (input.name ?? '未命名表格').slice(0, 200),
        html,
        caption: shape.caption,
        row_count: shape.rows,
        col_count: shape.cols,
        sort_order: input.sortOrder ?? nextTopOrder(),
        created_at: ts,
        updated_at: ts,
    };

    db().prepare(
        `INSERT INTO tables (id, name, html, caption, row_count, col_count, sort_order, created_at, updated_at)
         VALUES (@id, @name, @html, @caption, @row_count, @col_count, @sort_order, @created_at, @updated_at)`,
    ).run(rec);

    return toFull(rec);
}

/** 保存编辑结果。name 与 html 都是可选的，只传哪个就只改哪个 */
export function updateTable(id: string, patch: { name?: string; html?: string }): TableFull | null {
    const existing = db().prepare('SELECT * FROM tables WHERE id = ?').get(id) as TableRecord | undefined;
    if (!existing) return null;

    const html = patch.html === undefined ? existing.html : sanitizeTableHtml(patch.html);
    const shape = tableShape(html);
    const name = patch.name === undefined ? existing.name : patch.name.slice(0, 200);

    db().prepare(
        `UPDATE tables SET name = ?, html = ?, caption = ?, row_count = ?, col_count = ?, updated_at = ?
         WHERE id = ?`,
    ).run(name, html, shape.caption, shape.rows, shape.cols, nowIso(), id);

    return getTable(id);
}

/** 删表。最后一张不给删 —— 编辑器至少要有一张表可编辑 */
export function deleteTable(id: string): { ok: boolean; reason?: string } {
    if (countTables() <= 1) return { ok: false, reason: '至少需要保留一个表格' };
    const info = db().prepare('DELETE FROM tables WHERE id = ?').run(id);
    return info.changes > 0 ? { ok: true } : { ok: false, reason: '表格不存在' };
}

/**
 * 恢复备份。
 * mode = 'merge'   追加到现有表后面
 * mode = 'replace' 清空后写入
 * 一律重新发 id，避免和现有表撞车。
 */
export function restoreTables(
    tables: Array<{ name: string; html: string }>,
    mode: 'merge' | 'replace',
): TableFull[] {
    const run = db().transaction((items: Array<{ name: string; html: string }>) => {
        let base: number;
        if (mode === 'replace') {
            db().prepare('DELETE FROM tables').run();
            base = 0;
        } else {
            const row = db().prepare('SELECT MAX(sort_order) AS m FROM tables').get() as { m: number | null };
            base = (row.m ?? 0) + 1;
        }
        return items.map((t, i) => createTable({ name: t.name, html: t.html, sortOrder: base + i }));
    });

    return run(tables);
}
