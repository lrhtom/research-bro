// 学习计划列表。
// 每个计划都是一副互相独立的牌组：自己的卡片、自己的每日新卡上限、自己的进度。

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import ImportPanel from '@/components/cards/ImportPanel';
import { Skeleton } from '@/components/Loading';
import { apiCreatePlan, apiDeletePlan, apiListPlans, apiToggleFavorite } from '@/lib/api';
import { FLASHCARD_SECTIONS } from '@/lib/nav';
import type { PlanWithStats } from '../../shared/types';

/**
 * 只按「是否收藏」分组，组内保持服务端给回来的先后。
 * Array.prototype.sort 是稳定排序，所以不必把 sort_order 也暴露给前端
 * ——那个字段一旦泄到客户端，两边的排序规则就得各写一遍、迟早对不上。
 */
function sortPlans(list: PlanWithStats[]): PlanWithStats[] {
    return [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite));
}

export default function PlansPage() {
    const [plans, setPlans] = useState<PlanWithStats[] | null>(null);
    const [tz, setTz] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [desc, setDesc] = useState('');
    const [limit, setLimit] = useState(20);
    const navigate = useNavigate();

    const reload = useCallback(async () => {
        try {
            const d = await apiListPlans();
            setPlans(d.plans);          // 服务端已经按「先收藏、再自定义顺序」排好了
            setTz(d.timeZone);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载失败');
        }
    }, []);

    useEffect(() => {
        document.title = '记忆卡 · 工具箱';
        void reload();
    }, [reload]);

    async function submitNew(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim()) return;
        try {
            const plan = await apiCreatePlan({ name, description: desc, dailyNewLimit: limit });
            setName(''); setDesc(''); setLimit(20); setCreating(false);
            navigate(`/tools/flashcards/${plan.id}`);
        } catch (err) {
            setError(err instanceof Error ? err.message : '新建失败');
        }
    }

    async function toggleFav(p: PlanWithStats) {
        // 先本地翻转再重排，点下去立刻有反馈；服务端是权威，回来之后以它为准
        setPlans((cur) => sortPlans(
            (cur ?? []).map((x) => (x.id === p.id ? { ...x, favorite: !x.favorite } : x)),
        ));
        try {
            await apiToggleFavorite(p.id);
            await reload();
        } catch (err) {
            setError(err instanceof Error ? err.message : '收藏失败');
            await reload();     // 失败就回滚成服务端的样子
        }
    }

    async function remove(p: PlanWithStats) {
        if (!window.confirm(`确定删除学习计划「${p.name}」吗？\n它的 ${p.stats.totalCards} 张卡片和全部学习记录都会一起删掉，无法撤销。`)) return;
        try {
            await apiDeletePlan(p.id);
            await reload();
        } catch (err) {
            setError(err instanceof Error ? err.message : '删除失败');
        }
    }

    return (
        <AppShell
            title="记忆卡"
            subtitle="Spaced Repetition · 间隔重复"
            sections={FLASHCARD_SECTIONS}
            actions={
                <Link className="u-btn" to="/tools/flashcards/stats">
                    <i className="fas fa-chart-line" /> 学习统计
                </Link>
            }
        >
                <p className="u-aside">
                    <i className="fas fa-brain" />
                    复习节奏由官方 <b>FSRS</b> 算法安排，<b>全部在服务端计算</b> —— 浏览器只提交「这张卡评了几分」。
                    每次评分立即落库，学到一半关掉页面不会丢任何已评过的卡，重新打开接着上次的位置继续。
                    {tz && <> 「今天」按 <b>{tz}</b> 的日历日切分。</>}
                </p>

                {error && <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>}

                <div className="u-head">
                    <h2><i className="fas fa-layer-group" /> 学习计划</h2>
                    <span className="count u-num">{plans ? `${plans.length} 个` : '加载中…'}</span>
                </div>

                {/* 计划卡片有六七十像素高，骨架也给同样的高度 ——
                    数据到位时不该整页往下跳一大截 */}
                {!plans && <Skeleton rows={4} label="正在读取学习计划" />}

                {plans && plans.length === 0 && (
                    <p className="fc-empty">还没有学习计划。在下面新建一个，或者直接导入一份卡片 JSON。</p>
                )}

                <div className="fc-plan-grid">
                    {plans?.map((p) => {
                        const s = p.stats;
                        const pct = s.total > 0 ? (s.finished / s.total) * 100 : 0;
                        return (
                            <article className={'fc-plan' + (p.favorite ? ' is-fav' : '')} key={p.id}>
                                <div className="fc-plan-top">
                                    <h3>{p.name}</h3>
                                    <button
                                        type="button"
                                        className={'fc-icon-btn fc-star' + (p.favorite ? ' on' : '')}
                                        title={p.favorite ? '取消收藏' : '收藏（排到最前面）'}
                                        aria-pressed={p.favorite}
                                        onClick={() => void toggleFav(p)}
                                    >
                                        <i className={(p.favorite ? 'fas' : 'far') + ' fa-star'} />
                                    </button>
                                    <button
                                        type="button"
                                        className="fc-icon-btn fc-danger"
                                        title="删除这个计划"
                                        onClick={() => void remove(p)}
                                    >
                                        <i className="fas fa-trash" />
                                    </button>
                                </div>
                                {p.description && <p className="fc-plan-desc">{p.description}</p>}

                                <ul className="fc-plan-counts">
                                    <li><b>{s.totalCards}</b><span>总卡片</span></li>
                                    <li><b>{s.newCards}</b><span>新卡</span></li>
                                    <li><b>{s.learningCards}</b><span>学习中</span></li>
                                    <li><b>{s.reviewCards}</b><span>复习</span></li>
                                </ul>

                                <div className="fc-plan-progress">
                                    <div className="fc-plan-progress-head">
                                        <span>今日进度 <b>{s.finished}</b> / {s.total}</span>
                                        <span className="fc-muted">掌握度 {(s.mastery * 100).toFixed(0)}%</span>
                                    </div>
                                    <div className="fc-bar">
                                        <div className="fc-bar-fill" style={{ width: pct.toFixed(2) + '%' }} />
                                    </div>
                                </div>

                                <div className="fc-plan-foot">
                                    <Link className="fc-btn fc-btn-primary" to={`/tools/flashcards/${p.id}/study`}>
                                        {s.remaining > 0
                                            ? <><i className="fas fa-play" /> 开始学习（{s.remaining}）</>
                                            : <><i className="fas fa-check" /> 今天学完了</>}
                                    </Link>
                                    <Link className="fc-btn" to={`/tools/flashcards/${p.id}`}>
                                        <i className="fas fa-pen-to-square" /> 管理卡片
                                    </Link>
                                    <Link
                                        className="fc-btn fc-btn-quiet"
                                        to={`/tools/flashcards/stats?plan=${p.id}`}
                                        title="只看这个计划的学习统计"
                                    >
                                        <i className="fas fa-chart-line" /> 统计
                                    </Link>
                                </div>
                            </article>
                        );
                    })}
                </div>

                <div className="u-head">
                    <h2><i className="fas fa-plus" /> 新建计划</h2>
                </div>

                {creating ? (
                    <form className="fc-form" onSubmit={submitNew}>
                        <label>
                            <span>计划名称</span>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="例如：雅思核心词汇"
                                autoFocus
                            />
                        </label>
                        <label>
                            <span>说明（可选）</span>
                            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个计划用来干嘛" />
                        </label>
                        <label className="fc-form-narrow">
                            <span>每日新卡上限</span>
                            <input
                                type="number"
                                min={0}
                                max={9999}
                                value={limit}
                                onChange={(e) => setLimit(Number(e.target.value))}
                            />
                        </label>
                        <div className="fc-form-actions">
                            <button type="submit" className="fc-btn fc-btn-primary" disabled={!name.trim()}>
                                <i className="fas fa-check" /> 创建
                            </button>
                            <button type="button" className="fc-btn" onClick={() => setCreating(false)}>取消</button>
                        </div>
                    </form>
                ) : (
                    <button type="button" className="fc-btn fc-btn-primary" onClick={() => setCreating(true)}>
                        <i className="fas fa-plus" /> 新建一个学习计划
                    </button>
                )}

                <div className="u-head">
                    <h2><i className="fas fa-file-import" /> 从 JSON 导入</h2>
                </div>
                <ImportPanel
                    mode="new-plan"
                    onDone={(msg) => { void reload(); window.alert(msg); }}
                />
        </AppShell>
    );
}
