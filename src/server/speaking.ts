// ============================================================
//  英语口语场景练习：会话存储 + 报告生成与校验
//
//  两件事值得单独说：
//
//  1. 存对话就必须连着存干扰项设置。
//     同一句 "sorry, say that again?"，在开了背景噪音的场景里是设计好的
//     听力压力，在没开的场景里是对方真的没听懂。设置丢了，记录就读不懂。
//
//  2. sanitizeReport() 是那道硬边界的**第二道闸**。
//     提示词里已经三次禁止模型评价发音 / 语调 / 语速 / 总分，但提示词
//     约束不住模型 —— 它只要有一次不听话，页面上就会出现一个凭空捏造的
//     测量结果。所以拿到模型输出之后，这里再逐条过一遍：
//       · 含发音类断言的条目 → 删掉
//       · quote 在学习者原话里找不到的条目 → 删掉
//     两道闸都有，测试才是确定性的，而不是「看模型今天心情」。
// ============================================================

import { db, nowIso } from './db.js';
import { chatNonEmpty, extractJson, sleepBeforeRetry, LLM_ATTEMPTS, LlmError } from './llm.js';
import { reportPrompt, transcriptForReport } from './speaking-prompts.js';
import {
    normalizeModifiers, parseTargetWords, tallyTargetWords,
    type Modifiers, type RawModifiers, type TargetWord,
} from '../shared/speaking.js';
import type {
    QuotedPoint, SpeakingReport, SpeakingSession, SpeakingSessionFull,
    SpeakingSessionSummary, SpeakingTurn, TurnSource,
} from '../shared/types.js';

export class SpeakingError extends Error {
    constructor(message: string, readonly status = 400) {
        super(message);
    }
}

// ---------- 行类型 ----------

interface SessionRow {
    id: number;
    scenario: string;
    label: string;
    preset: string;
    modifiers: string;
    target_words: string;
    status: string;
    report: string | null;
    started_at: string;
    finished_at: string | null;
}

interface TurnRow {
    id: number;
    role: string;
    content: string;
    source: string;
    seq: number;
    said_at: string;
}

function parseJson<T>(text: string, fallback: T): T {
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
}

function toSession(r: SessionRow): SpeakingSession {
    return {
        id: r.id,
        scenario: r.scenario,
        label: r.label,
        preset: r.preset,
        // 存进去时已经归一化过，读出来再归一化一次 —— 手改过库文件也不会污染提示词
        modifiers: normalizeModifiers(parseJson<RawModifiers>(r.modifiers, {})),
        targetWords: parseJson<TargetWord[]>(r.target_words, []),
        status: r.status === 'finished' ? 'finished' : 'active',
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        report: r.report ? parseJson<SpeakingReport | null>(r.report, null) : null,
    };
}

function toTurn(r: TurnRow): SpeakingTurn {
    return {
        id: r.id,
        role: r.role === 'user' ? 'user' : 'assistant',
        content: r.content,
        source: (['typed', 'speech', 'ai'].includes(r.source) ? r.source : 'ai') as TurnSource,
        seq: r.seq,
        saidAt: r.said_at,
    };
}

// ---------- 会话 ----------

export function createSession(input: {
    scenario: string;
    label?: string;
    preset?: string;
    modifiers?: RawModifiers;
    targetWords?: string | TargetWord[];
}): SpeakingSession {
    const scenario = input.scenario.trim().slice(0, 2000);
    if (!scenario) throw new SpeakingError('场景描述不能为空');

    const words = typeof input.targetWords === 'string'
        ? parseTargetWords(input.targetWords)
        : (input.targetWords ?? []).slice(0, 40);

    const ts = nowIso();
    const info = db().prepare(
        `INSERT INTO speaking_sessions
             (scenario, label, preset, modifiers, target_words, status,
              started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
        scenario,
        (input.label ?? '').trim().slice(0, 120),
        (input.preset ?? '').slice(0, 60),
        // 归一化之后再落库：库里存的就是真正拿去拼提示词的那一份
        JSON.stringify(normalizeModifiers(input.modifiers)),
        JSON.stringify(words),
        ts, ts, ts,
    );

    return getSession(Number(info.lastInsertRowid))!;
}

export function getSession(id: number): SpeakingSession | null {
    const row = db().prepare('SELECT * FROM speaking_sessions WHERE id = ?').get(id) as
        | SessionRow | undefined;
    return row ? toSession(row) : null;
}

export function requireSession(id: number): SpeakingSession {
    const s = getSession(id);
    if (!s) throw new SpeakingError('这场练习不存在', 404);
    return s;
}

export function getSessionFull(id: number): SpeakingSessionFull | null {
    const s = getSession(id);
    if (!s) return null;
    return { ...s, turns: listTurns(id) };
}

export function listSessions(limit = 50): SpeakingSessionSummary[] {
    const rows = db().prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM speaking_turns t WHERE t.session_id = s.id) AS turn_count,
                (SELECT COUNT(*) FROM speaking_turns t
                  WHERE t.session_id = s.id AND t.role = 'user') AS user_turn_count
         FROM speaking_sessions s
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT ?`,
    ).all(limit) as Array<SessionRow & { turn_count: number; user_turn_count: number }>;

    return rows.map((r) => ({
        ...toSession(r),
        turnCount: r.turn_count,
        userTurnCount: r.user_turn_count,
    }));
}

