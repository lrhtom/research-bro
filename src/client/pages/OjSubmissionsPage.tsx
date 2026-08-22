// 全部提交记录。可以用 ?problemId= 只看某一道题的。
//
// 行点开就展开：逐点结果网格 + 当时那份代码。列表接口本来就把代码和
// 逐点结果一起带回来了（单人用的量级，一次拉全反而更简单），
// 所以展开是零延迟的，不用再打一次接口。

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { VerdictBadge } from '@/components/oj/Badges';
import CaseResultGrid from '@/components/oj/CaseResultGrid';
import CodeEditor from '@/components/oj/CodeEditor';
import { apiOjSubmissions } from '@/lib/api';
import { dateText, msText } from '@/lib/format';
import { OJ_SECTIONS } from '@/lib/nav';
import { subscribeOjJudge } from '@/lib/oj-stream';
import type { OjSubmission } from '../../shared/oj';

const PAGE_SIZE = 20;

export default function OjSubmissionsPage() {
    const [params, setParams] = useSearchParams();
    const problemId = Number(params.get('problemId')) || 0;

    const [items, setItems] = useState<OjSubmission[] | null>(null);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [open, setOpen] = useState<number | null>(null);
    const [error, setError] = useState('');

    const reload = useCallback(async () => {
        try {
            const r = await apiOjSubmissions({
                ...(problemId > 0 ? { problemId } : {}),
                page,
                pageSize: PAGE_SIZE,
            });
            setItems(r.items);
            setTotal(r.total);
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载失败');
        }
    }, [problemId, page]);

    useEffect(() => {
        document.title = '提交记录 · 算法题库';
        void reload();
    }, [reload]);

    // 别处判完一题就刷新一次。只认 done —— case 事件一秒好几条，跟着刷等于连打接口
    useEffect(() => subscribeOjJudge((e) => { if (e.type === 'done') void reload(); }), [reload]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <AppShell
            title="提交记录"
            subtitle="Submissions"
            sections={OJ_SECTIONS}
            actions={problemId > 0 ? (
                <button
                    type="button"
                    className="u-btn"
                    onClick={() => { setParams({}); setPage(1); }}
                >
                    <i className="fas fa-filter-circle-xmark" /> 看全部
                </button>
            ) : undefined}
        >
            {problemId > 0 && (
                <p className="u-note">
                    只看题目 #{problemId} 的提交。
                    <Link to={`/tools/oj/${problemId}`}> 回到那道题 →</Link>
                </p>
            )}

            {error && <p className="fc-error">{error}</p>}
            {items === null && <p className="u-note"><i className="fas fa-spinner fa-spin" /> 正在读…</p>}

            {items?.length === 0 && (
                <div className="oj-empty">
                    <i className="fas fa-paper-plane" />
                    <h3>还没有提交记录</h3>
                    <p>去题库挑一道题交一份代码，这里就会有东西了。</p>
                    <Link className="u-btn u-btn-primary" to="/tools/oj">
                        <i className="fas fa-list-check" /> 去题库
                    </Link>
                </div>
            )}

            {items && items.length > 0 && (
                <ul className="oj-sub-list">
                    {items.map((s) => (
                        <li key={s.id} className={'oj-sub' + (open === s.id ? ' on' : '')}>
                            <button
                                type="button"
                                className="oj-sub-row"
                                onClick={() => setOpen(open === s.id ? null : s.id)}
                            >
                                <VerdictBadge verdict={s.verdict} />
                                <span className="oj-sub-score u-num">{s.score} 分</span>
                                <span className="oj-sub-title">{s.problemTitle ?? `题目 #${s.problemId}`}</span>
                                <span className="u-num">{msText(s.timeMs)}</span>
                                <span className="oj-sub-lang">{s.language}</span>
                                <span className="oj-sub-time u-num">{dateText(s.createdAt)}</span>
                                <i className={'fas fa-chevron-' + (open === s.id ? 'up' : 'down')} />
                            </button>

                            {open === s.id && (
                                <div className="oj-sub-body">
                                    <div className="oj-sub-ops">
                                        <Link className="fc-btn" to={`/tools/oj/${s.problemId}`}>
                                            <i className="fas fa-arrow-right" /> 打开这道题
                                        </Link>
                                    </div>
                                    <CaseResultGrid results={s.caseResults} />
                                    <CodeEditor value={s.code} language={s.language} height="300px" readOnly />
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {totalPages > 1 && (
                <div className="oj-pager">
                    <button
                        type="button"
                        className="fc-btn"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                        <i className="fas fa-chevron-left" /> 上一页
                    </button>
                    <span className="u-num">第 {page} / {totalPages} 页 · 共 {total} 条</span>
                    <button
                        type="button"
                        className="fc-btn"
                        disabled={page >= totalPages}
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    >
                        下一页 <i className="fas fa-chevron-right" />
                    </button>
                </div>
            )}
        </AppShell>
    );
}
