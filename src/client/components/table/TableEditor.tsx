// ============================================================
//  学术三线表编辑器
//
//  编辑区是一块 contenteditable 的 <table>，React 只负责「什么时候把 HTML
//  灌进去、什么时候读出来存库」，中间的增删行列、区域选择、样式统一全部走
//  真实 DOM（见 src/lib/table-dom.ts）。这是刻意的：受控化会毁掉光标位置、
//  富文本粘贴和 html2canvas 的一比一还原。
//
//  跟旧版最大的差别是持久化：localStorage → 本机 SQLite。
//  打字防抖 700ms 存一次，结构/样式操作立即存，Ctrl+S 手动存，
//  切表和关页面前强制冲一次。
// ============================================================

import { Link } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as T from '@/lib/table-dom';
import { apiCreateTable, apiDeleteTable, apiGetTable, apiSaveTable, apiSetSetting } from '@/lib/api';
import { mdTableName, mdTableToHtml, mdToPlainText, type MdTable } from '@/lib/markdown-table';
import type { TableFull, TableSummary } from '../../../shared/types';
import MdImportModal, { type MdImportMode } from './MdImportModal';
import BackupModal from './BackupModal';
import ExportAllModal from './ExportAllModal';

// 浏览器画布硬上限：Chrome / Safari 桌面版约为单边 16384、总面积 16384²。
// 超过就会得到一张全空白的图，所以导出前必须按表格实际尺寸夹一次。
const CANVAS_MAX_SIDE = 16384;
const CANVAS_MAX_AREA = 16384 * 16384;
const MAX_HISTORY = 50;
const EXPORT_SCALE_KEY = 'export_scale';
const LAST_TABLE_KEY = 'last_table_id';

const SCALE_OPTIONS = [
    { v: 2, label: '2× 草稿' },
    { v: 3, label: '3× 标准' },
    { v: 4, label: '4× 清晰' },
    { v: 6, label: '6× 期刊（推荐）' },
    { v: 8, label: '8× 超清' },
    { v: 10, label: '10× 极限' },
    { v: 12, label: '12× 榨干浏览器' },
];

function byteLen(s: string): number {
    return new TextEncoder().encode(s).length;
}

function summarize(t: TableFull): TableSummary {
    return {
        id: t.id,
        name: t.name,
        caption: t.caption,
        rows: t.rows,
        cols: t.cols,
        bytes: byteLen(t.html) + byteLen(t.name),
        updatedAt: t.updatedAt,
    };
}

interface Props {
    initialTables: TableSummary[];
    initialTable: TableFull;
    initialExportScale: number;
}

