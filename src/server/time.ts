// ============================================================
//  日历日边界
//
//  「今天」必须按用户时区的**日历日**切，不是滚动 24 小时窗口 ——
//  23:55 评的卡和 00:05 评的卡分属两天。整套进度统计都建立在这上面。
//
//  只用 Intl，不引时区库：Node 自带完整的 IANA 数据库，够用。
// ============================================================

const DAY_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
const PART_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
    let f = DAY_FMT_CACHE.get(timeZone);
    if (!f) {
        // en-CA 的短日期格式正好是 YYYY-MM-DD
        f = new Intl.DateTimeFormat('en-CA', {
            timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        });
        DAY_FMT_CACHE.set(timeZone, f);
    }
    return f;
}

function partFormatter(timeZone: string): Intl.DateTimeFormat {
    let f = PART_FMT_CACHE.get(timeZone);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        PART_FMT_CACHE.set(timeZone, f);
    }
    return f;
}

/** 某个瞬间在目标时区的 UTC 偏移（毫秒）。夏令时切换处会自动跟着变。 */
function offsetMs(at: Date, timeZone: string): number {
    const parts = Object.fromEntries(
        partFormatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]),
    ) as Record<string, string>;

    // 把「这一瞬间在目标时区显示的墙上时间」当作 UTC 解析，
    // 与真实 UTC 时刻之差就是该时区此刻的偏移
    const asUtc = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** 用户时区下的日历日，形如 2026-08-08 */
export function calendarDay(at: Date, timeZone: string): string {
    return dayFormatter(timeZone).format(at);
}

/** 该瞬间所属日历日的起点（当地午夜）对应的 UTC 时刻 */
export function startOfDay(at: Date, timeZone: string): Date {
    const [y, m, d] = calendarDay(at, timeZone).split('-').map(Number);
    const localMidnightAsUtc = Date.UTC(y, m - 1, d);

    // 先用「此刻的偏移」估一次，再用估出来的时刻重算偏移。
    // 两步是为了处理午夜前后正好跨夏令时切换的情况。
    let guess = localMidnightAsUtc - offsetMs(at, timeZone);
    guess = localMidnightAsUtc - offsetMs(new Date(guess), timeZone);
    return new Date(guess);
}

/**
 * 该瞬间所属日历日的**上界（不含）**，也就是下一个当地午夜。
 * 判断「是不是今天的事」一律用 [startOfDay, endOfDay) 这个半开区间。
 */
export function endOfDay(at: Date, timeZone: string): Date {
    const start = startOfDay(at, timeZone);
    // 加 26 小时保证无论怎么调夏令时都落到「下一天」里，再取那一天的起点
    return startOfDay(new Date(start.getTime() + 26 * 3600_000), timeZone);
}

/**
 * 前一个日历日的起点。
 *
 * 不能直接减 86400000 —— 夏令时切换那天只有 23 小时（或 25 小时），
 * 减固定的 24 小时会跳过一天或原地踏步。往回退 12 小时一定落在前一天之内
 * （偏移调整最多两三个小时），再取那一天的起点就稳了。
 */
export function startOfPrevDay(dayStart: Date, timeZone: string): Date {
    return startOfDay(new Date(dayStart.getTime() - 12 * 3600_000), timeZone);
}

/**
 * 最近 n 个日历日，从旧到新，最后一个是 `at` 所在的那天。
 * 中间**一天都不会漏** —— 统计图的横轴要靠它把没学习的空日也画出来。
 */
export function recentDays(n: number, at: Date, timeZone: string): string[] {
    const out: string[] = [];
    let cursor = startOfDay(at, timeZone);
    for (let i = 0; i < n; i++) {
        out.push(calendarDay(cursor, timeZone));
        cursor = startOfPrevDay(cursor, timeZone);
    }
    return out.reverse();
}

/**
 * 从 `at` 所在日历日开始，往后 n 天的**起点**，共 n + 1 个 ——
 * 第 i 个桶就是 [bounds[i], bounds[i + 1]) 这个半开区间。
 */
export function dayBounds(n: number, at: Date, timeZone: string): Date[] {
    const out: Date[] = [startOfDay(at, timeZone)];
    for (let i = 0; i < n; i++) out.push(endOfDay(out[out.length - 1], timeZone));
    return out;
}

/** 时区字符串是否被运行时认识；不认识就退回默认值，免得整个接口 500 */
export function normalizeTimeZone(tz: string | null | undefined, fallback = 'Asia/Shanghai'): string {
    if (!tz) return fallback;
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone: tz });
        return tz;
    } catch {
        return fallback;
    }
}
