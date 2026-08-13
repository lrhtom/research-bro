// ============================================================
//  英语口语场景练习 · 对话现场
//
//  六个状态：loading | mic_loading | idle | listening | processing | speaking | finished
//
//  两条输入路径都是一等公民：
//    · 语音 —— 浏览器自带的 SpeechRecognition，连续识别、边说边显示。
//              识别结果是**猜的**，所以提交时标成 source='speech'，
//              报告那边据此知道「怪词多半是识别错了，不是他说错了」。
//    · 打字 —— 浏览器不支持、或者用户拒绝麦克风、或者此刻不方便出声时用。
//              它能完整走完一整场练习并出报告，不是个占位的降级方案。
//  当前用的是哪条路，界面上一直显示着，随时可以切。
//
//  「隐藏字幕」放在主操作栏上而不是塞进设置里 ——
//  看不见字、只能靠听的时候，才是真的在练听力。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
    apiFinishSpeakingSession, apiGetSpeakingSession, apiSpeakingOpening, apiSpeakingTurn,
} from '@/lib/api';
import { AudioQualityFx } from '@/lib/audio-effects';
import { NoiseAmbience } from '@/lib/noise-ambience';
import {
    Recognizer, SentenceSpeaker, TIER_LABEL, bestAvailableTier, listEnglishVoices,
    onVoicesReady, speechRecognitionSupported, speechSynthesisSupported, voiceTier,
} from '@/lib/speech';
import {
    INTERFERENCE_LABELS, SUBOPTION_LABELS, tallyTargetWords,
    type InterferenceKey,
} from '../../shared/speaking';
import type { SpeakingSessionFull, SpeakingTurn } from '../../shared/types';

type Status = 'loading' | 'mic_loading' | 'idle' | 'listening' | 'processing' | 'speaking' | 'finished';
type InputMode = 'speech' | 'typed';

const STATUS_TEXT: Record<Status, string> = {
    loading: '正在准备…',
    mic_loading: '正在开麦克风…',
    idle: '轮到你了',
    listening: '正在听你说…',
    processing: '对方在思考…',
    speaking: '对方正在说',
    finished: '这场练习已经结束',
};

/** 等待回复时占位的「对方在思考」气泡 */
function ThinkingBubble() {
    return (
        <article className="sp-turn sp-turn-assistant">
            <div className="sp-turn-who">对方</div>
            <p className="sp-thinking">
                <span className="sp-dots"><i /><i /><i /></span>
                对方在思考…
            </p>
        </article>
    );
}

