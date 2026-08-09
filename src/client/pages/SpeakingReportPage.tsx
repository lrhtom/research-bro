// ============================================================
//  英语口语场景练习 · 反馈报告
//
//  ★ 这一页最重要的是它**不显示什么**。
//
//  模型看到的全部东西 = 你打的字，或者浏览器语音识别猜出来的字。
//  它从头到尾没有听过你的声音。所以：
//    · 没有发音分、没有准确率百分比、没有音素级点评
//    · 没有语调 / 重音 / 节奏 / 口音的任何judgement
//    · 没有语速（每分钟多少词），也没有任何由时间推出来的结论
//    · 没有当成考试成绩摆出来的总分
//  这些数字要么得有音频才算得出来，要么就是编的。界面上那个「发音」位置
//  明明白白写着「未评估」，并说清楚为什么 —— 空着不写，用户会以为是没测出来。
//
//  能给的都建立在转录稿上，而且每一条都挂着你自己的原话：
//  任务完成度、词汇、语法、话轮应对、目标词、下一步。
//  服务端还会把引不出原话的条目直接删掉（speaking.ts 的 sanitizeReport）。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { SPEAKING_SECTIONS } from '@/lib/nav';
import { apiGetSpeakingSession, apiSpeakingReport } from '@/lib/api';
import { INTERFERENCE_LABELS, SUBOPTION_LABELS, type InterferenceKey } from '../../shared/speaking';
import type { SpeakingReport, SpeakingSessionFull } from '../../shared/types';

const VERDICT: Record<SpeakingReport['taskAchievement']['verdict'], { text: string; cls: string }> = {
    achieved: { text: '办成了', cls: 'ok' },
    partial: { text: '办成了一半', cls: 'partial' },
    'not-achieved': { text: '没办成', cls: 'bad' },
};

function Quote({ text }: { text: string }) {
    if (!text) return null;
    return <blockquote className="sp-quote">{text}</blockquote>;
}

