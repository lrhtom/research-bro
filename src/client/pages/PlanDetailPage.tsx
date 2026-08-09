// 单个学习计划：改设置、增删改卡片、导入 JSON、开始学习。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { FLASHCARD_SECTIONS } from '@/lib/nav';
import ImportPanel from '@/components/cards/ImportPanel';
import CardEditor from '@/components/cards/CardEditor';
import { Skeleton } from '@/components/Loading';
import {
    apiCreateCard, apiDeleteCard, apiListCards, apiResetCard, apiUpdateCard, apiUpdatePlan,
} from '@/lib/api';
import { dateText, STATE_LABELS, untilText } from '@/lib/format';
import type { Card, Plan, PlanStats } from '../../shared/types';

export default function PlanDetailPage() {
    const { planId } = useParams();
    const id = Number(planId);
    const navigate = useNavigate();

    const [plan, setPlan] = useState<Plan | null>(null);
    const [stats, setStats] = useState<PlanStats | null>(null);
    const [cards, setCards] = useState<Card[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<number | 'new' | null>(null);
    const [filter, setFilter] = useState('');

    const reload = useCallback(async () => {
        try {
            const [meta, list] = await Promise.all([
                fetch(`/api/plans/${id}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('计划不存在')))),
                apiListCards(id),
            ]);
            setPlan(meta.plan);
            setStats(meta.stats);
            setCards(list);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载失败');
        }
    }, [id]);

    useEffect(() => {
        document.title = '管理卡片 · 记忆卡';
        void reload();
    }, [reload]);

    const shown = useMemo(() => {
        if (!cards) return [];
        const q = filter.trim().toLowerCase();
        if (!q) return cards;
        return cards.filter((c) => (c.front + ' ' + c.back).toLowerCase().includes(q));
    }, [cards, filter]);

    async function savePlanField(patch: { name?: string; description?: string; dailyNewLimit?: number }) {
        try {
            setPlan(await apiUpdatePlan(id, patch));
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
        }
    }

    async function saveCard(cardId: number | 'new', front: string, back: string) {
        try {
            if (cardId === 'new') await apiCreateCard(id, front, back);
            else await apiUpdateCard(cardId, { front, back });
            setEditingId(null);
            await reload();
        } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
        }
    }

    async function removeCard(c: Card) {
        if (!window.confirm(`删除这张卡片吗？\n\n${c.front.slice(0, 60)}`)) return;
        try { await apiDeleteCard(c.id); await reload(); }
        catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
    }

    async function resetCard(c: Card) {
        if (!window.confirm('把这张卡的学习进度清零、重新当新卡吗？\n（卡片内容与历史记录都保留）')) return;
        try { await apiResetCard(c.id); await reload(); }
        catch (e) { setError(e instanceof Error ? e.message : '重置失败'); }
    }

    if (error && !plan) {
        return (
            <AppShell title="记忆卡" subtitle="Spaced Repetition" sections={FLASHCARD_SECTIONS}>
                <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/tools/flashcards">← 返回学习计划列表</Link></p>
            </AppShell>
        );
    }

    return (
        <AppShell
            title={plan?.name ?? '记忆卡'}
            subtitle="Manage Cards · 管理卡片"
            sections={FLASHCARD_SECTIONS}
            actions={
                <>
                    <Link className="u-btn" to={`/tools/flashcards/stats?plan=${id}`}>
                        <i className="fas fa-chart-line" /> 本计划统计
                    </Link>
                    {stats && stats.remaining > 0 && (
                        <Link className="u-btn u-btn-primary" to={`/tools/flashcards/${id}/study`}>
                            <i className="fas fa-play" /> 开始学习（{stats.remaining}）
                        </Link>
                    )}
                </>
            }
        >
                <p className="fc-crumb">
                    <Link to="/tools/flashcards">← 全部学习计划</Link>
                </p>

                {error && <p className="fc-error"><i className="fas fa-circle-xmark" /> {error}</p>}

                {plan && (
                    <div className="fc-form fc-plan-settings">
                        <label>
                            <span>计划名称</span>
                            <input
                                defaultValue={plan.name}
                                onBlur={(e) => { if (e.target.value !== plan.name) void savePlanField({ name: e.target.value }); }}
                            />
                        </label>
                        <label>
                            <span>说明</span>
                            <input
                                defaultValue={plan.description}
                                onBlur={(e) => { if (e.target.value !== plan.description) void savePlanField({ description: e.target.value }); }}
                            />
                        </label>
                        <label className="fc-form-narrow">
                            <span>每日新卡上限</span>
                            <input
                                type="number" min={0} max={9999}
                                defaultValue={plan.dailyNewLimit}
                                onBlur={(e) => {
                                    const v = Number(e.target.value);
                                    if (v !== plan.dailyNewLimit) void savePlanField({ dailyNewLimit: v });
                                }}
                            />
                        </label>
                        <p className="fc-muted fc-form-note">
                            改完点别处即保存。到期的卡片<b>不受上限限制</b> —— 那是已经欠下的债。
                        </p>
                    </div>
                )}

                {stats && (
                    <ul className="fc-stat-row">
                        <li><b>{stats.totalCards}</b><span>总卡片</span></li>
                        <li><b>{stats.newCards}</b><span>新卡</span></li>
                        <li><b>{stats.learningCards}</b><span>学习中</span></li>
                        <li><b>{stats.reviewCards}</b><span>复习</span></li>
                        <li><b>{stats.finished}</b><span>今日已学完</span></li>
                        <li><b>{stats.remaining}</b><span>今日还剩</span></li>
                    </ul>
                )}

                <div className="section-head">
                    <h2><i className="fas fa-rectangle-list" /> 卡片</h2>
                    <span className="count">{cards ? `共 ${cards.length} 张` : '加载中…'}</span>
                    <input
                        className="fc-filter"
                        placeholder="筛选…"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    <button type="button" className="fc-btn fc-btn-primary" onClick={() => setEditingId('new')}>
                        <i className="fas fa-plus" /> 新增卡片
                    </button>
                </div>

                {editingId === 'new' && (
                    <CardEditor
                        key="new"
                        onSave={(f, b) => void saveCard('new', f, b)}
                        onCancel={() => setEditingId(null)}
                    />
                )}

                {!cards && <Skeleton rows={5} label="正在读取卡片" />}

                <div className="fc-card-list">
                    {shown.map((c) => (
                        editingId === c.id ? (
                            <CardEditor
                                key={c.id}
                                initialFront={c.front}
                                initialBack={c.back}
                                onSave={(f, b) => void saveCard(c.id, f, b)}
                                onCancel={() => setEditingId(null)}
                            />
                        ) : (
                            <article className="fc-card-row" key={c.id}>
                                <div className="fc-card-main">
                                    <div className="fc-card-front">{c.front}</div>
                                    {c.back && <div className="fc-card-back-src">{c.back.slice(0, 160)}</div>}
                                </div>
                                <div className="fc-card-meta">
                                    <span className={'fc-state fc-state-' + c.state}>{STATE_LABELS[c.state]}</span>
                                    <span className="fc-muted">
                                        {c.state === 'new' ? '尚未学习' : `${untilText(c.due)} · ${dateText(c.due)}`}
                                    </span>
                                    <span className="fc-muted">复习 {c.reps} 次 · 忘记 {c.lapses} 次</span>
                                </div>
                                <div className="fc-card-actions">
                                    <button type="button" className="fc-icon-btn" title="编辑" onClick={() => setEditingId(c.id)}>
                                        <i className="fas fa-pen" />
                                    </button>
                                    <button type="button" className="fc-icon-btn" title="进度清零" onClick={() => void resetCard(c)}>
                                        <i className="fas fa-rotate-left" />
                                    </button>
                                    <button type="button" className="fc-icon-btn fc-danger" title="删除" onClick={() => void removeCard(c)}>
                                        <i className="fas fa-trash" />
                                    </button>
                                </div>
                            </article>
                        )
                    ))}
                    {cards && shown.length === 0 && (
                        <p className="fc-empty">{filter ? '没有匹配的卡片。' : '这个计划还没有卡片，新增一张或从 JSON 导入。'}</p>
                    )}
                </div>

                <div className="section-head" style={{ marginTop: 36 }}>
                    <h2><i className="fas fa-file-import" /> 导入 JSON 到本计划</h2>
                </div>
                <ImportPanel
                    mode="into-plan"
                    planId={id}
                    onDone={(msg) => { void reload(); window.alert(msg); }}
                />
        </AppShell>
    );
}
