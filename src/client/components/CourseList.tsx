// 网课列表 + 分类过滤条。数据在 lib/site-data.ts 的 courses / courseCats。

import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { courseCats, courses, demos, type Course } from '@/lib/site-data';

/** 演示 id → 标题，用来把课程和站内可视化演示串起来 */
const demoTitle: Record<string, string> = Object.fromEntries(demos.map((d) => [d.id, d.t]));

/** 来源标记：官方频道 vs 第三方搬运。这个区别对能不能长期看到很关键 */
function SourceTag({ c }: { c: Course }) {
    return c.source === 'official' ? (
        <span className="src src-off"><i className="fas fa-circle-check" /> 官方频道</span>
    ) : (
        <span className="src src-mir"><i className="fas fa-circle-exclamation" /> 第三方搬运</span>
    );
}

/** 课程关联的站内可视化演示，点了直接跳到那个演示 */
function PairChips({ c }: { c: Course }) {
    const list = c.pairs.filter((id) => demoTitle[id]);
    if (!list.length) return null;
    return (
        <div className="pairs">
            <span className="pairs-h"><i className="fas fa-wave-square" /> 配合本站演示食用</span>
            <span className="pairs-list">
                {list.map((id) => (
                    <Link key={id} className="pair" to={`/tools/visualizations#demo=${id}`}>
                        {demoTitle[id]}
                    </Link>
                ))}
            </span>
        </div>
    );
}

export default function CourseList() {
    const [active, setActive] = useState('all');

    const list = useMemo(
        () => (active === 'all' ? courses : courses.filter((c) => c.cat === active)),
        [active],
    );

    const catButtons = [
        { id: 'all', icon: 'fa-layer-group', name: '全部', n: courses.length },
        ...courseCats
            .map((c) => ({ ...c, n: courses.filter((x) => x.cat === c.id).length }))
            .filter((c) => c.n > 0),
    ];

    return (
        <>
            <div className="cat-bar" id="cat-bar">
                {catButtons.map((b) => (
                    <button
                        key={b.id}
                        type="button"
                        className={'u-chip' + (active === b.id ? ' is-on' : '')}
                        onClick={() => setActive(b.id)}
                    >
                        <i className={'fas ' + b.icon} /> {b.name}
                        <span className="cat-n u-num">{b.n}</span>
                    </button>
                ))}
            </div>

            <div className="u-head">
                <h2><i className="fas fa-graduation-cap" /> 课程列表</h2>
                <span className="count u-num">
                    {active === 'all' ? `${courses.length} 门` : `${list.length} / ${courses.length} 门`}
                </span>
            </div>

            <div className="course-grid" id="course-grid">
                {list.map((c, i) => (
                    <article
                        key={c.code}
                        className={'course cat-' + c.cat}
                        style={{ animationDelay: i * 70 + 'ms' }}
                    >
                        <div className="course-top">
                            <span className="code">{c.code}</span>
                            <SourceTag c={c} />
                        </div>
                        <h3 className="course-t">{c.title}</h3>
                        <p className="course-en">{c.en}</p>
                        <ul className="meta">
                            <li><i className="fas fa-building-columns" />{c.school}</li>
                            <li><i className="fas fa-calendar" />{c.term}</li>
                            <li><i className="fas fa-language" />{c.lang}</li>
                            <li><i className="fas fa-tv" />{c.channel}</li>
                        </ul>
                        <p className="course-d">{c.desc}</p>
                        <PairChips c={c} />
                        <div className="course-foot">
                            <span className="verified">
                                <i className="fas fa-shield-halved" /> {c.verified} 已验证
                            </span>
                            <a className="go" href={c.href} target="_blank" rel="noopener noreferrer">
                                前往观看 <i className="fas fa-arrow-up-right-from-square" />
                            </a>
                        </div>
                    </article>
                ))}
            </div>
        </>
    );
}
