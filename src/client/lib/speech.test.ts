// ============================================================
//  声音挑选的测试
//
//  要守住的一条：**默认必须挑到这台机器上最好听的那把**。
//  getVoices() 给回来的顺序常常正好把最难听的老式 SAPI 声音排在最前，
//  直接取 [0] 就会让整个练习都是机器音 —— 而这个功能是练听力的。
//
//  Edge 的 “Microsoft … Online (Natural)” 是免费能拿到的最好的一档，
//  英式的 Sonia / Ryan 正对本功能的英国生活场景，必须排到最前面。
// ============================================================

import { describe, expect, it, vi } from 'vitest';

// 造 voice 替身；listEnglishVoices 只读 name / lang / localService
function v(name: string, lang: string, localService = true): SpeechSynthesisVoice {
    return { name, lang, localService, default: false, voiceURI: name } as SpeechSynthesisVoice;
}

/** 一台典型的 Windows + Edge 机器会报出来的列表，顺序照抄系统给的（最差的在最前） */
const WINDOWS_EDGE = [
    v('Microsoft David - English (United States)', 'en-US'),
    v('Microsoft Mark - English (United States)', 'en-US'),
    v('Microsoft Zira - English (United States)', 'en-US'),
    v('Microsoft Hazel - English (United Kingdom)', 'en-GB'),
    v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', false),
    v('Microsoft Guy Online (Natural) - English (United States)', 'en-US', false),
    v('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB', false),
    v('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB', false),
    v('Microsoft Thomas Online (Natural) - English (United Kingdom)', 'en-GB', false),
    v('Google UK English Female', 'en-GB', false),
    v('中文（普通话）', 'zh-CN'),          // 非英语，应当被滤掉
];

/** 只有本地老声音的机器（Chrome 常见） */
const WINDOWS_LOCAL_ONLY = [
    v('Microsoft David - English (United States)', 'en-US'),
    v('Microsoft Zira - English (United States)', 'en-US'),
];

const MAC = [
    v('Albert', 'en-US'),                  // 搞笑声音，必须沉底
    v('Zarvox', 'en-US'),
    v('Daniel', 'en-GB'),
    v('Serena (Premium)', 'en-GB'),
];

function withVoices(list: SpeechSynthesisVoice[]) {
    vi.stubGlobal('window', {
        speechSynthesis: {
            getVoices: () => list,
            addEventListener: () => {},
            removeEventListener: () => {},
        },
    });
}

const { listEnglishVoices, voiceTier, bestAvailableTier, looksEnglish } = await import('./speech.js');

// ------------------------------------------------------------

describe('默认挑到最好的那把', () => {
    it('Windows + Edge：排头两名是英式 Natural 招牌嗓（Sonia / Ryan），机器音沉到后面', () => {
        withVoices(WINDOWS_EDGE);
        const list = listEnglishVoices();

        // Sonia 和 Ryan 同为 en-GB Natural 招牌嗓，分数一样，
        // 谁在前由字母序定 —— 两个都对，不去硬指定其中一个（一男一女，没有高下）
        expect([list[0].name, list[1].name].join(' ')).toContain('Sonia');
        expect([list[0].name, list[1].name].join(' ')).toContain('Ryan');

        // 系统原本把 David 排在第一，现在必须掉到这两个后面
        expect(list.findIndex((x) => x.name.includes('David'))).toBeGreaterThan(1);
        expect(list.findIndex((x) => x.name.includes('Hazel'))).toBeGreaterThan(1);
    });

    it('非英语的声音会被滤掉', () => {
        withVoices(WINDOWS_EDGE);
        expect(listEnglishVoices().some((x) => /中文/.test(x.name))).toBe(false);
    });

    it('英式 Natural 排在美式 Natural 前面（场景就是英国生活）', () => {
        withVoices(WINDOWS_EDGE);
        const list = listEnglishVoices();
        expect(list.findIndex((x) => x.name.includes('Sonia')))
            .toBeLessThan(list.findIndex((x) => x.name.includes('Aria')));
    });

    it('招牌嗓子排在同为 Natural 的冷门嗓子前面', () => {
        withVoices(WINDOWS_EDGE);
        const list = listEnglishVoices();
        // Thomas 也是 en-GB Natural，但不在招牌名单里
        expect(list.findIndex((x) => x.name.includes('Sonia')))
            .toBeLessThan(list.findIndex((x) => x.name.includes('Thomas')));
    });

    it('macOS：Premium 排最前，搞笑声音排最后', () => {
        withVoices(MAC);
        const list = listEnglishVoices();
        expect(list[0].name).toContain('Serena');
        expect(list[list.length - 1].name).toMatch(/Albert|Zarvox/);
    });
});

