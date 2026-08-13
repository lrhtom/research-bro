// ============================================================
//  工具箱 · 全站数据源（单一事实来源）
//
//  首页卡片、网课大全、格式转换、以及全站搜索框，全都从这里读数据。
//  想新增内容只改这一个文件，四处会同步更新。
//
//  唯一被拆出去的是**站内**那一半（自建工具、二级页面、可视化演示）：
//  它挪到了 shared/site-catalog.ts，因为 AI 悬浮球的站内导航跑在服务端，
//  两边必须读同一份，否则助手迟早会把人往一个不存在的页面上送。
//  这里原样再导出一遍，页面照旧从 '@/lib/site-data' 取，调用方无感。
//
//  外部链接的硬性要求（三条缺一不可）：免登录、免费、事先亲自打开验证过。
//  每条外链都在 verified 字段记了核验日期。
//
//  唯一的例外是下面的 paperTools（论文检查）：论文 AI 检测这件事
//  暂时没有既免费又可信的服务，所以那一组放宽到「可以要账号、可以要钱」，
//  代价是每一条必须用 access 字段把门槛写死，并显示在卡片上。
//  其余各组（courses / converters）仍然三条全须全尾。
// ============================================================

export type { Accent, Demo, Tool } from '../../shared/site-catalog';
export { demoHref, demos, subRoutes, toolsUnder, tools, topTools, vizCats } from '../../shared/site-catalog';

import type { Accent } from '../../shared/site-catalog';
import { demos, tools, vizCats } from '../../shared/site-catalog';

export interface CourseCat {
    id: string;
    name: string;
    icon: string;
}

export interface Course {
    cat: string;
    code: string;
    title: string;
    en: string;
    school: string;
    term: string;
    lang: string;
    channel: string;
    /** official = 学校/课程组自己的官方频道，长期稳定；mirror = 第三方搬运，随时可能被删 */
    source: 'official' | 'mirror';
    href: string;
    desc: string;
    /** 配套的站内可视化演示 id */
    pairs: string[];
    verified: string;
    keywords: string;
}

export interface Converter {
    title: string;
    en: string;
    desc: string;
    icon: string;
    accent: Accent;
    href: string;
    site: string;
    badges: string[];
    verified: string;
    keywords: string;
}

/** 同一个比赛的一个入口。只有分站的条目才需要列出来（见 Contest.entries）。 */
export interface ContestEntry {
    /** 按钮上的字，例如「中国站」 */
    label: string;
    site: string;
    href: string;
}

export interface Contest {
    /** algo = 算法竞赛；web = 前端创意挑战；data = 数据 / 机器学习竞赛 */
    cat: 'algo' | 'web' | 'data';
    title: string;
    en: string;
    site: string;
    href: string;
    /**
     * 一个比赛有两个官方入口时填这里（力扣的国际站与中国站就是这种）。
     *
     * 填了之后整张卡片**不再是一个大链接**，改成在卡里并排放几个入口按钮 ——
     * 两个目的地却只有一个点击区，点下去到底去哪儿全靠猜。
     * href / site 仍然要填主入口，全站搜索用的是那一份。
     */
    entries?: ContestEntry[];
    icon: string;
    accent: Accent;
    /** 开赛节奏，例如「每周六 · ABC」 */
    cadence: string;
    lang: string;
    /** 下场比的门槛（赛程页一律免登录可看，这里说的是参赛） */
    join: string;
    desc: string;
    /** 官方暂停 / 停办时填一句说明，页面上会红字显示；正常开赛的不填 */
    paused?: string;
    badges: string[];
    verified: string;
    keywords: string;
}

export interface PaperTool {
    title: string;
    en: string;
    desc: string;
    icon: string;
    accent: Accent;
    href: string;
    site: string;
    /** free = 点开直接用；account = 要注册；paid = 要掏钱订阅 */
    access: 'free' | 'account' | 'paid';
    badges: string[];
    verified: string;
    keywords: string;
}

