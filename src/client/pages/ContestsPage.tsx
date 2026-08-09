// 编程比赛：纯外链，数据在 lib/site-data.ts 的 contests。
//
// 分两组不是按国别也不是按难度，而是按「比的是什么」：
// 算法竞赛比谁的解法更对更快，前端挑战比谁做得更好看 —— 这两件事根本不是
// 同一种活动，混在一张列表里会让人以为 CodePen 也要写 DSA。

import { useEffect } from 'react';
import AppShell from '@/components/AppShell';
import { contests, type Contest } from '@/lib/site-data';

export default function ContestsPage() {
    useEffect(() => { document.title = '编程比赛 · 工具箱'; }, []);

    const algo = contests.filter((c) => c.cat === 'algo');
    const web = contests.filter((c) => c.cat === 'web');
    const live = contests.filter((c) => !c.paused).length;

    return (
        <AppShell title="编程比赛" subtitle="Programming Contests · 常年开赛的线上比赛">
            <p className="u-aside">
                <i className="fas fa-circle-info" />
                每一条的<b>赛程页都不用登录就能看</b>，比赛本身也都免费；
                真要下场提交代码，则需要各站自己的<b>免费账号</b> —— 门槛写在每条的「参赛」一栏里。
                共 {contests.length} 个平台，其中 {live} 个当前正常开赛（{contests[0].verified} 逐个核实）。
            </p>

            <div className="u-head">
                <h2><i className="fas fa-bolt" /> 算法竞赛</h2>
                <span className="count u-num">{algo.length} 个</span>
            </div>
            <p className="u-note">
                限时做题、按通过数与罚时排名，多数带 Rating。
                <b>入门从 AtCoder ABC 或牛客小白月赛开始</b>最不容易劝退；
                只想练大厂面试手感的，<b>直接打力扣周赛</b>比拼 Codeforces 名次划算。
            </p>
            <ContestList items={algo} />

            <div className="u-head">
                <h2><i className="fas fa-palette" /> 前端创意挑战</h2>
                <span className="count u-num">{web.length} 个</span>
            </div>
            <p className="u-note">没有标准答案，也没有 Rating，交的是作品不是解法。</p>
            <ContestList items={web} />
        </AppShell>
    );
}

function ContestList({ items }: { items: Contest[] }) {
    if (items.length === 0) return <p className="u-empty">这一组暂时是空的。</p>;

    return (
        <ul className="link-list">
            {items.map((c) => (
                <li key={c.href}>
                    <a className="link-row" href={c.href} target="_blank" rel="noopener noreferrer">
                        <span className="link-icon"><i className={'fas ' + c.icon} /></span>

                        <span className="link-main">
                            <span className="link-titles">
                                <b>{c.title}</b>
                                <em>{c.en}</em>
                            </span>

                            {/* 暂停的放在描述之前 —— 这条信息决定要不要往下读 */}
                            {c.paused && (
                                <span className="contest-paused">
                                    <i className="fas fa-pause" />
                                    {c.paused}
                                </span>
                            )}

                            <span className="link-desc">{c.desc}</span>

                            <span className="contest-facts">
                                <span><i className="fas fa-calendar-day" />{c.cadence}</span>
                                <span><i className="fas fa-language" />{c.lang}</span>
                                <span><i className="fas fa-right-to-bracket" />{c.join}</span>
                            </span>

                            <span className="link-meta">
                                <span className="link-host">
                                    <i className="fas fa-arrow-up-right-from-square" />
                                    {c.site}
                                </span>
                                {c.badges.map((b) => <span key={b} className="tool-badge">{b}</span>)}
                            </span>
                        </span>

                        <span className="link-go" aria-hidden="true">
                            <i className="fas fa-arrow-up-right-from-square" />
                        </span>
                    </a>
                </li>
            ))}
        </ul>
    );
}
