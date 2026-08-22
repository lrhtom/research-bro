// ============================================================
//  算法题库（OJ）· 前后端共用的类型与常量
//
//  这一块是从独立的 ai_oj 桌面应用（Electron + Next.js）搬进来的。
//  搬迁时三处结构性改动，看代码前先知道：
//
//    1. **没有 IPC 了**。原来主进程用 ipcMain.handle + webContents.send
//       双向通信，这里全部改成 HTTP：请求走 /api/oj/*，
//       生成与判题的进度走一条 SSE（GET /api/oj/events）。
//       所以原来的 IPC 通道常量表整个删掉了。
//    2. **AI 配置不再自带一套**。原应用有自己的 provider / baseUrl /
//       apiKey / model 四个设置项；工具箱已经有全站共用的「大模型档案」
//       （llm_models 表 + src/server/llm.ts），OJ 直接用那一套，
//       这里只剩两个真正属于 OJ 的设置：Python 路径与生成并发数。
//    3. **类型名统一加 Oj 前缀**。src/client/lib/api.ts 同时 import
//       本文件和 shared/types.ts，那边已经有 Plan / Card 这些名字，
//       不加前缀读起来会分不清哪个 Plan 是记忆卡的、哪个是测试计划的。
//
//  本文件只放类型与常量，不放任何 IO 与状态。
// ============================================================

// ---------------- 基础枚举 ----------------

/**
 * 题目类型。目前只有 algo（算法题）。
 *
 * 这一列留着不是摆设：原应用二期做了「Web 前端题」（三栏 HTML/CSS/JS
 * 作答 + Playwright 断言判分），那一期暂时没搬过来。留着这一列，
 * 将来补二期就是加表加路由，不用动已有数据。
 */
export type OjProblemType = 'algo' | 'web';

export type OjDifficulty = '简单' | '中等' | '困难';
export type OjDifficultyChoice = OjDifficulty | '自动';
export type OjProblemStatus = 'generating' | 'ready' | 'partial' | 'failed';
export type OjTestCaseKind = 'sample' | 'boundary' | 'small' | 'large' | 'special';
export type OjVerdict = 'AC' | 'WA' | 'TLE' | 'RE' | 'CE' | 'SE' | 'JUDGING' | 'PENDING';
export type OjLanguageId = 'python' | 'cpp' | 'javascript' | 'typescript' | 'go';

// ---------------- 数据模型 ----------------

export interface OjProblem {
    id: number;
    type: OjProblemType;
    title: string;
    difficulty: OjDifficulty;
    tags: string[];
    /** 题面 Markdown。**不含样例** —— 样例由前端从 sample 测试点渲染 */
    statementMd: string;
    /** AI 给的标准解，生成期望输出用的就是它 */
    solutionCode: string;
    solutionLang: string;
    timeLimitMs: number;
    memoryLimitMb: number;
    isFavorite: boolean;
    status: OjProblemStatus;
    /** 用户当初填的提示词 */
    genPrompt: string;
    /** 生成过程中的警告（某个计划失败、缺少 large 类数据…） */
    genWarnings: string[];
    createdAt: string;
    updatedAt: string;
}

export interface OjProblemListItem {
    id: number;
    type: OjProblemType;
    title: string;
    difficulty: OjDifficulty;
    tags: string[];
    isFavorite: boolean;
    status: OjProblemStatus;
    testCaseCount: number;
    /** 有没有 AC 过 */
    solved: boolean;
    submissionCount: number;
    createdAt: string;
}

export interface OjProblemQuery {
    search?: string;
    tag?: string;
    favoriteOnly?: boolean;
    /** 从 1 开始 */
    page?: number;
    pageSize?: number;
}

export interface OjTestCase {
    id: number;
    problemId: number;
    /** 展示顺序，从 1 开始 */
    idx: number;
    kind: OjTestCaseKind;
    planName: string;
    planDesc: string;
    isSample: boolean;
    input: string;
    output: string;
    /** 生成这个点的 gen.py */
    generatorCode: string;
    inputBytes: number;
    outputBytes: number;
}

/**
 * 测试点元信息 —— 不带完整输入输出。
 *
 * 单个大数据点可以有好几 MB，一道题几百个点全量下发会把详情页拖死。
 * 列表只要预览，点开某一个才去要完整的那一份。
 */
export interface OjTestCaseMeta {
    id: number;
    problemId: number;
    idx: number;
    kind: OjTestCaseKind;
    planName: string;
    planDesc: string;
    isSample: boolean;
    inputBytes: number;
    outputBytes: number;
    inputPreview: string;
    outputPreview: string;
}

