// ============================================================
//  SQLite 连接
//
//  单用户本地应用：没有登录，也就没有多租户隔离，一个进程一个库文件。
//  better-sqlite3 是同步 API —— 在本地单进程场景下这反而最省事：
//  路由处理函数里直接调，不用管连接池，也不会有竞态。
// ============================================================

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// dev 时是 src/server/，build 后是 dist/server/，往上两级都是仓库根
const ROOT = path.resolve(HERE, '..', '..');

export const DB_FILE = process.env.TOOLBOX_DB
    ? path.resolve(process.env.TOOLBOX_DB)
    : path.join(ROOT, 'data', 'app.db');

const SCHEMA_FILE = path.join(ROOT, 'db', 'schema.sql');

let conn: Database.Database | null = null;

export function db(): Database.Database {
    if (conn) return conn;

    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const c = new Database(DB_FILE);

    // WAL：读写不互相阻塞，且崩溃后能自愈。本地单进程也值得开。
    c.pragma('journal_mode = WAL');
    initSchema(c);

    conn = c;
    return c;
}

/** 测试用：换一个库文件（通常是内存库），并丢掉旧连接 */
export function useDatabase(next: Database.Database): void {
    conn = next;
}

export function initSchema(target: Database.Database): void {
    target.pragma('foreign_keys = ON');
    target.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    applyColumnMigrations(target);
}

/**
 * 给已经存在的表补列，然后建那些依赖这些列的索引。
 *
 * schema.sql 全是 CREATE TABLE IF NOT EXISTS —— 对已经建好的表，
 * 后来在 schema 里新加的列它一个都不会补上。所以新增列必须同时写两处：
 * schema.sql 的 CREATE TABLE（给全新的库）和这里（给已有数据的库）。
 *
 * 顺序很关键：**依赖后加列的索引只能建在这里**，不能写进 schema.sql。
 * 写进去的话，老库上 schema.sql 会先于补列执行，索引落在一个还不存在的
 * 列上，直接 "no such column" 把服务启动整个搞挂。
 *
 * 判断依据是 PRAGMA table_info，所以反复执行无副作用。
 */
function applyColumnMigrations(target: Database.Database): void {
    const addColumn = (table: string, column: string, ddl: string) => {
        const cols = target.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === column)) {
            target.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        }
    };

    addColumn('plans', 'favorite', 'favorite INTEGER NOT NULL DEFAULT 0');

    // 计划列表默认按「先收藏、再自定义顺序」排
    target.exec(
        'CREATE INDEX IF NOT EXISTS idx_plans_order ON plans (favorite DESC, sort_order ASC, id ASC)',
    );
}

export function nowIso(): string {
    return new Date().toISOString();
}

// ---------- settings ----------

export function getSetting(key: string): string | null {
    const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
    return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
    db().prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}

export function allSettings(): Record<string, string> {
    const rows = db().prepare('SELECT key, value FROM settings').all() as Array<{
        key: string;
        value: string;
    }>;
    const out: Record<string, string> = {};
    rows.forEach((r) => { out[r.key] = r.value; });
    return out;
}
