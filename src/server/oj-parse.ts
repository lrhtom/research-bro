// ============================================================
//  OJ · 解析 AI 的回复
//
//  两件事：把标签分节抠出来，把 <plans> 那段 JSON 解析成对象。
//
//  为什么整份不走 JSON：题面和代码里全是引号、反斜杠和换行，套进 JSON
//  字符串就得转义，模型转错一个字符整份都废。标签分节没有这个问题。
//  只有 plans 是纯结构化数据，那一小段才用 JSON，而且配了 jsonrepair 兜底。
// ============================================================

import { jsonrepair } from 'jsonrepair';
import type { OjDifficulty, OjTestCaseKind, OjTestPlan } from '../shared/oj.js';
import { OJ_DEFAULT_COUNT_BY_KIND, OJ_MAX_CASES_PER_KIND } from '../shared/oj.js';

/** 计划数量上限：防着模型无视要求一口气塞几十个计划，把出题流程拖垮 */
const MAX_PLANS = 15;

const VALID_KINDS: readonly OjTestCaseKind[] = ['sample', 'boundary', 'small', 'large', 'special'];
const VALID_DIFFICULTIES: readonly OjDifficulty[] = ['简单', '中等', '困难'];

export interface ParsedOjProblem {
    title: string;
    difficulty: OjDifficulty;
    timeLimitMs: number;
    memoryLimitMb: number;
    tags: string[];
    statementMd: string;
    solutionCode: string;
    plans: OjTestPlan[];
}

/** 抠出 <tag>…</tag> 里第一个匹配的内容并去掉两头空白；没有就返回 null */
export function extractTag(text: string, tag: string): string | null {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(text);
    return m ? m[1].trim() : null;
}

/**
 * 剥掉整体包着的 ``` 围栏 —— 模型经常无视「不要加围栏」这条要求。
 *
 * 只有开头结尾**同时**是围栏才剥，否则会误伤正文里本来就含代码块的题面。
 */
export function stripCodeFence(text: string): string {
    const t = text.trim();
    if (!t.startsWith('```')) return t;

    const firstNewline = t.indexOf('\n');
    if (firstNewline === -1 || !t.endsWith('```')) return t;

    const body = t.slice(firstNewline + 1, -3).replace(/\r?\n[ \t]*$/, '');
    return body.trim() ? body : t;
}

function clampInt(raw: string | null, def: number, min: number, max: number): number {
    const n = raw === null ? NaN : parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

/**
 * 解析 <plans> 里的 JSON 数组。
 *
 * 彻底解析不了就抛错 —— 一个测试计划都没有的话整道题没法往下走，
 * 交给上层触发整题重试，比硬凑一个空数组继续跑要好。
 */
export function parsePlans(raw: string): OjTestPlan[] {
    const stripped = stripCodeFence(raw);

    let data: unknown;
    try {
        data = JSON.parse(stripped);
    } catch {
        // jsonrepair 能救回来的典型情况：尾逗号、单引号、漏引号的键
        try {
            data = JSON.parse(jsonrepair(stripped));
        } catch {
            throw new Error('测试计划 <plans> 不是合法 JSON（自动修复后仍然解析不了）');
        }
    }

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('测试计划 <plans> 必须是非空 JSON 数组');
    }

    const plans: OjTestPlan[] = [];
    for (const item of data.slice(0, MAX_PLANS)) {
        if (typeof item !== 'object' || item === null) continue;
        const o = item as Record<string, unknown>;

        // kind 非法时回退 special：宁可把这个计划当"特殊构造"跑掉，也别整题失败
        const kind: OjTestCaseKind = VALID_KINDS.includes(o.kind as OjTestCaseKind)
            ? (o.kind as OjTestCaseKind)
            : 'special';

        const name = typeof o.name === 'string' && o.name.trim()
            ? o.name.trim().slice(0, 60)
            : `计划${plans.length + 1}`;

        const description = typeof o.description === 'string' ? o.description.trim() : '';
        const isSample = typeof o.isSample === 'boolean' ? o.isSample : kind === 'sample';

        // count 缺了或不合法就按类型垫默认值，最后一律钳到该类型的上限 ——
        // 模型偶尔会给 large 塞几十个，那会把生成和判题的耗时直接翻十倍
        const rawCount = typeof o.count === 'number'
            ? o.count
            : typeof o.count === 'string' ? parseInt(o.count, 10) : NaN;
        const count = Number.isFinite(rawCount)
            ? Math.min(OJ_MAX_CASES_PER_KIND[kind], Math.max(1, Math.floor(rawCount)))
            : OJ_DEFAULT_COUNT_BY_KIND[kind];

        plans.push({ name, kind, description, isSample, count });
    }

    if (plans.length === 0) {
        throw new Error('测试计划 <plans> 里没有任何合法的计划对象');
    }
    return plans;
}

/** 解析第一步的回复。缺关键分节就抛错，交给上层整题重试。 */
export function parseProblemResponse(text: string): ParsedOjProblem {
    const title = extractTag(text, 'title');
    const statementMd = extractTag(text, 'statement');
    const solutionRaw = extractTag(text, 'solution');
    const plansRaw = extractTag(text, 'plans');

    const missing: string[] = [];
    if (!title) missing.push('<title>');
    if (!statementMd) missing.push('<statement>');
    if (!solutionRaw) missing.push('<solution>');
    if (!plansRaw) missing.push('<plans>');
    if (missing.length > 0) {
        throw new Error(`AI 返回的内容缺少必需分节：${missing.join('、')}`);
    }

    const solutionCode = stripCodeFence(solutionRaw as string);
    if (!solutionCode.trim()) {
        throw new Error('AI 返回的 <solution> 分节是空的');
    }

    const difficultyRaw = extractTag(text, 'difficulty');
    const difficulty: OjDifficulty = VALID_DIFFICULTIES.includes(difficultyRaw as OjDifficulty)
        ? (difficultyRaw as OjDifficulty)
        : '中等';

    const tagsRaw = extractTag(text, 'tags') ?? '';
    const tags = Array.from(new Set(
        tagsRaw
            .split(/[,，、;；\n]/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
    )).slice(0, 10);

    return {
        title: (title as string).replace(/\s+/g, ' ').slice(0, 80),
        difficulty,
        timeLimitMs: clampInt(extractTag(text, 'time_limit_ms'), 2000, 1000, 5000),
        memoryLimitMb: clampInt(extractTag(text, 'memory_limit_mb'), 256, 64, 2048),
        tags,
        statementMd: statementMd as string,
        solutionCode,
        plans: parsePlans(plansRaw as string),
    };
}

/** 解析第二步回复里的生成器代码。失败就抛，错误文本会原样反馈给模型让它重来。 */
export function parseGeneratorResponse(text: string): string {
    const tagged = extractTag(text, 'generator');
    if (tagged) {
        const code = stripCodeFence(tagged);
        if (code.trim()) return code.trim();
    }

    // 兜底：有的模型偶尔忘了贴标签，只回一个围栏代码块。能救就救，省掉一次重试。
    // 只在**恰好一个**围栏时才救 —— 有多个就说明它在解释思路，猜哪个都可能猜错。
    const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    if (fences.length === 1 && fences[0][1].trim()) {
        return fences[0][1].trim();
    }

    throw new Error('返回内容里没有 <generator> 分节（或者是空的），请严格按 <generator>代码</generator> 的格式输出');
}
