// ============================================================
//  英语口语练习：干扰项数据表 + 前后端共用的小工具
//
//  这个文件是「五个干扰开关」的唯一事实来源，前后端都从这里读：
//    · 服务端用 key 拼系统提示词（英文片段在 server/speaking-prompts.ts，不下发给浏览器）
//    · 客户端用 key 画开关，用 LABELS 显示中文
//  分成两个文件是有意的 —— 提示词永远只在服务端拼装，
//  客户端连自己发一份 system prompt 的机会都没有。
//
//  重要：这里没有任何跟发音有关的东西，将来也不许加。
//  整套功能只看得到文字（用户打的字，或浏览器语音识别猜的字），
//  从来没有听过用户的声音。
// ============================================================

/** 五个干扰开关。顺序固定 —— 拼提示词和算缓存键都靠它稳定。 */
export const INTERFERENCE_KEYS = [
    'accent', 'crosstalk', 'noise', 'audioquality', 'smalltalk',
] as const;

export type InterferenceKey = typeof INTERFERENCE_KEYS[number];

/** 每个开关的合法子选项（客户端的开关面板必须跟这里对齐） */
export const INTERFERENCE_SUBOPTIONS: Record<InterferenceKey, readonly string[]> = {
    accent: ['brummie', 'eastmidlands', 'scouse', 'geordie', 'cockney'],
    crosstalk: ['fast', 'interrupt', 'overlap'],
    noise: ['pub', 'canteen', 'office', 'street'],
    // 音质干扰：浏览器端还会拿它去调 TTS 的声音（见 lib/audio-effects.ts）
    audioquality: ['phone', 'muffled', 'radio'],
    // 只有开关，没有子选项
    smalltalk: [],
};

/** 归一化之后的形状：{开关: [子选项…]} */
export type Modifiers = Partial<Record<InterferenceKey, string[]>>;

/** 客户端收到的原始形状：新版对象、旧版数组都认 */
export type RawModifiers = Modifiers | string[] | Record<string, unknown> | null | undefined;

// ---------- 界面文案（中文，只给客户端用） ----------

export const INTERFERENCE_LABELS: Record<InterferenceKey, { title: string; hint: string; icon: string }> = {
    accent: {
        title: '地方口音',
        hint: '对方是有浓重地方口音的英国本地人，不说 BBC 标准音，会夹方言词',
        icon: 'fa-comment-dots',
    },
    crosstalk: {
        title: '语速与插话',
        hint: '母语者的正常语速，会打断你、会在你说话时搭腔',
        icon: 'fa-bolt',
    },
    noise: {
        title: '背景噪音',
        hint: '环境很吵，对方会听岔、会让你再说一遍（浏览器同时播放对应的环境音）',
        icon: 'fa-volume-high',
    },
    audioquality: {
        title: '音质劣化',
        hint: '像隔着电话线／墙／对讲机听，声音会被处理得更难听清',
        icon: 'fa-signal',
    },
    smalltalk: {
        title: '寒暄闲聊',
        hint: '会先聊两句天气近况，指望你也接得住；你太直接他会觉得怪',
        icon: 'fa-mug-hot',
    },
};

export const SUBOPTION_LABELS: Record<InterferenceKey, Record<string, string>> = {
    accent: {
        brummie: '伯明翰 Brummie',
        eastmidlands: '东米德兰 / 诺丁汉',
        scouse: '利物浦 Scouse',
        geordie: '纽卡斯尔 Geordie',
        cockney: '伦敦 Cockney',
    },
    crosstalk: {
        fast: '语速明显偏快',
        interrupt: '打断你、抢话',
        overlap: '你说话时不停搭腔（yeah yeah、mm-hm）',
    },
    noise: {
        pub: '嘈杂酒吧',
        canteen: '食堂餐具声',
        office: '开放式办公室',
        street: '车流街道',
    },
    audioquality: {
        phone: '电话听筒（窄频、发尖）',
        muffled: '隔墙闷响',
        radio: '对讲机沙沙声',
    },
    smalltalk: {},
};

// ---------- 场景预设 ----------
//
// scenario 是喂给模型的英文描述，label / desc 是界面上的中文。
// 分开写是因为提示词全篇英文时模型最稳，而界面得说人话。

