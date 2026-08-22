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

/** 资讯站内的一个平级入口（日报 / 周报 / 模型榜…），渲染成卡内按钮 */
export interface NewsEntry {
    label: string;
    href: string;
    /** 按钮下面那一行小字，说明这个入口是干什么的 */
    desc: string;
}

export interface NewsSite {
    title: string;
    en: string;
    site: string;
    href: string;
    icon: string;
    accent: Accent;
    /** 谁做的。资讯类跟工具类不同 —— 编辑口味决定了你每天看到什么，作者必须写出来 */
    author: string;
    /** 更新节奏 */
    cadence: string;
    /**
     * 站内的几个平级入口。
     *
     * 填了之后整张卡**不再是一个大链接**，改成在卡里并排放按钮，
     * 走的是跟编程比赛页同一套 .link-entries（见 converters.css）。
     * href 仍然要填主入口，全站搜索用的是那一份。
     */
    entries: NewsEntry[];
    desc: string;
    badges: string[];
    verified: string;
    keywords: string;
}

export interface AssetSite {
    /**
     * model = 3D 模型；texture = 材质贴图与 HDRI；audio = 音效与音乐；
     * generate = 图生 3D（自己造，不是现成的）。
     *
     * generate 那一类跟前三类是**两种动作**：前三类你去翻、去挑，
     * 挑到的是别人做好的东西；generate 是你喂一张图进去、等它算出一个网格。
     * 所以单开一节，不混进 model 里 —— 混了之后「这一节有几家可挑」
     * 这句话就不成立了。
     */
    cat: 'model' | 'texture' | 'audio' | 'generate';
    title: string;
    en: string;
    site: string;
    href: string;
    icon: string;
    accent: Accent;
    /**
     * cc0 = 公共领域，等于没有著作权；
     * permissive = 站点自有的免费授权，实质等价于「免费商用 + 免署名」，
     * 但通常多一条「不许把原样没改过的素材单独拿去卖」；
     * oss = 标准开源许可（MIT / Apache 之类），用在 generate 那一类上 ——
     * 那里管的不是某份素材的版权，而是**生成它的模型**的许可。
     *
     * 只有这三档能进这个数组，见下面数组上方的收录标准。
     */
    license: 'cc0' | 'permissive' | 'oss';
    /** 授权的原文写法，照抄站上的字，不要自己翻译成「免费」了事 */
    licenseLabel: string;
    /**
     * 下载要不要注册账号。
     *
     * 绝大多数条目是 false，页面上于是只把 true 的那几条标出来 ——
     * 给每一条都挂一个「免注册」标签，等于把最重要的那条例外淹掉。
     */
    account?: boolean;
    /** 用之前必须知道的那一条限制或坑；没有就不填 */
    caveat?: string;
    desc: string;
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
        title: 'Word 转 PDF',
        en: 'Word to PDF',
        desc: '上传 .doc / .docx 直接转成 PDF，排版、字体与分页原样保留。免注册、不限次数、不限文件大小，也没有水印。转换在对方服务器上跑，转完文件会自动删除。同一个站还能反过来把 PDF 转回 Word，以及合并、拆分、压缩、加密。',
        icon: 'fa-file-pdf',
        accent: 'indigo',
        href: 'https://tools.pdf24.org/zh/word-to-pdf',
        site: 'PDF24 Tools',
        badges: ['无限免费', '免注册', '中文界面'],
        verified: '2026-08-22',
        keywords: 'word doc docx pdf 转换 转 pdf 导出 论文 简历 排版 分页 pdf24 免费 免注册 不限次数 合并 拆分 压缩',
    },
    {
        title: 'PPT 转 PDF',
        en: 'PowerPoint to PDF',
        desc: '上传 .ppt / .pptx 转成 PDF，一页幻灯片对应一页 PDF，动画会被拍平成最终画面。免注册、不限次数、不限文件大小 —— 挑这家就是为了这一条：真实的演示文稿动辄几十 MB，好几家免费转换器不登录就卡在 2MB，等于用不了。',
        icon: 'fa-file-powerpoint',
        accent: 'blue',
        href: 'https://tools.pdf24.org/zh/ppt-to-pdf',
        site: 'PDF24 Tools',
        badges: ['无限免费', '免注册', '中文界面'],
        verified: '2026-08-22',
        keywords: 'ppt pptx powerpoint 幻灯片 演示文稿 pdf 转换 转 pdf 导出 答辩 汇报 讲稿 pdf24 免费 免注册 不限大小',
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

// ---------- AI 资讯（外部链接）----------
//
// 这一组跟站里其他外链组的性质不一样，收之前先想清楚这一点：
// 别的组是**目录** —— 你要转个格式、要找副材质，打开那一页从里面挑一个；
// 这一组是**每天去一次的固定目的地**，不存在「挑」这个动作。
//
// 正因如此，收录门槛要比目录页高得多：目录里多一条冷门条目最多是噪音，
// 而每日信息源多一条就是每天多花一份注意力。宁可只有一条。
//
// 收录标准（在全站那三条之上另加）：
//   4. 有人替你筛过 —— 纯 RSS 聚合器不收，那只是把信息过载搬了个地方
//   5. 标得出信源 —— 每条都能追到原始出处，不是无出处的二手转述
//   6. 真的每天更新 —— 翻得到连续的历史存档，不是发了三期就停的
//
// 2026-08-16 逐条打开核实：存活、免登录、更新节奏、以及历史存档的连续性。

export const newsSites: NewsSite[] = [
    {
        title: 'AIHOT · AI 日报',
        en: 'AIHOT Daily',
        site: 'aihot.virxact.com',
        href: 'https://aihot.virxact.com/daily',
        icon: 'fa-newspaper',
        accent: 'blue',
        author: '数字生命卡兹克',
        cadence: '每早八时',
        entries: [
            { label: 'AI 日报', href: 'https://aihot.virxact.com/daily', desc: '每天 · 约 9 分钟' },
            { label: '周报 / 月报', href: 'https://aihot.virxact.com/weekly', desc: '整周浓缩成 5 分钟' },
            { label: '模型榜', href: 'https://aihot.virxact.com/leaderboard', desc: '6 家榜单算共识分' },
            { label: '热点榜', href: 'https://aihot.virxact.com/hot', desc: '过去 48 小时' },
        ],
        desc: '把一天的 AI 动静筛成一页：分「模型发布 / 产品 / 行业动态 / 论文研究 / 技巧观点」五类，每条一段摘要，标着信源类型（官方 / 学术机构 / 综合资讯 / X·KOL）和具体出处 —— xAI 官网、OpenRouter、LMSYS、Meta Engineering Blog、Claude Code 的 GitHub Releases 都在里面，看完能顺着追到原文。工作日一天二十条上下，周末少。作者是公众号「数字生命卡兹克」，站上写明是 AI 帮着筛噪声、留下值得看的几条。',
        badges: ['免登录', '每条标信源', '有周报 / 月报'],
        verified: '2026-08-16',
        keywords: 'ai 日报 资讯 新闻 每日 daily 快讯 aihot 卡兹克 数字生命 大模型 llm 动态 追踪 跟进 周报 月报 热点 排行榜 leaderboard 模型榜 openai anthropic claude gemini qwen deepseek grok 信息源 rss 聚合 摘要',
    },
];

// ---------- 免费素材（外部链接）----------
//
// 这一组的收录标准比全站那三条还严，多加两条硬性的，理由是素材跟工具不一样：
// 工具是你自己用完就算了，素材是要打包进成品发出去的。
//
//   4. 不要求署名 —— 署名义务会跟着成品走一辈子，且没人记得住哪个音效来自哪家
//   5. 允许随项目再分发 —— 否则素材根本进不了要交付的 web 项目
//
// 第 4、5 条不容破例：踩了它们，代价出现在交付之后，那时候已经改不动了。
// 「免登录」这一条则允许**一处**破例并用 account 字段标出来（当前只有 Freesound）：
// 它的不可替代性在于冷门具体音效，别处真的没有；而注册的代价是当场的、可见的，
// 跟前两条那种延迟爆发的风险不是一回事。
//
// 2026-08-15 逐条打开核实：存活、授权原文、以及下载要不要账号。
// 核实过程中被**剔掉**的（留着，免得下次又去查一遍）：
//
//   · Poly Pizza      模型页写的是 Creative Commons Attribution，默认 CC-BY 要署名，
//                     违反第 4 条。且它的料多半转自 Kenney / Quaternius，已经收了源头
//   · Sketchfab       要登录才能下，且搜索结果里混着 CC-BY-NC（禁商用）与
//                     CC-BY-ND（禁修改），逐件看授权的心智负担太大
//   · Mixamo          Adobe 账号墙，首页就要 Sign Up，违反免注册
//   · HDRI Skies      自有授权，条款明确禁止再分发单张 HDR，违反第 5 条
//   · Textures.com    条款第一条要注册、第二条说下载需要 Premium Credits，且禁再分发
//   · Zapsplat        免费档必须署名 ZapSplat + 要注册 + 只给 mp3 + 有下载限额
//   · Incompetech     Kevin MacLeod 的曲子，免费档必须署名，不署名要单独买 License
//   · Sonniss GDC     授权本身合格（免署名、终身商用），但只能按年份整包几十 GB 下、
//                     没有搜索，不是「要个音效随手拿一个」的用法
//   · cgbookcase      CC0 且免注册，合格，只是跟 ambientCG / 3DTextures 完全重叠
//   · ShareTextures   同上，CC0 免注册，重叠
//   · Material Maker  是自己造材质的开源工具，不是素材库，不属于这一页
//   · Unsplash/Pexels 授权合格，但那是摄影图库不是贴图：要当材质用还得自己做无缝
//                     平铺、自己生成法线与粗糙度，不是「拿来即用」
//
// 图生 3D 那一节另外筛掉的两个（2026-08-16 核实）：
//
//   · 腾讯混元 Hunyuan3D 2.1   HuggingFace 上最热门的一个（2187 赞），但许可证第一行写着
//                     「THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION,
//                     UNITED KINGDOM AND SOUTH KOREA」，且第 4(c) 条把**产物**一并圈进
//                     地域限制：「must not use... Output or results... outside the
//                     Territory」。人在英国的话，连它生成出来的模型都是没授权的。
//                     许可证原文：github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE
//   · Tripo / Meshy   两家做得都比 TRELLIS 好用（导出格式全、有 3D 打印档），但都要注册，
//                     而且免费额度与产物的商用条款首页都不写明，得进各自 ToS 翻。
//                     等哪天条款写清楚了再说。
//
// Poly Haven 与 Kenney 各占两类（模型 / HDRI、模型 / 音效）—— 同一个站分两条，
// 是因为翻材质的人不该被要求先知道「它在模型那一节里」。

export const assetSites: AssetSite[] = [
    // ---- 3D 模型 ----
    {
        cat: 'model',
        title: 'Poly Haven',
        en: 'Poly Haven Models',
        site: 'polyhaven.com',
        href: 'https://polyhaven.com/models',
        icon: 'fa-gem',
        accent: 'indigo',
        license: 'cc0',
        licenseLabel: 'CC0',
        desc: '这一堆里单件质量最高的一家，偏写实，做影视与写实游戏的首选。站上原话是「No paywalls or signup required」—— 点开直接下，连邮箱都不用留。模型、材质、HDRI 三样是同一批人做的，混着用风格能对上，这一点别家给不了。量不如低模站大，胜在每一件都精修过。',
        badges: ['CC0', '免注册', '写实向'],
        verified: '2026-08-15',
        keywords: 'polyhaven poly haven 模型 model 写实 高质量 cc0 免注册 blender 影视 vfx 精修',
    },
    {
        cat: 'model',
        title: 'Kenney',
        en: 'Kenney Game Assets',
        site: 'kenney.nl',
        href: 'https://kenney.nl/assets',
        icon: 'fa-cube',
        accent: 'amber',
        license: 'cc0',
        licenseLabel: 'Creative Commons CC0',
        desc: '低模游戏素材包，一个包几十上百件，风格统一到可以直接拼出一整个场景而不违和。资产页上明写着 License: Creative Commons CC0，点 Download 就走。除模型外还有 UI 音效、字体、粒子贴图（音效那一半单独列在下面）。页面上那个付费的 All-in-1 只是「一次把全部打包下来」的便利，不买不影响单个包免费下。',
        badges: ['CC0', '免注册', '成套低模'],
        verified: '2026-08-15',
        keywords: 'kenney 低模 low poly 游戏 素材包 cc0 免注册 ui 字体 粒子 game asset 原型 prototype',
    },
    {
        cat: 'model',
        title: 'Quaternius',
        en: 'Quaternius Low Poly',
        site: 'quaternius.com',
        href: 'https://quaternius.com/',
        icon: 'fa-shapes',
        accent: 'teal',
        license: 'cc0',
        licenseLabel: 'CC0',
        desc: '同样是低模，但风格比 Kenney 更「圆润卡通」，按主题一整套一整套地出（海盗、太空、自然、城市、地牢…），角色带绑定和动画。每个包页面右上角标着 License CC0，格式给 FBX / OBJ / glTF / Blend 四种 —— glTF 那一份丢进 three.js 或引擎里不用转换。',
        badges: ['CC0', '免注册', 'FBX / OBJ / glTF / Blend'],
        verified: '2026-08-15',
        keywords: 'quaternius 低模 low poly 卡通 成套 主题包 cc0 gltf glb fbx obj blend 角色 动画 绑定 three.js',
    },
    {
        cat: 'model',
        title: 'KayKit',
        en: 'Kay Lousberg Game Assets',
        site: 'kaylousberg.com',
        href: 'https://kaylousberg.com/game-assets',
        icon: 'fa-person-running',
        accent: 'pink',
        license: 'cc0',
        licenseLabel: 'CC0 Licensed',
        desc: '卡通风的成套素材（地牢、冒险者、骷髅、城市建造各一套），角色能拆件换装组合。真正稀缺的是它的动画包：一个包就有 133 段人形动画，分 Rig_Medium / Rig_Large 两种骨架，按「移动 / 近战 / 远程 / 情绪」分组挑着拿。页面原话是「Free for personal and commercial use, no attribution required. (CC0 Licensed)」，给 FBX 与 GLTF。',
        caveat: '文件本身托管在 itch.io 上，点 Download 会跳过去；itch 的免费下载不用注册，页面上那个「支持作者」的金额可以填 0。',
        badges: ['CC0', '133 段动画', 'FBX / GLTF'],
        verified: '2026-08-15',
        keywords: 'kaykit kay lousberg 卡通 低模 角色 动画 animation 骨架 rig 地牢 冒险者 骷髅 cc0 itch fbx gltf 换装',
    },

    // ---- 材质 / 贴图 / HDRI ----
    {
        cat: 'texture',
        title: 'ambientCG',
        en: 'ambientCG PBR Materials',
        site: 'ambientcg.com',
        href: 'https://ambientcg.com/list?type=material',
        icon: 'fa-layer-group',
        accent: 'blue',
        license: 'cc0',
        licenseLabel: 'CC0',
        desc: 'PBR 材质的首选，量最大、覆盖最全。站上原话是「free to use without attribution - even in commercial circumstances」。材质页上直接挂着 1K / 2K / 4K / 8K × JPG / PNG 八个下载直链，一套贴图（颜色、法线、粗糙度、AO、置换）打包给全；页面上那个 Supporter Login 是可选的赞助入口，不登录照样下。除材质外还有 HDRI、贴花和一些模型。',
        badges: ['CC0', '免注册', '1K–8K 全套贴图'],
        verified: '2026-08-15',
        keywords: 'ambientcg ambient cg pbr 材质 贴图 纹理 texture material 法线 normal 粗糙度 roughness ao 置换 displacement 4k 8k cc0 免注册 无缝 seamless',
    },
    {
        cat: 'texture',
        title: 'Poly Haven · HDRI',
        en: 'Poly Haven HDRIs',
        site: 'polyhaven.com',
        href: 'https://polyhaven.com/hdris',
        icon: 'fa-sun',
        accent: 'indigo',
        license: 'cc0',
        licenseLabel: 'CC0',
        desc: 'HDRI 环境贴图这一块的事实标准，最高 16K，CC0、免注册。做 3D 渲染时环境光基本靠它一家就够 —— 挂上去打光和反射立刻是对的，比自己摆灯快一个数量级。跟上面模型那条是同一个站，分开列是因为找 HDRI 的人不该先知道它还做模型。',
        badges: ['CC0', '免注册', '最高 16K'],
        verified: '2026-08-15',
        keywords: 'polyhaven poly haven hdri hdr 环境贴图 天空盒 skybox 环境光 ibl 打光 lighting 渲染 16k cc0 免注册',
    },
    {
        cat: 'texture',
        title: '3DTextures',
        en: '3DTextures.me',
        site: '3dtextures.me',
        href: 'https://3dtextures.me/',
        icon: 'fa-th',
        accent: 'amber',
        license: 'cc0',
        licenseLabel: 'CC0',
        desc: '更新最勤的一家，翻到 2026 年 8 月还在发新的，风格偏写实。每张给 Diffuse / Normal / Metallic / Displacement / Roughness / AO 一整套，Unity、Unreal、Godot、Blender 都能直接吃。它的授权页把话说得比谁都透：可商用、不用署名、而且明确写了「你可以随自己的项目一起分发」—— 这一条正是打包上线要的。',
        caveat: '只能一张一张下。「一次下全部」的网盘链接是给赞助者的，但单张下载本身不要账号、不要钱。',
        badges: ['CC0', '免注册', '更新勤'],
        verified: '2026-08-15',
        keywords: '3dtextures 材质 贴图 纹理 texture pbr 写实 无缝 seamless diffuse normal roughness metallic ao 置换 cc0 免注册 unity unreal godot blender',
    },
    {
        cat: 'texture',
        title: 'Texture Ninja',
        en: 'Texture Ninja',
        site: 'texture.ninja',
        href: 'https://texture.ninja/',
        icon: 'fa-camera',
        accent: 'teal',
        license: 'cc0',
        // 站上横幅原文是「PUBLIC DOMAIN · CC0」，这里只留 CC0：
        // 后面会拼上「· 公共领域」，照抄全文会变成「公共领域 · CC0 · 公共领域」
        licenseLabel: 'CC0',
        desc: '跟上面两家是不同的东西：这里是实拍照片，不是做好的 PBR 贴图。砖墙、混凝土、锈迹、涂鸦、门、招牌、裂纹，24 类约 5300 张，最大的一类是 1389 张纯参考图。首页横幅直接写着「No account, no attribution required」。拿来自己做无缝贴图、或者直接贴在模型上做旧、做脏，比用现成材质更像真的。',
        badges: ['CC0', '免注册', '实拍照片'],
        verified: '2026-08-15',
        keywords: 'texture ninja 实拍 照片 参考 reference 砖墙 混凝土 锈 涂鸦 裂纹 招牌 做旧 做脏 cc0 公共领域 public domain 免注册 贴图素材',
    },

    // ---- 音效 / 音乐 ----
    {
        cat: 'audio',
        title: 'Pixabay 音效',
        en: 'Pixabay Sound Effects',
        site: 'pixabay.com',
        href: 'https://pixabay.com/sound-effects/',
        icon: 'fa-volume-high',
        accent: 'pink',
        license: 'permissive',
        licenseLabel: 'Pixabay Content License',
        desc: '最省事的一家：13 万+ 条音效，自有授权，免费商用、不要求署名、不用注册。音乐那一块也在同一个站上。缺点是社区上传、质量参差，同一个词能搜出一堆差不多的，得自己试听着挑。',
        caveat: '唯一的红线是不能把原样没改过的素材单独拿去卖（放进你自己的作品里正常用不受影响）。',
        badges: ['免署名', '免注册', '13 万+'],
        verified: '2026-08-15',
        keywords: 'pixabay 音效 sfx sound effect 音乐 music bgm 背景音乐 免费 商用 免署名 免注册 royalty free',
    },
    {
        cat: 'audio',
        title: 'Kenney · 音效',
        en: 'Kenney Audio',
        site: 'kenney.nl',
        href: 'https://kenney.nl/assets/category:Audio',
        icon: 'fa-gamepad',
        accent: 'amber',
        license: 'cc0',
        licenseLabel: 'Creative Commons CC0',
        desc: 'Kenney 的音频分区，全部 CC0：界面点击音、打击音、脚步、提示音、科幻音。特点是已经剪好了 —— 每条都短、响度一致、风格统一，拿来就用，不用自己裁头裁尾。给界面加反馈音或者做游戏，这一套的性价比最高。跟上面模型那条是同一个站。',
        badges: ['CC0', '免注册', '开箱即用'],
        verified: '2026-08-15',
        keywords: 'kenney audio 音效 ui 界面 点击 按钮 打击 脚步 提示音 科幻 游戏 cc0 免注册 短音效',
    },
    {
        cat: 'audio',
        title: 'Mixkit',
        en: 'Mixkit Free Sound Effects',
        site: 'mixkit.co',
        href: 'https://mixkit.co/free-sound-effects/',
        icon: 'fa-music',
        accent: 'blue',
        license: 'permissive',
        licenseLabel: 'Mixkit License',
        desc: '音效和背景音乐都有，自有授权允许商用，署名是「appreciated but not required」，而且不用注册。跟 Pixabay 的差别在于它是挑过的：量小得多，但翻十条有八条能用，不像社区库那样得筛。要成段的 BGM 时先来这儿。',
        badges: ['免署名', '免注册', '音效 + BGM'],
        verified: '2026-08-15',
        keywords: 'mixkit 音效 sfx 音乐 music bgm 背景音乐 免费 商用 免署名 免注册 精选 视频 素材',
    },
    {
        cat: 'audio',
        title: 'Freesound',
        en: 'Freesound',
        site: 'freesound.org',
        href: 'https://freesound.org/',
        icon: 'fa-wave-square',
        accent: 'teal',
        license: 'cc0',
        licenseLabel: 'CC0（要在搜索里筛出来）',
        account: true,
        desc: '73 万+ 条的社区库，由西班牙 Universitat Pompeu Fabra 运营，二十年了。收它是因为上面三家都是「挑好的」，量小；真要找某个具体又冷门的声音（某型号相机快门、某种鸟叫、某个地铁站的报站），只有这里有。这也是这一页唯一一条要注册的。',
        caveat: '库里四种授权混着放：CC0、CC-BY（要署名）、CC-BY-NC（禁商用）、以及已停用但老素材上还留着的 Sampling+。要维持这一页「免署名」的标准，就在高级搜索的授权筛选里只勾 CC0 —— 那个 Free Cultural Works 开关会把 CC-BY 一起放进来，它是要署名的。',
        // 「要注册」不放进 badges —— 它已经由 account 字段渲染成一枚独立的药丸了
        badges: ['73 万+', '只勾 CC0', '冷门音效'],
        verified: '2026-08-15',
        keywords: 'freesound 音效 sound 社区 库 cc0 cc-by 授权 筛选 冷门 现场 录音 field recording 环境音 ambience 注册',
    },

    // ---- 图生 3D（自己造，不是现成的）----
    {
        cat: 'generate',
        title: 'TRELLIS',
        en: 'Microsoft TRELLIS · Image to 3D',
        site: 'huggingface.co',
        href: 'https://huggingface.co/spaces/trellis-community/TRELLIS',
        icon: 'fa-wand-magic-sparkles',
        accent: 'indigo',
        license: 'oss',
        licenseLabel: 'MIT',
        desc: '微软的图生 3D 模型，跑在 HuggingFace 上，喂一张图进去出一个带贴图的网格，页面里直接能转着看，然后下 GLB。上面那几家翻不到你要的东西时走这条路 —— 它不是素材库，是现造。质量到不了 Poly Haven 那一档，做占位、做原型、做背景里的小物件够用。收它而没收更热门的腾讯混元，是因为混元的许可证把英国排除在外（见文件顶部的落选名单）。',
        caveat: 'GPU 是免费共享的，按天限额：不登录每天 2 分钟、排队优先级最低，够跑 2–4 次；注册个免费 HuggingFace 账号涨到 5 分钟。要批量生成就得登录。',
        badges: ['MIT', '免注册', '出 GLB'],
        verified: '2026-08-16',
        keywords: 'trellis 图生3d 图片转3d image to 3d 生成 ai 建模 微软 microsoft huggingface hf space 网格 mesh glb 贴图 zerogpu 免费 mit 2d转3d 照片转模型',
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
    type: 'tool' | 'demo' | 'course' | 'conv' | 'paper' | 'contest' | 'asset' | 'news';
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

    newsSites.forEach((n) => push({
        type: 'news', title: n.title, sub: n.site + ' · ' + n.cadence, desc: n.desc,
        href: n.href, icon: n.icon, tag: 'AI 资讯',
        // 几个入口的名字也进索引：搜「模型榜」应该能找到这一条
        keywords: n.keywords + ' ' + n.author + ' ' + n.entries.map((e) => e.label).join(' '),
        external: true,
    }));

    assetSites.forEach((a) => push({
        type: 'asset', title: a.title, sub: a.site + ' · ' + a.en, desc: a.desc,
        href: a.href, icon: a.icon, tag: '免费素材',
        keywords: a.keywords + ' ' + a.licenseLabel + ' ' + a.badges.join(' '), external: true,
    }));

    paperTools.forEach((p) => push({
        type: 'paper', title: p.title, sub: p.site + ' · ' + p.en, desc: p.desc,
        href: p.href, icon: p.icon, tag: '论文相关',
        keywords: p.keywords + ' ' + p.badges.join(' '), external: true,
    }));

    return rows;
}
