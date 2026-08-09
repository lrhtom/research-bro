// ============================================================
//  大模型配置面板
//
//  单机单人应用，配置直接存本机 SQLite 的 settings 表，填完即时生效、
//  不用重启服务，也不用去碰环境变量。
//
//  API Key 的处理：
//    · 输入框永远是空的，不回显明文 —— 服务端只回一个打码提示（sk-…a1b2），
//      够用来确认「填的是不是我以为的那把」，又不会让明文躺在浏览器缓存和抓包里
//    · 留空保存 = 不动原来那把，方便「只改模型不改 key」
//    · 环境变量配的那把，页面上不许改（改了也没用，读取时环境变量兜底在后面）
// ============================================================

import { useState } from 'react';
import { apiSaveLlmConfig, apiTestLlm, type LlmConfigView } from '@/lib/api';

interface Props {
    config: LlmConfigView;
    onSaved: (next: LlmConfigView) => void;
    /** 没配好时默认展开，配好了默认收起 */
    defaultOpen: boolean;
}

export default function LlmConfigPanel({ config, onSaved, defaultOpen }: Props) {
    const [open, setOpen] = useState(defaultOpen);
    const [baseUrl, setBaseUrl] = useState(config.baseUrl);
    const [model, setModel] = useState(config.model);
    const [apiKey, setApiKey] = useState('');
    const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

    async function save() {
        setBusy('save'); setMsg(null);
        try {
            const next = await apiSaveLlmConfig({
                baseUrl,
                model,
                // 空着就不传 —— 传空串是「明确要清掉」，那是另一回事
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            });
            setApiKey('');
            onSaved({ ...next, presets: config.presets });
            setMsg({ kind: 'ok', text: '已保存，立刻生效。' });
        } catch (e) {
            setMsg({ kind: 'err', text: e instanceof Error ? e.message : '保存失败' });
        } finally { setBusy(''); }
    }

    async function test() {
        setBusy('test'); setMsg(null);
        try {
            const r = await apiTestLlm();
            setMsg({ kind: 'ok', text: `连通了 —— ${r.model} 回了「${r.sample}」` });
        } catch (e) {
            setMsg({ kind: 'err', text: e instanceof Error ? e.message : '连不上' });
        } finally { setBusy(''); }
    }

    function applyPreset(key: string) {
        const p = config.presets.find((x) => x.key === key);
        if (!p) return;
        setBaseUrl(p.baseUrl);
        setModel(p.model);
    }

    return (
        <section className={'sp-llm' + (config.configured ? ' ok' : ' missing')}>
            <button type="button" className="sp-llm-head" onClick={() => setOpen((o) => !o)}>
                <i className={'fas ' + (config.configured ? 'fa-plug-circle-check' : 'fa-plug-circle-exclamation')} />
                <span className="sp-llm-title">大模型配置</span>
                <span className="sp-llm-state">
                    {config.configured
                        ? <>已配置 · <b>{config.model}</b>{config.keyHint && <em> · {config.keyHint}</em>}</>
                        : '还没配置 —— 配完才能开始练习'}
                </span>
                <i className={'fas fa-chevron-' + (open ? 'up' : 'down')} />
            </button>

            {open && (
                <div className="sp-llm-body">
                    <p className="fc-muted sp-llm-note">
                        任何 <b>OpenAI 兼容</b>的接口都能用（DeepSeek、OpenAI、OpenRouter、硅基流动、
                        通义、Kimi、本地 Ollama…）。配置存在本机
                        <code>data/app.db</code>，<b>不上传任何地方</b>；这台机器上填的 key
                        只会在向模型发请求时用到，页面上永远只看得到打码后的样子。
                    </p>

                    <div className="sp-llm-presets">
                        <span className="fc-muted">一键填好：</span>
                        {config.presets.map((p) => (
                            <button key={p.key} type="button" className="fc-chip" onClick={() => applyPreset(p.key)}>
                                {p.label}
                            </button>
                        ))}
                    </div>

                    <div className="sp-llm-grid">
                        <label>
                            <span>接口地址（Base URL）</span>
                            <input
                                value={baseUrl}
                                onChange={(e) => setBaseUrl(e.target.value)}
                                placeholder="https://api.deepseek.com/v1"
                                spellCheck={false}
                            />
                        </label>
                        <label>
                            <span>模型名</span>
                            <input
                                value={model}
                                onChange={(e) => setModel(e.target.value)}
                                placeholder="deepseek-chat"
                                spellCheck={false}
                            />
                        </label>
                        <label>
                            <span>
                                API Key
                                {config.keyHint && <em className="sp-llm-hint">当前：{config.keyHint}</em>}
                            </span>
                            <input
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder={config.configured ? '留空 = 不改动现有的 key' : 'sk-…'}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={config.fromEnv}
                            />
                        </label>
                    </div>

                    {config.fromEnv && (
                        <p className="fc-warn sp-llm-msg">
                            <i className="fas fa-circle-info" /> 当前这把 key 来自环境变量
                            <code>LLM_API_KEY</code>，页面上改不了。想在这儿管的话，先把那个环境变量去掉。
                        </p>
                    )}

                    <div className="sp-llm-actions">
                        <button
                            type="button"
                            className="fc-btn fc-btn-primary"
                            onClick={() => void save()}
                            disabled={busy !== ''}
                        >
                            <i className={busy === 'save' ? 'fas fa-spinner fa-spin' : 'fas fa-floppy-disk'} /> 保存
                        </button>
                        <button
                            type="button"
                            className="fc-btn"
                            onClick={() => void test()}
                            disabled={busy !== '' || !config.configured}
                            title={config.configured ? '打一次最小调用，看看能不能通' : '先保存 key'}
                        >
                            <i className={busy === 'test' ? 'fas fa-spinner fa-spin' : 'fas fa-vial'} /> 测试连接
                        </button>
                    </div>

                    {msg && (
                        <p className={(msg.kind === 'ok' ? 'fc-ok' : 'fc-error') + ' sp-llm-msg'}>
                            <i className={'fas ' + (msg.kind === 'ok' ? 'fa-circle-check' : 'fa-circle-xmark')} />
                            {' '}{msg.text}
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}