describe('品质分档', () => {
    it('Natural / Online / 本地老声音各归各档', () => {
        expect(voiceTier(v('Microsoft Sonia Online (Natural) - English (United Kingdom)', 'en-GB', false)))
            .toBe('natural');
        expect(voiceTier(v('Serena (Premium)', 'en-GB'))).toBe('natural');
        expect(voiceTier(v('Google UK English Female', 'en-GB', false))).toBe('online');
        expect(voiceTier(v('Microsoft David - English (United States)', 'en-US'))).toBe('standard');
    });

    it('只有机器音时报 standard —— 界面据此提示去 Edge 换 Sonia', () => {
        withVoices(WINDOWS_LOCAL_ONLY);
        expect(bestAvailableTier(listEnglishVoices())).toBe('standard');
    });

    it('有 Natural 时不再提示', () => {
        withVoices(WINDOWS_EDGE);
        expect(bestAvailableTier(listEnglishVoices())).toBe('natural');
    });

    it('一个英语声音都没有时返回 null，不崩', () => {
        withVoices([v('中文（普通话）', 'zh-CN')]);
        expect(listEnglishVoices()).toEqual([]);
        expect(bestAvailableTier([])).toBeNull();
    });
});

// ============================================================
//  记忆卡正面「要不要念」的判定
//
//  这个判断错了的后果是不对称的：
//    · 该念的没念 —— 用户点一下喇叭就行，损失很小
//    · 不该念的念了 —— 英语嗓子念中文卡，或者把 "1+1=?" 念成一串符号，
//      吵、且每翻一张就来一次
//  所以宁可漏，不可错：拿不准的一律判 false。
// ============================================================

describe('英文正面识别', () => {
    it('单词、短语、整句都算英语', () => {
        expect(looksEnglish('serendipity')).toBe(true);
        expect(looksEnglish('take something for granted')).toBe(true);
        expect(looksEnglish('What does this idiom mean?')).toBe(true);
    });

    it('带中文的一律不念 —— 中英混排的卡也算', () => {
        expect(looksEnglish('三次握手')).toBe(false);
        expect(looksEnglish('TCP 三次握手')).toBe(false);
        expect(looksEnglish('serendipity（意外的好运）')).toBe(false);
    });

    it('日文假名与谚文同样挡掉', () => {
        expect(looksEnglish('ありがとう')).toBe(false);
        expect(looksEnglish('감사합니다')).toBe(false);
    });

    it('纯符号 / 纯数字不念 —— 念了也没有信息', () => {
        expect(looksEnglish('1 + 1 = ?')).toBe(false);
        expect(looksEnglish('')).toBe(false);
        expect(looksEnglish('   ')).toBe(false);
        expect(looksEnglish('42')).toBe(false);
    });

    it('字母太少或被符号淹没的不念', () => {
        expect(looksEnglish('C')).toBe(false);          // 单个字母
        expect(looksEnglish('C++')).toBe(false);        // 字母占比不到一半
    });

    it('代码味的英文仍然算 —— 字母够密就念', () => {
        expect(looksEnglish('O(n log n)')).toBe(true);
        expect(looksEnglish('int main()')).toBe(true);
    });
});
