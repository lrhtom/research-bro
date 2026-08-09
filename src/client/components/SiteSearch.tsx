// ============================================================
//  全站搜索框
//
//  数据全部来自 src/lib/site-data.ts（工具 / 30 个可视化演示 / 网课 / 格式转换），
//  打分与高亮在 src/lib/search.ts。索引在客户端现算 —— 几十条而已，比拉个接口便宜。
//
//  快捷键：/ 或 Ctrl+K 聚焦，↑↓ 选择，Enter 打开，Esc 关闭。
// ============================================================

import { Link } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildIndex, type SearchRow } from '@/lib/site-data';
import { highlight, search, splitTerms } from '@/lib/search';

function Marked({ text, terms }: { text: string; terms: string[] }) {
    return (
        <>
            {highlight(text, terms).map((seg, i) =>
                seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
            )}
        </>
    );
}

export default function SiteSearch({ placeholder = '搜索工具、演示、网课、比赛…' }: { placeholder?: string }) {
    const index = useMemo(() => buildIndex(), []);
    const [q, setQ] = useState('');
    const [open, setOpen] = useState(false);
    const [cur, setCur] = useState(-1);

    const hostRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const query = q.trim();
    const terms = useMemo(() => splitTerms(query), [query]);
    const rows: SearchRow[] = useMemo(
        () => (query ? search(query, index) : []),
        [query, index],
    );

    // 结果换了就把高亮条拉回第一条
    useEffect(() => {
        setCur(rows.length ? 0 : -1);
    }, [rows]);

    // 点面板外面就关掉。用 mousedown 而不是 click：
    // 如果等到 click，blur 会先触发把面板清空，结果链接点了个空。
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (hostRef.current && !hostRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, []);

    // 全局快捷键：/ 聚焦（正在别的输入框打字时不抢），Ctrl/Cmd+K 同效
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            const tag = (t?.tagName || '').toLowerCase();
            const typing = tag === 'input' || tag === 'textarea' || !!t?.isContentEditable;
            if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
                e.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    function move(delta: number) {
        if (!rows.length) return;
        const next = (cur + delta + rows.length) % rows.length;
        setCur(next);
        panelRef.current?.querySelectorAll('.search-hit')[next]?.scrollIntoView({ block: 'nearest' });
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter') {
            const el = panelRef.current?.querySelectorAll<HTMLAnchorElement>('.search-hit')[cur];
            if (el) { e.preventDefault(); el.click(); }
        } else if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
        }
    }

    const showPanel = open && !!query;

    return (
        <div className="search" id="site-search" ref={hostRef}>
            <div className="search-box">
                <i className="fas fa-magnifying-glass search-ico" />
                <input
                    ref={inputRef}
                    type="search"
                    className="search-input"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={placeholder}
                    aria-label="全站搜索"
                    value={q}
                    onChange={(e) => { setQ(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={onKeyDown}
                />
                {!query && <kbd className="search-kbd">/</kbd>}
            </div>

            <div className="search-panel" hidden={!showPanel} ref={panelRef}>
                {showPanel && rows.length === 0 && (
                    <div className="search-empty">
                        没有匹配「{query}」的内容
                        <span>试试「TCP」「缓存」「数据库」「MIT」这类关键词</span>
                    </div>
                )}

                {showPanel && rows.length > 0 && (
                    <>
                        <div className="search-count">{rows.length} 条结果</div>
                        {rows.map((r, i) => {
                            const cls = 'search-hit' + (i === cur ? ' on' : '');
                            const body = (
                                <>
                                    <span className="hit-ico"><i className={'fas ' + r.icon} /></span>
                                    <span className="hit-body">
                                        <span className="hit-t"><Marked text={r.title} terms={terms} /></span>
                                        <span className="hit-s"><Marked text={r.sub || ''} terms={terms} /></span>
                                    </span>
                                    <span className={'hit-tag' + (r.external ? ' out' : '')}>
                                        {r.tag}
                                        {r.external && <> <i className="fas fa-arrow-up-right-from-square" /></>}
                                    </span>
                                </>
                            );

                            return r.external ? (
                                <a
                                    key={r.href + i}
                                    className={cls}
                                    href={r.href}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onMouseEnter={() => setCur(i)}
                                >
                                    {body}
                                </a>
                            ) : (
                                <Link
                                    key={r.href + i}
                                    className={cls}
                                    to={r.href}
                                    onMouseEnter={() => setCur(i)}
                                    onClick={() => setOpen(false)}
                                >
                                    {body}
                                </Link>
                            );
                        })}
                    </>
                )}
            </div>
        </div>
    );
}