export interface OjCaseResult {
    caseId: number;
    idx: number;
    kind: OjTestCaseKind;
    verdict: OjVerdict;
    timeMs: number;
    /** WA 时是差异摘要，RE 时是 stderr 尾部 */
    message?: string;
}

export interface OjSubmission {
    id: number;
    problemId: number;
    /** 列表联查带出来的题目名 */
    problemTitle?: string;
    language: OjLanguageId;
    code: string;
    verdict: OjVerdict;
    /** 0~100，通过测试点的比例 */
    score: number;
    /** 所有测试点里最大的那个耗时 */
    timeMs: number | null;
    caseResults: OjCaseResult[];
    createdAt: string;
}

export interface OjSubmissionQuery {
    problemId?: number;
    page?: number;
    pageSize?: number;
}

// ---------------- 设置 ----------------

/**
 * 只剩真正属于 OJ 的两项。
 *
 * 接口地址 / API Key / 模型名一概不在这儿 —— 那是全站共用的
 * 「大模型档案」，在任意一个带模型面板的页面上改，OJ 立刻跟着变。
 */
export interface OjSettings {
    /** 默认 'python'；Windows 上也可以填 py 或绝对路径 */
    pythonPath: string;
    /** 生成测试点的并发数，1~6 */
    genConcurrency: number;
}

export const OJ_DEFAULT_SETTINGS: OjSettings = {
    pythonPath: 'python',
    genConcurrency: 3,
};

// ---------------- 生成管线 ----------------

export interface OjGenerateParams {
    prompt: string;
    tags: string[];
    difficulty: OjDifficultyChoice;
}

/** 第一步 AI 返回的测试数据计划（<plans> JSON 数组的元素） */
export interface OjTestPlan {
    name: string;
    kind: OjTestCaseKind;
    /** 给第二步 AI 看的生成要求，要具体到能独立写出生成器 */
    description: string;
    isSample: boolean;
    /** 这个计划要出几个测试点：换随机种子反复跑同一个生成器，重复的会去重 */
    count?: number;
}

export type OjGenPhase =
    | 'requesting_problem'
    | 'parsing_problem'
    | 'generating_cases'
    | 'saving'
    | 'done'
    | 'failed';

export type OjGenPlanStatus =
    | 'pending'
    | 'requesting'          // 正在问 AI 要 gen.py
    | 'running_generator'   // 正在跑 gen.py 造输入
    | 'running_solution'    // 正在跑标准解求输出
    | 'retrying'
    | 'ok'
    | 'failed';

export interface OjGenPlanState {
    planIndex: number;
    planName: string;
    kind: OjTestCaseKind;
    status: OjGenPlanStatus;
    message?: string;
}

/** 生成进度事件。原来走 IPC 广播，现在走 SSE。 */
export type OjGenProgressEvent =
    | { jobId: string; type: 'phase'; phase: OjGenPhase; message: string; problemId?: number }
    | { jobId: string; type: 'plan'; plan: OjGenPlanState }
    | { jobId: string; type: 'log'; message: string };

/** 生成任务快照：页面重新挂载后拉一次，恢复现场 */
export interface OjGenJobSnapshot {
    jobId: string;
    params: OjGenerateParams;
    phase: OjGenPhase;
    phaseMessage: string;
    problemId?: number;
    problemTitle?: string;
    plans: OjGenPlanState[];
    logs: string[];
    startedAt: string;
}

// ---------------- 判题 ----------------

export interface OjJudgeSubmitParams {
    problemId: number;
    language: OjLanguageId;
    code: string;
}

export type OjJudgeProgressEvent =
    | { submissionId: number; type: 'start'; total: number }
    | { submissionId: number; type: 'case'; caseIndex: number; total: number; result: OjCaseResult }
    | { submissionId: number; type: 'done'; verdict: OjVerdict; score: number; timeMs: number | null };

/** SSE 那条流上跑的两类事件，各带一个 kind 好在前端分流 */
export type OjEvent =
    | { kind: 'gen'; event: OjGenProgressEvent }
    | { kind: 'judge'; event: OjJudgeProgressEvent };

// ---------------- Python 执行器 ----------------

export interface OjRunPythonOptions {
    pythonPath: string;
    /** 会被写进临时目录的 main.py */
    code: string;
    stdin?: string;
    /** 传给脚本的命令行参数 —— 生成器用它接随机种子 */
    args?: string[];
    timeoutMs: number;
    maxOutputBytes?: number;
}

export type OjRunStatus = 'ok' | 'timeout' | 'runtime_error' | 'output_limit' | 'spawn_error';

export interface OjRunResult {
    status: OjRunStatus;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timeMs: number;
}

