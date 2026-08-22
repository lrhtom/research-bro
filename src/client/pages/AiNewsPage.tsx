// AI 资讯：纯外链，数据在 lib/site-data.ts 的 newsSites。
//
// 这一页跟站里其他外链页是**两种东西**，别照着它们的密度来看：
// 格式转换、免费素材、编程比赛都是目录 —— 你有事要办才打开，进去挑一个；
// 这一页是每天去一次的固定目的地，不存在「挑」这个动作。
//
// 所以它只有一条，而且这是设计而不是没写完：目录里多一条冷门条目最多是噪音，
// 每日信息源多一条就是每天多花一份注意力。页面底部把收录标准写出来，
// 一是解释这一页为什么这么空，二是下次想加的时候有个尺子可量。
//
// 布局上不套「一大堆卡片」的壳：单独一条外链撑不起一页列表，
// 所以借编程比赛那套 .link-entries —— 把这个站的几个入口（日报 / 周报 /
// 模型榜 / 热点榜）摊在卡里，让人直接跳到想去的那一层，而不是先落到首页再自己找。

import { useEffect } from 'react';
import AppShell from '@/components/AppShell';
import { newsSites, type NewsSite } from '@/lib/site-data';

export default function AiNewsPage() {
    useEffect(() => { document.title = 'AI 资讯 · 工具箱'; }, []);

    const lastVerified = newsSites.reduce((a, n) => (n.verified > a ? n.verified : a), '');

    return (
        <AppShell title="AI 资讯" subtitle="AI News Digest · 每天跟进这一条就够">
            <p className="u-aside">
                <i className="fas fa-circle-info" />
                这一页跟站里其他外链页不是一回事：那些是<b>目录</b>，有事要办才打开、进去挑一个；
                这一页是<b>每天去一次的固定目的地</b>。所以它不追求收得多 ——
                目录里多一条冷门条目最多是噪音，每日信息源多一条就是每天多花一份注意力。
                {newsSites.length === 1 ? '目前就一条，够用。' : `目前 ${newsSites.length} 条。`}
                最近一次打开核实 {lastVerified}。
            </p>

            {newsSites.map((n) => <NewsCard key={n.href} n={n} />)}

            <p className="u-note">
                <i className="fas fa-list-check" />{' '}
                <b>要加第二条得过这三关</b>（在全站那三条「免登录、免费、亲自验证过」之上）：
                <b>有人替你筛过</b> —— 纯 RSS 聚合器不收，那只是把信息过载搬了个地方；
                <b>标得出信源</b> —— 每条能追到原始出处，不是无出处的二手转述；
                <b>真的每天更新</b> —— 翻得到连续的历史存档，不是发了三期就停的。
                三关都过了再说，宁可这一页一直只有一条。
            </p>
        </AppShell>
    );
}

/**
 * 一个资讯站。
 *
 * 整卡不是一个大链接，几个入口各自可点 —— 理由跟编程比赛页的力扣那条一样：
 * 多个目的地却只有一个点击区，点下去到底去哪儿全靠猜，而且 <a> 套 <a>
 * 本身就不是合法的 HTML。
 */
function NewsCard({ n }: { n: NewsSite }) {
    return (
        <ul className="link-list">
            <li>
                <div className="link-row is-multi">
                    <span className="link-icon"><i className={'fas ' + n.icon} /></span>

                    <span className="link-main">
                        <span className="link-titles">
                            <b>{n.title}</b>
                            <em>{n.en}</em>
                        </span>

                        <span className="link-desc">{n.desc}</span>

                        {/* 作者跟节奏拎出来单独一行：资讯类跟工具类不同，
                            编辑口味决定了你每天看到什么，作者是谁不能只写在描述里 */}
                        <span className="contest-facts">
                            <span><i className="fas fa-user-pen" />{n.author}</span>
                            <span><i className="fas fa-clock" />{n.cadence}</span>
                            <span><i className="fas fa-arrow-up-right-from-square" />{n.site}</span>
                        </span>

                        <span className="link-meta">
                            {n.badges.map((b) => <span key={b} className="tool-badge">{b}</span>)}
                            <span className="tool-badge">{n.verified} 核验</span>
                        </span>
                    </span>

                    <div className="link-entries">
                        {n.entries.map((e) => (
                            <a
                                key={e.href}
                                className="link-entry"
                                href={e.href}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <b>{e.label}</b>
                                <em>{e.desc}</em>
                                <i className="fas fa-arrow-up-right-from-square" />
                            </a>
                        ))}
                    </div>
                </div>
            </li>
        </ul>
    );
}
