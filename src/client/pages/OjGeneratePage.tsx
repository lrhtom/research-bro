// AI 出题。
//
// 表单填完点开始 → 接口立刻返回一个 jobId，任务在**服务端**跑，
// 进度走 SSE 推回来。所以这一页离开也没事，任务照样在跑；
// 回来的时候页面会先问一次 /oj/generate/jobs 把现场接回来。
//
// 进度分三块：阶段步骤条（走到哪一步了）、计划网格（每个测试计划各自的状态）、
// 日志（发生了什么）。三块回答的是三个不同的问题，缺哪一块都会让人对着
// 一个转圈的图标干等。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { KindBadge } from '@/components/oj/Badges';
import { apiOjCancelGenerate, apiOjGenerate, apiOjJobs, apiOjSettings } from '@/lib/api';
import { OJ_SECTIONS } from '@/lib/nav';
import { subscribeOjGen } from '@/lib/oj-stream';
import type {
    OjDifficultyChoice, OjGenJobSnapshot, OjGenPhase, OjGenPlanState, OjGenPlanStatus,
} from '../../shared/oj';
import { OJ_GEN_PHASE_LABELS, OJ_PRESET_TAGS } from '../../shared/oj';

const PHASES: OjGenPhase[] = ['requesting_problem', 'parsing_problem', 'generating_cases', 'saving', 'done'];

const PHASE_SHORT: Record<OjGenPhase, string> = {
    requesting_problem: '命题',
    parsing_problem: '解析',
    generating_cases: '造数据',
    saving: '入库',
    done: '完成',
    failed: '失败',
};

const PLAN_ICON: Record<OjGenPlanStatus, string> = {
    pending: 'fa-clock',
    requesting: 'fa-comment-dots',
    running_generator: 'fa-dice',
    running_solution: 'fa-play',
    retrying: 'fa-rotate',
    ok: 'fa-circle-check',
    failed: 'fa-circle-xmark',
};

const PLAN_TEXT: Record<OjGenPlanStatus, string> = {
    pending: '排队中',
    requesting: '正在问 AI 要生成器',
    running_generator: '正在造输入数据',
    running_solution: '正在跑标准解',
    retrying: '出错了，正在重试',
    ok: '完成',
    failed: '失败',
};

const DIFFICULTY_CHOICES: OjDifficultyChoice[] = ['自动', '简单', '中等', '困难'];

