// ============================================================
//  添加 / 修改一套模型配置
//
//  形制照搬 aIELTS 那个弹窗：三个输入框 + 一个问号按钮展开常见供应商的
//  填法示例，每条带「填进去」一键套用。
//
//  为什么要那个示例面板：「Base URL 填什么」是这类配置唯一真正劝退人的
//  地方 —— 各家结尾要不要带 /v1、要不要带 /chat/completions 全不一样，
//  错一个字符就是一个看不懂的 404。与其写一段说明让人自己对照，
//  不如直接给可以点的样板。
//
//  两处刻意的设计：
//    · **可以先测再存**。不然只能「存了再测，不行再改」，而错的那一套
//      已经躺在列表里了。
//    · **改的时候 key 留空 = 不动原来那把**。页面永远不回显明文 key，
//      所以「只改别名不改 key」必须是可能的。
// ============================================================

import { useEffect, useState } from 'react';
import { apiCreateLlmModel, apiTestLlmConfig, apiTestLlmModel, apiUpdateLlmModel } from '@/lib/api';
import type { LlmModel, LlmTestResult } from '@/lib/api';

interface Props {
    open: boolean;
    /** 传了就是「改这一套」，不传就是「加一套新的」 */
    editing?: LlmModel | null;
    onClose: () => void;
    onSaved: (models: LlmModel[], savedId: number) => void;
}

/**
 * 常见供应商的填法样板。
 *
 * 这里给的是不带 /chat/completions 的短形式，但**两种都能用** ——
 * 服务端的 normUrl（src/server/llm-models.ts）会把末尾那段剥掉再拼。
 * 加这层容忍是因为各家文档给的形态本来就不一样：OpenAI 文档写的是
 * 完整路径，DeepSeek 写的是短的，而人当然是照着文档复制的。
 */
