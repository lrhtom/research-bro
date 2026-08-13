// ============================================================
//  Markdown 记事本
//
//  左边一列笔记、右边一个编辑器，中间一条可以拖不动但能收起来的分界。
//  逻辑（字数、日期分组、光标落点、草稿脏判定）全在 lib/notes.ts，
//  这里只负责摆控件、调接口、把两者接起来。
//
//  编辑器就是一个 <textarea>。不上 CodeMirror、不上 Monaco，也不做
//  contenteditable 富文本 —— 「一个文本域 + 一个预览」本身就是这个功能的
//  全部想法，更重的东西在这儿买不到任何东西，只买到打包体积。
//
//  预览复用站里已有的 Markdown 组件（marked + DOMPurify，gfm 开着，
//  表格 / 删除线 / 任务列表都支持），没有再引一套 react-markdown。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import Markdown from '@/components/cards/Markdown';
import {
    apiCreateNote, apiDeleteNote, apiListNotes, apiUpdateNote,
} from '@/lib/api';
import {
    DATE_GROUP_LABEL, PLACEHOLDER, TEMPLATES,
    afterCloudSave, capitalizeSentenceStarts, computeInsertion, getPreviewText, getWordCount,
    groupNotesByDate, isClean, isSaveShortcut, loadDraft, matchesQuery, openNote, reconcileDraft,
    removeDraft, todayLabel,
    type Draft, type InsertKind, type NoteTemplate, type PreviewMode,
} from '@/lib/notes';
import type { Note } from '../../shared/types';

/** 本地草稿的防抖。够短，不会让人真的丢字；够长，不会每敲一下都写一次。 */
const DRAFT_DEBOUNCE_MS = 500;

const TOOLBAR: Array<{ kind: InsertKind; icon: string; title: string }> = [
    { kind: 'bold', icon: 'fa-bold', title: '加粗' },
    { kind: 'italic', icon: 'fa-italic', title: '斜体' },
    { kind: 'code', icon: 'fa-code', title: '行内代码' },
    { kind: 'link', icon: 'fa-link', title: '链接' },
    { kind: 'h2', icon: 'fa-heading', title: '二级标题' },
    { kind: 'h3', icon: 'fa-heading', title: '三级标题' },
    { kind: 'list', icon: 'fa-list-ul', title: '列表' },
    { kind: 'quote', icon: 'fa-quote-left', title: '引用' },
    { kind: 'table', icon: 'fa-table', title: '表格' },
];

const MODES: Array<{ mode: PreviewMode; label: string; icon: string }> = [
    { mode: 'edit', label: '编辑', icon: 'fa-pen' },
    { mode: 'split', label: '分栏', icon: 'fa-table-columns' },
    { mode: 'preview', label: '预览', icon: 'fa-eye' },
];

/* ---------------- 新建弹窗 ---------------- */

