// ============================================================
//  OJ · 判题
//
//  逐个测试点跑一遍你的代码，比对输出，汇总落库，全程往 SSE 上报进度。
//
//  两条不能破的规矩：
//
//    1. **全部测试点跑完，不提前终止**。第 3 个点就 WA 了也要把剩下的跑完 ——
//       你要看到的是「哪些过了哪些没过」，不是「在第 3 个点停下了」。
//       总评取第一个非 AC 的判定，得分按通过比例算。
//    2. **同一时刻只跑一个判题任务**。TLE 判定靠的是墙钟计时，两个判题
//       并行会互相抢 CPU，本来能过的代码就被判超时了。用一条模块级的
//       promise 链排队，先到先跑。
// ============================================================

import type {
    OjCaseResult,
    OjJudgeSubmitParams,
    OjLanguageId,
    OjRunResult,
    OjTestCase,
    OjVerdict,
} from '../shared/oj.js';
import { OJ_LANGUAGES } from '../shared/oj.js';
import { emitJudgeEvent } from './oj-events.js';
import { beginJudgeHold, endJudgeHold, runPython } from './oj-python.js';
import { getOjSettings, getProblem, listTestCasesFull, updateSubmission } from './oj-store.js';

/** RE 的时候把 stderr 尾部截多少字符 —— Python traceback 的关键信息在最后 */
const STDERR_TAIL_CHARS = 300;

/** 输出比对里，不一致的那一行两边各显示多少字符 */
const DIFF_TRUNCATE_LEN = 80;

// ---------------- 输出比对 ----------------

/**
 * 把输出切成规范化后的行数组。
 *
 * 规范化三条：CRLF 统一成 LF、每行去掉行尾空白、去掉结尾的空行。
 * 都是「肉眼看不出区别、但字节不同」的情况 —— Windows 上打印出来的
 * 换行和 Linux 不一样，print 完最后多一个换行更是家常便饭，
 * 这几样判 WA 属于误伤。
 */
