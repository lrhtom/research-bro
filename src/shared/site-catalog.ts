// ============================================================
//  站内地图 —— 前后端共用的那一份
//
//  这里只放**站内**的东西：自建工具、二级页面、可视化演示。
//  外部链接（网课 / 格式转换 / 编程比赛 / 论文检查）留在
//  src/client/lib/site-data.ts，那些只有页面在用。
//
//  为什么要单独拆出来：AI 悬浮球的站内导航与搜索跑在服务端
//  （提示词和工具循环都在 src/server/assistant.ts），它必须知道
//  站里有哪些页面。让它去 import 客户端的模块不合适，
//  抄一份到服务端又必然会跟首页卡片对不上 —— 所以放 shared，
//  首页卡片和 AI 助手读的是同一份数据。
//
//  站内新增一个工具/演示，改这一个文件，首页、侧栏、全站搜索、
//  AI 助手四处同时生效。
// ============================================================

export type Accent = 'indigo' | 'blue' | 'teal' | 'pink' | 'amber';

export interface Tool {
    title: string;
    subtitle: string;
    desc: string;
    icon: string;
    href: string;
    accent: Accent;
    badges: string[];
    keywords: string;
    /**
     * 挂在哪一页底下（填那一页的 href）。
     *
     * 有值就**不进首页列表和侧栏**，改由那一页自己渲染出来。
     * 之所以不是干脆从数组里删掉：这条路由真实存在，全站搜索要能搜到它，
     * AI 助手也要能把人送过去 —— 变的只是入口摆在哪儿，不是这个工具没了。
     */
    parent?: string;
}

export interface Demo {
    id: string;
    cat: string;
    /** 标题 */ t: string;
    /** 副标题 */ s: string;
    /** 一句话说明 */ d: string;
}

/** 工具内部的二级页面。只有 AI 助手在用 —— 侧栏那一层由各页面自己传 sections。 */
export interface SubRoute {
    href: string;
    title: string;
    desc: string;
}

// ---------- 自建工具（首页卡片 + 侧栏 + AI 助手导航）----------

