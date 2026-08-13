// ============================================================
//  记事本的纯逻辑
//
//  页面组件只负责摆控件和调接口，凡是「算出一个结果」的事情都放这里 ——
//  字数、日期分组、工具栏插入的光标落点、草稿的脏判定，全都能脱离 DOM 测。
//  这几件事恰好也是最容易写错、且错了不会报错只会静静给出坏结果的部分。
// ============================================================

import type { Note } from '../../shared/types';

/** 编辑器的三种视图 */
export type PreviewMode = 'edit' | 'split' | 'preview';

// ---------- 字数 ----------

/**
 * CJK 统一表意文字 + 扩展 A + 兼容表意 + 日文假名 + 谚文。
 *
 * 只按空白切词的话，一整段中文会被算成 1 个词 —— 中文里没有空格，
 * 所以中日韩字符必须一个字算一个。
 */
export const CJK_RE = /[一-鿿㐀-䶿豈-﫿぀-ヿ가-힯]/g;

export function getWordCount(text: string): { chars: number; words: number } {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return { chars: 0, words: 0 };
    const cjk = trimmed.match(CJK_RE)?.length ?? 0;
    // 先把 CJK 换成空格再按空白切，剩下的才是拉丁词，两边不会重复计数
    const latin = trimmed.replace(CJK_RE, ' ').split(/\s+/).filter(Boolean).length;
    return { chars: trimmed.replace(/\s/g, '').length, words: cjk + latin };
}

// ---------- 句首大写 ----------

/**
 * 把句首的小写字母改成大写：行首（跳过 `#` `-` `>` `1.` 这类 Markdown 前缀）
 * 以及 `.` `!` `?` 之后。
 *
 * **反引号里的内容一律不动** —— 代码是大小写敏感的，把 `useState` 改成
 * `UseState` 就从排版修饰变成了改坏代码。实现上按反引号切开，只处理
 * 偶数段（奇数段就是 code span 的内容）。围栏代码块和表格行整行跳过。
 *
 * 大小写替换不改变长度，所以调用方手里的选区偏移改完仍然有效。
 */
