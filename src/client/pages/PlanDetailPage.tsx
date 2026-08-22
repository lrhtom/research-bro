// 单个学习计划：改设置、增删改卡片、导入 JSON、开始学习。
//
// 卡片区是**左列表 + 右详情**：左边放完整的正面文字（长的就往下撑开、
// 不截断 —— 截成一行之后好几张卡的开头都一样，根本分不出是哪一张），
// 点一行右边整块跟着换。
// 上一版是一列长卡片、编辑时就地展开 —— 卡多了之后要一直上下滚，
// 而且展开会把下面的行全推走，改完再找回原来的位置很烦。
//
// 右边两个页签：
//   · 详情 —— 自上而下三段：卡片预览（背面按 Markdown 渲染，跟学习时一模一样）、
//             调度数据（状态、到期、稳定度、复习/遗忘次数）、遗忘曲线与手动调整
//   · 编辑 —— 改正反面
// 预览原来是独立一档，后来并进详情最上面：这两件事本来就连着看 ——
// 判断「这张卡要不要调曲线」得先看清它长什么样，分成两档就得来回切。
// 编辑器自己右半边虽然也有实时预览，但那一栏窄，图和表格看不全，
// 所以详情里这一份仍然留着。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { FLASHCARD_SECTIONS } from '@/lib/nav';
import ImportPanel from '@/components/cards/ImportPanel';
import CardEditor from '@/components/cards/CardEditor';
import ForgettingCurve from '@/components/cards/ForgettingCurve';
import Markdown from '@/components/cards/Markdown';
import { Skeleton } from '@/components/Loading';
import {
    apiCreateCard, apiDeleteCard, apiListCards, apiToggleCardFavorite,
    apiUpdateCard, apiUpdatePlan,
} from '@/lib/api';
import { dateText, STATE_LABELS, untilText } from '@/lib/format';
import { cancelSpeech, speakAuto, speechSynthesisSupported } from '@/lib/speech';
import type { Card, Plan, PlanStats } from '../../shared/types';

/** 右边那块的两个页签 */
type Tab = 'detail' | 'edit';

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
    { key: 'detail', label: '详情', icon: 'fa-circle-info' },
    { key: 'edit', label: '编辑', icon: 'fa-pen' },
];

/**
 * 落地页签：详情。
 *
 * 「预览」原来是独立一档，现在并进详情里、摆在最上面 —— 因为这两件事
 * 本来就是连着看的：先看清这张卡长什么样，再往下看它排到什么时候、
 * 记忆掉到哪儿了。分成两档的时候，判断「这张卡要不要调」得来回切页签，
 * 而调度数据脱离卡片内容单独看也没什么意义。
 *
 * 换卡、存完、取消编辑之后都回到这里，所以抽成一个常量，只改一处。
 */
const DEFAULT_TAB: Tab = 'detail';

