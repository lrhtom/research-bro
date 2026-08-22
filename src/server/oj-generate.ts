// ============================================================
//  OJ · 出题编排
//
//  一次「出题」是这么一串：
//
//    第一步   问 AI 要题面 + 标准解 + 测试数据计划（一次请求，标签分节返回）
//    建题     立刻把题写进库（status=generating），题库页马上能看到「生成中」
//    第二步   每个计划各问一次 AI 要「输入生成器 gen.py」，并发跑
//             ├ 跑 gen.py（带随机种子）拿到一组输入
//             └ 拿这组输入跑标准解，得到期望输出
//    落库     排序、补样例、写测试点、汇总警告、定题目状态
//
//  一个计划能产出**好几个**测试点：同一个生成器换不同的随机种子多跑几次。
//  AI 的请求次数一点没变（每个计划仍然只问一次），本地多跑几趟而已，
//  单题测试点就从个位数放大到上百个。重复的输入会按 SHA1 去重，
//  连着重复几次就判定这个生成器没用种子，提前收工，不白跑。
//
//  跟原来在 Electron 里比，这里换掉了两样：
//    · AI 客户端 → 全站共用的 src/server/llm.ts（模型配置走「大模型档案」）
//    · 进度广播 → SSE（src/server/oj-events.ts）
// ============================================================

import { createHash, randomUUID } from 'node:crypto';
import type {
    OjDifficulty,
    OjGenerateParams,
    OjGenJobSnapshot,
    OjGenPhase,
    OjGenPlanState,
    OjGenPlanStatus,
    OjProblemStatus,
    OjRunResult,
    OjTestPlan,
} from '../shared/oj.js';
import {
    OJ_DEDUP_STOP_AFTER,
    OJ_GEN_GENERATOR_TIMEOUT_MS,
    OJ_GEN_PHASE_LABELS,
    OJ_GEN_SOLUTION_TIMEOUT_MIN_MS,
    OJ_GEN_SOLUTION_TIMEOUT_MULTIPLIER,
    OJ_MAX_TESTCASE_INPUT_BYTES,
    OJ_MAX_TOTAL_CASES,
    OJ_PLAN_MAX_RETRIES,
} from '../shared/oj.js';
import { chatNonEmpty, llmStatus } from './llm.js';
import { emitGenEvent } from './oj-events.js';
import { buildGeneratorPrompts, buildProblemPrompts } from './oj-prompts.js';
import { parseGeneratorResponse, parseProblemResponse } from './oj-parse.js';
import { runPython, waitForJudgeIdle } from './oj-python.js';
import { getOjSettings, insertProblem, insertTestCase, updateProblem } from './oj-store.js';

/**
 * 已结束的任务在内存里留多久。
 *
 * 留一会儿是有用的：页面刚好错过 done 事件再重新挂载时，还能把结果捞回来。
 * 尤其是「第一步就失败了、题库里压根没有这条记录」的情况 ——
 * 那个失败原因只存在于这里，丢了就再也说不清为什么没出成。
 */
const FINISHED_JOB_TTL_MS = 5 * 60_000;

/** 单个任务留多少行日志，免得长任务把快照撑爆 */
const MAX_LOG_LINES = 300;

/** 第一步最多试几次（含第一次） */
const PROBLEM_MAX_ATTEMPTS = 2;

/**
 * 给两步 AI 请求的 token 上限。
 *
 * 必须显式给：llm.ts 的默认值是 2000，那是给对话轮设计的，
 * 而第一步要一口气吐出题面 + 标准解 + 十来个计划，2000 会被硬生生截断，
 * 表现是 <plans> 分节缺一半、解析报「缺少必需分节」——
 * 看起来像模型不听话，其实是我们没给够。
 */
const PROBLEM_MAX_TOKENS = 16_000;
const GENERATOR_MAX_TOKENS = 8_000;

// ---------------- 内存态 ----------------

interface JobState {
    jobId: string;
    params: OjGenerateParams;
    phase: OjGenPhase;
    phaseMessage: string;
    problemId?: number;
    problemTitle?: string;
    plans: OjGenPlanState[];
    logs: string[];
    startedAt: string;
    cancelled: boolean;
    /** 取消时用来掐断在途的 AI 请求，所有请求共用这一个信号 */
    abort: AbortController;
    finishedAt?: number;
}