function CreateModal({ onCreate, onClose, busy }: {
    onCreate: (title: string, content: string) => void;
    onClose: () => void;
    busy: boolean;
}) {
    const [title, setTitle] = useState('');
    const [tpl, setTpl] = useState<NoteTemplate>(TEMPLATES[0]);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { inputRef.current?.focus(); }, []);

    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        onCreate(title.trim() || '未命名笔记', tpl.body(todayLabel()));
    };

    return (
        <div className="nb-modal-mask" onClick={onClose} role="presentation">
            <div className="nb-modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="nb-modal-title"><i className="fas fa-feather" /> 新建笔记</h3>

                <form onSubmit={submit}>
                    <label className="nb-field">
                        <span className="nb-field-label">标题</span>
                        <input
                            ref={inputRef}
                            className="nb-input"
                            value={title}
                            maxLength={200}
                            placeholder="留空就叫「未命名笔记」"
                            onChange={(e) => setTitle(e.target.value)}
                        />
                    </label>

                    <div className="nb-field">
                        <span className="nb-field-label">从哪种骨架开始</span>
                        <div className="nb-tpl-grid">
                            {TEMPLATES.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    className={'nb-tpl' + (t.id === tpl.id ? ' is-active' : '')}
                                    onClick={() => setTpl(t)}
                                >
                                    <i className={'fas ' + t.icon} />
                                    <span>{t.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="nb-modal-actions">
                        <button type="button" className="nb-btn" onClick={onClose}>取消</button>
                        <button type="submit" className="nb-btn nb-btn--primary" disabled={busy}>
                            {busy ? '创建中…' : '创建并开始写'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

/* ---------------- 主页面 ---------------- */

export default function NotesPage() {
    useEffect(() => { document.title = '记事本 · 工具箱'; }, []);

    const [notes, setNotes] = useState<Note[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedId, setSelectedId] = useState<number | null>(null);

    // 编辑器里的三个字段。它们是「本地这一份」，跟服务端那份可能不一样
    const [title, setTitle] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [content, setContent] = useState('');
    const [tagInput, setTagInput] = useState('');

    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [mode, setMode] = useState<PreviewMode>('split');
    const [query, setQuery] = useState('');
    const [collapsed, setCollapsed] = useState(false);
    const [creating, setCreating] = useState(false);
    const [showCreate, setShowCreate] = useState(false);
    const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
    /** 侧栏上那颗「有未保存草稿」的小圆点，靠它触发重算 */
    const [draftTick, setDraftTick] = useState(0);

    const editorRef = useRef<HTMLTextAreaElement>(null);
    const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const notify = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
        setToast({ text, kind });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 2000);
    }, []);

    // 一次拉全。不分页、不懒加载正文 —— 见 server/notes.ts 里的说明
    useEffect(() => {
        apiListNotes()
            .then(setNotes)
            .catch(() => notify('笔记加载失败', 'err'))
            .finally(() => setLoading(false));
    }, [notify]);

    const selected = useMemo(
        () => notes.find((n) => n.id === selectedId) ?? null,
        [notes, selectedId],
    );

    /** 选中一条笔记：有草稿用草稿，没有才用服务端那份 */
    useEffect(() => {
        if (!selected) return;
        const { draft, dirty: d } = openNote(selected);
        setTitle(draft.title);
        setTags(draft.tags);
        setContent(draft.content);
        setDirty(d);
        setTagInput('');
        // 只在切换笔记时灌一次。依赖 selected 会让每次云端保存后
        // 拿回来的新对象再灌一遍，把光标顶回开头
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId]);

    /**
     * 第一层：本地草稿，每次编辑防抖 500ms 写进 sessionStorage。
     *
     * 这一层是崩溃/误关的保险，不是持久化。真正的持久化只有按保存那一条路。
     * 注意它跟上面那个 effect 会被同一批 state 变化触发 —— 所以判定放在
     * reconcileDraft 里：内容跟服务端一致就删草稿、判干净，
     * 「光是打开一条笔记就变成未保存」这个 bug 就是在这里挡掉的。
     */
    useEffect(() => {
        if (!selected || loading) return;
        if (draftTimer.current) clearTimeout(draftTimer.current);

        const local: Draft = { title, tags, content };

        // 跟服务端一致就当场处理掉，不进防抖：这条路径正是「刚打开一条笔记」，
        // 让它挂 500ms 会让「未保存」标记先亮一下再灭，看着像出了 bug
        if (isClean(selected, local)) {
            reconcileDraft(selected, local);
            setDirty(false);
            setDraftTick((v) => v + 1);
            return;
        }

        draftTimer.current = setTimeout(() => {
            setDirty(reconcileDraft(selected, local));
            setDraftTick((v) => v + 1);
        }, DRAFT_DEBOUNCE_MS);

        return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
    }, [title, tags, content, selected, loading]);

    /** 第二层：存云端。只有这里和 Ctrl/Cmd-S 会 PATCH 服务端，没有定时上传。 */
    const saveToCloud = useCallback(async () => {
        if (!selected || !dirty || saving) return;
        setSaving(true);
        try {
            const saved = await apiUpdateNote(selected.id, { title, tags, content });
            setNotes((prev) => prev.map((n) => (n.id === saved.id ? saved : n)));
            afterCloudSave(saved.id);
            setDirty(false);
            setDraftTick((v) => v + 1);
            notify('已保存');
        } catch (e) {
            notify(e instanceof Error ? e.message : '保存失败', 'err');
        } finally {
            setSaving(false);
        }
    }, [selected, dirty, saving, title, tags, content, notify]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!isSaveShortcut(e)) return;
            e.preventDefault();
            void saveToCloud();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [saveToCloud]);

    /* ---------- 增删 ---------- */

    const handleCreate = async (noteTitle: string, noteContent: string) => {
        setCreating(true);
        try {
            const note = await apiCreateNote({ title: noteTitle, content: noteContent });
            setNotes((prev) => [note, ...prev]);
            setSelectedId(note.id);
            setMode('split');
            setShowCreate(false);
            setTimeout(() => editorRef.current?.focus(), 80);
        } catch {
            notify('创建失败', 'err');
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async () => {
        if (!selected) return;
        if (!window.confirm(`删除笔记「${selected.title || '未命名笔记'}」吗？\n内容会一起删掉，无法撤销。`)) return;
        try {
            await apiDeleteNote(selected.id);
            removeDraft(selected.id);
            setNotes((prev) => prev.filter((n) => n.id !== selected.id));
            setSelectedId(null);
            setDirty(false);
            notify('已删除');
        } catch {
            notify('删除失败', 'err');
        }
    };

    /* ---------- 标签 ---------- */

    const addTag = () => {
        const t = tagInput.trim().toLowerCase();
        if (!t) return;
        if (!tags.includes(t)) setTags([...tags, t]);
        setTagInput('');
    };

    /* ---------- 工具栏 ---------- */

    const insert = (kind: InsertKind) => {
        const el = editorRef.current;
        if (!el) return;
        const r = computeInsertion(content, el.selectionStart, el.selectionEnd, kind);
        setContent(r.value);
        // 等 React 把新的 value 提交上去再摆光标，否则会被这一次渲染冲掉
        setTimeout(() => {
            el.focus();
            el.setSelectionRange(r.selStart, r.selEnd);
        }, 0);
    };

    const capitalize = () => {
        const el = editorRef.current;
        const from = el?.selectionStart ?? 0;
        const to = el?.selectionEnd ?? 0;
        const hasSel = !!el && to > from;

        const target = hasSel ? content.slice(from, to) : content;
        const { result, count } = capitalizeSentenceStarts(target);
        if (count === 0) {
            notify('没有需要改的句首');
            return;
        }
        setContent(hasSel ? content.slice(0, from) + result + content.slice(to) : result);
        notify(`改了 ${count} 处句首`);
        // 大小写替换不改变长度，原来的选区偏移仍然有效
        if (el) setTimeout(() => { el.focus(); el.setSelectionRange(from, to); }, 0);
    };

    /* ---------- 派生 ---------- */

    const filtered = useMemo(() => notes.filter((n) => matchesQuery(n, query)), [notes, query]);
    const groups = useMemo(() => groupNotesByDate(filtered), [filtered]);
    const wc = useMemo(() => getWordCount(content), [content]);
    const draftIds = useMemo(() => {
        void draftTick;                       // 保存/编辑之后要重算这一份
        return new Set(notes.filter((n) => loadDraft(n.id)).map((n) => n.id));
    }, [notes, draftTick]);

    /* ---------- 渲染 ---------- */

    return (
        <AppShell title="记事本" subtitle="Markdown Notebook · 本地存储">
            {showCreate && (
                <CreateModal
                    busy={creating}
                    onClose={() => setShowCreate(false)}
                    onCreate={handleCreate}
                />
            )}

            {toast && <div className={'nb-toast nb-toast--' + toast.kind}>{toast.text}</div>}

            <div className={'nb-wrap' + (collapsed ? ' nb-wrap--collapsed' : '')}>
                {/* ---------------- 侧栏 ---------------- */}
                <aside className="nb-side">
                    <div className="nb-side-head">
                        <h2>全部笔记</h2>
                        <button
                            type="button"
                            className="nb-icon-btn"
                            title={collapsed ? '展开列表' : '收起列表'}
                            aria-label={collapsed ? '展开列表' : '收起列表'}
                            onClick={() => setCollapsed((v) => !v)}
                        >
                            <i className={'fas ' + (collapsed ? 'fa-angles-right' : 'fa-angles-left')} />
                        </button>
                    </div>

                    <button type="button" className="nb-new" onClick={() => setShowCreate(true)}>
                        <i className="fas fa-plus" /> 新建笔记
                    </button>

                    <div className="nb-search">
                        <i className="fas fa-magnifying-glass" />
                        <input
                            value={query}
                            placeholder="搜标题、正文、标签"
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        {query && (
                            <button
                                type="button"
                                className="nb-search-clear"
                                aria-label="清空搜索"
                                onClick={() => setQuery('')}
                            >
                                ×
                            </button>
                        )}
                    </div>

                    <div className="nb-list">
                        {loading ? (
                            <p className="nb-empty">加载中…</p>
                        ) : filtered.length === 0 ? (
                            <div className="nb-empty">
                                <i className="fas fa-feather-pointed nb-empty-icon" />
                                <p>{query ? '没有匹配的笔记' : '还一条笔记都没有'}</p>
                                {!query && (
                                    <button type="button" className="nb-btn nb-btn--primary" onClick={() => setShowCreate(true)}>
                                        写第一条
                                    </button>
                                )}
                            </div>
                        ) : groups.map((g) => (
                            <section key={g.key} className="nb-group">
                                <h3 className="nb-group-label">{DATE_GROUP_LABEL[g.key]}</h3>
                                {g.notes.map((n) => (
                                    <button
                                        key={n.id}
                                        type="button"
                                        className={'nb-item' + (n.id === selectedId ? ' is-active' : '')}
                                        onClick={() => setSelectedId(n.id)}
                                    >
                                        <span className="nb-item-head">
                                            <b>{n.title || '未命名笔记'}</b>
                                            {draftIds.has(n.id) && <i className="nb-dot" title="有未保存的改动" />}
                                        </span>
                                        {n.content && <span className="nb-item-preview">{getPreviewText(n.content)}</span>}
                                        {n.tags.length > 0 && (
                                            <span className="nb-item-tags">
                                                {n.tags.slice(0, 4).map((t) => <span key={t} className="nb-chip">{t}</span>)}
                                                {n.tags.length > 4 && <span className="nb-chip">+{n.tags.length - 4}</span>}
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </section>
                        ))}
                    </div>

                    <footer className="nb-side-foot">
                        共 {notes.length} 条{query && ` · 命中 ${filtered.length} 条`}
                    </footer>
                </aside>

                {/* ---------------- 编辑器 ---------------- */}
                <section className="nb-main">
                    {!selected ? (
                        <div className="nb-blank">
                            <i className="fas fa-file-lines" />
                            <p>左边挑一条笔记，或者新建一条。</p>
                            <p className="nb-blank-hint">
                                写的时候每 0.5 秒往浏览器本地存一次草稿，<b>存到本机数据库要按保存或 Ctrl/⌘+S</b> ——
                                不会有定时器背着你上传。
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="nb-meta">
                                <input
                                    className="nb-title"
                                    value={title}
                                    maxLength={200}
                                    placeholder="笔记标题"
                                    onChange={(e) => setTitle(e.target.value)}
                                />
                                <div className="nb-meta-actions">
                                    {dirty && <span className="nb-dirty">未保存</span>}
                                    <button
                                        type="button"
                                        className="nb-btn nb-btn--primary"
                                        disabled={!dirty || saving}
                                        onClick={() => void saveToCloud()}
                                        title="保存到本机数据库（Ctrl/⌘+S）"
                                    >
                                        <i className="fas fa-floppy-disk" /> {saving ? '保存中…' : '保存'}
                                    </button>
                                    <button type="button" className="nb-btn nb-btn--danger" onClick={() => void handleDelete()}>
                                        <i className="fas fa-trash" /> 删除
                                    </button>
                                </div>
                            </div>

                            <div className="nb-tags">
                                {tags.map((t) => (
                                    <span key={t} className="nb-chip nb-chip--edit">
                                        {t}
                                        <button type="button" aria-label={`移除标签 ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}>×</button>
                                    </span>
                                ))}
                                <input
                                    className="nb-tag-input"
                                    value={tagInput}
                                    placeholder="加标签，回车确认"
                                    onChange={(e) => setTagInput(e.target.value)}
                                    onBlur={addTag}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') { e.preventDefault(); addTag(); }
                                        // 输入框空着时退格删掉最后一个，跟常见标签控件一致
                                        else if (e.key === 'Backspace' && !tagInput && tags.length) setTags(tags.slice(0, -1));
                                    }}
                                />
                            </div>

                            <div className="nb-bar">
                                <div className="nb-tools">
                                    {TOOLBAR.map((b) => (
                                        <button
                                            key={b.kind}
                                            type="button"
                                            className="nb-icon-btn"
                                            title={b.title}
                                            aria-label={b.title}
                                            onClick={() => insert(b.kind)}
                                        >
                                            <i className={'fas ' + b.icon} />
                                            {b.kind === 'h3' && <sub>3</sub>}
                                            {b.kind === 'h2' && <sub>2</sub>}
                                        </button>
                                    ))}
                                    <span className="nb-tools-sep" />
                                    <button
                                        type="button"
                                        className="nb-icon-btn"
                                        title="句首字母大写（跳过反引号里的代码）"
                                        aria-label="句首字母大写"
                                        onClick={capitalize}
                                    >
                                        <i className="fas fa-font" />
                                    </button>
                                </div>

                                {/* 三档视图带文字，不做纯图标 —— 图标猜不出「分栏」和「预览」 */}
                                <div className="nb-modes" role="group" aria-label="视图">
                                    {MODES.map((m) => (
                                        <button
                                            key={m.mode}
                                            type="button"
                                            className={'nb-mode' + (mode === m.mode ? ' is-active' : '')}
                                            aria-pressed={mode === m.mode}
                                            onClick={() => setMode(m.mode)}
                                        >
                                            <i className={'fas ' + m.icon} /> {m.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className={'nb-panes nb-panes--' + mode}>
                                {mode !== 'preview' && (
                                    <textarea
                                        ref={editorRef}
                                        className="nb-editor"
                                        value={content}
                                        spellCheck={false}
                                        placeholder={`用 Markdown 写。表格、任务列表、删除线都支持。\n\n试试工具栏，或者直接打字 —— 比如 **${PLACEHOLDER.bold}**`}
                                        onChange={(e) => setContent(e.target.value)}
                                    />
                                )}
                                {mode !== 'edit' && (
                                    <div className="nb-preview">
                                        {content.trim()
                                            ? <Markdown source={content} className="fc-markdown" />
                                            : <p className="nb-preview-empty">左边写点什么，这里会实时渲染。</p>}
                                    </div>
                                )}
                            </div>

                            <footer className="nb-foot">
                                <span>{wc.words} 词 · {wc.chars} 字</span>
                                <span>
                                    {dirty ? '有改动没存' : '已与本机数据库一致'}
                                    {' · '}
                                    更新于 {new Date(selected.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                                </span>
                            </footer>
                        </>
                    )}
                </section>
            </div>
        </AppShell>
    );
}
