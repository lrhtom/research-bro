/**
 * 语音识别 + 语音合成 —— 全部用浏览器自带的免费 API。
 *
 * 识别：window.SpeechRecognition / webkitSpeechRecognition
 *   这一行就是整套「语音转文字」的全部依赖：不花钱、不用 key、不用后端。
 *   代价是它只在 Chrome / Edge / Safari 上有，而且识别结果是**猜的**。
 *   所以：
 *     · 不支持或者用户拒绝麦克风时，打字输入是完整可用的第一等路径，不是残废降级；
 *     · 识别出来的文字在库里标成 source='speech'，报告提示词会据此知道
 *       「这词看着怪，多半是识别错了，不是他说错了」。
 *
 * 合成：window.speechSynthesis
 *   同样免费。注意它的输出**进不了 Web Audio**，所以音质干扰是靠调
 *   pitch/rate 加一层合成底噪来做的（见 audio-effects.ts 的说明）。
 */

// ---------- 语音识别 ----------

/** 浏览器给的识别结果 */
export interface SpeechResult {
    /** 已经定稿的文字 */
    final: string;
    /** 还在变的临时文字，用来做实时回显 */
    interim: string;
}

interface SRLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((e: unknown) => void) | null;
    onerror: ((e: unknown) => void) | null;
    onend: (() => void) | null;
}

/** 跨浏览器工厂。拿不到就是这台浏览器不支持，调用方切到打字模式。 */
function getSRConstructor(): (new () => SRLike) | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as Record<string, unknown>;
    return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as (new () => SRLike) | null;
}

export function speechRecognitionSupported(): boolean {
    return getSRConstructor() !== null;
}

export interface RecognizerHandlers {
    onResult(r: SpeechResult): void;
    /** 'not-allowed' = 用户拒绝了麦克风，调用方应该切到打字模式 */
    onError(code: string): void;
    onEnd(): void;
}

/**
 * 连续识别的一层薄封装。
 *
 * continuous + interimResults：说的过程中就能看到字，
 * 说完再由调用方决定什么时候把定稿的那段提交上去。
 */
export class Recognizer {
    private sr: SRLike | null = null;
    private finalText = '';
    private stopping = false;

    readonly supported = speechRecognitionSupported();

    constructor(private handlers: RecognizerHandlers, private lang = 'en-GB') {}

    start(): boolean {
        const Ctor = getSRConstructor();
        if (!Ctor) return false;
        this.stop();

        const sr = new Ctor();
        sr.lang = this.lang;
        sr.continuous = true;
        sr.interimResults = true;
        sr.maxAlternatives = 1;

        sr.onresult = (e: unknown) => {
            const ev = e as { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> };
            let interim = '';
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const res = ev.results[i];
                const text = res[0]?.transcript ?? '';
                if (res.isFinal) this.finalText += text;
                else interim += text;
            }
            this.handlers.onResult({ final: this.finalText.trim(), interim: interim.trim() });
        };

        sr.onerror = (e: unknown) => {
            const code = String((e as { error?: unknown }).error ?? 'unknown');
            // no-speech / aborted 是连续识别里的常态噪声，不值得打扰用户
            if (code === 'no-speech' || code === 'aborted') return;
            this.handlers.onError(code);
        };

        sr.onend = () => {
            this.sr = null;
            if (!this.stopping) this.handlers.onEnd();
        };

        this.sr = sr;
        this.stopping = false;
        try {
            sr.start();
            return true;
        } catch {
            // 上一个实例还没完全停掉时会抛 InvalidStateError
            this.sr = null;
            return false;
        }
    }

    /** 停止识别，返回这一轮攒下来的定稿文字 */
    stop(): string {
        const text = this.finalText.trim();
        if (this.sr) {
            this.stopping = true;
            try { this.sr.stop(); } catch { /* 已经停了 */ }
            this.sr = null;
        }
        return text;
    }

    abort(): void {
        if (this.sr) {
            this.stopping = true;
            try { this.sr.abort(); } catch { /* ignore */ }
            this.sr = null;
        }
        this.finalText = '';
    }

    /** 把攒下来的文字清空，准备下一轮 */
    reset(): void {
        this.finalText = '';
    }

    get pending(): string { return this.finalText.trim(); }
}

// ---------- 语音合成 ----------

/**
 * 声音品质分档。
 *
 * 同一个 speechSynthesis 接口下，声音的差距是天壤之别：
 *   · natural / neural —— 神经网络合成，听起来基本是真人（Windows 的
 *     「Microsoft Sonia Online (Natural)」、macOS 的 Premium/Enhanced 一档）
 *   · online / google  —— 云端合成，明显好过本地
 *   · 本地 SAPI 老声音（David / Zira / Hazel…）—— 就是那种「机器音」
 * 默认必须挑到最好的那一个，而不是 getVoices() 返回的第一个 ——
 * 系统给的顺序往往正好把最难听的排在最前面。
 */
