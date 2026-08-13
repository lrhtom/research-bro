// ============================================================
//  记事本逻辑的测试
//
//  盯的是四类「错了也不报错、只是安静地给出坏结果」的地方：
//    · 本地草稿的脏判定 —— 错了会让人以为存过了，或者以为没存过
//    · 工具栏插入的光标落点 —— 错了会跳到文档里另一个同名词上
//    · 句首大写 —— 错了会改坏反引号里的代码
//    · 中文字数与日期分组 —— 错了不会有任何报错，只是数字不对
// ============================================================

import { beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '../../shared/types';
import {
    PLACEHOLDER,
    afterCloudSave,
    capitalizeSentenceStarts,
    computeInsertion,
    getDateGroup,
    getWordCount,
    groupNotesByDate,
    isSaveShortcut,
    loadDraft,
    openNote,
    reconcileDraft,
} from './notes';

// ---------- 替身 ----------

/** Node 环境没有 sessionStorage，给一个够用的内存版 */
class MemoryStorage implements Storage {
    private map = new Map<string, string>();
    get length() { return this.map.size; }
    clear() { this.map.clear(); }
    getItem(k: string) { return this.map.get(k) ?? null; }
    key(i: number) { return [...this.map.keys()][i] ?? null; }
    removeItem(k: string) { this.map.delete(k); }
    setItem(k: string, v: string) { this.map.set(k, v); }
}

function makeNote(over: Partial<Note> = {}): Note {
    return {
        id: 1,
        title: '服务端标题',
        tags: ['go', 'net'],
        content: '服务端正文',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over,
    };
}

beforeEach(() => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = new MemoryStorage();
});

// ---------- 本地草稿 ----------

describe('本地草稿', () => {
    it('打开一条笔记不产生草稿，也不标记为未保存', () => {
        const note = makeNote();
        const { draft, dirty } = openNote(note);
        expect(dirty).toBe(false);

        // 灌数据进输入框会触发跟真打字同一个 effect，这一步必须判定为干净
        expect(reconcileDraft(note, draft)).toBe(false);
        expect(loadDraft(note.id)).toBeNull();
    });

    it('改了又改回去，草稿被删掉、未保存标记也清掉', () => {
        const note = makeNote();

        const edited = { title: note.title, tags: note.tags, content: '改了一句' };
        expect(reconcileDraft(note, edited)).toBe(true);
        expect(loadDraft(note.id)?.content).toBe('改了一句');

        const reverted = { title: note.title, tags: note.tags, content: note.content };
        expect(reconcileDraft(note, reverted)).toBe(false);
        expect(loadDraft(note.id)).toBeNull();
    });

    it('标签顺序不同也算改过（数组是有序的，渲染出来就是不一样）', () => {
        const note = makeNote({ tags: ['a', 'b'] });
        expect(reconcileDraft(note, { title: note.title, content: note.content, tags: ['b', 'a'] })).toBe(true);
    });

    it('有草稿时打开，拿到的是草稿而不是服务端那份', () => {
        const note = makeNote();
        reconcileDraft(note, { title: '写了一半', tags: ['go'], content: '还没保存的正文' });

        const { draft, dirty } = openNote(note);
        expect(dirty).toBe(true);
        expect(draft.title).toBe('写了一半');
        expect(draft.content).toBe('还没保存的正文');
        expect(draft.content).not.toBe(note.content);
    });

    it('Ctrl/Cmd-S 认得出来，存云端之后草稿被清掉', () => {
        expect(isSaveShortcut({ ctrlKey: true, metaKey: false, key: 's' })).toBe(true);
        expect(isSaveShortcut({ ctrlKey: false, metaKey: true, key: 'S' })).toBe(true);
        expect(isSaveShortcut({ ctrlKey: false, metaKey: false, key: 's' })).toBe(false);
        expect(isSaveShortcut({ ctrlKey: true, metaKey: false, key: 'a' })).toBe(false);

        const note = makeNote();
        reconcileDraft(note, { title: note.title, tags: note.tags, content: '未保存' });
        expect(loadDraft(note.id)).not.toBeNull();

        afterCloudSave(note.id);
        expect(loadDraft(note.id)).toBeNull();
    });

    it('存坏的草稿当作没有，不把整页拖垮', () => {
        globalThis.sessionStorage.setItem('notes.draft.1', '{ 这不是 JSON');
        expect(loadDraft(1)).toBeNull();
    });
});

// ---------- 工具栏 ----------

describe('工具栏插入', () => {
    it('没选中东西时，光标正好落在占位词上', () => {
        const r = computeInsertion('', 0, 0, 'bold');
        expect(r.value).toBe(`**${PLACEHOLDER.bold}**`);
        expect(r.value.slice(r.selStart, r.selEnd)).toBe(PLACEHOLDER.bold);
    });

    it('占位词在文档前面出现过，光标仍然落在新插入的那一个上', () => {
        // 这条锁的是 indexOf 定位法的老 bug：全文搜占位词会搜到前面那一个
        const prefix = `${PLACEHOLDER.bold}这两个字前面就有\n`;
        const content = prefix;
        const caret = content.length;

        const r = computeInsertion(content, caret, caret, 'bold');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe(PLACEHOLDER.bold);
        // 关键：选中的是插到末尾的那一个，不是开头那一个
        expect(r.selStart).toBeGreaterThan(prefix.length);
        expect(r.selStart).toBe(caret + 2);
    });

    it('有选中内容时，包住选区并保持它被选中', () => {
        const content = '前面 关键词 后面';
        const start = content.indexOf('关键词');
        const r = computeInsertion(content, start, start + 3, 'italic');
        expect(r.value).toBe('前面 _关键词_ 后面');
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('关键词');
    });

    it('链接插入后选中的是 url 那一段，不是文字', () => {
        const r = computeInsertion('', 0, 0, 'link');
        expect(r.value).toBe(`[${PLACEHOLDER.link}](url)`);
        expect(r.value.slice(r.selStart, r.selEnd)).toBe('url');
    });

    it('表格插入后光标停在第一个数据格里', () => {
        const r = computeInsertion('', 0, 0, 'table');
        expect(r.value.split('\n')).toHaveLength(3);
        expect(r.selStart).toBe(r.selEnd);
        // 落点前面刚好是最后一行的 "| "
        expect(r.value.slice(r.selStart - 2, r.selStart)).toBe('| ');
    });

    it('插入点不在开头时，返回的偏移是绝对位置', () => {
        const content = '开头一段\n';
        const r = computeInsertion(content, content.length, content.length, 'h2');
        expect(r.value).toBe(`开头一段\n## ${PLACEHOLDER.h2}`);
        expect(r.value.slice(r.selStart, r.selEnd)).toBe(PLACEHOLDER.h2);
    });
});

