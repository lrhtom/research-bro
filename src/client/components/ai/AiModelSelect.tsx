// ============================================================
//  选模型的下拉栏
//
//  站里凡是「要用 AI 生成点什么」的地方（口语练习、AI 出题、悬浮球…）
//  都只摆这一个下拉栏。**增删改查一律不在这儿** —— 那些在「AI 配置」
//  面板里做（个人中心）。
//
//  为什么这么切：管理界面只在你想换配置时用一次，而下拉栏是每次要用
//  之前都会看一眼的东西。把整套「添加/编辑/删除/测试」摆在每个页面上，
//  等于让最少用的功能占掉最好的位置，还得在三个页面上各维护一遍。
//
//  唯一的例外是下拉栏顶上那个「+ 添加自定义模型」：没有任何模型时，
//  一个空下拉栏是死路 —— 得能就地加一个。
//
//  切换是**立刻全站生效**的：这套配置口语练习、AI 出题、悬浮球共用。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { apiActivateLlmModel, apiListLlmModels } from '@/lib/api';
import type { LlmModel } from '@/lib/api';
import AiModelModal from './AiModelModal';

/** 下拉栏顶上那一项的值。只是个信号，永远不会被存下去。 */
const ADD = '__add__';

interface Props {
    /** 左边那行小字。传空串就不显示。 */
    label?: string;
    /** 紧凑版：只有一个药丸形状的下拉栏，塞在工具栏里用 */
    variant?: 'default' | 'compact';
    /** 切换之后回调，页面通常拿它去刷新「配好了没有」这类状态 */
    onChange?: (active: LlmModel | null) => void;
}

export default function AiModelSelect({ label = 'AI 模型', variant = 'default', onChange }: Props) {
    const [models, setModels] = useState<LlmModel[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [modalOpen, setModalOpen] = useState(false);

    const activeId = models.find((m) => m.active)?.id ?? 0;

    const load = useCallback(async () => {
        try {
            const r = await apiListLlmModels();
            setModels(r.models);
            setError('');
            return r.models;
        } catch (e) {
            setError(e instanceof Error ? e.message : '读不到模型列表');
            return [];
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    async function pick(value: string) {
        if (value === ADD) { setModalOpen(true); return; }

        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) return;

        // 先本地切过去，接口回来再以服务端为准 —— 下拉栏点一下要立刻有反应，
        // 而不是等一个来回之后才跳过去
        setModels((cur) => cur.map((m) => ({ ...m, active: m.id === id })));
        setBusy(true);
        try {
            const r = await apiActivateLlmModel(id);
            setModels(r.models);
            onChange?.(r.models.find((m) => m.active) ?? null);
        } catch (e) {
            setError(e instanceof Error ? e.message : '切换失败');
            await load();   // 切失败就回到服务端那一份，别让界面停在一个假状态上
        } finally {
            setBusy(false);
        }
    }

    const configured = models.some((m) => m.hasKey);

    const select = (
        <select
            className={'am-select' + (variant === 'compact' ? ' am-select-compact' : '')}
            value={activeId || ADD}
            disabled={busy}
            onChange={(e) => void pick(e.target.value)}
            title={configured ? '换一个模型（全站共用）' : '还没有可用的模型'}
        >
            {models.length === 0 && <option value={ADD}>还没有模型 —— 点这里添加</option>}
            {models.map((m) => (
                <option key={m.id} value={m.id}>
                    {m.hasKey ? '★ ' : '⚠ '}{m.alias}（{m.model}）{m.hasKey ? '' : ' · 没填 key'}
                </option>
            ))}
            {models.length > 0 && <option value={ADD}>＋ 添加自定义模型…</option>}
        </select>
    );

    if (variant === 'compact') {
        return (
            <>
                {select}
                <AiModelModal
                    open={modalOpen}
                    onClose={() => setModalOpen(false)}
                    onSaved={(next, savedId) => { setModels(next); void pick(String(savedId)); }}
                />
            </>
        );
    }

    return (
        <div className={'am-pick' + (configured ? '' : ' is-missing')}>
            {label && (
                <div className="am-pick-label">
                    <i className={'fas ' + (configured ? 'fa-plug-circle-check' : 'fa-plug-circle-exclamation')} />
                    <span>{label}</span>
                </div>
            )}
            {select}
            <em className="am-pick-note">
                {configured
                    ? '口语练习、AI 出题、右下角的助手共用这一个。换了立刻生效。'
                    : '还没配好 —— 加一套（接口地址 + API Key + 模型名）才能用 AI 功能。'}
            </em>
            {error && <p className="am-error"><i className="fas fa-circle-xmark" /> {error}</p>}

            <AiModelModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onSaved={(next, savedId) => { setModels(next); void pick(String(savedId)); }}
            />
        </div>
    );
}
