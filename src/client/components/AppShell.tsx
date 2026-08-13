// ============================================================
//  全站骨架：滑出式深色侧栏 + 吸顶浅色顶栏 + 内容区
//
//  跟上一版最大的差别是**侧栏不再常驻**：它默认收着，从左边滑出来盖在
//  内容上，后面垫一层半透明遮罩，点遮罩或按 Esc 关掉。内容区完全不受
//  影响 —— 侧栏是浮在上面的，不挤压布局，所以正文宽度在任何时候都一样。
//
//  代价说清楚：常驻侧栏能一直显示「我在站里的哪个位置」，滑出式做不到。
//  补偿手段是顶栏中间始终显示当前页标题，那一行现在承担了「我在哪儿」。
//
//  收起状态存 sessionStorage 而不是 localStorage：这是**这一次浏览**里的
//  临时偏好，下次打开站点应该回到干净的默认态，而不是继承上周的选择。
//
//  两级导航：
//    · 上面一组是顶层工具 —— 挂在别的页面底下的（比如三线表在「论文相关」
//      里）不出现在这儿，见 site-catalog.ts 的 Tool.parent
//    · 下面一组是当前工具内部的去处（比如记忆卡的 计划 / 统计），
//      由页面通过 sections 传进来
//
//  沉浸式页面（背卡片、口语对话）不套这个骨架：那两个场景要的是全屏专注。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import SiteSearch from './SiteSearch';
import Avatar from './Avatar';
import { useProfile } from '@/lib/profile';
import { topTools } from '@/lib/site-data';

/** 当前工具内部的去处 */
export interface ShellSection {
    to: string;
    label: string;
    icon: string;
    /** 默认按前缀匹配；精确匹配的（比如列表页 vs 详情页）传 true */
    end?: boolean;
}

interface Props {
    /** 页面标题，显示在顶栏中间 */
    title: string;
    /** 副标题；通常放英文名或一句定位 */
    subtitle?: string;
    /** 顶栏右侧的操作按钮 */
    actions?: React.ReactNode;
    /** 当前工具内部的二级导航 */
    sections?: ShellSection[];
    /** 内容区宽度：默认铺满到 --stage-max，narrow / medium 是配置型页面的窄栏 */
    width?: 'wide' | 'medium' | 'narrow';
    /**
     * 顶栏融进页面底色（首页用）。
     *
     * 首页本身就是一张大列表，顶栏再画一条边会把它切成两截；
     * 去掉边和投影之后顶栏和页面是同一块，滚动时内容照样从它后面过去。
     */
    flatNav?: boolean;
    children: React.ReactNode;
}

/** 这一次浏览里侧栏开着没有。sessionStorage —— 关掉标签页就忘掉 */
const OPEN_KEY = 'shell.sidebar.open';

