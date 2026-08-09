// ============================================================
//  知识可视化 · React 外壳
//
//  30 个演示本体是原来的纯 DOM 模块，一行没改，原样放在 public/viz/js/ 下。
//  它们不需要框架 —— 每个模块都是 mount(container) / unmount() 两个函数，
//  用 canvas 和手写 DOM 画图，翻成 React 组件只会徒增几千行且毫无收益。
//  所以这里只做三件事：
//    1. 把 viz.css 和那批脚本按顺序注入（脚本靠 async=false 保证执行顺序）
//    2. 把 Viz.dom 指到 React 渲染出来的几个容器上
//    3. 复现旧版 main.js 的初始化逻辑（#demo= 优先 > 上次看的 > 第一个）
//  样式表用 <link> 动态挂载、卸载时摘掉，这样 viz.css 里的 .card / .brand
//  永远不会跑到门户页面上去。
// ============================================================

import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { demos } from '@/lib/site-data';
import Loading from './Loading';

// ---------- 与 public/viz/js/core.js 对应的最小类型 ----------

interface VizDemo {
    id: string;
    cat: string;
    title: string;
    subtitle?: string;
    blurb?: string;
    icon?: string;
    mount: (container: HTMLElement) => void;
    unmount?: () => void;
}

interface VizGlobal {
    demos: VizDemo[];
    currentId: string | null;
    dom: Record<string, HTMLElement | null>;
    activate: (id: string) => void;
    renderNav: () => void;
}

declare global {
    interface Window {
        Viz?: VizGlobal;
    }
}

// ---------- 脚本加载 ----------

const SCRIPT_URLS = ['/viz/js/core.js', ...demos.map((d) => `/viz/js/${d.id}.js`)];

/** 模块级缓存：路由来回切、React 严格模式重复执行 effect，都只加载一次 */
let scriptsPromise: Promise<void> | null = null;

function loadScripts(): Promise<void> {
    if (scriptsPromise) return scriptsPromise;

    scriptsPromise = new Promise<void>((resolve, reject) => {
        // 动态插入的 script 默认是 async，谁先下完谁先跑；
        // 显式置 async=false 才会按插入顺序执行 —— 演示在侧边栏里的排序靠的就是这个。
        let pending = SCRIPT_URLS.length;
        SCRIPT_URLS.forEach((src) => {
            const el = document.createElement('script');
            el.src = src;
            el.async = false;
            el.dataset.viz = '1';
            el.onload = () => { if (--pending === 0) resolve(); };
            el.onerror = () => reject(new Error(`加载演示脚本失败：${src}`));
            document.head.appendChild(el);
        });
    }).catch((err) => {
        scriptsPromise = null;   // 失败了允许重试，别把错误状态焊死
        throw err;
    });

    return scriptsPromise;
}