// ---------------- 语言 ----------------

export interface OjLanguageInfo {
    id: OjLanguageId;
    label: string;
    /** 目前只有 python 是 true */
    available: boolean;
    /** 编辑器初始模板 */
    template: string;
}

export const OJ_LANGUAGES: OjLanguageInfo[] = [
    {
        id: 'python',
        label: 'Python 3',
        available: true,
        template: 'import sys\ninput = sys.stdin.readline\n\n\ndef main():\n    pass\n\n\nmain()\n',
    },
    { id: 'cpp', label: 'C++（即将支持）', available: false, template: '' },
    { id: 'javascript', label: 'JavaScript（即将支持）', available: false, template: '' },
    { id: 'typescript', label: 'TypeScript（即将支持）', available: false, template: '' },
    { id: 'go', label: 'Go（即将支持）', available: false, template: '' },
];

// ---------------- 文案 ----------------

export const OJ_VERDICT_LABELS: Record<OjVerdict, string> = {
    AC: '通过',
    WA: '答案错误',
    TLE: '超出时限',
    RE: '运行错误',
    CE: '编译错误',
    SE: '系统错误',
    JUDGING: '评测中',
    PENDING: '排队中',
};

export const OJ_KIND_LABELS: Record<OjTestCaseKind, string> = {
    sample: '样例',
    boundary: '边界',
    small: '小数据',
    large: '大数据',
    special: '特殊构造',
};

export const OJ_GEN_PHASE_LABELS: Record<OjGenPhase, string> = {
    requesting_problem: '正在请求 AI 生成题面、标准解与测试计划…',
    parsing_problem: '正在解析 AI 返回内容…',
    generating_cases: '正在并发生成测试点…',
    saving: '正在保存题目数据…',
    done: '生成完成',
    failed: '生成失败',
};

export const OJ_DIFFICULTIES: readonly OjDifficulty[] = ['简单', '中等', '困难'];

/** 生成页的标签多选。分组只影响排布，存进库的就是这些字符串。 */
export const OJ_PRESET_TAGS: string[] = [
    '数组', '字符串', '哈希表', '双指针', '滑动窗口', '前缀和', '差分', '排序',
    '二分查找', '贪心', '递归', '分治', '回溯', '动态规划', '背包', '区间DP',
    '树形DP', '状态压缩', '栈', '单调栈', '队列', '单调队列', '堆(优先队列)',
    '链表', '树', '二叉搜索树', '字典树', '并查集', '图', 'DFS', 'BFS',
    '拓扑排序', '最短路', '最小生成树', '线段树', '树状数组', '位运算',
    '数学', '数论', '组合数学', '概率', '博弈论', '几何', '模拟', '构造', 'KMP',
];

// ---------------- 生成/判题的各种限额 ----------------

/** 单个测试点的输入体积上限。超了直接判这个点生成失败，免得把库撑爆。 */
export const OJ_MAX_TESTCASE_INPUT_BYTES = 8 * 1024 * 1024;
/** Python 子进程的输出上限 */
export const OJ_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** 跑 gen.py 的时限 */
export const OJ_GEN_GENERATOR_TIMEOUT_MS = 30_000;
/** 生成期跑标准解的时限：题目时限的 10 倍，且不低于 15 秒 */
export const OJ_GEN_SOLUTION_TIMEOUT_MIN_MS = 15_000;
export const OJ_GEN_SOLUTION_TIMEOUT_MULTIPLIER = 10;
/** 单个测试计划失败后最多再试几次 */
export const OJ_PLAN_MAX_RETRIES = 2;

/**
 * 单个计划最多能产出多少测试点，按类型分档。
 *
 * 为什么按类型分：small（小随机数据）越多越能覆盖边角情形，放到上百都行；
 * large（大数据）单点体积大、只为卡复杂度，放大反而拖慢生成与判题还吃内存。
 */
export const OJ_MAX_CASES_PER_KIND: Record<OjTestCaseKind, number> = {
    sample: 2,
    boundary: 20,
    small: 100,
    large: 5,
    special: 15,
};

/** 计划没给 count 时按类型垫的默认值 */
export const OJ_DEFAULT_COUNT_BY_KIND: Record<OjTestCaseKind, number> = {
    sample: 1,
    boundary: 2,
    small: 15,
    large: 3,
    special: 4,
};

/** 单题测试点总量的硬上限：生成和判题都是逐点跑，不封顶会让耗时失控 */
export const OJ_MAX_TOTAL_CASES = 300;

/** 同一计划连续产出重复输入达到这个次数，就认定生成器没用上随机种子，提前收工 */
export const OJ_DEDUP_STOP_AFTER = 2;
