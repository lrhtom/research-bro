// ============================================================
//  JSON 导入的解析与规范化
//
//  前后端共用：前端拿它做导入预览，后端拿它做最终校验。
//  刻意写得宽容一些 —— 手头的卡片 JSON 十有八九是从别处导出来的，
//  字段名五花八门，不该为了字段叫 question 还是 front 就让人手改文件。
//
//  接受的形状：
//    [ {front, back}, ... ]
//    { cards: [ ... ] }
//    { name, description, dailyNewLimit, cards: [ ... ] }
//  单张卡的字段别名：
//    正面：front / question / q / term / 正面 / 问题 / 正
//    背面：back / answer / a / definition / 背面 / 答案 / 反
// ============================================================

export interface ImportedCard {
    front: string;
    back: string;
}

export interface ImportedDeck {
    name?: string;
    description?: string;
    dailyNewLimit?: number;
    cards: ImportedCard[];
}

export interface ImportParseResult {
    ok: boolean;
    error?: string;
    warnings: string[];
    deck?: ImportedDeck;
}

const FRONT_KEYS = ['front', 'question', 'q', 'term', '正面', '问题', '正'];
const BACK_KEYS = ['back', 'answer', 'a', 'definition', '背面', '答案', '反'];

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim() !== '') return v;
        if (typeof v === 'number') return String(v);
    }
    return null;
}

/** 从任意解析好的 JSON 值里抽出一副牌组 */
export function normalizeDeck(data: unknown): ImportParseResult {
    const warnings: string[] = [];

    let rawCards: unknown;
    let meta: Record<string, unknown> = {};

    if (Array.isArray(data)) {
        rawCards = data;
    } else if (data && typeof data === 'object') {
        meta = data as Record<string, unknown>;
        rawCards = meta.cards ?? meta.notes ?? meta.items ?? meta.卡片;
    } else {
        return { ok: false, error: '文件内容既不是数组也不是对象。', warnings };
    }

    if (!Array.isArray(rawCards)) {
        return { ok: false, error: '没找到卡片数组（顶层数组，或对象里的 cards 字段）。', warnings };
    }

    const cards: ImportedCard[] = [];
    rawCards.forEach((raw, i) => {
        if (typeof raw === 'string') {
            // 允许 ["正面\t背面", ...] 或 ["正面 | 背面", ...] 这种极简写法
            const parts = raw.split(/\t|\s*\|\s*/);
            if (parts.length >= 2 && parts[0].trim()) {
                cards.push({ front: parts[0].trim(), back: parts.slice(1).join(' | ').trim() });
            } else {
                warnings.push(`第 ${i + 1} 条是一行没法拆成正反面的文本，已跳过`);
            }
            return;
        }
        if (!raw || typeof raw !== 'object') {
            warnings.push(`第 ${i + 1} 条不是对象，已跳过`);
            return;
        }
        const obj = raw as Record<string, unknown>;
        const front = pick(obj, FRONT_KEYS);
        const back = pick(obj, BACK_KEYS);
        if (!front) {
            warnings.push(`第 ${i + 1} 条没有正面内容，已跳过`);
            return;
        }
        cards.push({ front: front.trim(), back: (back ?? '').trim() });
    });

    if (cards.length === 0) {
        return { ok: false, error: '没解析出任何可用的卡片。', warnings };
    }

    const name = typeof meta.name === 'string' ? meta.name
        : typeof meta.title === 'string' ? meta.title
            : typeof meta.名称 === 'string' ? meta.名称 : undefined;

    const description = typeof meta.description === 'string' ? meta.description
        : typeof meta.说明 === 'string' ? meta.说明 : undefined;

    const rawLimit = meta.dailyNewLimit ?? meta.daily_new_limit ?? meta.每日新卡;
    const dailyNewLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(0, Math.floor(rawLimit))
        : undefined;

    return { ok: true, warnings, deck: { name, description, dailyNewLimit, cards } };
}

/** 从一段文本解析（先 JSON.parse，再规范化） */
export function parseDeckText(text: string): ImportParseResult {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (err) {
        return {
            ok: false,
            warnings: [],
            error: '不是合法的 JSON：' + (err instanceof Error ? err.message : String(err)),
        };
    }
    return normalizeDeck(data);
}
