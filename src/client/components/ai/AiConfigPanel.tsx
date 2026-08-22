// ============================================================
//  AI 配置面板
//
//  全站**唯一**能增删改模型的地方，摆在个人中心。
//  形制照搬 aIELTS 的那一块：顶上一个下拉栏选当前用哪个，
//  下面是自定义模型的管理列表，每行 测试 / 修改 / 删除，右上角一个添加。
//
//  别的页面（口语练习、AI 出题）只放 AiModelSelect 那个下拉栏 ——
//  管理界面一年用不了几次，不该在每个页面上都占一大块，
//  更不该在三个页面上各维护一份。
//
//  「测试」是逐套单独测的，**不会切换**当前在用的那个：想知道哪一套
//  还能用，不该逼你先切过去、测完再切回来（切换会立刻影响
//  口语练习、AI 出题和悬浮球）。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import {
    apiActivateLlmModel, apiDeleteLlmModel, apiListLlmModels, apiTestLlmModel,
} from '@/lib/api';
import type { LlmModel, LlmTestResult } from '@/lib/api';
import AiModelModal from './AiModelModal';

export default function AiConfigPanel() {
    const [models, setModels] = useState<LlmModel[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [results, setResults] = useState<Record<number, LlmTestResult>>({});

    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<LlmModel | null>(null);

    const load = useCallback(async () => {
        try {
            setModels((await apiListLlmModels()).models);
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : '读不到模型列表');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const activeId = models.find((m) => m.active)?.id ?? 0;

    async function activate(id: number) {
        setBusy('act' + id);
        setModels((cur) => cur.map((m) => ({ ...m, active: m.id === id })));
        try {
            setModels((await apiActivateLlmModel(id)).models);
        } catch (e) {
            setError(e instanceof Error ? e.message : '切换失败');
            await load();
        } finally { setBusy(''); }
    }

    async function test(m: LlmModel) {
        setBusy('test' + m.id);
        try {
            // 先 await 出结果再进 setState —— 那个更新函数是同步回调，await 进不去
            const r = await apiTestLlmModel(m.id);
            setResults((cur) => ({ ...cur, [m.id]: r }));
        } catch (e) {
            setResults((r) => ({
                ...r,
                [m.id]: {
                    status: 'error', http: null, sample: null,
                    message: e instanceof Error ? e.message : '测不了',
                },
            }));
        } finally { setBusy(''); }
    }

    async function remove(m: LlmModel) {
        const warn = m.active
            ? `\n\n它正是当前在用的那一套，删掉之后会自动退回列表里的第一套。`
            : '';
        if (!window.confirm(`删除「${m.alias}」吗？\n模型名 ${m.model}，删了这台机器上就没有它了。${warn}`)) return;

        setBusy('del' + m.id);
        try {
            setModels((await apiDeleteLlmModel(m.id)).models);
            setResults((r) => { const next = { ...r }; delete next[m.id]; return next; });
        } catch (e) {
            setError(e instanceof Error ? e.message : '删除失败');
        } finally { setBusy(''); }
    }

    return (
        <section className="am-panel">
            <div className="am-panel-head">
                <div>
                    <h3 className="am-panel-title"><i className="fas fa-robot" /> AI 配置</h3>
                    <p className="am-panel-desc">
                        选一个用来生成和批改的模型。<b>全站共用</b> —— 口语练习、AI 出题、
                        右下角的助手用的都是这里选中的这一套。
                    </p>
                </div>
            </div>

            {loading && <p className="u-note"><i className="fas fa-spinner fa-spin" /> 正在读…</p>}

            {!loading && (
                <select
                    className="am-select am-select-wide"
                    value={activeId || ''}
                    disabled={busy !== '' || models.length === 0}
                    onChange={(e) => void activate(Number(e.target.value))}
                >
                    {models.length === 0 && <option value="">还没有模型 —— 用右边的按钮加一套</option>}
                    {models.map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.hasKey ? '★ ' : '⚠ '}{m.alias}（{m.model}）{m.hasKey ? '' : ' · 没填 key'}
                        </option>
                    ))}
                </select>
            )}

            <div className="am-panel-head am-sub-head">
                <div>
                    <h4 className="am-panel-title am-sub-title">自定义模型管理</h4>
                    <p className="am-panel-desc">
                        任何 <b>OpenAI 兼容</b>的接口都能加（DeepSeek、OpenAI、OpenRouter、硅基流动、
                        通义、Kimi、本地 Ollama…）。配置只存在本机 <code>data/app.db</code>，
                        <b>不上传任何地方</b>；API Key 明文除了发给模型之外不离开这台电脑。
                    </p>
                </div>
                <button
                    type="button"
                    className="am-add-btn"
                    onClick={() => { setEditing(null); setModalOpen(true); }}
                >
                    <i className="fas fa-plus" /> 添加自定义模型
                </button>
            </div>

            {error && <p className="am-error"><i className="fas fa-circle-xmark" /> {error}</p>}

            {!loading && models.length === 0 && (
                <p className="am-empty">一套都还没有。加一套（接口地址 + API Key + 模型名）才能用站里的 AI 功能。</p>
            )}

            {models.length > 0 && (
                <ul className="am-list">
                    {models.map((m) => {
                        const r = results[m.id];
                        return (
                            <li key={m.id} className={'am-row' + (m.active ? ' on' : '')}>
                                <div className="am-row-info">
                                    <div className="am-row-name">
                                        {m.alias}
                                        {m.active && <span className="am-tag">使用中</span>}
                                        {!m.hasKey && <span className="am-tag warn">没填 key</span>}
                                    </div>
                                    <div className="am-row-sub">
                                        <code>{m.model}</code>
                                        <em>{m.keyHint || '—'}</em>
                                        <em>{m.baseUrl}</em>
                                    </div>
                                    {r && (
                                        <span className={'am-result s-' + r.status}>
                                            <span className="am-dot" />
                                            {r.message}
                                            {r.status === 'ok' && r.sample && <em> —— 它回了「{r.sample}」</em>}
                                        </span>
                                    )}
                                </div>

                                <div className="am-row-ops">
                                    <button
                                        type="button"
                                        className="fc-btn"
                                        disabled={busy !== ''}
                                        onClick={() => void test(m)}
                                    >
                                        <i className={'fas ' + (busy === 'test' + m.id ? 'fa-spinner fa-spin' : 'fa-vial')} /> 测试
                                    </button>
                                    <button
                                        type="button"
                                        className="fc-btn"
                                        disabled={busy !== ''}
                                        onClick={() => { setEditing(m); setModalOpen(true); }}
                                    >
                                        <i className="fas fa-pen" /> 修改
                                    </button>
                                    <button
                                        type="button"
                                        className="fc-btn am-danger"
                                        disabled={busy !== ''}
                                        onClick={() => void remove(m)}
                                    >
                                        <i className={'fas ' + (busy === 'del' + m.id ? 'fa-spinner fa-spin' : 'fa-trash')} /> 删除
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <AiModelModal
                open={modalOpen}
                editing={editing}
                onClose={() => setModalOpen(false)}
                onSaved={(next, savedId) => {
                    setModels(next);
                    // 新加的那一套直接切过去 —— 你刚配好它，八成就是要用它
                    if (!editing && savedId) void activate(savedId);
                }}
            />
        </section>
    );
}
