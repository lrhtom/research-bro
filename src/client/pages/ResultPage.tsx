// 今日成绩单。
//
// 两组数字刻意分开列，绝不并排放在同一行：
//   · 四个桶按「张」算 —— 互斥且穷尽，加起来正好等于今天学完的卡数
//   · 评分次数按「次」算 —— 一张卡评了四次就是四次
// 混在一起看会得出完全错误的结论，所以下面把口径明明白白写在标题里。

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { FLASHCARD_SECTIONS } from '@/lib/nav';
import Loading from '@/components/Loading';
import { apiSessionResult } from '@/lib/api';
import { dateText, durationText, STATE_LABELS, untilText } from '@/lib/format';
import { BUCKET_LABELS, RATING_LABELS, type Bucket, type Rating, type SessionResult } from '../../shared/types';

const BUCKET_ORDER: Bucket[] = ['relearned', 'hard', 'good', 'easy'];
const RATING_ORDER: Rating[] = [1, 2, 3, 4];

export default function ResultPage() {
    const { planId } = useParams();
    const id = Number(planId);
    const [result, setResult] = useState<SessionResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        document.title = '今日成绩单 · 记忆卡';
        apiSessionResult(id)
            .then(setResult)
            .catch((e: Error) => setError(e.message));
    }, [id]);

    if (error) {
        return (
            <AppShell title="今日成绩单" subtitle="Session Result" sections={FLASHCARD_SECTIONS}>
                <p className="u-msg u-msg-error"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/tools/flashcards">← 返回学习计划列表</Link></p>
            </AppShell>
        );
    }

    if (!result) {
        return (
            <AppShell title="今日成绩单" subtitle="Session Result" sections={FLASHCARD_SECTIONS}>
                <Loading block text="正在结算今天学过的卡…" />
            </AppShell>
        );
    }

    const bucketSum = BUCKET_ORDER.reduce((a, b) => a + result.buckets[b], 0);

    return (
        <AppShell
            title="今日成绩单"
            subtitle={`Session Result · ${result.day}`}
            sections={FLASHCARD_SECTIONS}
            actions={
                <Link className="u-btn" to={`/tools/flashcards/${id}`}>
                    <i className="fas fa-pen-to-square" /> 回到这个计划
                </Link>
            }
        >

                {result.finished === 0 ? (
                    <p className="fc-empty">今天还没学完任何卡片。</p>
                ) : (
                    <>
                        <div className="fc-result-hero">
                            <div>
                                <b>{result.finished}</b>
                                <span>今天学完（张）</span>
                            </div>
                            <div>
                                <b>{durationText(result.durationMs)}</b>
                                <span>用时</span>
                            </div>
                            <div>
                                <b>{result.totalTimes}</b>
                                <span>评分次数（次）</span>
                            </div>
                        </div>

                        <div className="section-head">
                            <h2><i className="fas fa-chart-pie" /> 按卡片分布（单位：张）</h2>
                            <span className="count">
                                四类相加 {bucketSum} = 学完 {result.finished} 张
                            </span>
                        </div>
                        <p className="fc-muted fc-note">
                            今天<b>任何时刻</b>按过一次「重来」的卡片，只计入「重新学会」，不会再出现在其它三类里 ——
                            所以这四个数字互不重叠，加起来必然等于学完的卡数。
                        </p>
                        <ul className="fc-bucket-row">
                            {BUCKET_ORDER.map((b) => (
                                <li key={b} className={'fc-bucket fc-bucket-' + b}>
                                    <b>{result.buckets[b]}</b>
                                    <span>{BUCKET_LABELS[b]}</span>
                                </li>
                            ))}
                        </ul>

                        <div className="section-head">
                            <h2><i className="fas fa-hand-pointer" /> 按点击分布（单位：次）</h2>
                            <span className="count">共 {result.totalTimes} 次</span>
                        </div>
                        <p className="fc-muted fc-note">
                            这是<b>点了多少次</b>，不是学完多少张 —— 一张卡评过三次「重来」再评一次「良好」，
                            在上面算 <b>1 张</b>，在这里算 <b>4 次</b>。两种口径不能相加。
                        </p>
                        <ul className="fc-bucket-row">
                            {RATING_ORDER.map((r) => (
                                <li key={r} className={'fc-bucket fc-rate-tint-' + r}>
                                    <b>{result.times[r]}</b>
                                    <span>{RATING_LABELS[r]}</span>
                                </li>
                            ))}
                        </ul>

                        <div className="section-head">
                            <h2><i className="fas fa-calendar-check" /> 下次复习时间</h2>
                            <span className="count">{result.cards.length} 张</span>
                        </div>
                        <table className="fc-table">
                            <thead>
                                <tr><th>卡片</th><th>归类</th><th>状态</th><th>下次到期</th></tr>
                            </thead>
                            <tbody>
                                {result.cards.map((c) => (
                                    <tr key={c.id}>
                                        <td>{c.front.slice(0, 70)}</td>
                                        <td><span className={'fc-tag fc-bucket-' + c.bucket}>{BUCKET_LABELS[c.bucket]}</span></td>
                                        <td>{STATE_LABELS[c.state]}</td>
                                        <td>{untilText(c.due)}<span className="fc-muted"> · {dateText(c.due)}</span></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
        </AppShell>
    );
}
