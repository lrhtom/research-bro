// 题目详情：左边题面，右边写代码交题。
//
// 左右分栏、各自滚动。这是刷题页最该有的形状 —— 写代码时要能随时回头看
// 数据范围，上下堆着的话每看一眼都要滚一趟。窄屏下自动叠成上下两块。
//
// 判题进度走 SSE：提交之后接口立刻返回一个 submissionId，逐点结果
// 一个个推过来。所以离开这一页再回来，判题不会中断 —— 它在服务端跑。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { DifficultyBadge, StatusBadge, VerdictBadge } from '@/components/oj/Badges';
import CaseResultGrid from '@/components/oj/CaseResultGrid';
import CodeEditor from '@/components/oj/CodeEditor';
import SampleBlock from '@/components/oj/SampleBlock';
import Statement from '@/components/oj/Statement';
import TestcasesTab from '@/components/oj/TestcasesTab';
import { apiOjJudge, apiOjProblem, apiOjSubmissions, apiOjToggleFavorite } from '@/lib/api';
import { dateText, msText } from '@/lib/format';
import { OJ_SECTIONS } from '@/lib/nav';
import { subscribeOjJudge } from '@/lib/oj-stream';
import type {
    OjCaseResult, OjJudgeProgressEvent, OjLanguageId, OjProblem, OjSubmission,
    OjTestCase, OjVerdict,
} from '../../shared/oj';
import { OJ_LANGUAGES } from '../../shared/oj';

type Tab = 'statement' | 'testcases' | 'submissions';

/** 草稿按「题 + 语言」分别存：同一道题用两种语言写的东西不该互相覆盖 */
function draftKey(problemId: number, lang: OjLanguageId): string {
    return `oj.draft.${problemId}.${lang}`;
}