export type VoiceTier = 'natural' | 'online' | 'standard';

const RX_NATURAL = /natural|neural/i;
const RX_ONLINE = /online|google/i;
const RX_PREMIUM = /premium|enhanced/i;
/** macOS 那些搞笑声音（Zarvox、Bad News…），一律沉底 */
const RX_NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy/i;

/**
 * Edge 的 “Microsoft … Online (Natural)” 系列里最拿得出手的几把嗓子。
 *
 * 这一族是微软的神经网络语音，通过 Edge 的 speechSynthesis 直接可用、免费、
 * 免 key；en-GB 的 Sonia / Ryan 听起来基本就是真人，正好对得上本功能
 * 「英国生活场景」的设定。Chrome 一般看不到它们（Chrome 只给本地 SAPI 和
 * Google 那几个），所以下面的提示会明确让用户用 Edge 打开。
 *
 * 同为 Natural 的声音有几十个，这里给这几把再加一档，
 * 免得默认挑中某个冷门口音的 Natural。
 */
const RX_FLAGSHIP_GB = /\b(sonia|ryan|libby)\b/i;
const RX_FLAGSHIP_US = /\b(aria|guy|jenny|andrew|emma)\b/i;

export function voiceTier(v: SpeechSynthesisVoice): VoiceTier {
    if (RX_NATURAL.test(v.name) || RX_PREMIUM.test(v.name)) return 'natural';
    if (RX_ONLINE.test(v.name) || v.localService === false) return 'online';
    return 'standard';
}

export const TIER_LABEL: Record<VoiceTier, string> = {
    natural: '自然音',
    online: '在线',
    standard: '机器音',
};

function voiceScore(v: SpeechSynthesisVoice): number {
    let s = 0;
    if (RX_NATURAL.test(v.name)) s += 100;
    if (RX_PREMIUM.test(v.name)) s += 90;
    if (RX_ONLINE.test(v.name)) s += 55;
    if (v.localService === false) s += 30;
    if (RX_NOVELTY.test(v.name)) s -= 300;

    // Natural 系列里的招牌嗓子再加一档，别默认挑中某个冷门的
    if (RX_NATURAL.test(v.name)) {
        if (RX_FLAGSHIP_GB.test(v.name)) s += 35;
        else if (RX_FLAGSHIP_US.test(v.name)) s += 20;
    }

    // 场景是英国生活，英式优先；其它英语变体次之
    if (/^en[-_]GB/i.test(v.lang)) s += 40;
    else if (/^en[-_](IE|AU|NZ|ZA)/i.test(v.lang)) s += 15;
    else if (/^en[-_]IN/i.test(v.lang)) s += 5;
    return s;
}

/**
 * 取可用的英语声音，**最好听的排最前面**。
 *
 * 声音列表在部分浏览器上是异步填充的，第一次同步调用可能是空的 ——
 * 所以调用方要同时监听 voiceschanged（见 onVoicesReady）。
 */
