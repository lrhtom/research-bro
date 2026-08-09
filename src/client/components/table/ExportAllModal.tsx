// ============================================================
//  批量导出：把多张表一次性打成一个 ZIP
//
//  PNG 那一路必须**真的把表格渲染到页面上**才能截图（html2canvas 只认
//  实际布局），所以这里在屏幕外挂一个跟编辑区一模一样的 .table-wrapper，
//  一张一张灌 HTML、截图、再灌下一张。宽度写死成固定值 ——
//  不然导出结果会跟当时侧栏收没收、窗口多宽有关，同一批表出来的图会不一样宽。
//
//  逐张处理而不是并发：html2canvas 很吃内存，几十张表同时渲染容易直接把
//  标签页顶爆；串行慢一点，但有确定的进度可以显示，也能中途取消。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGetTable } from '@/lib/api';
import * as T from '@/lib/table-dom';
import { dedupeNames, downloadBlob, makeZip, safeEntryName, type ZipEntry } from '@/lib/zip';
import type { TableSummary } from '../../../shared/types';

/**
 * 屏幕外渲染台的兜底宽度。
 *
 * 正常情况下走的是外面传进来的 renderWidth —— 也就是**单张导出时
 * 编辑区那块 .table-wrapper 的实际宽度**。两边必须一样宽，否则同一张表
 * 单独导和批量导会在不同位置折行，出来的图对不上（这就是「导出有偏移」）。
 */
const FALLBACK_WIDTH = 930;

/**
 * 等浏览器把刚灌进去的表格排完版。
 *
 * 不能只等 requestAnimationFrame：**标签页切到后台时 rAF 根本不触发**，
 * 导出会永远停在第一张上（切走泡杯茶回来发现进度条还是 0，就是这个原因）。
 * 所以让 rAF 和一个定时器赛跑，谁先到都往下走。
 */
function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        requestAnimationFrame(() => requestAnimationFrame(done));
        setTimeout(done, 40);
    });
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Format = 'png' | 'md' | 'both';

/** 进度里正在干的事 —— 只报「渲染」和「打包」两段，够用且不啰嗦 */
type Phase = '' | 'render' | 'zip';

interface Props {
    open: boolean;
    onClose: () => void;
    /** true = 从「导出全部」进来的，打开即自动全选开跑，不用再点一次 */
    autoStart?: boolean;
    tables: TableSummary[];
    /** 当前这张表的最新 HTML —— 它可能还没存回库里，要用内存里的版本 */
    liveHtml: (id: string) => string | null;
    /** 单张导出时编辑区的实际渲染宽度。批量必须用同一个值，两边才对得上。 */
    measureWidth: () => number;
    exportScale: number;
    includeCaption: boolean;
    onNotify: (msg: string, icon?: string) => void;
}

