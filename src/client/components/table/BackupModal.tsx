// ============================================================
//  数据备份与迁移
//
//  跟旧版最大的差别：表格现在存在本机 SQLite（data/app.db），不再是浏览器
//  localStorage —— 换浏览器不会丢，也没有 5MB 上限。但库文件本身仍然只在
//  这台机器上，所以「导出成 JSON」依然是唯一能带走的备份形式。
//  导出格式与旧版完全一致，两边可以互相导入。
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { fmtSize, parseBackup, type ParsedBackup } from '@/lib/table-dom';
import { BACKUP_FORMAT } from '../../../shared/table-defaults';
import { apiRestoreBackup } from '@/lib/api';
import type { TableSummary } from '../../../shared/types';

type RestoreMode = 'merge' | 'replace';

interface Props {
    open: boolean;
    onClose: () => void;
    tables: TableSummary[];
    currentId: string;
    /** 恢复完成后通知编辑器刷新列表并切到第一张表 */
    onRestored: (firstId: string, count: number, mode: RestoreMode) => void;
    onNotify: (msg: string) => void;
}

export default function BackupModal({
    open, onClose, tables, currentId, onRestored, onNotify,
}: Props) {
    const [mode, setMode] = useState<RestoreMode>('merge');
    const [pending, setPending] = useState<ParsedBackup | null>(null);
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) { setPending(null); setBusy(false); }
    }, [open]);

    // Esc 关闭（捕获阶段，抢在编辑器快捷键之前）
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [open, onClose]);

    const totalBytes = tables.reduce((a, t) => a + t.bytes, 0);

    function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = '';                       // 允许再次选择同一个文件
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setPending(parseBackup(String(reader.result || ''), BACKUP_FORMAT));
        reader.onerror = () => onNotify('读取文件失败');
        reader.readAsText(file, 'UTF-8');
    }

    async function confirmRestore() {
        if (!pending?.ok || !pending.tables) return;

        if (mode === 'replace') {
            const ok = window.confirm(
                `确定要用备份里的 ${pending.tables.length} 张表\n覆盖当前的 ${tables.length} 张表吗？\n\n`
                + '当前数据会被全部删除，且无法撤销。\n建议先点上面的「导出全部」备份一份。',
            );
            if (!ok) return;
        }

        setBusy(true);
        try {
            const payload = pending.tables.map((t) => ({ name: t.name, html: t.html }));
            const res = await apiRestoreBackup(payload, mode);
            onRestored(res.firstId, res.count, res.mode);
        } catch (err) {
            onNotify(err instanceof Error ? err.message : '恢复失败');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div
            className={'modal-mask' + (open ? ' show' : '')}
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="backup-title">
                <div className="modal-head">
                    <h3 id="backup-title"><i className="fas fa-database" /> 数据备份与迁移</h3>
                    <button type="button" className="icon-btn" onClick={onClose} title="关闭">
                        <i className="fas fa-times" />
                    </button>
                </div>

                <div className="modal-body">
                    <p className="modal-hint">
                        表格现在存在<b>本机的 SQLite 数据库</b>（<code>data/app.db</code>）里 ——
                        换浏览器、清缓存都不会再丢，也没有 localStorage 那 5MB 的上限。<br />
                        但库文件只在这台机器上：<b>要换设备或留存档，仍然请导出成 JSON 文件</b>。
                        导出格式跟旧版完全一致，两边可以互相导入。
                    </p>

                    <div className="bk-section">
                        <h4><i className="fas fa-box-archive" /> 现在存了什么</h4>
                        <div className="bk-list">
                            <div className="bk-summary">
                                数据库里存了 <b>{tables.length}</b> 张表，正文共 <b>{fmtSize(totalBytes)}</b>
                            </div>
                            <table className="bk-table">
                                <tbody>
                                    <tr><th>表名</th><th>结构</th><th>大小</th></tr>
                                    {tables.map((t) => (
                                        <tr key={t.id} className={t.id === currentId ? 'cur' : undefined}>
                                            <td>
                                                {t.name}
                                                {t.id === currentId && <span className="bk-cur">当前</span>}
                                            </td>
                                            <td>{t.cols} 列 × {t.rows} 行</td>
                                            <td>{fmtSize(t.bytes)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {/* 直接走接口下载，服务端从库里现读现拼，文件名与 Content-Disposition
                            都由后端给，不经过前端内存 */}
                        <button
                            type="button"
                            className="primary bk-export"
                            onClick={() => { window.location.href = '/api/backup'; }}
                        >
                            <i className="fas fa-download" /> 导出全部表格为 JSON
                        </button>
                    </div>

                    <div className="bk-section">
                        <h4><i className="fas fa-upload" /> 从备份文件恢复</h4>
                        <div className="modal-row">
                            <label className="file-pick">
                                <input ref={fileRef} type="file" accept=".json,application/json" onChange={pickFile} />
                                <i className="fas fa-folder-open" /> 选择备份 .json
                            </label>
                            <div className="modal-modes">
                                <label>
                                    <input
                                        type="radio"
                                        name="backup-mode"
                                        checked={mode === 'merge'}
                                        onChange={() => setMode('merge')}
                                    /> 追加到现有表后面
                                </label>
                                <label>
                                    <input
                                        type="radio"
                                        name="backup-mode"
                                        checked={mode === 'replace'}
                                        onChange={() => setMode('replace')}
                                    /> 覆盖全部
                                </label>
                            </div>
                        </div>

                        <div className="bk-list">
                            {!pending && (
                                <p className="bk-hint">选择一个备份文件后，这里会显示它里面有什么。</p>
                            )}
                            {pending && !pending.ok && (
                                <p className="bk-bad"><i className="fas fa-circle-xmark" /> {pending.error}</p>
                            )}
                            {pending?.ok && pending.tables && (
                                <>
                                    <p className="bk-ok">
                                        <i className="fas fa-circle-check" /> 识别到 <b>{pending.tables.length}</b> 张表
                                        {pending.exportedAt && (
                                            <span className="bk-quota">
                                                　备份于 {pending.exportedAt.slice(0, 16).replace('T', ' ')}
                                            </span>
                                        )}
                                    </p>
                                    <table className="bk-table">
                                        <tbody>
                                            <tr><th>表名</th><th>结构</th></tr>
                                            {pending.tables.slice(0, 12).map((t, i) => (
                                                <tr key={i}>
                                                    <td>{t.name}</td>
                                                    <td>{t.cols} 列 × {t.rows} 行</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {pending.tables.length > 12 && (
                                        <p className="bk-hint">…另有 {pending.tables.length - 12} 张未列出</p>
                                    )}
                                    {!!pending.warnings?.length && (
                                        <p className="bk-warn">
                                            <i className="fas fa-triangle-exclamation" /> {pending.warnings.join('；')}
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>

                <div className="modal-foot">
                    <button type="button" onClick={onClose}>关闭</button>
                    <button
                        type="button"
                        className="primary"
                        disabled={!pending?.ok || busy}
                        onClick={confirmRestore}
                    >
                        <i className={busy ? 'fas fa-spinner fa-spin' : 'fas fa-check'} /> 恢复
                    </button>
                </div>
            </div>
        </div>
    );
}
