/**
 * 音质干扰 —— 把 AI 的声音弄得更难听清。
 *
 * ── 一个必须讲清楚的限制 ────────────────────────────────────────────
 * 参考实现里 TTS 是服务端返回的音频 blob，能挂到 <audio> 上再走 Web Audio：
 *     <audio> -> createMediaElementSource -> [滤波器链] -> destination
 * 本项目只用**浏览器自带的 speechSynthesis**（免费、免 key、免服务），
 * 而 speechSynthesis 的输出直接走系统声卡，**没有任何标准 API 能把它接进
 * Web Audio 图里**。所以对它没法做真正的滤波。
 *
 * 于是这个类同时提供两条路：
 *   1. attach(el)        —— <audio> 元素的真滤波链（逐字移植自参考实现）。
 *                           将来若接上任何返回音频文件的 TTS，这条路直接可用。
 *   2. tuneUtterance()   —— speechSynthesis 这条路：改音高/语速让音色变化，
 *      + startArtefacts()   再叠一层用 Web Audio 合成的信道噪声（电话底噪、
 *                           隔墙闷响、对讲机沙沙），制造真实的听辨压力。
 *
 * 两条路都受同一个开关控制：没勾「音质劣化」时 active 为 false，
 * attach() 直接返回 false、不建 AudioContext、不发任何声音。
 */

export type QualityProfileKey = 'phone' | 'muffled' | 'radio';

const VALID: QualityProfileKey[] = ['phone', 'muffled', 'radio'];

const AC: typeof AudioContext | undefined =
    typeof window !== 'undefined'
        ? (window.AudioContext
           || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;

/** 轻微失真曲线（对讲机那种沙沙的破音） */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
}

/** 按 profile 建一条滤波链，返回链尾节点 */
function buildProfileChain(ctx: AudioContext, input: AudioNode, profile: QualityProfileKey): AudioNode {
    if (profile === 'phone') {
        // 电话线：带限到大约 300-3400 Hz，再抬一点中频，就是那种又平又尖的声音
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = 0.7;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 0.7;
        const presence = ctx.createBiquadFilter();
        presence.type = 'peaking'; presence.frequency.value = 1700; presence.Q.value = 1.0; presence.gain.value = 6;
        const g = ctx.createGain(); g.gain.value = 1.2;
        input.connect(hp); hp.connect(lp); lp.connect(presence); presence.connect(g);
        return g;
    }
    if (profile === 'muffled') {
        // 隔墙：低通把高频全削掉
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.5;
        const g = ctx.createGain(); g.gain.value = 1.15;
        input.connect(lp); lp.connect(g);
        return g;
    }
    // radio：窄带 + 失真 = 对讲机
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 500; hp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2800; lp.Q.value = 0.8;
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(6);
    shaper.oversample = '2x';
    const g = ctx.createGain(); g.gain.value = 0.9;
    input.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(g);
    return g;
}

/** speechSynthesis 这条路上，每种信道对应的音色调整与底噪参数 */
const SYNTH_TUNING: Record<QualityProfileKey, {
    pitch: number; rate: number; volume: number;
    bed: { type: BiquadFilterType; freq: number; q: number; gain: number; hum?: number; crackle?: boolean };
}> = {
    // 电话：音高略高、音量略低，配窄带底噪
    phone: {
        pitch: 1.12, rate: 1.0, volume: 0.9,
        bed: { type: 'bandpass', freq: 1800, q: 1.2, gain: 0.045, hum: 50 },
    },
    // 隔墙：音高压低、说话略慢，配低频闷响
    muffled: {
        pitch: 0.88, rate: 0.95, volume: 0.75,
        bed: { type: 'lowpass', freq: 400, q: 0.7, gain: 0.05 },
    },
    // 对讲机：音高高、语速快，配沙沙的中高频噪声
    radio: {
        pitch: 1.18, rate: 1.08, volume: 0.85,
        bed: { type: 'bandpass', freq: 2200, q: 0.9, gain: 0.06, crackle: true },
    },
};

export class AudioQualityFx {
    private ctx: AudioContext | null = null;
    private profiles: QualityProfileKey[] = [];
    private bedNodes: Array<{ stop: () => void }> = [];
    private bedGain: GainNode | null = null;
    private noiseBuffer: AudioBuffer | null = null;

    setProfiles(profiles: string[]): void {
        const next = profiles.filter((p): p is QualityProfileKey => (VALID as string[]).includes(p));
        this.profiles = next;
        if (next.length === 0) this.stopArtefacts();
    }

    get active(): boolean { return this.profiles.length > 0; }

    /** 当前生效的档位（外部只读，用来显示状态） */
    get current(): QualityProfileKey[] { return [...this.profiles]; }

