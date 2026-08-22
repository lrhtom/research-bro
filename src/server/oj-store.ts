// ============================================================
//  OJ · 数据访问层
//
//  行 ↔ 领域对象的转换全部收在这里（snake_case ↔ camelCase、JSON 列的
//  容错解析），模块外不碰任何 SQL。
//
//  JSON 列一律**解析失败就回退默认值，绝不抛异常**。库文件是本机的一个
//  普通文件，你完全可能拿别的工具打开它改坏一行；一条坏数据不该让整个
//  题库列表接口 500。同理，从库里读出来的枚举值都要过一遍白名单函数 ——
//  前端的徽章组件假设 verdict 一定是那八个值之一。
// ============================================================

import { db, getSetting, nowIso, setSetting } from './db.js';
import type {
    OjCaseResult,
    OjDifficulty,
    OjLanguageId,
    OjProblem,
    OjProblemListItem,
    OjProblemQuery,
    OjProblemStatus,
    OjProblemType,
    OjSettings,
    OjSubmission,
    OjSubmissionQuery,
    OjTestCase,
    OjTestCaseKind,
    OjTestCaseMeta,
    OjVerdict,
} from '../shared/oj.js';
import { OJ_DEFAULT_SETTINGS } from '../shared/oj.js';

/** 测试点列表里预览截取多少字符 */
const PREVIEW_CHARS = 200;

// ---------------- 行类型 ----------------

interface ProblemRow {
    id: number;
    type: string;
    title: string;
    difficulty: string;
    tags: string;
    statement_md: string;
    solution_code: string;
    solution_lang: string;
    time_limit_ms: number;
    memory_limit_mb: number;
    is_favorite: number;
    status: string;
    gen_prompt: string;
    gen_warnings: string;
    created_at: string;
    updated_at: string;
}

interface ProblemListRow {
    id: number;
    type: string;
    title: string;
    difficulty: string;
    tags: string;
    is_favorite: number;
    status: string;
    created_at: string;
    test_case_count: number;
    submission_count: number;
    solved: number;
}

interface TestCaseRow {
    id: number;
    problem_id: number;
    idx: number;
    kind: string;
    plan_name: string;
    plan_desc: string;
    is_sample: number;
    input: string;
    output: string;
    generator_code: string;
    input_bytes: number;
    output_bytes: number;
}

interface TestCaseMetaRow {
    id: number;
    problem_id: number;
    idx: number;
    kind: string;
    plan_name: string;
    plan_desc: string;
    is_sample: number;
    input_bytes: number;
    output_bytes: number;
    input_preview: string;
    output_preview: string;
}

interface SubmissionRow {
    id: number;
    problem_id: number;
    language: string;
    code: string;
    verdict: string;
    score: number;
    time_ms: number | null;
    case_results: string;
    created_at: string;
    problem_title?: string | null;
}

// ---------------- 容错转换 ----------------

function parseStringArray(text: string | null | undefined): string[] {
    if (!text) return [];
    try {
        const v: unknown = JSON.parse(text);
        return Array.isArray(v) ? v.map((x) => String(x)) : [];
    } catch {
        return [];
    }
}

const VALID_VERDICTS: readonly OjVerdict[] = [
    'AC', 'WA', 'TLE', 'RE', 'CE', 'SE', 'JUDGING', 'PENDING',
];

function toDifficulty(v: string): OjDifficulty {
    return v === '简单' || v === '中等' || v === '困难' ? v : '中等';
}

function toStatus(v: string): OjProblemStatus {
    return v === 'generating' || v === 'ready' || v === 'partial' || v === 'failed' ? v : 'ready';
}

function toKind(v: string): OjTestCaseKind {
    return v === 'sample' || v === 'boundary' || v === 'small' || v === 'large' || v === 'special'
        ? v
        : 'special';
}

function toVerdict(v: string): OjVerdict {
    return (VALID_VERDICTS as readonly string[]).includes(v) ? (v as OjVerdict) : 'SE';
}

