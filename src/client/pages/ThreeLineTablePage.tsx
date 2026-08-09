// 三线表工具的入口。
//
// 上一版是 Next.js 的服务端组件，首屏直接读库渲染；换成 SPA 之后
// 改为挂载时拉一次 /api/table-bootstrap（列表 + 该打开的表 + 导出倍率一次拿全），
// 拿到之前先占个位。编辑器本身是非受控的 contenteditable，
// 必须等数据到齐再挂载，否则首帧空 HTML 会被记进撤销栈。

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import TableEditor from '@/components/table/TableEditor';
import Loading from '@/components/Loading';
import type { TableFull, TableSummary } from '../../shared/types';

interface Bootstrap {
    tables: TableSummary[];
    table: TableFull;
    exportScale: number;
}

export default function ThreeLineTablePage() {
    const [data, setData] = useState<Bootstrap | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        document.title = '学术三线表生成工具 | Academic Table Generator';
        let alive = true;
        fetch('/api/table-bootstrap')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`加载失败（${r.status}）`))))
            .then((d: Bootstrap) => { if (alive) setData(d); })
            .catch((e: Error) => { if (alive) setError(e.message); });
        return () => { alive = false; };
    }, []);

    if (error) {
        return (
            <div className="tt-shell tt-boot">
                <p className="tt-boot-bad"><i className="fas fa-circle-xmark" /> {error}</p>
                <p><Link to="/">← 返回工具箱</Link></p>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="tt-shell tt-boot">
                <Loading text="正在从本机数据库读取表格…" />
            </div>
        );
    }

    return (
        <TableEditor
            initialTables={data.tables}
            initialTable={data.table}
            initialExportScale={data.exportScale}
        />
    );
}
