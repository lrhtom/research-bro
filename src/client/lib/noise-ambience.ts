/**
 * 背景噪音 —— 用 Web Audio 现场合成，不打包任何音频文件。
 *
 * 勾了「背景噪音」这个干扰项时，除了让 AI 在提示词层面表现出「这里很吵、
 * 我听不清、你再说一遍」，浏览器这边也真的把噪音放出来 ——
 * 否则「背景噪音」就只是 AI 嘴上说说，学习者的耳朵一点压力都没有，
 * 而这个功能的全部意义就在于听辨压力。
 *
 * 每个子类型一条独立的噪声链（循环粉噪 -> 带通/低通 -> 增益，部分再叠低频嗡鸣
 * 或缓慢起伏），多选就并联混在一起，整体压得比人声低，不至于盖住 TTS。
 *
 * 用合成而不是音频文件：没有版权问题、离线可用、几乎不增加打包体积、
 * 而且开停都是瞬时的。将来想换成真实录音，只要把 buildProfile 换成
 * <audio>/AudioBuffer 的加载器即可。
 */

export type NoiseProfileKey = 'pub' | 'canteen' | 'office' | 'street';

interface ProfileParams {
    type: BiquadFilterType;
    freq: number;   // 滤波器中心 / 截止频率
    q: number;
    gain: number;   // 这一层噪声的相对增益 0..1
    hum?: number;   // 可选低频嗡鸣（Hz），模拟空调或机器
    lfo?: number;   // 可选缓慢起伏（Hz），模拟人群或车流的潮汐
}

const PROFILE_PARAMS: Record<NoiseProfileKey, ProfileParams> = {
    pub: { type: 'bandpass', freq: 520, q: 0.6, gain: 0.85, lfo: 0.15 },
    canteen: { type: 'highpass', freq: 850, q: 0.5, gain: 0.55 },
    office: { type: 'lowpass', freq: 240, q: 0.6, gain: 0.70, hum: 110 },
    street: { type: 'bandpass', freq: 300, q: 0.4, gain: 0.80, lfo: 0.08 },
};

type ProfileNode = { stop: () => void };

const AC: typeof AudioContext | undefined =
    typeof window !== 'undefined'
        ? (window.AudioContext
           || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;

export class NoiseAmbience {
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;
    private buffer: AudioBuffer | null = null;
    private nodes: ProfileNode[] = [];
    private active: NoiseProfileKey[] = [];
    private volume = 0.16;
    private muted = false;
    private gestureArmed = false;
    running = false;

    /** 开始播放这些子类型（需要时才建 AudioContext） */
    async start(profiles: string[]): Promise<void> {
        if (!AC) return;
        if (!this.ctx) {
            this.ctx = new AC();
            this.master = this.ctx.createGain();
            this.master.gain.value = 0;
            this.master.connect(this.ctx.destination);
            this.buffer = this.makePinkBuffer(this.ctx, 4);
        }
        await this.ctx.resume().catch(() => {});
        this.running = true;
        this.setProfiles(profiles);
        // 自动播放策略：还处于 suspended 就等下一次用户手势再恢复
        if (this.ctx.state === 'suspended') this.armGestureResume();
    }

    /** 换一组子类型（加层 / 减层） */
    setProfiles(profiles: string[]): void {
        const valid = profiles.filter((p): p is NoiseProfileKey => p in PROFILE_PARAMS);
        // 开了背景噪音但一个子类型都没选 → 默认给「酒吧 + 办公室」的混合
        this.active = valid.length ? valid : (['pub', 'office'] as NoiseProfileKey[]);
        if (!this.running || !this.ctx || !this.buffer || !this.master) return;

        this.clearNodes();
        for (const p of this.active) this.nodes.push(this.buildProfile(p));
        // 多层叠在一起要整体压低，否则越选越吵
        this.rampMaster(this.muted ? 0 : this.volume / Math.sqrt(this.active.length || 1));
    }

    setMuted(muted: boolean): void {
        this.muted = muted;
        if (!this.master || !this.ctx) return;
        this.rampMaster(muted ? 0 : this.volume / Math.sqrt(this.active.length || 1));
    }

    isMuted(): boolean { return this.muted; }

    stop(): void {
        this.running = false;
        this.clearNodes();
        if (this.ctx) {
            const ctx = this.ctx;
            this.ctx = null;
            this.master = null;
            this.buffer = null;
            ctx.close().catch(() => {});
        }
    }

    // ── 内部 ────────────────────────────────────────────────────────
    private rampMaster(target: number): void {
        if (!this.master || !this.ctx) return;
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(target, now, 0.25);
    }

    private clearNodes(): void {
        for (const n of this.nodes) {
            try { n.stop(); } catch { /* ignore */ }
        }
        this.nodes = [];
    }

    private armGestureResume(): void {
        if (this.gestureArmed) return;
        this.gestureArmed = true;
        const resume = () => {
            this.ctx?.resume().catch(() => {});
            window.removeEventListener('pointerdown', resume);
            window.removeEventListener('keydown', resume);
            this.gestureArmed = false;
        };
        window.addEventListener('pointerdown', resume, { once: true });
        window.addEventListener('keydown', resume, { once: true });
    }

    private buildProfile(profile: NoiseProfileKey): ProfileNode {
        const ctx = this.ctx!;
        const master = this.master!;
        const p = PROFILE_PARAMS[profile];

        const src = ctx.createBufferSource();
        src.buffer = this.buffer!;
        src.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = p.type;
        filter.frequency.value = p.freq;
        filter.Q.value = p.q;

        const g = ctx.createGain();
        g.gain.value = p.gain;

        src.connect(filter);
        filter.connect(g);
        g.connect(master);
        src.start();

        // 缓慢起伏（人群 / 车流的潮汐）
        let lfo: OscillatorNode | null = null;
        let lfoGain: GainNode | null = null;
        if (p.lfo) {
            lfo = ctx.createOscillator();
            lfo.frequency.value = p.lfo;
            lfoGain = ctx.createGain();
            lfoGain.gain.value = p.gain * 0.4;
            lfo.connect(lfoGain);
            lfoGain.connect(g.gain);
            lfo.start();
        }

        // 低频嗡鸣（空调 / 机房）
        let hum: OscillatorNode | null = null;
        let humGain: GainNode | null = null;
        if (p.hum) {
            hum = ctx.createOscillator();
            hum.type = 'sine';
            hum.frequency.value = p.hum;
            humGain = ctx.createGain();
            humGain.gain.value = 0.04;
            hum.connect(humGain);
            humGain.connect(master);
            hum.start();
        }

        return {
            stop: () => {
                try { src.stop(); } catch { /* 已经停了 */ }
                lfo?.stop();
                hum?.stop();
                [src, filter, g, lfo, lfoGain, hum, humGain].forEach((n) => {
                    try { n?.disconnect(); } catch { /* ignore */ }
                });
            },
        };
    }

    /** 生成一段可循环的粉噪（Paul Kellet 的近似算法） */
    private makePinkBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
        const len = Math.floor(ctx.sampleRate * seconds);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
            const w = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
            b6 = w * 0.115926;
        }
        return buf;
    }
}