// ---------- 句首大写 ----------

describe('句首大写', () => {
    it('行首和 . ! ? 之后的小写字母被抬成大写', () => {
        const { result, count } = capitalizeSentenceStarts('hello world. this is fine! ok? yes');
        expect(result).toBe('Hello world. This is fine! Ok? Yes');
        expect(count).toBe(4);
    });

    it('反引号里的内容一个字母都不动', () => {
        const { result, count } = capitalizeSentenceStarts('use `useState` here. `map` stays.');
        expect(result).toBe('Use `useState` here. `map` stays.');
        expect(result).toContain('`useState`');
        expect(result).not.toContain('UseState');
        expect(result).toContain('`map`');
        expect(count).toBe(1);
    });

    it('围栏代码块整块跳过', () => {
        const src = 'intro text\n\n```ts\nconst x = 1;\nlet y = 2;\n```\n\nafter text';
        const { result } = capitalizeSentenceStarts(src);
        expect(result).toContain('const x = 1;');
        expect(result).toContain('let y = 2;');
        expect(result.startsWith('Intro text')).toBe(true);
        expect(result.endsWith('After text')).toBe(true);
    });

    it('Markdown 前缀之后的那个字母才是行首', () => {
        expect(capitalizeSentenceStarts('- item one').result).toBe('- Item one');
        expect(capitalizeSentenceStarts('## heading').result).toBe('## Heading');
        expect(capitalizeSentenceStarts('> quoted line').result).toBe('> Quoted line');
    });

    it('表格行不动（`---` 与单元格内容都不该被当句子）', () => {
        const src = '| col a | col b |\n| --- | --- |\n| one | two |';
        expect(capitalizeSentenceStarts(src).result).toBe(src);
    });

    it('没有可改的地方时 count 为 0（界面据此提示「没有需要改的」）', () => {
        expect(capitalizeSentenceStarts('Already Fine. All Good.').count).toBe(0);
    });

    it('改写不改变长度，调用方的选区偏移仍然有效', () => {
        const src = 'one. two. three';
        expect(capitalizeSentenceStarts(src).result).toHaveLength(src.length);
    });
});

// ---------- 字数 ----------

describe('字数统计', () => {
    it('中文按字算', () => {
        expect(getWordCount('你好世界').words).toBe(4);
    });

    it('英文按空白切词', () => {
        expect(getWordCount('hello world').words).toBe(2);
    });

    it('中英混排是两者之和', () => {
        expect(getWordCount('你好世界 hello world').words).toBe(4 + 2);
        expect(getWordCount('这是一个 test').words).toBe(4 + 1);
    });

    it('日文假名与谚文同样按字算', () => {
        expect(getWordCount('こんにちは').words).toBe(5);
        expect(getWordCount('안녕하세요').words).toBe(5);
    });

    it('空白与空串是 0', () => {
        expect(getWordCount('').words).toBe(0);
        expect(getWordCount('   \n  ').words).toBe(0);
    });

    it('字符数不含空白', () => {
        expect(getWordCount('a b\nc').chars).toBe(3);
    });
});

// ---------- 日期分组 ----------

describe('日期分组', () => {
    const now = new Date('2026-08-11T09:00:00');

    it('今天写的归今天，不会因为「还不满 24 小时」被算成本周', () => {
        // 今天凌晨 00:30 —— 按滚动 24 小时算会落到「昨天/本周」，按日历日才是今天
        expect(getDateGroup('2026-08-11T00:30:00', now)).toBe('today');
        expect(getDateGroup('2026-08-11T08:59:00', now)).toBe('today');
    });

    it('昨天、本周、更早各归各的', () => {
        expect(getDateGroup('2026-08-10T23:00:00', now)).toBe('yesterday');
        expect(getDateGroup('2026-08-07T12:00:00', now)).toBe('thisWeek');
        expect(getDateGroup('2026-08-04T12:00:00', now)).toBe('older');
    });

    it('分组保持传入顺序，空组不出现', () => {
        const notes = [
            makeNote({ id: 1, updatedAt: '2026-08-11T08:00:00' }),
            makeNote({ id: 2, updatedAt: '2026-08-11T07:00:00' }),
            makeNote({ id: 3, updatedAt: '2026-07-01T07:00:00' }),
        ];
        const groups = groupNotesByDate(notes, now);
        expect(groups.map((g) => g.key)).toEqual(['today', 'older']);
        expect(groups[0].notes.map((n) => n.id)).toEqual([1, 2]);
    });

    it('时间戳坏掉不抛异常，落到「更早」', () => {
        expect(getDateGroup('不是时间', now)).toBe('older');
    });
});
