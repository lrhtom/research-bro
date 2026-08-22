// 题库：搜索、标签过滤、只看收藏、分页，以及删题。
//
// 「生成中」的题也列在这儿（点不进去），因为出题要跑好几分钟 ——
// 看得见它在长，比让人对着一个空列表等着强。它跑完的那一刻会通过 SSE
// 推一条 phase 事件过来，列表自己刷新，不用手动按 F5。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { DifficultyBadge, StatusBadge } from '@/components/oj/Badges';
import {
    apiOjDeleteProblem, apiOjProblems, apiOjTags, apiOjToggleFavorite,
} from '@/lib/api';
import { dateText } from '@/lib/format';
import { OJ_SECTIONS } from '@/lib/nav';
import { subscribeOjGen } from '@/lib/oj-stream';
import type { OjProblemListItem } from '../../shared/oj';

const PAGE_SIZE = 20;

export default function OjProblemsPage() {
    const [items, setItems] = useState<OjProblemListItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState('');

    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [tag, setTag] = useState('');
    const [favOnly, setFavOnly] = useState(false);
    const [page, setPage] = useState(1);
    const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);

    const navigate = useNavigate();

    // 搜索防抖 300ms：每敲一个字打一次接口，中文输入法一句话能打出十几个请求
    useEffect(() => {
        const t = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 300);
        return () => clearTimeout(t);
    }, [search]);

    const reload = useCallback(async () => {
        try {
            const r = await apiOjProblems({
                ...(debounced ? { search: debounced } : {}),
                ...(tag ? { tag } : {}),
                ...(favOnly ? { favoriteOnly: true } : {}),
                page,
                pageSize: PAGE_SIZE,
            });
            setItems(r.items);
            setTotal(r.total);
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载失败');
        }
    }, [debounced, tag, favOnly, page]);

    useEffect(() => {
        document.title = '算法题库 · 工具箱';
        void reload();
    }, [reload]);

    useEffect(() => { void apiOjTags().then(setTags).catch(() => { /* 标签拉不到不影响列表 */ }); }, [items]);

    /**
     * 出题任务推进度过来时刷新列表。
     *
     * 只在 phase 事件上刷，不在 log / plan 上刷 —— 后两者一秒能来好几条，
     * 跟着刷等于对着接口连打。phase 一次任务只变几次，正好。
     */
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    useEffect(() => subscribeOjGen((e) => { if (e.type === 'phase') void reloadRef.current(); }), []);

    async function toggleFav(p: OjProblemListItem) {
        // 先本地翻过来，接口回来再以服务端为准 —— 点一下星星要立刻有反应
        setItems((cur) => cur?.map((x) => (x.id === p.id ? { ...x, isFavorite: !x.isFavorite } : x)) ?? cur);
        try {
            await apiOjToggleFavorite(p.id);
        } catch {
            void reload();
        }
    }

    async function remove(p: OjProblemListItem) {
        if (!window.confirm(`删除「${p.title}」吗？\n它的 ${p.testCaseCount} 个测试点和 ${p.submissionCount} 条提交会一起没掉，删了找不回来。`)) return;
        try {
            await apiOjDeleteProblem(p.id);
            void reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : '删除失败');
        }
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <AppShell
            title="算法题库"
            subtitle="Algorithm Problem Bank · AI 出题 + 本地判题"
            sections={OJ_SECTIONS}
            actions={
                <Link className="u-btn u-btn-primary" to="/tools/oj/generate">
                    <i className="fas fa-wand-magic-sparkles" /> AI 出一道
                </Link>
            }
        >
            <div className="oj-filters">
                <label className="oj-search">
                    <i className="fas fa-magnifying-glass" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="按标题搜索…"
                        spellCheck={false}
                    />
                    {search && (
                        <button type="button" onClick={() => setSearch('')} aria-label="清空">
                            <i className="fas fa-xmark" />
                        </button>
                    )}
                </label>

                <select
                    className="oj-select"
                    value={tag}
                    onChange={(e) => { setTag(e.target.value); setPage(1); }}
                >
                    <option value="">全部标签</option>
                    {tags.map((t) => (
                        <option key={t.tag} value={t.tag}>{t.tag}（{t.count}）</option>
                    ))}
                </select>

                <button
                    type="button"
                    className={'fc-chip' + (favOnly ? ' on' : '')}
                    aria-pressed={favOnly}
                    onClick={() => { setFavOnly((v) => !v); setPage(1); }}
                >
                    <i className={(favOnly ? 'fas' : 'far') + ' fa-star'} /> 只看收藏
                </button>
            </div>

            {error && <p className="fc-error">{error}</p>}

            {items === null && <p className="u-note"><i className="fas fa-spinner fa-spin" /> 正在读题库…</p>}

            {items?.length === 0 && (
                <div className="oj-empty">
                    <i className="fas fa-inbox" />
                    <h3>{debounced || tag || favOnly ? '没有符合条件的题' : '题库还是空的'}</h3>
                    <p>
                        {debounced || tag || favOnly
                            ? '换个搜索词或者把筛选清掉试试。'
                            : '这里的题全部由 AI 现出：你说想练什么，它写题面、写标准解、再造几十上百个测试点。'}
                    </p>
                    {!(debounced || tag || favOnly) && (
                        <Link className="u-btn u-btn-primary" to="/tools/oj/generate">
                            <i className="fas fa-wand-magic-sparkles" /> 出第一道题
                        </Link>
                    )}
                </div>
            )}

            {items && items.length > 0 && (
                <ul className="oj-list">
                    {items.map((p) => {
                        const busy = p.status === 'generating';
                        return (
                            <li key={p.id} className={'oj-item' + (busy ? ' is-busy' : '')}>
                                <button
                                    type="button"
                                    className="oj-star"
                                    aria-pressed={p.isFavorite}
                                    title={p.isFavorite ? '取消收藏' : '收藏'}
                                    onClick={() => void toggleFav(p)}
                                >
                                    <i className={(p.isFavorite ? 'fas' : 'far') + ' fa-star'} />
                                </button>

                                <div className="oj-item-main">
                                    <div className="oj-item-titles">
                                        {busy ? (
                                            // 生成中的题点不进去：题面在，但测试点还没造完，
                                            // 这时候进去只会看到一道判不了的题
                                            <span className="oj-item-title is-busy">{p.title}</span>
                                        ) : (
                                            <Link className="oj-item-title" to={`/tools/oj/${p.id}`}>{p.title}</Link>
                                        )}
                                        {p.solved && (
                                            <span className="oj-solved" title="已经 AC 过">
                                                <i className="fas fa-circle-check" />
                                            </span>
                                        )}
                                        <DifficultyBadge difficulty={p.difficulty} />
                                        <StatusBadge status={p.status} />
                                    </div>

                                    <div className="oj-item-tags">
                                        {p.tags.map((t) => (
                                            <button
                                                key={t}
                                                type="button"
                                                className={'oj-tag' + (tag === t ? ' on' : '')}
                                                onClick={() => { setTag(tag === t ? '' : t); setPage(1); }}
                                            >
                                                {t}
                                            </button>
                                        ))}
                                    </div>

                                    <div className="oj-item-meta">
                                        <span><i className="fas fa-vials" /> <b className="u-num">{p.testCaseCount}</b> 个测试点</span>
                                        <span><i className="fas fa-paper-plane" /> <b className="u-num">{p.submissionCount}</b> 次提交</span>
                                        <span><i className="fas fa-clock" /> {dateText(p.createdAt)}</span>
                                    </div>
                                </div>

                                <div className="oj-item-ops">
                                    {!busy && (
                                        <button
                                            type="button"
                                            className="fc-btn"
                                            onClick={() => navigate(`/tools/oj/${p.id}`)}
                                        >
                                            去做 <i className="fas fa-arrow-right" />
                                        </button>
                                    )}
                                    <button type="button" className="fc-btn fc-btn-quiet" onClick={() => void remove(p)}>
                                        <i className="fas fa-trash" />
                                    </button>
                                </div>
                            </li>
                        );
                    })}
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
                    <span className="u-num">第 {page} / {totalPages} 页 · 共 {total} 题</span>
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