export default function PlanDetailPage() {
    const { planId } = useParams();
    const id = Number(planId);

    const [plan, setPlan] = useState<Plan | null>(null);
    const [stats, setStats] = useState<PlanStats | null>(null);
    const [cards, setCards] = useState<Card[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState('');

    /** 右边正在看哪一张。'new' = 正在新建。 */
    const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);
    const [tab, setTab] = useState<Tab>(DEFAULT_TAB);
    /** 计划设置默认收起 —— 一进来就想看卡片，不是改每日上限 */
    const [settingsOpen, setSettingsOpen] = useState(false);
    /** 正在朗读题目。浏览器不支持语音合成时整个按钮不出现，而不是出现了点不动 */
    const canSpeak = speechSynthesisSupported();
    const [speaking, setSpeaking] = useState(false);

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
            return list as Card[];
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载失败');
            return null;
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

    // 默认选中第一张，右边不会一进来就是空的。
    // 已经选了的、或者正在新建的，都不要抢。
    useEffect(() => {
        if (selectedId !== null || shown.length === 0) return;
        setSelectedId(shown[0].id);
    }, [shown, selectedId]);

    const selected = useMemo(
        () => (typeof selectedId === 'number' ? cards?.find((c) => c.id === selectedId) ?? null : null),
        [cards, selectedId],
    );

    // 选中的那张被筛掉了（改了搜索词）就跟着跳到第一条，
    // 免得右边显示的卡在左边根本找不到
    useEffect(() => {
        if (typeof selectedId !== 'number' || shown.length === 0) return;
        if (!shown.some((c) => c.id === selectedId)) setSelectedId(shown[0].id);
    }, [shown, selectedId]);

    function pick(cardId: number) {
        setSelectedId(cardId);
        // 换卡时回到落地页签：上一张停在「编辑」，下一张不该也直接进编辑态
        setTab(DEFAULT_TAB);
        // 上一张还在念就掐掉 —— 右边已经换成另一张了，声音还在念旧的很错乱
        stopSpeak();
    }

    function stopSpeak() {
        cancelSpeech();
        setSpeaking(false);
    }

    /** 朗读题目（正面）。再点一次停掉。语言由 speakAuto 自己判。 */
    function toggleSpeak(c: Card) {
        if (speaking) { stopSpeak(); return; }
        setSpeaking(speakAuto(c.front, { onEnd: () => setSpeaking(false) }));
    }

    // 离开这一页时把声音带走，否则会一直念到说完
    useEffect(() => () => cancelSpeech(), []);

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
            if (cardId === 'new') {
                const created = await apiCreateCard(id, front, back);
                await reload();
                // 新建完直接选中它，让人看见「东西确实进去了」
                setSelectedId(created.id);
                setTab(DEFAULT_TAB);
            } else {
                await apiUpdateCard(cardId, { front, back });
                await reload();
                setTab(DEFAULT_TAB);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
        }
    }

    async function removeCard(c: Card) {
        if (!window.confirm(`删除这张卡片吗？\n\n${c.front.slice(0, 60)}`)) return;
        try {
            const list = await (async () => { await apiDeleteCard(c.id); return reload(); })();
            // 删掉的正好是选中的：往后顺延一张，没有就选第一张
            if (list) setSelectedId(list.length ? list[0].id : null);
        } catch (e) {
            setError(e instanceof Error ? e.message : '删除失败');
        }
    }


    /** 收藏：先改界面再发请求，失败原样退回 —— 点一颗星要等一个来回才亮，手感很差 */
    async function toggleFavorite(c: Card) {
        setCards((cur) => cur?.map((x) => (x.id === c.id ? { ...x, favorite: !x.favorite } : x)) ?? cur);
        try {
            await apiToggleCardFavorite(c.id);
            await reload();
        } catch (e) {
            setCards((cur) => cur?.map((x) => (x.id === c.id ? { ...x, favorite: c.favorite } : x)) ?? cur);
            setError(e instanceof Error ? e.message : '收藏失败');
        }
    }

    if (error && !plan) {
        return (
            <AppShell title="记忆卡" subtitle="Spaced Repetition" sections={FLASHCARD_SECTIONS}>
                <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/tools/flashcards">← 返回学习计划列表</Link></p>
            </AppShell>
        );
    }

    const favCount = cards?.filter((c) => c.favorite).length ?? 0;

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

            {stats && (
                <ul className="fc-stat-row">
                    <li><b>{stats.totalCards}</b><span>总卡片</span></li>
                    <li><b>{stats.newCards}</b><span>新卡</span></li>
                    <li><b>{stats.learningCards}</b><span>学习中</span></li>
                    <li><b>{stats.reviewCards}</b><span>复习</span></li>
                    <li><b>{favCount}</b><span>已收藏</span></li>
                    <li><b>{stats.remaining}</b><span>今日还剩</span></li>
                </ul>
            )}

            {/* 计划设置默认折起来。一进这一页十次有九次是来看卡片的 */}
            {plan && (
                <div className="fc-settings-fold">
                    <button
                        type="button"
                        className="fc-settings-toggle"
                        onClick={() => setSettingsOpen((v) => !v)}
                        aria-expanded={settingsOpen}
                    >
                        <i className={`fas fa-chevron-${settingsOpen ? 'down' : 'right'}`} />
                        计划设置
                        <span className="fc-muted">每日新卡上限 {plan.dailyNewLimit}</span>
                    </button>

                    {settingsOpen && (
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
                </div>
            )}

            {!cards && <Skeleton rows={5} label="正在读取卡片" />}

            {cards && (
                <div className="fc-workbench">
                    {/* ---------- 左：卡片题目 ---------- */}
                    <aside className="fc-rail" aria-label="卡片列表">
                        <div className="fc-rail-head">
                            <input
                                className="fc-filter"
                                placeholder="筛选卡片…"
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                            />
                            <button
                                type="button"
                                className="fc-btn fc-btn-primary fc-rail-add"
                                onClick={() => { setSelectedId('new'); setTab('edit'); }}
                                title="新增卡片"
                            >
                                <i className="fas fa-plus" />
                            </button>
                        </div>

                        <p className="fc-rail-count u-muted">
                            {filter ? `匹配 ${shown.length} / ${cards.length} 张` : `共 ${cards.length} 张`}
                            {favCount > 0 && <> · 收藏 {favCount}</>}
                        </p>

                        <ul className="fc-rail-list">
                            {shown.map((c) => (
                                <li key={c.id}>
                                    <button
                                        type="button"
                                        className={'fc-rail-item' + (selectedId === c.id ? ' is-active' : '')}
                                        onClick={() => pick(c.id)}
                                    >
                                        <span className={'fc-dot fc-state-' + c.state} aria-hidden="true" />
                                        <span className="fc-rail-front">{c.front}</span>
                                    </button>
                                    <button
                                        type="button"
                                        className={'fc-rail-star' + (c.favorite ? ' is-on' : '')}
                                        onClick={() => void toggleFavorite(c)}
                                        title={c.favorite ? '取消收藏' : '收藏（收藏的排在最前）'}
                                        aria-pressed={c.favorite}
                                    >
                                        <i className={(c.favorite ? 'fas' : 'far') + ' fa-star'} />
                                    </button>
                                </li>
                            ))}
                            {shown.length === 0 && (
                                <li className="fc-rail-empty">
                                    {filter ? '没有匹配的卡片' : '还没有卡片'}
                                </li>
                            )}
                        </ul>
                    </aside>

                    {/* ---------- 右：详情 / 编辑 / 预览 ---------- */}
                    <section className="fc-pane">
                        {selectedId === 'new' ? (
                            <>
                                <header className="fc-pane-head">
                                    <h3>新增卡片</h3>
                                </header>
                                <CardEditor
                                    key="new"
                                    onSave={(f, b) => void saveCard('new', f, b)}
                                    onCancel={() => setSelectedId(cards[0]?.id ?? null)}
                                />
                            </>
                        ) : !selected ? (
                            <p className="fc-empty">
                                {cards.length === 0
                                    ? '这个计划还没有卡片，点左上角的 + 新增一张，或者从下面导入 JSON。'
                                    : '在左边选一张卡片。'}
                            </p>
                        ) : (
                            <>
                                <header className="fc-pane-head">
                                    <h3>{selected.front}</h3>
                                    <div className="fc-pane-actions">
                                        {canSpeak && (
                                            <button
                                                type="button"
                                                className={'fc-icon-btn' + (speaking ? ' is-speaking' : '')}
                                                title={speaking ? '停止朗读' : '朗读题目'}
                                                aria-label={speaking ? '停止朗读' : '朗读题目'}
                                                onClick={() => toggleSpeak(selected)}
                                            >
                                                <i className={'fas ' + (speaking ? 'fa-circle-stop' : 'fa-volume-high')} />
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className={'fc-icon-btn' + (selected.favorite ? ' fc-star-on' : '')}
                                            title={selected.favorite ? '取消收藏' : '收藏'}
                                            onClick={() => void toggleFavorite(selected)}
                                        >
                                            <i className={(selected.favorite ? 'fas' : 'far') + ' fa-star'} />
                                        </button>
                                        <button
                                            type="button" className="fc-icon-btn fc-danger" title="删除"
                                            onClick={() => void removeCard(selected)}
                                        >
                                            <i className="fas fa-trash" />
                                        </button>
                                    </div>
                                </header>

                                <div className="fc-tabs" role="tablist">
                                    {TABS.map((t) => (
                                        <button
                                            key={t.key}
                                            type="button"
                                            role="tab"
                                            aria-selected={tab === t.key}
                                            className={'fc-tab' + (tab === t.key ? ' is-active' : '')}
                                            onClick={() => setTab(t.key)}
                                        >
                                            <i className={'fas ' + t.icon} /> {t.label}
                                        </button>
                                    ))}
                                </div>

                                {/* 预览摆在最上面：先看清这张卡长什么样，
                                    再往下看调度数据和曲线 */}
                                {tab === 'detail' && (
                                    <div className="fc-preview">
                                        <p className="u-label">正面</p>
                                        <p className="fc-preview-front">{selected.front}</p>
                                        <p className="u-label">背面</p>
                                        {selected.back
                                            ? <Markdown source={selected.back} className="fc-markdown" />
                                            : <p className="fc-muted">这张卡没有背面内容。</p>}
                                    </div>
                                )}

                                {tab === 'detail' && (
                                    <dl className="fc-detail fc-detail-below">
                                        <div>
                                            <dt>状态</dt>
                                            <dd><span className={'fc-state fc-state-' + selected.state}>{STATE_LABELS[selected.state]}</span></dd>
                                        </div>
                                        <div>
                                            <dt>下次复习</dt>
                                            <dd>{selected.state === 'new' ? '尚未学习' : `${untilText(selected.due)} · ${dateText(selected.due)}`}</dd>
                                        </div>
                                        <div>
                                            <dt>上次复习</dt>
                                            <dd>{selected.lastReview ? dateText(selected.lastReview) : '—'}</dd>
                                        </div>
                                        <div>
                                            <dt>复习次数</dt>
                                            <dd className="u-num">{selected.reps}</dd>
                                        </div>
                                        <div>
                                            <dt>忘记次数</dt>
                                            <dd className="u-num">{selected.lapses}</dd>
                                        </div>
                                        <div>
                                            <dt>记忆稳定度</dt>
                                            {/* 单位是天：FSRS 认为再过这么久，记得住的概率掉到 90% */}
                                            <dd className="u-num">{selected.stability ? `${selected.stability.toFixed(1)} 天` : '—'}</dd>
                                        </div>
                                        <div>
                                            <dt>难度</dt>
                                            <dd className="u-num">{selected.difficulty ? selected.difficulty.toFixed(1) : '—'}<span className="fc-muted"> / 10</span></dd>
                                        </div>
                                        <div>
                                            <dt>创建于</dt>
                                            <dd>{dateText(selected.createdAt)}</dd>
                                        </div>
                                    </dl>
                                )}

                                {/* 曲线跟在那堆数字后面：稳定度、难度、到期这些就是它的坐标，
                                    放一起才互相解释得通。key 用卡片 id —— 换卡要整块重来，
                                    不能让上一张的曲线残留着等新数据回来 */}
                                {tab === 'detail' && (
                                    <ForgettingCurve
                                        key={selected.id}
                                        card={selected}
                                        onCardChanged={(next) => {
                                            setCards((prev) => (prev ?? []).map(
                                                (c) => (c.id === next.id ? next : c),
                                            ));
                                            // 卡片状态变了，计划的状态分布跟着变，统计要重取
                                            void reload();
                                        }}
                                    />
                                )}

                                {tab === 'edit' && (
                                    <CardEditor
                                        key={selected.id}
                                        initialFront={selected.front}
                                        initialBack={selected.back}
                                        onSave={(f, b) => void saveCard(selected.id, f, b)}
                                        onCancel={() => setTab(DEFAULT_TAB)}
                                    />
                                )}

                            </>
                        )}
                    </section>
                </div>
            )}

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
