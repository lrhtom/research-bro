// 学术三线表 + 备份 + 全局设置的 HTTP 接口

import { Router } from 'express';
import { allSettings, getSetting, setSetting } from './db.js';
import {
    allTables, createTable, deleteTable, getTable, listTables, restoreTables, updateTable,
} from './tables.js';
import { looksLikeTable } from './table-html.js';
import { BACKUP_FORMAT, BACKUP_VERSION, defaultTableHtml, type BackupPayload } from '../shared/table-defaults.js';
import { normalizeTimeZone } from './time.js';

export const tablesRouter: Router = Router();

// ---------- 表格 ----------

tablesRouter.get('/tables', (_req, res) => {
    res.json({ tables: listTables() });
});

/**
 * 三线表页的首屏数据，一次拿全：列表 + 该打开的那张表 + 导出倍率。
 * 库是空的（第一次跑）就先建一张默认表，编辑器永远有东西可编辑。
 * 注意要定义在 /tables/:id 之前，否则 "table-bootstrap" 会被当成表 id。
 */
tablesRouter.get('/table-bootstrap', (_req, res) => {
    if (allTables().length === 0) {
        createTable({ name: '表 1: 未命名表格', html: defaultTableHtml('表 1: 未命名表格') });
    }
    const tables = listTables();
    // 优先打开上次编辑的那张；它可能已经被删了，兜底到列表第一张
    const lastId = getSetting('last_table_id');
    const table = (lastId ? getTable(lastId) : null) ?? getTable(tables[0].id)!;
    const scale = Number(getSetting('export_scale'));

    res.json({
        tables,
        table,
        exportScale: Number.isFinite(scale) && scale > 0 ? scale : 6,
    });
});

tablesRouter.post('/tables', (req, res) => {
    const body = (req.body ?? {}) as { name?: string; html?: string };
    const name = (body.name ?? '新图表').trim() || '新图表';
    const html = body.html ?? defaultTableHtml(name);
    res.status(201).json({ table: createTable({ name, html }) });
});

tablesRouter.get('/tables/:id', (req, res) => {
    const table = getTable(req.params.id);
    if (!table) { res.status(404).json({ error: '表格不存在' }); return; }
    res.json({ table });
});

tablesRouter.put('/tables/:id', (req, res) => {
    const body = (req.body ?? {}) as { name?: string; html?: string };
    const table = updateTable(req.params.id, { name: body.name, html: body.html });
    if (!table) { res.status(404).json({ error: '表格不存在' }); return; }
    res.json({ table });
});

tablesRouter.delete('/tables/:id', (req, res) => {
    const result = deleteTable(req.params.id);
    if (!result.ok) { res.status(409).json({ error: result.reason }); return; }
    res.json({ ok: true });
});

// ---------- 备份 ----------
//
// 导出格式与旧版静态站完全一致，两边可以互相导入。

tablesRouter.get('/backup', (_req, res) => {
    const tables = allTables();
    const payload: BackupPayload = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        count: tables.length,
        tables: tables.map((t) => ({ id: t.id, name: t.name, html: t.html })),
    };

    const d = new Date();
    const stamp = d.getFullYear()
        + String(d.getMonth() + 1).padStart(2, '0')
        + String(d.getDate()).padStart(2, '0')
        + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    const cnName = `三线表备份_${stamp}_${payload.count}张.json`;

    res.setHeader('Content-Type', 'application/json;charset=utf-8');
    // 文件名含中文，要靠 RFC 5987 的 filename* 才不会在下载时变乱码
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="backup_${stamp}_${payload.count}.json"; `
        + `filename*=UTF-8''${encodeURIComponent(cnName)}`,
    );
    res.send(JSON.stringify(payload, null, 2));
});

tablesRouter.post('/backup', (req, res) => {
    const body = (req.body ?? {}) as { tables?: unknown; mode?: unknown };
    if (!Array.isArray(body.tables)) {
        res.status(400).json({ error: '缺少 tables 数组' });
        return;
    }
    const mode = body.mode === 'replace' ? 'replace' : 'merge';

    const warnings: string[] = [];
    const clean: Array<{ name: string; html: string }> = [];

    body.tables.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object') {
            warnings.push(`第 ${i + 1} 条不是对象，已跳过`);
            return;
        }
        const t = raw as { name?: unknown; html?: unknown };
        const html = String(t.html ?? '');
        // 真正的清洗在 createTable 里做，这里只筛掉「压根没有表格」的条目
        if (!looksLikeTable(html)) {
            warnings.push(`第 ${i + 1} 条里没有表格，已跳过`);
            return;
        }
        clean.push({ name: String(t.name ?? '未命名表格').slice(0, 120), html });
    });

    if (clean.length === 0) {
        res.status(400).json({ error: '文件里没有可用的表格', warnings });
        return;
    }

    const created = restoreTables(clean, mode);
    res.json({ ok: true, mode, count: created.length, firstId: created[0].id, warnings });
});

// ---------- 设置 ----------

tablesRouter.get('/settings', (_req, res) => {
    res.json({ settings: allSettings() });
});

tablesRouter.post('/settings', (req, res) => {
    const body = (req.body ?? {}) as { key?: unknown; value?: unknown };
    const key = typeof body.key === 'string' ? body.key : '';
    if (!key) { res.status(400).json({ error: '缺少 key' }); return; }

    // 时区会直接影响「今天」怎么切，写进来的必须是运行时认识的 IANA 名字
    const value = key === 'timezone'
        ? normalizeTimeZone(String(body.value ?? ''))
        : String(body.value ?? '');

    setSetting(key, value);
    res.json({ ok: true, key, value: getSetting(key) });
});
