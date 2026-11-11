/* 入口模块：定义侧边栏面板、卡片模块与可选的 Lovelace 卡片外壳。 */

import { createApi } from './api.js';
import { Vault } from './vault.js';
import { VaultView, STYLES } from './view.js';
import { PANEL_HEADER_STYLES, PANEL_HEADER_HTML } from './panel-header.js';

const PANEL_STYLES = `
:host { display: block; min-height: 100%; }
* { box-sizing: border-box; }
main {
  width: 100%; padding: 0;
  color: var(--primary-text-color, #212121);
}
`;

class PasswordVaultCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>${STYLES}</style><div id="root"></div>`;
  }

  connectedCallback() {
    this.boot();
  }

  disconnectedCallback() {
    if (this.view) this.view.destroy();
    this.view = null;
  }

  set hass(hass) {
    this.hassInstance = hass;
    this.boot();
  }

  get hass() {
    return this.hassInstance;
  }

  boot() {
    if (this.view || !this.hassInstance || !this.isConnected) return;
    // 通过代理读取最新的 hass，避免 HA 高频 set hass 造成请求使用过期连接
    const hassProxy = {
      callWS: (...args) => this.hassInstance.callWS(...args),
    };
    const api = createApi(hassProxy);
    this.view = new VaultView(
      this.shadowRoot.getElementById('root'), api, new Vault(api)
    );
    this.view.start();
  }

  lock() {
    if (this.view) this.view.lock();
  }
}

class PasswordPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    // 默认头部与通过插槽/setHeader 注入的头部都复用这个行为
    this.addEventListener('click', (event) => {
      const hit = event.composedPath().some(
        (node) => node instanceof Element && node.matches('[data-action="toggle-menu"]')
      );
      if (hit) {
        this.dispatchEvent(new CustomEvent('hass-toggle-menu', {
          bubbles: true, composed: true,
        }));
      }
    });
  }

  connectedCallback() {
    this.sync();
  }

  disconnectedCallback() {
    if (this.card) this.card.lock();
  }

  set hass(hass) {
    this.hassInstance = hass;
    this.sync();
  }

  get hass() {
    return this.hassInstance;
  }

  set narrow(value) {
    this.narrowValue = value;
  }

  set route(value) {
    this.routeValue = value;
  }

  set panel(value) {
    this.panelValue = value;
  }

  sync() {
    if (!this.shadowRoot.innerHTML) {
      this.shadowRoot.innerHTML = `<style>${PANEL_STYLES}${PANEL_HEADER_STYLES}</style>
        <slot name="header">${PANEL_HEADER_HTML}</slot>
        <main><password-vault-card></password-vault-card></main>`;
      this.card = this.shadowRoot.querySelector('password-vault-card');
    }
    if (this.card && this.hassInstance) this.card.hass = this.hassInstance;
  }

  /** 运行时替换头部：传 HTML 字符串或 Node；传 null / 空串恢复默认头部。 */
  setHeader(content) {
    this.sync();
    this.querySelectorAll('[slot="header"]').forEach((node) => node.remove());
    if (content == null || content === '') {
      // 注入空占位以屏蔽默认头部（slot fallback），让卡片自身头部成为唯一头部
      const placeholder = document.createElement('div');
      placeholder.slot = 'header';
      this.appendChild(placeholder);
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.slot = 'header';
    if (content instanceof Node) wrapper.appendChild(content);
    else wrapper.innerHTML = String(content);
    this.appendChild(wrapper);
  }

  get header() {
    return this.querySelector('[slot="header"]');
  }
}

customElements.define('password-vault-card', PasswordVaultCard);
customElements.define('password-panel', PasswordPanel);
