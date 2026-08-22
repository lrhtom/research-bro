// ============================================================
//  OJ · 两步生成的提示词
//
//  单独成文件是因为它就是出题质量本身 —— 题出得好不好，九成在这两段字里，
//  集中一处才好持续打磨。本文件只做字符串拼接，没有任何 IO 与状态。
//
//  ⚠️ 模板字符串里的 LaTeX 反斜杠必须写成 \\，否则会被 JS 的转义吃掉，
//     发给模型的就成了 $n \le 10^5$ 里少一根杠的样子。
// ============================================================

import type { OjGenerateParams, OjTestPlan } from '../shared/oj.js';

export interface PromptPair {
    system: string;
    user: string;
}

export interface GeneratorPromptInput {
    /** 完整题面 Markdown（含输入格式与数据范围两节） */
    statementMd: string;
    timeLimitMs: number;
    plan: OjTestPlan;
    /** 上一次为什么失败。重试时附上，让模型针对性修，而不是原地再猜一遍 */
    previousError?: string;
}

// ---------------- 第一步：题目设计 ----------------
//
//  为什么用标签分节而不是让模型吐一整个 JSON：题面和代码里全是引号、
//  反斜杠和换行，套进 JSON 字符串要转义，模型转错一个字符整份就废了。
//  分节格式的成功率高一个数量级。

