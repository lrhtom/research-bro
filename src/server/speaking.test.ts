// ============================================================
//  英语口语场景练习的验收测试
//
//  大模型被替换成一个**读得懂提示词**的假模型：它按系统提示词里
//  有没有某段干扰片段来决定回什么。这样测的是「干扰项有没有真的拼进
//  提示词、有没有真的走到模型、结果有没有真的落库」这条链路，
//  而不是把 CI 绑在某个供应商的可用性和当天的心情上。
//
//  覆盖需求点名的九条，外加几条同样容易做错的。
// ============================================================

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── 假模型 ────────────────────────────────────────────────────────
// 必须在 import 被测模块之前 mock，vi.mock 会被提升到文件顶部。

const llmCalls: Array<{ system: string; user: string }> = [];
/** 测试里塞进来的下一次回复；不塞就走默认的「读提示词决定说什么」 */
let nextReply: string | null = null;
/** 报告调用返回的 JSON（字符串） */
let nextReportJson: string | null = null;

function fakeAnswer(system: string): string {
    // 报告调用：认得出来是因为它的系统提示词里有那道硬边界
    if (system.includes('WHAT YOU CAN AND CANNOT SEE')) {
        return nextReportJson ?? JSON.stringify({
            summary: '你把事情办成了。',
            taskAchievement: { verdict: 'achieved', comment: '问清了押金。', quote: 'how much is the deposit' },
            vocabulary: [],
            grammar: [],
            turnTaking: { comment: '你会追问。', quote: 'how much is the deposit' },
            nextSteps: ['下次试着先寒暄一句再进正题。'],
        });
    }
    if (nextReply !== null) {
        const r = nextReply;
        nextReply = null;
        return r;
    }
    // 角色扮演：看提示词里有没有 Scouse 那一段，决定说方言还是标准英语。
    // 真模型是自己读提示词做这件事的；这里把它固定下来，测的是链路。
    if (system.includes("Liverpool 'Scouse'")) {
        return "Ay up la, that's proper sound, innit — ta for that.";
    }
    return 'That sounds good. Could you tell me a little more about it?';
}

vi.mock('./llm.js', async () => {
    const actual = await vi.importActual<typeof import('./llm.js')>('./llm.js');
    return {
        ...actual,
        llmConfigured: () => true,
        llmStatus: () => ({ configured: true, model: 'fake', baseUrl: 'fake' }),
        chat: async (messages: Array<{ role: string; content: string }>) => {
            const system = messages.find((m) => m.role === 'system')?.content ?? '';
            const user = messages.filter((m) => m.role === 'user').pop()?.content ?? '';
            llmCalls.push({ system, user });
            return fakeAnswer(system);
        },
        // eslint-disable-next-line require-yield
        chatStream: async function* (messages: Array<{ role: string; content: string }>) {
            const system = messages.find((m) => m.role === 'system')?.content ?? '';
            const user = messages.filter((m) => m.role === 'user').pop()?.content ?? '';
            llmCalls.push({ system, user });
            // 一小片一小片吐，跟真的流式一样
            for (const piece of fakeAnswer(system).match(/.{1,12}/g) ?? []) yield piece;
        },
    };
});

import { initSchema, useDatabase } from './db.js';
import {
    addTurn, createSession, generateReport, getSessionFull, listSessions, listTurns,
    sanitizeReport, unusedTargetWords, __internals,
} from './speaking.js';
import { interferenceBlock, openingPrompt, reportPrompt, turnPrompt, transcriptForReport } from './speaking-prompts.js';
import { normalizeModifiers, parseTargetWords, tallyTargetWords } from '../shared/speaking.js';

let conn: Database.Database;

beforeEach(() => {
    conn = new Database(':memory:');
    initSchema(conn);
    useDatabase(conn);
    llmCalls.length = 0;
    nextReply = null;
    nextReportJson = null;
});

afterEach(() => {
    conn.close();
});

const SCENARIO = 'The learner is viewing a flat. You are the landlord.';

// ------------------------------------------------------------

