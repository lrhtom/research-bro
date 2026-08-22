// 记忆卡界面里的一堆小格式化函数

/** 把「从现在到 due」说成人话：3 分钟后 / 2 天后 / 1.5 个月后 */
export function untilText(due: string, now = new Date()): string {
    const ms = new Date(due).getTime() - now.getTime();
    if (ms <= 0) return '现在';
    const min = ms / 60000;
    if (min < 60) return `${Math.max(1, Math.round(min))} 分钟后`;
    const hours = min / 60;
    if (hours < 24) return `${Math.round(hours)} 小时后`;
    const days = hours / 24;
    if (days < 30) return `${days < 1.5 ? 1 : Math.round(days)} 天后`;
    const months = days / 30.44;
    if (months < 12) return `${months.toFixed(1)} 个月后`;
    return `${(days / 365.25).toFixed(1)} 年后`;
}

/** 用时：42 秒 / 3 分 12 秒 / 1 小时 5 分 */
export function durationText(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

export function dateText(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
    });
}

export const STATE_LABELS: Record<string, string> = {
    new: '新卡',
    learning: '学习中',
    review: '复习',
    relearning: '重新学习',
};

// ---------- 算法题库（OJ）用到的两个 ----------

/** 体积：512 B / 12.3 KB / 4.1 MB。测试点大小、输入输出体积都用它。 */
export function bytesText(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 判题耗时：87 ms / 1.24 s。
 *
 * 跟上面的 durationText 分开：那个是给「学了 3 分 12 秒」用的，最小单位是秒；
 * 判题这边一整道题也就几百毫秒，取整到秒全成了「0 秒」。
 */
export function msText(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
