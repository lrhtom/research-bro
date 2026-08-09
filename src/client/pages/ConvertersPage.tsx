// 格式转换：纯外链，数据在 lib/site-data.ts 的 converters。

import { useEffect } from 'react';
import AppShell from '@/components/AppShell';
import { converters } from '@/lib/site-data';

export default function ConvertersPage() {
    useEffect(() => { document.title = '格式转换 · 工具箱'; }, []);

    // 「本地运行」的排前面：数据不出本机这件事，比转换质量更该先看到
    const local = converters.filter((c) => c.badges.some((b) => b.includes('本地')));
    const remote = converters.filter((c) => !c.badges.some((b) => b.includes('本地')));

    return (
        <AppShell title="格式转换" subtitle="Format Converters · 免注册的在线转换工具">
            <p className="u-aside">
                <i className="fas fa-triangle-exclamation" />
                全部是<b>第三方在线服务</b>，本站只做整理与跳转，<b>不经手你的任何文件</b>。
                每条都确认过免注册、免费、不限次数（{converters.length > 0 && converters[0].verified} 核验）。
                下面按<b>文件去哪儿</b>分成两组 —— 这是这一页最该先看清的一件事。
            </p>

            <div className="u-head">
                <h2><i className="fas fa-shield-halved" /> 在你自己的浏览器里算</h2>
                <span className="count u-num">{local.length} 个</span>
            </div>
            <p className="u-note">文件<b>不会离开这台电脑</b>，涉密内容也可以用。</p>
            <LinkList items={local} safe />

            <div className="u-head">
                <h2><i className="fas fa-cloud-arrow-up" /> 会把文件传到对方服务器</h2>
                <span className="count u-num">{remote.length} 个</span>
            </div>
            <p className="u-note">
                方便，但<b>文件会上传</b>。涉密或敏感内容请改用本地软件处理。
            </p>
            <LinkList items={remote} />
        </AppShell>
    );
}

function LinkList({ items, safe = false }: { items: typeof converters; safe?: boolean }) {
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
                            <span className="link-desc">{c.desc}</span>
                            <span className="link-meta">
                                <span className={'link-host' + (safe ? ' is-safe' : '')}>
                                    <i className={'fas ' + (safe ? 'fa-shield-halved' : 'fa-arrow-up-right-from-square')} />
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
