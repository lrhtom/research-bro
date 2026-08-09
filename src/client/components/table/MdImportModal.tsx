// 导入 Markdown 表格的弹窗：边打边预览，确认后交给编辑器建表 / 替换当前表。

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    mdColCount,
    mdInlineToHtml,
    mdTableName,
    parseMarkdownTables,
    type MdTable,
} from '@/lib/markdown-table';

export type MdImportMode = 'new' | 'replace';

interface Props {
    open: boolean;
    onClose: () => void;
    onConfirm: (tables: MdTable[], mode: MdImportMode) => void;
    onNotify: (msg: string) => void;
}

/** 预览用的小表格（最多显示 5 行数据）*/
function PreviewTable({ t, cols }: { t: MdTable; cols: number }) {
    const align = t.align || [];
    const styleFor = (i: number) =>
        (align[i] ? { textAlign: align[i] as React.CSSProperties['textAlign'] } : undefined);

    return (
        <>
            <table className="md-preview-table">
                <thead>
                    <tr>
                        {Array.from({ length: cols }, (_, i) => (
                            <th
                                key={i}
                                style={styleFor(i)}
                                dangerouslySetInnerHTML={{ __html: mdInlineToHtml(t.header[i] || '') }}
                            />
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {t.rows.slice(0, 5).map((r, ri) => (
                        <tr key={ri}>
                            {Array.from({ length: cols }, (_, i) => (
                                <td
                                    key={i}
                                    style={styleFor(i)}
                                    dangerouslySetInnerHTML={{ __html: mdInlineToHtml(r[i] || '') }}
                                />
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            {t.rows.length > 5 && (
                <div className="md-preview-more">…还有 {t.rows.length - 5} 行未预览</div>
            )}
        </>
    );
}

export default function MdImportModal({ open, onClose, onConfirm, onNotify }: Props) {
    const [text, setText] = useState('');
    const [mode, setMode] = useState<MdImportMode>('new');
    const textRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const tables = useMemo(() => (text.trim() ? parseMarkdownTables(text) : []), [text]);

    useEffect(() => {
        if (open) setTimeout(() => textRef.current?.focus(), 0);
    }, [open]);

    // Esc 关闭。用捕获阶段，抢在编辑器那套快捷键之前处理掉。
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [open, onClose]);

    function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = '';                       // 允许再次选择同一个文件
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            setText(String(reader.result || ''));
            onNotify('已读取 ' + file.name);
        };
        reader.onerror = () => onNotify('读取文件失败');
        reader.readAsText(file, 'UTF-8');
    }

    return (
        <div
            className={'modal-mask' + (open ? ' show' : '')}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="md-import-title">
                <div className="modal-head">
                    <h3 id="md-import-title"><i className="fas fa-file-import" /> 导入 Markdown 表格</h3>
                    <button type="button" className="icon-btn" onClick={onClose} title="关闭">
                        <i className="fas fa-times" />
                    </button>
                </div>

                <div className="modal-body">
                    <p className="modal-hint">
                        把 Markdown 表格粘进来，或选一个 <code>.md</code> 文件。<br />
                        支持 <code>:---:</code> 对齐、<code>\|</code> 转义、<code>&lt;br&gt;</code> 换行、
                        <code>**粗体**</code> / <code>*斜体*</code>。<br />
                        表格上方紧邻的一行短文字会当作<b>表题</b>；一段文本里有多个表格会一次全部识别。
                    </p>

                    <textarea
                        ref={textRef}
                        id="md-import-text"
                        spellCheck={false}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={'**表 1 各组前后测成绩**\n\n| 组别 | 人数 | 前测 M (SD) | 后测 M (SD) |\n| --- | ---: | ---: | ---: |\n| 实验组 | 42 | 68.3 (7.1) | 81.5 (6.4) |\n| 对照组 | 40 | 67.9 (6.8) | 71.2 (7.0) |'}
                    />

                    <div className="modal-row">
                        <label className="file-pick">
                            <input
                                ref={fileRef}
                                type="file"
                                accept=".md,.markdown,.txt,text/markdown,text/plain"
                                onChange={pickFile}
                            />
                            <i className="fas fa-folder-open" /> 选择 .md 文件
                        </label>
                        <div className="modal-modes">
                            <label>
                                <input
                                    type="radio"
                                    name="md-import-mode"
                                    checked={mode === 'new'}
                                    onChange={() => setMode('new')}
                                /> 新建表格
                            </label>
                            <label>
                                <input
                                    type="radio"
                                    name="md-import-mode"
                                    checked={mode === 'replace'}
                                    onChange={() => setMode('replace')}
                                /> 替换当前表格
                            </label>
                        </div>
                    </div>

                    <div id="md-import-preview" className="md-preview">
                        {!text.trim() && (
                            <p className="md-preview-empty">粘贴或选择文件后，这里会显示识别到的表格。</p>
                        )}
                        {!!text.trim() && tables.length === 0 && (
                            <p className="md-preview-bad">
                                <i className="fas fa-triangle-exclamation" /> 没识别到表格。
                                Markdown 表格需要一行分隔行，形如 <code>| --- | --- |</code>。
                            </p>
                        )}
                        {tables.length > 0 && (
                            <>
                                <p className="md-preview-ok">
                                    <i className="fas fa-circle-check" /> 识别到 {tables.length} 个表格
                                </p>
                                {tables.slice(0, 5).map((t, i) => {
                                    const cols = mdColCount(t);
                                    return (
                                        <div className="md-preview-item" key={i}>
                                            <div className="md-preview-meta">
                                                #{i + 1} {mdTableName(t, i + 1)} · {cols} 列 × {t.rows.length} 行数据
                                            </div>
                                            <PreviewTable t={t} cols={cols} />
                                        </div>
                                    );
                                })}
                                {tables.length > 5 && (
                                    <p className="md-preview-more">
                                        …另有 {tables.length - 5} 个表格未预览，导入时同样会处理。
                                    </p>
                                )}
                            </>
                        )}
                    </div>
                </div>

                <div className="modal-foot">
                    <button type="button" onClick={onClose}>取消</button>
                    <button
                        type="button"
                        className="primary"
                        disabled={tables.length === 0}
                        onClick={() => { onConfirm(tables, mode); setText(''); }}
                    >
                        <i className="fas fa-check" /> 导入
                    </button>
                </div>
            </div>
        </div>
    );
}