/** 一个成功产出的测试点。saving 阶段统一排序落库。 */
interface CaseOutcome {
    planIndex: number;
    plan: OjTestPlan;
    /** 展示名：一个计划产出多个点时带 #k 后缀 */
    name: string;
    input: string;
    output: string;
    generatorCode: string;
    /** 可能在 saving 阶段被「没有样例」的兜底改写，所以跟 plan.isSample 分开存 */
    isSample: boolean;
}

interface PlanFailure {
    planIndex: number;
    plan: OjTestPlan;
    reason: string;
}

type PlanResult = { outcomes: CaseOutcome[]; failReason?: string };

/** 用户取消专用的异常，跟真失败区分开 —— 别把「我不想出了」记成「出题失败」 */
class CancelledError extends Error {
    constructor() {
        super('用户取消');
        this.name = 'CancelledError';
    }
}

/** Python 环境本身的问题（路径填错之类）。换个生成器代码重试毫无意义，直接停。 */
class EnvError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EnvError';
    }
}

const jobs = new Map<string, JobState>();

// ---------------- 小工具 ----------------

function throwIfCancelled(job: { cancelled: boolean }): void {
    if (job.cancelled) throw new CancelledError();
}

function errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 取末尾片段 —— Python traceback 的关键信息（异常类型与行号）都在最后 */
function tail(s: string, max: number): string {
    const t = s.trim();
    return t.length > max ? `…${t.slice(-max)}` : t;
}

/** 输入去重的指纹。同一个计划多跑几次要是产出一样的输入，就该丢掉。 */
function hashInput(s: string): string {
    return createHash('sha1').update(s).digest('hex');
}

function clampConcurrency(n: number): number {
    const v = Number.isFinite(n) ? Math.floor(n) : 3;
    return Math.min(6, Math.max(1, v));
}

/** 用户选的标签排前面 —— 那是他明确的意图，AI 补的排后面 */
function mergeTags(userTags: string[], aiTags: string[]): string[] {
    const merged = new Set<string>();
    for (const t of [...userTags, ...aiTags]) {
        const v = t.trim();
        if (v) merged.add(v);
    }
    return [...merged].slice(0, 10);
}

/**
 * 一个极简的并发池：固定几条「泳道」抢着取下一个下标。
 *
 * worker 内部已经全兜底了，这里再包一层 try —— 单个计划出意外
 * 绝不能把整个池子拖垮，剩下的计划还得接着跑。
 */
async function runPool<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let cursor = 0;
    const width = Math.max(1, Math.min(concurrency, items.length));
    const lanes: Promise<void>[] = [];

    for (let i = 0; i < width; i++) {
        lanes.push((async () => {
            for (;;) {
                const index = cursor;
                cursor += 1;
                if (index >= items.length) return;
                try {
                    await worker(items[index], index);
                } catch (e) {
                    console.error('[oj] 计划 worker 漏出异常（已兜底）', e);
                }
            }
        })());
    }
    await Promise.all(lanes);
}

/** 问一次 AI。把 system + user 这一对翻成 llm.ts 的消息数组。 */
async function ask(
    system: string,
    user: string,
    maxTokens: number,
    signal: AbortSignal,
): Promise<string> {
    return chatNonEmpty(
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        // 温度压到 0.6：出题要的是听话和可解析，不是天马行空
        { temperature: 0.6, maxTokens, signal },
    );
}

// ---------------- 结果校验 ----------------
//
//  这两个函数抛出的错误文本会被**原样贴回给 AI** 让它修，
//  所以每一句都要写成「模型看得懂、并且知道该怎么改」的样子，
//  而不是 "generator failed" 这种只有我们自己看得懂的话。

