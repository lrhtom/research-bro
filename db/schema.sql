-- ============================================================
--  工具箱 · SQLite schema
--
--  单用户本地应用，没有账号体系，也就没有 user_id 这一列。
--  这个文件是 schema 的唯一事实来源，服务端启动时整份执行一遍
--  （全部 IF NOT EXISTS，反复跑无副作用）。
-- ============================================================

-- ------------------------------------------------------------
--  学术三线表
--
--  表格正文整段存 HTML（编辑器本身就是 contenteditable 直接操作 HTML，
--  存原文可以做到 100% 无损）；caption / row_count / col_count 是从
--  HTML 解析出来的派生列，只为列表展示与搜索服务，写入时一并算好。
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tables (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL DEFAULT '未命名表格',
    html        TEXT    NOT NULL,

    caption     TEXT    NOT NULL DEFAULT '',
    row_count   INTEGER NOT NULL DEFAULT 0,
    col_count   INTEGER NOT NULL DEFAULT 0,

    -- 显示顺序，升序。新建的表拿当前最小值 - 1，于是排在最前
    sort_order  INTEGER NOT NULL DEFAULT 0,

    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tables_sort ON tables (sort_order, created_at);

-- ------------------------------------------------------------
--  记忆卡（FSRS 间隔重复）
--
--  一个「学习计划」= 一个独立的牌组：自己的卡片、自己的每日新卡上限、
--  自己的进度统计。计划之间互不影响。
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    -- 每天最多引入多少张新卡。到期卡不受此限制 —— 那是已经欠下的债。
    daily_new_limit INTEGER NOT NULL DEFAULT 20,
    -- 收藏。收藏过的计划在列表里排到最前面。
    favorite        INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

-- 注意：依赖 favorite 这类「后加列」的索引不要写在这里。
-- 本文件是整份 exec 的，对已经存在的表，CREATE TABLE IF NOT EXISTS 不会补列，
-- 于是索引会在一个还不存在的列上创建、直接报 no such column。
-- 这类索引统一放到 src/server/db.ts 的 applyColumnMigrations 里，补完列再建。

-- 卡片。调度相关的字段全部由 ts-fsrs 计算后原样落库，服务端不自己算公式。
CREATE TABLE IF NOT EXISTS cards (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id        INTEGER NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
    front          TEXT    NOT NULL,
    back           TEXT    NOT NULL DEFAULT '',   -- Markdown，前端渲染

    -- new | learning | review | relearning
    state          TEXT    NOT NULL DEFAULT 'new',
    stability      REAL    NOT NULL DEFAULT 0,    -- 记忆能保持的天数
    difficulty     REAL    NOT NULL DEFAULT 0,    -- 1..10
    due            TEXT    NOT NULL,              -- ISO UTC
    last_review    TEXT,                          -- ISO UTC，从没复习过就是 NULL
    reps           INTEGER NOT NULL DEFAULT 0,
    lapses         INTEGER NOT NULL DEFAULT 0,

    -- ts-fsrs 自己还要用到的三个字段，一并存回去，下次调度原样喂回给它
    elapsed_days   REAL    NOT NULL DEFAULT 0,
    scheduled_days REAL    NOT NULL DEFAULT 0,
    learning_steps INTEGER NOT NULL DEFAULT 0,

    -- 收藏。**只影响管理界面的排序与筛选，不参与调度** ——
    -- 「我关心这张卡」和「什么时候该复习它」是两回事，
    -- 让收藏插队会让这些卡的间隔长期偏离 FSRS 算出来的安排。
    favorite       INTEGER NOT NULL DEFAULT 0,

    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_plan_due   ON cards (plan_id, due);
CREATE INDEX IF NOT EXISTS idx_cards_plan_state ON cards (plan_id, state);

-- 每一次评分的流水。
--
-- 这张表是进度与统计的唯一依据：进度分母、四个桶、按次统计、
-- 「今天引入了几张新卡」全都从它算出来，所以每次评分必须当场落库 ——
-- 中途关掉页面不会丢任何已评过的卡。
CREATE TABLE IF NOT EXISTS reviews (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id           INTEGER NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    plan_id           INTEGER NOT NULL REFERENCES plans (id) ON DELETE CASCADE,

    rating            INTEGER NOT NULL,   -- 1=Again 2=Hard 3=Good 4=Easy
    reviewed_at       TEXT    NOT NULL,   -- ISO UTC

    -- 用户时区下的日历日 YYYY-MM-DD。
    -- 「今天」按日历日切，不是滚动 24 小时窗口：23:55 和 00:05 评的卡分属两天。
    review_day        TEXT    NOT NULL,

    duration_ms       INTEGER NOT NULL DEFAULT 0,

    -- 评分前的状态。用来统计「今天引入了几张新卡」（state_before = 'new'）
    state_before      TEXT    NOT NULL,
    -- 评分后的状态，留痕便于复盘
    state_after       TEXT    NOT NULL,
    due_after         TEXT    NOT NULL,
    stability_after   REAL    NOT NULL,
    difficulty_after  REAL    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_plan_day ON reviews (plan_id, review_day);
CREATE INDEX IF NOT EXISTS idx_reviews_card_day ON reviews (card_id, review_day);

-- ------------------------------------------------------------
--  英语口语场景练习
--
--  一场练习 = 一个 speaking_sessions 行 + 若干 speaking_turns 行。
--
--  干扰项设置必须跟对话存在一起：同一句「say that again?」，在开了
--  背景噪音的场景里是设计好的听力压力，在没开的场景里是对方真没听懂。
--  只留对话不留设置，过几天自己都读不懂当时发生了什么。
--
--  这里没有任何跟发音有关的列，将来也不要加 —— 整套功能从头到尾
--  只有文字（用户打的字，或浏览器语音识别猜的字），没有音频。
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS speaking_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 喂给模型的场景描述（英文）与界面上显示的名字（中文）
    scenario        TEXT    NOT NULL,
    label           TEXT    NOT NULL DEFAULT '',
    -- 预设的 key；自己写的场景是空串
    preset          TEXT    NOT NULL DEFAULT '',

    -- 产生这段对话的那一份干扰项设置，JSON：{"accent":["scouse"],"noise":["pub"]}
    modifiers       TEXT    NOT NULL DEFAULT '{}',
    -- 目标词，JSON 数组：[{"en":"deposit","zh":"押金"}]
    target_words    TEXT    NOT NULL DEFAULT '[]',

    -- active | finished
    status          TEXT    NOT NULL DEFAULT 'active',
    -- 总结报告 JSON；没生成过就是 NULL
    report          TEXT,

    started_at      TEXT    NOT NULL,
    finished_at     TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_speaking_sessions_time ON speaking_sessions (started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS speaking_turns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES speaking_sessions (id) ON DELETE CASCADE,

    -- assistant（AI 扮演的那个人） | user（学习者）
    role        TEXT    NOT NULL,
    content     TEXT    NOT NULL,

    -- 这句话是怎么来的：typed（键盘打的）| speech（浏览器语音识别猜的）
    -- assistant 的行固定填 'ai'。
    -- 这一列会写进报告的提示词里：识别那一路出现的怪词，
    -- 大概率是识别错了，不是用户说错了 —— 模型必须知道这个区别。
    source      TEXT    NOT NULL DEFAULT 'ai',

    seq         INTEGER NOT NULL,
    said_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_speaking_turns_session ON speaking_turns (session_id, seq);

-- 随机场景的去重历史，只留最近若干条
CREATE TABLE IF NOT EXISTS speaking_scenario_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- ------------------------------------------------------------
--  杂项设置（三线表导出倍率、上次打开的表、用户时区…）
--  这些原本散在 localStorage 里，换浏览器就丢，现在一并落库。
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ------------------------------------------------------------
--  AI 悬浮球（全站右下角那颗球）
--
--  待办与快捷方式原本可以塞进 settings 表里当一坨 JSON，但那样
--  「勾掉一条待办」要读出整坨、改完再整坨写回，并发下必然互相覆盖。
--  各给一张表，一行一条，改哪条动哪条。
--
--  对话历史**不落库**：悬浮球是随手问一句的地方，不是笔记本。
--  关掉面板就该忘掉，省得在库里堆一堆再也不会看第二眼的闲聊。
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assistant_todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_todos_order ON assistant_todos (done ASC, id DESC);

-- ------------------------------------------------------------
--  Markdown 记事本
--
--  标签直接以 JSON 数组存在笔记这一行上，**不建标签表**。
--  没有标签实体，也就没有改名、没有配色、没有标签的标签 ——
--  整个标签功能就是「一串可以拿来筛选的字符串」，到此为止。
--  真要按标签查，这个量级下前端把全部笔记拉下来自己过一遍就够了。
--
--  也没有 search / autosave / tag 三类接口：
--  搜索在前端做，本地草稿存 sessionStorage，存云端只在你按保存时发生。
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL DEFAULT '',
    -- JSON 数组，元素是小写去空白后的标签字符串
    tags       TEXT    NOT NULL DEFAULT '[]',
    content    TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);

-- 侧栏永远按「最近改过的在最上面」排，这个索引就是为它建的
CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes (updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS assistant_shortcuts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    url             TEXT    NOT NULL,
    -- 站内路径（/tools/…）默认当前标签页跳，外链默认新标签页
    open_in_new_tab INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL
);