// ---------- 网课（外部链接）----------
//
// 全部于 2026-08-01 逐条打开核实：免登录、免费、内容与标题相符。

export const courseCats: CourseCat[] = [
    { id: 'sys', name: '系统与底层', icon: 'fa-microchip' },
    { id: 'db', name: '数据库', icon: 'fa-database' },
    { id: 'net', name: '计算机网络', icon: 'fa-network-wired' },
    { id: 'dist', name: '分布式系统', icon: 'fa-circle-nodes' },
    { id: 'sec', name: '安全', icon: 'fa-shield-halved' },
    { id: 'guide', name: '学习路线', icon: 'fa-compass' },
];

export const courses: Course[] = [
    {
        cat: 'db',
        code: 'CMU 15-445/645',
        title: '数据库系统导论',
        en: 'Intro to Database Systems',
        school: '卡内基梅隆大学',
        term: 'Fall 2022',
        lang: '英文',
        channel: 'CMU Database Group',
        source: 'official',
        href: 'https://www.youtube.com/playlist?list=PLSE8ODhjZXjaKScG3l0nuOiDTTqpfnWFf',
        desc: '数据库领域公认最好的公开课，由 Andy Pavlo 主讲。从关系模型一路讲到存储引擎、索引、并发控制、查询优化、恢复机制，配套的 BusTub 实验是自己动手写一个数据库。',
        pairs: ['mvcc', 'bplus-tree', 'join-algorithms', 'buffer-pool', 'wal'],
        verified: '2026-08-01',
        keywords: 'database 数据库 andy pavlo bustub 索引 事务 查询优化 存储引擎 15445',
    },
    {
        cat: 'dist',
        code: 'MIT 6.824',
        title: '分布式系统',
        en: 'Distributed Systems',
        school: '麻省理工学院',
        term: 'Spring 2020',
        lang: '英文',
        channel: 'MIT 6.824: Distributed Systems',
        source: 'official',
        href: 'https://www.youtube.com/playlist?list=PLrw6a1wE39_tb2fErI4-WkMbsvGQk9_UB',
        desc: '分布式系统的标杆课程，Robert Morris 主讲。围绕 MapReduce、GFS、Raft、ZooKeeper、Spanner 等经典论文展开，四个 Go 语言实验要求从零实现一个带容错的 Raft 与分片 KV 存储。',
        pairs: ['consistent-hash', 'singleflight'],
        verified: '2026-08-01',
        keywords: 'distributed 分布式 raft mapreduce gfs zookeeper spanner 一致性 共识 golang 6824',
    },
    {
        cat: 'net',
        code: 'Stanford CS144',
        title: '计算机网络导论',
        en: 'Introduction to Computer Networking',
        school: '斯坦福大学',
        term: '—',
        lang: '英文（英文字幕）',
        channel: 'cat blue',
        source: 'mirror',
        href: 'https://www.youtube.com/playlist?list=PL6RdenZrxrw9inR-IJv-erlOKRHjymxMN',
        desc: '自顶向下讲网络分层，从 HTTP 一路拆到 IP 与链路层。配套实验是用 C++ 亲手写一个能跑的 TCP 协议栈，写完之后再看三次握手和滑动窗口会完全不一样。',
        pairs: ['tcp-congestion', 'tcp-window', 'tcp-handshake', 'http-evolution', 'dns'],
        verified: '2026-08-01',
        keywords: 'network 网络 tcp ip http 协议栈 sponge cs144 斯坦福 拥塞控制',
    },
    {
        cat: 'sys',
        code: 'CMU 15-213',
        title: '深入理解计算机系统 CSAPP',
        en: 'Introduction to Computer Systems',
        school: '卡内基梅隆大学',
        term: 'Spring 2015',
        lang: '英文',
        channel: 'Abhinav Maurya',
        source: 'mirror',
        href: 'https://www.youtube.com/playlist?list=PLpIxOj-HnDsPZIJYO4U9f-xRI8bBadaso',
        desc: '《深入理解计算机系统》这本书的配套课程，程序员基本功的地基。从二进制表示、汇编、处理器体系结构，讲到内存层次、链接、异常控制流、虚拟内存与并发。Lab 出了名的硬核，尤其是 Bomb Lab 和 Malloc Lab。',
        pairs: ['virtual-memory', 'gc', 'scheduling'],
        verified: '2026-08-01',
        keywords: 'csapp 15213 计算机系统 汇编 assembly 内存 链接 虚拟内存 bomb lab malloc 深入理解',
    },
    {
        cat: 'sec',
        code: 'UCB CS161',
        title: '计算机安全',
        en: 'Computer Security',
        school: '加州大学伯克利分校',
        term: 'Spring 2026',
        lang: '英文',
        channel: 'CS 161 (Computer Security) at UC Berkeley',
        source: 'official',
        href: 'https://www.youtube.com/playlist?list=PLfBkt1-_BHX9WY9MtskJWtNW8OWQQHhxO',
        desc: '伯克利的安全入门课，覆盖内存安全漏洞与利用、密码学基础、Web 安全、网络攻防。课程网站 cs161.org 上讲义、作业与往年题全部公开。',
        pairs: ['tls-handshake', 'bloom-filter'],
        verified: '2026-08-01',
        keywords: 'security 安全 cs161 伯克利 berkeley 缓冲区溢出 密码学 web 攻防 漏洞',
    },
    {
        cat: 'guide',
        code: 'csdiy.wiki',
        title: 'CS 自学指南',
        en: 'CS Self-Learning Guide',
        school: '北京大学学生编写',
        term: '持续更新',
        lang: '中文',
        channel: '开源站点',
        source: 'official',
        href: 'https://csdiy.wiki/',
        desc: '不是视频课，而是一本「课程搜索引擎」。把 MIT、斯坦福、伯克利等名校的公开课按方向整理成学习路线，每门课标注了难度、工作量、前置知识和配套项目。不知道下一步学什么的时候来这里翻。',
        pairs: [],
        verified: '2026-08-01',
        keywords: 'csdiy 自学 指南 路线 学习路径 北大 开源 课程导航 wiki',
    },
];