/** 校验生成器跑出来的东西，返回那组输入 */
function checkGeneratorRun(run: OjRunResult): string {
    if (run.status === 'spawn_error') throw new EnvError(run.stderr || 'Python 环境不可用');

    if (run.status === 'timeout') {
        throw new Error(
            `生成器运行超过 ${OJ_GEN_GENERATOR_TIMEOUT_MS / 1000} 秒被强制终止；`
            + `请优化生成效率（例如先拼好列表再用 '\\n'.join 一次性输出）`,
        );
    }
    if (run.status === 'output_limit') {
        throw new Error('生成器输出超过体积上限，请显著减小生成的数据规模');
    }
    if (run.status === 'runtime_error') {
        throw new Error(
            `生成器运行出错（退出码 ${run.exitCode ?? '未知'}）：${tail(run.stderr, 400) || '无错误输出'}`,
        );
    }

    const input = run.stdout;
    if (!input.trim()) throw new Error('生成器运行成功但没有向标准输出打印任何数据');

    const bytes = Buffer.byteLength(input, 'utf8');
    if (bytes > OJ_MAX_TESTCASE_INPUT_BYTES) {
        throw new Error(
            `生成的输入数据 ${bytes} 字节，超过上限 ${OJ_MAX_TESTCASE_INPUT_BYTES} 字节，请减小数据规模`,
        );
    }
    return input;
}

/** 校验标准解跑出来的东西，返回期望输出 */
function checkSolutionRun(run: OjRunResult, stdTimeoutMs: number): string {
    if (run.status === 'spawn_error') throw new EnvError(run.stderr || 'Python 环境不可用');

    if (run.status === 'timeout') {
        throw new Error(
            `标准解在 ${stdTimeoutMs}ms（题目时限的 ${OJ_GEN_SOLUTION_TIMEOUT_MULTIPLIER} 倍）内没跑完这组输入，`
            + '说明数据规模超出了标准解能承受的范围，请减小本计划的数据规模',
        );
    }
    if (run.status === 'output_limit') {
        throw new Error('标准解输出超过体积上限，请减小数据规模');
    }
    if (run.status === 'runtime_error') {
        throw new Error(
            `标准解在这组输入上运行出错（退出码 ${run.exitCode ?? '未知'}）：`
            + `${tail(run.stderr, 400) || '无错误输出'}。`
            + '多半是生成的数据不满足题目约束，请让数据严格符合输入格式与数据范围',
        );
    }
    if (!run.stdout.trim()) {
        throw new Error('标准解在这组输入上没有产生任何输出，请检查数据是否符合题目约束');
    }
    return run.stdout;
}

// ---------------- 事件与快照 ----------------

function setPhase(job: JobState, phase: OjGenPhase, message: string): void {
    job.phase = phase;
    job.phaseMessage = message;
    emitGenEvent({
        jobId: job.jobId,
        type: 'phase',
        phase,
        message,
        ...(job.problemId !== undefined ? { problemId: job.problemId } : {}),
    });
}

function setPlan(job: JobState, planIndex: number, status: OjGenPlanStatus, message?: string): void {
    const p = job.plans[planIndex];
    if (!p) return;
    p.status = status;
    p.message = message;
    emitGenEvent({ jobId: job.jobId, type: 'plan', plan: { ...p } });
}

function pushLog(job: JobState, message: string): void {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
    job.logs.push(line);
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    emitGenEvent({ jobId: job.jobId, type: 'log', message: line });
}

function snapshot(job: JobState): OjGenJobSnapshot {
    return {
        jobId: job.jobId,
        params: { ...job.params, tags: [...job.params.tags] },
        phase: job.phase,
        phaseMessage: job.phaseMessage,
        ...(job.problemId !== undefined ? { problemId: job.problemId } : {}),
        ...(job.problemTitle !== undefined ? { problemTitle: job.problemTitle } : {}),
        plans: job.plans.map((p) => ({ ...p })),
        logs: [...job.logs],
        startedAt: job.startedAt,
    };
}

function prune(): void {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finishedAt !== undefined && now - job.finishedAt > FINISHED_JOB_TTL_MS) {
            jobs.delete(id);
        }
    }
}

// ---------------- 单个测试点 ----------------

/** 跑一次「生成器（带种子）→ 标准解」，产出一个测试点。任一步失败就抛。 */
async function produceOneCase(
    job: JobState,
    pythonPath: string,
    generatorCode: string,
    solutionCode: string,
    stdTimeoutMs: number,
    plan: OjTestPlan,
    planIndex: number,
    seed: number,
): Promise<CaseOutcome> {
    // 有判题在跑就先等着 —— 抢 CPU 会让判题的墙钟计时失真，把好代码判成 TLE
    await waitForJudgeIdle();
    throwIfCancelled(job);

    const genRun = await runPython({
        pythonPath,
        code: generatorCode,
        args: [String(seed)],   // 生成器从 sys.argv[1] 读种子：换个种子就是另一组数据
        timeoutMs: OJ_GEN_GENERATOR_TIMEOUT_MS,
    });
    throwIfCancelled(job);
    const input = checkGeneratorRun(genRun);

    await waitForJudgeIdle();
    throwIfCancelled(job);

    const solRun = await runPython({
        pythonPath,
        code: solutionCode,
        stdin: input,
        timeoutMs: stdTimeoutMs,
    });
    throwIfCancelled(job);
    const output = checkSolutionRun(solRun, stdTimeoutMs);

    return { planIndex, plan, name: plan.name, input, output, generatorCode, isSample: plan.isSample };
}