export default function SpeakingRoomPage() {
    const { sessionId } = useParams();
    const id = Number(sessionId);
    const navigate = useNavigate();

    const [session, setSession] = useState<SpeakingSessionFull | null>(null);
    const [turns, setTurns] = useState<SpeakingTurn[]>([]);
    const [status, setStatus] = useState<Status>('loading');
    const [error, setError] = useState<string | null>(null);

    // 输入
    const [mode, setMode] = useState<InputMode>(
        speechRecognitionSupported() ? 'speech' : 'typed',
    );
    const [micDenied, setMicDenied] = useState(false);
    const [heard, setHeard] = useState({ final: '', interim: '' });
    const [typed, setTyped] = useState('');
    /** 语音那一路：识别完先落到这里，改完再按「发送」 */
    const [draft, setDraft] = useState('');
    /**
     * 这份草稿里有没有识别器的成分。
     *
     * 关系到报告那道边界：标成 speech 的句子，模型会知道「怪词多半是听错了」；
     * 可如果在语音模式下整句都是自己敲的，再标 speech 就是在替它开脱。
     * 所以按草稿的真实来源标，而不是按当前选的模式标。
     */
    const [draftFromSpeech, setDraftFromSpeech] = useState(false);

    // 输出
    const [hideText, setHideText] = useState(false);
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [voiceName, setVoiceName] = useState('');
    const [rate, setRate] = useState(1);
    const [muted, setMuted] = useState(false);
    /** 正在流式生成的那段回复，还没落库 */
    const [streaming, setStreaming] = useState('');
    /**
     * AI 这一轮没出声、服务端正在重来，值是第几次。
     *
     * 要显示出来而不是默默重试：对方突然沉默几秒，用户不知道是网卡了、
     * 是自己说错了、还是程序死了 —— 说一句「没听清，正在重来」，
     * 这几秒就从故障变成了正常等待。
     */
    const [retrying, setRetrying] = useState(0);

    const recognizerRef = useRef<Recognizer | null>(null);
    const speakerRef = useRef<SentenceSpeaker | null>(null);
    const fxRef = useRef<AudioQualityFx | null>(null);
    const ambienceRef = useRef<NoiseAmbience | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const startedRef = useRef(false);

    // 这两个值要在回调里读最新的，用 ref 兜住
    const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
    const rateRef = useRef(1);
    const mutedRef = useRef(false);
    rateRef.current = rate;
    mutedRef.current = muted;

    const ttsSupported = speechSynthesisSupported();

    // ---------- 声音列表 ----------
    //
    // Edge 上那批 “… Online (Natural)” 是云端语音，**第一次同步调用
    // getVoices() 往往还没有它们**，要等 voiceschanged 再来一次。
    // 所以只要用户没有自己动过下拉框，每次列表变化都重新挑一次最好的 ——
    // 否则会被第一批返回的本地机器音钉死，Sonia 到了也切不过去。
    const userPickedVoiceRef = useRef(false);

    useEffect(() => {
        const load = () => {
            // listEnglishVoices 已经按品质排好序，[0] 就是这台机器上最好听的那个。
            // 绝不能直接用 getVoices() 的原始顺序 —— 系统往往把最机器的那个排最前。
            const list = listEnglishVoices();
            setVoices(list);
            if (!userPickedVoiceRef.current && list.length) setVoiceName(list[0].name);
        };
        load();
        return onVoicesReady(load);   // 部分浏览器是异步填的
    }, []);

    useEffect(() => {
        voiceRef.current = voices.find((v) => v.name === voiceName) ?? voices[0] ?? null;
    }, [voices, voiceName]);

    // ---------- 干扰项：音质 + 环境噪音 ----------
    useEffect(() => {
        if (!session) return;

        // 没勾「音质劣化」就一个 AudioContext 都不建、attach 也不会被调用
        const qualitySubs = session.modifiers.audioquality;
        if (qualitySubs !== undefined) {
            if (!fxRef.current) fxRef.current = new AudioQualityFx();
            // 开了但没选具体档位 → 默认电话音质
            fxRef.current.setProfiles(qualitySubs.length ? qualitySubs : ['phone']);
        } else {
            fxRef.current?.setProfiles([]);
        }

        const noiseSubs = session.modifiers.noise;
        if (noiseSubs !== undefined) {
            if (!ambienceRef.current) ambienceRef.current = new NoiseAmbience();
            void ambienceRef.current.start(noiseSubs);
        } else {
            ambienceRef.current?.stop();
            ambienceRef.current = null;
        }
    }, [session]);

    useEffect(() => { ambienceRef.current?.setMuted(muted); }, [muted]);

    // 卸载时把音频资源全部释放
    useEffect(() => () => {
        speakerRef.current?.cancel();
        recognizerRef.current?.abort();
        ambienceRef.current?.stop(); ambienceRef.current = null;
        fxRef.current?.dispose(); fxRef.current = null;
    }, []);

    // ---------- 朗读器 ----------
    if (!speakerRef.current) {
        speakerRef.current = new SentenceSpeaker({
            voice: () => voiceRef.current,
            rate: () => rateRef.current,
            tune: (u) => {
                if (mutedRef.current) { u.volume = 0; return; }
                fxRef.current?.tuneUtterance(u);
            },
            onStart: () => {
                if (!mutedRef.current) fxRef.current?.startArtefacts();
                setStatus((s) => (s === 'finished' ? s : 'speaking'));
            },
            onDone: () => {
                fxRef.current?.stopArtefacts();
                setStatus((s) => (s === 'finished' ? s : 'idle'));
            },
        });
    }

    // ---------- 载入会话 + 开场白 ----------
    const load = useCallback(async () => {
        try {
            const full = await apiGetSpeakingSession(id);
            setSession(full);
            setTurns(full.turns);

            if (full.status === 'finished') { setStatus('finished'); return; }

            if (full.turns.length === 0 && !startedRef.current) {
                startedRef.current = true;
                setStatus('processing');
                const opening = await apiSpeakingOpening(id);
                setTurns([opening]);
                speakerRef.current?.speakAll(opening.content);
                // 没有语音合成的浏览器不会触发 onStart/onDone，这里兜一下
                if (!speechSynthesisSupported()) setStatus('idle');
            } else {
                setStatus('idle');
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : '载入失败');
            setStatus('idle');
        }
    }, [id]);

    useEffect(() => {
        document.title = '英语口语练习 · 工具箱';
        void load();
    }, [load]);

    // 有新内容就滚到底
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [turns, streaming]);

    // ---------- 语音识别 ----------
    function ensureRecognizer(): Recognizer {
        if (!recognizerRef.current) {
            recognizerRef.current = new Recognizer({
                onResult: (r) => setHeard(r),
                onError: (code) => {
                    if (code === 'not-allowed' || code === 'service-not-allowed') {
                        setMicDenied(true);
                        setMode('typed');
                        setError('拿不到麦克风权限，已经切到打字模式 —— 打字一样能完整练完。');
                    } else {
                        setError(`语音识别出错（${code}），可以切到打字模式继续。`);
                    }
                    setStatus('idle');
                },
                onEnd: () => {
                    // 浏览器有时会自己停（静音超时），还在听的状态就自动接上
                    setStatus((s) => {
                        if (s === 'listening') { recognizerRef.current?.start(); return s; }
                        return s;
                    });
                },
            });
        }
        return recognizerRef.current;
    }

    function startListening() {
        setError(null);
        speakerRef.current?.cancel();
        fxRef.current?.stopArtefacts();
        const rec = ensureRecognizer();
        rec.reset();
        setHeard({ final: '', interim: '' });
        setStatus('mic_loading');
        if (rec.start()) setStatus('listening');
        else { setStatus('idle'); setError('这台浏览器起不了语音识别，请用打字模式。'); }
    }

    /**
     * 停止识别，把听到的文字放进可编辑的草稿框里等你确认。
     *
     * 刻意不自动发出去：浏览器的识别经常听岔，发出去之后
     * AI 就是照着那句错的答的，你还得再解释一遍。
     * 停下来能改一个字，比重说一整句省事得多。
     */
    function stopListening() {
        const rec = recognizerRef.current;
        if (!rec) return;
        const text = rec.stop();
        rec.reset();
        setHeard({ final: '', interim: '' });
        setStatus('idle');
        if (text) {
            setDraft((cur) => (cur ? `${cur} ${text}` : text));
            setDraftFromSpeech(true);
        } else {
            setError('没听到内容 —— 再说一次，或者直接在右边的框里打字。');
        }
    }

    // ---------- 提交一轮 ----------
    const send = useCallback(async (content: string, source: 'typed' | 'speech') => {
        const text = content.trim();
        if (!text || status === 'processing') return;

        setError(null);
        setStatus('processing');
        // 先本地插一条，不等服务端 —— 说完立刻看到自己那句
        setTurns((cur) => [...cur, {
            id: -Date.now(), role: 'user', content: text, source,
            seq: cur.length + 1, saidAt: new Date().toISOString(),
        }]);
        setTyped('');
        setStreaming('');

        const speaker = speakerRef.current!;
        speaker.reset();

        try {
            let acc = '';
            const { turn, error: streamErr } = await apiSpeakingTurn(id, text, source, {
                onDelta: (piece) => {
                    acc += piece;
                    setStreaming(acc);
                    // 攒够一句就先念，不等整段回完
                    speaker.push(piece);
                },
                // 服务端这一次没出声、正在重来：把收到的半截连同朗读队列一起清掉，
                // 否则重试的正文会接在上一次那几个空白字符后面
                onRetry: (attempt) => {
                    acc = '';
                    setStreaming('');
                    speaker.reset();
                    setRetrying(attempt);
                },
            });
            speaker.flush();
            setStreaming('');
            setRetrying(0);

            if (streamErr) { setError(streamErr); setStatus('idle'); return; }
            if (turn) setTurns((cur) => [...cur, turn]);
            if (!speechSynthesisSupported() || mutedRef.current) setStatus('idle');
        } catch (e) {
            setStreaming('');
            setRetrying(0);
            setError(e instanceof Error ? e.message : '这一轮没能送出去');
            setStatus('idle');
        }
    }, [id, status]);

    // ---------- 结束 ----------
    async function finish() {
        speakerRef.current?.cancel();
        recognizerRef.current?.abort();
        ambienceRef.current?.stop();
        fxRef.current?.stopArtefacts();
        setStatus('finished');
        try { await apiFinishSpeakingSession(id); } catch { /* 报告页还会再兜一次 */ }
        navigate(`/tools/speaking/${id}/report`);
    }

    // ---------- 派生 ----------
    const usedWords = useMemo(() => {
        if (!session) return [];
        return tallyTargetWords(
            session.targetWords,
            turns.filter((t) => t.role === 'user').map((t) => t.content),
        );
    }, [session, turns]);

    const activeMods = useMemo(() => {
        if (!session) return [] as Array<{ k: InterferenceKey; subs: string[] }>;
        return (Object.keys(session.modifiers) as InterferenceKey[])
            .map((k) => ({ k, subs: session.modifiers[k] ?? [] }));
    }, [session]);

    const busy = status === 'processing';
    const lastAi = [...turns].reverse().find((t) => t.role === 'assistant');

    if (error && !session) {
        return (
            <div className="focus"><main className="focus-body">
                <p className="fc-error"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/tools/speaking">← 回到设置页</Link></p>
            </main></div>
        );
    }

    return (
        <div className="focus sp-shell">
            <header className="sp-topbar">
                <Link to="/tools/speaking" className="back-badge" title="返回设置页">
                    <i className="fas fa-arrow-left" />
                </Link>
                <div className="sp-topbar-title">
                    <b>{session?.label || '口语练习'}</b>
                    <span className={'sp-status sp-status-' + status}>
                        {status === 'processing' && <i className="fas fa-spinner fa-spin" />}
                        {status === 'listening' && <i className="fas fa-microphone" />}
                        {status === 'speaking' && <i className="fas fa-volume-high" />}
                        {' '}{STATUS_TEXT[status]}
                    </span>
                </div>

                {/* 干扰项一直挂在顶栏：这段对话是在什么条件下发生的，必须一眼看得到 */}
                <div className="sp-mod-chips">
                    {activeMods.length === 0
                        ? <span className="fc-muted">标准英语 · 无干扰</span>
                        : activeMods.map(({ k, subs }) => (
                            <span key={k} className="sp-chip" title={INTERFERENCE_LABELS[k].hint}>
                                <i className={'fas ' + INTERFERENCE_LABELS[k].icon} />
                                {INTERFERENCE_LABELS[k].title}
                                {subs.length > 0 && (
                                    <em>{subs.map((s) => SUBOPTION_LABELS[k][s] ?? s).join('、')}</em>
                                )}
                            </span>
                        ))}
                </div>

                <button type="button" className="fc-btn" onClick={() => void finish()}>
                    <i className="fas fa-flag-checkered" /> 结束并生成报告
                </button>
            </header>

            {/* ---------- 主操作栏 ---------- */}
            <div className="sp-bar">
                <button
                    type="button"
                    className={'sp-bar-btn' + (hideText ? ' on' : '')}
                    onClick={() => setHideText((h) => !h)}
                    title="盖住字幕，只靠听 —— 这才是真的在练听力"
                >
                    <i className={hideText ? 'fas fa-eye-slash' : 'fas fa-eye'} />
                    {hideText ? '字幕已隐藏' : '隐藏字幕'}
                </button>

                <button
                    type="button"
                    className="sp-bar-btn"
                    onClick={() => {
                        // 刷新过页面的话，朗读器手里是空的（对话是从库里读回来的，没念过）——
                        // 这时直接把最后一句 AI 的话重新念一遍，而不是让按钮变成死的
                        if (speakerRef.current?.hasSpoken) speakerRef.current.replay();
                        else if (lastAi) speakerRef.current?.speakAll(lastAi.content);
                    }}
                    disabled={!ttsSupported || busy || !lastAi}
                    title="再听一遍对方刚才说的话"
                >
                    <i className="fas fa-rotate-left" /> 重听上一句
                </button>

                <button
                    type="button"
                    className={'sp-bar-btn' + (muted ? ' on' : '')}
                    onClick={() => {
                        const next = !muted;
                        setMuted(next);
                        if (next) { speakerRef.current?.cancel(); fxRef.current?.stopArtefacts(); setStatus('idle'); }
                    }}
                >
                    <i className={muted ? 'fas fa-volume-xmark' : 'fas fa-volume-high'} />
                    {muted ? '已静音' : '有声'}
                </button>

                <label className="sp-voice">
                    <span>声音</span>
                    <select
                        value={voiceName}
                        onChange={(e) => { userPickedVoiceRef.current = true; setVoiceName(e.target.value); }}
                        disabled={!ttsSupported}
                    >
                        {voices.length === 0 && <option value="">（没有可用的英语声音）</option>}
                        {voices.map((v) => (
                            <option key={v.name} value={v.name}>
                                [{TIER_LABEL[voiceTier(v)]}] {v.name}（{v.lang}）
                            </option>
                        ))}
                    </select>
                </label>

                <label className="sp-rate">
                    <span>语速 {rate.toFixed(1)}×</span>
                    <input
                        type="range" min={0.6} max={1.6} step={0.1}
                        value={rate}
                        onChange={(e) => setRate(Number(e.target.value))}
                        disabled={!ttsSupported}
                    />
                </label>

                {/* 这台机器上最好的也只是老式 SAPI 声音时，明确指路到 Edge 的 Natural 系列 ——
                    机器音会让整个练习的听感垮掉，而换个浏览器打开是零成本的事 */}
                {ttsSupported && bestAvailableTier(voices) === 'standard' && (
                    <span className="sp-voice-tip">
                        <i className="fas fa-lightbulb" />
                        当前只有机器音。<b>用 Microsoft Edge 打开本页</b>就能直接选到微软的神经网络语音
                        <b>Microsoft … Online (Natural)</b> 系列 —— 英式的 <b>Sonia / Ryan</b>、
                        美式的 <b>Aria / Guy</b>，免费免登录，听感接近真人，打开后本页会自动选中最好的那个。
                        （这几把是云端合成，需要联网；Chrome 通常看不到它们。）
                        也可以在 Windows「设置 → 时间和语言 → 语音 → 添加声音」装英语（英国）自然语音，
                        或在 macOS「系统设置 → 辅助功能 → 朗读内容」下载 Enhanced / Premium 那一档。
                    </span>
                )}
            </div>

            {/* ---------- 对话 ---------- */}
            <div className="sp-body">
                <div className="sp-thread" ref={scrollRef}>
                    {turns.map((t) => (
                        <article
                            key={t.id}
                            className={'sp-turn sp-turn-' + t.role + (hideText && t.role === 'assistant' ? ' is-hidden' : '')}
                        >
                            <div className="sp-turn-who">
                                {t.role === 'assistant' ? '对方' : '你'}
                                {t.role === 'user' && (
                                    <span className="sp-src" title={t.source === 'typed'
                                        ? '这句是你打字输入的'
                                        : '这句是浏览器语音识别猜出来的文字，可能有出入'}>
                                        {t.source === 'typed' ? '打字' : '识别'}
                                    </span>
                                )}
                            </div>
                            {hideText && t.role === 'assistant' ? (
                                <p className="sp-hidden-note">
                                    <i className="fas fa-ear-listen" /> 字幕已隐藏 —— 用「重听上一句」再听一遍
                                </p>
                            ) : (
                                <p className="sp-turn-text">{t.content}</p>
                            )}
                        </article>
                    ))}

                    {/* 还没吐出第一个字的这段空窗最难受 —— 顶栏那一行小字太容易漏看，
                        所以在对话流里直接占一个气泡，跟真人聊天时的「正在输入」一个意思 */}
                    {(status === 'processing' || status === 'loading') && !streaming && <ThinkingBubble />}

                    {/* 重试中。不写成红色错误 —— 它还在自己想办法，用户什么都不用做 */}
                    {retrying > 0 && (
                        <p className="sp-retry-note">
                            <i className="fas fa-rotate fa-spin" />
                            对方那边没出声，正在重来（第 {retrying + 1} 次）…
                        </p>
                    )}

                    {streaming && (
                        <article className={'sp-turn sp-turn-assistant' + (hideText ? ' is-hidden' : '')}>
                            <div className="sp-turn-who">对方</div>
                            {hideText
                                ? <p className="sp-hidden-note"><i className="fas fa-ear-listen" /> 正在说…</p>
                                : <p className="sp-turn-text">{streaming}<span className="sp-caret" /></p>}
                        </article>
                    )}

                    {status === 'finished' && (
                        <p className="fc-ok" style={{ marginTop: 16 }}>
                            <i className="fas fa-circle-check" /> 这场练习已经结束。
                            <Link to={`/tools/speaking/${id}/report`}> 查看反馈报告 →</Link>
                        </p>
                    )}
                </div>

                {/* 侧栏：目标词 */}
                {session && session.targetWords.length > 0 && (
                    <aside className="sp-side">
                        <h3><i className="fas fa-list-check" /> 目标词</h3>
                        <p className="fc-muted sp-side-note">
                            对方不会提醒你用它们 —— 用上了这里会自己亮起来。
                        </p>
                        <ul className="sp-words">
                            {usedWords.map((w) => (
                                <li key={w.en} className={w.count > 0 ? 'on' : ''}>
                                    <i className={w.count > 0 ? 'fas fa-circle-check' : 'far fa-circle'} />
                                    <b>{w.en}</b>
                                    {w.zh && <span>{w.zh}</span>}
                                    {w.count > 1 && <em>×{w.count}</em>}
                                </li>
                            ))}
                        </ul>
                    </aside>
                )}
            </div>

            {/* ---------- 输入区 ---------- */}
            <div className="sp-input">
                {error && <p className="fc-error sp-input-error"><i className="fas fa-circle-xmark" /> {error}</p>}

                <div className="sp-mode">
                    <button
                        type="button"
                        className={'fc-chip' + (mode === 'speech' ? ' on' : '')}
                        onClick={() => setMode('speech')}
                        disabled={!speechRecognitionSupported() || micDenied}
                        title={!speechRecognitionSupported()
                            ? '这台浏览器不支持语音识别（Chrome / Edge / Safari 可用）'
                            : micDenied ? '麦克风权限被拒绝了' : '用说的'}
                    >
                        <i className="fas fa-microphone" /> 说话
                    </button>
                    <button
                        type="button"
                        className={'fc-chip' + (mode === 'typed' ? ' on' : '')}
                        onClick={() => { recognizerRef.current?.abort(); setStatus('idle'); setMode('typed'); }}
                    >
                        <i className="fas fa-keyboard" /> 打字
                    </button>
                    <span className="fc-muted sp-mode-note">
                        {mode === 'speech'
                            ? '说完点「说完了」，识别结果会落到右边的框里 —— 听岔了可以直接改，再点「发送」。'
                            : '打字模式一样能完整练完并出报告 —— 它不是降级方案。回车即发送。'}
                    </span>
                </div>

                {mode === 'speech' ? (
                    <form
                        className="sp-mic-row"
                        onSubmit={(e) => {
                            e.preventDefault();
                            void send(draft, draftFromSpeech ? 'speech' : 'typed');
                            setDraft(''); setDraftFromSpeech(false);
                        }}
                    >
                        <button
                            type="button"
                            className={'sp-mic' + (status === 'listening' ? ' on' : '')}
                            onClick={() => (status === 'listening' ? stopListening() : startListening())}
                            disabled={busy || status === 'finished'}
                        >
                            <i className={status === 'listening' ? 'fas fa-stop' : 'fas fa-microphone'} />
                            {status === 'listening' ? '说完了' : '开始说'}
                        </button>

                        {/* 听到的文字是**可以改的** —— 浏览器识别经常听岔，
                            改一个字比重说一整句省事，也让「发送」这一步一直看得见 */}
                        <div className="sp-heard-wrap">
                            {status === 'listening' ? (
                                <div className="sp-heard is-live">
                                    <p>
                                        {draft && <span className="sp-heard-prev">{draft} </span>}
                                        {heard.final}
                                        <span className="sp-interim">{heard.interim || ' 在听…'}</span>
                                    </p>
                                </div>
                            ) : (
                                <textarea
                                    className="sp-typed"
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            void send(draft, draftFromSpeech ? 'speech' : 'typed');
                                            setDraft(''); setDraftFromSpeech(false);
                                        }
                                    }}
                                    placeholder="点左边「开始说」，说完这里会出现识别结果，可以改完再发送"
                                    disabled={busy || status === 'finished'}
                                />
                            )}
                        </div>

                        <div className="sp-send-col">
                            <button
                                type="submit"
                                className="fc-btn fc-btn-primary sp-send"
                                disabled={busy || !draft.trim() || status === 'finished' || status === 'listening'}
                            >
                                <i className="fas fa-paper-plane" /> 发送
                            </button>
                            {(draft || status === 'listening') && (
                                <button
                                    type="button"
                                    className="fc-btn fc-btn-quiet sp-clear"
                                    onClick={() => {
                                        recognizerRef.current?.abort();
                                        setHeard({ final: '', interim: '' });
                                        setDraft(''); setDraftFromSpeech(false);
                                        setStatus('idle');
                                    }}
                                >
                                    清空
                                </button>
                            )}
                        </div>
                    </form>
                ) : (
                    <form
                        className="sp-typed-row"
                        onSubmit={(e) => { e.preventDefault(); void send(typed, 'typed'); }}
                    >
                        <textarea
                            className="sp-typed"
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    void send(typed, 'typed');
                                }
                            }}
                            placeholder="用英语回他一句…（回车发送，Shift + 回车换行）"
                            disabled={busy || status === 'finished'}
                        />
                        <button
                            type="submit"
                            className="fc-btn fc-btn-primary"
                            disabled={busy || !typed.trim() || status === 'finished'}
                        >
                            <i className="fas fa-paper-plane" /> 发送
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