// ---------- 格式转换（外部链接）----------
//
// 同样三条硬要求：免登录、免费、事先验证。

export const converters: Converter[] = [
    {
        title: 'Word 转 PNG',
        en: 'Word to PNG',
        desc: '上传 Word 文档，一键转换为高清 PNG 图片。无需注册登录，不限次数。适合把排版好的表格、公式直接变成图片贴进别处。',
        icon: 'fa-file-image',
        accent: 'pink',
        href: 'https://products.aspose.app/words/conversion/word-to-png',
        site: 'Aspose',
        badges: ['无限免费', '免注册'],
        verified: '2026-08-01',
        keywords: 'word docx png 图片 转换 文档 截图 aspose',
    },
    {
        title: '图片切割',
        en: 'Split Image',
        desc: '把一张图片按行、列或网格切成多张，可自定义数量或尺寸，支持逐张下载或打包下载。做九宫格、拆长图都用它。',
        icon: 'fa-scissors',
        accent: 'teal',
        href: 'https://pinetools.com/split-image',
        site: 'PineTools',
        badges: ['免费', '免注册'],
        verified: '2026-08-01',
        keywords: '图片 切割 分割 九宫格 长图 网格 split image pinetools',
    },
    {
        title: '公式 ↔ Python 计算本',
        en: 'EngineeringPaper.xyz',
        desc: '在网页上直接手写数学公式，SymPy 当场求解、还会自动处理单位换算；需要复杂逻辑时插入 Python 代码单元，公式与 Python 可以互相调用取值。整个 Python 运行时（含 numpy / scipy / sympy）靠 Pyodide 跑在浏览器里，数据完全不离开本机。MIT 开源。',
        icon: 'fa-square-root-variable',
        accent: 'blue',
        href: 'https://engineeringpaper.xyz/',
        site: 'EngineeringPaper',
        badges: ['免注册', 'MIT 开源', '本地运行'],
        verified: '2026-08-01',
        keywords: '数学 公式 python sympy numpy scipy 计算 latex 代码 工程 pyodide 单位换算 符号计算 求解',
    },
    {
        title: 'GIF 转换',
        en: 'GIF Converter',
        desc: '视频转 GIF、GIF 转 MP4 / WebM、多图合成 GIF，还能裁剪、压缩、加字幕、调帧率。GIF 相关的活基本都能在这一个站里干完。',
        icon: 'fa-film',
        accent: 'amber',
        href: 'https://ezgif.com/',
        site: 'EZGIF',
        badges: ['免费', '免注册'],
        verified: '2026-08-01',
        keywords: 'gif 动图 视频 mp4 webm 转换 压缩 裁剪 帧率 字幕 ezgif',
    },
];