export default function TableEditor({ initialTables, initialTable, initialExportScale }: Props) {
    // ---------- React 状态（只放会影响渲染的东西）----------
    const [tables, setTables] = useState<TableSummary[]>(initialTables);
    const [currentId, setCurrentId] = useState(initialTable.id);
    const [name, setName] = useState(initialTable.name);
    const [toast, setToast] = useState<{ msg: string; icon: string } | null>(null);
    const [collapsed, setCollapsed] = useState(false);
    const [scale, setScale] = useState(initialExportScale);
    const [includeCaption, setIncludeCaption] = useState(true);
    const [hint, setHint] = useState({ text: '', title: '' });
    const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
    const [mdOpen, setMdOpen] = useState(false);
    const [bkOpen, setBkOpen] = useState(false);
    const [expOpen, setExpOpen] = useState(false);
    /** true = 「导出全部」那颗按钮进来的，弹窗打开即自动开跑 */
    const [expAuto, setExpAuto] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportingMd, setExportingMd] = useState(false);
    /** 侧栏里被截断的图表名，鼠标停上去在右侧浮出全名 */
    const [nameTip, setNameTip] = useState<{ text: string; x: number; y: number } | null>(null);
    const [sel, setSel] = useState({
        active: false,
        fontSize: 16,
        padding: 14,
        lineHeight: 1.5,
        fontFamily: "'Times New Roman', Times, serif",
    });

    // ---------- 可变引用（事件闭包里读写，不触发渲染）----------
    const wrapRef = useRef<HTMLDivElement>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    const tipTimer = useRef<number | null>(null);

    /**
     * 侧栏图表名的浮层提示。
     *
     * 只在**真的被截断**时才弹（scrollWidth > clientWidth）——
     * 名字本来就显示得全的行，再浮一层出来纯属打扰。
     *
     * 用 position: fixed 是因为侧栏是 overflow:hidden 的，
     * absolute 的浮层会被裁掉；fixed 不受祖先 overflow 影响。
     */
    const showNameTip = useCallback((el: HTMLElement, text: string) => {
        if (el.scrollWidth <= el.clientWidth) return;   // 没截断就不弹
        if (tipTimer.current) window.clearTimeout(tipTimer.current);
        const r = el.getBoundingClientRect();
        // 略微延迟：鼠标扫过一整列时不该一路闪出十几个浮层
        tipTimer.current = window.setTimeout(() => {
            setNameTip({ text, x: r.right + 10, y: r.top + r.height / 2 });
        }, 220);
    }, []);

    const hideNameTip = useCallback(() => {
        if (tipTimer.current) window.clearTimeout(tipTimer.current);
        tipTimer.current = null;
        setNameTip(null);
    }, []);

    // 列表一滚动，浮层的位置就过时了 —— 直接收掉，别让它停在半空
    useEffect(() => {
        if (!nameTip) return;
        const drop = () => hideNameTip();
        window.addEventListener('scroll', drop, true);
        window.addEventListener('resize', drop);
        return () => {
            window.removeEventListener('scroll', drop, true);
            window.removeEventListener('resize', drop);
        };
    }, [nameTip, hideNameTip]);

    // 首屏内容交给 SSR，避免白闪；之后编辑区一律由 innerHTML 命令式接管。
    //
    // 这个对象必须是**同一个引用**，不能每次渲染现写 {{ __html: ... }}：
    // React 的属性 diff 按引用比较，字面量每次都是新对象 → 每次重渲染都会
    // 重新 setInnerHTML，把用户的选区、光标乃至刚敲进去的内容整片冲掉。
    const initialHtmlProp = useRef({ __html: initialTable.html });

    const idRef = useRef(currentId);
    const nameRef = useRef(name);
    const scaleRef = useRef(scale);
    const modalOpenRef = useRef(false);

    const activeRef = useRef<HTMLElement[]>([]);
    const anchorRef = useRef<HTMLElement | null>(null);
    const dragStartRef = useRef<HTMLElement | null>(null);

    const historyRef = useRef<{ stack: string[]; index: number; paused: boolean }>({
        stack: [], index: -1, paused: false,
    });

    const inputTimer = useRef<number | null>(null);
    const saveTimer = useRef<number | null>(null);
    const styleTimer = useRef<number | null>(null);
    const toastTimer = useRef<number | null>(null);
    const dirtyRef = useRef(false);
    const sizeCacheRef = useRef<{ liveW: number; liveH: number; w: number; h: number } | null>(null);

    idRef.current = currentId;
    nameRef.current = name;
    scaleRef.current = scale;
    modalOpenRef.current = mdOpen || bkOpen;

    // ---------- 基础工具 ----------

    const notify = useCallback((msg: string, icon = 'fa-info-circle') => {
        setToast({ msg, icon });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), 1800);
    }, []);

    const getTableEl = useCallback(
        () => (wrapRef.current?.querySelector('table') as HTMLTableElement | null),
        [],
    );

    /** 根据当前选中单元格刷新样式工具栏显示 */
    const updateToolbar = useCallback(() => {
        const els = activeRef.current;
        if (!els.length) {
            setSel((s) => ({ ...s, active: false }));
            return;
        }
        const cs = window.getComputedStyle(els[0]);

        // 边距：0 也要如实显示，不能被 || 当成假值
        const padTop = Math.round(parseFloat(cs.paddingTop));

        let lineHeight = 1.5;
        if (cs.lineHeight !== 'normal') {
            const lhPx = parseFloat(cs.lineHeight);
            const fsPx = parseFloat(cs.fontSize);
            if (lhPx && fsPx) lineHeight = parseFloat((lhPx / fsPx).toFixed(1));
        }

        const ff = cs.fontFamily.toLowerCase();
        const fontFamily = ff.includes('calibri') ? 'Calibri, sans-serif'
            : ff.includes('arial') ? 'Arial, sans-serif'
                : "'Times New Roman', Times, serif";

        setSel({
            active: true,
            fontSize: Math.round(parseFloat(cs.fontSize)),
            padding: Number.isNaN(padTop) ? 14 : padTop,
            lineHeight,
            fontFamily,
        });
    }, []);

    const clearSelection = useCallback(() => {
        activeRef.current.forEach((el) => { if (el.isConnected) el.classList.remove('selected-cell'); });
        activeRef.current = [];
        anchorRef.current = null;
        updateToolbar();
    }, [updateToolbar]);

    /** 从 activeElements 里剔掉已经脱离 DOM 的僵尸引用 */
    const pruneActive = useCallback(() => {
        activeRef.current = activeRef.current.filter((el) => el.isConnected);
        updateToolbar();
    }, [updateToolbar]);

    const setSingleSelection = useCallback((cell: HTMLElement) => {
        activeRef.current.forEach((el) => { if (el.isConnected) el.classList.remove('selected-cell'); });
        activeRef.current = [cell];
        cell.classList.add('selected-cell');
        updateToolbar();
    }, [updateToolbar]);

    /** 选中 anchor→target 的矩形区域（跨表头/表体，caption 除外）*/
    const selectRange = useCallback((anchor: HTMLElement, target: HTMLElement) => {
        if (anchor.tagName === 'CAPTION' || target.tagName === 'CAPTION') {
            setSingleSelection(target);
            return;
        }
        const allRows = T.getAllRows(getTableEl());
        const a = {
            r: allRows.indexOf(anchor.parentElement as HTMLTableRowElement),
            c: (anchor as HTMLTableCellElement).cellIndex,
        };
        const b = {
            r: allRows.indexOf(target.parentElement as HTMLTableRowElement),
            c: (target as HTMLTableCellElement).cellIndex,
        };
        if (a.r < 0 || b.r < 0) return;

        const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
        const c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);

        activeRef.current.forEach((el) => { if (el.isConnected) el.classList.remove('selected-cell'); });
        activeRef.current = [];
        for (let r = r1; r <= r2; r++) {
            const cells = allRows[r].children;
            for (let c = c1; c <= c2 && c < cells.length; c++) {
                (cells[c] as HTMLElement).classList.add('selected-cell');
                activeRef.current.push(cells[c] as HTMLElement);
            }
        }
        updateToolbar();
    }, [getTableEl, setSingleSelection, updateToolbar]);

    /** 取当前应操作的单元格：优先编辑焦点，其次选中的第一个 */
    const getCurrentCell = useCallback((): HTMLTableCellElement | null => {
        const ae = document.activeElement as HTMLElement | null;
        if (ae && (ae.tagName === 'TD' || ae.tagName === 'TH') && wrapRef.current?.contains(ae)) {
            return ae as HTMLTableCellElement;
        }
        return (activeRef.current.find((el) => el.tagName === 'TD' || el.tagName === 'TH')
            ?? null) as HTMLTableCellElement | null;
    }, []);

    /** 当前可编辑目标：单元格或表题（表题也允许格内换行）*/
    const getCurrentEditable = useCallback((): HTMLElement | null => {
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae.tagName === 'CAPTION' && wrapRef.current?.contains(ae)) return ae;
        return getCurrentCell() ?? activeRef.current.find((el) => el.tagName === 'CAPTION') ?? null;
    }, [getCurrentCell]);

    const focusCell = useCallback((cell: HTMLElement, selectAll: boolean) => {
        T.placeCaret(cell, selectAll);
        setSingleSelection(cell);
        anchorRef.current = cell;
    }, [setSingleSelection]);

    // ---------- 导出尺寸提示 ----------

    /** 给定 CSS 尺寸，在不超出画布上限的前提下最多能放大多少倍 */
    const maxSafeScale = useCallback((width: number, height: number) => {
        const w = Math.max(width, 1);
        const h = Math.max(height, 1);
        const bySide = Math.min(CANVAS_MAX_SIDE / w, CANVAS_MAX_SIDE / h);
        const byArea = Math.sqrt(CANVAS_MAX_AREA / (w * h));
        // 向下取到两位小数，避免浮点误差顶到上限
        return Math.max(1, Math.floor(Math.min(bySide, byArea) * 100) / 100);
    }, []);

    /**
     * 导出前会先收起侧边栏，表格因此变宽（换行变少还可能变矮）。
     * 这里瞬时收一下量出真实导出尺寸再还原 —— 同一个任务内完成，不会闪。
     * 按当前可见尺寸做缓存：宽度没变就不重测，避免每次操作都强制重排。
     */
    const measureExportSize = useCallback(() => {
        const wrap = wrapRef.current;
        const sidebar = sidebarRef.current;
        if (!wrap) return { w: 1, h: 1 };

        const live = { w: wrap.offsetWidth, h: wrap.offsetHeight };
        if (!sidebar || sidebar.classList.contains('collapsed')) return live;

        const c = sizeCacheRef.current;
        if (c && c.liveW === live.w && c.liveH === live.h) return { w: c.w, h: c.h };

        const prevTransition = sidebar.style.transition;
        sidebar.style.transition = 'none';
        sidebar.classList.add('collapsed');
        const w = wrap.offsetWidth;
        const h = wrap.offsetHeight;
        sidebar.classList.remove('collapsed');
        void sidebar.offsetWidth;
        sidebar.style.transition = prevTransition;

        sizeCacheRef.current = { liveW: live.w, liveH: live.h, w, h };
        return { w, h };
    }, []);

    /** 刷新「输出 W × H px」提示；同时返回夹过上限后的实际倍率 */
    const updateSizeHint = useCallback(() => {
        if (!wrapRef.current) return scaleRef.current;
        const size = measureExportSize();
        const requested = scaleRef.current;
        const s = Math.min(requested, maxSafeScale(size.w, size.h));
        const w = Math.round(size.w * s);
        const h = Math.round(size.h * s);
        setHint({
            text: `${w} × ${h} px · ${(w * h / 1e6).toFixed(1)} MP`,
            title: s < requested
                ? `${requested}× 会超出浏览器画布上限（单边 ${CANVAS_MAX_SIDE} px），已自动降到 ${s}×`
                : '导出尺寸（导出时会自动收起侧边栏，表格按最大宽度渲染）',
        });
        return s;
    }, [maxSafeScale, measureExportSize]);

    // ---------- 历史（HTML 快照栈）----------

    const pushHistory = useCallback(() => {
        // 表格结构/样式一变，导出尺寸提示就得跟着变（放在 paused 判断之前）
        updateSizeHint();

        const h = historyRef.current;
        if (h.paused) return;
        const wrap = wrapRef.current;
        if (!wrap) return;

        // 拍快照前先移除选中高亮，保持快照干净
        const live = activeRef.current.filter((el) => el.isConnected);
        live.forEach((el) => el.classList.remove('selected-cell'));
        const snapshot = wrap.innerHTML;
        live.forEach((el) => el.classList.add('selected-cell'));

        // 若之前 undo 过，截断后面的记录
        if (h.index < h.stack.length - 1) h.stack = h.stack.slice(0, h.index + 1);
        // 避免连续压入完全相同的快照
        if (h.stack.length > 0 && h.stack[h.stack.length - 1] === snapshot) return;

        h.stack.push(snapshot);
        if (h.stack.length > MAX_HISTORY) h.stack.shift();
        h.index = h.stack.length - 1;
    }, [updateSizeHint]);

    // ---------- 持久化 ----------

    const saveNow = useCallback(async (showToast: boolean) => {
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        const wrap = wrapRef.current;
        if (!wrap) return;

        // 选中高亮是纯 UI 状态，不该被存进库
        const live = activeRef.current.filter((el) => el.isConnected);
        live.forEach((el) => el.classList.remove('selected-cell'));
        const html = wrap.innerHTML;
        live.forEach((el) => el.classList.add('selected-cell'));

        dirtyRef.current = false;
        try {
            const saved = await apiSaveTable(idRef.current, { name: nameRef.current, html });
            const s = summarize(saved);
            setTables((list) => list.map((t) => (t.id === s.id ? s : t)));
            if (showToast) notify('保存成功', 'fa-check-circle');
        } catch (err) {
            dirtyRef.current = true;                      // 存失败就留着脏标记，下次接着试
            notify(err instanceof Error ? err.message : '保存失败');
        }
    }, [notify]);

    /** 打字走 700ms 防抖；结构与样式操作传 0，立刻落库 */
    const scheduleSave = useCallback((delay = 700) => {
        dirtyRef.current = true;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => { void saveNow(false); }, delay);
    }, [saveNow]);

    /** 结构/样式类操作的统一收尾：提示 → 记历史 → 落库 → 该聚焦就聚焦 */
    const afterOp = useCallback((r: T.OpResult) => {
        if (r.notify) notify(r.notify);
        if (!r.changed) return;
        pushHistory();
        pruneActive();
        scheduleSave(0);
        if (r.focus) focusCell(r.focus, true);
    }, [focusCell, notify, pruneActive, pushHistory, scheduleSave]);

    /** 样式输入连续调整时防抖提交（避免每次按键都记一次快照、发一次请求）*/
    const commitStyleSoon = useCallback(() => {
        if (styleTimer.current) clearTimeout(styleTimer.current);
        styleTimer.current = window.setTimeout(() => {
            pushHistory();
            scheduleSave(0);
        }, 500);
    }, [pushHistory, scheduleSave]);

    const restoreSnapshot = useCallback((snapshot: string) => {
        historyRef.current.paused = true;
        clearSelection();
        if (wrapRef.current) wrapRef.current.innerHTML = snapshot;
        historyRef.current.paused = false;
        updateSizeHint();
        scheduleSave(0);      // 撤销/重做后即时写回，不然刷新会回到撤销前
    }, [clearSelection, scheduleSave, updateSizeHint]);

    const undo = useCallback(() => {
        const h = historyRef.current;
        if (h.index <= 0) return;
        h.index--;
        restoreSnapshot(h.stack[h.index]);
    }, [restoreSnapshot]);

    const redo = useCallback(() => {
        const h = historyRef.current;
        if (h.index >= h.stack.length - 1) return;
        h.index++;
        restoreSnapshot(h.stack[h.index]);
    }, [restoreSnapshot]);

    // ---------- 多表管理 ----------

    /** 把一张表的内容装进编辑区，并重置历史栈 */
    const applyTable = useCallback((t: TableFull) => {
        clearSelection();
        setCurrentId(t.id);
        idRef.current = t.id;
        setName(t.name);
        nameRef.current = t.name;
        if (wrapRef.current) wrapRef.current.innerHTML = t.html;

        historyRef.current = { stack: [], index: -1, paused: false };
        sizeCacheRef.current = null;
        dirtyRef.current = false;
        pushHistory();
        void apiSetSetting(LAST_TABLE_KEY, t.id);
    }, [clearSelection, pushHistory]);

    const switchTable = useCallback(async (id: string) => {
        if (id === idRef.current) return;
        if (dirtyRef.current) await saveNow(false);
        try {
            applyTable(await apiGetTable(id));
        } catch (err) {
            notify(err instanceof Error ? err.message : '加载表格失败');
        }
    }, [applyTable, notify, saveNow]);

    const createTable = useCallback(async (tableName = '新图表') => {
        if (dirtyRef.current) await saveNow(false);
        try {
            const t = await apiCreateTable(tableName);
            setTables((list) => [summarize(t), ...list]);
            applyTable(t);
        } catch (err) {
            notify(err instanceof Error ? err.message : '新建失败');
        }
    }, [applyTable, notify, saveNow]);

    const removeTable = useCallback(async (id: string) => {
        if (tables.length <= 1) {
            window.alert('至少需要保留一个表格！您可以选择清空里面的内容。');
            return;
        }
        if (!window.confirm('确定要删除这个图表吗？此操作不可撤销。')) return;

        try {
            await apiDeleteTable(id);
            const rest = tables.filter((t) => t.id !== id);
            setTables(rest);
            if (id === idRef.current) {
                dirtyRef.current = false;              // 删掉的表别再存回去
                applyTable(await apiGetTable(rest[0].id));
            }
            notify('已删除');
        } catch (err) {
            notify(err instanceof Error ? err.message : '删除失败');
        }
    }, [applyTable, notify, tables]);

    // ---------- 结构操作 ----------

    const withTable = useCallback((fn: (table: HTMLTableElement) => T.OpResult) => {
        const table = getTableEl();
        if (!table) return;
        afterOp(fn(table));
    }, [afterOp, getTableEl]);

    // ---------- 样式操作 ----------

    const applyFontFamily = useCallback((value: string) => {
        setSel((s) => ({ ...s, fontFamily: value }));
        activeRef.current.forEach((el) => {
            el.style.fontFamily = value;
            T.unifyCellStyle(el, 'font-family', 'face');   // 清掉子元素自带字体，整格统一
        });
        pushHistory();
        scheduleSave(0);
    }, [pushHistory, scheduleSave]);

    const applyFontSize = useCallback((value: number) => {
        setSel((s) => ({ ...s, fontSize: value }));
        if (Number.isNaN(value)) return;
        activeRef.current.forEach((el) => {
            el.style.fontSize = value + 'px';
            T.unifyCellStyle(el, 'font-size', 'size');     // 清掉子元素自带字号，整格统一
        });
        commitStyleSoon();
    }, [commitStyleSoon]);

    const applyPadding = useCallback((value: number) => {
        setSel((s) => ({ ...s, padding: value }));
        if (Number.isNaN(value)) return;
        activeRef.current.forEach((el) => {
            el.style.paddingTop = value + 'px';
            el.style.paddingBottom = value + 'px';
        });
        commitStyleSoon();
    }, [commitStyleSoon]);

    const applyLineHeight = useCallback((value: number) => {
        setSel((s) => ({ ...s, lineHeight: value }));
        if (Number.isNaN(value)) return;
        activeRef.current.forEach((el) => { el.style.lineHeight = String(value); });
        commitStyleSoon();
    }, [commitStyleSoon]);

    // ---------- 导出 ----------

    const exportScaleChange = useCallback((v: number) => {
        setScale(v);
        scaleRef.current = v;
        void apiSetSetting(EXPORT_SCALE_KEY, String(v));
        updateSizeHint();
    }, [updateSizeHint]);

    const exportToPNG = useCallback(async () => {
        const wrap = wrapRef.current;
        const sidebar = sidebarRef.current;
        if (!wrap) return;

        setExporting(true);
        const live = activeRef.current.filter((el) => el.isConnected);
        live.forEach((el) => el.classList.remove('selected-cell'));

        // 表题默认包含；仅当「导出含表题」开关关闭时才隐藏
        const caption = wrap.querySelector('caption') as HTMLElement | null;
        let originalCaptionDisplay = '';
        let captionHidden = false;
        if (caption && !includeCaption) {
            originalCaptionDisplay = caption.style.display;
            caption.style.display = 'none';
            captionHidden = true;
        }

        // 临时收起侧边栏，保证导出时表格达到最大宽度
        const wasSidebarOpen = !!sidebar && !sidebar.classList.contains('collapsed');
        if (wasSidebarOpen && sidebar) {
            sidebar.style.transition = 'none';
            sidebar.classList.add('collapsed');
            void sidebar.offsetWidth;                      // 强制重排
        }

        // 去掉圆角与投影：留着的话页面背景会从四角透进图里
        wrap.classList.add('is-exporting');

        let restored = false;
        const restore = () => {
            if (restored) return;                          // 重试链路上可能被调两次，做成幂等
            restored = true;
            wrap.classList.remove('is-exporting');
            if (captionHidden && caption) caption.style.display = originalCaptionDisplay;
            if (wasSidebarOpen && sidebar) {
                sidebar.classList.remove('collapsed');
                void sidebar.offsetWidth;
                sidebar.style.transition = '';
            }
        };

        // 侧边栏已收起并重排，这里量到的就是最终渲染尺寸
        const requested = scaleRef.current;
        const usable = Math.min(requested, maxSafeScale(wrap.offsetWidth, wrap.offsetHeight));
        if (usable < requested) notify(`${requested}× 会超出浏览器画布上限，已自动降到 ${usable}×`);

        const { default: html2canvas } = await import('html2canvas');

        const render = async (s: number) => {
            const canvas = await html2canvas(wrap, {
                scale: s,
                backgroundColor: '#ffffff',
                useCORS: true,
                logging: false,
                imageTimeout: 0,
            });
            // 超限时 html2canvas 不报错，只会给一张空画布 —— 得自己判出来
            if (!canvas || !canvas.width || !canvas.height) throw new Error('画布为空（可能超出浏览器上限）');
            return canvas;
        };

        const save = (canvas: HTMLCanvasElement, usedScale: number) => {
            const link = document.createElement('a');
            const safeName = nameRef.current.replace(/[/\\:*?"<>|]/g, '');
            link.download = `${safeName || '学术三线表'}_导出@${usedScale}x.png`;
            link.href = canvas.toDataURL('image/png');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            notify(`已导出 ${canvas.width} × ${canvas.height} px（${usedScale}×）`, 'fa-check-circle');
        };

        try {
            let canvas: HTMLCanvasElement;
            let used = usable;
            try {
                canvas = await render(usable);
            } catch {
                // 高倍率失败多半是显存/画布上限，自动降一半再试一次
                const fallback = Math.max(2, Math.floor(usable / 2));
                if (fallback >= usable) throw new Error('render failed');
                notify(`${usable}× 渲染失败，正在用 ${fallback}× 重试`);
                canvas = await render(fallback);
                used = fallback;
            }
            restore();
            save(canvas, used);
        } catch (err) {
            restore();
            console.error('导出图片失败', err);
            window.alert('导出图片失败。表格很大时请把「分辨率」调低一档再试。');
        } finally {
            live.forEach((el) => { if (el.isConnected) el.classList.add('selected-cell'); });
            setExporting(false);
            updateSizeHint();
        }
    }, [includeCaption, maxSafeScale, notify, updateSizeHint]);

    /**
     * 单张导出时表格实际有多宽。
     *
     * 批量导出要用同一个值 —— 宽度不一样，单元格折行的位置就不一样，
     * 同一张表两条路导出来的图会对不上（表现就是「导出有偏移」）。
     *
     * 跟 exportToPNG 一样，量之前先把侧栏收掉：单张导出就是在收起状态下渲染的。
     * 收 → 量 → 还原全在同一个任务里做完，中间不会有一帧闪。
     */
    const measureExportWidth = useCallback(() => {
        const wrap = wrapRef.current;
        const sidebar = sidebarRef.current;
        if (!wrap) return 0;

        const wasOpen = !!sidebar && !sidebar.classList.contains('collapsed');
        if (wasOpen && sidebar) {
            sidebar.style.transition = 'none';
            sidebar.classList.add('collapsed');
            void sidebar.offsetWidth;                  // 强制重排
        }
        const w = wrap.offsetWidth;
        if (wasOpen && sidebar) {
            sidebar.classList.remove('collapsed');
            void sidebar.offsetWidth;
            sidebar.style.transition = '';
        }
        return w;
    }, []);

    const exportToMarkdown = useCallback(() => {
        const table = getTableEl();
        if (!table) return;
        setExportingMd(true);
        try {
            const md = T.tableToMarkdown(table);
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const safeName = nameRef.current.replace(/[/\\:*?"<>|]/g, '');
            link.download = (safeName || '学术三线表') + '.md';
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('导出 Markdown 失败', err);
            window.alert('导出 Markdown 失败，请重试。');
        } finally {
            setExportingMd(false);
        }
    }, [getTableEl]);

    // ---------- Markdown 导入 ----------

    const confirmMdImport = useCallback(async (mdTables: MdTable[], mode: MdImportMode) => {
        setMdOpen(false);
        if (mdTables.length === 0) return;

        try {
            if (mode === 'replace') {
                const t = mdTables[0];
                const hasCaption = !!mdToPlainText(t.caption || '');
                const newName = hasCaption ? mdTableName(t, 1) : nameRef.current;

                clearSelection();
                if (wrapRef.current) {
                    wrapRef.current.innerHTML = mdTableToHtml(t, hasCaption ? t.caption : newName);
                }
                if (hasCaption) { setName(newName); nameRef.current = newName; }
                pushHistory();
                await saveNow(false);
                notify(mdTables.length > 1
                    ? `已替换当前表格（识别到 ${mdTables.length} 个，替换模式只用第 1 个）`
                    : '已替换当前表格');
                return;
            }

            // 倒序创建：每次插到列表头，最终第 1 个表格排在最前且处于激活状态
            let last: TableFull | null = null;
            const created: TableSummary[] = [];
            for (let i = mdTables.length - 1; i >= 0; i--) {
                const t = mdTables[i];
                const tableName = mdTableName(t, i + 1);
                last = await apiCreateTable(tableName, mdTableToHtml(t, t.caption || tableName));
                created.unshift(summarize(last));
            }
            // 服务端给新表的 sort_order 依次递减，所以最后建的排最前 —— 这里按同样顺序拼列表
            setTables((list) => [...created.slice().reverse(), ...list]);
            if (last) applyTable(last);
            notify(mdTables.length > 1 ? `已导入 ${mdTables.length} 个表格` : '已导入 1 个表格');
        } catch (err) {
            notify(err instanceof Error ? err.message : '导入失败');
        }
    }, [applyTable, clearSelection, notify, pushHistory, saveNow]);

    // ---------- 备份恢复 ----------

    const onRestored = useCallback(async (firstId: string, count: number, mode: 'merge' | 'replace') => {
        setBkOpen(false);
        dirtyRef.current = false;      // 覆盖模式下当前表可能已经没了，别再存回去
        try {
            const [list, first] = await Promise.all([
                fetch('/api/tables', { cache: 'no-store' })
                    .then((r) => r.json() as Promise<{ tables: TableSummary[] }>),
                apiGetTable(firstId),
            ]);
            setTables(list.tables);
            applyTable(first);
            notify(mode === 'replace' ? `已覆盖恢复 ${count} 张表` : `已追加 ${count} 张表`, 'fa-check-circle');
        } catch (err) {
            notify(err instanceof Error ? err.message : '恢复后刷新列表失败，请刷新页面');
        }
    }, [applyTable, notify]);

    // ---------- 事件：把最新的处理函数放进 ref，供只挂一次的全局监听调用 ----------

    const handlers = {
        clearSelection, getCurrentCell, getCurrentEditable, focusCell, selectRange,
        setSingleSelection, pushHistory, scheduleSave, saveNow, undo, redo, notify,
        updateToolbar, getTableEl, afterOp,
    };
    const hRef = useRef(handlers);
    hRef.current = handlers;

    // 首屏：把初始表的 HTML 记进历史栈，并算一次导出尺寸
    useEffect(() => {
        pushHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 全局监听只挂一次，内部一律通过 hRef 读最新逻辑，避免反复解绑重绑
    useEffect(() => {
        const h = () => hRef.current;

        // ---- 拖拽框选 ----
        const onMouseMove = (event: MouseEvent) => {
            if (!dragStartRef.current) return;
            const target = (event.target as HTMLElement)?.closest?.('td, th') as HTMLElement | null;
            if (!target || target === dragStartRef.current) return;
            if (dragStartRef.current.tagName === 'CAPTION' || target.tagName === 'CAPTION') return;
            window.getSelection()?.removeAllRanges();      // 抑制文本选区
            h().selectRange(dragStartRef.current, target);
        };

        const onMouseUp = () => { dragStartRef.current = null; };

        // ---- 点表格/工具栏/侧边栏/右键菜单之外 → 清除选中 ----
        const onDocMouseDown = (event: MouseEvent) => {
            const t = event.target as HTMLElement | null;
            if (!t || typeof t.closest !== 'function') return;
            if (!t.closest('.context-menu')) setCtx(null);
            if (!wrapRef.current?.contains(t)
                && !t.closest('.toolbar')
                && !t.closest('.sidebar-nav')
                && !t.closest('.modal-mask')
                && !t.closest('.context-menu')) {
                h().clearSelection();
            }
        };

        // ---- 复制选中区域为 TSV ----
        const onCopy = (event: ClipboardEvent) => {
            const ae = document.activeElement;
            // 焦点在输入框/文本域里（如导入弹窗）时不劫持，走原生复制
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
            // 单格或未选区域时走浏览器默认复制（复制格内文字）
            if (activeRef.current.length < 2) return;

            const cells = activeRef.current.filter((el) => el.tagName !== 'CAPTION');
            if (cells.length < 2) return;

            const allRows = T.getAllRows(h().getTableEl());
            const coords = cells.map((el) => ({
                r: allRows.indexOf(el.parentElement as HTMLTableRowElement),
                c: (el as HTMLTableCellElement).cellIndex,
            }));
            const r1 = Math.min(...coords.map((o) => o.r));
            const r2 = Math.max(...coords.map((o) => o.r));
            const c1 = Math.min(...coords.map((o) => o.c));
            const c2 = Math.max(...coords.map((o) => o.c));

            const lines: string[] = [];
            for (let r = r1; r <= r2; r++) {
                const rowCells = allRows[r].children;
                const vals: string[] = [];
                for (let c = c1; c <= c2; c++) {
                    const cell = rowCells[c] as HTMLElement | undefined;
                    vals.push(cell ? cell.innerText.replace(/\t/g, ' ').replace(/\n/g, ' ') : '');
                }
                lines.push(vals.join('\t'));
            }

            event.clipboardData?.setData('text/plain', lines.join('\n'));
            event.preventDefault();
            h().notify(`已复制 ${r2 - r1 + 1} 行 × ${c2 - c1 + 1} 列`);
        };

        // ---- 快捷键与单元格导航 ----
        const onKeyDown = (event: KeyboardEvent) => {
            const isCtrl = event.ctrlKey || event.metaKey;
            const ae = document.activeElement as HTMLElement | null;
            const inFormField = !!ae
                && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA');

            // 保存 (Ctrl + S) —— 全局有效
            if (isCtrl && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void h().saveNow(true);
                return;
            }

            if (modalOpenRef.current) return;          // 弹窗开着时把键盘让给弹窗
            // 焦点在表单控件里时，让出原生行为（撤销/全选/加粗等）
            if (inFormField) return;

            // 全选 (Ctrl + A)
            if (isCtrl && event.key.toLowerCase() === 'a') {
                if (activeRef.current.length === 1) return;   // 放行格内文字全选
                event.preventDefault();
                const table = h().getTableEl();
                if (table) {
                    const all = Array.from(table.querySelectorAll<HTMLElement>('td, th, caption'));
                    activeRef.current.forEach((el) => {
                        if (el.isConnected) el.classList.remove('selected-cell');
                    });
                    activeRef.current = all;
                    all.forEach((el) => el.classList.add('selected-cell'));
                    h().updateToolbar();
                }
                return;
            }

            if (isCtrl && event.key.toLowerCase() === 'b') {
                event.preventDefault(); h().afterOp(T.toggleBold(activeRef.current)); return;
            }
            if (isCtrl && event.key.toLowerCase() === 'i') {
                event.preventDefault(); h().afterOp(T.toggleItalic(activeRef.current)); return;
            }
            if (isCtrl && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                if (inputTimer.current) {          // 把待提交的输入快照先冲掉，否则撤销会少一步
                    clearTimeout(inputTimer.current);
                    inputTimer.current = null;
                    h().pushHistory();
                }
                h().undo();
                return;
            }
            if (isCtrl && event.key.toLowerCase() === 'y') { event.preventDefault(); h().redo(); return; }

            if (event.key === 'Escape') { h().clearSelection(); setCtx(null); return; }

            // ---- 以下为单元格导航 / 清空（不与 Ctrl 组合）----
            if (isCtrl) return;

            const cell = h().getCurrentCell();

            // Tab / Shift+Tab 换格；在最后一格按 Tab 自动新增一行（与 Word 表格一致）
            if (event.key === 'Tab') {
                if (!cell) return;
                event.preventDefault();
                const table = h().getTableEl();
                if (!table) return;
                let target = T.tabNavigate(table, cell, event.shiftKey);
                if (!target && !event.shiftKey) {
                    h().afterOp(T.appendEmptyRow(table));
                    target = T.tabNavigate(table, cell, false);
                }
                if (target) h().focusCell(target, true);
                return;
            }

            // Enter：格内换行 —— Word 里表格就是这个行为，本工具面向论文排版，跟 Word 对齐。
            // 跨格移动请用 Tab / 方向键。
            if (event.key === 'Enter') {
                const target = h().getCurrentEditable();
                if (!target) return;
                event.preventDefault();
                if (T.insertLineBreak(target)) {
                    // 手工兜底不会触发 input 事件，这里显式记一次历史，保证能撤销、能存住
                    h().pushHistory();
                    h().scheduleSave(0);
                }
                return;
            }

            // Delete / Backspace：多选时清空所有选中单元格
            if ((event.key === 'Delete' || event.key === 'Backspace') && activeRef.current.length >= 2) {
                event.preventDefault();
                h().afterOp(T.clearCells(activeRef.current));
                return;
            }

            // 方向键：光标到达文本边界时跨格
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                if (!cell) return;
                const info = T.caretInfo(cell);
                if (!info.collapsed) return;
                let dir: 'left' | 'right' | 'up' | 'down' | '' = '';
                if (event.key === 'ArrowRight' && info.atEnd) dir = 'right';
                else if (event.key === 'ArrowLeft' && info.atStart) dir = 'left';
                else if (event.key === 'ArrowDown' && !info.afterHasNL) dir = 'down';
                else if (event.key === 'ArrowUp' && !info.beforeHasNL) dir = 'up';
                if (dir) {
                    const table = h().getTableEl();
                    const target = table ? T.gridNavigate(table, cell, dir) : null;
                    if (target) { event.preventDefault(); h().focusCell(target, false); }
                }
            }
        };

        // ---- 关页面 / 切后台前把没存的冲掉 ----
        const flushOnLeave = () => {
            if (!dirtyRef.current || !wrapRef.current) return;
            const live = activeRef.current.filter((el) => el.isConnected);
            live.forEach((el) => el.classList.remove('selected-cell'));
            const html = wrapRef.current.innerHTML;
            live.forEach((el) => el.classList.add('selected-cell'));
            dirtyRef.current = false;
            // keepalive 让请求在页面卸载后仍然发得出去
            void apiSaveTable(idRef.current, { name: nameRef.current, html }, { keepalive: true })
                .catch(() => { dirtyRef.current = true; });
        };
        const onVisibility = () => { if (document.visibilityState === 'hidden') flushOnLeave(); };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('mousedown', onDocMouseDown);
        document.addEventListener('copy', onCopy);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('pagehide', flushOnLeave);

        return () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('mousedown', onDocMouseDown);
            document.removeEventListener('copy', onCopy);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pagehide', flushOnLeave);
            flushOnLeave();
        };
    }, []);

    // 窗口/容器尺寸变化会改变导出尺寸，但不产生历史记录，单独盯一下
    useEffect(() => {
        const onResize = () => { sizeCacheRef.current = null; updateSizeHint(); };
        window.addEventListener('resize', onResize);
        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver === 'function' && wrapRef.current) {
            ro = new ResizeObserver(() => updateSizeHint());
            ro.observe(wrapRef.current);
        }
        return () => {
            window.removeEventListener('resize', onResize);
            ro?.disconnect();
        };
    }, [updateSizeHint]);

    // ---------- 编辑区上的事件（React 合成事件，先于上面的 document 监听触发）----------

    function onWrapperMouseDown(event: React.MouseEvent) {
        if (event.button !== 0) return;      // 只有左键触发选择/拖拽；右键交给上下文菜单
        const target = (event.target as HTMLElement).closest('td, th, caption') as HTMLElement | null;
        if (!target || !wrapRef.current?.contains(target)) return;

        // Ctrl/Cmd 逐个切换
        if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            const idx = activeRef.current.indexOf(target);
            if (idx > -1) {
                target.classList.remove('selected-cell');
                activeRef.current.splice(idx, 1);
            } else {
                target.classList.add('selected-cell');
                activeRef.current.push(target);
            }
            anchorRef.current = target;
            updateToolbar();
            return;
        }

        // Shift 矩形选择
        if (event.shiftKey && anchorRef.current) {
            event.preventDefault();
            selectRange(anchorRef.current, target);
            return;
        }

        // 普通按下：记录拖拽起点（不 preventDefault，保留点击进入编辑）
        dragStartRef.current = target;
        setSingleSelection(target);
        anchorRef.current = target;
    }

    function onWrapperPaste(event: React.ClipboardEvent) {
        const text = event.clipboardData?.getData('text/plain');
        if (text === '' || text == null) return;

        const anchor = getCurrentCell();

        // 解析为二维数组（制表符分列、换行分行）
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalized.split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();   // 去掉尾部空行
        const grid = lines.map((line) => line.split('\t'));
        const isMulti = grid.length > 1 || (grid[0] && grid[0].length > 1);

        // 单格纯文本：去格式化插入，避免带进 Excel 的样式
        if (!isMulti || !anchor) {
            event.preventDefault();
            document.execCommand('insertText', false, normalized);
            return;
        }

        const table = getTableEl();
        if (!table) return;
        event.preventDefault();
        T.fillFromGrid(table, anchor, grid);
        pushHistory();
        scheduleSave(0);
        notify(`已粘贴 ${grid.length} 行 × ${Math.max(...grid.map((g) => g.length))} 列`);
    }

    function onWrapperContextMenu(event: React.MouseEvent) {
        const cell = (event.target as HTMLElement).closest('td, th') as HTMLElement | null;
        if (!cell || !wrapRef.current?.contains(cell)) return;
        event.preventDefault();
        // 右键的单元格若不在当前选区，则单选它
        if (!activeRef.current.includes(cell)) setSingleSelection(cell);
        anchorRef.current = cell;
        setCtx({ x: event.pageX, y: event.pageY });
    }

    function onWrapperInput() {
        if (inputTimer.current) clearTimeout(inputTimer.current);
        inputTimer.current = window.setTimeout(() => {
            inputTimer.current = null;
            pushHistory();
        }, 600);
        scheduleSave();
    }

    function onNameChange(v: string) {
        setName(v);
        nameRef.current = v;
        setTables((list) => list.map((t) => (t.id === idRef.current ? { ...t, name: v } : t)));
        scheduleSave();
    }

    // ---------- 右键菜单 ----------

    const ctxActions: Array<{ key: string; icon: string; label: string; kbd?: string; danger?: boolean; run: () => void }> = [
        { key: 'ra', icon: 'fa-arrow-up', label: '上方插入行', run: () => withTable((t) => T.insertRow(t, 'above', getCurrentCell())) },
        { key: 'rb', icon: 'fa-arrow-down', label: '下方插入行', run: () => withTable((t) => T.insertRow(t, 'below', getCurrentCell())) },
        { key: 'sep1', icon: '', label: '', run: () => { } },
        { key: 'cl', icon: 'fa-arrow-left', label: '左侧插入列', run: () => withTable((t) => T.insertColumn(t, 'left', getCurrentCell())) },
        { key: 'cr', icon: 'fa-arrow-right', label: '右侧插入列', run: () => withTable((t) => T.insertColumn(t, 'right', getCurrentCell())) },
        { key: 'sep2', icon: '', label: '', run: () => { } },
        {
            key: 'br', icon: 'fa-turn-down', label: '格内换行', kbd: 'Enter', run: () => {
                const target = getCurrentEditable();
                if (target && T.insertLineBreak(target)) { pushHistory(); scheduleSave(0); }
            },
        },
        { key: 'sep3', icon: '', label: '', run: () => { } },
        { key: 'dr', icon: 'fa-trash-alt', label: '删除行', danger: true, run: () => withTable((t) => T.deleteRows(t, activeRef.current)) },
        { key: 'dc', icon: 'fa-trash-alt', label: '删除列', danger: true, run: () => withTable((t) => T.deleteColumns(t, activeRef.current)) },
        { key: 'clr', icon: 'fa-eraser', label: '清空内容', run: () => afterOp(T.clearCells(activeRef.current)) },
    ];

    // ---------- 渲染 ----------

    return (
        <div className="tt-shell">
            <div className={'toast' + (toast ? ' show' : '')}>
                {toast && <><i className={'fas ' + toast.icon} /> {toast.msg}</>}
            </div>

            <div className="app-layout">
                {/* 左侧侧边栏（可折叠） */}
                <aside
                    className={'sidebar-nav' + (collapsed ? ' collapsed' : '')}
                    ref={sidebarRef as React.RefObject<HTMLElement>}
                >
                    <div className="sidebar-header">
                        <h2>图表管理</h2>
                        <button type="button" className="icon-btn" onClick={() => setCollapsed(true)} title="收起侧边栏">
                            <i className="fas fa-chevron-left" />
                        </button>
                    </div>
                    <div className="sidebar-actions">
                        <button type="button" className="primary" onClick={() => void createTable('新图表')}>
                            <i className="fas fa-plus" /> 新建图表
                        </button>
                    </div>
                    <ul className="table-list">
                        {tables.map((t) => (
                            <li key={t.id} className={'table-item' + (t.id === currentId ? ' active' : '')}>
                                {/* 用真正的 button 而不是带 onClick 的 span：
                                    span 只占内容盒，行的 padding 落在它外面 —— 光标显示可点、
                                    点上去却没反应。button 撑满整行（padding 也归它），
                                    顺带还能 Tab 聚焦、回车触发。 */}
                                <button
                                    type="button"
                                    className="table-name"
                                    aria-current={t.id === currentId ? 'true' : undefined}
                                    onClick={() => void switchTable(t.id)}
                                    onMouseEnter={(e) => showNameTip(e.currentTarget, t.name)}
                                    onMouseLeave={hideNameTip}
                                    onFocus={(e) => showNameTip(e.currentTarget, t.name)}
                                    onBlur={hideNameTip}
                                >
                                    {t.name}
                                </button>
                                <button
                                    type="button"
                                    className="delete-btn"
                                    title="删除图表"
                                    onClick={(e) => { e.stopPropagation(); void removeTable(t.id); }}
                                >
                                    <i className="fas fa-trash" />
                                </button>
                            </li>
                        ))}
                    </ul>
                    <div className="sidebar-foot">
                        <button
                            type="button"
                            className="ghost-btn"
                            onClick={() => setBkOpen(true)}
                            title="查看存了什么 / 导出备份 / 从备份恢复"
                        >
                            <i className="fas fa-database" /> 数据备份与迁移
                        </button>
                        <p className="sidebar-tip">
                            表格存在本机 <code>data/app.db</code>，改动自动落库。换设备请导出 JSON 备份。
                        </p>
                    </div>
                </aside>

                {/* 右侧主内容区 */}
                <div className="main-content">
                    <header className="main-header">
                        <Link to="/" className="home-link" title="返回工具箱主页">
                            <i className="fas fa-arrow-left" /> <span>工具箱</span>
                        </Link>
                        <button
                            type="button"
                            className="icon-btn"
                            onClick={() => setCollapsed((c) => !c)}
                            title="展开/收起侧边栏"
                        >
                            <i className="fas fa-bars" />
                        </button>
                        <input
                            type="text"
                            className="table-name-input"
                            value={name}
                            onChange={(e) => onNameChange(e.target.value)}
                        />
                        <div className="header-title">学术三线表工具</div>
                    </header>

                    <div className="main-container">
                        <nav className="toolbar">
                            <div className="control-section">
                                <h3><i className="fas fa-table" /> 全局操作 (末尾)</h3>
                                <div className="button-row">
                                    <button type="button" onClick={() => withTable(T.addRow)}><i className="fas fa-plus" /> 末尾加行</button>
                                    <button type="button" onClick={() => withTable(T.addColumn)}><i className="fas fa-plus" /> 末尾加列</button>
                                    <button type="button" className="danger" onClick={() => withTable(T.removeRow)}><i className="fas fa-minus" /> 删末尾行</button>
                                    <button type="button" className="danger" onClick={() => withTable(T.removeColumn)}><i className="fas fa-minus" /> 删末尾列</button>
                                </div>
                                <h3 style={{ marginTop: 12 }}><i className="fas fa-mouse-pointer" /> 基于选中单元格</h3>
                                <div className="button-row">
                                    <button type="button" onClick={() => withTable((t) => T.insertRow(t, 'above', getCurrentCell()))}><i className="fas fa-arrow-up" /> 上加行</button>
                                    <button type="button" onClick={() => withTable((t) => T.insertRow(t, 'below', getCurrentCell()))}><i className="fas fa-arrow-down" /> 下加行</button>
                                    <button type="button" className="danger" onClick={() => withTable((t) => T.deleteRows(t, activeRef.current))}><i className="fas fa-trash-alt" /> 删选中行</button>
                                </div>
                                <div className="button-row" style={{ marginTop: 4 }}>
                                    <button type="button" onClick={() => withTable((t) => T.insertColumn(t, 'left', getCurrentCell()))}><i className="fas fa-arrow-left" /> 左加列</button>
                                    <button type="button" onClick={() => withTable((t) => T.insertColumn(t, 'right', getCurrentCell()))}><i className="fas fa-arrow-right" /> 右加列</button>
                                    <button type="button" className="danger" onClick={() => withTable((t) => T.deleteColumns(t, activeRef.current))}><i className="fas fa-trash-alt" /> 删选中列</button>
                                </div>
                            </div>

                            <div className="control-section" style={{ flex: 2 }}>
                                <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    borderBottom: '2px solid var(--border-color)', paddingBottom: 8, marginBottom: 12,
                                }}>
                                    <h3 style={{ margin: 0, border: 'none', padding: 0 }}>
                                        <i className="fas fa-paint-brush" /> 元素样式{' '}
                                        <span style={{
                                            fontSize: 11, fontWeight: 'normal',
                                            color: 'var(--text-secondary)', textTransform: 'none',
                                        }}>
                                            (提示: 按住 Ctrl 可多选单元格进行批处理)
                                        </span>
                                    </h3>
                                </div>

                                <div className={'style-toolbar' + (sel.active ? ' active' : '')}>
                                    <div className="input-group">
                                        <label htmlFor="font-family-input"><i className="fas fa-font" /> 字体</label>
                                        <select
                                            id="font-family-input"
                                            value={sel.fontFamily}
                                            onChange={(e) => applyFontFamily(e.target.value)}
                                        >
                                            <option value="'Times New Roman', Times, serif">Times New Roman</option>
                                            <option value="Calibri, sans-serif">Calibri</option>
                                            <option value="Arial, sans-serif">Arial</option>
                                        </select>
                                    </div>

                                    <div className="input-group">
                                        <label htmlFor="font-size-input"><i className="fas fa-text-height" /> 大小(px)</label>
                                        <input
                                            type="number"
                                            id="font-size-input"
                                            value={sel.fontSize}
                                            onChange={(e) => applyFontSize(Number(e.target.value))}
                                        />
                                    </div>

                                    <div className="input-group">
                                        <label htmlFor="padding-input"><i className="fas fa-arrows-alt-v" /> 边距</label>
                                        <input
                                            type="number"
                                            id="padding-input"
                                            title="调整单元格的上下内边距"
                                            value={sel.padding}
                                            onChange={(e) => applyPadding(Number(e.target.value))}
                                        />
                                    </div>

                                    <div className="input-group">
                                        <label htmlFor="line-height-input"><i className="fas fa-ruler-vertical" /> 行高</label>
                                        <input
                                            type="number"
                                            id="line-height-input"
                                            step="0.1"
                                            title="调整多行文字之间的距离"
                                            value={sel.lineHeight}
                                            onChange={(e) => applyLineHeight(Number(e.target.value))}
                                        />
                                    </div>

                                    <div className="button-row">
                                        <button type="button" title="加粗" onClick={() => afterOp(T.toggleBold(activeRef.current))}><i className="fas fa-bold" /></button>
                                        <button type="button" title="斜体" onClick={() => afterOp(T.toggleItalic(activeRef.current))}><i className="fas fa-italic" /></button>
                                        <div style={{ width: 1, background: 'var(--border-color)', margin: '0 4px' }} />
                                        <button type="button" title="左对齐" onClick={() => afterOp(T.alignText(activeRef.current, 'left'))}><i className="fas fa-align-left" /></button>
                                        <button type="button" title="居中" onClick={() => afterOp(T.alignText(activeRef.current, 'center'))}><i className="fas fa-align-center" /></button>
                                        <button type="button" title="右对齐" onClick={() => afterOp(T.alignText(activeRef.current, 'right'))}><i className="fas fa-align-right" /></button>
                                        <button type="button" title="两端对齐" onClick={() => afterOp(T.alignText(activeRef.current, 'justify'))}><i className="fas fa-align-justify" /></button>
                                        <div style={{ width: 1, background: 'var(--border-color)', margin: '0 4px' }} />
                                        <button
                                            type="button"
                                            title="清除格式：把从 Word/PDF 粘来的斜体、加粗、杂乱字号还原成纯文本"
                                            onClick={() => afterOp(T.clearFormatting(activeRef.current))}
                                        >
                                            <i className="fas fa-eraser" /> 清除格式
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* 导出面板。
                                只有「导出高清 PNG」是实心主按钮 —— 一屏里同时出现三个
                                不同颜色的实心按钮时，等于没有主次，眼睛不知道该落在哪儿。
                                其余一律描边，按「当前表 / 全部表」分成两组。 */}
                            <div className="control-section export-section">
                                <h3><i className="fas fa-file-export" /> 导出</h3>

                                <div className="exp-group">
                                    <span className="exp-group-label">当前这张表</span>

                                    <button
                                        type="button"
                                        className="primary exp-main"
                                        disabled={exporting}
                                        onClick={() => void exportToPNG()}
                                    >
                                        <i className={exporting ? 'fas fa-spinner fa-spin' : 'fas fa-image'} />
                                        {exporting ? '导出中…' : '导出高清 PNG'}
                                    </button>

                                    <div className="export-scale">
                                        <label htmlFor="export-scale-input">分辨率</label>
                                        <select
                                            id="export-scale-input"
                                            value={scale}
                                            title="倍率越高越清晰，文件也越大；超出浏览器画布上限时会自动降档"
                                            onChange={(e) => exportScaleChange(Number(e.target.value))}
                                        >
                                            {SCALE_OPTIONS.map((o) => (
                                                <option key={o.v} value={o.v}>{o.label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <span className="export-size-hint" title={hint.title}>{hint.text}</span>

                                    <div className="exp-row">
                                        <button
                                            type="button"
                                            disabled={exportingMd}
                                            onClick={exportToMarkdown}
                                        >
                                            <i className={exportingMd ? 'fas fa-spinner fa-spin' : 'fas fa-file-code'} />
                                            导出 Markdown
                                        </button>
                                        <label className="export-toggle" title="导出 PNG 时是否包含表题（caption）">
                                            <input
                                                type="checkbox"
                                                checked={includeCaption}
                                                onChange={(e) => setIncludeCaption(e.target.checked)}
                                            />
                                            <span>含表题</span>
                                        </label>
                                    </div>
                                </div>

                                <div className="exp-group">
                                    <span className="exp-group-label">
                                        全部表格 <b className="u-num">{tables.length}</b>
                                    </span>
                                    <div className="exp-row">
                                        <button
                                            type="button"
                                            onClick={() => { setExpAuto(true); setExpOpen(true); }}
                                            disabled={tables.length === 0}
                                            title={`把全部 ${tables.length} 张表按当前分辨率打包成一个 zip，点了就开始`}
                                        >
                                            <i className="fas fa-file-zipper" /> 全部导出
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { setExpAuto(false); setExpOpen(true); }}
                                            disabled={tables.length === 0}
                                            title="自己挑几张、选格式，再打包"
                                        >
                                            <i className="fas fa-list-check" /> 自选导出
                                        </button>
                                    </div>
                                </div>

                                <div className="exp-group">
                                    <span className="exp-group-label">导入</span>
                                    <button
                                        type="button"
                                        className="btn-import"
                                        onClick={() => setMdOpen(true)}
                                        title="把 Markdown 表格粘贴或选择 .md 文件导入"
                                    >
                                        <i className="fas fa-file-import" /> 导入 Markdown
                                    </button>
                                </div>
                            </div>
                        </nav>

                        <div className="usage-hints">
                            <i className="fas fa-lightbulb" />
                            <span className="hint-label">像 Excel 一样：</span>
                            <span><b>拖拽 / Shift+点</b> 框选</span>
                            <span><b>Ctrl+V</b> 从 Excel 粘贴</span>
                            <span><b>Enter</b> 格内换行</span>
                            <span><b>Tab / 方向键</b> 换格（末格 Tab 自动加行）</span>
                            <span><b>Delete</b> 清空所选</span>
                            <span><b>右键</b> 插入 / 删除行列</span>
                            <span><b>Ctrl+C</b> 复制为表格</span>
                            <span><b>导入 Markdown</b> 贴 md 表格直接建表</span>
                        </div>

                        <main className="preview-area">
                            {/*
                              编辑区：内容由 innerHTML 直接管理，React 不参与 diff。
                              首屏用 dangerouslySetInnerHTML 交给 SSR，避免白闪；
                              之后切表 / 撤销 / 导入都是命令式改 innerHTML。
                            */}
                            <div
                                id="table-export-area"
                                className="table-wrapper"
                                ref={wrapRef}
                                onMouseDown={onWrapperMouseDown}
                                onPaste={onWrapperPaste}
                                onContextMenu={onWrapperContextMenu}
                                onInput={onWrapperInput}
                                dangerouslySetInnerHTML={initialHtmlProp.current}
                            />
                        </main>
                    </div>
                </div>
            </div>

            {/* 右键上下文菜单 */}
            {ctx && (
                <div className="context-menu" style={{ left: ctx.x, top: ctx.y }}>
                    {ctxActions.map((a) => (
                        a.key.startsWith('sep')
                            ? <div key={a.key} className="context-sep" />
                            : (
                                <button
                                    key={a.key}
                                    type="button"
                                    className={a.danger ? 'danger' : undefined}
                                    onClick={() => { a.run(); setCtx(null); }}
                                >
                                    <i className={'fas ' + a.icon} /> {a.label}
                                    {a.kbd && <span className="ctx-key">{a.kbd}</span>}
                                </button>
                            )
                    ))}
                </div>
            )}

            <MdImportModal
                open={mdOpen}
                onClose={() => setMdOpen(false)}
                onConfirm={(t, m) => void confirmMdImport(t, m)}
                onNotify={notify}
            />

            <BackupModal
                open={bkOpen}
                onClose={() => setBkOpen(false)}
                tables={tables}
                currentId={currentId}
                onRestored={(id, count, mode) => void onRestored(id, count, mode)}
                onNotify={notify}
            />

            <ExportAllModal
                open={expOpen}
                autoStart={expAuto}
                onClose={() => setExpOpen(false)}
                tables={tables}
                /* 当前这张表可能刚改完还没落库，用内存里的最新 HTML；
                   其余的让弹窗自己去库里取 */
                liveHtml={(id) => (id === currentId ? (wrapRef.current?.innerHTML ?? null) : null)}
                measureWidth={measureExportWidth}
                exportScale={scale}
                includeCaption={includeCaption}
                onNotify={notify}
            />

            {/* 图表全名浮层。挂在最外层、position:fixed，
                这样不会被侧栏的 overflow:hidden 裁掉。 */}
            {nameTip && (
                <div className="name-tip" style={{ left: nameTip.x, top: nameTip.y }} role="tooltip">
                    {nameTip.text}
                </div>
            )}
        </div>
    );
}
