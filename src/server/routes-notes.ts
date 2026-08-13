// Markdown 记事本的 HTTP 接口
//
// 只有两组路由：列表/新建，和单条的读/改/删。
// **刻意没有**搜索接口、标签接口、自动保存接口 —— 那三件事全在前端做：
// 搜索是对已经拉全的列表过滤，标签只是笔记上的字符串数组，
// 「自动保存」是浏览器本地草稿，服务端只在你按保存时被打扰一次。

import { Router } from 'express';
import { createNote, deleteNote, getNote, listNotes, updateNote } from './notes.js';

export const notesRouter: Router = Router();

/** 路径参数是字符串，非法 id 一律当成不存在 */
function noteId(raw: string): number | null {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

notesRouter.get('/notes', (_req, res) => {
    res.json({ notes: listNotes() });
});

notesRouter.post('/notes', (req, res) => {
    const body = (req.body ?? {}) as { title?: unknown; tags?: unknown; content?: unknown };
    res.status(201).json({ note: createNote(body) });
});

notesRouter.get('/notes/:id', (req, res) => {
    const id = noteId(req.params.id);
    const note = id === null ? null : getNote(id);
    if (!note) { res.status(404).json({ error: '笔记不存在' }); return; }
    res.json({ note });
});

notesRouter.patch('/notes/:id', (req, res) => {
    const id = noteId(req.params.id);
    if (id === null) { res.status(404).json({ error: '笔记不存在' }); return; }

    // 只把请求里真正出现过的键传下去 —— 「没传 title」不等于「把 title 清空」
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { title?: unknown; tags?: unknown; content?: unknown } = {};
    if ('title' in body) patch.title = body.title;
    if ('tags' in body) patch.tags = body.tags;
    if ('content' in body) patch.content = body.content;

    const note = updateNote(id, patch);
    if (!note) { res.status(404).json({ error: '笔记不存在' }); return; }
    res.json({ note });
});

notesRouter.delete('/notes/:id', (req, res) => {
    const id = noteId(req.params.id);
    if (id === null || !deleteNote(id)) { res.status(404).json({ error: '笔记不存在' }); return; }
    res.json({ ok: true });
});