export default function AppShell({
    title, subtitle, actions, sections, width = 'wide', flatNav = false, children,
}: Props) {
    const [open, setOpen] = useState(() => {
        try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
    });
    /** 侧栏底部那一条要显示名字。模块级缓存过，切页面不会重复打接口 */
    const profile = useProfile();

    const sidebarRef = useRef<HTMLElement | null>(null);
    const openBtnRef = useRef<HTMLButtonElement | null>(null);

    const setOpenPersisted = useCallback((next: boolean) => {
        setOpen(next);
        try { sessionStorage.setItem(OPEN_KEY, next ? '1' : '0'); } catch { /* 无痕模式 */ }
    }, []);

    /**
     * 关掉侧栏。
     *
     * 关之前先看焦点在不在侧栏里 —— 在的话（点了里面的链接、或者 Tab 到某一项
     * 之后按了 Esc）要把它送回汉堡按钮。不送的话侧栏一 inert，焦点会被浏览器
     * 丢回 <body>，键盘用户下一次按 Tab 得从整页开头重新走一遍。
     *
     * 焦点不在侧栏里就别动它：正在输入框里打字时按 Esc 顺手关侧栏，
     * 光标不该莫名其妙跳走。
     */
    const close = useCallback(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && sidebarRef.current?.contains(active)) {
            openBtnRef.current?.focus();
        }
        setOpenPersisted(false);
    }, [setOpenPersisted]);

    // 开着时按 Esc 关掉
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, close]);

    const navItem = ({ isActive }: { isActive: boolean }) =>
        'sidebar-item' + (isActive ? ' is-active' : '');

    return (
        <div className="layout">
            {/* 遮罩只在开着时挂上去 —— 一直留在 DOM 里、只是透明的话，
                它会默默吃掉整页的点击 */}
            {open && (
                <div className="sidebar-overlay" onClick={close} aria-hidden="true" />
            )}

            <aside
                ref={sidebarRef}
                className={'sidebar ' + (open ? 'expanded' : 'collapsed')}
                aria-label="站点导航"
                /*
                 * 收起时整块 inert：既移出无障碍树，也拿不到焦点。
                 *
                 * 这里**只用 inert，不加 aria-hidden**。两个一起加会被 Chrome 拦下来
                 * 报「Blocked aria-hidden on an element because its descendant retained
                 * focus」—— 点侧栏里的链接会顺手关掉侧栏，那一刻焦点还在这个链接上，
                 * 而 aria-hidden 不负责移走焦点，于是就出现了「焦点停在一个对读屏器
                 * 不存在的元素上」这种自相矛盾的状态。inert 两件事一起做，没有这个洞。
                 */
                inert={!open}
            >
                <div className="sidebar-header">
                    <Link to="/" className="sidebar-logo" title="工具箱主页">工</Link>
                    <Link to="/" className="sidebar-title">工具箱</Link>
                </div>

                <div className="sidebar-nav-label">工具</div>
                <nav className="sidebar-content" aria-label="工具">
                    <NavLink to="/" end className={navItem} onClick={close}>
                        <span className="sidebar-icon"><i className="fas fa-house" /></span>
                        <span className="sidebar-text">全部工具</span>
                    </NavLink>

                    {topTools.map((t) => (
                        <NavLink key={t.href} to={t.href} className={navItem} onClick={close}>
                            <span className="sidebar-icon"><i className={'fas ' + t.icon} /></span>
                            <span className="sidebar-text">{t.title}</span>
                        </NavLink>
                    ))}

                    {sections && sections.length > 0 && (
                        <>
                            <div className="sidebar-nav-label">本工具</div>
                            {sections.map((s) => (
                                <NavLink
                                    key={s.to}
                                    to={s.to}
                                    end={s.end}
                                    className={navItem}
                                    onClick={close}
                                >
                                    <span className="sidebar-icon"><i className={'fas ' + s.icon} /></span>
                                    <span className="sidebar-text">{s.label}</span>
                                </NavLink>
                            ))}
                        </>
                    )}
                </nav>

                <NavLink to="/me" className="sidebar-me" onClick={close}>
                    <Avatar name={profile.name} avatar={profile.avatar} className="sidebar-me-avatar" />
                    <span className="sidebar-me-text">
                        <b>{profile.name}</b>
                        <span>个人中心</span>
                    </span>
                </NavLink>

                <button type="button" className="sidebar-collapse-btn" onClick={close}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                    <span>收起</span>
                </button>
            </aside>

            <header className={'navbar' + (flatNav ? ' navbar--flat' : '')}>
                <div className="navbar-left">
                    <button
                        type="button"
                        ref={openBtnRef}
                        className="sidebar-open-btn"
                        onClick={() => setOpenPersisted(true)}
                        aria-label="打开导航"
                        aria-expanded={open}
                    >
                        <span className="hamburger-icon" aria-hidden="true">
                            <span className="hamburger-line" />
                            <span className="hamburger-line" />
                            <span className="hamburger-line" />
                        </span>
                    </button>
                </div>

                <div className="navbar-center">
                    <div className="navbar-title-group">
                        <h1 className="navbar-page-title">{title}</h1>
                        {subtitle && <p className="navbar-page-subtitle">{subtitle}</p>}
                    </div>
                </div>

                <div className="navbar-right">
                    {actions}
                    <SiteSearch />
                </div>
            </header>

            <main className="layout-content">
                <div className={'page-wrap page-wrap--' + width}>{children}</div>
            </main>
        </div>
    );
}