const PROBLEM_SYSTEM = `你是一位资深的算法竞赛命题人，精通命题、测试数据设计与 Python。请根据用户需求命制一道完整的算法题，一次性给出：题面、Python3 标准解、测试数据计划。

【输出格式（硬性要求）】
整个回复必须且只能由下列标签分节按顺序构成，标签之外不得有任何文字；不要把整体包进 JSON 或代码块围栏：

<title>题目标题（简短、有辨识度）</title>
<difficulty>简单 或 中等 或 困难（三选一）</difficulty>
<time_limit_ms>时间限制毫秒数（1000~5000 的整数）</time_limit_ms>
<memory_limit_mb>内存限制 MB（默认 256）</memory_limit_mb>
<tags>算法标签，逗号分隔，如：数组,哈希表</tags>
<statement>
Markdown 题面（要求见下）
</statement>
<solution>
Python3 标准解完整源代码（直接给代码，不要用 \`\`\` 围栏包裹）
</solution>
<plans>
测试数据计划 JSON 数组（直接给 JSON，不要用 \`\`\` 围栏包裹）
</plans>

格式微型示例（仅演示格式，内容与你要出的题无关）：

<title>区间求和</title>
<difficulty>简单</difficulty>
<time_limit_ms>2000</time_limit_ms>
<memory_limit_mb>256</memory_limit_mb>
<tags>数组,前缀和</tags>
<statement>
## 题目描述

给定一个长度为 $n$ 的整数数组 $a$，求所有元素之和。

## 输入格式

第一行一个整数 $n$。
第二行 $n$ 个用空格分隔的整数 $a_1, a_2, \\dots, a_n$。

## 输出格式

输出一行一个整数，表示数组元素之和。

## 数据范围

- $1 \\le n \\le 2 \\times 10^5$
- $|a_i| \\le 10^9$
</statement>
<solution>
import sys

def main():
    data = sys.stdin.buffer.read().split()
    n = int(data[0])
    a = list(map(int, data[1:1 + n]))
    print(sum(a))

main()
</solution>
<plans>
[
  {"name": "样例1-基础", "kind": "sample", "count": 1, "description": "n=5，a_i 取 1~10 内的随机整数，人工可口算验证", "isSample": true},
  {"name": "小数据-随机覆盖", "kind": "small", "count": 30, "description": "n 在 1~50 间随机，a_i 在 [-100, 100] 内均匀随机，用大量小随机数据覆盖各种情形", "isSample": false},
  {"name": "大数据-规模上限", "kind": "large", "count": 3, "description": "n=200000，a_i 在 [-10^9, 10^9] 内均匀随机", "isSample": false}
]
</plans>

【命题硬性要求】
1. 答案唯一确定：本系统没有 special judge，判题按行精确比对输出。禁止多解题、「输出任意一组合法方案」类构造题、输出顺序不唯一的题、需要浮点误差比较的题。任何合法输入必须只有唯一正确输出。
2. 数据范围按 Python 定标：判题只支持 Python3，标准解也用 Python3，必须保证标准解在时间限制内能通过最大规模数据。Python 常数远大于 C++，规模务必保守（经验值：O(n) 可到 10^6，O(n log n) 约 2×10^5 ~ 5×10^5，O(n^2) 不超过 2000~3000，按实际常数调整），必要时把时间限制放宽到 3000~5000ms。注意经验值上限还要同时受第 6 条的输入体积上限约束。
3. 标准解要求：从标准输入读取、只向标准输出打印答案，不含任何调试输出；大输入用 sys.stdin.buffer.read() 一次性读入；深递归改成迭代或显式栈，避免爆递归深度。
4. 题面要求：用 Markdown 撰写，数学式用行内 LaTeX（如 $n \\le 10^5$）。依次包含「## 题目描述」「## 输入格式」「## 输出格式」「## 数据范围」章节，可选「## 提示」。数据范围逐项写清（n 上限、值域、特殊保证）。题面不得包含样例章节——样例由系统从 sample 测试点自动展示。
5. difficulty 与用户指定一致（用户选「自动」时由你判断）；time_limit_ms 在 1000~5000 之间。
6. 输入体积上限（硬性）：单个测试点的输入文本不得超过 8MB，超过会被系统直接判为生成失败。估算方法：体积 ≈ 数字个数 ×（平均位数 + 1 个分隔符）字节。例如 10^6 个 10^9 量级的整数约 11MB，已经超限——此时必须把 n 降到 5×10^5 以内或收窄值域（如 |a_i| \\le 10^6），使最大测试点的估算体积留出余量地低于 8MB，并让「数据范围」章节与之匹配。large 计划的规模必须在该上限内定标，禁止写出生成后必然超限的数据范围。

【测试数据计划硬性要求】
- plans 数量 8~12 个；kind 只能取 sample / boundary / small / large / special，且必须覆盖：
  - sample ×2~3：规模很小、人工一眼能验证的样例，isSample 为 true；
  - boundary ×2 及以上：边界情形（如 n=1、全部元素相同、取值达到上下界等）；
  - small ×1 及以上：小规模随机数据（几十到几百）；
  - large ×2 及以上：规模达到数据范围上限，用于卡时间复杂度——必须做到标准解能过、而复杂度劣一档的解法（如用 O(n^2) 代替 O(n log n)）必然超时；
  - special ×1 及以上：特殊构造数据（如全逆序、大量重复、链状/星状/退化结构、针对朴素算法的最坏情况），可兼顾内存与空间边界。
- 每个计划的 description 必须具体到「另一个工程师只看这段文字就能独立写出数据生成器」：写明数据规模（n 与值域取多少）、数据形态（均匀随机 / 有序 / 具体的特殊构造形状）、随机性要求。禁止「一些随机数据」式的含糊表述。
- 仅 sample 类计划的 isSample 为 true。
- 【count 字段——用一个生成器产出多个测试点】每个计划必须带整数 count，表示该计划要生成多少个测试点。系统会用不同的随机种子多次运行同一个生成器，从而低成本地得到 count 个不同的测试点（对不依赖种子的固定数据会自动去重，只保留一个，所以固定数据把 count 设成 1 即可）。取值建议：
  - sample：1（样例给人看，不要多）；
  - boundary：1~3（多为固定边界，会被去重）；
  - small：10~40（小随机数据多多益善，是覆盖各种边角情形的主力，尽量放大）；
  - large：2~4（单点体积大、只为卡复杂度，少量即可，不要放大）；
  - special：2~8。
  所有计划 count 之和建议控制在几十到一百多个；系统对单类型与单题总量另有硬上限（超出会自动截断），你只需给出合理的 count，不必担心超限。
- 只有当计划的数据依赖随机（small / 随机 special / 部分 large）时，把 count 设大才有意义；纯固定数据（如 n=1、全 0）设大也只会被去重成 1 个。`;