export const tools: Tool[] = [
    {
        title: '学术三线表生成器',
        subtitle: 'Three-line Table Generator',
        desc: '在线制作标准学术三线表，支持多表管理、单元格批量样式设置、Markdown 表格导入，一键导出高清 PNG 与 Markdown。表格存在本机 SQLite 里。',
        icon: 'fa-table',
        href: '/tools/three-line-table',
        accent: 'indigo',
        badges: ['免费', 'SQLite 存储', 'PNG 导出'],
        keywords: '三线表 表格 论文 排版 markdown 导入 导出 png 学术 期刊 latex sqlite',
        // 收进「论文相关」里，首页和侧栏不再单独占一格
        parent: '/tools/paper-check',
    },
    {
        title: '记忆卡',
        subtitle: 'Spaced Repetition Flashcards',
        desc: '用官方 FSRS 算法安排复习节奏。可建多个互相独立的学习计划，各自统计进度；支持 JSON 导入与直接编辑，卡片背面按 Markdown 渲染。调度全在服务端算，评分即时落库。',
        icon: 'fa-layer-group',
        href: '/tools/flashcards',
        accent: 'amber',
        badges: ['FSRS 调度', '多学习计划', 'Markdown 背面'],
        keywords: '记忆卡 闪卡 背单词 间隔重复 复习 anki fsrs flashcard spaced repetition 学习计划 markdown',
    },
    {
        title: '英语口语练习',
        subtitle: 'Scenario Role-play Speaking',
        desc: 'AI 扮演场景里那个具体的人，全程不出戏也不纠错。难度来自听辨压力：可以给对方叠上地方口音、快语速插话、酒吧噪音、电话音质。说话用浏览器自带的语音识别转文字，全程不录音；打字也能完整练完。',
        icon: 'fa-comments',
        href: '/tools/speaking',
        accent: 'teal',
        badges: ['5 种干扰项', '不录音', '打字也能练'],
        keywords: '英语 口语 练习 speaking 对话 角色扮演 场景 雅思 ielts 听力 口音 accent 语音识别 role-play 英国 生活',
    },
    {
        title: '知识可视化',
        subtitle: 'Knowledge Visualizations',
        desc: '把那些「名词会背、图画不出」的知识点一步步画出来，覆盖计算机网络、操作系统、数据库、缓存并发、系统设计、AI 大模型与算法七大类，参数可调、单步可点。',
        icon: 'fa-wave-square',
        href: '/tools/visualizations',
        accent: 'blue',
        badges: ['30 个演示', '7 大分类', '交互可调'],
        keywords: '可视化 演示 动画 交互 计算机基础 面试 八股 原理',
    },
    {
        title: '网课大全',
        subtitle: 'CS Course Collection',
        desc: '收录国外顶尖高校公开的计算机课程视频，全部免费、免登录、可直接观看。每条都标注了课程编号、开课学校与视频来源是否为官方频道。',
        icon: 'fa-graduation-cap',
        href: '/tools/courses',
        accent: 'teal',
        badges: ['免费', '免登录', '已逐条验证'],
        keywords: '网课 公开课 课程 视频 mooc 自学 cmu mit stanford berkeley 伯克利 油管 youtube',
    },
    {
        title: '编程比赛',
        subtitle: 'Programming Contests',
        desc: '固定开周赛的线上编程比赛入口：Codeforces、AtCoder、力扣、牛客、CodeChef、yukicoder 六家算法竞赛，加上 CodePen 的前端创意挑战。只收有稳定周赛的站 —— 题库和真题存档一概不收。赛程页全部免登录就能看，下场比要各站自己的免费账号。',
        icon: 'fa-trophy',
        href: '/tools/contests',
        accent: 'amber',
        badges: ['免登录看赛程', '参赛免费', '算法 + 前端'],
        keywords: '编程 比赛 竞赛 打比赛 周赛 算法 acm icpc oi codeforces cf atcoder abc arc agc 力扣 leetcode 双周赛 codechef starters 牛客 nowcoder 小白月赛 多校 yukicoder 日本 codepen 前端 挑战 contest challenge 刷题',
    },
    {
        title: '格式转换',
        subtitle: 'Format Converters',
        desc: '汇总免注册、不限次数的在线格式转换工具：Word 转 PNG、图片切割、GIF 与视频互转。全部跳转第三方服务，本站不经手你的文件。',
        icon: 'fa-right-left',
        href: '/tools/converters',
        accent: 'pink',
        badges: ['免注册', '不限次数', '外部服务'],
        keywords: '格式转换 转换器 word png 图片 切割 gif 视频 mp4 webm 压缩',
    },
    {
        title: '论文相关',
        subtitle: 'Paper Toolkit',
        desc: '写论文这条线上要用到的东西集中在这儿：站内的三线表生成器，加上交稿前那几样第三方服务 —— AI 生成率检测、AI 改写、查重与语法。外部服务全是跳转，本站不经手你的论文；和站里其他外链不同，这一页允许收录要账号、要付费的，门槛逐条标在卡片上。',
        icon: 'fa-file-pen',
        href: '/tools/paper-check',
        accent: 'blue',
        badges: ['站内 + 外部', '门槛已标注', '不经手论文'],
        keywords: '论文 相关 写作 检查 三线表 表格 ai 检测 生成率 改写 降重 humanize 查重 原创度 学术不端 chatgpt originality detector plagiarism 语法 可读性',
    },
];

/**
 * 首页列表与侧栏用这一份 —— 挂在别人底下的不算顶层入口。
 *
 * 搜索索引和 AI 助手仍然读完整的 tools：那些工具没有消失，
 * 只是不在最外面单独占一格。
 */
export const topTools: Tool[] = tools.filter((t) => !t.parent);

/** 某一页底下挂了哪些工具，由那一页自己渲染 */
export function toolsUnder(parentHref: string): Tool[] {
    return tools.filter((t) => t.parent === parentHref);
}

