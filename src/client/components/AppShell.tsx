// ============================================================
//  全站骨架：左侧导航 + 右侧内容
//
//  以前每个页面各写一份顶栏，于是「我现在在站里的哪个位置」这件事
//  每页都得重新读一遍标题才知道。改成固定的左栏之后，
//  当前工具一直高亮在那儿，切换也不用先退回首页。
//
//  两级导航：
//    · 上面一组是**顶层工具**（记忆卡 / 口语 / 可视化 / 网课 / 比赛 / 转换 / 论文相关）
//      —— 挂在别的页面底下的（比如三线表在「论文相关」里）不出现在这儿，
//      见 site-catalog.ts 的 Tool.parent
//    · 下面一组是**当前工具内部的去处**（比如记忆卡的 计划 / 统计），
//      由页面通过 sections 传进来 —— 只有进了这个工具才会出现
//
//  沉浸式页面（背卡片、口语对话）**不套这个骨架**：那两个场景要的是
//  全屏专注，侧栏在旁边一直闪只会分心。它们自己留一个返回入口。
// ============================================================

import { useCallback, useEffect, useState } from 'react';
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
    /** 页面标题，显示在内容区顶部 */
    title: string;
    /** 副标题；通常放英文名或一句定位 */
    subtitle?: string;
    /** 右上角的操作按钮 */
    actions?: React.ReactNode;
    /** 当前工具内部的二级导航 */
    sections?: ShellSection[];
    /** 内容区是否用窄栏（阅读型页面更好读） */
    narrow?: boolean;
    children: React.ReactNode;
}

const COLLAPSE_KEY = 'shell.rail.collapsed';

export default function AppShell({
    title, subtitle, actions, sections, narrow = false, children,
}: Props) {
    // 折叠状态存本地：这是个人偏好，不值得为它开一次接口，
    // 但也不该每次刷新都弹回展开
    const [collapsed, setCollapsed] = useState(
        () => typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1',
    );
    /** 窄屏下的抽屉 */
    const [drawer, setDrawer] = useState(false);
    /** 侧栏底部那一条要显示名字。模块级缓存过，切页面不会重复打接口 */
    const profile = useProfile();

    const toggle = useCallback(() => {
        setCollapsed((c) => {
            const next = !c;
            try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* 无痕模式 */ }
            return next;
        });
    }, []);

    // 抽屉开着时按 Esc 关掉
    useEffect(() => {
        if (!drawer) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [drawer]);

    return (
        <div className={'shell' + (collapsed ? ' is-collapsed' : '') + (drawer ? ' is-drawer-open' : '')}>
            {/* 窄屏下点遮罩关抽屉 */}
            <div className="shell-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />

            <aside className="rail">
                <div className="rail-brand">
                    <Link to="/" className="rail-mark" title="工具箱主页">
                        <span className="rail-mark-glyph">工</span>
                    </Link>
                    <Link to="/" className="rail-wordmark">
                        <b>工具箱</b>
                        <span>Toolbox</span>
                    </Link>
                    <button
                        type="button"
                        className="rail-collapse"
                        onClick={toggle}
                        title={collapsed ? '展开侧栏' : '收起侧栏'}
                        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
                    >
                        <i className={'fas fa-angles-' + (collapsed ? 'right' : 'left')} />
                    </button>
                </div>

                <nav className="rail-nav" aria-label="工具">
                    {/* 首页也要有自己的一项，否则站在首页时侧栏里没有任何东西是亮的，
                        「我在哪儿」这件事就断了一截 */}
                    <NavLink
                        to="/"
                        end
                        className={({ isActive }) => 'rail-item' + (isActive ? ' is-active' : '')}
                        title="全部工具"
                    >
                        <i className="fas fa-house" />
                        <span className="rail-item-text">全部工具</span>
                    </NavLink>

                    <p className="rail-label">工具</p>
                    {topTools.map((t) => (
                        <NavLink
                            key={t.href}
                            to={t.href}
                            className={({ isActive }) => 'rail-item' + (isActive ? ' is-active' : '')}
                            title={t.title}
                        >
                            <i className={'fas ' + t.icon} />
                            <span className="rail-item-text">{t.title}</span>
                        </NavLink>
                    ))}

                    {sections && sections.length > 0 && (
                        <>
                            <p className="rail-label">本工具</p>
                            {sections.map((s) => (
                                <NavLink
                                    key={s.to}
                                    to={s.to}
                                    end={s.end}
                                    className={({ isActive }) => 'rail-item is-sub' + (isActive ? ' is-active' : '')}
                                    title={s.label}
                                >
                                    <i className={'fas ' + s.icon} />
                                    <span className="rail-item-text">{s.label}</span>
                                </NavLink>
                            ))}
                        </>
                    )}
                </nav>

                <div className="rail-foot">
                    {/* 收起态下这一整块只剩这个头像 —— 名字和脚注都藏起来，
                        但入口不能一起消失，否则个人中心就没有常驻入口了 */}
                    <NavLink
                        to="/me"
                        className={({ isActive }) => 'rail-me' + (isActive ? ' is-active' : '')}
                        title={`${profile.name} · 个人中心`}
                    >
                        <Avatar name={profile.name} avatar={profile.avatar} className="rail-me-avatar" />
                        <span className="rail-me-text">
                            <b>{profile.name}</b>
                            <span>个人中心</span>
                        </span>
                    </NavLink>
                    <p className="rail-foot-note">
                        自建工具跑在本机，数据存本地 SQLite。
                    </p>
                </div>
            </aside>

            <div className="stage">
                <header className="stage-head">
                    {/* 顶栏内容跟正文用同一条宽度轨道并一起居中 ——
                        顶栏铺满整幅而正文限宽的话，宽屏上搜索框会孤零零飘在
                        正文右边缘之外好几百像素，看着像两个页面拼起来的 */}
                    <div className="stage-head-inner">
                        <button
                            type="button"
                            className="stage-menu"
                            onClick={() => setDrawer(true)}
                            aria-label="打开导航"
                        >
                            <i className="fas fa-bars" />
                        </button>

                        <div className="stage-title">
                            <h1>{title}</h1>
                            {subtitle && <p>{subtitle}</p>}
                        </div>

                        <div className="stage-actions">{actions}</div>
                        <SiteSearch />
                    </div>
                </header>

                <main className={'stage-body' + (narrow ? ' is-narrow' : '')}>
                    <div className="stage-inner">{children}</div>
                </main>
            </div>
        </div>
    );
}
