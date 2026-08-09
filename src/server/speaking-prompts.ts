// ============================================================
//  口语练习的系统提示词
//
//  提示词只在服务端拼装。客户端提交的永远只有「场景 + 勾了哪些干扰项 +
//  目标词」这三样结构化数据，它没有机会自己塞一段 system prompt 进来。
//
//  英文片段（_SUB_LABELS / _BASE_FRAGMENTS）逐字移植自参考实现的
//  scenario.py 5-75，改动会直接改变 AI 的说话方式，动之前先想清楚。
//
//  ★ 最重要的一条：报告提示词（reportPrompt）里那道硬边界。
//    模型看到的全部内容 = 用户打的字，或浏览器语音识别猜出来的字。
//    它从来没有听过用户的声音，所以任何发音 / 语调 / 重音 / 语速 的评价
//    都是凭空捏造的测量结果。提示词里禁一遍，服务端还会再校验一遍
//    （见 speaking.ts 的 sanitizeReport）—— 光靠提示词约束不住模型。
// ============================================================

import {
    INTERFERENCE_KEYS, normalizeModifiers,
    type InterferenceKey, type Modifiers, type RawModifiers, type TargetWord,
} from '../shared/speaking.js';

// ---------- 干扰项 → 英文片段（逐字移植） ----------

/** 子选项 → 注入提示词的英文描述 */
const SUB_LABELS: Record<InterferenceKey, Record<string, string>> = {
    accent: {
        brummie: "Birmingham 'Brummie'",
        eastmidlands: 'East Midlands / Nottingham',
        scouse: "Liverpool 'Scouse'",
        geordie: "Newcastle 'Geordie'",
        cockney: "London 'Cockney'",
    },
    crosstalk: {
        fast: 'talk noticeably fast',
        interrupt: 'interrupt and talk over the learner',
        overlap: "use overlapping back-channels ('yeah yeah', 'mm-hm') while they speak",
    },
    noise: {
        pub: 'a busy pub',
        canteen: 'a clattering canteen',
        office: 'an open-plan office',
        street: 'a noisy street',
    },
    audioquality: {
        phone: 'a narrow, tinny telephone line',
        muffled: 'a muffled, low-fidelity channel (as if through a wall)',
        radio: 'a crackly two-way radio',
    },
    smalltalk: {},   // 只有开关，没有子选项
};

/** 每个干扰项的基础行为指令（选了子选项就在后面追加 'Specifically: …'） */
const BASE_FRAGMENTS: Record<InterferenceKey, string> = {
    accent: (
        'ACCENT: Play a working-class British local with a strong REGIONAL accent (NOT BBC Received '
        + "Pronunciation). Drop in regional dialect words and colloquialisms ('ta', 'ay up', 'innit', "
        + "'gonna', 'proper' = very), conveying the accent through spelling and word choice while staying "
        + 'ultimately understandable'
    ),
    crosstalk: (
        'PACE & INTERRUPTIONS: Speak at a fast native pace with contractions and fillers '
        + "('erm', 'like', 'you know')"
    ),
    noise: (
        'BACKGROUND NOISE: There is loud background noise; occasionally mishear the learner or ask them '
        + "to repeat ('it's dead loud in here — say that again?') and reference the noise naturally"
    ),
    audioquality: (
        'AUDIO QUALITY: The learner hears you through a degraded audio channel; enunciate clearly and be '
        + 'understanding if they mishear or ask you to repeat'
    ),
    smalltalk: (
        'SMALL TALK: Weave in natural British small talk and expect the learner to reciprocate; if they '
        + 'are too abrupt, react as a real person would (mild surprise) but stay friendly'
    ),
};

/**
 * 把开启的干扰项（连同子选项）拼成一段系统指令；一个都没开就返回空串。
 *
 * 「一个都没开就返回空串」是有测试守着的：没勾干扰项时，
 * 拼出来的系统提示词里不能出现 REALISM MODIFIERS 这一段，
 * AI 就说标准英语。
 */