describe('干扰项：一个都没开', () => {
    it('拼出来的系统提示词里没有干扰段', () => {
        expect(interferenceBlock({})).toBe('');
        expect(interferenceBlock([])).toBe('');
        expect(interferenceBlock(null)).toBe('');

        const prompt = turnPrompt(SCENARIO, {}, []);
        expect(prompt).not.toContain('REALISM MODIFIERS');
        expect(prompt).not.toContain('ACCENT:');
        expect(prompt).not.toContain('BACKGROUND NOISE');
        expect(prompt).not.toContain('SMALL TALK');
    });

    it('走完一整轮，回的是标准英语', async () => {
        const s = createSession({ scenario: SCENARIO, modifiers: {} });
        addTurn(s.id, 'assistant', 'Come in, have a look round.', 'ai');
        addTurn(s.id, 'user', 'How much is the deposit?', 'typed');

        // 直接调提示词 + 假模型，跟路由那一层走的是同一条链路
        const { chatStream } = await import('./llm.js');
        let out = '';
        for await (const p of chatStream([
            { role: 'system', content: turnPrompt(s.scenario, s.modifiers, s.targetWords) },
            { role: 'user', content: 'How much is the deposit?' },
        ])) out += p;

        expect(llmCalls[0].system).not.toContain('REALISM MODIFIERS');
        expect(out).toBe('That sounds good. Could you tell me a little more about it?');
        // 没有方言标记
        expect(out).not.toMatch(/\b(ay up|la|innit|ta|proper)\b/i);
    });
});

