// 学习界面：翻卡 → 评分 → 下一张。
//
// 每一次评分都是一次请求，服务端算完新状态**并落库**之后才返回下一张卡与进度。
// 也就是说这里没有任何「本地会话进度」：
//   · 关掉标签页，已评过的卡一张都不丢
//   · 刷新页面，进度和队列位置跟服务端完全一致
// 组件里存的 state 只是当前这一屏在显示什么，不是数据。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ProgressBar from '@/components/cards/ProgressBar';
import Markdown from '@/components/cards/Markdown';
import Loading from '@/components/Loading';
import { untilText, STATE_LABELS } from '@/lib/format';
import { apiRate, apiResetCard, apiStudyState } from '@/lib/api';
import {
    cancelSpeech, listEnglishVoices, looksEnglish, onVoicesReady,
    speakOnce, speechSynthesisSupported,
} from '@/lib/speech';
import { RATING_LABELS, type Rating, type StudyState } from '../../shared/types';

const RATING_ORDER: Rating[] = [1, 2, 3, 4];
const RATING_KEYS: Record<string, Rating> = { '1': 1, '2': 2, '3': 3, '4': 4 };

/** 朗读开关存本地：戴不戴耳机是这台机器当下的事，不值得为它开一次接口 */
const K_SPEAK = 'cards.speakEnglish';

/**
 * 这台机器上最好的那把英语嗓子。
 *
 * getVoices() 在部分浏览器上是异步填的，第一次同步取可能是空数组 ——
 * 所以拿不到就挂上 voiceschanged 等一次；拿到之后取消订阅。
 */
function useEnglishVoice(): SpeechSynthesisVoice | null {
    const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(() => listEnglishVoices()[0] ?? null);

    useEffect(() => {
        if (voice) return;
        return onVoicesReady(() => setVoice(listEnglishVoices()[0] ?? null));
    }, [voice]);

    return voice;
}

