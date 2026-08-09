// JSON 导入面板：选文件或直接粘贴，边打边预览，确认后再发给服务端。
//
// 解析用的是 shared/card-import.ts —— 前端拿它做预览，后端拿它做最终校验，
// 同一套规则，不会出现「预览说能导 30 张、导进去只剩 12 张」这种事。

import { useMemo, useRef, useState } from 'react';
import { parseDeckText } from '../../../shared/card-import';
import { apiImportAsNewPlan, apiImportIntoPlan } from '@/lib/api';

const SAMPLE = `{
  "name": "示例计划",
  "dailyNewLimit": 20,
  "cards": [
    { "front": "FSRS 里的 stability 是什么？", "back": "记忆能维持的**天数**。\\n\\n它越大，下次复习排得越远。" },
    { "front": "difficulty 的取值范围", "back": "1 ~ 10" }
  ]
}`;

interface Props {
    /** new-plan：导入时顺便建一个新计划；into-plan：导进已有计划 */
    mode: 'new-plan' | 'into-plan';
    planId?: number;
    onDone: (message: string) => void;
}

export default function ImportPanel({ mode, planId, onDone }: Props) {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const parsed = useMemo(() => (text.trim() ? parseDeckText(text) : null), [text]);

    function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = '';                 // 允许再次选同一个文件
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setText(String(reader.result || ''));
        reader.onerror = () => setError('读取文件失败');
        reader.readAsText(file, 'UTF-8');
    }

    async function submit() {
        if (!parsed?.ok || !parsed.deck) return;
        setBusy(true);
        setError(null);
        try {
            if (mode === 'new-plan') {
                const r = await apiImportAsNewPlan(parsed.deck);
                onDone(`已新建计划「${r.plan.name}」并导入 ${r.count} 张卡片`);
            } else {
                const r = await apiImportIntoPlan(planId!, parsed.deck);
                onDone(`已导入 ${r.count} 张卡片`);
            }
            setText('');
        } catch (e) {
            setError(e instanceof Error ? e.message : '导入失败');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fc-import">
            <p className="fc-import-hint">
                支持顶层数组 <code>[&#123;front, back&#125;, …]</code>，或带 <code>cards</code> 字段的对象。
                字段名认这些别名：正面 <code>front / question / q / term / 正面</code>，
                背面 <code>back / answer / a / definition / 背面</code>。
                背面按 <b>Markdown</b> 渲染。
            </p>

            <textarea
                className="fc-import-text"
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={SAMPLE}
            />

            <div className="fc-import-row">
                <label className="fc-file">
                    <input ref={fileRef} type="file" accept=".json,application/json" onChange={pickFile} />
                    <i className="fas fa-folder-open" /> 选择 .json 文件
                </label>
                <button
                    type="button"
                    className="fc-btn fc-btn-primary"
                    disabled={!parsed?.ok || busy}
                    onClick={() => void submit()}
                >
                    <i className={busy ? 'fas fa-spinner fa-spin' : 'fas fa-file-import'} />{' '}
                    {mode === 'new-plan' ? '导入为新计划' : '导入到本计划'}
                </button>
            </div>

            {error && <p className="fc-error"><i className="fas fa-circle-xmark" /> {error}</p>}

            {parsed && !parsed.ok && (
                <p className="fc-error"><i className="fas fa-circle-xmark" /> {parsed.error}</p>
            )}

            {parsed?.ok && parsed.deck && (
                <div className="fc-import-preview">
                    <p className="fc-ok">
                        <i className="fas fa-circle-check" /> 识别到 <b>{parsed.deck.cards.length}</b> 张卡片
                        {parsed.deck.name && <> · 计划名「{parsed.deck.name}」</>}
                        {parsed.deck.dailyNewLimit !== undefined && <> · 每日新卡 {parsed.deck.dailyNewLimit}</>}
                    </p>
                    <table className="fc-table">
                        <thead><tr><th>#</th><th>正面</th><th>背面（Markdown 源码）</th></tr></thead>
                        <tbody>
                            {parsed.deck.cards.slice(0, 8).map((c, i) => (
                                <tr key={i}>
                                    <td>{i + 1}</td>
                                    <td>{c.front.slice(0, 60)}</td>
                                    <td className="fc-muted">{c.back.slice(0, 80) || '（空）'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {parsed.deck.cards.length > 8 && (
                        <p className="fc-muted">…另有 {parsed.deck.cards.length - 8} 张未列出，导入时同样会处理。</p>
                    )}
                    {parsed.warnings.length > 0 && (
                        <p className="fc-warn">
                            <i className="fas fa-triangle-exclamation" /> {parsed.warnings.slice(0, 5).join('；')}
                            {parsed.warnings.length > 5 && ` …等 ${parsed.warnings.length} 条`}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
