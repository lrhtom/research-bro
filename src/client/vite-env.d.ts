/// <reference types="vite/client" />

// 这一行把 Vite 自带的环境类型引进来，主要是两样：
//   · `*.css` / `*.svg` 这类非 JS 资源的模块声明 —— 没有它，
//     `import 'katex/dist/katex.min.css'` 会被 tsc 报成「找不到模块」
//   · import.meta.env 的类型
//
// 以前没有这个文件也不报错，是因为站里的样式表全是**相对路径**导入的
// （'./styles/global.css'），TS 对相对路径的未知扩展名网开一面；
// 而从 node_modules 里按包名导入一份 css 就走不了那条路了。
