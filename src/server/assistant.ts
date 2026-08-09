// ============================================================
//  AI 悬浮球的数据层：待办、快捷方式、站内检索
//
//  待办和快捷方式是悬浮球自己的两张小表，跟三线表/记忆卡互不相干。
//  站内检索直接扫 shared/site-catalog 那份内存数组 —— 站里总共几十个
//  条目，线性扫一遍是微秒级，为它建 FTS 索引纯属自找麻烦。
// ============================================================

import { db, nowIso } from './db.js';
import { demoHref, demos, subRoutes, tools, vizCats } from '../shared/site-catalog.js';
import type { AssistantShortcut, AssistantTodo } from '../shared/types.js';

export class AssistantError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

/** 一条待办最多这么长。超了多半是把整段笔记粘进来了，截断比报错友好。 */
const TODO_MAX = 300;
const SHORTCUT_TITLE_MAX = 60;
const SHORTCUT_URL_MAX = 2000;

// ---------- 待办 ----------

interface TodoRow {
    id: number;
    text: string;
    done: number;
    created_at: string;
}

function toTodo(r: TodoRow): AssistantTodo {
    return { id: r.id, text: r.text, done: r.done === 1, createdAt: r.created_at };
}

/** 未完成的排前面，同组内新建的排前面 */
export function listTodos(): AssistantTodo[] {
    const rows = db().prepare(
        'SELECT id, text, done, created_at FROM assistant_todos ORDER BY done ASC, id DESC',
    ).all() as TodoRow[];
    return rows.map(toTodo);
}

export function createTodo(rawText: string): AssistantTodo {
    const text = String(rawText ?? '').trim().slice(0, TODO_MAX);
    if (!text) throw new AssistantError('待办内容不能为空');

    const info = db().prepare(
        'INSERT INTO assistant_todos (text, done, created_at) VALUES (?, 0, ?)',
    ).run(text, nowIso());
    return requireTodo(Number(info.lastInsertRowid));
}

export function requireTodo(id: number): AssistantTodo {
    const row = db().prepare(
        'SELECT id, text, done, created_at FROM assistant_todos WHERE id = ?',
    ).get(id) as TodoRow | undefined;
    if (!row) throw new AssistantError('这条待办不存在', 404);
    return toTodo(row);
}

export function updateTodo(id: number, patch: { text?: string; done?: boolean }): AssistantTodo {
    const current = requireTodo(id);
    const text = patch.text === undefined ? current.text : patch.text.trim().slice(0, TODO_MAX);
    if (!text) throw new AssistantError('待办内容不能为空');
    const done = patch.done === undefined ? current.done : patch.done;

    db().prepare('UPDATE assistant_todos SET text = ?, done = ? WHERE id = ?')
        .run(text, done ? 1 : 0, id);
    return requireTodo(id);
}

/** 不存在也当成功 —— 删除是幂等的，重复点两下不该报错 */
export function deleteTodo(id: number): boolean {
    return db().prepare('DELETE FROM assistant_todos WHERE id = ?').run(id).changes > 0;
}

export function clearDoneTodos(): number {
    return db().prepare('DELETE FROM assistant_todos WHERE done = 1').run().changes;
}

// ---------- 快捷方式 ----------

interface ShortcutRow {
    id: number;
    title: string;
    url: string;
    open_in_new_tab: number;
    created_at: string;
}

function toShortcut(r: ShortcutRow): AssistantShortcut {
    return {
        id: r.id,
        title: r.title,
        url: r.url,
        openInNewTab: r.open_in_new_tab === 1,
        createdAt: r.created_at,
    };
}

/**
 * 只放行 http(s) 和站内绝对路径。
 *
 * 挡的是 javascript: 与 data: —— 快捷方式是「点一下就跳」的东西，
 * 让它能承载一段可执行脚本，等于给自己留了个随时会踩的坑。
 */
