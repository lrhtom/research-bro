// ============================================================
//  Markdown 记事本的数据访问层
//
//  薄得刻意：一张表、五个函数，没有搜索、没有标签实体、没有自动保存。
//  搜索在前端对已经拉全的列表做，标签只是笔记上的一串字符串，
//  「自动保存」是浏览器本地的草稿，跟服务端无关。
// ============================================================

import { db, nowIso } from './db.js';
import type { Note } from '../shared/types.js';

interface NoteRecord {
    id: number;
    title: string;
    tags: string;
    content: string;
    created_at: string;
    updated_at: string;
}

/** 标题上限 200 字，跟表定义里的意图一致（SQLite 自己不管长度） */
const TITLE_MAX = 200;

function toNote(r: NoteRecord): Note {
    return {
        id: r.id,
        title: r.title,
        tags: parseTags(r.tags),
        content: r.content,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

/** 库里存的是 JSON 文本。存坏了也不能让整个列表接口挂掉，坏行按无标签处理。 */
function parseTags(raw: string): string[] {
    try {
        const v = JSON.parse(raw) as unknown;
        return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * 标签规整：去空白、转小写、丢空串、去重。
 *
 * 去重是这里比参考实现多做的一件事 —— 同一个标签在一条笔记上出现两次
 * 没有任何意义，而它只要进过库一次，之后每次筛选、每次渲染都要绕过它。
 */
export function normalizeTags(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const out: string[] = [];
    for (const raw of input) {
        const t = String(raw ?? '').trim().toLowerCase();
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

export function normalizeTitle(input: unknown): string {
    return String(input ?? '').trim().slice(0, TITLE_MAX);
}

// ---------- 读 ----------

/**
 * 全部笔记，正文一起带回来。
 *
 * 不分页、不做「列表只给摘要、点开再拉正文」—— 在自己一个人用的量级下，
 * 一次拉全换来的是：搜索、筛标签、切换笔记全部零延迟，也不用维护
 * 「这条的正文加载了没有」这种状态。等真攒到几千条再说。
 */
export function listNotes(): Note[] {
    const rows = db().prepare(
        'SELECT * FROM notes ORDER BY updated_at DESC, id DESC',
    ).all() as NoteRecord[];
    return rows.map(toNote);
}

export function getNote(id: number): Note | null {
    const row = db().prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRecord | undefined;
    return row ? toNote(row) : null;
}

// ---------- 写 ----------

export function createNote(input: { title?: unknown; tags?: unknown; content?: unknown }): Note {
    const now = nowIso();
    const info = db().prepare(
        `INSERT INTO notes (title, tags, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(
        normalizeTitle(input.title),
        JSON.stringify(normalizeTags(input.tags)),
        String(input.content ?? ''),
        now,
        now,
    );
    return getNote(Number(info.lastInsertRowid))!;
}

/**
 * 只改传进来的字段。
 *
 * 「没传」和「传了空值」是两件事：PATCH 只带 content 时不能把标题清空。
 * 所以这里判断的是键在不在，不是值真不真。
 */
export function updateNote(
    id: number,
    patch: { title?: unknown; tags?: unknown; content?: unknown },
): Note | null {
    if (!getNote(id)) return null;

    const sets: string[] = [];
    const args: unknown[] = [];

    if ('title' in patch) { sets.push('title = ?'); args.push(normalizeTitle(patch.title)); }
    if ('tags' in patch) { sets.push('tags = ?'); args.push(JSON.stringify(normalizeTags(patch.tags))); }
    if ('content' in patch) { sets.push('content = ?'); args.push(String(patch.content ?? '')); }

    // 一个字段都没给就别动 updated_at —— 空 PATCH 不该把笔记顶到侧栏最前面
    if (sets.length) {
        sets.push('updated_at = ?');
        args.push(nowIso());
        db().prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }
    return getNote(id);
}

export function deleteNote(id: number): boolean {
    return db().prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0;
}
