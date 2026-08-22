// 真正的 CodeMirror。只被 CodeEditor.tsx 用 React.lazy 拉进来，
// 从不直接 import —— 理由见那个文件顶上的注释。

import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { EditorView } from '@codemirror/view';
import type { OjLanguageId } from '../../../shared/oj';

interface Props {
    value: string;
    onChange?: (v: string) => void;
    language: OjLanguageId;
    height: string;
    readOnly?: boolean;
}

/**
 * 主题跟着工具箱走：暖白纸、发丝线、青绿光标。
 *
 * CodeMirror 自带的 light 主题是冷灰的，摆在这个站里像是从别处贴过来的一块。
 * 这里只覆写几个真正影响观感的地方，其余交给默认样式。
 */
const toolboxTheme = EditorView.theme({
    '&': {
        fontSize: '13px',
        backgroundColor: 'var(--surface)',
        color: 'var(--ink)',
    },
    '.cm-content': {
        fontFamily: 'var(--font-mono)',
        // 代码行给足行高，不然中文注释和英文代码混排时会挤成一坨
        lineHeight: '1.65',
        caretColor: 'var(--accent)',
    },
    '.cm-gutters': {
        backgroundColor: 'var(--surface-2)',
        color: 'var(--ink-4)',
        border: 'none',
        borderRight: '1px solid var(--hairline)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--accent-tint)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--accent-tint)', color: 'var(--ink-2)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--accent-tint-2)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
});

export default function CodeEditorInner({ value, onChange, language, height, readOnly }: Props) {
    return (
        <CodeMirror
            value={value}
            height={height}
            readOnly={readOnly ?? false}
            // 目前只有 Python 能跑，所以也只装了 Python 的语法包。
            // 将来开别的语言，在这儿按 language 分流即可。
            extensions={language === 'python' ? [python(), toolboxTheme] : [toolboxTheme]}
            onChange={onChange ?? undefined}
            basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: !readOnly,
                highlightActiveLineGutter: !readOnly,
                // 竞赛代码里括号成堆，自动配对省事；但只读视图里不需要
                closeBrackets: !readOnly,
                autocompletion: false,
                // 搜索面板会抢 Ctrl+F，只读看代码时留着，编辑时也无妨
                searchKeymap: true,
            }}
        />
    );
}