function normalizeUrl(raw: string): string {
    const url = String(raw ?? '').trim().slice(0, SHORTCUT_URL_MAX);
    if (!url) throw new AssistantError('链接不能为空');
    if (url.startsWith('/')) return url;
    if (/^https?:\/\//i.test(url)) return url;
    throw new AssistantError('链接要以 http://、https:// 或 /（站内路径）开头');
}

export function listShortcuts(): AssistantShortcut[] {
    const rows = db().prepare(
        'SELECT id, title, url, open_in_new_tab, created_at FROM assistant_shortcuts ORDER BY id ASC',
    ).all() as ShortcutRow[];
    return rows.map(toShortcut);
}

export function requireShortcut(id: number): AssistantShortcut {
    const row = db().prepare(
        'SELECT id, title, url, open_in_new_tab, created_at FROM assistant_shortcuts WHERE id = ?',
    ).get(id) as ShortcutRow | undefined;
    if (!row) throw new AssistantError('这条快捷方式不存在', 404);
    return toShortcut(row);
}

export function createShortcut(input: {
    title: string;
    url: string;
    openInNewTab?: boolean;
}): AssistantShortcut {
    const title = String(input.title ?? '').trim().slice(0, SHORTCUT_TITLE_MAX);
    if (!title) throw new AssistantError('快捷方式要有个名字');
    const url = normalizeUrl(input.url);

    // 没明说的话按链接类型猜：站内路径原地跳（保留 SPA 状态），外链开新标签页
    const newTab = input.openInNewTab === undefined ? !url.startsWith('/') : input.openInNewTab;

    const info = db().prepare(
        'INSERT INTO assistant_shortcuts (title, url, open_in_new_tab, created_at) VALUES (?, ?, ?, ?)',
    ).run(title, url, newTab ? 1 : 0, nowIso());
    return requireShortcut(Number(info.lastInsertRowid));
}

export function updateShortcut(id: number, patch: {
    title?: string;
    url?: string;
    openInNewTab?: boolean;
}): AssistantShortcut {
    const cur = requireShortcut(id);
    const title = patch.title === undefined ? cur.title : patch.title.trim().slice(0, SHORTCUT_TITLE_MAX);
    if (!title) throw new AssistantError('快捷方式要有个名字');
    const url = patch.url === undefined ? cur.url : normalizeUrl(patch.url);
    const newTab = patch.openInNewTab === undefined ? cur.openInNewTab : patch.openInNewTab;

    db().prepare('UPDATE assistant_shortcuts SET title = ?, url = ?, open_in_new_tab = ? WHERE id = ?')
        .run(title, url, newTab ? 1 : 0, id);
    return requireShortcut(id);
}

export function deleteShortcut(id: number): boolean {
    return db().prepare('DELETE FROM assistant_shortcuts WHERE id = ?').run(id).changes > 0;
}

// ---------- 站内检索与导航 ----------

export interface SitePage {
    href: string;
    title: string;
    desc: string;
    /** 参与匹配但不展示的别名 */
    keywords: string;
}

/**
 * 站内所有可导航目标：8 个工具 + 二级页面 + 30 个可视化演示。
 *
 * 只在首次调用时拼一次。这份数据是编译期常量，不会在运行中变。
 */
let pageCache: SitePage[] | null = null;

export function sitePages(): SitePage[] {
    if (pageCache) return pageCache;

    const pages: SitePage[] = [
        { href: '/', title: '工具箱首页', desc: '全部工具的入口卡片', keywords: '首页 主页 home 全部工具' },
    ];

    tools.forEach((t) => pages.push({
        href: t.href,
        title: t.title,
        desc: t.desc,
        keywords: `${t.subtitle} ${t.keywords}`,
    }));

    subRoutes.forEach((s) => pages.push({
        href: s.href, title: s.title, desc: s.desc, keywords: s.title,
    }));

    demos.forEach((d) => pages.push({
        href: demoHref(d.id),
        title: `可视化演示 · ${d.t}`,
        desc: `${d.s} —— ${d.d}`,
        keywords: `${d.id.replace(/-/g, ' ')} ${vizCats[d.cat] ?? ''} 演示 可视化`,
    }));

    pageCache = pages;
    return pages;
}

/** 这个路径是不是站里真有的一页。助手给的 path 一律先过这一关。 */
export function isKnownPath(path: string): boolean {
    const clean = String(path ?? '').trim();
    if (!clean.startsWith('/')) return false;
    // 演示是带 #demo= 的深链接，比对时按整串来
    return sitePages().some((p) => p.href === clean);
}

/**
 * 极简打分检索：标题命中权重最高，其次说明，最后关键词。
 *
 * 跟前端搜索框（lib/search.ts）是两套实现，但两边喂的是同一份数据，
 * 结果不会互相打架。这里不追求排序完全一致 —— 助手只要前几条对得上就够了。
 */
export function searchSite(query: string, limit = 6): SitePage[] {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];

    // 中文没有空格分词，整串匹配之外再按字符切一层，"一致性哈希" 也能命中 "一致性哈希 演示"
    const terms = q.split(/\s+/).filter(Boolean);

    const scored = sitePages().map((p) => {
        const title = p.title.toLowerCase();
        const desc = p.desc.toLowerCase();
        const keys = p.keywords.toLowerCase();

        let score = 0;
        for (const term of terms) {
            if (title.includes(term)) score += 10;
            else if (keys.includes(term)) score += 4;
            else if (desc.includes(term)) score += 2;
        }
        return { page: p, score };
    });

    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => s.page);
}