// ---------- 编程比赛（外部链接）----------
//
// 2026-08-09 逐个打开核实：赛程页都不用登录就能看，比赛本身免费。
// 「参赛要免费账号」不算违反免登录那一条 —— 免登录说的是本站访客点过去
// 能不能看到东西，而不是能不能提交代码。
// GfG 周赛当天核实到官方已暂停，保留条目但标出来，免得有人白跑一趟。

export const contests: Contest[] = [
    {
        cat: 'algo',
        title: 'Codeforces',
        en: 'Codeforces Contests',
        site: 'codeforces.com',
        href: 'https://codeforces.com/contests',
        icon: 'fa-bolt',
        accent: 'blue',
        cadence: '每周 1~3 场',
        lang: '英文 / 俄文',
        join: '免费注册即可参赛',
        desc: '算法竞赛人数最多的平台。按水平分成 Div. 1~4，另有 Educational、Global 等专场，每场 2 小时左右、赛后立刻出题解与 Rating 变化。错过的场次可以开 Virtual participation 按原时长补打一遍。',
        badges: ['分级 Div.1~4', '虚拟参赛补赛', 'Rated'],
        verified: '2026-08-09',
        keywords: 'codeforces cf 算法 竞赛 div1 div2 div3 div4 educational global rating 补赛 virtual 打比赛 俄罗斯',
    },
    {
        cat: 'algo',
        title: 'AtCoder',
        en: 'AtCoder Contests',
        site: 'atcoder.jp',
        href: 'https://atcoder.jp/contests/',
        icon: 'fa-torii-gate',
        accent: 'pink',
        cadence: '几乎每周末',
        lang: '日文 / 英文（站内可切）',
        join: '免费注册即可参赛',
        desc: '日本的算法竞赛站，题面干净、难度曲线做得最好。ABC 面向入门（每周六、100 分钟），ARC 进阶，AGC 最难，AHC 是长周期的启发式优化赛。另有两个不限时的 practice 常驻赛，随时能进去熟悉判题环境。',
        badges: ['ABC / ARC / AGC / AHC', '入门友好', '常驻练习赛'],
        verified: '2026-08-09',
        keywords: 'atcoder abc arc agc ahc 日本 算法 竞赛 beginner contest heuristic 入门 打比赛',
    },
    {
        cat: 'algo',
        title: '力扣 LeetCode',
        en: 'LeetCode Contest',
        site: 'leetcode.cn',
        href: 'https://leetcode.cn/contest/',
        // 两个站是同期同题、各自独立排名，账号也不通用 —— 所以给两个入口，
        // 而不是替用户选一个
        entries: [
            { label: '中国站', site: 'leetcode.cn', href: 'https://leetcode.cn/contest/' },
            { label: '国际站', site: 'leetcode.com', href: 'https://leetcode.com/contest/' },
        ],
        icon: 'fa-list-check',
        accent: 'amber',
        cadence: '每周日周赛 + 隔周六双周赛',
        lang: '中文 / 英文（两站同期同题）',
        join: '免费注册即可参赛',
        desc: '面试向刷题站里唯一有稳定周赛的。周赛每周日上午（北京时间 10:30）四道题，双周赛在隔周的周六晚上，题目难度跟大厂算法面试基本同一档 —— 想练面试手感而不是拼名次的，这条线比 Codeforces 直接。往届可以随时开「虚拟」按原时长补打。国际站与中国站同期同题，但排名和账号各算各的，按你想跟谁比来挑。',
        badges: ['每周日 4 题', '双周赛', '虚拟补赛', '国际站 / 中国站'],
        verified: '2026-08-11',
        keywords: '力扣 leetcode lc 周赛 双周赛 竞赛 算法 面试 刷题 虚拟 补赛 rating 大厂 hot100 国际站 中国站 leetcode.cn leetcode.com',
    },
    {
        cat: 'algo',
        title: 'CodeChef',
        en: 'CodeChef Contests',
        site: 'codechef.com',
        href: 'https://www.codechef.com/contests',
        icon: 'fa-utensils',
        accent: 'amber',
        cadence: '每周 2~3 场',
        lang: '英文',
        join: '免费注册即可参赛',
        desc: '印度的老牌竞赛站，节奏比 Codeforces 轻。主力是每周三的 Starters（2 小时，按 star 分段计分），另有周一的 Monday Munch DSA 挑战与周五的 Placement Prep 面试向专场，偏求职刷题的人更合适。',
        badges: ['Starters 每周三', '面试向专场', 'Rated'],
        verified: '2026-08-09',
        keywords: 'codechef starters monday munch placement prep dsa 印度 算法 竞赛 面试 求职 打比赛',
    },
    {
        cat: 'algo',
        title: '牛客竞赛',
        en: 'Nowcoder Contests',
        site: 'ac.nowcoder.com',
        href: 'https://ac.nowcoder.com/acm/contest/vip-index',
        icon: 'fa-flag-checkered',
        accent: 'teal',
        cadence: '每周都有',
        lang: '中文',
        join: '免费注册后报名',
        desc: '中文圈最活跃的竞赛平台，题面和讨论区全中文。分牛客系列赛、高校校赛、自主创建赛三类：周赛与小白月赛适合日常练手，暑期多校、寒假集训营是国内 ICPC 队伍的主要训练场。',
        badges: ['全中文题面', '周赛 / 小白月赛', '暑期多校'],
        verified: '2026-08-09',
        keywords: '牛客 nowcoder 竞赛 周赛 小白月赛 练习赛 暑期多校 寒假集训营 acm icpc ccpc 中文 校赛 打比赛',
    },
    {
        cat: 'algo',
        title: 'yukicoder',
        en: 'yukicoder Contest',
        site: 'yukicoder.me',
        href: 'https://yukicoder.me/contests',
        icon: 'fa-dice-d20',
        accent: 'teal',
        cadence: '基本每周五 21:20（日本时间）',
        lang: '日文',
        join: 'Twitter / GitHub / Google 账号登录',
        desc: '日本的民间自办赛，题目由社区成员轮流出，风格偏数学与构造，跟 AtCoder 官方题的味道明显不同。每题带 ★ 难度星级；赛程表提前一两个月就排满，是 AtCoder 之外补周赛量的首选。',
        badges: ['社区出题', '数学 / 构造向', '★ 难度分级'],
        verified: '2026-08-09',
        keywords: 'yukicoder 日本 周赛 民间 社区 数学 构造 星级 難易度 算法 竞赛 打比赛',
    },
    {
        cat: 'algo',
        title: 'GfG 周赛',
        en: 'GfG Weekly Coding Contest',
        site: 'geeksforgeeks.org',
        href: 'https://www.geeksforgeeks.org/events/rec/gfg-weekly-coding-contest',
        icon: 'fa-code',
        accent: 'indigo',
        cadence: '原为每周日',
        lang: '英文',
        join: '免费注册即可参赛',
        desc: 'GeeksforGeeks 的每周算法赛，题目偏面试常考的 DSA，难度低于 Codeforces，适合边刷题边找手感。往期比赛在 practice 子站上仍然可以进去做。',
        paused: '官方页面写明周赛「temporarily paused」（已暂停，复办时间未定），当前只有往期题目和 GfG 160 系列可做。',
        badges: ['官方已暂停', 'DSA 面试向', '往期可做'],
        verified: '2026-08-09',
        keywords: 'geeksforgeeks gfg 周赛 weekly 算法 dsa 面试 印度 practice potd 打比赛',
    },
    {
        cat: 'data',
        title: 'Kaggle',
        en: 'Kaggle Competitions',
        site: 'kaggle.com',
        href: 'https://www.kaggle.com/competitions',
        icon: 'fa-chart-line',
        accent: 'blue',
        cadence: '常年数十场并行 · 单场 1~3 个月',
        lang: '英文',
        join: '免费注册后组队提交',
        desc: '数据科学与机器学习竞赛的大本营，比的不是限时手速而是模型效果：给一份数据集和一个评测指标，在赛期内反复提交预测、刷公开榜，截止时按私榜定名次。「Getting Started」那一组（泰坦尼克、房价预测）常年开着、没有截止日期，是入门 ML 最常见的第一站；Playground 每月一期，用合成数据练手，压力比正赛小得多。自带浏览器里的 Notebook 环境，有免费 GPU / TPU 额度，本机不用配任何东西。',
        badges: ['入门赛常驻', '每月 Playground', '免费 GPU 额度'],
        verified: '2026-08-11',
        keywords: 'kaggle 数据 竞赛 机器学习 machine learning 深度学习 ai 数据科学 data science notebook gpu tpu playground titanic 泰坦尼克 房价 榜单 leaderboard 建模 特征工程',
    },
    {
        cat: 'web',
        title: 'CodePen Challenges',
        en: 'CodePen Challenges',
        site: 'codepen.io',
        href: 'https://codepen.io/challenges',
        icon: 'fa-palette',
        accent: 'pink',
        cadence: '每月一主题 · 每周一题',
        lang: '英文',
        join: '免费注册即可参赛',
        desc: '不比算法，比前端创意。每月定一个主题，每周给一条具体的命题，用 HTML / CSS / JS 现场写一个 Pen 交上去，选中的会被挂到首页。没账号也能看历年主题和别人交的作品，本身就是一份前端灵感库。',
        badges: ['前端创意', '每周一题', '作品可围观'],
        verified: '2026-08-09',
        keywords: 'codepen challenge 前端 创意 css html js 挑战 pen 设计 动效 灵感 每周',
    },
];