function toLanguage(v: string): OjLanguageId {
    return v === 'python' || v === 'cpp' || v === 'javascript' || v === 'typescript' || v === 'go'
        ? v
        : 'python';
}

function toType(v: string): OjProblemType {
    return v === 'web' ? 'web' : 'algo';
}

/**
 * 逐个元素校验形状，而不是 JSON.parse 完就直接当数组用。
 *
 * 这一列存的是判题结果，前端会拿 verdict 去查徽章配色、拿 timeMs 去格式化。
 * 少一个字段就是一次 `undefined.toFixed`，整页白屏。宁可丢掉坏的那一条。
 */
function parseCaseResults(text: string | null | undefined): OjCaseResult[] {
    if (!text) return [];
    let v: unknown;
    try {
        v = JSON.parse(text);
    } catch {
        return [];
    }
    if (!Array.isArray(v)) return [];

    const out: OjCaseResult[] = [];
    for (const item of v) {
        if (typeof item !== 'object' || item === null) continue;
        const o = item as Record<string, unknown>;
        if (!(VALID_VERDICTS as readonly string[]).includes(o.verdict as string)) continue;
        if (typeof o.caseId !== 'number' || typeof o.idx !== 'number' || typeof o.timeMs !== 'number') continue;
        out.push({
            caseId: o.caseId,
            idx: o.idx,
            kind: toKind(typeof o.kind === 'string' ? o.kind : ''),
            verdict: o.verdict as OjVerdict,
            timeMs: o.timeMs,
            ...(typeof o.message === 'string' ? { message: o.message } : {}),
        });
    }
    return out;
}

/** LIKE 里的 % 和 _ 是通配符，用户搜索词必须转义后配 ESCAPE '\' 用 */
function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// ---------------- 行映射 ----------------