export function deleteSession(id: number): boolean {
    // turns 是 ON DELETE CASCADE，跟着一起走
    return db().prepare('DELETE FROM speaking_sessions WHERE id = ?').run(id).changes > 0;
}

export function finishSession(id: number): SpeakingSession {
    requireSession(id);
    const ts = nowIso();
    db().prepare(
        "UPDATE speaking_sessions SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ?",
    ).run(ts, ts, id);
    return getSession(id)!;
}

// ---------- 对话轮 ----------

export function listTurns(sessionId: number): SpeakingTurn[] {
    const rows = db().prepare(
        'SELECT * FROM speaking_turns WHERE session_id = ? ORDER BY seq ASC, id ASC',
    ).all(sessionId) as TurnRow[];
    return rows.map(toTurn);
}

/**
 * 追加一轮。
 *
 * 每一轮当场落库 —— 说到一半关掉页面，已经说过的话一句都不会丢，
 * 重新打开接着上次的位置继续。
 */
export function addTurn(
    sessionId: number,
    role: 'assistant' | 'user',
    content: string,
    source: TurnSource,
): SpeakingTurn {
    const text = content.trim().slice(0, 8000);
    if (!text) throw new SpeakingError('这一轮是空的');

    const max = db().prepare(
        'SELECT MAX(seq) AS m FROM speaking_turns WHERE session_id = ?',
    ).get(sessionId) as { m: number | null };

    const ts = nowIso();
    const info = db().prepare(
        `INSERT INTO speaking_turns (session_id, role, content, source, seq, said_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, role, text, source, (max.m ?? 0) + 1, ts);

    db().prepare('UPDATE speaking_sessions SET updated_at = ? WHERE id = ?').run(ts, sessionId);

    return toTurn(db().prepare('SELECT * FROM speaking_turns WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as TurnRow);
}

/** 还没用过的目标词。快收尾时拿它把话题往这些词上带。 */
export function unusedTargetWords(session: SpeakingSession, turns: SpeakingTurn[]): string[] {
    const userText = turns.filter((t) => t.role === 'user').map((t) => t.content);
    return tallyTargetWords(session.targetWords, userText)
        .filter((w) => w.count === 0)
        .map((w) => w.en);
}

// ---------- 报告校验：那道硬边界的第二道闸 ----------

/**
 * 发音 / 语调 / 语速 / 总分 类断言的关键词。
 *
 * 中英文都要查：提示词是英文写的，但报告正文是中文，
 * 模型完全可能用英文提示词的措辞在中文句子里说出「语调偏平」。
 *
 * 这份清单只用来**删除**条目，不用来改写 —— 把一条评价改一改留下来，
 * 等于替模型编一句它没说的话，比直接删掉更糟。
 */
const BANNED_CLAIM_PATTERNS: RegExp[] = [
    // 发音
    /pronunciation|pronounce|phoneme|mispronounc/i,
    /发音|读音|吐字|咬字|口型/,
    // 语调 / 重音 / 节奏
    /intonation|word stress|sentence stress|rhythm|prosody/i,
    /语调|声调|重音|语气起伏|节奏感/,
    // 口音
    /\baccent\b/i,
    /口音/,
    // 语速 / 时长
    /words? per minute|\bwpm\b|speaking (?:rate|speed)|pause length|speech rate/i,
    /语速|每分钟\s*\d+\s*词|停顿时长|说得太快|说得太慢/,
    // 分数化的整体评价
    /band\s*(?:score|[0-9])|overall band|CEFR|\bIELTS\b\s*\d/i,
    /总分|总体得分|雅思\s*\d|评分\s*[:：]\s*\d/,
    // 听觉流利度（把 fluent 单独留着 —— 说「表达流畅」是文本层面的判断，
    // 但「听起来流利」不是）
    /sounded? (?:fluent|natural|hesitant|choppy)|听起来.*(?:流利|结巴|卡顿)/i,
];

function hasBannedClaim(text: string): boolean {
    return BANNED_CLAIM_PATTERNS.some((rx) => rx.test(text));
}

/** 比对引文用的归一化：大小写、标点、空白都不计较，只看词 */
function normalizeForQuote(s: string): string {
    return s
        .toLowerCase()
        .replace(/[‘’“”]/g, "'")
        .replace(/[^a-z0-9一-鿿']+/g, ' ')
        .trim();
}

/**
 * 这句引文是不是真的出自学习者。
 *
 * 宽到允许模型截取一句话的片段（很常见、也合理），
 * 严到不允许它把 AI 的话或者自己编的句子当成学习者说的。
 * 太短的片段（少于 3 个词）一律不算 —— "I think" 谁都说得出，
 * 拿它当出处等于没有出处。
 */
function quoteIsFromLearner(quote: string, learnerNorm: string[]): boolean {
    const q = normalizeForQuote(quote);
    if (!q) return false;
    if (q.split(' ').length < 3) return false;
    return learnerNorm.some((line) => line.includes(q));
}

function cleanPoints(
    raw: unknown,
    learnerNorm: string[],
    suggestionKey: 'suggestion' | 'fix',
): { kept: QuotedPoint[]; dropped: number } {
    if (!Array.isArray(raw)) return { kept: [], dropped: 0 };

    const kept: QuotedPoint[] = [];
    let dropped = 0;

    for (const item of raw.slice(0, 12)) {
        const o = (item ?? {}) as Record<string, unknown>;
        const quote = String(o.quote ?? '').trim();
        const suggestion = String(o[suggestionKey] ?? o.suggestion ?? o.fix ?? '').trim();
        const why = String(o.why ?? '').trim();

        // 引不出学习者原话 → 删。这一条就是「报告必须建立在转录稿上」的执行点。
        if (!quoteIsFromLearner(quote, learnerNorm)) { dropped++; continue; }
        // 含发音类断言 → 删
        if (hasBannedClaim(`${suggestion} ${why}`)) { dropped++; continue; }

        kept.push({ quote, suggestion, why });
    }
    return { kept, dropped };
}

/** 一段自由文本：含违规断言就整段丢掉，换成一句说明，而不是留着骗人 */
function cleanText(text: unknown, fallback = ''): { text: string; dropped: number } {
    const s = String(text ?? '').trim();
    if (!s) return { text: fallback, dropped: 0 };
    if (hasBannedClaim(s)) return { text: fallback, dropped: 1 };
    return { text: s, dropped: 0 };
}

const VERDICTS = new Set(['achieved', 'partial', 'not-achieved']);

/**
 * 把模型输出的报告过一遍闸，再补上服务端自己算的目标词统计。
 *
 * 目标词**不问模型**：它看到词表就倾向于说「你用了」。
 * 用不用过是能从原话里数出来的事实，数出来就行。
 */
export function sanitizeReport(
    raw: unknown,
    session: SpeakingSession,
    turns: SpeakingTurn[],
): SpeakingReport {
    const userTurns = turns.filter((t) => t.role === 'user');
    const learnerNorm = userTurns.map((t) => normalizeForQuote(t.content)).filter(Boolean);
    const words = tallyTargetWords(session.targetWords, userTurns.map((t) => t.content))
        .map((w) => ({ ...w, used: w.count > 0 }));

    // 一句话都没说：直接给空状态，不要让模型评价一场没发生过的对话
    if (userTurns.length === 0) {
        return {
            summary: '这场练习里你还没有开口 —— 没有可以点评的内容。',
            taskAchievement: { verdict: 'not-achieved', comment: '没有产生任何发言。', quote: '' },
            vocabulary: [],
            grammar: [],
            turnTaking: { comment: '没有产生任何发言。', quote: '' },
            targetWords: words,
            nextSteps: ['下次先随便说一句，哪怕只是 "hello, I\'m here about the flat" —— 开口比说对重要。'],
            empty: true,
            droppedPoints: 0,
        };
    }

    const o = (raw ?? {}) as Record<string, unknown>;
    let dropped = 0;

    const summary = cleanText(o.summary, '（本次总结未通过内容校验，已略去。）');
    dropped += summary.dropped;

    const ta = (o.taskAchievement ?? {}) as Record<string, unknown>;
    const taComment = cleanText(ta.comment, '（本条未通过内容校验，已略去。）');
    dropped += taComment.dropped;
    const taQuote = String(ta.quote ?? '').trim();

    const vocab = cleanPoints(o.vocabulary, learnerNorm, 'suggestion');
    const grammar = cleanPoints(o.grammar, learnerNorm, 'fix');
    dropped += vocab.dropped + grammar.dropped;

    const tt = (o.turnTaking ?? {}) as Record<string, unknown>;
    const ttComment = cleanText(tt.comment, '（本条未通过内容校验，已略去。）');
    dropped += ttComment.dropped;
    const ttQuote = String(tt.quote ?? '').trim();

    const nextSteps: string[] = [];
    for (const step of (Array.isArray(o.nextSteps) ? o.nextSteps : []).slice(0, 5)) {
        const s = String(step ?? '').trim();
        if (!s) continue;
        if (hasBannedClaim(s)) { dropped++; continue; }
        nextSteps.push(s);
    }

    const verdictRaw = String(ta.verdict ?? '').trim();

    return {
        summary: summary.text,
        taskAchievement: {
            verdict: (VERDICTS.has(verdictRaw) ? verdictRaw : 'partial') as SpeakingReport['taskAchievement']['verdict'],
            comment: taComment.text,
            // 引文对不上就留空，界面上那一行的引用块就不显示 —— 好过挂一句他没说过的话
            quote: quoteIsFromLearner(taQuote, learnerNorm) ? taQuote : '',
        },
        vocabulary: vocab.kept.slice(0, 4),
        grammar: grammar.kept.slice(0, 5),
        turnTaking: {
            comment: ttComment.text,
            quote: quoteIsFromLearner(ttQuote, learnerNorm) ? ttQuote : '',
        },
        targetWords: words,
        nextSteps,
        empty: false,
        droppedPoints: dropped,
    };
}

/** 测试与路由共用：把校验器单独暴露出来 */
export const __internals = { hasBannedClaim, quoteIsFromLearner, normalizeForQuote };

// ---------- 生成报告 ----------

/**
 * 整场练习的第二次（也是最后一次）大模型调用。
 *
 * 没有「每轮偷偷评估一次」的设计：那会让一次实时对话既加钱又加延迟，
 * 而这些判断在这里一次做完就够了。
 */
export async function generateReport(sessionId: number): Promise<SpeakingReport> {
    const session = requireSession(sessionId);
    const turns = listTurns(sessionId);
    const userTurns = turns.filter((t) => t.role === 'user');

    // 一句话都没说，连模型都不用调 —— 没有转录稿，任何评价都是编的
    if (userTurns.length === 0) {
        const empty = sanitizeReport(null, session, turns);
        saveReport(sessionId, empty);
        return empty;
    }

    // 报告是整场练习的收尾，重来一次的代价是把 2500 token 再烧一遍 ——
    // 但让用户对着「请重试」按钮自己点，烧的是同样多的 token 外加一次挫败。
    // 空回复由 chatNonEmpty 兜，抠不出 JSON 的再自己转一圈。
    let parsed: unknown = null;

    for (let attempt = 1; attempt <= LLM_ATTEMPTS; attempt += 1) {
        const text = await chatNonEmpty([
            { role: 'system', content: reportPrompt() },
            {
                role: 'user',
                content: transcriptForReport(
                    session.scenario,
                    turns.map((t) => ({ role: t.role, content: t.content, source: t.source })),
                ),
            },
        ], { temperature: 0.3, maxTokens: 2500 });

        parsed = extractJson<unknown>(text);
        if (parsed !== null) break;
        if (attempt < LLM_ATTEMPTS) await sleepBeforeRetry(attempt);
    }

    if (parsed === null) throw new LlmError('报告没能解析成 JSON，稍后再生成一次');

    const report = sanitizeReport(parsed, session, turns);
    saveReport(sessionId, report);
    return report;
}

function saveReport(sessionId: number, report: SpeakingReport): void {
    const ts = nowIso();
    db().prepare(
        `UPDATE speaking_sessions
         SET report = ?, status = 'finished',
             finished_at = COALESCE(finished_at, ?), updated_at = ?
         WHERE id = ?`,
    ).run(JSON.stringify(report), ts, ts, sessionId);
}

// ---------- 随机场景的去重历史 ----------

export function recentScenarioLabels(limit = 60): string[] {
    const rows = db().prepare(
        'SELECT label FROM speaking_scenario_history ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(limit) as Array<{ label: string }>;
    return rows.map((r) => r.label);
}

export function rememberScenario(label: string): void {
    const clean = label.trim().slice(0, 60);
    if (!clean) return;
    db().prepare('INSERT INTO speaking_scenario_history (label, created_at) VALUES (?, ?)')
        .run(clean, nowIso());
    // 只留最近 100 条，别让去重历史无限长下去把提示词撑爆
    db().prepare(
        `DELETE FROM speaking_scenario_history
         WHERE id NOT IN (
             SELECT id FROM speaking_scenario_history ORDER BY created_at DESC, id DESC LIMIT 100
         )`,
    ).run();
}

export type { Modifiers };