// ---------- 论文相关（外部链接 · 全站唯一允许有门槛的一组）----------
//
// 这一组不要求免登录免费，但要求 access 字段如实标明门槛，页面上必须显示出来。
// 收之前仍然要亲自打开核实一遍价格与功能，日期记在 verified。
//
// 描述一律照抄工具自己的定位，不做美化 —— 这一页放着一个 AI 检测器和一个
// 专门用来绕过 AI 检测器的工具，把话说清楚才知道自己在点什么。
// 同一页的站内工具（三线表）不在这个数组里，页面直接从 tools 取，
// 免得同一份说明在两处各写一遍、迟早对不上。

export const paperTools: PaperTool[] = [
    {
        title: '论文 AI 检查',
        en: 'AI Content Detector',
        desc: '粘贴正文或上传 docx / pdf / doc，给出整篇的 AI 生成概率，并把最可疑的句子逐句高亮；同一个账号还能顺带做查重、可读性、语法与事实核查，结果可导出 PDF 报告。按字数扣积分，100 词算 1 积分。',
        icon: 'fa-robot',
        accent: 'pink',
        href: 'https://originality.ai/',
        site: 'Originality.ai',
        access: 'paid',
        badges: ['需登录', '订阅制 $12.95/月起', '按字数扣积分'],
        verified: '2026-08-09',
        keywords: 'ai 检测 检查 生成率 论文 查重 原创度 学术不端 降重 chatgpt gpt claude gemini originality detector plagiarism 语法 可读性',
    },
    {
        title: 'AI 文本改写',
        en: 'Humanize AI',
        desc: '把 AI 生成的文字重写成读起来像人写的。官网原话是「bypass ALL detectors, including Originality.ai, GPTZero, Turnitin」—— 它的卖点就是绕过 AI 检测，包括学校用的 Turnitin，不是普通的润色工具。免费额度 1500 词、单次 300 词，往上按月订阅。',
        icon: 'fa-wand-magic-sparkles',
        accent: 'teal',
        href: 'https://www.humanizeai.pro/',
        site: 'HumanizeAI.pro',
        access: 'free',
        badges: ['免费 1500 词', '单次 300 词', '用途看清楚'],
        verified: '2026-08-09',
        keywords: 'ai 改写 降重 人性化 humanize 绕过 检测 规避 originality gptzero turnitin 论文 润色 paraphrase rewrite undetectable',
    },
];