const PRESETS = [
    { key: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', sk: 'sk-…' },
    { key: 'openai', label: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', sk: 'sk-…' },
    { key: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1', sk: 'sk-or-…' },
    { key: 'siliconflow', label: '硅基流动', model: 'Qwen/Qwen2.5-7B-Instruct', baseUrl: 'https://api.siliconflow.cn/v1', sk: 'sk-…' },
    { key: 'dashscope', label: '阿里通义', model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sk: 'sk-…' },
    { key: 'moonshot', label: '月之暗面 Kimi', model: 'moonshot-v1-8k', baseUrl: 'https://api.moonshot.cn/v1', sk: 'sk-…' },
    { key: 'ollama', label: '本地 Ollama', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1', sk: 'ollama（随便填，本地不校验）' },
] as const;

export default function AiModelModal({ open, editing, onClose, onSaved }: Props) {
    const [alias, setAlias] = useState('');
    const [model, setModel] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');

    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState<LlmTestResult | null>(null);
    const [error, setError] = useState('');
    const [showHelp, setShowHelp] = useState(false);

    // 每次打开（或换了编辑对象）都重置。不重置的话，上一次填了一半
    // 关掉的东西会留在框里，下次打开看着像是已经存过了
    useEffect(() => {
        if (!open) return;
        setAlias(editing?.alias ?? '');
        setModel(editing?.model ?? '');
        setBaseUrl(editing?.baseUrl ?? '');
        setApiKey('');
        setResult(null);
        setError('');
        setShowHelp(false);
    }, [open, editing]);

    // Esc 关掉。弹窗不给键盘出口是很烦人的
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    function applyPreset(p: typeof PRESETS[number]) {
        setBaseUrl(p.baseUrl);
        setModel(p.model);
        // 别名空着才顺手垫一个，不覆盖已经起好的名字
        setAlias((a) => a || p.label);
        if (p.key === 'ollama') setApiKey('ollama');
        setResult(null);
        setError('');
    }

    /** 名字和地址的基本校验。返回空串表示没问题。 */
    function validate(): string {
        if (!alias.trim()) return '给它起个名字吧，列表上显示的就是这个';
        if (!model.trim()) return '模型名不能空 —— 那是接口真正认的那个字符串';
        if (!/^https?:\/\//i.test(baseUrl.trim())) return '接口地址要以 http:// 或 https:// 开头';
        return '';
    }

    async function test() {
        setError('');
        setResult(null);

        const bad = validate();
        if (bad) { setError(bad); return; }

        const typed = apiKey.trim();
        if (!typed && !editing) { setError('新加的这套还没填 API Key，测不了'); return; }

        setTesting(true);
        try {
            // 填了新 key 就测新填的这份；没填而且是在改已有的，就测存着的那一套
            setResult(typed
                ? await apiTestLlmConfig({ baseUrl: baseUrl.trim(), apiKey: typed, model: model.trim() })
                : await apiTestLlmModel(editing!.id));
        } catch (e) {
            setResult({
                status: 'error', http: null, sample: null,
                message: e instanceof Error ? e.message : '测不了',
            });
        } finally {
            setTesting(false);
        }
    }

    async function save() {
        const bad = validate();
        if (bad) { setError(bad); return; }
        if (!editing && !apiKey.trim()) { setError('新加的这套要填 API Key'); return; }

        setSaving(true);
        setError('');
        try {
            const body = {
                alias: alias.trim(),
                model: model.trim(),
                baseUrl: baseUrl.trim(),
                // 留空 = 不传这个键 = 服务端不动原来那把
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            };
            const reply = editing
                ? await apiUpdateLlmModel(editing.id, body)
                : await apiCreateLlmModel(body);

            const savedId = reply.models.find((m) => m.alias === body.alias && m.model === body.model)?.id
                ?? editing?.id
                ?? reply.models[reply.models.length - 1]?.id
                ?? 0;
            onSaved(reply.models, savedId);
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : '保存失败');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="am-overlay" onClick={onClose} role="presentation">
            <div
                className="am-modal"
                role="dialog"
                aria-modal="true"
                aria-label={editing ? '修改模型' : '添加模型'}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="am-modal-head">
                    <h3>{editing ? '修改模型' : '添加自定义模型'}</h3>
                    <button
                        type="button"
                        className={'am-help-btn' + (showHelp ? ' on' : '')}
                        title="常见供应商怎么填"
                        aria-label="常见供应商怎么填"
                        onClick={() => setShowHelp((v) => !v)}
                    >
                        <i className="fas fa-circle-question" />
                    </button>
                    <button type="button" className="am-close" aria-label="关闭" onClick={onClose}>
                        <i className="fas fa-xmark" />
                    </button>
                </div>

                {showHelp && (
                    <div className="am-help">
                        <p className="am-help-intro">
                            任何 <b>OpenAI 兼容</b>的接口都能用。地址<b>照着对方文档复制就行</b> ——
                            填到 <code>/v1</code> 为止，或者把整条
                            <code>/v1/chat/completions</code> 一起粘进来，两种都认。
                        </p>
                        <div className="am-help-list">
                            {PRESETS.map((p) => (
                                <div key={p.key} className="am-help-item">
                                    <div className="am-help-item-head">
                                        <b>{p.label}</b>
                                        <button type="button" className="am-help-fill" onClick={() => applyPreset(p)}>
                                            填进去
                                        </button>
                                    </div>
                                    <div className="am-help-kv"><span>模型名</span><code>{p.model}</code></div>
                                    <div className="am-help-kv"><span>接口地址</span><code>{p.baseUrl}</code></div>
                                    <div className="am-help-kv"><span>API Key</span><code>{p.sk}</code></div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                <label className="am-field">
                    <span>别名（自己起的名字，列表上显示它）</span>
                    <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="例：便宜的那个" maxLength={60} />
                </label>

                <label className="am-field">
                    <span>模型名（接口真正认的那个）</span>
                    <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" spellCheck={false} />
                </label>

                <label className="am-field">
                    <span>接口地址（Base URL）</span>
                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
                </label>

                <label className="am-field">
                    <span>API Key</span>
                    <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={editing ? (editing.keyHint || '留空 = 不改动现有的 key') : 'sk-…'}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {editing && <em className="am-hint">留空就是不动原来那把。key 只存在本机，页面上永远只看得到打码后的样子。</em>}
                </label>

                {error && <p className="am-error"><i className="fas fa-circle-xmark" /> {error}</p>}

                {result && (
                    <p className={'am-result s-' + result.status}>
                        <span className="am-dot" />
                        {result.message}
                        {result.status === 'ok' && result.sample && <em> —— 它回了「{result.sample}」</em>}
                    </p>
                )}

                <div className="am-modal-actions">
                    <button type="button" className="fc-btn" onClick={() => void test()} disabled={testing || saving}>
                        <i className={'fas ' + (testing ? 'fa-spinner fa-spin' : 'fa-vial')} /> 测一下
                    </button>
                    <span className="am-spacer" />
                    <button type="button" className="fc-btn" onClick={onClose} disabled={saving}>取消</button>
                    <button
                        type="button"
                        className="fc-btn fc-btn-primary"
                        onClick={() => void save()}
                        disabled={saving || testing}
                    >
                        <i className={'fas ' + (saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk')} />
                        {editing ? ' 保存修改' : ' 添加'}
                    </button>
                </div>
            </div>
        </div>
    );
}