export default function OjGeneratePage() {
    const [prompt, setPrompt] = useState('');
    const [tags, setTags] = useState<string[]>([]);
    const [customTag, setCustomTag] = useState('');
    const [difficulty, setDifficulty] = useState<OjDifficultyChoice>('自动');

    const [job, setJob] = useState<OjGenJobSnapshot | null>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState('');
    const [llmOk, setLlmOk] = useState<boolean | null>(null);

    const logRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => { document.title = 'AI 出题 · 工具箱'; }, []);

    // 没配模型的话，把按钮先禁掉并说清楚去哪儿配 —— 比点下去再报 503 强
    useEffect(() => {
        void apiOjSettings()
            .then((s) => setLlmOk(s.llm.configured))
            .catch(() => setLlmOk(null));
    }, []);

    /** 进页面先把还在跑（或刚跑完）的任务接回来 */
    const restore = useCallback(async () => {
        try {
            const jobs = await apiOjJobs();
            if (jobs.length === 0) return;
            // 多个任务时挑最新开始的那个：这一页一次只显示一个现场
            const latest = [...jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
            setJob(latest);
        } catch { /* 接不回来就当没有，重新出一道也没什么损失 */ }
    }, []);

    useEffect(() => { void restore(); }, [restore]);

    // ---------- 进度 ----------
    const jobIdRef = useRef<string | null>(null);
    jobIdRef.current = job?.jobId ?? null;

    useEffect(() => subscribeOjGen((e) => {
        if (e.jobId !== jobIdRef.current) return;

        setJob((cur) => {
            if (!cur) return cur;
            if (e.type === 'phase') {
                return {
                    ...cur,
                    phase: e.phase,
                    phaseMessage: e.message,
                    ...(e.problemId !== undefined ? { problemId: e.problemId } : {}),
                };
            }
            if (e.type === 'log') {
                return { ...cur, logs: [...cur.logs, e.message].slice(-300) };
            }
            // plan：按 planIndex 覆盖那一格。用下标定位而不是 push ——
            // 服务端一开始就把全量 pending 的计划推过来了，之后都是就地更新
            const plans = [...cur.plans];
            const at = plans.findIndex((p) => p.planIndex === e.plan.planIndex);
            if (at >= 0) plans[at] = e.plan; else plans.push(e.plan);
            return { ...cur, plans };
        });
    }), []);

    // 日志自动滚到底
    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [job?.logs.length]);

    function toggleTag(t: string) {
        setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
    }

    function addCustomTag() {
        const t = customTag.trim();
        if (!t || tags.includes(t)) { setCustomTag(''); return; }
        setTags((cur) => [...cur, t]);
        setCustomTag('');
    }

    async function start() {
        setStarting(true);
        setError('');
        try {
            const { jobId } = await apiOjGenerate({ prompt, tags, difficulty });
            setJob({
                jobId,
                params: { prompt, tags, difficulty },
                phase: 'requesting_problem',
                phaseMessage: OJ_GEN_PHASE_LABELS.requesting_problem,
                plans: [],
                logs: [],
                startedAt: new Date().toISOString(),
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : '起不来');
        } finally {
            setStarting(false);
        }
    }

    async function cancel() {
        if (!job) return;
        if (!window.confirm('取消这次出题吗？已经造好的测试点会一起丢掉。')) return;
        try { await apiOjCancelGenerate(job.jobId); } catch { /* 取消失败下一条 phase 事件会说明情况 */ }
    }

    const running = job !== null && job.phase !== 'done' && job.phase !== 'failed';
    const okPlans = job?.plans.filter((p) => p.status === 'ok').length ?? 0;
    const failedPlans = job?.plans.filter((p) => p.status === 'failed').length ?? 0;

    return (
        <AppShell
            title="AI 出题"
            subtitle="Generate a Problem · 命题 + 造数据全自动"
            sections={OJ_SECTIONS}
            width="wide"
        >
            {!job && (
                <>
                    <p className="u-aside">
                        <i className="fas fa-circle-info" />
                        说一句想练什么，AI 会写出题面、写一份 Python 标准解，再按十来个「测试数据计划」
                        造出几十到上百个测试点 —— 每个点的期望输出都是拿那份标准解**真跑一遍**得来的，
                        所以判题是纯机器判定，跟 AI 觉得你写得好不好没有关系。
                        整个过程要几分钟，起了之后可以离开这一页。
                    </p>

                    {llmOk === false && (
                        <p className="fc-warn">
                            <i className="fas fa-plug-circle-exclamation" /> 还没配大模型。
                            去 <Link to="/tools/speaking">英语口语练习</Link> 页顶部的「AI 模型」面板里加一套
                            （接口地址 + API Key + 模型名），全站共用同一套配置。
                        </p>
                    )}

                    <form
                        className="oj-gen-form"
                        onSubmit={(e) => { e.preventDefault(); void start(); }}
                    >
                        <label className="oj-field">
                            <span>想出一道什么样的题？</span>
                            <textarea
                                rows={4}
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                placeholder={'例：出一道二分答案的题，背景是给流水线分配任务，n 到 2e5\n'
                                    + '例：考单调栈，最好是那种一眼看不出来要用单调栈的\n'
                                    + '例：随便来一道中等难度的图论题'}
                            />
                        </label>

                        <div className="oj-field">
                            <span>算法标签（可多选，会作为命题的核心考点）</span>
                            <div className="oj-tag-picker">
                                {OJ_PRESET_TAGS.map((t) => (
                                    <button
                                        key={t}
                                        type="button"
                                        className={'fc-chip' + (tags.includes(t) ? ' on' : '')}
                                        aria-pressed={tags.includes(t)}
                                        onClick={() => toggleTag(t)}
                                    >
                                        {t}
                                    </button>
                                ))}
                            </div>

                            <div className="oj-custom-tag">
                                <input
                                    value={customTag}
                                    onChange={(e) => setCustomTag(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag(); } }}
                                    placeholder="上面没有的自己加，回车确认"
                                />
                                <button type="button" className="fc-btn" onClick={addCustomTag}>
                                    <i className="fas fa-plus" /> 加
                                </button>
                            </div>

                            {tags.filter((t) => !OJ_PRESET_TAGS.includes(t)).length > 0 && (
                                <div className="oj-tag-picker">
                                    {tags.filter((t) => !OJ_PRESET_TAGS.includes(t)).map((t) => (
                                        <button key={t} type="button" className="fc-chip on" onClick={() => toggleTag(t)}>
                                            {t} <i className="fas fa-xmark" />
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="oj-field">
                            <span>难度</span>
                            <div className="oj-tag-picker">
                                {DIFFICULTY_CHOICES.map((d) => (
                                    <button
                                        key={d}
                                        type="button"
                                        className={'fc-chip' + (difficulty === d ? ' on' : '')}
                                        aria-pressed={difficulty === d}
                                        onClick={() => setDifficulty(d)}
                                    >
                                        {d}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {error && <p className="fc-error">{error}</p>}

                        <div className="oj-gen-actions">
                            <button
                                type="submit"
                                className="u-btn u-btn-primary"
                                disabled={starting || llmOk === false || (!prompt.trim() && tags.length === 0)}
                            >
                                <i className={'fas ' + (starting ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles')} />
                                {' '}开始出题
                            </button>
                            <span className="u-note">
                                {!prompt.trim() && tags.length === 0
                                    ? '至少写一句话，或者选一个标签。'
                                    : '大约要几分钟。起了之后可以去干别的。'}
                            </span>
                        </div>
                    </form>
                </>
            )}

            {job && (
                <div className="oj-gen-progress">
                    {/* 阶段步骤条 */}
                    <ol className={'oj-steps' + (job.phase === 'failed' ? ' is-failed' : '')}>
                        {PHASES.map((p) => {
                            const at = PHASES.indexOf(job.phase);
                            const mine = PHASES.indexOf(p);
                            const state = job.phase === 'failed'
                                ? (mine < at ? 'done' : 'idle')
                                : mine < at ? 'done' : mine === at ? 'now' : 'idle';
                            return (
                                <li key={p} className={'oj-step is-' + state}>
                                    <span className="oj-step-dot">
                                        {state === 'done' && <i className="fas fa-check" />}
                                        {state === 'now' && <i className="fas fa-spinner fa-spin" />}
                                    </span>
                                    <span className="oj-step-label">{PHASE_SHORT[p]}</span>
                                </li>
                            );
                        })}
                    </ol>

                    <p className={'oj-gen-phase' + (job.phase === 'failed' ? ' is-failed' : '')}>
                        {job.phase === 'failed' && <i className="fas fa-circle-xmark" />}
                        {job.phase === 'done' && <i className="fas fa-circle-check" />}
                        {' '}{job.phaseMessage}
                    </p>

                    {/* 计划网格 */}
                    {job.plans.length > 0 && (
                        <>
                            <div className="u-head">
                                <h2><i className="fas fa-vials" /> 测试数据计划</h2>
                                <span className="count u-num">
                                    {okPlans} 成功 · {failedPlans} 失败 · 共 {job.plans.length}
                                </span>
                            </div>
                            <ul className="oj-plan-grid">
                                {job.plans.map((p) => <PlanCard key={p.planIndex} plan={p} />)}
                            </ul>
                        </>
                    )}

                    {/* 日志 */}
                    {job.logs.length > 0 && (
                        <>
                            <div className="u-head"><h2><i className="fas fa-terminal" /> 日志</h2></div>
                            <div className="oj-log" ref={logRef}>
                                {job.logs.map((l, i) => <div key={i} className="oj-log-line">{l}</div>)}
                            </div>
                        </>
                    )}

                    <div className="oj-gen-actions">
                        {running && (
                            <button type="button" className="fc-btn" onClick={() => void cancel()}>
                                <i className="fas fa-stop" /> 取消这次出题
                            </button>
                        )}
                        {job.problemId !== undefined && !running && (
                            <Link className="u-btn u-btn-primary" to={`/tools/oj/${job.problemId}`}>
                                <i className="fas fa-arrow-right" /> 去做这道题
                            </Link>
                        )}
                        {!running && (
                            <button
                                type="button"
                                className="u-btn"
                                onClick={() => { setJob(null); setError(''); }}
                            >
                                <i className="fas fa-wand-magic-sparkles" /> 再出一道
                            </button>
                        )}
                        <Link className="u-btn" to="/tools/oj"><i className="fas fa-list-check" /> 回题库</Link>
                    </div>
                </div>
            )}
        </AppShell>
    );
}

function PlanCard({ plan }: { plan: OjGenPlanState }) {
    const busy = plan.status === 'requesting'
        || plan.status === 'running_generator'
        || plan.status === 'running_solution';

    return (
        <li className={'oj-plan p-' + plan.status} title={plan.message ?? PLAN_TEXT[plan.status]}>
            <span className="oj-plan-icon">
                <i className={'fas ' + PLAN_ICON[plan.status] + (busy ? ' fa-fade' : '')} />
            </span>
            <span className="oj-plan-main">
                <span className="oj-plan-name">{plan.planName}</span>
                <span className="oj-plan-state">
                    {plan.message ?? PLAN_TEXT[plan.status]}
                </span>
            </span>
            <KindBadge kind={plan.kind} />
        </li>
    );
}