function mapProblem(r: ProblemRow): OjProblem {
    return {
        id: r.id,
        type: toType(r.type),
        title: r.title,
        difficulty: toDifficulty(r.difficulty),
        tags: parseStringArray(r.tags),
        statementMd: r.statement_md,
        solutionCode: r.solution_code,
        solutionLang: r.solution_lang,
        timeLimitMs: r.time_limit_ms,
        memoryLimitMb: r.memory_limit_mb,
        isFavorite: !!r.is_favorite,
        status: toStatus(r.status),
        genPrompt: r.gen_prompt,
        genWarnings: parseStringArray(r.gen_warnings),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function mapTestCase(r: TestCaseRow): OjTestCase {
    return {
        id: r.id,
        problemId: r.problem_id,
        idx: r.idx,
        kind: toKind(r.kind),
        planName: r.plan_name,
        planDesc: r.plan_desc,
        isSample: !!r.is_sample,
        input: r.input,
        output: r.output,
        generatorCode: r.generator_code,
        inputBytes: r.input_bytes,
        outputBytes: r.output_bytes,
    };
}

function mapTestCaseMeta(r: TestCaseMetaRow): OjTestCaseMeta {
    return {
        id: r.id,
        problemId: r.problem_id,
        idx: r.idx,
        kind: toKind(r.kind),
        planName: r.plan_name,
        planDesc: r.plan_desc,
        isSample: !!r.is_sample,
        inputBytes: r.input_bytes,
        outputBytes: r.output_bytes,
        inputPreview: r.input_preview,
        outputPreview: r.output_preview,
    };
}

function mapSubmission(r: SubmissionRow): OjSubmission {
    return {
        id: r.id,
        problemId: r.problem_id,
        ...(r.problem_title ? { problemTitle: r.problem_title } : {}),
        language: toLanguage(r.language),
        code: r.code,
        verdict: toVerdict(r.verdict),
        score: r.score,
        timeMs: r.time_ms ?? null,
        caseResults: parseCaseResults(r.case_results),
        createdAt: r.created_at,
    };
}

// ---------------- 题目 ----------------

export interface NewOjProblem {
    type: OjProblemType;
    title: string;
    difficulty: OjDifficulty;
    tags: string[];
    statementMd: string;
    solutionCode: string;
    solutionLang: string;
    timeLimitMs: number;
    memoryLimitMb: number;
    status: OjProblemStatus;
    genPrompt: string;
    genWarnings: string[];
}

export function insertProblem(p: NewOjProblem): number {
    const now = nowIso();
    const info = db().prepare(
        `INSERT INTO oj_problems
           (type, title, difficulty, tags, statement_md, solution_code, solution_lang,
            time_limit_ms, memory_limit_mb, status, gen_prompt, gen_warnings, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
        p.type, p.title, p.difficulty, JSON.stringify(p.tags), p.statementMd,
        p.solutionCode, p.solutionLang, p.timeLimitMs, p.memoryLimitMb,
        p.status, p.genPrompt, JSON.stringify(p.genWarnings), now, now,
    );
    return Number(info.lastInsertRowid);
}

/** 允许改的字段 → 列名 / 要不要 JSON 序列化。白名单之外的键一律忽略。 */
const PROBLEM_PATCH_FIELDS: Record<string, { col: string; json?: boolean }> = {
    title: { col: 'title' },
    statementMd: { col: 'statement_md' },
    status: { col: 'status' },
    genWarnings: { col: 'gen_warnings', json: true },
    timeLimitMs: { col: 'time_limit_ms' },
    memoryLimitMb: { col: 'memory_limit_mb' },
    tags: { col: 'tags', json: true },
    difficulty: { col: 'difficulty' },
};

export type OjProblemPatch = Partial<Pick<
    OjProblem,
    'title' | 'statementMd' | 'status' | 'genWarnings' | 'timeLimitMs' | 'memoryLimitMb' | 'tags' | 'difficulty'
>>;

export function updateProblem(id: number, patch: OjProblemPatch): void {
    const sets: string[] = [];
    const params: (string | number)[] = [];

    for (const [key, value] of Object.entries(patch)) {
        const field = PROBLEM_PATCH_FIELDS[key];
        if (!field || value === undefined) continue;
        sets.push(`${field.col} = ?`);
        params.push(field.json ? JSON.stringify(value) : (value as string | number));
    }
    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    db().prepare(`UPDATE oj_problems SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function listProblems(q: OjProblemQuery): { items: OjProblemListItem[]; total: number } {
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 20)));

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (q.search) {
        where.push(`p.title LIKE ? ESCAPE '\\'`);
        params.push('%' + escapeLike(q.search) + '%');
    }
    if (q.tag) {
        // tags 是 JSON 数组的序列化文本，按带引号的 "标签" 匹配 ——
        // 序列化后每个标签两侧都有引号，这么配就不会把「树」匹配到「树状数组」上
        where.push(`p.tags LIKE ? ESCAPE '\\'`);
        params.push('%"' + escapeLike(q.tag) + '"%');
    }
    if (q.favoriteOnly) where.push('p.is_favorite = 1');

    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const totalRow = db()
        .prepare(`SELECT COUNT(*) AS c FROM oj_problems p ${whereSql}`)
        .get(...params) as { c: number };

    const rows = db().prepare(`
        SELECT p.id, p.type, p.title, p.difficulty, p.tags, p.is_favorite, p.status, p.created_at,
               (SELECT COUNT(*) FROM oj_test_cases t  WHERE t.problem_id = p.id) AS test_case_count,
               (SELECT COUNT(*) FROM oj_submissions s WHERE s.problem_id = p.id) AS submission_count,
               EXISTS(SELECT 1 FROM oj_submissions s2
                       WHERE s2.problem_id = p.id AND s2.verdict = 'AC')        AS solved
        FROM oj_problems p
        ${whereSql}
        ORDER BY p.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as ProblemListRow[];

    const items: OjProblemListItem[] = rows.map((r) => ({
        id: r.id,
        type: toType(r.type),
        title: r.title,
        difficulty: toDifficulty(r.difficulty),
        tags: parseStringArray(r.tags),
        isFavorite: !!r.is_favorite,
        status: toStatus(r.status),
        testCaseCount: r.test_case_count,
        solved: !!r.solved,
        submissionCount: r.submission_count,
        createdAt: r.created_at,
    }));

    return { items, total: totalRow.c };
}

export function getProblem(id: number): OjProblem | null {
    const row = db().prepare('SELECT * FROM oj_problems WHERE id = ?').get(id) as ProblemRow | undefined;
    return row ? mapProblem(row) : null;
}

/** 测试点与提交靠外键 ON DELETE CASCADE 一起走（db.ts 里已经开了 foreign_keys） */
export function deleteProblem(id: number): boolean {
    return db().prepare('DELETE FROM oj_problems WHERE id = ?').run(id).changes > 0;
}

/** 返回切换之后的新状态；题目不存在返回 null */
export function toggleFavorite(id: number): boolean | null {
    const row = db().prepare('SELECT is_favorite FROM oj_problems WHERE id = ?').get(id) as
        | { is_favorite: number }
        | undefined;
    if (!row) return null;

    const next = row.is_favorite ? 0 : 1;
    db().prepare('UPDATE oj_problems SET is_favorite = ? WHERE id = ?').run(next, id);
    return next === 1;
}

/** 题库里出现过的全部标签，按出现次数从多到少。生成页和筛选下拉都用它。 */
export function listAllTags(): Array<{ tag: string; count: number }> {
    const rows = db().prepare('SELECT tags FROM oj_problems').all() as Array<{ tags: string }>;
    const counter = new Map<string, number>();
    for (const r of rows) {
        for (const t of parseStringArray(r.tags)) {
            counter.set(t, (counter.get(t) ?? 0) + 1);
        }
    }
    return [...counter.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
}

// ---------------- 测试点 ----------------

export interface NewOjTestCase {
    problemId: number;
    idx: number;
    kind: OjTestCaseKind;
    planName: string;
    planDesc: string;
    isSample: boolean;
    input: string;
    output: string;
    generatorCode: string;
}

export function insertTestCase(tc: NewOjTestCase): number {
    const info = db().prepare(
        `INSERT INTO oj_test_cases
           (problem_id, idx, kind, plan_name, plan_desc, is_sample,
            input, output, generator_code, input_bytes, output_bytes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
        tc.problemId, tc.idx, tc.kind, tc.planName, tc.planDesc, tc.isSample ? 1 : 0,
        tc.input, tc.output, tc.generatorCode,
        // 体积在写入时算好：列表页要显示它，而正文可能有几 MB，
        // 每次列表都 length(input) 一遍等于把整题的数据读一遍
        Buffer.byteLength(tc.input, 'utf8'),
        Buffer.byteLength(tc.output, 'utf8'),
    );
    return Number(info.lastInsertRowid);
}

/** 列表用：只取预览，不把几 MB 的正文拉下来 */
export function listTestCaseMetas(problemId: number): OjTestCaseMeta[] {
    const rows = db().prepare(
        `SELECT id, problem_id, idx, kind, plan_name, plan_desc, is_sample,
                input_bytes, output_bytes,
                substr(input, 1, ?)  AS input_preview,
                substr(output, 1, ?) AS output_preview
         FROM oj_test_cases WHERE problem_id = ? ORDER BY idx ASC`,
    ).all(PREVIEW_CHARS, PREVIEW_CHARS, problemId) as TestCaseMetaRow[];
    return rows.map(mapTestCaseMeta);
}

/** 判题用：要全量正文 */
export function listTestCasesFull(problemId: number): OjTestCase[] {
    const rows = db().prepare(
        'SELECT * FROM oj_test_cases WHERE problem_id = ? ORDER BY idx ASC',
    ).all(problemId) as TestCaseRow[];
    return rows.map(mapTestCase);
}

export function getSampleCases(problemId: number): OjTestCase[] {
    const rows = db().prepare(
        'SELECT * FROM oj_test_cases WHERE problem_id = ? AND is_sample = 1 ORDER BY idx ASC',
    ).all(problemId) as TestCaseRow[];
    return rows.map(mapTestCase);
}

export function getTestCase(id: number): OjTestCase | null {
    const row = db().prepare('SELECT * FROM oj_test_cases WHERE id = ?').get(id) as TestCaseRow | undefined;
    return row ? mapTestCase(row) : null;
}

// ---------------- 提交 ----------------

export function insertSubmission(s: { problemId: number; language: OjLanguageId; code: string }): number {
    const info = db().prepare(
        'INSERT INTO oj_submissions (problem_id, language, code, created_at) VALUES (?,?,?,?)',
    ).run(s.problemId, s.language, s.code, nowIso());
    return Number(info.lastInsertRowid);
}

export function updateSubmission(
    id: number,
    patch: { verdict: OjVerdict; score: number; timeMs: number | null; caseResults: OjCaseResult[] },
): void {
    db().prepare(
        'UPDATE oj_submissions SET verdict = ?, score = ?, time_ms = ?, case_results = ? WHERE id = ?',
    ).run(patch.verdict, patch.score, patch.timeMs, JSON.stringify(patch.caseResults), id);
}

/**
 * 列表项也把完整代码与逐点结果带回来。
 *
 * 看着浪费，但这是自己一个人用的量级（一天几十条提交），一次拉全换来的是
 * 展开某一条时零延迟、也不用维护「这条的代码加载了没有」这种状态。
 */
export function listSubmissions(q: OjSubmissionQuery): { items: OjSubmission[]; total: number } {
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(q.pageSize ?? 20)));

    const hasProblem = typeof q.problemId === 'number';
    const whereSql = hasProblem ? 'WHERE s.problem_id = ?' : '';
    const params: number[] = hasProblem ? [q.problemId as number] : [];

    const totalRow = db()
        .prepare(`SELECT COUNT(*) AS c FROM oj_submissions s ${whereSql}`)
        .get(...params) as { c: number };

    const rows = db().prepare(`
        SELECT s.*, p.title AS problem_title
        FROM oj_submissions s LEFT JOIN oj_problems p ON p.id = s.problem_id
        ${whereSql}
        ORDER BY s.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as SubmissionRow[];

    return { items: rows.map(mapSubmission), total: totalRow.c };
}

export function getSubmission(id: number): OjSubmission | null {
    const row = db().prepare(
        `SELECT s.*, p.title AS problem_title
         FROM oj_submissions s LEFT JOIN oj_problems p ON p.id = s.problem_id
         WHERE s.id = ?`,
    ).get(id) as SubmissionRow | undefined;
    return row ? mapSubmission(row) : null;
}

// ---------------- 设置 ----------------
//
//  只有两项，直接搭全站通用的 settings 表，不再单开一张。
//  接口地址 / key / 模型名不在这儿 —— 那是「大模型档案」的事。

const K_PYTHON = 'oj_python_path';
const K_CONCURRENCY = 'oj_gen_concurrency';

export function getOjSettings(): OjSettings {
    const raw = Number(getSetting(K_CONCURRENCY));
    return {
        pythonPath: getSetting(K_PYTHON) || OJ_DEFAULT_SETTINGS.pythonPath,
        genConcurrency: Number.isFinite(raw) && raw >= 1 && raw <= 6
            ? Math.floor(raw)
            : OJ_DEFAULT_SETTINGS.genConcurrency,
    };
}

export function saveOjSettings(patch: Partial<OjSettings>): OjSettings {
    if (patch.pythonPath !== undefined) {
        // 空串回落到 'python'：一个空的 Python 路径只会让每次 spawn 都失败，
        // 而失败信息（ENOENT ''）完全看不出是设置被清空了
        setSetting(K_PYTHON, String(patch.pythonPath).trim().slice(0, 400) || OJ_DEFAULT_SETTINGS.pythonPath);
    }
    if (patch.genConcurrency !== undefined) {
        const n = Math.floor(Number(patch.genConcurrency));
        setSetting(K_CONCURRENCY, String(Number.isFinite(n) ? Math.min(6, Math.max(1, n)) : 3));
    }
    return getOjSettings();
}