// ---------------- 单个计划 ----------------

/**
 * 跑一个计划，产出 count 个测试点。**永不抛异常**，失败都折进返回值。
 *
 * 分两个阶段：先带重试拿到一个能跑通的生成器（顺带得到第一个测试点），
 * 再换种子多跑几次追加。追加阶段容错很宽 —— 个别种子失败跳过就是了，
 * 已经拿到手的测试点不会因此作废。
 */
async function runPlan(
    job: JobState,
    pythonPath: string,
    statementMd: string,
    solutionCode: string,
    timeLimitMs: number,
    stdTimeoutMs: number,
    plan: OjTestPlan,
    planIndex: number,
    budget: { used: number; max: number },
): Promise<PlanResult> {
    const target = Math.max(1, plan.count ?? 1);
    // 每个计划独占一段种子空间，免得不同计划的种子撞在一起产出重复数据
    const seedBase = planIndex * 100000;

    // ---- 阶段 1：拿到一个能跑通的生成器 + 第一个测试点 ----
    let generatorCode: string | null = null;
    let firstOutcome: CaseOutcome | null = null;
    let previousError: string | undefined;

    for (let attempt = 0; attempt <= OJ_PLAN_MAX_RETRIES; attempt++) {
        if (job.cancelled) return { outcomes: [], failReason: '用户取消' };
        try {
            setPlan(job, planIndex, 'requesting');
            const pair = buildGeneratorPrompts({
                statementMd,
                timeLimitMs,
                plan,
                ...(previousError !== undefined ? { previousError } : {}),
            });
            const reply = await ask(pair.system, pair.user, GENERATOR_MAX_TOKENS, job.abort.signal);
            throwIfCancelled(job);

            const code = parseGeneratorResponse(reply);
            setPlan(job, planIndex, 'running_generator');
            firstOutcome = await produceOneCase(
                job, pythonPath, code, solutionCode, stdTimeoutMs, plan, planIndex, seedBase + attempt,
            );
            generatorCode = code;
            break;
        } catch (e) {
            if (job.cancelled || e instanceof CancelledError) return { outcomes: [], failReason: '用户取消' };
            previousError = errText(e);
            pushLog(job, `计划「${plan.name}」第 ${attempt + 1} 次尝试失败：${truncate(previousError, 200)}`);
            // Python 都起不来的话，换多少次生成器代码都是同一个结果
            if (e instanceof EnvError) break;
            if (attempt < OJ_PLAN_MAX_RETRIES) {
                setPlan(job, planIndex, 'retrying', truncate(previousError, 300));
            }
        }
    }

    if (!generatorCode || !firstOutcome) {
        const reason = previousError ?? '未知原因';
        setPlan(job, planIndex, 'failed', truncate(reason, 300));
        return { outcomes: [], failReason: reason };
    }

    // ---- 阶段 2：换种子多跑，去重 + 预算 + 早停 ----
    const outcomes: CaseOutcome[] = [firstOutcome];
    const seen = new Set<string>([hashInput(firstOutcome.input)]);
    budget.used += 1;

    let dupStreak = 0;
    let errStreak = 0;

    for (let i = 1; i < target; i++) {
        if (job.cancelled) break;
        if (budget.used >= budget.max) {
            pushLog(job, `已到单题测试点总量上限 ${budget.max}，计划「${plan.name}」停止追加`);
            break;
        }

        setPlan(job, planIndex, 'running_solution', `已生成 ${outcomes.length}/${target} 个测试点`);
        try {
            const outcome = await produceOneCase(
                job, pythonPath, generatorCode, solutionCode, stdTimeoutMs,
                plan, planIndex, seedBase + 1000 + i,
            );

            const h = hashInput(outcome.input);
            if (seen.has(h)) {
                dupStreak += 1;
                if (dupStreak >= OJ_DEDUP_STOP_AFTER) {
                    pushLog(
                        job,
                        `计划「${plan.name}」的生成器疑似没用上随机种子（连着产出重复数据），`
                        + `在 ${outcomes.length} 个测试点处停下`,
                    );
                    break;
                }
                continue;
            }

            dupStreak = 0;
            errStreak = 0;
            seen.add(h);
            outcomes.push(outcome);
            budget.used += 1;
        } catch (e) {
            if (job.cancelled || e instanceof CancelledError) break;
            if (e instanceof EnvError) break;
            // 个别种子失败可以容忍（跳过就是）；连着失败说明这生成器不稳，别耗了
            errStreak += 1;
            pushLog(
                job,
                `计划「${plan.name}」追加第 ${outcomes.length + 1} 个测试点失败：${truncate(errText(e), 160)}`,
            );
            if (errStreak >= 3) break;
        }
    }

    // 多个点的时候给展示名加 #k 后缀，测试数据表格里才分得清
    if (outcomes.length > 1) {
        outcomes.forEach((o, k) => { o.name = `${plan.name} #${k + 1}`; });
    }

    setPlan(job, planIndex, 'ok', `共 ${outcomes.length} 个测试点`);
    return { outcomes };
}