function normalizeLines(text: string): string[] {
    // 行尾用 /\s+$/ 一起 trim，顺手把 \r 吃掉；先统一换行是防着孤零零的 \r
    const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.replace(/\s+$/u, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

function truncate(s: string): string {
    return s.length > DIFF_TRUNCATE_LEN ? `${s.slice(0, DIFF_TRUNCATE_LEN)}…` : s;
}

/**
 * 比对期望输出与实际输出。
 *
 * 不等的时候一定要给出**第一处**不同在第几行、两边各是什么 ——
 * 只说一句「答案错误」，等于让你把几百行输出自己 diff 一遍。
 */
export function compareOutput(expected: string, actual: string): { equal: boolean; message?: string } {
    const exp = normalizeLines(expected);
    const act = normalizeLines(actual);

    const maxLen = Math.max(exp.length, act.length);
    for (let i = 0; i < maxLen; i++) {
        const e = i < exp.length ? exp[i] : undefined;
        const a = i < act.length ? act[i] : undefined;
        if (e === a) continue;

        const lineNo = i + 1;
        if (e === undefined) {
            return {
                equal: false,
                message: `第 ${lineNo} 行不一致：期望的输出已经结束，实际还多出「${truncate(a ?? '')}」`
                    + `（期望共 ${exp.length} 行，实际 ${act.length} 行）`,
            };
        }
        if (a === undefined) {
            return {
                equal: false,
                message: `第 ${lineNo} 行不一致：期望「${truncate(e)}」，实际输出已经结束`
                    + `（期望共 ${exp.length} 行，实际 ${act.length} 行）`,
            };
        }
        return {
            equal: false,
            message: `第 ${lineNo} 行不一致：期望「${truncate(e)}」，实际「${truncate(a)}」`,
        };
    }

    return { equal: true };
}

// ---------------- 语言 ----------------

export function languageAvailable(id: OjLanguageId): boolean {
    return OJ_LANGUAGES.find((l) => l.id === id)?.available ?? false;
}

/**
 * 跑一段某语言的代码。
 *
 * 目前只有 Python 真能跑。其余语言在 OJ_LANGUAGES 里 available: false，
 * 前端就选不中它们，这里的兜底只是防御 —— 有人直接打接口也不会崩。
 *
 * 将来加 C++ / Go 要在这儿分出「编译 + 运行」两段，编译失败映射成 CE：
 *   cpp: g++ -O2 -std=c++17 -o main.exe main.cpp  然后跑 main.exe
 *   go:  go build -o main.exe main.go             （go run 会把编译时间算进去，计时不准）
 */
function runInLanguage(
    id: OjLanguageId,
    opts: { pythonPath: string; code: string; stdin: string; timeoutMs: number },
): Promise<OjRunResult> {
    if (id === 'python') {
        return runPython({
            pythonPath: opts.pythonPath,
            code: opts.code,
            stdin: opts.stdin,
            timeoutMs: opts.timeoutMs,
        });
    }
    return Promise.resolve({
        status: 'spawn_error',
        stdout: '',
        stderr: '这个语言还没支持',
        exitCode: null,
        timeMs: 0,
    });
}

// ---------------- 判题队列 ----------------

/**
 * 全局 FIFO 队列。判题一个一个来，理由见文件头第 2 条。
 *
 * 用 promise 链而不是数组 + 循环：链天然保序，而且 await 一个任务
 * 就等于等到它前面的全跑完。
 */
let judgeQueueTail: Promise<void> = Promise.resolve();

/** 单点的运行结果 → 判定 */
function toCaseResult(tc: OjTestCase, run: OjRunResult): OjCaseResult {
    const base = { caseId: tc.id, idx: tc.idx, kind: tc.kind, timeMs: run.timeMs };

    switch (run.status) {
        case 'ok': {
            const cmp = compareOutput(tc.output, run.stdout);
            return cmp.equal
                ? { ...base, verdict: 'AC' }
                : { ...base, verdict: 'WA', ...(cmp.message ? { message: cmp.message } : {}) };
        }
        case 'timeout':
            return { ...base, verdict: 'TLE', message: '超时被终止' };
        case 'runtime_error': {
            const tail = run.stderr.trim().slice(-STDERR_TAIL_CHARS);
            return {
                ...base,
                verdict: 'RE',
                message: tail || `进程异常退出（退出码 ${run.exitCode ?? '未知'}）`,
            };
        }
        case 'output_limit':
            return { ...base, verdict: 'RE', message: '输出超过体积上限，已终止' };
        case 'spawn_error':
            // 这不是你的代码的错，是环境起不来 —— 单独判 SE，别让人以为是自己写错了
            return { ...base, verdict: 'SE', message: run.stderr };
    }
}

/** 排队判题。返回的 promise 在这一次判题真正跑完时兑现。 */
export function judgeSubmission(submissionId: number, params: OjJudgeSubmitParams): Promise<void> {
    const task = judgeQueueTail.then(() => doJudge(submissionId, params));
    // 链上把异常吞掉，保证前一个任务失败不会把链断掉、后面排队的还能跑
    judgeQueueTail = task.catch(() => { /* doJudge 内部已经兜底，这里只护住链 */ });
    return task;
}

async function doJudge(submissionId: number, params: OjJudgeSubmitParams): Promise<void> {
    /**
     * 任何提前失败都要收敛成「SE 落库 + done 事件」。
     *
     * 不这么做的话，提交会永远停在 PENDING —— 页面上转着圈等一个
     * 再也不会来的结果，而库里也看不出发生过什么。
     */
    const failAsSystemError = (reason: string) => {
        try {
            updateSubmission(submissionId, { verdict: 'SE', score: 0, timeMs: null, caseResults: [] });
        } catch {
            // 库都写不进去了，只能靠事件通知前端
        }
        console.error(`[oj] 提交 ${submissionId} 判为系统错误：${reason}`);
        emitJudgeEvent({ submissionId, type: 'done', verdict: 'SE', score: 0, timeMs: null });
    };

    try {
        const problem = getProblem(params.problemId);
        if (!problem) { failAsSystemError('题目不存在或已经被删了'); return; }

        if (!languageAvailable(params.language)) { failAsSystemError('这个语言还没支持'); return; }

        const cases = listTestCasesFull(params.problemId);
        if (cases.length === 0) { failAsSystemError('这道题一个测试点都没有，没法评测'); return; }

        emitJudgeEvent({ submissionId, type: 'start', total: cases.length });

        // Python 路径开跑时读一次就够了；判题中途改设置不影响这一次
        const settings = getOjSettings();
        const results: OjCaseResult[] = [];

        // 判题期间持闸：出题那边暂停启动新的 Python 子进程，免得抢 CPU 把 TLE 判歪
        beginJudgeHold();
        try {
            for (let i = 0; i < cases.length; i++) {
                const tc = cases[i];
                const run = await runInLanguage(params.language, {
                    pythonPath: settings.pythonPath,
                    code: params.code,
                    stdin: tc.input,
                    timeoutMs: problem.timeLimitMs,
                });
                const result = toCaseResult(tc, run);
                results.push(result);
                emitJudgeEvent({ submissionId, type: 'case', caseIndex: i, total: cases.length, result });
            }
        } finally {
            endJudgeHold();
        }

        const firstBad = results.find((r) => r.verdict !== 'AC');
        const verdict: OjVerdict = firstBad ? firstBad.verdict : 'AC';
        const passed = results.filter((r) => r.verdict === 'AC').length;
        const score = Math.round((passed / results.length) * 100);
        const timeMs = results.reduce((max, r) => Math.max(max, r.timeMs), 0);

        updateSubmission(submissionId, { verdict, score, timeMs, caseResults: results });
        emitJudgeEvent({ submissionId, type: 'done', verdict, score, timeMs });
    } catch (e) {
        failAsSystemError(e instanceof Error ? e.message : String(e));
    }
}