export default function OjProblemPage() {
    const { problemId } = useParams();
    const id = Number(problemId);
    const navigate = useNavigate();

    const [problem, setProblem] = useState<OjProblem | null>(null);
    const [samples, setSamples] = useState<OjTestCase[]>([]);
    const [error, setError] = useState('');
    const [tab, setTab] = useState<Tab>('statement');
    const [showSolution, setShowSolution] = useState(false);

    const [language, setLanguage] = useState<OjLanguageId>('python');
    const [code, setCode] = useState('');

    // 本次判题的现场
    const [submitting, setSubmitting] = useState(false);
    const [judgingId, setJudgingId] = useState<number | null>(null);
    const [results, setResults] = useState<OjCaseResult[]>([]);
    const [totalCases, setTotalCases] = useState(0);
    const [verdict, setVerdict] = useState<OjVerdict | null>(null);
    const [score, setScore] = useState(0);
    const [timeMs, setTimeMs] = useState<number | null>(null);

    const [mySubs, setMySubs] = useState<OjSubmission[] | null>(null);

    // ---------- 拉题 ----------
    useEffect(() => {
        if (!Number.isInteger(id) || id <= 0) { setError('题目不存在'); return; }
        let alive = true;
        void apiOjProblem(id)
            .then((r) => {
                if (!alive) return;
                setProblem(r.problem);
                setSamples(r.samples);
                document.title = `${r.problem.title} · 算法题库`;
            })
            .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : '题目读不出来'); });
        return () => { alive = false; };
    }, [id]);

    // ---------- 草稿 ----------
    useEffect(() => {
        if (!Number.isInteger(id) || id <= 0) return;
        let saved: string | null = null;
        try { saved = localStorage.getItem(draftKey(id, language)); } catch { /* 隐私模式下没有 localStorage */ }
        setCode(saved ?? OJ_LANGUAGES.find((l) => l.id === language)?.template ?? '');
    }, [id, language]);

    useEffect(() => {
        if (!Number.isInteger(id) || id <= 0 || !code) return;
        // 每次改都写一遍 localStorage 就行 —— 它是同步的，几 KB 的字符串开销可以忽略，
        // 而防抖会让「刚敲完就关标签页」丢掉最后那几秒的东西
        try { localStorage.setItem(draftKey(id, language), code); } catch { /* 写不进去就算了 */ }
    }, [id, language, code]);

    // ---------- 本题提交 ----------
    const loadMySubs = useCallback(async () => {
        if (!Number.isInteger(id) || id <= 0) return;
        try {
            setMySubs((await apiOjSubmissions({ problemId: id, pageSize: 30 })).items);
        } catch { /* 拉不到就空着，不打断做题 */ }
    }, [id]);

    useEffect(() => { if (tab === 'submissions') void loadMySubs(); }, [tab, loadMySubs]);

    // ---------- 判题进度 ----------
    //
    // 这里有个不盯着看就发现不了的时序坑。
    //
    // 判题接口是「先把活派下去、再回响应」：路由里 void judgeSubmission(...)
    // 之后才 res.json({submissionId})。判题在下一个微任务就开跑并推出 start，
    // 而那时候 202 响应还没走完网络回到浏览器 —— 也就是说，
    // **start（乃至前几个 case）完全可能比 submissionId 先到**。
    //
    // 而过滤条件是 e.submissionId === 我这一条，id 还没拿到时无从比对，
    // 那几帧就被静默丢掉了。症状极隐蔽：总评和得分照样对（它们来自 done
    // 事件和服务端），只有那个格子网格少几格 —— 41 个测试点画出 40 格，
    // 谁会去数？（实测就是这么发现的。）
    //
    // 所以：id 还没拿到、但确实有一次提交在路上时，先把事件存起来，
    // 拿到 id 再回放。另外在 done 时拿服务端那份权威记录对一次账，
    // 中途万一还漏了帧（SSE 断线重连之类）也能自愈。
    const judgingIdRef = useRef<number | null>(null);
    /** 提交已发出、还没拿到 submissionId 的那段空档里到达的事件 */
    const pendingRef = useRef<OjJudgeProgressEvent[]>([]);
    const awaitingRef = useRef(false);

    const applyJudgeEvent = useCallback((e: OjJudgeProgressEvent) => {
        if (e.type === 'start') {
            setTotalCases(e.total);
            setResults([]);
            setVerdict('JUDGING');
        } else if (e.type === 'case') {
            setResults((cur) => [...cur, e.result]);
        } else if (e.type === 'done') {
            setVerdict(e.verdict);
            setScore(e.score);
            setTimeMs(e.timeMs);
            judgingIdRef.current = null;
            setJudgingId(null);
            // 拿服务端那份权威的逐点结果覆盖一遍。这一趟本来就要打
            // （「本题提交」那一栏要刷新），顺手把网格对平，不额外多一次请求。
            void apiOjSubmissions({ problemId: id, pageSize: 30 })
                .then((r) => {
                    setMySubs(r.items);
                    const mine = r.items.find((s) => s.id === e.submissionId);
                    if (mine && mine.caseResults.length > 0) {
                        setResults(mine.caseResults);
                        setTotalCases(mine.caseResults.length);
                    }
                })
                .catch(() => { /* 对不上账就保持流式那一份，不打断做题 */ });
        }
    }, [id]);

    useEffect(() => subscribeOjJudge((e) => {
        const mine = judgingIdRef.current;
        if (mine === null) {
            // 还不知道自己是哪一条。有提交在路上就先存着，等 id 到了回放
            if (awaitingRef.current) pendingRef.current.push(e);
            return;
        }
        // 全站共用一条流，别的页面提交的判题也会推过来 —— 只认自己这一条
        if (e.submissionId !== mine) return;
        applyJudgeEvent(e);
    }), [applyJudgeEvent]);

    async function submit() {
        if (!problem || submitting || judgingId !== null) return;
        setSubmitting(true);
        setError('');
        setResults([]);
        setVerdict(null);
        setScore(0);
        setTimeMs(null);

        pendingRef.current = [];
        awaitingRef.current = true;
        try {
            const r = await apiOjJudge({ problemId: problem.id, language, code });

            // 同步写 ref，不等 React 渲染 —— 中间每一帧都要认得出自己
            judgingIdRef.current = r.submissionId;
            awaitingRef.current = false;
            setJudgingId(r.submissionId);
            setVerdict('PENDING');

            // 回放空档期攒下的那几帧，顺序不变
            const buffered = pendingRef.current.filter((x) => x.submissionId === r.submissionId);
            pendingRef.current = [];
            buffered.forEach(applyJudgeEvent);
        } catch (e) {
            awaitingRef.current = false;
            pendingRef.current = [];
            setError(e instanceof Error ? e.message : '提交失败');
        } finally {
            setSubmitting(false);
        }
    }

    async function toggleFav() {
        if (!problem) return;
        setProblem({ ...problem, isFavorite: !problem.isFavorite });
        try { await apiOjToggleFavorite(problem.id); } catch { /* 翻回去太吵，下次进页面自然会对上 */ }
    }

    const passed = useMemo(() => results.filter((r) => r.verdict === 'AC').length, [results]);
    const judging = judgingId !== null;

    if (error && !problem) {
        return (
            <AppShell title="算法题库" subtitle="Algorithm Problem Bank" sections={OJ_SECTIONS}>
                <p className="fc-error">{error}</p>
                <Link className="u-btn" to="/tools/oj"><i className="fas fa-arrow-left" /> 回题库</Link>
            </AppShell>
        );
    }

    if (!problem) {
        return (
            <AppShell title="算法题库" subtitle="Algorithm Problem Bank" sections={OJ_SECTIONS}>
                <p className="u-note"><i className="fas fa-spinner fa-spin" /> 正在读题…</p>
            </AppShell>
        );
    }

    return (
        <AppShell
            title={problem.title}
            subtitle="Algorithm Problem Bank"
            sections={OJ_SECTIONS}
            actions={
                <>
                    <button type="button" className="u-btn" onClick={() => void toggleFav()}>
                        <i className={(problem.isFavorite ? 'fas' : 'far') + ' fa-star'} />
                        {problem.isFavorite ? ' 已收藏' : ' 收藏'}
                    </button>
                    <button type="button" className="u-btn" onClick={() => navigate('/tools/oj')}>
                        <i className="fas fa-arrow-left" /> 回题库
                    </button>
                </>
            }
        >
            <div className="oj-split">
                {/* ---------------- 左：题面 ---------------- */}
                <section className="oj-pane oj-pane-left">
                    <div className="oj-prob-head">
                        <DifficultyBadge difficulty={problem.difficulty} />
                        <StatusBadge status={problem.status} />
                        <span className="oj-limit u-num">
                            <i className="fas fa-stopwatch" /> {problem.timeLimitMs} ms
                        </span>
                        <span className="oj-limit u-num">
                            <i className="fas fa-memory" /> {problem.memoryLimitMb} MB
                        </span>
                        {problem.tags.map((t) => <span key={t} className="oj-tag">{t}</span>)}
                    </div>

                    {problem.genWarnings.length > 0 && (
                        <details className="oj-warnings">
                            <summary>
                                <i className="fas fa-triangle-exclamation" />
                                生成时有 {problem.genWarnings.length} 条警告
                            </summary>
                            <ul>{problem.genWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                        </details>
                    )}

                    <div className="oj-tabs" role="tablist">
                        {([
                            ['statement', '题目', 'fa-file-lines'],
                            ['testcases', '测试数据', 'fa-vials'],
                            ['submissions', '本题提交', 'fa-clock-rotate-left'],
                        ] as const).map(([key, label, icon]) => (
                            <button
                                key={key}
                                type="button"
                                role="tab"
                                aria-selected={tab === key}
                                className={'oj-tab' + (tab === key ? ' on' : '')}
                                onClick={() => setTab(key)}
                            >
                                <i className={'fas ' + icon} /> {label}
                            </button>
                        ))}
                    </div>

                    <div className="oj-pane-body">
                        {tab === 'statement' && (
                            <>
                                <Statement md={problem.statementMd} />

                                <div className="u-head"><h2><i className="fas fa-list-ol" /> 样例</h2></div>
                                <SampleBlock samples={samples} />

                                {problem.solutionCode && (
                                    <>
                                        <div className="u-head">
                                            <h2><i className="fas fa-key" /> 标准解</h2>
                                            <button
                                                type="button"
                                                className="fc-btn fc-btn-quiet u-head-act"
                                                onClick={() => setShowSolution((v) => !v)}
                                            >
                                                {showSolution ? '收起' : '看一眼'}
                                            </button>
                                        </div>
                                        {showSolution ? (
                                            <>
                                                <p className="u-note">
                                                    这份代码不只是「参考答案」—— 每个测试点的期望输出都是拿它跑出来的。
                                                    换句话说，判题判的就是「你的输出跟它一不一样」。
                                                </p>
                                                <CodeEditor
                                                    value={problem.solutionCode}
                                                    language="python"
                                                    height="320px"
                                                    readOnly
                                                />
                                            </>
                                        ) : (
                                            <p className="u-note">先自己写。真卡住了再点上面那个按钮。</p>
                                        )}
                                    </>
                                )}
                            </>
                        )}

                        {tab === 'testcases' && <TestcasesTab problemId={problem.id} />}

                        {tab === 'submissions' && (
                            <MySubmissions subs={mySubs} onReuse={(s) => { setLanguage(s.language); setCode(s.code); }} />
                        )}
                    </div>
                </section>

                {/* ---------------- 右：作答 ---------------- */}
                <section className="oj-pane oj-pane-right">
                    <div className="oj-judge-head">
                        <select
                            className="oj-select"
                            value={language}
                            onChange={(e) => setLanguage(e.target.value as OjLanguageId)}
                        >
                            {OJ_LANGUAGES.map((l) => (
                                <option key={l.id} value={l.id} disabled={!l.available}>{l.label}</option>
                            ))}
                        </select>

                        <button
                            type="button"
                            className="fc-btn fc-btn-quiet"
                            title="把编辑器恢复成这个语言的初始模板"
                            onClick={() => {
                                if (!window.confirm('清空当前代码，换回初始模板？')) return;
                                setCode(OJ_LANGUAGES.find((l) => l.id === language)?.template ?? '');
                            }}
                        >
                            <i className="fas fa-rotate-left" /> 重置
                        </button>

                        <button
                            type="button"
                            className="u-btn u-btn-primary oj-submit"
                            disabled={submitting || judging || !code.trim()}
                            onClick={() => void submit()}
                        >
                            <i className={'fas ' + (submitting || judging ? 'fa-spinner fa-spin' : 'fa-paper-plane')} />
                            {judging ? ' 评测中…' : ' 提交评测'}
                        </button>
                    </div>

                    <CodeEditor value={code} onChange={setCode} language={language} height="46vh" />

                    <p className="u-note oj-draft-note">
                        代码随手存在这台电脑的浏览器里，按题目和语言分开记 —— 关掉页面再回来还在。
                    </p>

                    {error && <p className="fc-error">{error}</p>}

                    {verdict && (
                        <div className="oj-result">
                            <div className="oj-result-head">
                                <VerdictBadge verdict={verdict} full />
                                {verdict !== 'PENDING' && verdict !== 'JUDGING' && (
                                    <>
                                        <span className="oj-result-score u-num">{score} 分</span>
                                        <span className="u-num">{msText(timeMs)}</span>
                                    </>
                                )}
                                {judging && totalCases > 0 && (
                                    <span className="u-num oj-result-progress">
                                        {results.length} / {totalCases} 个测试点 · 已过 {passed}
                                    </span>
                                )}
                            </div>
                            <CaseResultGrid results={results} total={totalCases} />
                        </div>
                    )}
                </section>
            </div>
        </AppShell>
    );
}