export default function StudyPage() {
    const { planId } = useParams();
    const id = Number(planId);
    const navigate = useNavigate();

    const [state, setState] = useState<StudyState | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // 这张卡是什么时候摆到眼前的 —— 用来算这一次评分花了多久
    const shownAt = useRef<number>(Date.now());

    // ---- 英文正面朗读 ----
    const canSpeak = speechSynthesisSupported();
    const [speakOn, setSpeakOn] = useState(
        () => typeof localStorage !== 'undefined' && localStorage.getItem(K_SPEAK) !== '0',
    );
    const voice = useEnglishVoice();
    // 声音是异步到位的。把它放进 ref 而不是进依赖数组 ——
    // 否则第一张卡会在「拿到声音之前」和「拿到之后」各念一遍
    const voiceRef = useRef(voice);
    voiceRef.current = voice;

    const load = useCallback(async () => {
        try {
            const s = await apiStudyState(id);
            setState(s);
            setRevealed(false);
            shownAt.current = Date.now();
            if (!s.card) navigate(`/tools/flashcards/${id}/result`, { replace: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : '加载失败');
        }
    }, [id, navigate]);

    useEffect(() => {
        document.title = '学习中 · 记忆卡';
        void load();
    }, [load]);

    const rate = useCallback(async (rating: Rating) => {
        if (!state?.card || busy) return;
        setBusy(true);
        try {
            const next = await apiRate(id, state.card.id, rating, Date.now() - shownAt.current);
            setState(next);
            setRevealed(false);
            shownAt.current = Date.now();
            if (!next.card) navigate(`/tools/flashcards/${id}/result`, { replace: true });
        } catch (e) {
            setError(e instanceof Error ? e.message : '提交评分失败');
        } finally {
            setBusy(false);
        }
    }, [busy, id, navigate, state]);

    /**
     * 重学：把这张卡的进度清零，重新当新卡。
     *
     * 给的是「这张我压根没学会过，四档里没有一档对得上」这种情况 ——
     * 评「重来」只是把间隔缩短，稳定度和难度还带着之前那一路的历史；
     * 重学是把这张卡的记忆模型整个推倒，从零开始。
     *
     * 三件事要交代清楚：
     *   1. **不写 reviews 流水**（走的是 /cards/:id/reset，跟管理页同一个接口），
     *      所以今日进度和统计都不受影响 —— 推倒重来不是一次复习
     *   2. 清完必须重取队列：这张卡从「复习卡」变成了「新卡」，
     *      在队列里的位置整个变了，接着用旧的 state 会拿它当复习卡继续排
     *   3. 它会不会当场再出现，取决于今天的新卡额度还剩不剩 ——
     *      额度用完的话它今天就不再露面了，这一点写进确认框里
     */
    const relearn = useCallback(async () => {
        if (!state?.card || busy) return;
        const raw = state.card.front;
        const label = raw.length > 30 ? `${raw.slice(0, 30)}…` : raw;
        // 用模板字符串直接写真换行 —— confirm 里要分行，
        // 拼 '\n' 反而更容易在编辑时被写坏
        const ok = window.confirm(
            `把「${label}」的进度清零、重新当新卡？

· 稳定度、难度、复习次数全部归零（历史流水保留）
· 不计入今日进度与统计
· 之后按新卡排队；今天新卡额度用完的话，它今天不再出现`,
        );
        if (!ok) return;

        setBusy(true);
        try {
            await apiResetCard(state.card.id);
            // 队列变了，整份重取 —— 不能只把当前这张换掉
            await load();
        } catch (e) {
            setError(e instanceof Error ? e.message : '重学失败');
        } finally {
            setBusy(false);
        }
    }, [busy, load, state]);

    const front = state?.card?.front ?? '';
    const speakable = canSpeak && speakOn && looksEnglish(front);

    /**
     * 换到新卡就念一遍正面。
     *
     * 依赖里只放正面文字和开关：卡片对象每次评分都会换新引用，
     * 但只有正面变了才该重念。卸载/切卡时 cancel —— 连着按键翻卡时，
     * 上一张的读音压着下一张说话比不念还糟。
     *
     * 注：直接刷新进这一页、且浏览器还没拿到任何用户手势时，
     * Chrome 的自动播放策略可能会把这次 speak 吞掉。不做兜底提示 ——
     * 点一下喇叭或翻一张卡就正常了，为它弹条横幅更吵。
     */
    useEffect(() => {
        if (!speakable) return;
        speakOnce(front, voiceRef.current);
        return () => cancelSpeech();
    }, [front, speakable]);

    const replay = useCallback(() => {
        if (speakable) speakOnce(front, voiceRef.current);
    }, [front, speakable]);

    const toggleSpeak = useCallback(() => {
        setSpeakOn((on) => {
            const next = !on;
            try { localStorage.setItem(K_SPEAK, next ? '1' : '0'); } catch { /* 无痕模式 */ }
            if (!next) cancelSpeech();
            return next;
        });
    }, []);

    // 空格翻面，1~4 评分，S 重听
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                if (!revealed) setRevealed(true);
                return;
            }
            if (e.key === 's' || e.key === 'S') { e.preventDefault(); replay(); return; }
            const r = RATING_KEYS[e.key];
            if (r && revealed) { e.preventDefault(); void rate(r); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [rate, replay, revealed]);

    if (error) {
        return (
            <div className="focus"><main className="focus-body">
                <p className="fc-error"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/tools/flashcards">← 返回学习计划列表</Link></p>
            </main></div>
        );
    }

    if (!state) {
        return (
            <div className="focus"><main className="focus-body">
                <Loading text="正在取今天的队列…" />
            </main></div>
        );
    }

    const card = state.card;
    if (!card) {
        return (
            <div className="focus"><main className="focus-body">
                <Loading text="今天学完了，正在生成成绩单…" />
            </main></div>
        );
    }

    return (
        <div className="focus fc-study-shell">
            <main className="focus-body fc-study">
                <div className="fc-study-top">
                    <Link className="fc-btn fc-btn-quiet" to={`/tools/flashcards/${id}`}>
                        <i className="fas fa-arrow-left" /> 退出
                    </Link>
                    <ProgressBar progress={state.progress} />

                    {/* 开关常驻，不随卡片是不是英文而出现/消失 ——
                        跳来跳去的按钮比多一个灰按钮更烦 */}
                    {canSpeak && (
                        <button
                            type="button"
                            className={'fc-btn fc-speak-toggle' + (speakOn ? ' is-on' : '')}
                            onClick={toggleSpeak}
                            aria-pressed={speakOn}
                            title={speakOn ? '关掉英文正面的自动朗读' : '打开英文正面的自动朗读'}
                        >
                            <i className={'fas ' + (speakOn ? 'fa-volume-high' : 'fa-volume-xmark')} />
                            {speakOn ? '朗读开' : '朗读关'}
                        </button>
                    )}
                </div>

                <article className="fc-stage">
                    <div className="fc-stage-badge">
                        <span className={'fc-state fc-state-' + card.state}>{STATE_LABELS[card.state]}</span>
                        {card.lapses > 0 && <span className="fc-muted">忘记过 {card.lapses} 次</span>}
                    </div>

                    <div className="fc-front-row">
                        <div className="fc-front">{card.front}</div>
                        {/* 喇叭只在这张卡真的会念时出现 —— 摆一个按了没反应的图标更糟 */}
                        {speakable && (
                            <button
                                type="button"
                                className="fc-icon-btn fc-replay"
                                onClick={replay}
                                title="再听一遍（S）"
                                aria-label="再听一遍"
                            >
                                <i className="fas fa-volume-high" />
                            </button>
                        )}
                    </div>

                    {revealed ? (
                        <>
                            <hr className="fc-divider" />
                            <Markdown className="fc-markdown fc-back" source={card.back} />
                        </>
                    ) : (
                        <button type="button" className="fc-reveal" onClick={() => setRevealed(true)}>
                            <i className="fas fa-eye" /> 显示答案 <kbd>空格</kbd>
                        </button>
                    )}
                </article>

                {revealed && (
                    <>
                        <div className="fc-ratings">
                            {RATING_ORDER.map((r) => (
                                <button
                                    key={r}
                                    type="button"
                                    className={'fc-rate fc-rate-' + r}
                                    disabled={busy}
                                    onClick={() => void rate(r)}
                                >
                                    <b>{RATING_LABELS[r]}</b>
                                    <small>{state.intervals ? untilText(state.intervals[r]) : ''}</small>
                                    <kbd>{r}</kbd>
                                </button>
                            ))}
                        </div>

                        {/* 重学摆在四档**外面**，不进 .fc-ratings ——
                            那四档是互斥且穷尽的一组，塞第五个按钮进去会让人以为
                            它也是一档评分（它不是：它不产生流水，也不计入今日进度）。
                            只在翻开答案后出现：没看见答案之前，判断不了自己是不是真忘干净了。
                            也不给键盘快捷键 —— 1~4 旁边再放一个键，手快时很容易误触，
                            而这个操作会把一张卡的记忆历史清空。 */}
                        <button
                            type="button"
                            className="fc-relearn"
                            disabled={busy}
                            onClick={() => void relearn()}
                            title="进度清零，这张卡重新当新卡"
                        >
                            <i className="fas fa-rotate-left" />
                            重学（进度清零，不计入统计）
                        </button>
                    </>
                )}

                <p className="fc-study-note">
                    每次评分立即存进数据库。中途关掉页面不会丢已评过的卡，下次进来接着这个位置继续。
                    {canSpeak && <>{' '}正面是英文时会自动念一遍（<kbd>S</kbd> 重听），不想要就点右上角关掉。</>}
                </p>
            </main>
        </div>
    );
}
