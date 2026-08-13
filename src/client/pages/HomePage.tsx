// 首页：工具索引。
// 卡片数据在 lib/site-data.ts 的 tools，那个文件同时也是网课页、
// 格式转换页和搜索的数据源，改一处四处生效。

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import AppShell from '@/components/AppShell';
import { converters, courses, demos, tools, topTools } from '@/lib/site-data';

export default function HomePage() {
    useEffect(() => { document.title = '工具箱 · 在线工具与可视化演示'; }, []);

    // flatNav：首页的顶栏融进页面底色。首页本身就是一张长列表，
    // 顶栏再画一条边会把它切成两截
    return (
        <AppShell title="工具箱" subtitle="Toolbox · 在线工具与可视化演示" flatNav>
            <p className="u-aside home-lead">
                自建的几件工具都跑在本机，数据存本地 SQLite，不经过任何服务器；
                收录的外部链接<b>逐条打开验证过</b>，默认都是<b>免登录、免费</b>的，
                个别需要账号或付费的（都在「论文相关」里）会把门槛标在卡片上。
            </p>

            <div className="u-head">
                {/* 不叫「全部工具」：三线表这类挂在别的页底下的不列在这儿，
                    而下面「站内收录」的自建工具数是把它们算进去的 ——
                    两个数字不一样，标题就不能说「全部」 */}
                <h2><i className="fas fa-toolbox" /> 工具入口</h2>
                <span className="count u-num">{topTools.length} 个</span>
            </div>

            {/* 排成一列有编号的条目，而不是一格格的卡片：
                工具只有六个，列表比网格更快扫完，也留得下足够的说明文字 */}
            <ol className="tool-list">
                {topTools.map((t, i) => (
                    <li key={t.href} className="u-rise" style={{ animationDelay: `${i * 45}ms` }}>
                        <Link className="tool-row" to={t.href}>
                            <span className="tool-index u-num">{String(i + 1).padStart(2, '0')}</span>
                            <span className="tool-icon"><i className={'fas ' + t.icon} /></span>

                            <span className="tool-main">
                                <span className="tool-titles">
                                    <b>{t.title}</b>
                                    <em>{t.subtitle}</em>
                                </span>
                                <span className="tool-desc">{t.desc}</span>
                                <span className="tool-badges">
                                    {t.badges.map((b) => <span key={b} className="tool-badge">{b}</span>)}
                                </span>
                            </span>

                            <span className="tool-go" aria-hidden="true">
                                <i className="fas fa-arrow-right" />
                            </span>
                        </Link>
                    </li>
                ))}
            </ol>

            <div className="u-head">
                <h2><i className="fas fa-database" /> 站内收录</h2>
            </div>
            <dl className="home-stats">
                <div>
                    <dt>可视化演示</dt>
                    <dd className="u-num">{demos.length}</dd>
                </div>
                <div>
                    <dt>公开课</dt>
                    <dd className="u-num">{courses.length}</dd>
                </div>
                <div>
                    <dt>转换服务</dt>
                    <dd className="u-num">{converters.length}</dd>
                </div>
                <div>
                    <dt>自建工具</dt>
                    <dd className="u-num">{tools.length}</dd>
                </div>
            </dl>
        </AppShell>
    );
}
