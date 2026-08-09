import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// 单页应用，样式表全站共用一份。
// 唯一的例外是知识可视化的 viz.css —— 它跟 30 个演示脚本一起放在 public/，
// 由 VizApp 在挂载时动态插 <link>、卸载时摘掉，免得它的 .card / .brand
// 跑到别的页面上（见 styles/global.css 顶部那条规矩）。
import '@fortawesome/fontawesome-free/css/all.min.css';
// 顺序有讲究：重置 → 设计变量 → 骨架 → 各工具。
// theme.css 定义的变量后面每一份都在用，它必须排在前面。
import './styles/global.css';
import './styles/theme.css';
import './styles/shell.css';
import './styles/search.css';
import './styles/home.css';
import './styles/courses.css';
import './styles/converters.css';
import './styles/table.css';
import './styles/flashcards.css';
import './styles/speaking.css';
import './styles/profile.css';
// 悬浮球排最后：它浮在所有页面之上，样式也该压在所有页面之后
import './styles/assistant.css';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
