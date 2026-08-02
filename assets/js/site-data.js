// ============================================================
//  工具箱 · 全站数据源（单一事实来源）
//
//  首页卡片、网课大全、格式转换、以及全站搜索框，全都从这里读数据。
//  想新增内容只改这一个文件，四处会同步更新。
//
//  href 一律写成「相对站点根目录」的路径（如 tools/courses/index.html）。
//  各页面按自己所处的深度传一个 base 前缀（首页是 ''，工具页是 '../../'），
//  由 SITE.url() 拼出真实地址 —— 这样 file:// 双击打开也能跑。
//
//  外部链接的硬性要求（三条缺一不可）：免登录、免费、事先亲自打开验证过。
//  每条外链都在 verified 字段记了核验日期。
// ============================================================

window.SITE = {};

// ---------- 自建工具（首页卡片）----------

SITE.tools = [
    {
        title: '学术三线表生成器',
        subtitle: 'Three-line Table Generator',
        desc: '在线制作标准学术三线表，支持多表管理、单元格批量样式设置、Markdown 表格导入，一键导出高清 PNG 与 Markdown。',
        icon: 'fa-table',
        href: 'tools/three-line-table/index.html',
        accent: 'indigo',
        badges: ['免费', '本地保存', 'PNG 导出'],
        keywords: '三线表 表格 论文 排版 markdown 导入 导出 png 学术 期刊 latex',
    },
    {
        title: '知识可视化',
        subtitle: 'Knowledge Visualizations',
        desc: '把那些「名词会背、图画不出」的知识点一步步画出来，覆盖计算机网络、操作系统、数据库、缓存并发、系统设计、AI 大模型与算法七大类，参数可调、单步可点。',
        icon: 'fa-wave-square',
        href: 'tools/visualizations/index.html',
        accent: 'blue',
        badges: ['30 个演示', '7 大分类', '交互可调'],
        keywords: '可视化 演示 动画 交互 计算机基础 面试 八股 原理',
    },
    {
        title: '网课大全',
        subtitle: 'CS Course Collection',
        desc: '收录国外顶尖高校公开的计算机课程视频，全部免费、免登录、可直接观看。每条都标注了课程编号、开课学校与视频来源是否为官方频道。',
        icon: 'fa-graduation-cap',
        href: 'tools/courses/index.html',
        accent: 'teal',
        badges: ['免费', '免登录', '已逐条验证'],
        keywords: '网课 公开课 课程 视频 mooc 自学 cmu mit stanford berkeley 伯克利 油管 youtube',
    },
    {
        title: '格式转换',
        subtitle: 'Format Converters',
        desc: '汇总免注册、不限次数的在线格式转换工具：Word 转 PNG、图片切割、GIF 与视频互转。全部跳转第三方服务，本站不经手你的文件。',
        icon: 'fa-right-left',
        href: 'tools/converters/index.html',
        accent: 'pink',
        badges: ['免注册', '不限次数', '外部服务'],
        keywords: '格式转换 转换器 word png 图片 切割 gif 视频 mp4 webm 压缩',
    },
];

// ---------- 网课（外部链接）----------
//
// source: 'official' = 学校/课程组自己的官方频道，长期稳定
//         'mirror'   = 第三方搬运，随时可能被删，仅作备选
//
// 全部于 2026-08-01 逐条打开核实：免登录、免费、内容与标题相符。

SITE.courseCats = [
    { id: 'sys', name: '系统与底层', icon: 'fa-microchip' },
    { id: 'db', name: '数据库', icon: 'fa-database' },
    { id: 'net', name: '计算机网络', icon: 'fa-network-wired' },
    { id: 'dist', name: '分布式系统', icon: 'fa-circle-nodes' },
    { id: 'sec', name: '安全', icon: 'fa-shield-halved' },
    { id: 'guide', name: '学习路线', icon: 'fa-compass' },
];

SITE.courses = [
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

SITE.converters = [
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

// ---------- 可视化演示（供搜索用；演示本体在 tools/visualizations/）----------

SITE.vizCats = {
    net: '计算机网络', os: '操作系统', db: '数据库', cache: '缓存与并发',
    sys: '系统设计', ai: 'AI 与大模型', algo: '算法与其它',
};

SITE.demos = [
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

// ---------- 工具函数 ----------

/** 站内相对路径 → 当前页面可用的地址。base 由各页面自己设定 */
SITE.base = '';
SITE.url = function (href) {
    if (/^https?:\/\//.test(href)) return href;   // 外链原样返回
    return SITE.base + href;
};

/**
 * 汇总成一张搜索表。每条 = { type, title, sub, desc, text, href, icon, tag, external }
 * text 是拼好的小写检索串，搜索时直接在它上面做子串匹配。
 */
SITE.buildIndex = function () {
    const rows = [];
    const push = (o) => {
        o.text = [o.title, o.sub, o.desc, o.tag, o.keywords].join(' ').toLowerCase();
        rows.push(o);
    };

    SITE.tools.forEach((t) => push({
        type: 'tool', title: t.title, sub: t.subtitle, desc: t.desc,
        href: t.href, icon: t.icon, tag: '工具', keywords: t.keywords, external: false,
    }));

    SITE.demos.forEach((d) => push({
        type: 'demo', title: d.t, sub: d.s, desc: d.d,
        href: 'tools/visualizations/index.html#demo=' + d.id,
        icon: 'fa-wave-square', tag: '演示 · ' + (SITE.vizCats[d.cat] || ''),
        keywords: d.id.replace(/-/g, ' '), external: false,
    }));

    SITE.courses.forEach((c) => push({
        type: 'course', title: c.code + ' ' + c.title, sub: c.school + ' · ' + c.en, desc: c.desc,
        href: c.href, icon: 'fa-graduation-cap', tag: '网课',
        keywords: c.keywords + ' ' + c.channel, external: true,
    }));

    SITE.converters.forEach((c) => push({
        type: 'conv', title: c.title, sub: c.site + ' · ' + c.en, desc: c.desc,
        href: c.href, icon: c.icon, tag: '格式转换',
        keywords: c.keywords, external: true,
    }));

    return rows;
};
