// 编程比赛：纯外链，数据在 lib/site-data.ts 的 contests。
//
// 分组不是按国别也不是按难度，而是按「比的是什么」：算法赛比解法对不对、
// 快不快，前端挑战比做得好不好看，数据赛比模型准不准 —— 三件根本不同的事，
// 混在一张列表里会让人以为 CodePen 也要写 DSA、Kaggle 也是限时四道题。
//
// 「几个平台」那个数字从 contests.length 来，不写死：加一条就自动对上。

import { useEffect } from 'react';
import AppShell from '@/components/AppShell';
import { contests, type Contest } from '@/lib/site-data';

export default function ContestsPage() {
    useEffect(() => { document.title = '编程比赛 · 工具箱'; }, []);

    const algo = contests.filter((c) => c.cat === 'algo');
    const data = contests.filter((c) => c.cat === 'data');
    const web = contests.filter((c) => c.cat === 'web');
    const live = contests.filter((c) => !c.paused).length;
    // 取最新那一条的核验日期，不是第一条 —— 后加的条目会带更新的日期，
    // 写死取 [0] 的话页面会一直显示最早那次的日子
    const lastVerified = contests.reduce((a, c) => (c.verified > a ? c.verified : a), '');

    return (
        <AppShell title="编程比赛" subtitle="Programming Contests · 常年开赛的线上比赛">
            <p className="u-aside">
                <i className="fas fa-circle-info" />
                每一条的<b>赛程页都不用登录就能看</b>，比赛本身也都免费；
                真要下场提交代码，则需要各站自己的<b>免费账号</b> —— 门槛写在每条的「参赛」一栏里。
                共 {contests.length} 个平台，其中 {live} 个当前正常开赛（最近一次逐条核实 {lastVerified}）。
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
                <h2><i className="fas fa-chart-line" /> 数据 / 机器学习竞赛</h2>
                <span className="count u-num">{data.length} 个</span>
            </div>
            <p className="u-note">
                比的不是限时手速，而是模型效果：赛期以月计，随时可以提交，按榜单分数排名。
                <b>没有周赛这一说</b>，所以单独列一组 —— 不要拿它跟上面那几家的节奏比。
            </p>
            <ContestList items={data} />

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
            {items.map((c) => <ContestRow key={c.href} c={c} />)}
        </ul>
    );
}

/**
 * 一条比赛。
 *
 * 有两个官方入口的（力扣的国际站 / 中国站）走另一套壳子：整卡不再是一个大链接，
 * 改成在卡里并排放入口按钮。两个目的地却只有一个点击区的话，点下去到底
 * 去哪儿全靠猜；而且 <a> 里再套 <a> 本身就不是合法的 HTML。
 */
function ContestRow({ c }: { c: Contest }) {
    const body = (
        <>
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
                    {!c.entries && (
                        <span className="link-host">
                            <i className="fas fa-arrow-up-right-from-square" />
                            {c.site}
                        </span>
                    )}
                    {c.badges.map((b) => <span key={b} className="tool-badge">{b}</span>)}
                </span>
            </span>
        </>
    );

    if (!c.entries) {
        return (
            <li>
                <a className="link-row" href={c.href} target="_blank" rel="noopener noreferrer">
                    {body}
                    <span className="link-go" aria-hidden="true">
                        <i className="fas fa-arrow-up-right-from-square" />
                    </span>
                </a>
            </li>
        );
    }

    return (
        <li>
            <div className="link-row is-multi">
                {body}

                <div className="link-entries">
                    {c.entries.map((e) => (
                        <a
                            key={e.href}
                            className="link-entry"
                            href={e.href}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <b>{e.label}</b>
                            <em>{e.site}</em>
                            <i className="fas fa-arrow-up-right-from-square" />
                        </a>
                    ))}
                </div>
            </div>
        </li>
    );
}