export default function ExportAllModal({
    open, onClose, autoStart = false, tables, liveHtml, measureWidth,
    exportScale, includeCaption, onNotify,
}: Props) {
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [format, setFormat] = useState<Format>('png');
    const [scale, setScale] = useState(exportScale);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(0);
    const [current, setCurrent] = useState('');
    const [phase, setPhase] = useState<Phase>('');
    /** 已经打进包里的文件数 —— 「两者都要」时它会是表数的两倍 */
    const [madeFiles, setMadeFiles] = useState(0);
    /** 已产出的字节数，导出时能直观看到包在变大 */
    const [madeBytes, setMadeBytes] = useState(0);
    const [failedNames, setFailedNames] = useState<string[]>([]);
    const cancelRef = useRef(false);
    const runRef = useRef<(ids: string[]) => Promise<void>>(null);

    // 每次打开都重置进度与选择；**格式和分辨率不重置** ——
    // 那两个是用户的偏好，连着导好几批时不该每次都被拨回默认值
    useEffect(() => {
        if (!open) return;
        setPicked(new Set(tables.map((t) => t.id)));
        setBusy(false);
        setDone(0);
        setCurrent('');
        setPhase('');
        setMadeFiles(0);
        setMadeBytes(0);
        setFailedNames([]);
        cancelRef.current = false;
    }, [open, tables]);

    // 「导出全部」：打开就跑，不等用户再点一次按钮
    useEffect(() => {
        if (!open || !autoStart || tables.length === 0) return;
        const ids = tables.map((t) => t.id);
        // 等一拍，让上面那个重置的 effect 先跑完
        const t = window.setTimeout(() => { void runRef.current?.(ids); }, 0);
        return () => window.clearTimeout(t);
    }, [open, autoStart, tables]);

    // Esc 关闭（捕获阶段，抢在编辑器快捷键之前）；导出中不许关
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            if (busy) cancelRef.current = true;
            else onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [open, busy, onClose]);

    const toggle = useCallback((id: string) => {
        setPicked((cur) => {
            const next = new Set(cur);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const run = useCallback(async (ids: string[]) => {
        const list = tables.filter((t) => ids.includes(t.id));
        if (list.length === 0) return;

        setBusy(true);
        setDone(0);
        setMadeFiles(0);
        setMadeBytes(0);
        setFailedNames([]);
        setPhase('render');
        cancelRef.current = false;

        // 屏幕外的渲染台。位置放到视口外而不是 display:none ——
        // 不参与布局的元素 html2canvas 量不到尺寸，会截出空白图。
        //
        // 宽度必须跟单张导出时一致：宽度不同 → 单元格折行位置不同 →
        // 同一张表两条路导出来的图不一样，看着就是「偏移」。
        const width = Math.max(320, Math.round(measureWidth()) || FALLBACK_WIDTH);
        const stage = document.createElement('div');
        // is-exporting 跟单张导出用的是同一个类：去掉圆角与投影，
        // 保证两条路渲染出来的是同一张图
        stage.className = 'table-wrapper is-exporting';
        stage.style.cssText = `position: fixed; left: -99999px; top: 0; width: ${width}px;`;
        document.body.appendChild(stage);

        const entries: ZipEntry[] = [];
        const wantPng = format === 'png' || format === 'both';
        const wantMd = format === 'md' || format === 'both';
        const failed: string[] = [];

        try {
            const html2canvas = wantPng ? (await import('html2canvas')).default : null;

            for (const t of list) {
                if (cancelRef.current) break;
                setCurrent(t.name);

                try {
                    // 当前正在编辑的那张用内存里的最新 HTML，其余的从库里取
                    const html = liveHtml(t.id) ?? (await apiGetTable(t.id)).html;
                    stage.innerHTML = html;

                    const caption = stage.querySelector('caption') as HTMLElement | null;
                    if (caption && !includeCaption) caption.style.display = 'none';

                    const base = safeEntryName(t.name, '未命名表格');

                    if (wantMd) {
                        const table = stage.querySelector('table') as HTMLTableElement | null;
                        if (table) {
                            const data = new TextEncoder().encode(T.tableToMarkdown(table));
                            entries.push({ name: `markdown/${base}.md`, data });
                            setMadeFiles((n) => n + 1);
                            setMadeBytes((n) => n + data.length);
                        }
                    }

                    if (wantPng && html2canvas) {
                        // 让浏览器把这一张真正排完版再截图
                        await nextFrame();
                        const canvas = await html2canvas(stage, {
                            scale,
                            backgroundColor: '#ffffff',
                            useCORS: true,
                            logging: false,
                            imageTimeout: 0,
                        });
                        if (!canvas.width || !canvas.height) throw new Error('画布为空');
                        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
                        if (!blob) throw new Error('转 PNG 失败');
                        const data = new Uint8Array(await blob.arrayBuffer());
                        entries.push({ name: `png/${base}@${scale}x.png`, data });
                        setMadeFiles((n) => n + 1);
                        setMadeBytes((n) => n + data.length);
                    }
                } catch (err) {
                    // 单张失败不该让整批白跑 —— 记下来，最后一起报
                    console.error('导出失败：' + t.name, err);
                    failed.push(t.name);
                    setFailedNames((f) => [...f, t.name]);
                }

                setDone((n) => n + 1);
            }

            if (cancelRef.current) { onNotify('已取消导出'); return; }
            if (entries.length === 0) { onNotify('没有导出任何内容', 'fa-circle-exclamation'); return; }

            // 打包这一步在大批量下也要好几百毫秒，单独报一段状态，
            // 免得进度条走满之后界面看着像卡住了
            setPhase('zip');
            setCurrent('');
            await new Promise((r) => setTimeout(r, 16));   // 让这一帧先画出来

            // 同名的表会互相覆盖，打包前统一去重
            const names = dedupeNames(entries.map((e) => e.name));
            entries.forEach((e, i) => { e.name = names[i]; });

            const stamp = new Date().toISOString().slice(0, 10);
            downloadBlob(makeZip(entries), `学术三线表_${list.length}张_${stamp}.zip`);

            onNotify(
                failed.length
                    ? `导出完成，${failed.length} 张失败：${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}`
                    : `已打包 ${entries.length} 个文件`,
                failed.length ? 'fa-circle-exclamation' : 'fa-check-circle',
            );
            if (!failed.length) onClose();
        } catch (err) {
            console.error('批量导出失败', err);
            onNotify(err instanceof Error ? err.message : '批量导出失败', 'fa-circle-exclamation');
        } finally {
            stage.remove();
            setBusy(false);
            setCurrent('');
            setPhase('');
        }
    }, [tables, format, scale, includeCaption, liveHtml, measureWidth, onNotify, onClose]);

    // 给「导出全部」那条自动启动的路子用（effect 里拿不到最新的 run）
    runRef.current = run;

    if (!open) return null;

    const all = picked.size === tables.length;
    const fileCount = picked.size * (format === 'both' ? 2 : 1);

    return (
        <div
            className="modal-mask show"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
        >
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-all-title">
                <div className="modal-head">
                    <h3 id="export-all-title"><i className="fas fa-file-zipper" /> 批量导出</h3>
                    <button type="button" className="icon-btn" onClick={onClose} disabled={busy} title="关闭">
                        <i className="fas fa-times" />
                    </button>
                </div>

                <div className="modal-body">
                    <p className="modal-hint">
                        选中的表会各自渲染一遍，打包成一个 <code>.zip</code> 下载。
                        PNG 用<b>跟单张导出完全相同的宽度</b>渲染，所以同一张表两条路
                        导出来的图是一样的。表数量多时会慢，可以随时取消。
                    </p>

                    {/* ---------- 格式 ---------- */}
                    <div className="modal-modes">
                        <label>
                            <input type="radio" name="exp-fmt" checked={format === 'png'}
                                   onChange={() => setFormat('png')} disabled={busy} />
                            <span><b>高清 PNG</b><em>每张表一张图</em></span>
                        </label>
                        <label>
                            <input type="radio" name="exp-fmt" checked={format === 'md'}
                                   onChange={() => setFormat('md')} disabled={busy} />
                            <span><b>Markdown</b><em>纯文本表格</em></span>
                        </label>
                        <label>
                            <input type="radio" name="exp-fmt" checked={format === 'both'}
                                   onChange={() => setFormat('both')} disabled={busy} />
                            <span><b>两者都要</b><em>分 png / markdown 两个目录</em></span>
                        </label>
                    </div>

                    {format !== 'md' && (
                        <div className="exp-scale">
                            <label htmlFor="exp-scale-sel">PNG 分辨率</label>
                            <select
                                id="exp-scale-sel"
                                value={scale}
                                onChange={(e) => setScale(Number(e.target.value))}
                                disabled={busy}
                            >
                                <option value={2}>2× 屏幕阅读</option>
                                <option value={4}>4× 一般印刷</option>
                                <option value={6}>6× 期刊（推荐）</option>
                                <option value={8}>8× 超高清</option>
                            </select>
                            <span className="u-muted">倍率越高越慢，也越吃内存</span>
                        </div>
                    )}

                    {/* ---------- 选表 ---------- */}
                    <div className="exp-pick-head">
                        <b>选择表格</b>
                        <span className="u-muted u-num">{picked.size} / {tables.length}</span>
                        <button
                            type="button"
                            className="exp-toggle-all"
                            onClick={() => setPicked(all ? new Set() : new Set(tables.map((t) => t.id)))}
                            disabled={busy}
                        >
                            {all ? '全不选' : '全选'}
                        </button>
                    </div>

                    <ul className="exp-list">
                        {tables.map((t) => (
                            <li key={t.id}>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={picked.has(t.id)}
                                        onChange={() => toggle(t.id)}
                                        disabled={busy}
                                    />
                                    <span className="exp-name">{t.name}</span>
                                    <span className="exp-meta u-num">{t.rows}×{t.cols}</span>
                                </label>
                            </li>
                        ))}
                    </ul>

                    {busy && (
                        <div className="exp-progress">
                            <div className="u-bar">
                                <div
                                    className="u-bar-fill"
                                    style={{ width: `${(done / Math.max(1, picked.size)) * 100}%` }}
                                />
                            </div>

                            <div className="exp-progress-line">
                                <i className="fas fa-spinner fa-spin" />
                                {phase === 'zip' ? (
                                    <span>正在打包 ZIP…</span>
                                ) : (
                                    <>
                                        <span className="exp-progress-count u-num">
                                            {done} / {picked.size}
                                        </span>
                                        <span className="exp-progress-name">{current || '准备中…'}</span>
                                    </>
                                )}
                                <span className="exp-progress-pct u-num">
                                    {Math.round((done / Math.max(1, picked.size)) * 100)}%
                                </span>
                            </div>

                            {/* 已产出多少、失败几张 —— 让人知道它真的在动，而不是卡了 */}
                            <p className="exp-progress-sub u-muted">
                                已生成 <b className="u-num">{madeFiles}</b> 个文件
                                {madeBytes > 0 && <> · <span className="u-num">{fmtBytes(madeBytes)}</span></>}
                                {failedNames.length > 0 && (
                                    <span className="exp-progress-fail">
                                        {' '}· 失败 <b className="u-num">{failedNames.length}</b> 张
                                    </span>
                                )}
                            </p>
                        </div>
                    )}
                </div>

                <div className="modal-foot">
                    {busy ? (
                        <button type="button" onClick={() => { cancelRef.current = true; }}>
                            <i className="fas fa-stop" /> 取消导出
                        </button>
                    ) : (
                        <>
                            <button type="button" onClick={onClose}>关闭</button>
                            <button
                                type="button"
                                className="primary"
                                onClick={() => void run([...picked])}
                                disabled={picked.size === 0}
                            >
                                <i className="fas fa-file-zipper" />
                                {picked.size === 0
                                    ? ' 先选几张表'
                                    : ` 导出 ${picked.size} 张（${fileCount} 个文件）`}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