// ---------------- 整个任务 ----------------

async function runJob(job: JobState): Promise<void> {
    // 设置在任务开头快照一次：跑到一半改设置不影响这一次
    const settings = getOjSettings();
    const concurrency = clampConcurrency(settings.genConcurrency);

    try {
        // ---- 1. 第一步命题 ----
        setPhase(job, 'requesting_problem', OJ_GEN_PHASE_LABELS.requesting_problem);
        const model = llmStatus();
        pushLog(
            job,
            `任务启动（模型 ${model.alias || model.model || '未配置'}，并发 ${concurrency}，`
            + `Python ${settings.pythonPath}）`,
        );

        let parsed: ReturnType<typeof parseProblemResponse> | null = null;
        let lastError = '';

        for (let attempt = 0; attempt < PROBLEM_MAX_ATTEMPTS && parsed === null; attempt++) {
            throwIfCancelled(job);
            if (attempt > 0) {
                setPhase(job, 'requesting_problem', '第一次命题没成，正在重试…');
                pushLog(job, `第一次命题失败（${truncate(lastError, 200)}），进行第 ${attempt + 1} 次尝试`);
            }
            try {
                const pair = buildProblemPrompts(job.params);
                // 纠错提示在这里拼、不进 prompts 模板：它属于重试策略，跟模板本身无关
                const user = attempt === 0
                    ? pair.user
                    : `${pair.user}\n\n【注意】上一次的输出没能通过解析：${truncate(lastError, 300)}。`
                        + '请严格按规定的标签分节格式完整重新输出。';

                const reply = await ask(pair.system, user, PROBLEM_MAX_TOKENS, job.abort.signal);
                throwIfCancelled(job);

                setPhase(job, 'parsing_problem', OJ_GEN_PHASE_LABELS.parsing_problem);
                parsed = parseProblemResponse(reply);
            } catch (e) {
                throwIfCancelled(job);
                lastError = errText(e);
            }
        }

        if (parsed === null) {
            throw new Error(`AI 命题失败（已重试 ${PROBLEM_MAX_ATTEMPTS - 1} 次）：${lastError}`);
        }
        const problem = parsed;

        /**
         * 检查测试计划的种类覆盖。
         *
         * 提示词只能"要求"，约束不了模型。缺 large 意味着复杂度劣一档的解法
         * 也能拿满分 —— 那这道题的判题就是失真的，必须显式告警，
         * 不能让判题的正确性静默地劣化下去。
         */
        const kindCoverageWarnings: string[] = [];
        {
            const planKinds = new Set(problem.plans.map((p) => p.kind));
            if (!planKinds.has('large')) {
                kindCoverageWarnings.push(
                    '测试计划里没有 large（大数据 / 时间复杂度边界）类，卡不掉复杂度劣一档的解法',
                );
            }
            if (!planKinds.has('boundary')) {
                kindCoverageWarnings.push(
                    '测试计划里没有 boundary（边界数据）类，n=1、极值这些边界情形可能没覆盖到',
                );
            }
            for (const w of kindCoverageWarnings) pushLog(job, `警告：${w}`);
        }

        // ---- 2. 立刻建题，题库页马上能看到「生成中」 ----
        throwIfCancelled(job);
        // 用户明确选了难度就以用户为准（模型偶尔不听话）；选「自动」才用它判的
        const difficulty: OjDifficulty = job.params.difficulty === '自动'
            ? problem.difficulty
            : job.params.difficulty;

        const problemId = insertProblem({
            type: 'algo',
            title: problem.title,
            difficulty,
            tags: mergeTags(job.params.tags, problem.tags),
            statementMd: problem.statementMd,
            solutionCode: problem.solutionCode,
            solutionLang: 'python',
            timeLimitMs: problem.timeLimitMs,
            memoryLimitMb: problem.memoryLimitMb,
            status: 'generating',
            genPrompt: job.params.prompt,
            genWarnings: kindCoverageWarnings,
        });

        job.problemId = problemId;
        job.problemTitle = problem.title;
        setPhase(job, 'parsing_problem', `题目「${problem.title}」已创建`);
        pushLog(
            job,
            `命题成功：「${problem.title}」（难度 ${difficulty}，时限 ${problem.timeLimitMs}ms，`
            + `测试计划 ${problem.plans.length} 个）`,
        );

        // 先把全量 pending 的计划广播出去：生成页要先拿到完整的计划网格，
        // 再看着各个计划一个个亮起来。不然格子是一个个冒出来的，看着很乱
        job.plans = problem.plans.map((p, i): OjGenPlanState => ({
            planIndex: i,
            planName: p.name,
            kind: p.kind,
            status: 'pending',
        }));
        for (const p of job.plans) {
            emitGenEvent({ jobId: job.jobId, type: 'plan', plan: { ...p } });
        }

        // ---- 3. 并发生成测试点 ----
        throwIfCancelled(job);
        setPhase(
            job,
            'generating_cases',
            `正在并发生成 ${problem.plans.length} 个计划的测试点（并发 ${concurrency}）…`,
        );

        const stdTimeoutMs = Math.max(
            problem.timeLimitMs * OJ_GEN_SOLUTION_TIMEOUT_MULTIPLIER,
            OJ_GEN_SOLUTION_TIMEOUT_MIN_MS,
        );

        const successes: CaseOutcome[] = [];
        const failures: PlanFailure[] = [];
        // 总量预算跨计划共享，防止在慢盘上把生成和判题的耗时拖到失控
        const budget = { used: 0, max: OJ_MAX_TOTAL_CASES };

        await runPool(problem.plans, concurrency, async (plan, planIndex) => {
            const r = await runPlan(
                job, settings.pythonPath, problem.statementMd, problem.solutionCode,
                problem.timeLimitMs, stdTimeoutMs, plan, planIndex, budget,
            );
            if (r.outcomes.length > 0) {
                successes.push(...r.outcomes);
                const bytes = r.outcomes.reduce((s, o) => s + Buffer.byteLength(o.input, 'utf8'), 0);
                pushLog(
                    job,
                    `计划「${plan.name}」完成：${r.outcomes.length} 个测试点（合计输入 ${bytes} 字节）`,
                );
            } else {
                failures.push({ planIndex, plan, reason: r.failReason ?? '未知原因' });
            }
        });
        throwIfCancelled(job);

        // ---- 4. 汇总落库 ----
        setPhase(job, 'saving', OJ_GEN_PHASE_LABELS.saving);
        // 建题时写进去的覆盖警告要留着：这一步会整体覆写 genWarnings
        const warnings: string[] = [...kindCoverageWarnings];

        // 一个样例都没有的兜底：详情页得有样例可看，把最小的那个点改标成样例。
        // 挑最小的是因为样例是给人看的，几万个数的样例等于没有。
        if (successes.length > 0 && !successes.some((c) => c.isSample)) {
            const preferred = successes.filter((c) => c.plan.kind === 'small' || c.plan.kind === 'boundary');
            const candidates = preferred.length > 0 ? preferred : successes;
            let smallest = candidates[0];
            for (const c of candidates) {
                if (Buffer.byteLength(c.input, 'utf8') < Buffer.byteLength(smallest.input, 'utf8')) {
                    smallest = c;
                }
            }
            smallest.isSample = true;
            warnings.push(`样例类测试点全都没生成出来，已自动把测试点「${smallest.name}」标成样例`);
        }

        // 排序：样例在前，组内保持计划的原顺序
        const ordered = [...successes].sort(
            (a, b) => Number(b.isSample) - Number(a.isSample) || a.planIndex - b.planIndex,
        );
        ordered.forEach((c, i) => {
            insertTestCase({
                problemId,
                idx: i + 1,
                kind: c.plan.kind,
                planName: c.name,
                planDesc: c.plan.description,
                isSample: c.isSample,
                input: c.input,
                output: c.output,
                generatorCode: c.generatorCode,
            });
        });

        failures.sort((a, b) => a.planIndex - b.planIndex);
        for (const f of failures) {
            warnings.push(`测试计划「${f.plan.name}」生成失败：${truncate(f.reason, 200)}`);
        }

        const status: OjProblemStatus = successes.length === 0
            ? 'failed'
            : failures.length > 0 ? 'partial' : 'ready';
        updateProblem(problemId, { status, genWarnings: warnings });

        // ---- 5. 收尾 ----
        if (status === 'failed') {
            setPhase(job, 'failed', '所有测试点都没生成出来，题目已标记为失败（原因见题目警告）');
        } else {
            const okPlans = problem.plans.length - failures.length;
            const extra = status === 'partial' ? `（${failures.length} 个计划失败，已记进警告）` : '';
            setPhase(
                job,
                'done',
                `题目「${problem.title}」生成完成：${successes.length} 个测试点`
                + `（${okPlans}/${problem.plans.length} 个计划成功）${extra}`,
            );
        }
        pushLog(
            job,
            `任务结束：${successes.length} 个测试点，${failures.length} 个计划失败，题目状态 ${status}`,
        );
    } catch (e) {
        const cancelled = job.cancelled || e instanceof CancelledError;
        const reason = cancelled ? '用户取消' : errText(e);
        if (!cancelled) console.error('[oj] 出题任务失败', e);

        // 已经建了题就得把它标成 failed —— 不然库里会永远躺着一条 generating，
        // 列表上点不进去也删不明白
        if (job.problemId !== undefined) {
            try {
                updateProblem(job.problemId, {
                    status: 'failed',
                    genWarnings: [cancelled ? '用户取消了生成' : `生成失败：${truncate(reason, 300)}`],
                });
            } catch (dbErr) {
                console.error('[oj] 标记题目失败状态时又出错了', dbErr);
            }
        }
        setPhase(job, 'failed', cancelled ? '已取消生成任务' : `生成失败：${truncate(reason, 300)}`);
    } finally {
        job.finishedAt = Date.now();
    }
}

