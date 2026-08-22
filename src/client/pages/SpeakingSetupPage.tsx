// ============================================================
//  英语口语场景练习 · 开始前的设置
//
//  三件事：选场景、开干扰项、（可选）填目标词。
//
//  干扰项是这个功能的重点 —— 真正的难度不来自生词，
//  而来自「对方带口音、语速快、还在酒吧里跟你说话」的听辨压力。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { SPEAKING_SECTIONS } from '@/lib/nav';
import AiModelSelect from '@/components/ai/AiModelSelect';
import {
    apiCheckScenario, apiCreateSpeakingSession, apiDeleteScenario, apiListScenarios,
    apiRandomScenario, apiSaveScenario, apiSpeakingStatus,
    type LlmConfigView, type SavedScenario,
} from '@/lib/api';
import {
    INTERFERENCE_KEYS, INTERFERENCE_LABELS, INTERFERENCE_SUBOPTIONS, SCENARIO_PRESETS,
    SUBOPTION_LABELS, parseTargetWords,
    type InterferenceKey, type Modifiers,
} from '../../shared/speaking';

export default function SpeakingSetupPage() {
    const navigate = useNavigate();

    const [preset, setPreset] = useState<string>(SCENARIO_PRESETS[0].key);
    const [custom, setCustom] = useState('');
    const [customLabel, setCustomLabel] = useState('');
    const [mods, setMods] = useState<Modifiers>({});
    const [wordsRaw, setWordsRaw] = useState('');

    const [busy, setBusy] = useState<'' | 'check' | 'random' | 'start' | 'save'>('');
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [llm, setLlm] = useState<LlmConfigView | null>(null);
    /** 自己存下来的场景。内置的那些在 SCENARIO_PRESETS 里，是代码不是数据。 */
    const [saved, setSaved] = useState<SavedScenario[]>([]);

    useEffect(() => {
        document.title = '英语口语练习 · 工具箱';
        apiSpeakingStatus().then(setLlm).catch(() => setLlm({
            configured: false, baseUrl: '', model: '', keyHint: '', fromEnv: false,
            presets: [], models: [],
        }));
        apiListScenarios().then(setSaved).catch(() => { /* 存过的场景拉不到不影响用内置的 */ });
    }, []);

    const isCustom = preset === '__custom__';
    // 选中的是自己存的那一条时，preset 长这样：saved:12
    const savedId = preset.startsWith('saved:') ? Number(preset.slice(6)) : null;
    const savedPick = savedId ? saved.find((s) => s.id === savedId) ?? null : null;
    const words = parseTargetWords(wordsRaw);

    /** 开关：没开 → 开（空子选项）；已开 → 关 */
    const toggleKey = useCallback((k: InterferenceKey) => {
        setMods((cur) => {
            const next = { ...cur };
            if (next[k] === undefined) next[k] = [];
            else delete next[k];
            return next;
        });
    }, []);

    /** 子选项：点一下加、再点一下减；子选项全清空不等于关掉开关 */
    const toggleSub = useCallback((k: InterferenceKey, sub: string) => {
        setMods((cur) => {
            const subs = cur[k] ?? [];
            const next = subs.includes(sub) ? subs.filter((s) => s !== sub) : [...subs, sub];
            return { ...cur, [k]: next };
        });
    }, []);

    async function rollRandom() {
        setBusy('random'); setError(null); setNotice(null);
        try {
            const r = await apiRandomScenario();
            setPreset('__custom__');
            setCustom(r.scenario);
            setCustomLabel(r.label);
            setNotice('已生成一个新场景，可以直接用，也可以自己改。');
        } catch (e) {
            setError(e instanceof Error ? e.message : '生成失败');
        } finally { setBusy(''); }
    }

    /** 把当前写的场景存进「我的场景」。存的时候审一次，以后开练就不用再审了。 */
    async function saveScenario() {
        const scenario = custom.trim();
        if (!scenario) { setError('先把场景描述写出来'); return; }
        setBusy('save'); setError(null); setNotice(null);
        try {
            const r = await apiSaveScenario({
                label: customLabel.trim() || scenario.slice(0, 20),
                scenario,
            });
            setSaved(r.scenarios);
            setPreset('saved:' + r.scenario.id);       // 存完直接选中它
            setCustom(''); setCustomLabel('');
            setNotice(`已存为「${r.scenario.label}」，以后在上面直接点就能用。`);
        } catch (e) {
            setError(e instanceof Error ? e.message : '存不下来');
        } finally { setBusy(''); }
    }

    async function removeScenario(s: SavedScenario) {
        if (!window.confirm(`删除场景「${s.label}」吗？`)) return;
        try {
            setSaved(await apiDeleteScenario(s.id));
            if (savedId === s.id) setPreset(SCENARIO_PRESETS[0].key);
        } catch (e) {
            setError(e instanceof Error ? e.message : '删不掉');
        }
    }

    async function start() {
        setError(null); setNotice(null);
        const chosen = SCENARIO_PRESETS.find((p) => p.key === preset);
        const scenario = isCustom ? custom.trim() : savedPick ? savedPick.scenario : chosen?.scenario ?? '';
        if (!scenario) { setError('先选一个场景，或者自己写一个'); return; }

        try {
            // 只有「现写现用」的才要审：内置场景是我们自己写的，
            // 存下来的那些在存的时候已经审过一次，文本之后没再变
            if (isCustom) {
                setBusy('check');
                const v = await apiCheckScenario(scenario);
                if (!v.valid) { setError(v.reason || '这个场景不适合用来练习，换一个吧'); return; }
            }

            setBusy('start');
            const session = await apiCreateSpeakingSession({
                scenario,
                label: isCustom
                    ? (customLabel || custom.slice(0, 20))
                    : savedPick ? savedPick.label : (chosen?.label ?? ''),
                // preset 只记内置场景的 key；自己写的和自己存的都留空
                preset: isCustom || savedPick ? '' : preset,
                modifiers: mods,
                targetWords: wordsRaw,
            });
            navigate(`/tools/speaking/${session.id}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : '开始失败');
        } finally { setBusy(''); }
    }

    return (
        <AppShell
            title="英语口语练习"
            subtitle="Scenario Role-play · 场景角色扮演"
            sections={SPEAKING_SECTIONS}
            actions={
                <Link className="u-btn" to="/tools/speaking/history">
                    <i className="fas fa-clock-rotate-left" /> 练习记录
                </Link>
            }
        >
                <p className="u-aside">
                    <i className="fas fa-comments" />
                    AI 会扮演场景里那个<b>具体的人</b>，全程不出戏、不纠错、不夸你英语好。
                    真正的难度来自<b>听辨压力</b> —— 对方带口音、语速快、还在酒吧里跟你说话，
                    而不是来自生词。说话用浏览器自带的语音识别转成文字，
                    <b>全程不录音、不上传任何音频</b>；不方便说话时打字也一样能完整练完。
                </p>

                {/* 只摆一个下拉栏。加/改/删模型在个人中心的「AI 配置」里，全站就那一处 ——
                    管理界面一年用不了几次，不该在每个用到 AI 的页面上都占一大块 */}
                <AiModelSelect onChange={() => { void apiSpeakingStatus().then(setLlm).catch(() => { /* 拿不到就保持原样 */ }); }} />

                {error && <p className="fc-error"><i className="fas fa-circle-xmark" /> {error}</p>}
                {notice && <p className="fc-ok"><i className="fas fa-circle-check" /> {notice}</p>}

                {/* ---------- 1. 场景 ---------- */}
                <div className="section-head">
                    <h2><i className="fas fa-masks-theater" /> 1 · 选场景</h2>
                    <button
                        type="button"
                        className="fc-btn fc-head-btn"
                        onClick={() => void rollRandom()}
                        disabled={busy !== '' || !llm?.configured}
                    >
                        <i className={busy === 'random' ? 'fas fa-spinner fa-spin' : 'fas fa-dice'} /> 随机来一个
                    </button>
                </div>

                <div className="sp-preset-grid">
                    {SCENARIO_PRESETS.map((p) => (
                        <button
                            key={p.key}
                            type="button"
                            className={'sp-preset' + (preset === p.key ? ' on' : '')}
                            onClick={() => setPreset(p.key)}
                        >
                            <i className={'fas ' + p.icon} />
                            <b>{p.label}</b>
                            <span>{p.desc}</span>
                        </button>
                    ))}
                    {/* 自己存下来的，跟内置的并排。区别只有右上角那个删除按钮 */}
                    {saved.map((s) => (
                        <div
                            key={s.id}
                            className={'sp-preset sp-preset-saved' + (savedId === s.id ? ' on' : '')}
                            role="button"
                            tabIndex={0}
                            onClick={() => setPreset('saved:' + s.id)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreset('saved:' + s.id); }
                            }}
                        >
                            <i className="fas fa-bookmark" />
                            <b>{s.label}</b>
                            <span>{s.scenario.slice(0, 52)}{s.scenario.length > 52 ? '…' : ''}</span>
                            <button
                                type="button"
                                className="sp-preset-del"
                                title="删掉这个场景"
                                aria-label={`删掉场景 ${s.label}`}
                                onClick={(e) => { e.stopPropagation(); void removeScenario(s); }}
                            >
                                ×
                            </button>
                        </div>
                    ))}

                    <button
                        type="button"
                        className={'sp-preset sp-preset-custom' + (isCustom ? ' on' : '')}
                        onClick={() => setPreset('__custom__')}
                    >
                        <i className="fas fa-pen" />
                        <b>自己写一个</b>
                        <span>描述你要练的处境，开始前会先过一遍内容审核</span>
                    </button>
                </div>

                {savedPick && (
                    <div className="sp-saved-view">
                        <p className="fc-muted">
                            <i className="fas fa-bookmark" /> 存过的场景 ——
                            存的时候已经审核过，<b>开练时不再审一遍</b>。
                        </p>
                        <pre className="sp-saved-text">{savedPick.scenario}</pre>
                    </div>
                )}

                {isCustom && (
                    <div className="fc-form sp-custom">
                        <label style={{ flex: '1 1 100%' }}>
                            <span>场景描述（写英文效果最好；中文也认）</span>
                            <textarea
                                className="sp-textarea"
                                value={custom}
                                onChange={(e) => setCustom(e.target.value)}
                                placeholder={'例：The learner is at the council office trying to sort out a '
                                    + 'council tax bill that was sent to the wrong address. You are the clerk.'}
                            />
                        </label>
                        <label className="fc-form-narrow" style={{ flex: '0 0 220px' }}>
                            <span>给它起个名字（列表里显示）</span>
                            <input
                                value={customLabel}
                                onChange={(e) => setCustomLabel(e.target.value)}
                                placeholder="例：市政厅交税"
                            />
                        </label>
                        <p className="fc-muted fc-form-note">
                            写清楚<b>你是谁、对方是谁、你要办成什么事</b>，AI 才知道该怎么为难你。
                            只写「聊聊天气」这种，练不出什么东西。
                        </p>
                        <div className="sp-custom-ops">
                            <button
                                type="button"
                                className="fc-btn"
                                onClick={() => void saveScenario()}
                                disabled={busy !== '' || !custom.trim() || !llm?.configured}
                                title="存下来以后直接点就能用，不用每次重写"
                            >
                                <i className={busy === 'save' ? 'fas fa-spinner fa-spin' : 'fas fa-bookmark'} />
                                {busy === 'save' ? ' 审核中…' : ' 存到我的场景'}
                            </button>
                            <span className="fc-muted">
                                不存也能直接开练；存下来的好处是<b>以后不用再等审核</b>。
                            </span>
                        </div>
                    </div>
                )}

                {/* ---------- 2. 干扰项 ---------- */}
                <div className="section-head">
                    <h2><i className="fas fa-sliders" /> 2 · 干扰项</h2>
                    <span className="count">
                        {INTERFERENCE_KEYS.filter((k) => mods[k] !== undefined).length} / 5 已开启
                    </span>
                </div>
                <p className="fc-muted fc-note">
                    这些开关改变的是<b>对方怎么说话</b>，不影响给你的反馈是否公正。
                    一个都不开就是标准英语的正常对话；全开接近真实的英国街头。
                </p>

                <div className="sp-mod-grid">
                    {INTERFERENCE_KEYS.map((k) => {
                        const on = mods[k] !== undefined;
                        const subs = INTERFERENCE_SUBOPTIONS[k];
                        return (
                            <section key={k} className={'sp-mod' + (on ? ' on' : '')}>
                                <button type="button" className="sp-mod-head" onClick={() => toggleKey(k)}>
                                    <span className={'sp-switch' + (on ? ' on' : '')} aria-hidden="true">
                                        <i />
                                    </span>
                                    <span className="sp-mod-title">
                                        <i className={'fas ' + INTERFERENCE_LABELS[k].icon} />
                                        {INTERFERENCE_LABELS[k].title}
                                    </span>
                                    <span className="sp-mod-hint">{INTERFERENCE_LABELS[k].hint}</span>
                                </button>

                                {on && subs.length > 0 && (
                                    <div className="sp-subs">
                                        {subs.map((s) => (
                                            <button
                                                key={s}
                                                type="button"
                                                className={'fc-chip' + ((mods[k] ?? []).includes(s) ? ' on' : '')}
                                                onClick={() => toggleSub(k, s)}
                                            >
                                                {SUBOPTION_LABELS[k][s] ?? s}
                                            </button>
                                        ))}
                                        {(mods[k] ?? []).length === 0 && (
                                            <span className="fc-muted sp-sub-hint">不选就是随机混合</span>
                                        )}
                                    </div>
                                )}
                            </section>
                        );
                    })}
                </div>

                {/* ---------- 3. 目标词 ---------- */}
                <div className="section-head">
                    <h2><i className="fas fa-list-check" /> 3 · 目标词（可选）</h2>
                    <span className="count">{words.length} 个</span>
                </div>
                <p className="fc-muted fc-note">
                    一行一个，英文在前，后面可以跟中文注释。
                    AI 会<b>制造用得上它们的机会</b>，但绝不会念清单、也不会提醒你「试试这个词」——
                    一提醒就从角色扮演掉回背单词了。练完的报告里会列出你真正用上了哪些、避开了哪些。
                </p>
                <textarea
                    className="sp-textarea sp-words"
                    value={wordsRaw}
                    onChange={(e) => setWordsRaw(e.target.value)}
                    placeholder={'deposit 押金\ntenancy agreement 租约\nviewing 看房\nbills included 包水电'}
                />

                {/* ---------- 开始 ---------- */}
                <div className="sp-start-bar">
                    <button
                        type="button"
                        className="fc-btn fc-btn-primary sp-start"
                        onClick={() => void start()}
                        disabled={busy !== '' || !llm?.configured}
                    >
                        <i className={busy === 'start' || busy === 'check' ? 'fas fa-spinner fa-spin' : 'fas fa-play'} />
                        {busy === 'check' ? ' 正在审核场景…' : busy === 'start' ? ' 正在准备…' : ' 开始练习'}
                    </button>
                    <span className="fc-muted">
                        随时可以结束；结束后会生成一份基于对话记录的反馈报告。
                    </span>
                </div>
        </AppShell>
    );
}
