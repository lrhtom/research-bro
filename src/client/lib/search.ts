// ============================================================
//  全站搜索的打分与高亮
//
//  纯前端子串匹配，没有后端也没有索引文件 —— 条目总共几十条，直接线性扫最省事。
//  高亮不再拼 HTML 字符串，而是返回分段数组交给 React 渲染，天然没有 XSS 面。
// ============================================================

import type { SearchRow } from './site-data';

export const MAX_SHOW = 12;

const ASCII_WORD = /^[a-z0-9]+$/;

/**
 * 判断 text 里有没有 term。
 *
 * 纯英文数字的词按「词首」匹配，不按裸子串 ——
 * 否则搜 MIT 会命中 rate limit 里的 li-MIT，搜 AI 会命中一堆 cont-AI-ner。
 * 词首匹配同时保留了前缀搜索（打一半 "data" 也能搜到 database）。
 * 含中文的词没有词边界可言，仍旧按子串匹配。
 */
function hasTerm(text: string, t: string): boolean {
    if (!ASCII_WORD.test(t)) return text.indexOf(t) >= 0;
    let i = text.indexOf(t);
    while (i >= 0) {
        if (!precededByWordChar(text, i)) return true;
        i = text.indexOf(t, i + 1);
    }
    return false;
}

function precededByWordChar(text: string, i: number): boolean {
    if (i <= 0) return false;
    const p = text.charCodeAt(i - 1);
    return (p >= 97 && p <= 122) || (p >= 48 && p <= 57);
}

/**
 * 打分：命中标题比命中正文值钱得多，
 * 否则搜「缓存」会被一堆正文里顺口提到缓存的条目淹掉。
 * 返回 0 表示没命中。
 */
function score(row: SearchRow, terms: string[]): number {
    let s = 0;
    const title = row.title.toLowerCase();
    const sub = (row.sub || '').toLowerCase();
    for (const t of terms) {
        if (!hasTerm(row.text, t)) return 0;      // 所有词都得命中（AND 语义）
        if (title === t) s += 100;
        else if (title.startsWith(t)) s += 60;
        else if (hasTerm(title, t)) s += 40;
        else if (hasTerm(sub, t)) s += 15;
        else s += 5;
    }
    if (!row.external) s += 2;                     // 同分时站内内容优先
    return s;
}

export function splitTerms(q: string): string[] {
    return String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
}

export function search(q: string, index: SearchRow[]): SearchRow[] {
    const terms = splitTerms(q);
    if (!terms.length) return [];
    return index
        .map((row) => ({ row, s: score(row, terms) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || a.row.title.length - b.row.title.length)
        .slice(0, MAX_SHOW)
        .map((x) => x.row);
}

// ---------- 高亮 ----------

export interface Segment {
    text: string;
    hit: boolean;
}

/**
 * 把查询词在文本里出现的地方切成 [{text, hit}] 分段。
 * 命中区间先算好再合并重叠，跟 hasTerm 用同一套词首规则 ——
 * 免得搜 MIT 时把 limit 中间那三个字母也涂黄。
 */
export function highlight(text: string, terms: string[]): Segment[] {
    const src = String(text ?? '');
    if (!src || !terms.length) return [{ text: src, hit: false }];

    const low = src.toLowerCase();
    const hits: Array<[number, number]> = [];
    for (const t of terms) {
        if (!t) continue;
        const asciiWord = ASCII_WORD.test(t);
        let i = low.indexOf(t);
        while (i >= 0) {
            if (!asciiWord || !precededByWordChar(low, i)) hits.push([i, i + t.length]);
            i = low.indexOf(t, i + 1);
        }
    }
    if (!hits.length) return [{ text: src, hit: false }];

    hits.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [[...hits[0]] as [number, number]];
    for (let k = 1; k < hits.length; k++) {
        const last = merged[merged.length - 1];
        if (hits[k][0] <= last[1]) last[1] = Math.max(last[1], hits[k][1]);
        else merged.push([...hits[k]] as [number, number]);
    }

    const out: Segment[] = [];
    let pos = 0;
    for (const [a, b] of merged) {
        if (a > pos) out.push({ text: src.slice(pos, a), hit: false });
        out.push({ text: src.slice(a, b), hit: true });
        pos = b;
    }
    if (pos < src.length) out.push({ text: src.slice(pos), hit: false });
    return out;
}