export interface ScenarioPreset {
    key: string;
    label: string;
    desc: string;
    icon: string;
    scenario: string;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
    {
        key: 'flat',
        label: '看房',
        desc: '房东带你看一套出租房，你得问清押金、账单和能不能养宠物',
        icon: 'fa-house',
        scenario:
            'The learner is viewing a one-bedroom flat they saw advertised. You are the landlord showing '
            + 'them round. You are keen to let it quickly, a bit vague about the deposit and who pays the '
            + 'bills, and you would rather they did not ask about the damp patch in the bathroom.',
    },
    {
        key: 'gp',
        label: '看全科医生',
        desc: '10 分钟的 GP 门诊，你要在被打断之前说清症状',
        icon: 'fa-stethoscope',
        scenario:
            'The learner has a ten-minute GP appointment about a persistent cough. You are the GP: '
            + 'busy, running late, asking short clinical questions, and you will move things along if '
            + 'they ramble.',
    },
    {
        key: 'bank',
        label: '银行开户',
        desc: '柜台开户，对方要地址证明，而你刚搬来',
        icon: 'fa-building-columns',
        scenario:
            'The learner is opening a current account at a high-street bank branch. You are the counter '
            + 'staff. You need proof of address and ID, you have a script to follow, and you keep trying '
            + 'to mention the overdraft and the app.',
    },
    {
        key: 'refund',
        label: '无小票退货',
        desc: '想退一件没有小票的商品，店员按规定不能退',
        icon: 'fa-receipt',
        scenario:
            'The learner wants to return a jacket they bought three weeks ago but has lost the receipt. '
            + 'You are the shop assistant. Store policy says no receipt means no refund, only an exchange '
            + '— but you can be persuaded to check the card transaction if they ask the right way.',
    },
    {
        key: 'interview',
        label: '求职面试',
        desc: '正式面试，会追问细节，不接受空话',
        icon: 'fa-briefcase',
        scenario:
            'The learner is being interviewed for a junior role. You are the hiring manager: polite but '
            + 'probing, following up on vague answers with "can you give me a specific example?", and you '
            + 'will ask what questions they have for you at the end.',
    },
    {
        key: 'pub',
        label: '嘈杂酒吧点单',
        desc: '吧台很挤，酒保很忙，你只有一次说清楚的机会',
        icon: 'fa-beer-mug-empty',
        scenario:
            'The learner is at the bar of a packed pub on a Friday night trying to order drinks and food. '
            + 'You are the bartender: rushed, serving three people at once, and you will move on to '
            + 'someone else if they take too long.',
    },
    {
        key: 'lecturer',
        label: '找导师问作业',
        desc: 'office hour，要问清作业要求和能不能延期',
        icon: 'fa-chalkboard-user',
        scenario:
            'The learner has come to a lecturer\'s office hour to ask about a coursework brief they do not '
            + 'understand, and to ask for an extension. You are the lecturer: helpful but pressed for time, '
            + 'and you will not grant an extension without a concrete reason.',
    },
    {
        key: 'delivery',
        label: '包裹丢件投诉',
        desc: '打电话追一个显示「已送达」但根本没收到的包裹',
        icon: 'fa-box-open',
        scenario:
            'The learner is phoning a delivery company about a parcel marked "delivered" that they never '
            + 'received. You are the call-centre agent: reading from a script, asking for the tracking '
            + 'number, and initially insisting the driver\'s GPS shows it was handed over.',
    },
];

// ---------- 归一化 ----------

/**
 * 把客户端传来的干扰项归一化成 {开关: [合法子选项]}。
 *
 * 两种输入都接受：
 *   · 新版对象 {'accent': ['scouse'], 'noise': ['pub']}
 *   · 旧版数组 ['accent', 'noise']（等价于每个开关都没选子选项）
 *
 * 只保留白名单里的开关与子选项，去重且保持 INTERFERENCE_KEYS 的固定顺序 ——
 * 顺序固定了，同样的选择才会拼出字节一致的提示词。
 */
export function normalizeModifiers(raw: RawModifiers): Modifiers {
    let items: Array<[string, unknown]>;

    if (Array.isArray(raw)) {
        // 旧版数组：每个开关都没有子选项
        items = raw.map((k) => [String(k), []]);
    } else if (raw && typeof raw === 'object') {
        items = Object.entries(raw as Record<string, unknown>);
    } else {
        return {};
    }

    const out: Modifiers = {};
    for (const opt of INTERFERENCE_KEYS) {   // 固定顺序
        const hit = items.find(([k]) => k === opt);
        if (!hit) continue;                  // 没提到这个开关 = 没开

        const allowed = new Set(INTERFERENCE_SUBOPTIONS[opt]);
        const rawSubs = Array.isArray(hit[1]) ? (hit[1] as unknown[]) : [];
        const seen = new Set<string>();
        const valid: string[] = [];
        for (const s of rawSubs) {
            const ks = String(s);
            if (allowed.has(ks) && !seen.has(ks)) {
                seen.add(ks);
                valid.push(ks);
            }
        }
        out[opt] = valid;
    }
    return out;
}

/** 有没有开任何一个干扰项 */
export function hasInterference(m: Modifiers): boolean {
    return INTERFERENCE_KEYS.some((k) => m[k] !== undefined);
}

// ---------- 目标词 ----------

export interface TargetWord {
    /** 英文词或短语 */
    en: string;
    /** 可选的中文注释 */
    zh: string;
}

/**
 * 解析目标词输入框：一行一个，英文在前，后面跟着的都当中文注释。
 * 移植自参考实现的 parseWords。
 */
export function parseTargetWords(raw: string): TargetWord[] {
    if (!raw.trim()) return [];
    const out: TargetWord[] = [];
    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        const m = l.match(/^([a-zA-Z][a-zA-Z\s'-]*)(.*)$/);
        if (!m) continue;
        const en = m[1].trim();
        if (!en) continue;
        const key = en.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ en, zh: m[2].trim() });
    }
    return out;
}

/**
 * 一段文本里某个目标词出现了几次。
 *
 * \b 词边界 + 忽略大小写；词本身要转义，否则用户输入的 `run (away)`
 * 会被当成正则里的分组，轻则匹配错、重则整个页面崩掉。
 */
export function countMatches(text: string, word: string): number {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!esc) return 0;
    try {
        const rx = new RegExp(`\\b${esc}\\b`, 'gi');
        return (text.match(rx) || []).length;
    } catch {
        return 0;
    }
}

/**
 * 统计每个目标词在「用户自己说过的话」里用了几次。
 *
 * 只喂用户的发言 —— AI 为了制造机会自己也会说这些词，
 * 把 AI 的话算进去，用户一个词没说也会显示「已使用」。
 */
export function tallyTargetWords(
    words: TargetWord[],
    userTurns: string[],
): Array<TargetWord & { count: number }> {
    const joined = userTurns.join('\n');
    return words.map((w) => ({ ...w, count: countMatches(joined, w.en) }));
}