export function capitalizeSentenceStarts(text: string): { result: string; count: number } {
    let count = 0;
    let inFence = false;
    const upper = (prefix: string, ch: string) => {
        count++;
        return prefix + ch.toUpperCase();
    };

    const lines = (text ?? '').split('\n').map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            return line;
        }
        if (inFence || line.trimStart().startsWith('|')) return line;

        const parts = line.split('`');
        for (let i = 0; i < parts.length; i += 2) {
            parts[i] = parts[i].replace(/([.!?]["')\]]*\s+)([a-z])/g, (_, p: string, ch: string) => upper(p, ch));
        }
        // 行首那一个只可能落在第一段（反引号之前）
        parts[0] = parts[0].replace(
            /^(\s*(?:(?:#{1,6}|>+|[-*+]|\d+[.)])\s+)*)([a-z])/,
            (_, p: string, ch: string) => upper(p, ch),
        );
        return parts.join('`');
    });

    return { result: lines.join('\n'), count };
}

// ---------- 侧栏摘要 ----------

/** 列表里那一行灰字：把 Markdown 记号去掉，压成一行 */
export function getPreviewText(content: string, maxLen = 80): string {
    const plain = (content ?? '')
        .replace(/```[\s\S]*?```/g, ' ')          // 整块代码不进摘要，那是噪音
        .replace(/[#*`>[\]()!~|\\_-]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain;
}

// ---------- 日期分组 ----------

export type DateGroupKey = 'today' | 'yesterday' | 'thisWeek' | 'older';

export const DATE_GROUP_LABEL: Record<DateGroupKey, string> = {
    today: '今天',
    yesterday: '昨天',
    thisWeek: '本周',
    older: '更早',
};

const GROUP_ORDER: DateGroupKey[] = ['today', 'yesterday', 'thisWeek', 'older'];

/**
 * 两边都归零到**本地零点**再比。
 *
 * 直接拿完整时间戳去减，今天早上写的笔记会因为「还不满 24 小时」
 * 被算成昨天甚至本周 —— 人说的「今天」是日历日，不是滚动 24 小时。
 */
export function getDateGroup(dateStr: string, now: Date = new Date()): DateGroupKey {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return 'older';
    d.setHours(0, 0, 0, 0);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const days = Math.round((today.getTime() - d.getTime()) / 86_400_000);
    if (days <= 0) return 'today';           // 未来时间也归今天，总比单开一组强
    if (days === 1) return 'yesterday';
    if (days < 7) return 'thisWeek';
    return 'older';
}

/** 保持传入顺序，按组归拢；空组不出现 */
export function groupNotesByDate(
    notes: Note[],
    now: Date = new Date(),
): Array<{ key: DateGroupKey; notes: Note[] }> {
    const map = new Map<DateGroupKey, Note[]>();
    for (const n of notes) {
        const key = getDateGroup(n.updatedAt, now);
        const bucket = map.get(key);
        if (bucket) bucket.push(n);
        else map.set(key, [n]);
    }
    return GROUP_ORDER.filter((k) => map.has(k)).map((k) => ({ key: k, notes: map.get(k)! }));
}

// ---------- 搜索 ----------

/** 标题、正文、标签，三处任一命中即可。全在本地做，没有搜索接口。 */
export function matchesQuery(note: Note, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return note.title.toLowerCase().includes(q)
        || note.content.toLowerCase().includes(q)
        || note.tags.some((t) => t.includes(q));
}

// ---------- 工具栏插入 ----------

export type InsertKind = 'bold' | 'italic' | 'code' | 'link' | 'h2' | 'h3' | 'list' | 'quote' | 'table';

export interface InsertResult {
    /** 替换后的整段正文 */
    value: string;
    /** 插入后光标（或选区）的绝对位置 */
    selStart: number;
    selEnd: number;
}

/** 没选中东西时垫进去的占位词。插完就被选中，直接打字即可覆盖。 */
export const PLACEHOLDER: Record<Exclude<InsertKind, 'table'>, string> = {
    bold: '加粗',
    italic: '斜体',
    code: '代码',
    link: '链接文字',
    h2: '标题',
    h3: '标题',
    list: '列表项',
    quote: '引用',
};

/**
 * 算出插入之后的正文与光标位置。
 *
 * 关键在于：每种语法都**自己声明相对插入点的选区偏移**，最后统一加上
 * `start` 得到绝对位置。绝不能反过来「插完再去全文里搜占位词」——
 * 只要笔记前面任何地方出现过同一个词，搜到的就是那一个，光标当场跳走。
 * 这个 bug 只在特定内容下复现，测试里专门锁了一条。
 */
export function computeInsertion(
    content: string,
    start: number,
    end: number,
    kind: InsertKind,
): InsertResult {
    const before = content.slice(0, start);
    const selected = content.slice(start, end);
    const after = content.slice(end);
    const body = (k: Exclude<InsertKind, 'table'>) => selected || PLACEHOLDER[k];

    let inserted: string;
    let from: number;
    let to: number;

    switch (kind) {
        case 'bold': {
            const b = body('bold');
            inserted = `**${b}**`; from = 2; to = 2 + b.length; break;
        }
        case 'italic': {
            const b = body('italic');
            inserted = `_${b}_`; from = 1; to = 1 + b.length; break;
        }
        case 'code': {
            const b = body('code');
            inserted = `\`${b}\``; from = 1; to = 1 + b.length; break;
        }
        case 'link': {
            const b = body('link');
            // 选中 url 那一段：文字多半已经有了，要改的是地址
            inserted = `[${b}](url)`; from = b.length + 3; to = b.length + 6; break;
        }
        case 'h2': {
            const b = body('h2');
            inserted = `## ${b}`; from = 3; to = 3 + b.length; break;
        }
        case 'h3': {
            const b = body('h3');
            inserted = `### ${b}`; from = 4; to = 4 + b.length; break;
        }
        case 'list': {
            const b = body('list');
            inserted = `- ${b}`; from = 2; to = 2 + b.length; break;
        }
        case 'quote': {
            const b = body('quote');
            inserted = `> ${b}`; from = 2; to = 2 + b.length; break;
        }
        case 'table': {
            const row = '|  |  |';
            inserted = `| 列 1 | 列 2 |\n| --- | --- |\n${row}`;
            // 落进第三行第一格：整段末尾往回数到 row，再跳过开头的 "| "
            from = inserted.length - row.length + 2; to = from; break;
        }
    }

    return { value: before + inserted + after, selStart: start + from, selEnd: start + to };
}

// ---------- 本地草稿 ----------

export interface Draft {
    title: string;
    tags: string[];
    content: string;
}

const DRAFT_PREFIX = 'notes.draft.';

/**
 * sessionStorage 而不是 localStorage：草稿是**这一次浏览**的崩溃保险，
 * 不是持久化。真正的持久化只有一条路 —— 你自己按保存。
 *
 * 取不到（无痕模式、跑在 Node 里）就当没有草稿，功能照常用。
 */
function box(): Storage | null {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
}

export function loadDraft(id: number): Draft | null {
    try {
        const raw = box()?.getItem(DRAFT_PREFIX + id);
        if (!raw) return null;
        const d = JSON.parse(raw) as Partial<Draft>;
        return {
            title: String(d.title ?? ''),
            tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
            content: String(d.content ?? ''),
        };
    } catch {
        return null;
    }
}

export function saveDraft(id: number, draft: Draft): void {
    try {
        box()?.setItem(DRAFT_PREFIX + id, JSON.stringify(draft));
    } catch { /* 配额满了也不该打断打字 */ }
}

export function removeDraft(id: number): void {
    try {
        box()?.removeItem(DRAFT_PREFIX + id);
    } catch { /* ignore */ }
}

/**
 * 编辑器里的内容跟服务端那份是不是完全一样。
 *
 * 这个判断是本地草稿那一层的闸门，挡住两件事：
 *   · 选中一条笔记会把服务端内容灌进输入框，从而触发同一个 effect ——
 *     没有这道闸，**光是打开一条笔记就会生成草稿并标记为未保存**。
 *   · 改完又改回去（或者早期 bug 留下的幽灵草稿），下次判定为干净，
 *     草稿被顺手删掉 —— 自愈，不需要额外的清理逻辑。
 */
export function isClean(note: Note, local: Draft): boolean {
    return local.title === note.title
        && local.content === note.content
        && local.tags.length === note.tags.length
        && local.tags.every((t, i) => t === note.tags[i]);
}

/**
 * 打开一条笔记时编辑器该显示什么。
 *
 * **有草稿就用草稿**，没有才用服务端那份。点开别的笔记再点回来
 * 就丢掉没保存的修改 —— 这是用户唯一不会原谅的那种故障。
 */
export function openNote(note: Note): { draft: Draft; dirty: boolean } {
    const stored = loadDraft(note.id);
    if (stored) return { draft: stored, dirty: true };
    return { draft: { title: note.title, tags: note.tags, content: note.content }, dirty: false };
}

/**
 * 一次编辑（防抖之后）对本地草稿的处置，返回这条笔记现在脏不脏。
 *
 * 跟服务端那份一模一样 → 删掉草稿、判定为干净；否则写草稿、判定为脏。
 * 「一模一样也走这里」是关键：灌数据进输入框跟真的敲键盘会触发同一个
 * effect，没有这一支就会「一打开就变成未保存」。
 */
export function reconcileDraft(note: Note, local: Draft): boolean {
    if (isClean(note, local)) {
        removeDraft(note.id);
        return false;
    }
    saveDraft(note.id, local);
    return true;
}

/** 云端保存成功之后：本地草稿完成使命，删掉 */
export function afterCloudSave(id: number): void {
    removeDraft(id);
}

/** Ctrl+S / Cmd+S。存云端只有这一个触发源，加上界面上那颗保存按钮。 */
export function isSaveShortcut(e: { ctrlKey: boolean; metaKey: boolean; key: string }): boolean {
    return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
}

// ---------- 新建笔记的模板 ----------

export interface NoteTemplate {
    id: string;
    label: string;
    icon: string;
    body: (today: string) => string;
}

export const TEMPLATES: NoteTemplate[] = [
    { id: 'blank', label: '空白', icon: 'fa-file', body: () => '' },
    {
        id: 'meeting',
        label: '会议记录',
        icon: 'fa-users',
        body: (d) => `# 会议记录 · ${d}\n\n## 参与者\n- \n\n## 议题\n1. \n\n## 结论\n- \n\n## 待办\n- [ ] \n`,
    },
    {
        id: 'daily',
        label: '每日日志',
        icon: 'fa-calendar-day',
        body: (d) => `# ${d}\n\n## 今天做了什么\n- \n\n## 卡在哪里\n- \n\n## 明天第一件事\n- [ ] \n`,
    },
    {
        id: 'study',
        label: '学习笔记',
        icon: 'fa-book',
        body: () => '# 主题\n\n## 一句话概括\n\n## 关键点\n- \n\n## 我原本理解错的地方\n- \n\n## 参考\n- \n',
    },
    {
        id: 'snippet',
        label: '代码片段',
        icon: 'fa-code',
        body: () => '# 片段说明\n\n## 用在什么场景\n\n```ts\n\n```\n\n## 坑\n- \n',
    },
];

export function todayLabel(now: Date = new Date()): string {
    return `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
}
