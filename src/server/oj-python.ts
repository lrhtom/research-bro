// ============================================================
//  OJ · Python 子进程执行器
//
//  出题时要跑两种代码（AI 写的生成器、AI 写的标准解），判题时要跑第三种
//  （你自己写的提交）。三种都**不可信**，所以一律只在子进程里跑 ——
//  这个文件里没有、将来也不要有 eval / require / vm 那一类东西。
//
//  永不 reject：所有异常都折叠进 OjRunResult 的 status 字段，
//  调用方拿到的一定是一个结果对象，不用套 try/catch。
//  判题要按 status 分流出 TLE / RE / SE，抛异常反而把这几种情况揉成一团。
//
//  执行闸门（beginJudgeHold / waitForJudgeIdle）也在这个文件里，见文件末尾。
// ============================================================

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { OjRunPythonOptions, OjRunResult, OjRunStatus } from '../shared/oj.js';
import { OJ_MAX_OUTPUT_BYTES } from '../shared/oj.js';

/** 临时执行目录的根。一次运行一个随机子目录，跑完就删。 */
const RUN_ROOT = path.join(os.tmpdir(), 'toolbox-oj-run');

/**
 * kill 之后 close 事件迟迟不来时的兜底结算时长。
 * 极端情况（进程树没杀干净）下不兜这一手，判题队列会永久悬在那儿。
 */
const KILL_SETTLE_FALLBACK_MS = 10_000;

/** 超过这个年龄的残留目录视为历史泄漏，可以回收 —— 正在跑的目录都很新，不会误删 */
const STALE_RUN_DIR_MS = 6 * 60 * 60 * 1000;

function errMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/**
 * 还活着的子进程登记表，服务退出时兜底清理。
 *
 * 为什么非要有：Windows 上非 detached 的子进程**不会**跟着父进程一起死。
 * 判 TLE 的典型用户代码就是个纯计算死循环 —— 不管它的话，
 * 你 Ctrl+C 关掉工具箱之后，那个 python.exe 会以 100% CPU 一直烧下去。
 */
const liveChildren = new Set<ReturnType<typeof spawn>>();

/** 用 taskkill /T /F 杀整棵进程树（Windows 专用兜底），失败一律静默 */
function taskkillTree(pid: number): void {
    try {
        const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        tk.on('error', () => { /* taskkill 不在或失败都无所谓，这本来就是兜底 */ });
    } catch {
        // 忽略
    }
}

/** 服务退出时调用：把还在跑的 Python 全部终止 */
export function killAllRunningPython(): void {
    for (const proc of [...liveChildren]) {
        try {
            proc.kill();
        } catch {
            // 忽略
        }
        if (process.platform === 'win32' && typeof proc.pid === 'number') {
            taskkillTree(proc.pid);
        }
    }
    liveChildren.clear();
}

// 进程退出时清子进程。exit 里只能做同步的事，而 spawn 本身是同步创建的，
// taskkill 起得来就够了 —— 它自己会活到清理完。
let exitHooked = false;
function hookExitOnce(): void {
    if (exitHooked) return;
    exitHooked = true;
    process.on('exit', killAllRunningPython);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => {
            killAllRunningPython();
            process.exit(0);
        });
    }
}

let sweepStarted = false;

/**
 * 每个进程清扫一次历史残留目录，异步进行不阻塞。
 *
 * 泄漏是怎么来的：kill 兜底结算的那一刻子进程可能还占着 cwd，
 * taskkill 之后句柄也要一会儿才释放，这时 rm 会 EBUSY 失败。
 * 单次失败无所谓，攒上几百次就成了 temp 目录里的一片垃圾。
 */
function sweepStaleRunDirs(): void {
    if (sweepStarted) return;
    sweepStarted = true;
    void (async () => {
        let entries: Dirent[];
        try {
            entries = await readdir(RUN_ROOT, { withFileTypes: true });
        } catch {
            return;   // 目录还不存在，没什么可扫的
        }
        const now = Date.now();
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const dir = path.join(RUN_ROOT, ent.name);
            try {
                const st = await stat(dir);
                if (now - st.mtimeMs > STALE_RUN_DIR_MS) {
                    await rm(dir, { recursive: true, force: true });
                }
            } catch {
                // 单个目录清不掉不影响其余
            }
        }
    })();
}

/**
 * 跑一段 Python：临时目录写 main.py → spawn → 收输出 → 清理。
 *
 * opts.args 会接在脚本名后面（生成器靠 sys.argv[1] 拿随机种子）。
 */