// ---------------- 对外 ----------------

export function startGeneration(params: OjGenerateParams): { jobId: string } {
    prune();

    const job: JobState = {
        jobId: randomUUID(),
        params: { ...params, tags: [...params.tags] },
        phase: 'requesting_problem',
        phaseMessage: OJ_GEN_PHASE_LABELS.requesting_problem,
        plans: [],
        logs: [],
        startedAt: new Date().toISOString(),
        cancelled: false,
        abort: new AbortController(),
    };
    jobs.set(job.jobId, job);

    // 故意不 await：接口立刻返回 jobId，任务在后台跑，进度走 SSE。
    // runJob 内部已经全兜底了，这里再保一层险。
    void runJob(job).catch((e) => console.error('[oj] runJob 漏出异常（已兜底）', e));

    return { jobId: job.jobId };
}

export function cancelGeneration(jobId: string): boolean {
    const job = jobs.get(jobId);
    // 已经结束的任务不能取消 —— 否则会把一道已经出好的题改写成 failed
    if (!job || job.finishedAt !== undefined || job.cancelled) return false;

    job.cancelled = true;
    try {
        job.abort.abort();
    } catch {
        // abort 出错无所谓，cancelled 标志已经生效了
    }
    pushLog(job, '收到取消请求，正在停下…');
    return true;
}

/**
 * 列出内存里的任务（含 TTL 内刚结束的）。
 *
 * 已结束的也返回，是为了让页面在错过 done / failed 事件之后重新挂载时
 * 还能看到结果或失败原因 —— 详见 FINISHED_JOB_TTL_MS 那段注释。
 */
export function listActiveJobs(): OjGenJobSnapshot[] {
    prune();
    return [...jobs.values()].map(snapshot);
}