/** 「本题提交」那一栏 */
function MySubmissions({
    subs, onReuse,
}: { subs: OjSubmission[] | null; onReuse: (s: OjSubmission) => void }) {
    const [open, setOpen] = useState<number | null>(null);

    if (subs === null) return <p className="u-note"><i className="fas fa-spinner fa-spin" /> 正在读…</p>;
    if (subs.length === 0) return <p className="u-empty">这道题还没交过。</p>;

    return (
        <ul className="oj-sub-list">
            {subs.map((s) => (
                <li key={s.id} className={'oj-sub' + (open === s.id ? ' on' : '')}>
                    <button type="button" className="oj-sub-row" onClick={() => setOpen(open === s.id ? null : s.id)}>
                        <VerdictBadge verdict={s.verdict} />
                        <span className="oj-sub-score u-num">{s.score} 分</span>
                        <span className="u-num">{msText(s.timeMs)}</span>
                        <span className="oj-sub-lang">{s.language}</span>
                        <span className="oj-sub-time u-num">{dateText(s.createdAt)}</span>
                        <i className={'fas fa-chevron-' + (open === s.id ? 'up' : 'down')} />
                    </button>

                    {open === s.id && (
                        <div className="oj-sub-body">
                            <div className="oj-sub-ops">
                                <button type="button" className="fc-btn" onClick={() => onReuse(s)}>
                                    <i className="fas fa-arrow-right-to-bracket" /> 把这份代码放回编辑器
                                </button>
                            </div>
                            <CaseResultGrid results={s.caseResults} />
                            <CodeEditor value={s.code} language={s.language} height="260px" readOnly />
                        </div>
                    )}
                </li>
            ))}
        </ul>
    );
}
