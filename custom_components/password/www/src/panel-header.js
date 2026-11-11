/* 面板头部：完全自定义入口。
 *
 * 侧边栏面板本身是我们自己的 Custom Element，顶部头部不做任何配置项，
 * 直接改本文件的两个导出即可换成任意 HTML / CSS，无需改动 main.js。
 *
 * - PANEL_HEADER_STYLES：随 shadow DOM 一起注入，作用于下面的默认头部
 * - PANEL_HEADER_HTML：作为 <slot name="header"> 的默认内容
 *
 * 头部里带 data-action="toggle-menu" 的元素点击后会打开 HA 侧边栏，
 * 自定义头部保留这个属性即可复用该行为。
 */

export const PANEL_HEADER_STYLES = `
.bar {
  display: flex; align-items: center; gap: 12px;
  height: 56px; padding: 0 20px;
  color: var(--app-header-text-color, var(--primary-text-color, #fff));
  background: var(--app-header-background-color, var(--primary-color, #03a9f4));
}
.bar-title { font-size: 18px; font-weight: 600; }
.menu {
  display: none; border: none; background: transparent; cursor: pointer;
  color: inherit; font-size: 20px; padding: 4px 8px;
}
@media (max-width: 870px) { .menu { display: block; } }
`;

export const PANEL_HEADER_HTML = `
<header class="bar">
  <button class="menu" data-action="toggle-menu" aria-label="打开侧边栏">☰</button>
  <span class="bar-title">我的密码</span>
</header>`;