/** 演示脚本的加载顺序 —— 与旧版 tools/visualizations/index.html 的 <script> 顺序一致 */
export const demoScripts: string[] = demos.map((d) => d.id);

// ---------- 搜索索引 ----------

export interface SearchRow {
    type: 'tool' | 'demo' | 'course' | 'conv' | 'paper' | 'contest';
    title: string;
    sub: string;
    desc: string;
    href: string;
    icon: string;
    tag: string;
    external: boolean;
    /** 拼好的小写检索串，搜索时直接在它上面做匹配 */
    text: string;
}

/** 汇总成一张搜索表。条目总共几十条，线性扫最省事，不需要索引文件 */
export function buildIndex(): SearchRow[] {
    const rows: SearchRow[] = [];
    const push = (o: Omit<SearchRow, 'text'> & { keywords: string }) => {
        const { keywords, ...rest } = o;
        rows.push({ ...rest, text: [o.title, o.sub, o.desc, o.tag, keywords].join(' ').toLowerCase() });
    };

    tools.forEach((t) => push({
        type: 'tool', title: t.title, sub: t.subtitle, desc: t.desc,
        href: t.href, icon: t.icon, tag: '工具', keywords: t.keywords, external: false,
    }));

    demos.forEach((d) => push({
        type: 'demo', title: d.t, sub: d.s, desc: d.d,
        href: '/tools/visualizations#demo=' + d.id,
        icon: 'fa-wave-square', tag: '演示 · ' + (vizCats[d.cat] || ''),
        keywords: d.id.replace(/-/g, ' '), external: false,
    }));

    courses.forEach((c) => push({
        type: 'course', title: c.code + ' ' + c.title, sub: c.school + ' · ' + c.en, desc: c.desc,
        href: c.href, icon: 'fa-graduation-cap', tag: '网课',
        keywords: c.keywords + ' ' + c.channel, external: true,
    }));

    converters.forEach((c) => push({
        type: 'conv', title: c.title, sub: c.site + ' · ' + c.en, desc: c.desc,
        href: c.href, icon: c.icon, tag: '格式转换',
        keywords: c.keywords, external: true,
    }));

    contests.forEach((c) => push({
        type: 'contest', title: c.title, sub: c.site + ' · ' + c.cadence, desc: c.desc,
        href: c.href, icon: c.icon, tag: '编程比赛',
        keywords: c.keywords + ' ' + c.en, external: true,
    }));

    paperTools.forEach((p) => push({
        type: 'paper', title: p.title, sub: p.site + ' · ' + p.en, desc: p.desc,
        href: p.href, icon: p.icon, tag: '论文相关',
        keywords: p.keywords + ' ' + p.badges.join(' '), external: true,
    }));

    return rows;
}
