// 网课大全：纯外链，数据在 lib/site-data.ts 的 courses / courseCats。

import { useEffect } from 'react';
import AppShell from '@/components/AppShell';
import CourseList from '@/components/CourseList';
import { courses } from '@/lib/site-data';

export default function CoursesPage() {
    useEffect(() => { document.title = '网课大全 · 工具箱'; }, []);

    const official = courses.filter((c) => c.source === 'official').length;

    return (
        <AppShell title="网课大全" subtitle="CS Course Collection · 名校计算机公开课">
            <p className="u-aside">
                <i className="fas fa-circle-check" />
                每一条都在 <b>2026-08-01</b> 亲手打开确认过：<b>免费、免登录、点开就能看</b>。
                共 {courses.length} 门，其中 <b>{official} 门</b>来自学校官方频道 ——
                搬运源随时可能被删，官方频道更稳，列表里标了出来。
            </p>

            <CourseList />
        </AppShell>
    );
}
