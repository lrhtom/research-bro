// ============================================================
//  一次性迁移：三线表 JSON 备份 → SQLite
//
//  旧版把表格存在浏览器 localStorage 里，导出的备份文件长这样：
//      { format: 'academic-three-line-table-backup', version: 1, tables: [{id, name, html}] }
//
//  用法：
//      npm run migrate                        # 用默认备份路径
//      npm run migrate -- <备份文件.json>     # 指定文件
//      npm run migrate -- <文件> --replace    # 先清空再导入
//
//  默认是「幂等追加」：备份里的 id 已经在库里就跳过，可以重复跑不会出重复表。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { parse } from 'node-html-parser';

const DEFAULT_BACKUP = 'C:\\Users\\lrhto\\Downloads\\三线表备份_20260808_0903_25张.json';
const BACKUP_FORMAT = 'academic-three-line-table-backup';

const ROOT = process.cwd();
const DB_FILE = path.join(ROOT, 'data', 'app.db');
const SCHEMA_FILE = path.join(ROOT, 'db', 'schema.sql');

// ---------- HTML 处理（与 src/lib/table-html.ts 同一套规则）----------

const DROP_TAGS = 'script, iframe, object, embed, link, meta, base, form, svg, audio, video';
const URL_ATTRS = /^(src|href|xlink:href|action|formaction)$/;

function sanitizeTableHtml(html) {
    const root = parse(String(html ?? ''), {
        blockTextElements: { script: true, noscript: true, style: true, pre: true },
    });
    root.querySelectorAll(DROP_TAGS).forEach((node) => node.remove());
    root.querySelectorAll('*').forEach((el) => {
        Object.keys(el.attributes).forEach((raw) => {
            const name = raw.toLowerCase();
            const val = String(el.attributes[raw] ?? '');
            if (name.startsWith('on')) el.removeAttribute(raw);
            else if (URL_ATTRS.test(name) && /^\s*javascript:/i.test(val)) el.removeAttribute(raw);
        });
    });
    return root.toString();
}

function tableShape(html) {
    try {
        const root = parse(String(html ?? ''));
        const table = root.querySelector('table');
        if (!table) return { rows: 0, cols: 0, caption: '' };
        const headRow = table.querySelector('thead tr');
        const cols = headRow ? headRow.childNodes.filter((n) => n.nodeType === 1).length : 0;
        const rows = table.querySelectorAll('tbody tr').length;
        const cap = table.querySelector('caption');
        return { rows, cols, caption: cap ? cap.textContent.trim() : '' };
    } catch {
        return { rows: 0, cols: 0, caption: '' };
    }
}

// ---------- 主流程 ----------

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const backupPath = args.find((a) => !a.startsWith('--')) ?? DEFAULT_BACKUP;

if (!fs.existsSync(backupPath)) {
    console.error(`✗ 找不到备份文件：${backupPath}`);
    process.exit(1);
}

let payload;
try {
    payload = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
} catch (err) {
    console.error(`✗ 备份文件不是合法 JSON：${err.message}`);
    process.exit(1);
}

if (!payload || payload.format !== BACKUP_FORMAT) {
    console.error(`✗ format 字段对不上，期望 "${BACKUP_FORMAT}"，实际 "${payload?.format}"`);
    process.exit(1);
}
if (!Array.isArray(payload.tables)) {
    console.error('✗ 备份文件缺少 tables 数组');
    process.exit(1);
}

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const conn = new Database(DB_FILE);
conn.pragma('journal_mode = WAL');
conn.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));

if (replace) {
    const n = conn.prepare('SELECT COUNT(*) AS n FROM tables').get().n;
    conn.prepare('DELETE FROM tables').run();
    console.log(`· --replace：已清空原有 ${n} 张表`);
}

const exists = conn.prepare('SELECT 1 FROM tables WHERE id = ?');
const insert = conn.prepare(
    `INSERT INTO tables (id, name, html, caption, row_count, col_count, sort_order, created_at, updated_at)
     VALUES (@id, @name, @html, @caption, @row_count, @col_count, @sort_order, @created_at, @updated_at)`,
);

// 备份里的顺序就是旧版侧边栏的顺序，原样保留
const baseOrder = conn.prepare('SELECT MAX(sort_order) AS m FROM tables').get().m ?? -1;
const ts = payload.exportedAt || new Date().toISOString();

const stats = { inserted: 0, skipped: 0, invalid: 0 };

const run = conn.transaction((items) => {
    items.forEach((t, i) => {
        if (!t || typeof t !== 'object') {
            stats.invalid++;
            console.warn(`  ! 第 ${i + 1} 条不是对象，跳过`);
            return;
        }

        const html = sanitizeTableHtml(t.html);
        if (!/<table[\s>]/i.test(html)) {
            stats.invalid++;
            console.warn(`  ! 第 ${i + 1} 条（${t.name ?? '无名'}）里没有 <table>，跳过`);
            return;
        }

        const id = String(t.id || `table_${Date.now()}_${i}`);
        if (exists.get(id)) {
            stats.skipped++;
            console.log(`  = 已存在，跳过：${t.name}`);
            return;
        }

        const shape = tableShape(html);
        insert.run({
            id,
            name: String(t.name || '未命名表格').slice(0, 200),
            html,
            caption: shape.caption,
            row_count: shape.rows,
            col_count: shape.cols,
            sort_order: baseOrder + 1 + i,
            created_at: ts,
            updated_at: ts,
        });
        stats.inserted++;
        console.log(`  + ${String(t.name).slice(0, 48).padEnd(50)} ${shape.cols} 列 × ${shape.rows} 行`);
    });
});

console.log(`\n从 ${path.basename(backupPath)} 读到 ${payload.tables.length} 张表：\n`);
run(payload.tables);

const total = conn.prepare('SELECT COUNT(*) AS n FROM tables').get().n;
conn.close();

console.log(
    `\n✓ 完成：新增 ${stats.inserted} · 跳过 ${stats.skipped} · 无效 ${stats.invalid}`
    + `\n  数据库现有 ${total} 张表 → ${path.relative(ROOT, DB_FILE)}`,
);