export default function SpeakingReportPage() {
    const { sessionId } = useParams();
    const id = Number(sessionId);

    const [session, setSession] = useState<SpeakingSessionFull | null>(null);
    const [report, setReport] = useState<SpeakingReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(true);

    const load = useCallback(async (regenerate = false) => {
        setBusy(true); setError(null);
        try {
            const full = await apiGetSpeakingSession(id);
            setSession(full);
            if (full.report && !regenerate) { setReport(full.report); return; }
            setReport((await apiSpeakingReport(id, regenerate)).report);
        } catch (e) {
            setError(e instanceof Error ? e.message : '生成报告失败');
        } finally { setBusy(false); }
    }, [id]);

    useEffect(() => {
        document.title = '口语练习报告 · 工具箱';
        void load();
    }, [load]);

    const userTurns = session?.turns.filter((t) => t.role === 'user') ?? [];

    return (
        <AppShell
            title="口语练习报告"
            subtitle={session?.label ? `Session Report · ${session.label}` : 'Session Report'}
            sections={SPEAKING_SECTIONS}
            actions={
                <>
                    {report && !report.empty && (
                        <button type="button" className="u-btn" onClick={() => void load(true)} disabled={busy}>
                            <i className="fas fa-rotate" /> 重新生成
                        </button>
                    )}
                    <Link className="u-btn u-btn-primary" to="/tools/speaking">
                        <i className="fas fa-play" /> 再练一场
                    </Link>
                </>
            }
        >
                {error && <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>}
                {busy && !report && (
                    <p className="u-muted"><i className="fas fa-spinner fa-spin" /> 正在读你说过的话、生成反馈…</p>
                )}

                {/* ---------- 这次是在什么条件下练的 ---------- */}
                {session && (
                    <div className="sp-report-context">
                        <div>
                            <span className="sp-ctx-label">场景</span>
                            <p>{session.scenario}</p>
                        </div>
                        <div>
                            <span className="sp-ctx-label">干扰项</span>
                            <p>
                                {Object.keys(session.modifiers).length === 0
                                    ? '无 —— 标准英语的正常对话'
                                    : (Object.keys(session.modifiers) as InterferenceKey[]).map((k) => {
                                        const subs = session.modifiers[k] ?? [];
                                        return INTERFERENCE_LABELS[k].title
                                            + (subs.length
                                                ? `（${subs.map((s) => SUBOPTION_LABELS[k][s] ?? s).join('、')}）`
                                                : '');
                                    }).join(' · ')}
                            </p>
                        </div>
                        <div>
                            <span className="sp-ctx-label">你说了</span>
                            <p>
                                {userTurns.length} 轮
                                {userTurns.length > 0 && (
                                    <>
                                        {' · '}
                                        {userTurns.filter((t) => t.source === 'speech').length} 轮说的、
                                        {userTurns.filter((t) => t.source === 'typed').length} 轮打的
                                    </>
                                )}
                            </p>
                        </div>
                    </div>
                )}

                {report?.empty ? (
                    <p className="fc-empty" style={{ marginTop: 20 }}>
                        这场练习里你一句话都没说 —— 没有可点评的内容，所以这里不会有评价。<br />
                        <Link to="/tools/speaking">换个场景再来一次 →</Link>
                    </p>
                ) : report && (
                    <>
                        <p className="sp-summary">{report.summary}</p>

                        {/* ---------- 发音位：明确写清楚没测 ---------- */}
                        <div className="section-head">
                            <h2><i className="fas fa-microphone-slash" /> 发音</h2>
                        </div>
                        <div className="sp-not-assessed">
                            <b>未评估 —— 本模式不做任何音频分析</b>
                            <p>
                                这个功能全程<b>没有录音</b>：你说的话是由浏览器自带的语音识别在本地
                                转成文字的，模型只读到那串文字，<b>从来没有听过你的声音</b>。
                                所以发音、语调、重音、口音、语速这些都无从判断 ——
                                这里给出任何一个数字，都是凭空编的。
                            </p>
                        </div>

                        {/* ---------- 任务完成度 ---------- */}
                        <div className="section-head">
                            <h2><i className="fas fa-bullseye" /> 事儿办成了吗</h2>
                            <span className={'sp-verdict sp-verdict-' + VERDICT[report.taskAchievement.verdict].cls}>
                                {VERDICT[report.taskAchievement.verdict].text}
                            </span>
                        </div>
                        <p className="sp-point-text">{report.taskAchievement.comment}</p>
                        <Quote text={report.taskAchievement.quote} />

                        {/* ---------- 词汇 ---------- */}
                        <div className="section-head">
                            <h2><i className="fas fa-book" /> 换个说法会更地道</h2>
                            <span className="count">{report.vocabulary.length} 处</span>
                        </div>
                        {report.vocabulary.length === 0 ? (
                            <p className="fc-empty">没有找到需要改的地方（或者能引出原话的都被筛掉了）。</p>
                        ) : (
                            <ul className="sp-points">
                                {report.vocabulary.map((p, i) => (
                                    <li key={i}>
                                        <Quote text={p.quote} />
                                        <p className="sp-better"><i className="fas fa-arrow-right" /> {p.suggestion}</p>
                                        <p className="fc-muted">{p.why}</p>
                                    </li>
                                ))}
                            </ul>
                        )}

                        {/* ---------- 语法 ---------- */}
                        <div className="section-head">
                            <h2><i className="fas fa-spell-check" /> 最该改的语法</h2>
                            <span className="count">{report.grammar.length} 处</span>
                        </div>
                        {report.grammar.length === 0 ? (
                            <p className="fc-empty">没有挑出值得单独说的语法问题。</p>
                        ) : (
                            <ul className="sp-points">
                                {report.grammar.map((p, i) => (
                                    <li key={i}>
                                        <Quote text={p.quote} />
                                        <p className="sp-better"><i className="fas fa-arrow-right" /> {p.suggestion}</p>
                                        <p className="fc-muted">{p.why}</p>
                                    </li>
                                ))}
                            </ul>
                        )}

                        {/* ---------- 话轮应对 ---------- */}
                        <div className="section-head">
                            <h2><i className="fas fa-arrows-turn-to-dots" /> 你是怎么接话的</h2>
                        </div>
                        <p className="sp-point-text">{report.turnTaking.comment}</p>
                        <Quote text={report.turnTaking.quote} />

                        {/* ---------- 目标词 ---------- */}
                        {report.targetWords.length > 0 && (
                            <>
                                <div className="section-head">
                                    <h2><i className="fas fa-list-check" /> 目标词</h2>
                                    <span className="count">
                                        用上 {report.targetWords.filter((w) => w.used).length} / {report.targetWords.length}
                                    </span>
                                </div>
                                <p className="fc-muted fc-note">
                                    这一栏是<b>从你的原话里数出来的</b>，不问模型 ——
                                    模型看见词表就容易把你没说过的词也算成说过了。
                                </p>
                                <ul className="sp-words sp-words-report">
                                    {report.targetWords.map((w) => (
                                        <li key={w.en} className={w.used ? 'on' : 'off'}>
                                            <i className={w.used ? 'fas fa-circle-check' : 'fas fa-circle-minus'} />
                                            <b>{w.en}</b>
                                            {w.zh && <span>{w.zh}</span>}
                                            <em>{w.used ? `用了 ${w.count} 次` : '没用上'}</em>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}

                        {/* ---------- 下一步 ---------- */}
                        {report.nextSteps.length > 0 && (
                            <>
                                <div className="section-head">
                                    <h2><i className="fas fa-forward" /> 下次试试这几件事</h2>
                                </div>
                                <ol className="sp-next">
                                    {report.nextSteps.map((s, i) => <li key={i}>{s}</li>)}
                                </ol>
                            </>
                        )}

                        {report.droppedPoints > 0 && (
                            <p className="fc-muted fc-note fc-footnote">
                                <i className="fas fa-shield" /> 服务端在校验时删掉了 <b>{report.droppedPoints}</b> 条 ——
                                它们要么在你说过的话里找不到出处，要么含有发音 / 语调 / 语速 / 总分这类
                                <b>没有音频就得不出来</b>的断言。这类内容不会显示给你，因为它们是编的。
                            </p>
                        )}
                    </>
                )}

                {/* ---------- 完整对话 ---------- */}
                {session && session.turns.length > 0 && (
                    <>
                        <div className="section-head">
                            <h2><i className="fas fa-comments" /> 完整对话</h2>
                            <span className="count">{session.turns.length} 轮</span>
                        </div>
                        <div className="sp-transcript">
                            {session.turns.map((t) => (
                                <div key={t.id} className={'sp-tr sp-tr-' + t.role}>
                                    <span className="sp-tr-who">
                                        {t.role === 'assistant' ? '对方' : '你'}
                                        {t.role === 'user' && (
                                            <em>{t.source === 'typed' ? '打字' : '识别'}</em>
                                        )}
                                    </span>
                                    <p>{t.content}</p>
                                </div>
                            ))}
                        </div>
                    </>
                )}
        </AppShell>
    );
}