/** 从 #demo=xxx 里取演示 id；没有或格式不对就返回 null */
function demoFromHash(): string | null {
    const m = /(?:^|[#&])demo=([A-Za-z0-9_-]+)/.exec(window.location.hash || '');
    return m ? m[1] : null;
}

// ---------- 组件 ----------

export default function VizApp() {
    const navRef = useRef<HTMLUListElement>(null);
    const stageRef = useRef<HTMLElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const blurbRef = useRef<HTMLParagraphElement>(null);
    const sidebarRef = useRef<HTMLElement>(null);
    /**
     * 30 个演示脚本是动态插进来的，慢的时候要好几百毫秒 ——
     * 这期间左边列表和右边舞台都是空的，看着像页面坏了。
     * 所以显式记一个加载状态，把「在下载演示脚本」说出来。
     */
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

    useEffect(() => {
        let alive = true;

        // viz.css 跟着组件生死：挂上来、卸下去，绝不留在别的路由上
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/viz/viz.css';
        link.dataset.viz = '1';
        document.head.appendChild(link);

        const onHashChange = () => {
            const id = demoFromHash();
            const Viz = window.Viz;
            if (Viz && id && id !== Viz.currentId && Viz.demos.some((d) => d.id === id)) {
                Viz.activate(id);
            }
        };

        loadScripts()
            .then(() => {
                const Viz = window.Viz;
                if (!alive || !Viz) return;
                setStatus('ready');

                Viz.dom = {
                    navList: navRef.current,
                    stage: stageRef.current,
                    stageTitle: titleRef.current,
                    stageBlurb: blurbRef.current,
                    sidebar: sidebarRef.current,
                };

                // 打开哪个演示的优先级：地址栏 #demo=xxx > 上次看过的 > 列表第一个。
                // 地址栏优先是为了让首页搜索能直接跳到指定演示，而不是被 localStorage 抢走。
                const known = (id: string | null) => !!id && Viz.demos.some((d) => d.id === id);
                let last: string | null = null;
                try { last = localStorage.getItem('viz_last_demo'); } catch { /* 隐私模式忽略 */ }

                const hashed = demoFromHash();
                const first = known(hashed) ? hashed
                    : (known(last) ? last : (Viz.demos[0] && Viz.demos[0].id));

                // 卸载后重新进来时 currentId 还留着上次的值，先清掉，
                // 否则 activate 会去 unmount 一个早已不在页面上的演示
                Viz.currentId = null;
                if (first) Viz.activate(first);
                else Viz.renderNav();

                window.addEventListener('hashchange', onHashChange);
            })
            .catch((err) => {
                console.error(err);
                if (alive) setStatus('error');
            });

        return () => {
            alive = false;
            window.removeEventListener('hashchange', onHashChange);

            // 停掉当前演示的动画循环 / 定时器，否则离开页面它还在后台跑
            const Viz = window.Viz;
            if (Viz) {
                const cur = Viz.demos.find((d) => d.id === Viz.currentId);
                if (cur && typeof cur.unmount === 'function') cur.unmount();
                Viz.currentId = null;
                Viz.dom = {};
            }

            link.remove();
        };
    }, []);

    return (
        <div className="viz-shell">
            <div className="app-layout">
                {/* 左侧：分类折叠导航（内容由 core.js 的 renderNav 填充） */}
                <aside className="sidebar" id="sidebar" ref={sidebarRef}>
                    <div className="sidebar-header">
                        <h2><i className="fas fa-wave-square" /> 演示列表</h2>
                    </div>
                    <ul className="demo-list" id="demo-list" ref={navRef} />
                    {status === 'loading' && <Loading text="正在载入演示…" />}
                    <div className="sidebar-foot">
                        <p>点分类展开子菜单。每个演示都能自己调参数，边点边看流程怎么走。</p>
                    </div>
                </aside>

                {/* 右侧：舞台 */}
                <div className="main">
                    <header className="main-header">
                        <Link to="/" className="home-link" title="返回工具箱主页">
                            <i className="fas fa-arrow-left" /> <span>工具箱</span>
                        </Link>
                        <button
                            type="button"
                            className="icon-btn"
                            title="展开/收起列表"
                            onClick={() => sidebarRef.current?.classList.toggle('collapsed')}
                        >
                            <i className="fas fa-bars" />
                        </button>
                        <div className="header-titles">
                            <h1 id="stage-title" ref={titleRef}>知识可视化</h1>
                            <p id="stage-blurb" ref={blurbRef} />
                        </div>
                        <div className="brand">知识可视化</div>
                    </header>

                    {status === 'loading' && (
                        <Loading block text="正在下载 30 个演示的脚本，第一次会久一点…" />
                    )}
                    {status === 'error' && (
                        <p className="u-msg u-msg-error">
                            <i className="fas fa-circle-xmark" /> 演示脚本加载失败，刷新页面重试。
                        </p>
                    )}
                    {/* 舞台一直挂在树上：core.js 拿的是它的 ref，
                        条件渲染会让脚本跑完时指向一个已经被摘掉的节点 */}
                    <main className="stage" id="stage" ref={stageRef} />
                </div>
            </div>
        </div>
    );
}