    // ── 路线一：<audio> 元素的真滤波链 ──────────────────────────────
    /**
     * 把一个 <audio> 接进滤波链。
     * 没开音质干扰、或者浏览器不支持时返回 false，调用方直接原样播放。
     *
     * 注意：一个 <audio> 一旦被 createMediaElementSource 接管，它的默认输出
     * 就只走这张图了，所以图必须连到 destination，否则整段是静音的。
     */
    attach(el: HTMLAudioElement): boolean {
        if (!this.profiles.length || !AC) return false;
        if (!this.ctx) this.ctx = new AC();
        void this.ctx.resume().catch(() => {});
        let node: AudioNode;
        try {
            node = this.ctx.createMediaElementSource(el);
        } catch {
            return false;   // 已经接过了，或者不允许
        }
        for (const p of this.profiles) node = buildProfileChain(this.ctx, node, p);
        node.connect(this.ctx.destination);
        return true;
    }

    // ── 路线二：speechSynthesis ────────────────────────────────────
    /**
     * 调整一条待朗读语句的音色。
     *
     * speechSynthesis 的声音进不了 Web Audio，只能从合成参数上下手：
     * 电话线拔高音高、隔墙压低并放慢、对讲机又高又快。
     * 没开音质干扰时什么都不做。
     */
    tuneUtterance(u: SpeechSynthesisUtterance): void {
        if (!this.profiles.length) return;
        // 多选时按最后一个为准 —— 音高只有一个值，叠加没有意义
        const t = SYNTH_TUNING[this.profiles[this.profiles.length - 1]];
        u.pitch = Math.max(0, Math.min(2, u.pitch * t.pitch));
        u.rate = Math.max(0.1, Math.min(10, u.rate * t.rate));
        u.volume = Math.max(0, Math.min(1, u.volume * t.volume));
    }

    /** 开始播放信道底噪（跟朗读同时进行，制造真实的听辨压力） */
    startArtefacts(): void {
        if (!this.profiles.length || !AC) return;
        if (this.bedNodes.length) return;       // 已经在响了

        if (!this.ctx) this.ctx = new AC();
        void this.ctx.resume().catch(() => {});
        const ctx = this.ctx;

        if (!this.noiseBuffer) this.noiseBuffer = makeNoiseBuffer(ctx, 3);
        if (!this.bedGain) {
            this.bedGain = ctx.createGain();
            this.bedGain.gain.value = 0;
            this.bedGain.connect(ctx.destination);
        }

        for (const p of this.profiles) this.bedNodes.push(this.buildBed(SYNTH_TUNING[p].bed));

        // 淡入，别「啪」地一声砸出来
        const now = ctx.currentTime;
        this.bedGain.gain.cancelScheduledValues(now);
        this.bedGain.gain.setTargetAtTime(1 / Math.sqrt(this.profiles.length), now, 0.08);
    }

    stopArtefacts(): void {
        if (this.bedGain && this.ctx) {
            const now = this.ctx.currentTime;
            this.bedGain.gain.cancelScheduledValues(now);
            this.bedGain.gain.setTargetAtTime(0, now, 0.08);
        }
        for (const n of this.bedNodes) {
            try { n.stop(); } catch { /* 已经停了 */ }
        }
        this.bedNodes = [];
    }

    private buildBed(p: typeof SYNTH_TUNING[QualityProfileKey]['bed']): { stop: () => void } {
        const ctx = this.ctx!;
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer!;
        src.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = p.type;
        filter.frequency.value = p.freq;
        filter.Q.value = p.q;

        const g = ctx.createGain();
        g.gain.value = p.gain;

        src.connect(filter);
        filter.connect(g);
        g.connect(this.bedGain!);
        src.start();

        // 对讲机：不定时的电流爆音
        let crackle: number | null = null;
        if (p.crackle) {
            crackle = window.setInterval(() => {
                if (!this.ctx) return;
                const t = this.ctx.currentTime;
                g.gain.cancelScheduledValues(t);
                g.gain.setValueAtTime(p.gain * 4, t);
                g.gain.setTargetAtTime(p.gain, t + 0.02, 0.05);
            }, 1400 + Math.random() * 2200);
        }

        // 电话线的 50Hz 交流底噪
        let hum: OscillatorNode | null = null;
        let humGain: GainNode | null = null;
        if (p.hum) {
            hum = ctx.createOscillator();
            hum.type = 'sine';
            hum.frequency.value = p.hum;
            humGain = ctx.createGain();
            humGain.gain.value = 0.012;
            hum.connect(humGain);
            humGain.connect(this.bedGain!);
            hum.start();
        }

        return {
            stop: () => {
                if (crackle !== null) window.clearInterval(crackle);
                try { src.stop(); } catch { /* 已经停了 */ }
                hum?.stop();
                [src, filter, g, hum, humGain].forEach((n) => {
                    try { n?.disconnect(); } catch { /* ignore */ }
                });
            },
        };
    }

    dispose(): void {
        this.stopArtefacts();
        this.bedGain = null;
        this.noiseBuffer = null;
        if (this.ctx) {
            const c = this.ctx;
            this.ctx = null;
            c.close().catch(() => {});
        }
        this.profiles = [];
    }
}

/** 一段可循环的白噪声，给底噪用 */
function makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
}