export function interferenceBlock(raw: RawModifiers): string {
    const norm = normalizeModifiers(raw);
    const lines: string[] = [];

    for (const opt of INTERFERENCE_KEYS) {
        const subs = norm[opt];
        if (subs === undefined) continue;
        const labels = subs.map((s) => SUB_LABELS[opt][s]).filter(Boolean);
        const detail = labels.length ? ` Specifically: ${labels.join('; ')}.` : '.';
        lines.push(`- ${BASE_FRAGMENTS[opt]}${detail}`);
    }

    if (lines.length === 0) return '';

    return (
        '\n\nREALISM MODIFIERS — you MUST stay fully in character and apply ALL of the following, '
        + 'while keeping the conversation ultimately intelligible and helpful for an English learner. '
        + 'These affect ONLY your own speech and behaviour:\n'
        + lines.join('\n')
    );
}

// ---------- 目标词 ----------

/**
 * 目标词注入。
 *
 * 关键是「制造机会，不要点名」：AI 要把话题引到能自然用上这些词的地方，
 * 绝不能列清单、也不能说「试着用一下 X」—— 那一秒就从角色扮演掉回背单词。
 */
function targetWordBlock(words: TargetWord[]): string {
    if (words.length === 0) return '';
    return (
        `\n\nTARGET VOCABULARY: [${words.map((w) => w.en).join(', ')}]\n`
        + 'Create natural openings where the learner would plausibly use these words — ask questions, '
        + 'raise topics, or use the words yourself in passing so they are in the air. '
        + 'NEVER list them, never announce them, never say "try to use X". '
        + 'The learner must not be able to tell there is a word list.'
    );
}

/** 快收尾了，把话题往还没用过的词上带 */
export function unusedWordsNudge(unused: string[]): string {
    if (unused.length === 0) return '';
    return (
        `\n\n[Director's note — never mention this out loud] The learner has not yet used: `
        + `${unused.slice(0, 5).join(', ')}. The conversation is nearing its end. Steer the topic so `
        + 'that one or two of these become the natural thing to say. Stay fully in character.'
    );
}

// ---------- 四个对话提示词 ----------

/** 用户自己写的场景，先过一遍内容审核 */
export function checkScenarioPrompt(): string {
    return (
        'You are a content moderation AI for an English learning app. '
        + 'Analyse the following role-play scenario written by a user. '
        + 'Reject it only if it contains NSFW content, extreme violence, illegal activity, hate speech, '
        + 'or is so inappropriate that it cannot be role-played. Ordinary awkward or confrontational '
        + 'everyday situations (complaining, arguing about a refund, a difficult landlord) are FINE — '
        + 'they are exactly what a learner needs to practise.\n'
        + 'Output ONLY raw JSON matching: {"valid": true|false, "reason": "if false, a brief reason in '
        + 'Chinese; otherwise an empty string"}'
    );
}

/** AI 先开口。开场白要把场景「演」出来，而不是描述出来。 */
export function openingPrompt(
    scenario: string,
    modifiers: RawModifiers,
    words: TargetWord[],
): string {
    return (
        'You are starting a role-play speaking practice with an English learner.\n'
        + `SCENARIO: ${scenario}\n\n`
        + 'You are the counterpart in this scenario — a real person with a job to do, not a tutor.\n'
        + 'Begin the conversation naturally in character.\n'
        + 'Output ONLY a short, natural opening line (1-3 sentences) that starts the conversation.\n'
        + 'Make it immersive — set the scene through what you say, not by describing it.\n'
        + 'Reply in English only. Output raw text: no quotes, no JSON, no markdown, no stage directions.'
        + interferenceBlock(modifiers)
        + targetWordBlock(words)
    );
}