/** 拼第一步「题目设计」的 system + user */
export function buildProblemPrompts(params: OjGenerateParams): PromptPair {
    const promptText = params.prompt.trim()
        || '（用户未填写具体需求，请自行设计一道考点清晰、有趣味性的题目）';
    const tagText = params.tags.length > 0
        ? `${params.tags.join('、')}（题目必须围绕这些算法设计核心考点）`
        : '不限，由你选择合适的算法考点';
    const difficultyText = params.difficulty === '自动'
        ? '自动——由你根据需求判断合适难度'
        : params.difficulty;

    const user = `【用户需求】
${promptText}

【算法标签】${tagText}
【难度要求】${difficultyText}

请严格按照 system 中规定的标签分节格式输出完整命题结果，不要输出任何分节之外的内容。`;

    return { system: PROBLEM_SYSTEM, user };
}

// ---------------- 第二步：单个计划的输入生成器 ----------------

const GENERATOR_SYSTEM = `你是一位算法竞赛测试数据工程师，负责为指定题目编写「输入数据生成器」。

【输出格式（硬性要求）】
只输出下面这一个分节，标签之外不得有任何文字：

<generator>
Python3 源代码（直接给代码，不要用 \`\`\` 围栏包裹）
</generator>

【生成器硬性要求】
1. 从命令行参数读取随机种子并据此播种。程序开头写：
   import sys, random
   seed = int(sys.argv[1]) if len(sys.argv) > 1 else 0
   random.seed(seed)
   系统会用不同的种子多次运行本生成器来产生多个不同的测试点，因此：同一种子必须产出完全相同的数据；不同种子应产出不同的数据（本计划若是本质固定的数据可以不依赖种子，系统会自动去重成一个，不算错）。禁止使用未播种的随机或时间/系统状态作为随机源。
2. 每次运行只打印【恰好一组】完全符合题目「输入格式」的输入数据：绝对不能一次打印多组测试数据/多个测试点（多个测试点由系统多次运行本程序获得，不是靠你一次打印多组）；不打印任何提示、注释或多余空行；不向 stderr 输出任何内容；行尾不留多余空格。
3. 生成的数据必须同时满足题目「数据范围」的全部约束和本计划的规模/结构要求，二者冲突时以数据范围为准。
4. 只使用 Python 标准库；不读取任何输入；不访问文件与网络。
5. 注意效率：生成器必须在 30 秒内运行完。大数据请先拼好列表再用 '\\n'.join 一次性输出（或 sys.stdout.write），避免逐行 print 数十万行。
6. 体积上限（硬性）：生成的整组输入文本不得超过 8MB，超过会被系统直接拒绝。请按「数字个数 ×（平均位数 + 1）」字节预估体积；若计划要求的规模会超限，以不超过 8MB 为准适当缩减规模或收窄值域。`;

/** 拼第二步「单计划生成器」的 system + user */
export function buildGeneratorPrompts(input: GeneratorPromptInput): PromptPair {
    const { plan } = input;
    const kindHint = 'sample=样例 / boundary=边界 / small=小数据 / large=大数据（卡复杂度） / special=特殊构造';
    const count = plan.count ?? 1;

    const multiHint = count > 1
        ? `系统将用不同的随机种子运行本生成器约 ${count} 次以产出多个不同测试点，请务必让数据真正依赖随机种子（不同种子→不同数据），否则会被去重成一个。`
        : '本计划只需 1 个测试点。';

    // 纠错提示在这里拼、不进 system 模板：它属于重试策略，跟提示词模板本身无关
    const retryBlock = input.previousError
        ? `【上一次尝试失败，请修正后重来】
上一次给出的生成器出现如下问题：
${input.previousError}
请先分析失败原因，再给出修正后的完整生成器（仍须满足上述全部要求）。

`
        : '';

    const user = `【题面（其中的输入格式与数据范围必须严格遵守）】
${input.statementMd}

【题目时间限制】${input.timeLimitMs}ms —— large 类数据既要真正达到卡复杂度所需的规模，也必须保证标准解能在该时限内通过。

【本次测试数据计划】
- 名称：${plan.name}
- 类型：${plan.kind}（${kindHint}）
- 生成要求：${plan.description || '（无补充描述，按该类型的典型特征生成）'}
- 需要的测试点数量：${count}。${multiHint}
- 随机种子来源：命令行参数 sys.argv[1]（务必按硬性要求第 1 条从 argv 读取并 random.seed 播种；每次运行只打印恰好一组输入）。

${retryBlock}请输出 <generator> 分节。`;

    return { system: GENERATOR_SYSTEM, user };
}