// ---------- 工具内部的二级页面 ----------
//
// 首页不展示这些，但 AI 助手要能直接把人送到「统计」而不是只送到「记忆卡」。
// 带参数的路由（某个计划、某场练习）不列 —— 助手拿不到具体 id，
// 只能把人送到列表页让他自己点。

export const subRoutes: SubRoute[] = [
    { href: '/tools/flashcards/stats', title: '记忆卡 · 学习统计', desc: '复习热力图、到期曲线、各计划进度' },
    { href: '/tools/speaking/history', title: '英语口语 · 练习记录', desc: '历次口语练习的对话与总结报告' },
    // 不在 /tools 底下，但助手同样要能把人送过去
    { href: '/me', title: '个人中心', desc: '改用户名与签名、看站内足迹、收自己的外站主页链接；没有登录注册' },
];

// ---------- 可视化演示（演示本体在 public/viz/）----------

export const vizCats: Record<string, string> = {
    net: '计算机网络',
    os: '操作系统',
    db: '数据库',
    cache: '缓存与并发',
    sys: '系统设计',
    ai: 'AI 与大模型',
    algo: '算法与其它',
};

export const demos: Demo[] = [
    { id: 'tcp-congestion', cat: 'net', t: 'TCP 拥塞控制', s: '慢启动 / 拥塞避免 / 快重传 / 快恢复', d: 'cwnd 锯齿图 —— 名词人人会背，图没几个人画得出' },
    { id: 'tcp-window', cat: 'net', t: 'TCP 滑动窗口', s: '窗口滑动 / 流量控制 / 零窗口', d: '四个指针怎么滑，接收方处理不过来时会发生什么' },
    { id: 'tcp-handshake', cat: 'net', t: '三次握手 / 四次挥手', s: '状态机 · TIME_WAIT · CLOSE_WAIT', d: '状态怎么迁移，为什么不是两次，两个 WAIT 到底卡在哪' },
    { id: 'http-evolution', cat: 'net', t: 'HTTP 演进与队头阻塞', s: '1.0 / 1.1 / 2 / 3 五轨对比', d: '「多路复用」到底解决了哪一层的队头阻塞，H3 又多解决了什么' },
    { id: 'tls-handshake', cat: 'net', t: 'TLS 握手', s: 'HTTPS 比 HTTP 多的那一层', d: '对称与非对称怎么配合，证书链怎么验到根 CA' },
    { id: 'dns', cat: 'net', t: 'DNS 解析', s: '递归 · 迭代 · 缓存 TTL', d: '一次域名解析走了几跳，递归和迭代到底差在哪，缓存怎么把它压到 0.5ms' },
    { id: 'http-cache', cat: 'net', t: 'HTTP 缓存', s: '强缓存 · 协商缓存 · ETag', d: '第二次请求到底发不发、发了以后传不传 body，全看这几个头' },
    { id: 'scheduling', cat: 'os', t: '进程调度算法', s: 'FCFS / SJF / SRTF / RR / 优先级', d: '同一批进程喂给五种调度算法，甘特图并排看谁更快' },
    { id: 'virtual-memory', cat: 'os', t: '虚拟内存', s: '地址翻译 · 缺页 · 页面置换', d: '地址怎么翻译、内存满了赶谁走，以及为什么加内存反而可能更慢' },
    { id: 'gc', cat: 'os', t: '垃圾回收算法', s: '标记-清除 / 整理 / 复制 / 分代', d: '同一批存活对象，四种回收方式在堆上留下完全不同的形状' },
    { id: 'deadlock', cat: 'os', t: '死锁', s: '成环 · 检测 · 银行家算法', d: '资源分配图怎么成环，以及「有环就死锁」这句话错在哪' },
    { id: 'mvcc', cat: 'db', t: 'MVCC 与事务隔离级别', s: 'ReadView · 版本链 · 幻读', d: '同一段并发操作，RC 和 RR 为什么读到不一样的值' },
    { id: 'bplus-tree', cat: 'db', t: 'B+ 树索引', s: '分裂 / 树高 / 回表 / 最左匹配', d: '插入怎么触发分裂，以及为什么数据库不用红黑树' },
    { id: 'join-algorithms', cat: 'db', t: 'Join 算法', s: '嵌套循环 / 哈希 / 排序归并', d: '同样两张表，四种 join 算法的比较次数能差两个数量级' },
    { id: 'buffer-pool', cat: 'db', t: 'Buffer Pool', s: '分区 LRU · 脏页 · 预读', d: 'MySQL 用的不是教科书 LRU —— 一次全表扫描就能看出为什么' },
    { id: 'wal', cat: 'db', t: 'WAL 与崩溃恢复', s: 'redo · undo · checkpoint', d: '随便挑个时刻断电，看数据库怎么把账重新算平' },
    { id: 'cache-problems', cat: 'cache', t: '缓存穿透 / 击穿 / 雪崩', s: '三种故障的流量形状与解法', d: '三兄弟到底差在哪，各自把数据库打成什么样' },
    { id: 'singleflight', cat: 'cache', t: '单飞锁 singleflight', s: '并发相同请求合并为一次', d: '一堆请求同时要同一个 key，怎么让后端只被打一次' },
    { id: 'cache-eviction', cat: 'cache', t: '缓存淘汰策略', s: 'LRU · LFU · Redis 近似 LRU', d: '缓存满了扔谁？顺便看看 Redis 为什么不用真 LRU' },
    { id: 'rate-limit', cat: 'sys', t: '限流四算法', s: '固定窗口 / 滑动窗口 / 漏桶 / 令牌桶', d: '同一条请求流喂给四种限流器，看谁放谁挡' },
    { id: 'consistent-hash', cat: 'sys', t: '一致性哈希', s: '哈希环 · 虚拟节点 · 数据迁移', d: '加一台机器要搬多少数据：取模 N/(N+1)，一致性哈希 1/(N+1)' },
    { id: 'bloom-filter', cat: 'sys', t: '布隆过滤器', s: '位数组 · 多哈希 · 假阳性', d: '用几十 MB 判断一亿个 key 在不在，代价是偶尔会误判「在」' },
    { id: 'attention', cat: 'ai', t: 'Self-Attention 与 KV Cache', s: 'QKᵀ · 因果掩码 · 增量解码', d: '5 个 token 手算一遍注意力，再看 KV Cache 省了什么、又吃掉了什么' },
    { id: 'bpe', cat: 'ai', t: 'BPE 分词', s: '子词怎么被合并出来', d: '从字符出发反复合并高频对，最后 lowest 变成 low + est' },
    { id: 'fsrs', cat: 'algo', t: 'FSRS 间隔重复算法', s: 'Free Spaced Repetition Scheduler', d: '一张卡片被复习一次，算法是怎么算出「下次什么时候再看」的' },
    { id: 'kmp', cat: 'algo', t: 'KMP 字符串匹配', s: 'next 数组 · 主串指针不回退', d: '失配了该往右滑几位？以及为什么主串指针一次都不用回退' },
    { id: 'skip-list', cat: 'algo', t: '跳表 Skip List', s: 'Redis ZSet 的骨架', d: '抛硬币抛出来的多层索引，凭什么能做到 O(log n)' },
    { id: 'pathfinding', cat: 'algo', t: 'Dijkstra 与 A*', s: '启发函数怎么把搜索收窄', d: '一个摊成圆，一个收成锥 —— 差别就在那个 h' },
    { id: 'union-find', cat: 'algo', t: '并查集', s: '路径压缩 · 按秩合并', d: '一次 find 顺手把整条路拍到根上 —— 那一下就是灵魂' },
    { id: 'hashmap', cat: 'algo', t: 'HashMap', s: '扰动 · 扩容 · 树化', d: '一个 key 落到哪个桶，以及那句 h ^ (h>>>16) 到底在救什么' },
];

/** 演示的深链接。可视化页面靠 hash 选中具体那一个。 */
export function demoHref(id: string): string {
    return `/tools/visualizations#demo=${id}`;
}
