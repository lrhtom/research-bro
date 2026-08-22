// 代码编辑器的外壳。
//
// CodeMirror 连语法包打出来两百多 KB，而站里只有 OJ 这一块用得上 ——
// 首页、记忆卡、口语练习都不该为它买单。所以这里用 React.lazy 包一层，
// 真正进到题目页才去加载。跟 mermaid、KaTeX 一个待遇。
//
// 加载中给一个**等高**的占位框：不这么做的话，编辑器一到位页面会往下一跳，
// 而人这时候多半正要点「提交评测」，按钮位置一变就点空了。

import { Suspense, lazy } from 'react';
import type { OjLanguageId } from '../../../shared/oj';

const Inner = lazy(() => import('./CodeEditorInner'));

interface Props {
    value: string;
    onChange?: (v: string) => void;
    language: OjLanguageId;
    height?: string;
    readOnly?: boolean;
}

export default function CodeEditor({ value, onChange, language, height = '420px', readOnly }: Props) {
    return (
        <div className="oj-editor" style={{ minHeight: height }}>
            <Suspense
                fallback={
                    <div className="oj-editor-loading" style={{ height }}>
                        <i className="fas fa-spinner fa-spin" /> 正在加载编辑器…
                    </div>
                }
            >
                <Inner
                    value={value}
                    onChange={onChange ?? undefined}
                    language={language}
                    height={height}
                    readOnly={readOnly ?? false}
                />
            </Suspense>
        </div>
    );
}