/**
 * 每一轮的系统提示词。
 *
 * 跟参考实现最大的差别：**不返回 JSON、不打分**。
 * 参考实现每轮都让模型顺手评一次语法/词汇/相关性，那等于每轮多一次评估器 ——
 * 一次实时对话里既加钱又加延迟，而这些评价在最后那份报告里做一次就够了。
 * 所以这里只要一段纯文本，客户端拿到就能直接念。
 */
export function turnPrompt(
    scenario: string,
    modifiers: RawModifiers,
    words: TargetWord[],
): string {
    return (
        'You are role-playing with an English learner to give them speaking practice.\n'
        + `SCENARIO: ${scenario}\n\n`
        + 'You are the counterpart in this scenario. Rules you must follow:\n'
        + '1. Stay in character at all times. Never break character, never mention being an AI, '
        + 'never mention that this is practice or a simulation.\n'
        + '2. Never switch to another language. English only, whatever language the learner uses.\n'
        + '3. Reply in 1-3 sentences. A wall of text kills a speaking drill.\n'
        + '4. NEVER correct the learner\'s English, never comment on their grammar or vocabulary, '
        + 'never praise their English. You are not a teacher. Feedback comes later, elsewhere.\n'
        + '5. If the learner stalls, goes silent, or says something unintelligible, react the way the '
        + "person you are playing would — \"sorry, you've lost me there\", \"come again?\" — "
        + 'not as a tutor explaining what went wrong.\n'
        + '6. Drive towards the goal of the scenario. When it is genuinely resolved, wrap up in '
        + 'character the way that person would end the exchange.\n'
        + '7. Plain spoken text only. No markdown, no bullet points, no stage directions, no emoji, '
        + 'no asterisks — every character you output will be read aloud by a speech synthesiser.'
        + interferenceBlock(modifiers)
        + targetWordBlock(words)
    );
}

/** 随机想一个场景，避开最近用过的 */
export function randomScenarioPrompt(recent: string[]): string {
    const history = recent.length ? recent.map((t) => `- ${t}`).join('\n') : 'None.';
    return (
        'Invent one everyday English role-play scenario for a learner living in the UK to practise '
        + 'speaking. It must be a situation where they have to get something done by talking to '
        + 'someone: a service encounter, an appointment, a complaint, an enquiry.\n'
        + 'Avoid anything similar to these already-used scenarios:\n'
        + `${history}\n\n`
        + 'Output ONLY raw JSON with two keys:\n'
        + '{"scenario": "(English, 1-2 sentences) what the situation is and who you play", '
        + '"label": "(Chinese, 4-10 characters) a short name for this scenario"}\n'
        + 'Example: {"scenario": "The learner is at a pharmacy asking about a repeat prescription that '
        + 'has not arrived. You are the pharmacist, and the system says it was collected yesterday.", '
        + '"label": "药房取药纠纷"}'
    );
}

// ---------- 报告 ----------

/**
 * 总结报告 —— 全套功能里唯一一处需要「评价」的地方，也是最容易骗人的地方。
 *
 * 硬边界写了三遍（开头、禁止清单、结尾），因为模型对这类指令的服从度
 * 跟它出现的次数有关；即便如此，服务端拿到结果之后还会再过一遍
 * sanitizeReport()，把违规条目和引不出原话的条目直接删掉。
 * 提示词是第一道闸，代码是第二道，两道都得有。
 */