export async function runPython(opts: OjRunPythonOptions): Promise<OjRunResult> {
    hookExitOnce();
    sweepStaleRunDirs();

    const maxOutputBytes = opts.maxOutputBytes ?? OJ_MAX_OUTPUT_BYTES;
    // 每次运行独占一个随机子目录，并发跑的时候才不会互相覆盖 main.py
    const runDir = path.join(RUN_ROOT, randomUUID());

    try {
        await mkdir(runDir, { recursive: true });
        await writeFile(path.join(runDir, 'main.py'), opts.code, 'utf8');
    } catch (e) {
        return {
            status: 'spawn_error',
            stdout: '',
            stderr: `无法创建临时运行目录：${errMessage(e)}`,
            exitCode: null,
            timeMs: 0,
        };
    }

    const result = await new Promise<OjRunResult>((resolve) => {
        const startedAt = performance.now();
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let outputBytes = 0;

        // 超时 / 输出超限 / spawn 失败会抢占最终状态；正常结束时按退出码判
        let statusOverride: OjRunStatus | null = null;
        let spawnErrorHint = '';
        let settled = false;
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

        const settle = (status: OjRunStatus, exitCode: number | null) => {
            if (settled) return;
            settled = true;
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (fallbackTimer) clearTimeout(fallbackTimer);
            resolve({
                status,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: status === 'spawn_error' && spawnErrorHint
                    ? spawnErrorHint
                    : Buffer.concat(stderrChunks).toString('utf8'),
                exitCode,
                timeMs: Math.round(performance.now() - startedAt),
            });
        };

        let child: ReturnType<typeof spawn> | null = null;
        try {
            // -u 关掉缓冲，这样 TLE / RE 之前已经打出来的东西也收得到；
            // 两个 UTF-8 环境变量是为了躲开 Windows 默认 GBK 造成的乱码。
            child = spawn(opts.pythonPath, ['-u', 'main.py', ...(opts.args ?? [])], {
                cwd: runDir,
                windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
            });
        } catch (e) {
            // spawn 同步就抛的场景：pythonPath 是空串之类的非法参数
            spawnErrorHint = `无法启动 Python 进程，请检查设置里的 Python 路径：${errMessage(e)}`;
            settle('spawn_error', null);
        }
        if (child === null) return;

        const proc = child;
        liveChildren.add(proc);

        const killChild = () => {
            try {
                proc.kill();
            } catch {
                // kill 失败交给 taskkill 兜底
            }
            // Windows 上 kill() 不管子进程树（用户代码里再 spawn 就杀不干净），taskkill /T 补一刀
            if (process.platform === 'win32' && typeof proc.pid === 'number') {
                taskkillTree(proc.pid);
            }
            // kill 之后仍然等 close 把输出收全；但进程树杀不掉时必须有个兜底结算
            if (!fallbackTimer) {
                fallbackTimer = setTimeout(
                    () => settle(statusOverride ?? 'runtime_error', null),
                    KILL_SETTLE_FALLBACK_MS,
                );
            }
        };

        timeoutTimer = setTimeout(() => {
            // statusOverride 已经被 output_limit 占了就不覆盖：先到的那个定性，这会儿只是在等 close 收尾
            if (settled || statusOverride !== null) return;
            statusOverride = 'timeout';
            killChild();
        }, opts.timeoutMs);

        // 子进程可能压根不读 stdin 就退出 → 写入端 EPIPE。
        // 必须**先**挂 error 监听，否则那个 EPIPE 会变成未捕获异常把整个服务带走。
        if (proc.stdin) {
            proc.stdin.on('error', () => { /* EPIPE 之类一律忽略 */ });
            try {
                if (opts.stdin !== undefined && opts.stdin.length > 0) {
                    proc.stdin.write(opts.stdin);
                }
                // 不管有没有 stdin 都要 end，不然用户代码里的 read() 会一直等 EOF
                proc.stdin.end();
            } catch {
                // 同步写异常同样忽略
            }
        }

        const onData = (chunks: Buffer[]) => (buf: Buffer) => {
            if (settled) return;
            outputBytes += buf.length;
            chunks.push(buf);
            if (outputBytes > maxOutputBytes && statusOverride === null) {
                statusOverride = 'output_limit';
                killChild();
            }
        };
        proc.stdout?.on('data', onData(stdoutChunks));
        proc.stderr?.on('data', onData(stderrChunks));

        proc.on('error', (err) => {
            // 典型场景：python 路径不存在（ENOENT）。这时 close 可能不再触发，只能就地结算。
            liveChildren.delete(proc);
            if (statusOverride !== null) return;   // 已经在 timeout / output_limit 那条路上了
            statusOverride = 'spawn_error';
            spawnErrorHint = `无法启动 Python（${errMessage(err)}）。`
                + '请在 OJ 设置里检查 Python 路径，比如 python、py，或者 C:\\Python312\\python.exe';
            settle('spawn_error', null);
        });

        // 用 close 而不是 exit：exit 触发时 stdio 可能还没读完，close 才保证输出收全
        proc.on('close', (code) => {
            liveChildren.delete(proc);
            if (statusOverride !== null) {
                settle(statusOverride, code);
            } else if (code === 0) {
                settle('ok', code);
            } else {
                settle('runtime_error', code);
            }
        });
    });

    // 清临时目录。Windows 上文件被占着删不掉是常事，忽略即可 —— 上面的清扫会兜住
    await rm(runDir, { recursive: true, force: true }).catch(() => { /* 忽略 */ });

    return result;
}

