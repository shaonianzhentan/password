/* 面板头部：完全自定义入口。
 *
 * 默认不渲染任何外层头部 —— 卡片自带的功能顶栏（view.js 的 .topbar，
 * 含侧边栏图标、分类栏开关、搜索、新增、菜单）就是页面头部。
 * 需要额外头部时二选一：
 *
 * 1) 把自己的 HTML / CSS 写进下面两个导出（随 shadow DOM 注入）；
 * 2) 运行时用 <div slot="header"> 或 panel.setHeader(...) 注入（light DOM）。
 *
 * 头部里带 data-action="toggle-menu" 的元素点击后会打开 HA 侧边栏，
 * 自定义头部保留这个属性即可复用该行为。
 */

// 仅约束运行时注入的头部，避免被 :host 的 flex 布局压缩
export const PANEL_HEADER_STYLES = `
::slotted([slot="header"]) { flex: none; }
`;

// 默认无外层头部；需要「打开页面就显示」的自定义头部时，把 HTML 填在这里
export const PANEL_HEADER_HTML = '';
