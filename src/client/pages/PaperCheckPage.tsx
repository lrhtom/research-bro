// 论文相关：写论文这条线上要用到的东西的集散地。
//
// 跟站里其他页不同的两点：
//   1. 站内工具和外部服务摆在同一页。三线表是自建的、跑在本机，
//      外面那几个是第三方 —— 所以分成两组，「你的文件去哪儿」一眼分得清。
//   2. 允许收要账号、要付费的服务（全站只有这一页）。代价是门槛必须
//      写在脸上：每条按 access 分组，行内再挂一个门槛标签。
//
// 三线表的说明不在这儿重写，直接从 tools 里取那一条 —— 同一份文案
// 抄两遍，迟早有一处改了另一处没改。

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { paperTools, toolsUnder, type PaperTool } from '@/lib/site-data';

/** 挂在这一页底下的站内工具（在 site-catalog 里用 parent 声明） */
const HERE = '/tools/paper-check';

/** 三档门槛各自的说法与图标；safe 只给「点开就能用」的那一档 */
const ACCESS: Record<PaperTool['access'], { label: string; icon: string; safe: boolean }> = {
    free: { label: '免登录免费', icon: 'fa-lock-open', safe: true },
    account: { label: '需注册账号', icon: 'fa-user-lock', safe: false },
    paid: { label: '需付费订阅', icon: 'fa-credit-card', safe: false },
};

export default function PaperCheckPage() {
    useEffect(() => { document.title = '论文相关 · 工具箱'; }, []);

    const inSite = toolsUnder(HERE);
    const free = paperTools.filter((p) => p.access === 'free');
    const gated = paperTools.filter((p) => p.access !== 'free');

    return (
        <AppShell title="论文相关" subtitle="Paper Toolkit · 写论文这条线上要用的">
            <p className="u-aside">
                <i className="fas fa-circle-info" />
                分两截看：<b>站内工具</b>跑在本机、数据存本地 SQLite；
                <b>外部服务</b>是第三方，本站只做整理与跳转，<b>不经手你的论文</b>。
                这一页也是全站唯一<b>允许收录要账号、要付费的服务</b>的地方 ——
                门槛直接标在每一条上，点进去之前先看清楚。
            </p>

            {inSite.length > 0 && (
                <>
                    <div className="u-head">
                        <h2><i className="fas fa-house-laptop" /> 站内工具</h2>
                        <span className="count u-num">{inSite.length} 个</span>
                    </div>
                    <p className="u-note">自己写的，跑在这台机器上，文件不出本机。这些工具只在这一页有入口，首页和侧栏不再单独占一格。</p>
                    <ul className="link-list">
                        {inSite.map((t) => (
                            <li key={t.href}>
                                <Link className="link-row" to={t.href}>
                                    <span className="link-icon"><i className={'fas ' + t.icon} /></span>
                                    <span className="link-main">
                                        <span className="link-titles">
                                            <b>{t.title}</b>
                                            <em>{t.subtitle}</em>
                                        </span>
                                        <span className="link-desc">{t.desc}</span>
                                        <span className="link-meta">
                                            <span className="link-host is-safe">
                                                <i className="fas fa-shield-halved" />
                                                本机
                                            </span>
                                            {t.badges.map((b) => <span key={b} className="tool-badge">{b}</span>)}
                                        </span>
                                    </span>
                                    <span className="link-go" aria-hidden="true">
                                        <i className="fas fa-arrow-right" />
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </>
            )}

            {/* 分组都是有才显示 —— 空着一个「0 个」的框只会让人以为页面加载坏了 */}
            {free.length > 0 && (
                <>
                    <div className="u-head">
                        <h2><i className="fas fa-lock-open" /> 外部服务 · 点开就能用</h2>
                        <span className="count u-num">{free.length} 个</span>
                    </div>
                    <p className="u-note">不用注册、不用付钱，跟站里其他外链一个标准；有免费额度上限的会标出来。</p>
                    <LinkList items={free} />
                </>
            )}

            {gated.length > 0 && (
                <>
                    <div className="u-head">
                        <h2><i className="fas fa-user-lock" /> 外部服务 · 需要账号或付费</h2>
                        <span className="count u-num">{gated.length} 个</span>
                    </div>
                    <p className="u-note">
                        没有账号的话点过去只能看到介绍页，<b>用不了</b>。具体门槛看每条右边的标签。
                    </p>
                    <LinkList items={gated} />
                </>
            )}

            <p className="u-note">
                <i className="fas fa-circle-info" />{' '}
                <b>AI 检测的结果只能当参考</b>。这类工具对人写的文本也会误报，
                非母语作者、以及格式高度固定的段落（方法、公式推导、参考文献）尤其容易被判成 AI。
                拿它做自查可以，别拿一个百分比当结论。
            </p>
            <p className="u-note">
                <i className="fas fa-triangle-exclamation" />{' '}
                这一页同时放着<b>一个 AI 检测器和一个专门绕过 AI 检测器的工具</b>，两者互为对手，
                都留着是为了自查时两边都能看到。用途自己拿捏 ——
                改写工具官网点名的绕过对象里包含 <b>Turnitin</b>，那是学校判定学术不端用的系统。
            </p>
        </AppShell>
    );
}

function LinkList({ items }: { items: PaperTool[] }) {
    return (
        <ul className="link-list">
            {items.map((p) => {
                const gate = ACCESS[p.access];
                return (
                    <li key={p.href}>
                        <a className="link-row" href={p.href} target="_blank" rel="noopener noreferrer">
                            <span className="link-icon"><i className={'fas ' + p.icon} /></span>

                            <span className="link-main">
                                <span className="link-titles">
                                    <b>{p.title}</b>
                                    <em>{p.en}</em>
                                </span>
                                <span className="link-desc">{p.desc}</span>
                                <span className="link-meta">
                                    <span className={'link-host' + (gate.safe ? ' is-safe' : '')}>
                                        <i className={'fas ' + gate.icon} />
                                        {p.site} · {gate.label}
                                    </span>
                                    {p.badges.map((b) => <span key={b} className="tool-badge">{b}</span>)}
                                    <span className="tool-badge">{p.verified} 核验</span>
                                </span>
                            </span>

                            <span className="link-go" aria-hidden="true">
                                <i className="fas fa-arrow-up-right-from-square" />
                            </span>
                        </a>
                    </li>
                );
            })}
        </ul>
    );
}