/** 跑一条短命令收输出，只给 testPython 内部用 */
function captureCommand(
    command: string,
    args: string[],
    timeoutMs: number,
): Promise<{ ok: boolean; text: string }> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (ok: boolean, text: string) => {
            if (settled) return;
            settled = true;
            resolve({ ok, text });
        };

        let child: ReturnType<typeof spawn> | null = null;
        try {
            child = spawn(command, args, { windowsHide: true });
        } catch (e) {
            done(false, errMessage(e));
        }
        if (child === null) return;

        const proc = child;
        const chunks: Buffer[] = [];
        // python2 把 --version 打到 stderr，python3 打到 stdout，两路都收
        proc.stdout?.on('data', (b: Buffer) => chunks.push(b));
        proc.stderr?.on('data', (b: Buffer) => chunks.push(b));
        proc.stdin?.on('error', () => { /* 忽略 */ });
        proc.stdin?.end();

        const timer = setTimeout(() => {
            try { proc.kill(); } catch { /* 忽略 */ }
            done(false, '命令执行超时');
        }, timeoutMs);

        proc.on('error', (err) => {
            clearTimeout(timer);
            done(false, errMessage(err));
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            done(code === 0, Buffer.concat(chunks).toString('utf8').trim());
        });
    });
}

/**
 * 测 Python 能不能用：先 --version 拿版本号，再真跑一次 print('ok')。
 *
 * 两步都要：只看 --version 的话，一个装了但跑不了脚本的 Python 也会显示"可用"，
 * 等到出题跑生成器时才炸，那时候错误信息离原因已经很远了。
 */
export async function testPython(pythonPath: string): Promise<{ ok: boolean; message: string }> {
    try {
        const version = await captureCommand(pythonPath, ['--version'], 10_000);
        if (!version.ok) {
            return {
                ok: false,
                message: `跑不动「${pythonPath} --version」：${version.text || '未知错误'}。请检查 Python 路径。`,
            };
        }

        const startedAt = performance.now();
        const run = await runPython({ pythonPath, code: "print('ok')", timeoutMs: 15_000 });
        const elapsedMs = Math.round(performance.now() - startedAt);

        if (run.status === 'ok' && run.stdout.trim() === 'ok') {
            return { ok: true, message: `${version.text} 可用，跑通了测试脚本（耗时 ${elapsedMs}ms）` };
        }
        if (run.status === 'spawn_error') {
            return { ok: false, message: run.stderr };
        }
        if (run.status === 'timeout') {
            return {
                ok: false,
                message: `找到了 ${version.text}，但跑测试脚本超时了，看看这个 Python 能不能正常执行脚本。`,
            };
        }
        const detail = run.stderr.trim().slice(0, 300);
        return {
            ok: false,
            message: `找到了 ${version.text}，但跑测试脚本失败${detail ? `：${detail}` : '，也没有错误输出'}`,
        };
    } catch (e) {
        return { ok: false, message: `测 Python 的时候自己出错了：${errMessage(e)}` };
    }
}

// ============================================================
//  执行闸门：判题跑的时候，出题那边先别抢 CPU
// ============================================================
//
//  判 TLE 靠的是墙钟计时。而出题管线默认并发 3 个（最多 6 个）Python 子进程，
//  它们跟判题抢 CPU 会让临界解被误判成超时 —— 明明能过的代码，
//  就因为你同时在后台出另一道题而挂了，这种事查都没法查。
//
//  约定：判题持闸期间，出题侧不再**启动新的** Python 任务（已经在跑的自然跑完）。
//  判题永远不等出题，所以不存在互相等待的死锁。

let judgeHolds = 0;
let waiters: Array<() => void> = [];

/** 判题开始跑测试点前调用。跟 endJudgeHold 严格配对，调用方用 try/finally 保证。 */
export function beginJudgeHold(): void {
    judgeHolds += 1;
}

/** 判题跑完（或异常退出）时调用；最后一个判题结束时唤醒所有等着的出题任务 */
export function endJudgeHold(): void {
    judgeHolds = Math.max(0, judgeHolds - 1);
    if (judgeHolds === 0 && waiters.length > 0) {
        const pending = waiters;
        waiters = [];
        for (const resolve of pending) resolve();
    }
}

/** 出题管线每次启动 Python 之前调一下：有判题在跑就等它跑完 */
export function waitForJudgeIdle(): Promise<void> {
    if (judgeHolds === 0) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
}