export function listEnglishVoices(): SpeechSynthesisVoice[] {
    if (typeof window === 'undefined' || !window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices()
        .filter((v) => /^en[-_]/i.test(v.lang))
        .sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
}

/** 这台机器上最好的英语声音有多好，用来决定要不要提示用户去装自然音 */
export function bestAvailableTier(voices: SpeechSynthesisVoice[]): VoiceTier | null {
    if (voices.length === 0) return null;
    return voiceTier(voices[0]);
}

export function onVoicesReady(cb: () => void): () => void {
    if (typeof window === 'undefined' || !window.speechSynthesis) return () => {};
    const handler = () => cb();
    window.speechSynthesis.addEventListener('voiceschanged', handler);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', handler);
}

export function speechSynthesisSupported(): boolean {
    return typeof window !== 'undefined' && !!window.speechSynthesis;
}

// ---------- 短文本朗读（记忆卡正面）----------

/** 中日韩：汉字、假名、谚文。不带 g —— 带了 test() 会记住上次位置，隔次调用就错 */
const RX_CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/**
 * 这段文字看着是不是英语。
 *
 * 记忆卡正面多半是「单词 / 短语 / 一句话」，用不着真正的语种识别 ——
 * 只要挡住两类不该念的就够了：
 *   · 中日韩文本 —— 拿英语嗓子念中文是灾难
 *   · 纯符号 / 纯数字（`1+1=?`、`O(1)`）—— 念出来没有信息量
 * 所以判据是：不含 CJK，且拉丁字母占正文（去掉空白后）一半以上。
 */
export function looksEnglish(text: string): boolean {
    const s = text.trim();
    if (!s || RX_CJK.test(s)) return false;

    const letters = s.match(/[A-Za-z]/g)?.length ?? 0;
    if (letters < 2) return false;

    const dense = s.replace(/\s+/g, '').length;
    return letters / dense >= 0.5;
}

/**
 * 念一小段文字，念之前先掐掉上一段。
 *
 * 记忆卡是可以按着键连翻的，上一张的读音压着下一张说话比不念还糟 ——
 * 所以这里是「打断式」的，不排队。
 */
export function speakOnce(text: string, voice: SpeechSynthesisVoice | null, rate = 0.95): void {
    if (!speechSynthesisSupported()) return;
    const s = text.trim();
    if (!s) return;

    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-GB'; }
    u.rate = rate;
    window.speechSynthesis.speak(u);
}

export function cancelSpeech(): void {
    if (speechSynthesisSupported()) window.speechSynthesis.cancel();
}

/**
 * 把流式吐出来的文本按句子朗读。
 *
 * 之所以要按句切：流式回复是一小片一小片来的，攒够一整句就先念，
 * 用户在模型还没写完时就已经听到第一句了 —— 这正是流式的意义。
 * 攒到整段回完再念，每轮都要多等好几秒。
 */
export class SentenceSpeaker {
    private queue: string[] = [];
    private buffer = '';
    private speaking = false;
    private stopped = false;
    /** 这一轮念过的全部句子，"重听上一句"要用 */
    private spoken: string[] = [];
    /** Chromium 长时间朗读会自己卡死，靠这个心跳踹醒（见 keepAlive） */
    private heartbeat: number | null = null;

    constructor(private opts: {
        voice: () => SpeechSynthesisVoice | null;
        rate: () => number;
        /** 朗读前调音色（音质干扰） */
        tune?: (u: SpeechSynthesisUtterance) => void;
        onStart?: () => void;
        onDone?: () => void;
    }) {}

    /** 喂一片流式增量 */
    push(delta: string): void {
        if (this.stopped) return;
        this.buffer += delta;

        // 句末标点 + 后面跟空白，才算一句说完了；
        // 不这么判的话 "Mr. Smith" 会被从中间劈开念成两句
        for (;;) {
            const m = this.buffer.match(/^([\s\S]*?[.!?…]+)(\s+)([\s\S]*)$/);
            if (!m) break;
            const sentence = m[1].trim();
            this.buffer = m[3];
            if (sentence) this.enqueue(sentence);
        }
    }

    /** 流结束了，把剩下的半句也念掉 */
    flush(): void {
        const rest = this.buffer.trim();
        this.buffer = '';
        if (rest) this.enqueue(rest);
        if (!this.speaking) this.opts.onDone?.();
    }

    /** 不走流式，直接念一整段（开场白用） */
    speakAll(text: string): void {
        this.reset();
        this.push(text);
        this.flush();
    }

    /** 重听这一轮 AI 说的话 */
    replay(): void {
        const all = this.spoken.slice();
        this.cancel();
        this.stopped = false;
        this.spoken = all;
        this.queue = all.slice();
        this.pump();
    }

    get hasSpoken(): boolean { return this.spoken.length > 0; }

    reset(): void {
        this.cancel();
        this.stopped = false;
        this.spoken = [];
    }

    cancel(): void {
        this.stopped = true;
        this.queue = [];
        this.buffer = '';
        this.speaking = false;
        this.stopKeepAlive();
        if (speechSynthesisSupported()) window.speechSynthesis.cancel();
    }

    /**
     * Chromium（含 Edge）有个陈年毛病：连续朗读大约十几秒之后，
     * 合成引擎会悄悄卡住，既不报错也不再出声 —— Edge 那批云端
     * Online (Natural) 语音尤其容易碰上。
     * 官方没修，通行的绕法就是定期 resume() 踹一下（没暂停时它是空操作）。
     */
    private startKeepAlive(): void {
        if (this.heartbeat !== null || !speechSynthesisSupported()) return;
        this.heartbeat = window.setInterval(() => {
            if (!this.speaking) return;
            window.speechSynthesis.resume();
        }, 9000);
    }

    private stopKeepAlive(): void {
        if (this.heartbeat !== null) {
            window.clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }

    private enqueue(sentence: string): void {
        this.spoken.push(sentence);
        this.queue.push(sentence);
        this.pump();
    }

    private pump(): void {
        if (this.speaking || this.stopped || !speechSynthesisSupported()) return;
        const next = this.queue.shift();
        if (next === undefined) return;

        const u = new SpeechSynthesisUtterance(next);
        const v = this.opts.voice();
        if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-GB'; }
        u.rate = this.opts.rate();
        u.pitch = 1;
        u.volume = 1;
        this.opts.tune?.(u);

        if (!this.speaking) this.opts.onStart?.();
        this.speaking = true;
        this.startKeepAlive();

        const finish = () => {
            this.speaking = false;
            if (this.queue.length) { this.pump(); return; }
            this.stopKeepAlive();
            if (!this.buffer) this.opts.onDone?.();
        };
        u.onend = finish;
        // 出错也要往下走，否则一句读不出来整轮就卡死了
        u.onerror = finish;

        window.speechSynthesis.speak(u);
    }
}
