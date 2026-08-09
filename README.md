# 工具箱 · Toolbox

个人自用的在线工具站：学术三线表、记忆卡（间隔重复）、知识可视化、名校网课大全、格式转换，全站可搜索。

**技术栈**：Node.js + TypeScript + React + SQLite
后端 Express，前端 Vite + React Router 单页应用，数据库 better-sqlite3。
**没有登录逻辑** —— 单机单人使用，一个进程一个库文件。

```bash
npm install
npm run migrate      # 首次：把旧版三线表 JSON 备份导进 SQLite（可重复跑，幂等）
npm run seed         # 首次：灌入 20 副面试记忆卡牌组（可重复跑，幂等）
npm run dev          # 前端 http://localhost:6767，接口 6969
```

生产模式是单端口单进程 —— 这时候没有 Vite，Express 一个人托管接口和打好的前端，
所以生产访问的是**后端那个口 6969**：

```bash
npm run build && npm start   # http://localhost:6969
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | 先探两个空闲端口，再并行起 Express（`API_PORT`，默认 6969）与 Vite（`PORT`，默认 6767） |
| `npm run dev:all` | 不探端口，直接起那两个进程（`npm run dev` 内部用的就是它） |
| `npm run build` | 打包前端到 `build/client`，编译后端到 `build/server` |
| `npm start` | 生产模式单进程单端口，Express 同时托管接口与打好的前端 |
| `npm test` | 跑验收测试（vitest） |
| `npm run typecheck` | 前后端两份 tsconfig 各查一遍 |
| `npm run seed` | 灌入 `seed/decks/*.json` 里的记忆卡牌组（幂等，同名计划跳过） |
| `npm run seed:check` | 只校验牌组文件，不写库 |
| `npm run seed:sync` | 只把改过的答案覆盖进已有卡片，FSRS 进度一张不动 |
| `npm run seed:replace` | 同名计划先删掉再重建（**会清空进度与复习流水**） |

> 前后端的端口变量是分开的：后端只认 `API_PORT`（6969），前端只认 `PORT`（6767）。
> 开发时两个进程由同一条 npm 命令拉起、继承同一份环境变量，共用一个 `PORT` 会互相抢端口。

### 端口被别的程序占了怎么办

`npm run dev` 会在**拉起任何子进程之前**先真的 listen 一下探测端口，
被占就往后顺延（最多 30 个），并把最终端口同时传给前端和后端 —— 代理不可能指错。
想固定用某个端口就自己给：

```bash
PORT=7000 API_PORT=7001 npm run dev
```

这一层不是可有可无的。Vite 的 `/api` 代理写死指向 `API_PORT`，
要是后端因为端口被占而没起来、Vite 却还在往那个端口转发，
**本站的接口请求就会打到占着端口的那个陌生程序上** ——
页面照常打开、能点，只有数据全不对，这种故障最难查。

生产模式（`npm start`）撞上占用不会顺延，而是打印占用信息后退出：
服务偷偷搬到隔壁端口跟没起来一样难查。要换端口就显式给 `API_PORT`。

---

## 目录结构

```
src/
├── server/                     Express + SQLite（NodeNext，相对 import 带 .js 后缀）
│   ├── index.ts                入口：路由装配、生产模式托管前端、统一错误出口
│   ├── db.ts                   连接、schema 执行、settings 读写
│   ├── tables.ts               三线表数据访问
│   ├── table-html.ts           服务端 HTML 清洗与形状解析（node-html-parser）
│   ├── fsrs.ts                 ★ 全站唯一的调度入口，封装 ts-fsrs
│   ├── time.ts                 用户时区下的日历日边界
│   ├── study.ts                ★ 计划 / 卡片 / 今日队列 / 进度 / 成绩单
│   ├── study.test.ts           验收测试
│   ├── routes-tables.ts        三线表 + 备份 + 设置接口
│   └── routes-cards.ts         记忆卡接口
├── client/                     Vite + React（bundler 解析，@ 指向 src/client）
│   ├── main.tsx  App.tsx       入口与路由
│   ├── pages/                  Home / ThreeLineTable / Visualizations / Courses /
│   │                           Converters / Plans / PlanDetail / Study / Result
│   ├── components/
│   │   ├── table/              三线表编辑器与两个弹窗
│   │   └── cards/              记忆卡的进度条、卡片编辑器、导入面板
│   ├── lib/                    api / markdown / diagrams / format / search / site-data / table-dom
│   └── styles/                 global / home / search / courses / converters / table / flashcards
└── shared/                     前后端共用（只放类型与纯函数）
    ├── types.ts                接口数据形状
    ├── table-defaults.ts       三线表默认骨架与备份格式常量
    └── card-import.ts          JSON 导入的解析与规范化

public/viz/                     30 个可视化演示的原生 JS 与 viz.css（一行未改）
seed/decks/*.json               20 副面试记忆卡牌组的源文件，可直接手改后重新 seed
scripts/seed-decks.ts           把 seed/decks 灌进库（走和网页导入相同的代码路径）
db/schema.sql                   SQLite schema，唯一事实来源
data/app.db                     数据库本体（已 gitignore）
```

### 预置的 20 副记忆卡牌组

按面试提纲的四层结构分类，共 **558 张卡**，每张答案里都配了一张图（见下文「答案里的图」）。
`seed/decks/` 下的 JSON 就是源文件，想改内容直接改文件再 `npm run seed:sync`
（只覆盖答案，进度不动；`seed:replace` 会连进度一起清掉），也可以在网页上直接编辑。

| # | 牌组 | 张数 |
|---|---|---|
| 01 | 🔥 高频 20 题（面试主线） | 20 |
| 02 | 测试设计与流程（手工测试基础） | 30 |
| 03 | 自动化测试工程 | 30 |
| 04 | 性能测试与可观测性 | 30 |
| 05 | 无障碍测试（英国 WCAG / Equality Act） | 22 |
| 06 | LLM · AI · Agent · Eval | 33 |
| 07 | AI 辅助测试 | 22 |
| 08 | JavaScript / TypeScript | 32 |
| 09 | Python / Django | 22 |
| 10 | Go 语言与并发 | 34 |
| 11 | 数据结构与算法（保持手感） | 21 |
| 12 | HTTP 与 API 设计 | 28 |
| 13 | Web 安全 | 26 |
| 14 | 操作系统 | 29 |
| 15 | 计算机网络 | 34 |
| 16 | 数据库（MySQL / InnoDB） | 33 |
| 17 | Redis 与缓存 | 29 |
| 18 | Linux 与故障排查 | 24 |
| 19 | Git · CI/CD · 容器 | 28 |
| 20 | 系统设计 · 分布式 · 消息队列 · 设计模式 | 31 |

第 01 副是主线：那 20 题据说覆盖技术提问的约七成，所以答案写得比别的牌更深
（平均 1300 字），每张末尾还带一个「追问预警」小节，列出面试官顺着这题最可能追问的点。

**每日新卡上限是按副牌各自算的**，20 副全开的话一天两百多张新卡不现实。
实际用法是只主攻一两副，其余的把上限调成 0 先搁着，按面试临近程度再放开。

---

## 记忆卡

### 调度：不自己写公式

复习节奏全部交给官方的 [`ts-fsrs`](https://github.com/open-spaced-repetition/ts-fsrs)，
封装在 `src/server/fsrs.ts` 里，那是全站唯一调用调度器的地方。
公式、权重、状态机一概不碰，只做「数据库行 ↔ 库的 Card 结构」的翻译。

参数是这么定的（两条验收要求其实互相拉扯，得靠不对称的步长化解）：

| 参数 | 值 | 为什么 |
|---|---|---|
| `learning_steps` | `['1m']` | 只有一个学习步。新卡评「良好」直接毕业进 Review，间隔按天算 → 满足「新卡评良好后今天不再出现」；评「重来」退回这一步，1 分钟后重来 → 满足「重来的卡当场返回」。用库默认的 `['1m','10m']` 的话，新卡评良好只会走到第二步，10 分钟后还在今天队列里，第一条验收就过不了。 |
| `relearning_steps` | `['10m']` | 复习卡忘掉之后 10 分钟内再来一次，同一次学习里能收尾。 |
| `enable_fuzz` | `false` | 关掉间隔的随机抖动。抖动对真实记忆有好处，但会让验收测试不可复现；本地单人使用，这点收益不值得拿确定性去换。 |

### 调度跑在服务端

评分接口只接受 `{cardId, rating}`。新的 `stability` / `difficulty` / `due` / `state`
一律由服务端算出来再返回，客户端连提交的机会都没有 —— 这是「调度器」和「意见箱」的区别。

评分只有四档：`1=重来 2=困难 3=良好 4=简单`，别的值一律 400。

### 今日队列

```
到期卡：due 落在今天结束之前的全部卡片，不设上限 —— 那是已经欠下的债
新  卡：按 daily_new_limit 减去今天已引入的数量封顶（默认 20）
顺序  ：真正逾期的 → 新卡 → 今天稍后的学习步骤
```

用「今天之内」而不是字面的 `due <= now`，有两个原因：按天算的间隔本来就该整天到期
（昨天 10:00 学的、间隔 1 天，今天 09:00 也算到期）；而且评「重来」之后卡片排到 1 分钟后，
只有把今天之内的都算进队列，它才能在同一次学习里回来。学习步骤排在新卡之后，
是为了让刚评过「重来」的卡不至于立刻又蹦到眼前。

### 「今天」按日历日切

不是滚动 24 小时窗口。23:55 评的卡和 00:05 评的卡分属两天。
时区取自 `settings.timezone`，前端首次加载时把浏览器时区报上去；
边界计算在 `src/server/time.ts`，只用 `Intl`，夏令时也算得对。

### 进度计数的三条规矩

1. **分母 = 今日已完成 + 队列剩余**，不是每日上限。
   牌组今天只拿得出 91 张却显示 `0 / 100` 的话，进度条永远填不满，目标永远够不着。
2. **一张卡算一个单位**。评了三次「重来」再评一次「良好」，是 **1 张**学完，不是 4 个事件。
   按张和按次这两种口径绝不放在同一行数字里。
3. **今天任何时刻忘过的卡，只进 relearned 桶**，别的桶一律不进。
   四个桶（重新学会 / 困难 / 良好 / 简单）互斥且穷尽，加起来必然等于学完的卡数。
   按次的点击统计单独列，标题里写明单位是「次」。

### 中途退出不丢东西

每次评分当场落库（卡片状态 + 流水在同一个事务里），没有「学完再统一保存」这回事。
学到一半关掉标签页，已评过的卡一张都不丢；重新打开时进度和队列位置直接来自服务端，
跟关掉前完全一致。前端组件里的 state 只是「当前这一屏在显示什么」，不是数据。

### 学习计划 / 导入 / 编辑

- 可以建任意多个**互相独立**的学习计划，各自有卡片、每日新卡上限和进度统计。
- 卡片可以直接在网页上增删改，也可以从 JSON 导入（导进已有计划，或一步建一个新计划）。
- 导入解析写得比较宽容，接受这些形状与别名：

```jsonc
[ {"front": "…", "back": "…"}, … ]              // 顶层数组
{ "cards": [ … ] }                               // 或者裹一层
{ "name": "计划名", "dailyNewLimit": 20, "cards": [ … ] }
```

正面认 `front / question / q / term / 正面 / 问题`，
背面认 `back / answer / a / definition / 背面 / 答案`，
也接受 `"正面 | 背面"` 这种一行式写法。
解析用的是 `shared/card-import.ts`，前端预览和后端入库是同一套规则，
不会出现「预览说能导 30 张、导进去只剩 12 张」。

- **卡片背面按 Markdown 渲染**（marked + DOMPurify）。卡片可以从任意 JSON 导入，
  所以渲染前一律洗一遍，不假定内容可信。编辑器里带实时预览。

### 答案里的图（mermaid）

背面的 ` ```mermaid ` 代码块会被渲染成真正的图：流程图、时序图、思维导图、
状态图、象限图、折线柱状图都能用。20 副技术牌组的 **558 张卡每张都配了一张图**，
按题目性质选型：协议与交互用时序图，流程与判断用流程图，分类与清单用思维导图，
带数字的趋势用 xychart。

```
src/client/lib/diagrams.ts          动态 import mermaid，把 pre>code.language-mermaid 换成 <figure class="fc-diagram">
src/client/components/cards/Markdown.tsx   学习页与编辑器预览共用的渲染出口
```

三点取舍：

- **动态 import**。mermaid 打包出来一兆多，一张图都没有的卡片不会加载它。
- **画失败不吞内容**。语法错就把原来的代码块留在原地并标成 `language-mermaid-broken`，
  宁可看到源码，也不该看到空白。
- **图源是纯文本**，跟着 JSON 一起进版本库，可 diff 可搜索，不引入二进制资源。

图的语法有两条踩过的坑，改牌组时注意：**时序图与状态图的文字不要加引号**
（引号会被原样画出来），**任何图里都别用分号**（mermaid 把它当语句分隔符）。
流程图、思维导图、象限图的标签则必须用引号包住，中文标点才不会被当成语法。

### 验收测试

`npm test`，覆盖需求点名的六条外加几条同样容易做错的：

- 新卡评「良好」排到将来，今天不再出现在队列里
- 评「重来」的卡当场返回；最终通过后只计一次，且只进 relearned 桶
- 先「困难」再「重来」最后「简单」，仍然只进 relearned
- 四个桶之和 == 今天学完的卡数
- 整场学习每一步都满足 分母 == 已完成 + 剩余，且分母不会退回成每日上限
- 新卡受每日上限限制、到期卡不受限制
- 换个数据库连接重新读（相当于刷新页面），进度与队列位置一模一样
- 23:55 与 00:05 分属不同日历日；日历日起止点在跨夏令时的时区也算得对
- 两个学习计划互不影响

---

## 三线表

表格整段存 HTML + 派生的 `caption` / `row_count` / `col_count` 三列。

**为什么整段存 HTML**：编辑器本身就是 contenteditable 直接操作 DOM，存原文能做到
100% 无损（从 Word/Excel 粘进来的富文本、逐格的字号斜体、对齐边距全都保得住），
也让 html2canvas 的导出跟屏幕上所见完全一致。派生列只服务于列表展示与搜索，写入时算好。

**保存时机**：打字防抖 700ms、结构与样式操作立即存、`Ctrl+S` 手动存并提示、
切表和关页面前强制冲一次（`fetch(..., { keepalive: true })`）。

**备份**：`data/app.db` 不进版本库，也只在这台机器上。要换设备或留存档，
走侧边栏「数据备份与迁移 → 导出全部表格为 JSON」。导出格式与最早那版静态站完全一致。

```bash
npm run migrate                          # 默认读 Downloads 里那份备份
npm run migrate -- <备份.json>           # 指定文件
npm run migrate -- <备份.json> --replace # 先清空再导入
```

---

## 样式表的一条硬规矩

站里有三种完全不同的页面外观（门户 / 三线表编辑器 / 知识可视化），
而单页应用里样式表是全站共用一份的。为了让它们互不干扰：

> **除 `global.css` 外，任何样式表都不许写 `body` / `html` 选择器**，
> 页面级的整屏样式一律挂在自己的 shell 容器类上：
> `.site-shell` / `.tt-shell` / `.viz-shell`。

配套的四处处理：

- `home.css` 原来的 `.card` / `.brand` 与 `viz.css` 同名，已改成 `.tool-card` / `.site-brand`
- `table.css` 里裸的 `button {}` 规则全部锁进 `.tt-shell button`，否则会接管全站按钮
- 记忆卡的类名一律 `fc-` 前缀
- `viz.css` 干脆不进打包：它跟 30 个演示脚本一起放在 `public/`，
  由 `VizApp` 挂载时插 `<link>`、卸载时摘掉，双保险

**还有一条踩过坑的规矩：不要跨文件引用别人的 `@keyframes` 名字。**
上面把 `home.css` 的 `card-in` 改名成 `tool-card-in` 时，`courses.css` 还在引用旧名字，
于是动画静默失效 —— `.course { opacity: 0 }` 永远停在 0，**DOM 里查得到、页面上看不见**，
课程列表整个空白。现在 `courses.css` 用自己的 `course-in`。

这类 bug 有个通用教训：**验证「渲染出来了」不能只数 DOM 节点**，
必须看计算后的 `opacity` 和 `getBoundingClientRect()`，否则 `opacity:0` 的元素会骗过检查。

30 个可视化演示的 JS **一行未改**地复用。每个演示都是 `mount(container)` / `unmount()`
两个函数，用 canvas 和手写 DOM 画图，翻成 React 组件只会徒增几千行且毫无收益。
React 侧只负责按顺序注入脚本（靠 `script.async = false` 保证执行顺序）、
把 `Viz.dom` 指到容器上、复现 `#demo=` 哈希的初始化逻辑。

---

## ⚠️ 关于 E: 盘（FAT32）

项目所在的 E: 盘是 **FAT32**，而且 `fsutil dirty query E:` 报 **`Volume - E: is Dirty`**。

已经踩到的坑，一个比一个严重：

1. 删掉的目录会留下空壳，任何进程都打不开它（`src/app`、`src/lib` 这些迁移时删掉的旧目录
   就是这么来的）。只是空目录，不影响构建和运行。
2. **构建产物目录被彻底锁死**。旧的 `dist/client/viz` 既删不掉、也改不了名、
   连 `lstat` 都 EPERM（`rd /s /q`、robocopy 镜像空目录都试过，全部 Access denied），
   于是 Vite 清空产物目录时直接失败、构建跑不起来。
   根目录那个残留的 `dist/` 是垃圾，`.gitignore` 里已经忽略掉了。

   换个目录名只能挡一次 —— 新目录第一次构建之后照样会长出幽灵。
   实测**文件是能正常删的，只有目录会变幽灵**，所以真正的绕法是：
   `vite.config.ts` 里 `emptyOutDir: false`，改由 `scripts/clean-build.mjs`
   在构建前递归 unlink 所有文件、一个目录都不碰。这样构建就可重复了。
   卷修好之后可以删掉那个脚本、把 `emptyOutDir` 改回 `true`。

修法：

```bash
chkdsk E: /f
```

修完之后可以手工删掉根目录残留的 `dist/`，产物目录名想换回 `dist` 也随意
（要同时改 `vite.config.ts`、`tsconfig.server.json`、`package.json` 的 `start`、
以及 `src/server/index.ts` 里判断「是否跑在编译产物里」的那个目录名）。

**根治办法是把项目挪到 NTFS 分区（C: / D:）**。FAT32 没有日志、掉电容易坏库，
存论文表格和学习记录这种东西并不合适。挪之前先导出一份 JSON 备份。

> 历史记录：上一版用 Next.js 时，`next build` 需要一个补丁才能跑 ——
> FAT32 上对普通文件调 `fs.readlink` 返回 `EISDIR` 而不是 `EINVAL`，
> Next 的产物追踪器 `@vercel/nft` 不认这个错误码。换成 Vite + tsc 之后
> 构建链路里没有 nft，补丁已经删掉了。
