// 今日进度条。
//
// 两个分母都遵一条规矩：**分母必须是今天真够得着的数**。
//   · 进度条 —— 「今日已完成 + 队列剩余」，不是每日新卡上限
//   · 新卡那一行 —— progress.newTarget（= min(上限, 已引入 + 库里还剩的新卡)），
//     不是 dailyNewLimit。上限 100 而牌组里只剩 1 张新卡时，
//     「0/100」是个这辈子都到不了的目标，看着像没学。

import type { Progress } from '../../../shared/types';

export default function ProgressBar({ progress }: { progress: Progress }) {
    const { finished, remaining, total } = progress;
    const pct = total > 0 ? (finished / total) * 100 : 0;

    return (
        <div className="fc-progress">
            <div className="fc-progress-head">
                <span className="fc-progress-count">
                    <b>{finished}</b> / {total}
                </span>
                <span className="fc-progress-note">
                    还剩 {remaining} 张
                    {/* 目标是 0 张（上限设成 0，或者新卡早就学光了）时整段不显示 ——
                        「今日新卡 0/0」除了占地方没有任何信息 */}
                    {progress.newTarget > 0 && (
                        <> · 今日新卡 {progress.newIntroduced}/{progress.newTarget}</>
                    )}
                </span>
            </div>
            <div className="fc-bar">
                <div className="fc-bar-fill" style={{ width: pct.toFixed(2) + '%' }} />
            </div>
        </div>
    );
}
