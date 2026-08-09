// ============================================================
//  全站统一的加载态
//
//  统一它的理由不是好看，是**别让人以为页面坏了**：
//  在这之前，好几个页面在数据到之前什么都不画 —— 库大一点、机器慢一点，
//  看到的就是一整片空白，分不清是「在加载」「没数据」还是「崩了」。
//
//  两种形态，按「框架画出来没有」分：
//    · <Loading>  —— 整页还没有内容时用，一行「转圈 + 在做什么」
//    · <Skeleton> —— 框架已经在了、只差那一块列表时用，占住位置不让页面跳
//
//  两个都带 role="status"，读屏会念出来；骨架屏在 prefers-reduced-motion
//  下不闪。
// ============================================================

interface LoadingProps {
    /** 说清楚在等什么 —— 「加载中」等于没说 */
    text?: string;
    /** 整页级：给一块带虚线边的区域，而不是孤零零一行字 */
    block?: boolean;
}

export default function Loading({ text = '加载中…', block = false }: LoadingProps) {
    return (
        <p className={'u-loading' + (block ? ' is-block' : '')} role="status" aria-live="polite">
            <i className="fas fa-spinner fa-spin" aria-hidden="true" />
            {text}
        </p>
    );
}

interface SkeletonProps {
    /** 画几条占位行。按真实内容大概几行来给，差太多反而更晃眼 */
    rows?: number;
    className?: string;
    /** 读屏念什么 */
    label?: string;
}

export function Skeleton({ rows = 3, className = '', label = '加载中' }: SkeletonProps) {
    return (
        <div className={'u-skeleton ' + className} role="status" aria-live="polite" aria-label={label}>
            {Array.from({ length: rows }, (_, i) => <span key={i} className="u-skeleton-row" />)}
        </div>
    );
}