export function reportPrompt(): string {
    return (
        'You are giving an English learner feedback on a role-play speaking practice they just finished.\n\n'

        + '=== WHAT YOU CAN AND CANNOT SEE — READ THIS FIRST ===\n'
        + 'You are being given a TEXT TRANSCRIPT and nothing else. You have NEVER HEARD THIS PERSON '
        + 'SPEAK. There is no audio, there were no recordings, and no acoustic analysis of any kind was '
        + 'performed. Each learner turn is marked either [typed] (they typed it on a keyboard) or '
        + '[speech-to-text] (a rough guess produced by the browser\'s free speech recogniser, which '
        + 'routinely mishears words).\n'
        + 'Therefore any statement about how they SOUNDED would be an invented measurement. '
        + 'You MUST NOT produce, in any field, in any language:\n'
        + '  - pronunciation scores, accuracy percentages, or phoneme-level comments\n'
        + '  - any judgement of intonation, stress, rhythm, fluency-as-sound, or accent\n'
        + '  - words per minute, speaking speed, pause length, or anything derived from timing\n'
        + '  - an overall band score, IELTS/CEFR level, or any number presented as an exam result\n'
        + 'Also: never treat an odd word as a mispronunciation — on a [speech-to-text] turn it is far '
        + 'more likely to be the recogniser mishearing them.\n\n'

        + '=== WHAT THE TRANSCRIPT DOES SUPPORT ===\n'
        + 'Judge only what is visible in the words. Every single point you make MUST quote the '
        + "learner's own words verbatim, copied EXACTLY character-for-character from a line marked "
        + 'LEARNER. Never quote yourself, never quote the other character, never paraphrase into the '
        + 'quote field, never invent a quote. If you cannot find a real quote for a point, drop the '
        + 'point — a report that could have been written without reading the transcript is worthless.\n\n'

        + '=== OUTPUT ===\n'
        + 'Output ONLY raw JSON, no markdown fence, exactly this shape:\n'
        + '{\n'
        + '  "summary": "(Chinese, 2-3 sentences) what happened in this conversation and how they coped",\n'
        + '  "taskAchievement": {\n'
        + '    "verdict": "achieved" | "partial" | "not-achieved",\n'
        + '    "comment": "(Chinese) did they accomplish what the scenario required, and how",\n'
        + '    "quote": "(verbatim learner line that shows it)"\n'
        + '  },\n'
        + '  "vocabulary": [ {"quote": "(verbatim learner line)", "suggestion": "(a more natural or '
        + 'precise rewrite of that line, in English)", "why": "(Chinese, one line)"} ],\n'
        + '  "grammar": [ {"quote": "(verbatim learner line containing the error)", '
        + '"fix": "(the corrected English)", "why": "(Chinese, one line naming the grammar point)"} ],\n'
        + '  "turnTaking": {\n'
        + '    "comment": "(Chinese) did they ask questions back, cope with interruptions, ask for '
        + 'repetition when they misheard, or just answer passively",\n'
        + '    "quote": "(verbatim learner line that shows it)"\n'
        + '  },\n'
        + '  "nextSteps": ["(Chinese) 2-3 concrete things to try in the next session"]\n'
        + '}\n\n'
        + 'Give at most 4 vocabulary items and at most 5 grammar items — the ones that actually matter, '
        + 'not every slip. Order them worst-first.\n'
        + 'If the learner said nothing at all, return every list empty, verdict "not-achieved", and '
        + 'empty strings for the quotes. Do NOT invent an evaluation of a conversation that did not happen.\n\n'
        + 'FINAL REMINDER: no pronunciation, no intonation, no accent, no speaking speed, no band score. '
        + 'You never heard this person. Only what they wrote or what a recogniser guessed they said.'
    );
}

/**
 * 把一场对话整理成喂给报告的文本。
 *
 * 每条用户发言都标出来源：[typed] 还是 [speech-to-text]。
 * 这一标记不是装饰 —— 模型必须知道「这词看着怪」在语音识别那一路
 * 大概率是识别错了，而不是用户真说错了。
 */
export function transcriptForReport(
    scenario: string,
    turns: Array<{ role: 'assistant' | 'user'; content: string; source: string }>,
): string {
    const lines = turns.map((t) => (
        t.role === 'user'
            ? `LEARNER [${t.source === 'typed' ? 'typed' : 'speech-to-text'}]: ${t.content}`
            : `OTHER CHARACTER: ${t.content}`
    ));
    return `SCENARIO: ${scenario}\n\nTRANSCRIPT:\n${lines.join('\n')}`;
}