describe('干扰项：口音 + Scouse', () => {
    it('提示词里带上了 Scouse 那一段', () => {
        const block = interferenceBlock({ accent: ['scouse'] });
        expect(block).toContain('REALISM MODIFIERS');
        expect(block).toContain('ACCENT:');
        expect(block).toContain("Liverpool 'Scouse'");
        // 基础片段也要在
        expect(block).toContain('strong REGIONAL accent');
        expect(block).toContain('NOT BBC Received');
    });

    it('多选子选项时按顺序拼在同一条 Specifically 里', () => {
        const block = interferenceBlock({ accent: ['scouse', 'geordie'] });
        expect(block).toContain("Specifically: Liverpool 'Scouse'; Newcastle 'Geordie'.");
    });

    it('开了开关但没选子选项时，只有基础片段、没有 Specifically', () => {
        const block = interferenceBlock({ accent: [] });
        expect(block).toContain('ACCENT:');
        expect(block).not.toContain('Specifically');
        expect(block.trimEnd()).toMatch(/understandable\.$/);
    });

    it('回复带上了方言标记', async () => {
        const s = createSession({ scenario: SCENARIO, modifiers: { accent: ['scouse'] } });
        const { chatStream } = await import('./llm.js');
        let out = '';
        for await (const p of chatStream([
            { role: 'system', content: turnPrompt(s.scenario, s.modifiers, s.targetWords) },
            { role: 'user', content: 'Is it available now?' },
        ])) out += p;

        expect(llmCalls[0].system).toContain("Liverpool 'Scouse'");
        expect(out).toMatch(/\b(ay up|innit|ta|proper)\b/i);
    });

    it('五个开关全开，五段全在，且顺序固定', () => {
        const block = interferenceBlock({
            smalltalk: [], noise: ['pub'], accent: ['cockney'],
            audioquality: ['radio'], crosstalk: ['fast'],
        });
        const order = ['ACCENT:', 'PACE & INTERRUPTIONS:', 'BACKGROUND NOISE:', 'AUDIO QUALITY:', 'SMALL TALK:']
            .map((k) => block.indexOf(k));
        expect(order.every((i) => i >= 0)).toBe(true);
        // 无论传进来的键什么顺序，拼出来永远按 INTERFERENCE_KEYS 的固定顺序
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
});

describe('normalizeModifiers 两种输入都认', () => {
    it('新版对象形式', () => {
        expect(normalizeModifiers({ accent: ['scouse'], noise: ['pub'] }))
            .toEqual({ accent: ['scouse'], noise: ['pub'] });
    });

    it('旧版数组形式：等价于每个开关都没选子选项', () => {
        expect(normalizeModifiers(['accent', 'noise']))
            .toEqual({ accent: [], noise: [] });
    });

    it('两种形式拼出来的提示词，在「开了哪些开关」上一致', () => {
        const fromList = interferenceBlock(['accent', 'noise']);
        const fromDict = interferenceBlock({ accent: [], noise: [] });
        expect(fromList).toBe(fromDict);
        expect(fromList).toContain('ACCENT:');
        expect(fromList).toContain('BACKGROUND NOISE:');
    });

    it('白名单之外的开关与子选项一律丢掉', () => {
        expect(normalizeModifiers({
            accent: ['scouse', 'martian', 'scouse'],   // 非法 + 重复
            hacking: ['whatever'],                      // 非法开关
            noise: 'not-an-array' as never,             // 类型不对
        })).toEqual({ accent: ['scouse'], noise: [] });
    });

    it('乱七八糟的输入不会崩', () => {
        expect(normalizeModifiers(null)).toEqual({});
        expect(normalizeModifiers(undefined)).toEqual({});
        expect(normalizeModifiers('accent' as never)).toEqual({});
        expect(normalizeModifiers(42 as never)).toEqual({});
    });
});

describe('打字模式能完整走完一整场并出报告', () => {
    it('全程 typed，报告照常生成', async () => {
        const s = createSession({
            scenario: SCENARIO,
            label: '看房',
            modifiers: { noise: ['pub'] },
            targetWords: 'deposit 押金\nviewing 看房',
        });

        addTurn(s.id, 'assistant', 'Come in. What do you think of it?', 'ai');
        addTurn(s.id, 'user', 'How much is the deposit for this flat?', 'typed');
        addTurn(s.id, 'assistant', "It's five weeks' rent.", 'ai');
        addTurn(s.id, 'user', 'Are the bills included in the rent?', 'typed');

        const report = await generateReport(s.id);

        expect(report.empty).toBe(false);
        expect(report.summary).toBeTruthy();
        expect(report.taskAchievement.verdict).toBe('achieved');

        // 报告落库了，会话也标成结束
        const full = getSessionFull(s.id)!;
        expect(full.status).toBe('finished');
        expect(full.report).not.toBeNull();
        expect(full.turns.filter((t) => t.role === 'user').every((t) => t.source === 'typed')).toBe(true);

        // 喂给模型的转录稿标出了每一句的来源
        const reportCall = llmCalls.find((c) => c.system.includes('WHAT YOU CAN AND CANNOT SEE'))!;
        expect(reportCall.user).toContain('LEARNER [typed]:');
        expect(reportCall.user).not.toContain('[speech-to-text]');
    });

    it('语音那一路会被标成 speech-to-text，好让模型知道字是猜的', async () => {
        const s = createSession({ scenario: SCENARIO });
        addTurn(s.id, 'assistant', 'Hello.', 'ai');
        addTurn(s.id, 'user', 'How much is the deposit?', 'speech');

        await generateReport(s.id);
        const call = llmCalls.find((c) => c.system.includes('WHAT YOU CAN AND CANNOT SEE'))!;
        expect(call.user).toContain('LEARNER [speech-to-text]:');
    });
});

describe('报告的硬边界：模型没听过声音，就不许说声音的事', () => {
    /** 造一段有真实原话的对话 */
    function conversation() {
        const s = createSession({ scenario: SCENARIO });
        addTurn(s.id, 'assistant', 'Come in.', 'ai');
        addTurn(s.id, 'user', 'How much is the deposit for this flat?', 'speech');
        addTurn(s.id, 'assistant', 'Five weeks.', 'ai');
        addTurn(s.id, 'user', 'I want to know if the bills are included.', 'typed');
        return s;
    }

    it('提示词里三处都禁了发音 / 语调 / 语速 / 总分', () => {
        const p = reportPrompt();
        expect(p).toContain('NEVER HEARD THIS PERSON');
        expect(p).toContain('pronunciation scores');
        expect(p).toContain('intonation');
        expect(p).toContain('words per minute');
        expect(p).toContain('band score');
    });

    it('模型硬要给发音分，服务端把这些条目全删掉', async () => {
        const s = conversation();
        nextReportJson = JSON.stringify({
            summary: '你的发音有点问题，语调偏平。',
            taskAchievement: {
                verdict: 'partial',
                comment: '语速大约每分钟 95 词，偏慢。',
                quote: 'How much is the deposit for this flat?',
            },
            vocabulary: [
                {
                    quote: 'How much is the deposit for this flat?',
                    suggestion: 'What sort of deposit are you asking for?',
                    why: '更自然的问法',
                },
                {
                    quote: 'I want to know if the bills are included.',
                    suggestion: 'Are the bills included?',
                    why: 'deposit 这个词你的发音不准，重音位置错了',   // ← 该被删
                },
            ],
            grammar: [
                {
                    quote: 'How much is the deposit for this flat?',
                    fix: 'How much is the deposit on this flat?',
                    why: '介词搭配',
                },
            ],
            turnTaking: { comment: '你的语调听起来很犹豫。', quote: 'I want to know if the bills are included.' },
            nextSteps: ['多练连读和重音', '下次主动追问一句'],   // 第一条该被删
        });

        const report = await generateReport(s.id);
        const allText = JSON.stringify(report);

        // 一条发音 / 语调 / 语速 / 总分类的断言都不许留下
        expect(allText).not.toMatch(/发音|语调|重音|每分钟|语速|连读/);
        expect(allText).not.toMatch(/pronunciation|intonation|wpm|words per minute/i);

        // 违规的条目被删了，干净的留了下来
        expect(report.vocabulary).toHaveLength(1);
        expect(report.vocabulary[0].suggestion).toBe('What sort of deposit are you asking for?');
        expect(report.grammar).toHaveLength(1);
        expect(report.nextSteps).toEqual(['下次主动追问一句']);
        expect(report.droppedPoints).toBeGreaterThan(0);
    });

    it('每一条都必须引得出学习者的原话，编的引文一律删掉', async () => {
        const s = conversation();
        nextReportJson = JSON.stringify({
            summary: '整体不错。',
            taskAchievement: { verdict: 'achieved', comment: '问清楚了。', quote: 'How much is the deposit for this flat?' },
            vocabulary: [
                { quote: 'How much is the deposit for this flat?', suggestion: 'better', why: '真的' },
                { quote: 'I would like to enquire about the tenancy terms', suggestion: 'x', why: '这句他没说过' },
                { quote: 'Come in.', suggestion: 'y', why: '这是对方说的，不是他说的' },
                { quote: 'ok', suggestion: 'z', why: '太短，等于没有出处' },
            ],
            grammar: [],
            turnTaking: { comment: '还行。', quote: '这句也是编的引文' },
            nextSteps: [],
        });

        const report = await generateReport(s.id);
        const userLines = listTurns(s.id).filter((t) => t.role === 'user').map((t) => t.content);

        // 留下来的每一条，引文都能在学习者的原话里找到
        expect(report.vocabulary).toHaveLength(1);
        for (const p of [...report.vocabulary, ...report.grammar]) {
            expect(userLines.some((l) => l.toLowerCase().includes(p.quote.toLowerCase()))).toBe(true);
        }
        // 对不上的引文位置留空，而不是挂一句他没说过的话；
        // 但这一条点评本身（comment）没问题，所以不算「删掉一条」
        expect(report.turnTaking.quote).toBe('');
        expect(report.turnTaking.comment).toBe('还行。');
        expect(report.taskAchievement.quote).toBe('How much is the deposit for this flat?');
        expect(report.droppedPoints).toBe(3);   // 三条引文对不上的词汇条目
    });

    it('引用片段可以是原话的一部分，但不能是别人的话', () => {
        const s = createSession({ scenario: SCENARIO });
        addTurn(s.id, 'user', 'How much is the deposit for this flat?', 'typed');
        const turns = listTurns(s.id);
        const learner = turns.filter((t) => t.role === 'user')
            .map((t) => __internals.normalizeForQuote(t.content));

        expect(__internals.quoteIsFromLearner('how much is the deposit', learner)).toBe(true);
        expect(__internals.quoteIsFromLearner('How much is the DEPOSIT!', learner)).toBe(true);   // 大小写标点不计较
        expect(__internals.quoteIsFromLearner('the rent is due monthly', learner)).toBe(false);
        expect(__internals.quoteIsFromLearner('how much', learner)).toBe(false);                  // 太短
    });
});

describe('一句话都没说的场次', () => {
    it('给空状态，而不是一份编出来的评价', async () => {
        const s = createSession({ scenario: SCENARIO, targetWords: 'deposit 押金' });
        addTurn(s.id, 'assistant', 'Come in, have a look round.', 'ai');
        // 学习者一句都没说

        const report = await generateReport(s.id);

        expect(report.empty).toBe(true);
        expect(report.vocabulary).toEqual([]);
        expect(report.grammar).toEqual([]);
        expect(report.taskAchievement.verdict).toBe('not-achieved');
        expect(report.taskAchievement.quote).toBe('');
        expect(report.turnTaking.quote).toBe('');

        // 连模型都不该被调 —— 没有转录稿，任何评价都是编的
        expect(llmCalls.filter((c) => c.system.includes('WHAT YOU CAN AND CANNOT SEE'))).toHaveLength(0);

        // 目标词照常列出来，全部标成没用上
        expect(report.targetWords).toHaveLength(1);
        expect(report.targetWords[0].used).toBe(false);
    });
});

describe('目标词', () => {
    it('没用过的就是没用过 —— 不问模型，从原话里数', async () => {
        const s = createSession({
            scenario: SCENARIO,
            targetWords: 'deposit 押金\ntenancy 租约\nviewing 看房',
        });
        addTurn(s.id, 'assistant', 'The deposit is five weeks and the tenancy is twelve months.', 'ai');
        addTurn(s.id, 'user', 'How much is the deposit for this flat?', 'typed');

        // 模型硬说三个词都用上了
        nextReportJson = JSON.stringify({
            summary: '很好。',
            taskAchievement: { verdict: 'achieved', comment: '好', quote: 'How much is the deposit for this flat?' },
            vocabulary: [], grammar: [],
            turnTaking: { comment: '好', quote: 'How much is the deposit for this flat?' },
            nextSteps: [],
            targetWords: [
                { en: 'deposit', used: true }, { en: 'tenancy', used: true }, { en: 'viewing', used: true },
            ],
        });

        const report = await generateReport(s.id);
        const by = Object.fromEntries(report.targetWords.map((w) => [w.en, w]));

        expect(by.deposit.used).toBe(true);
        expect(by.deposit.count).toBe(1);
        // AI 说过 tenancy，但学习者没说 —— 必须算没用上
        expect(by.tenancy.used).toBe(false);
        expect(by.tenancy.count).toBe(0);
        expect(by.viewing.used).toBe(false);
    });

    it('只数学习者的话，AI 说了多少次都不算', () => {
        const words = parseTargetWords('deposit 押金');
        expect(tallyTargetWords(words, ['I paid the deposit'])[0].count).toBe(1);
        expect(tallyTargetWords(words, [])[0].count).toBe(0);
    });

    it('词边界要对：deposits / depositing 不算 deposit', () => {
        const words = parseTargetWords('deposit');
        expect(tallyTargetWords(words, ['deposits and depositing'])[0].count).toBe(0);
        expect(tallyTargetWords(words, ['a deposit, please'])[0].count).toBe(1);
    });

    it('带正则元字符的目标词不会把匹配搞崩', () => {
        const words = parseTargetWords('run');
        expect(() => tallyTargetWords(words, ['run (away)'])).not.toThrow();
        expect(tallyTargetWords(words, ['I run every day'])[0].count).toBe(1);
    });

    it('快收尾时，还没用过的词会被拿去引导话题', () => {
        const s = createSession({ scenario: SCENARIO, targetWords: 'deposit 押金\ntenancy 租约' });
        addTurn(s.id, 'user', 'How much is the deposit?', 'typed');
        expect(unusedTargetWords(s, listTurns(s.id))).toEqual(['tenancy']);
    });
});

describe('对话与设置一起存', () => {
    it('干扰项设置跟着这场对话一起落库、原样读得回来', () => {
        const s = createSession({
            scenario: SCENARIO,
            label: '看房',
            modifiers: { accent: ['scouse'], noise: ['pub', 'street'], smalltalk: [] },
            targetWords: 'deposit 押金',
        });
        addTurn(s.id, 'assistant', 'Ay up.', 'ai');
        addTurn(s.id, 'user', 'Hello there.', 'speech');

        const full = getSessionFull(s.id)!;
        expect(full.modifiers).toEqual({ accent: ['scouse'], noise: ['pub', 'street'], smalltalk: [] });
        expect(full.targetWords).toEqual([{ en: 'deposit', zh: '押金' }]);
        expect(full.turns.map((t) => t.source)).toEqual(['ai', 'speech']);
        // 列表页也带着设置，否则历史记录读不懂
        expect(listSessions()[0].modifiers).toEqual(full.modifiers);
    });

    it('入库前就归一化：客户端塞非法子选项进不来', () => {
        const s = createSession({
            scenario: SCENARIO,
            modifiers: { accent: ['scouse', 'klingon'], nonsense: ['x'] } as never,
        });
        expect(getSessionFull(s.id)!.modifiers).toEqual({ accent: ['scouse'] });
    });

    it('每一轮当场落库，中途关掉页面不丢', () => {
        const s = createSession({ scenario: SCENARIO });
        addTurn(s.id, 'assistant', 'Hello.', 'ai');
        addTurn(s.id, 'user', 'Hi there.', 'speech');

        // 换个连接重新读（相当于刷新页面重新问服务端）
        const again = getSessionFull(s.id)!;
        expect(again.turns).toHaveLength(2);
        expect(again.turns[1].content).toBe('Hi there.');
        expect(again.turns.map((t) => t.seq)).toEqual([1, 2]);
    });
});

describe('提示词的其它约束', () => {
    it('每一轮都禁止纠错、禁止出戏、禁止换语言', () => {
        const p = turnPrompt(SCENARIO, {}, []);
        expect(p).toContain('Stay in character at all times');
        expect(p).toContain('never mention being an AI');
        expect(p).toContain('English only');
        expect(p).toContain('NEVER correct');
        expect(p).toContain('1-3 sentences');
    });

    it('目标词只制造机会，不许念清单', () => {
        const p = turnPrompt(SCENARIO, {}, [{ en: 'deposit', zh: '押金' }]);
        expect(p).toContain('TARGET VOCABULARY: [deposit]');
        expect(p).toContain('NEVER list them');
        expect(p).toContain('never announce them');
    });

    it('没有目标词时整段不出现', () => {
        expect(turnPrompt(SCENARIO, {}, [])).not.toContain('TARGET VOCABULARY');
    });

    it('开场白也带着干扰项', () => {
        const p = openingPrompt(SCENARIO, { accent: ['geordie'] }, []);
        expect(p).toContain("Newcastle 'Geordie'");
        expect(p).toContain('1-3 sentences');
    });

    it('转录稿里对方的话不会被标成学习者的话', () => {
        const t = transcriptForReport(SCENARIO, [
            { role: 'assistant', content: 'Come in.', source: 'ai' },
            { role: 'user', content: 'Thanks.', source: 'typed' },
        ]);
        expect(t).toContain('OTHER CHARACTER: Come in.');
        expect(t).toContain('LEARNER [typed]: Thanks.');
        expect(t).not.toContain('LEARNER [typed]: Come in.');
    });
});

describe('sanitizeReport 直接测', () => {
    it('模型返回垃圾时也给得出一份结构完整的报告', () => {
        const s = createSession({ scenario: SCENARIO });
        addTurn(s.id, 'user', 'How much is the deposit for this flat?', 'typed');
        const turns = listTurns(s.id);

        const r = sanitizeReport(null, s, turns);
        expect(r.empty).toBe(false);
        expect(r.vocabulary).toEqual([]);
        expect(r.grammar).toEqual([]);
        expect(r.taskAchievement.verdict).toBe('partial');   // 非法 verdict 退回 partial
        expect(Array.isArray(r.nextSteps)).toBe(true);
    });

    it('识别出各种说法的发音类断言', () => {
        const bad = [
            '你的发音需要加强', 'pronunciation needs work', '语调偏平', 'flat intonation',
            '语速大约每分钟 120 词', '110 wpm', '总分 6.5', 'overall band 6.5',
            '你的口音很重', 'listen to your accent', '听起来很结巴',
        ];
        for (const t of bad) expect(__internals.hasBannedClaim(t)).toBe(true);

        // 这些是文本层面的判断，不该被误杀
        const ok = [
            '你的句子结构比较简单', '词汇量还可以再扩展', '你没有反问对方',
            'try asking a question back', '时态用错了', '表达可以更地道',
        ];
        for (const t of ok) expect(__internals.hasBannedClaim(t)).toBe(false);
    });
});
