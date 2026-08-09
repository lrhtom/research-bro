// ============================================================
//  英语口语场景练习 · 历史记录
//
//  每一条都连着当时的干扰项设置一起显示。
//  只留对话不留设置的话，过几天回来看，
//  「对方一直让我再说一遍」到底是设计好的噪音干扰、还是自己真的说不清，
//  已经分不出来了。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { Skeleton } from '@/components/Loading';
import { SPEAKING_SECTIONS } from '@/lib/nav';
import { apiDeleteSpeakingSession, apiListSpeakingSessions } from '@/lib/api';
import { dateText } from '@/lib/format';
import { INTERFERENCE_LABELS, SUBOPTION_LABELS, type InterferenceKey } from '../../shared/speaking';
import type { SpeakingSessionSummary } from '../../shared/types';

export default function SpeakingHistoryPage() {
    const [list, setList] = useState<SpeakingSessionSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setList(await apiListSpeakingSessions());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : '载入失败');
        }
    }, []);

    useEffect(() => {
        document.title = '口语练习记录 · 工具箱';
        void load();
    }, [load]);

    async function remove(s: SpeakingSessionSummary) {
        if (!window.confirm(`删除「${s.label || '这场练习'}」吗？\n对话记录和报告都会一起删掉，无法撤销。`)) return;
        try { await apiDeleteSpeakingSession(s.id); await load(); }
        catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
    }

    return (
        <AppShell
            title="口语练习记录"
            subtitle="Practice History"
            sections={SPEAKING_SECTIONS}
            actions={
                <Link className="u-btn u-btn-primary" to="/tools/speaking">
                    <i className="fas fa-plus" /> 开始新的一场
                </Link>
            }
        >
                {error && <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>}

                <div className="section-head">
                    <h2><i className="fas fa-clock-rotate-left" /> 练过的场景</h2>
                    <span className="count">{list ? `共 ${list.length} 场` : '加载中…'}</span>
                </div>
                <p className="fc-muted fc-note">
                    每一场都连着<b>当时的干扰项设置</b>一起存着 ——
                    没有设置，过几天回头看这段对话是读不懂的。
                </p>

                {!list && <Skeleton rows={3} label="正在读取练习记录" />}

                {list && list.length === 0 && (
                    <p className="fc-empty">还没有练过。<Link to="/tools/speaking">去开一场 →</Link></p>
                )}

                <div className="sp-history">
                    {list?.map((s) => {
                        const keys = Object.keys(s.modifiers) as InterferenceKey[];
                        return (
                            <article className="sp-hist" key={s.id}>
                                <div className="sp-hist-top">
                                    <h3>{s.label || '未命名场景'}</h3>
                                    <span className={'sp-hist-state ' + s.status}>
                                        {s.status === 'finished' ? '已结束' : '进行中'}
                                    </span>
                                    <button
                                        type="button"
                                        className="fc-icon-btn fc-danger"
                                        title="删除这场记录"
                                        onClick={() => void remove(s)}
                                    >
                                        <i className="fas fa-trash" />
                                    </button>
                                </div>

                                <p className="sp-hist-scenario">{s.scenario}</p>

                                <div className="sp-hist-mods">
                                    {keys.length === 0
                                        ? <span className="sp-chip sp-chip-plain">标准英语 · 无干扰</span>
                                        : keys.map((k) => {
                                            const subs = s.modifiers[k] ?? [];
                                            return (
                                                <span key={k} className="sp-chip">
                                                    <i className={'fas ' + INTERFERENCE_LABELS[k].icon} />
                                                    {INTERFERENCE_LABELS[k].title}
                                                    {subs.length > 0 && (
                                                        <em>{subs.map((x) => SUBOPTION_LABELS[k][x] ?? x).join('、')}</em>
                                                    )}
                                                </span>
                                            );
                                        })}
                                </div>

                                <div className="sp-hist-foot">
                                    <span className="fc-muted">
                                        {dateText(s.startedAt)} · 你说了 {s.userTurnCount} 轮
                                        {s.targetWords.length > 0 && ` · 目标词 ${s.targetWords.length} 个`}
                                    </span>
                                    <span className="sp-hist-links">
                                        {s.status === 'active' && (
                                            <Link className="fc-btn fc-btn-primary" to={`/tools/speaking/${s.id}`}>
                                                <i className="fas fa-play" /> 接着练
                                            </Link>
                                        )}
                                        <Link className="fc-btn" to={`/tools/speaking/${s.id}/report`}>
                                            <i className={s.report ? 'fas fa-file-lines' : 'fas fa-wand-magic-sparkles'} />
                                            {s.report ? ' 看报告' : ' 生成报告'}
                                        </Link>
                                    </span>
                                </div>
                            </article>
                        );
                    })}
                </div>
        </AppShell>
    );
}
