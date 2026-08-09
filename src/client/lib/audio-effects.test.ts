// ============================================================
//  音质干扰的验收测试
//
//  最要紧的一条：**没勾「音质劣化」时，什么都不许发生** ——
//  不建 AudioContext、不接管 <audio>、不改语音合成的音色、不放底噪。
//  一个「关着的开关仍然在偷偷改音频」的 bug，用户是听不出原因的，
//  只会觉得「这网站的声音怎么怪怪的」。
//
//  这个文件跑在 node 环境里，所以先造一个最小的 window + AudioContext 替身，
//  再动态 import 被测模块（AC 是在模块顶层就捕获的，import 之后再 stub 就晚了）。
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- 最小的 Web Audio 替身 ----------

let created = { contexts: 0, mediaSources: 0, bufferSources: 0, oscillators: 0 };

function node() {
    return { connect: vi.fn(), disconnect: vi.fn() };
}

class FakeAudioContext {
    currentTime = 0;
    sampleRate = 48000;
    state = 'running';
    destination = node();

    constructor() { created.contexts++; }

    createMediaElementSource() { created.mediaSources++; return node(); }
    createBiquadFilter() { return { ...node(), type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 } }; }
    createGain() {
        return {
            ...node(),
            gain: {
                value: 0,
                cancelScheduledValues: vi.fn(),
                setTargetAtTime: vi.fn(),
                setValueAtTime: vi.fn(),
            },
        };
    }
    createWaveShaper() { return { ...node(), curve: null as unknown, oversample: '' }; }
    createBufferSource() {
        created.bufferSources++;
        return { ...node(), buffer: null as unknown, loop: false, start: vi.fn(), stop: vi.fn() };
    }
    createOscillator() {
        created.oscillators++;
        return { ...node(), type: '', frequency: { value: 0 }, start: vi.fn(), stop: vi.fn() };
    }
    createBuffer(_ch: number, len: number) {
        return { getChannelData: () => new Float32Array(len) };
    }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
}

vi.stubGlobal('window', {
    AudioContext: FakeAudioContext,
    setInterval: () => 0,
    clearInterval: () => {},
});
vi.stubGlobal('AudioContext', FakeAudioContext);

const { AudioQualityFx } = await import('./audio-effects.js');

/** 只用到 <audio> 的类型位置，实际不碰 DOM */
const fakeAudioEl = {} as HTMLAudioElement;

function utterance(): SpeechSynthesisUtterance {
    return { pitch: 1, rate: 1, volume: 1 } as SpeechSynthesisUtterance;
}

beforeEach(() => {
    created = { contexts: 0, mediaSources: 0, bufferSources: 0, oscillators: 0 };
});

// ------------------------------------------------------------

describe('没开音质干扰', () => {
    it('attach 直接返回 false，连 AudioContext 都不建', () => {
        const fx = new AudioQualityFx();
        // 从没 setProfiles 过
        expect(fx.active).toBe(false);
        expect(fx.attach(fakeAudioEl)).toBe(false);
        expect(created.contexts).toBe(0);
        expect(created.mediaSources).toBe(0);
    });

    it('setProfiles([]) 之后同样不接管播放', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles([]);
        expect(fx.active).toBe(false);
        expect(fx.attach(fakeAudioEl)).toBe(false);
        expect(created.contexts).toBe(0);
    });

    it('语音合成的音色一个参数都不动', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles([]);
        const u = utterance();
        fx.tuneUtterance(u);
        expect(u).toMatchObject({ pitch: 1, rate: 1, volume: 1 });
    });

    it('不播放任何信道底噪', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles([]);
        fx.startArtefacts();
        expect(created.contexts).toBe(0);
        expect(created.bufferSources).toBe(0);
        expect(created.oscillators).toBe(0);
    });

    it('非法档位会被丢掉，等于没开', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles(['telephone', 'underwater', '']);   // 三个都不在白名单里
        expect(fx.active).toBe(false);
        expect(fx.attach(fakeAudioEl)).toBe(false);
        expect(created.contexts).toBe(0);
    });

    it('从开着改成关掉时，正在响的底噪会停掉', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles(['radio']);
        fx.startArtefacts();
        expect(created.bufferSources).toBeGreaterThan(0);

        const before = created.bufferSources;
        fx.setProfiles([]);           // 关掉
        fx.startArtefacts();          // 再叫一次也不该有新东西
        expect(created.bufferSources).toBe(before);
        expect(fx.active).toBe(false);
    });
});

describe('开了音质干扰', () => {
    it('attach 接管 <audio> 并建起滤波链', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles(['phone']);
        expect(fx.active).toBe(true);
        expect(fx.attach(fakeAudioEl)).toBe(true);
        expect(created.contexts).toBe(1);
        expect(created.mediaSources).toBe(1);
    });

    it('电话音质把音高抬高、音量压低', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles(['phone']);
        const u = utterance();
        fx.tuneUtterance(u);
        expect(u.pitch).toBeGreaterThan(1);
        expect(u.volume).toBeLessThan(1);
    });

    it('隔墙音质把音高压低、语速放慢', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles(['muffled']);
        const u = utterance();
        fx.tuneUtterance(u);
        expect(u.pitch).toBeLessThan(1);
        expect(u.rate).toBeLessThan(1);
    });

    it('调出来的值始终落在 Web Speech 的合法区间里', () => {
        for (const p of ['phone', 'muffled', 'radio']) {
            const fx = new AudioQualityFx();
            fx.setProfiles([p]);
            const u = utterance();
            u.pitch = 2; u.rate = 10; u.volume = 1;   // 先顶到上限，看会不会被推出界
            fx.tuneUtterance(u);
            expect(u.pitch).toBeGreaterThanOrEqual(0);
            expect(u.pitch).toBeLessThanOrEqual(2);
            expect(u.rate).toBeGreaterThanOrEqual(0.1);
            expect(u.rate).toBeLessThanOrEqual(10);
            expect(u.volume).toBeGreaterThanOrEqual(0);
            expect(u.volume).toBeLessThanOrEqual(1);
        }
    });

    it('底噪只起一套，重复调用不会越叠越吵', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles(['phone']);
        fx.startArtefacts();
        const first = created.bufferSources;
        fx.startArtefacts();
        fx.startArtefacts();
        expect(created.bufferSources).toBe(first);
    });

    it('dispose 之后回到「什么都不做」的状态', () => {
        const fx = new AudioQualityFx();
        fx.setProfiles(['radio']);
        fx.startArtefacts();
        fx.dispose();

        expect(fx.active).toBe(false);
        const u = utterance();
        fx.tuneUtterance(u);
        expect(u).toMatchObject({ pitch: 1, rate: 1, volume: 1 });
    });
});
