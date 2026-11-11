/* 卡片 UI：渲染、事件委托、弹窗与自动锁定。所有用户输入均转义后写入 DOM。 */

import { cryptoAvailable } from './crypto.js';
import {
  webAuthnState, platformAuthenticatorAvailable, localWraps,
  registerCredential, authenticate, removeLocalWrap,
} from './unlock.js';
import { normalizeItems } from './vault.js';

const IDLE_MS = 5 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export const STYLES = `
:host { display: block; }
* { box-sizing: border-box; }
.card {
  width: 100%;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  color: var(--primary-text-color, #212121);
  border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.10));
}
.head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.10)); flex-wrap: wrap; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0; border: none; background: transparent; color: var(--primary-text-color, #212121); border-radius: 10px; cursor: pointer; }
.icon-btn:hover { background: var(--secondary-background-color, rgba(0,0,0,.06)); }
.icon-btn svg { width: 22px; height: 22px; }
.title { font-size: 18px; font-weight: 600; line-height: 1.3; }
.subtitle { font-size: 12px; color: var(--secondary-text-color, #777); margin-top: 2px; }
.head-main { flex: 0 1 auto; min-width: 0; }
.search-bar { display: flex; align-items: center; gap: 8px; flex: 1 1 220px; min-width: 160px; }
.search-bar input { flex: 1; width: 100%; min-width: 0; }
.search-bar select { width: 150px; flex: 0 0 150px; }
.head-actions, .actions, .foot, .dialog-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.badge { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--secondary-background-color, rgba(0,0,0,.06)); color: var(--secondary-text-color, #666); }
.body { padding: 20px; }
.hint { font-size: 13px; line-height: 1.6; color: var(--secondary-text-color, #777); margin: 0 0 16px; }
.field { display: block; margin: 0 0 14px; }
.field > span { display: block; font-size: 13px; margin-bottom: 6px; color: var(--secondary-text-color, #666); }
input, textarea, select {
  width: 100%; padding: 10px 12px; font: inherit; font-size: 14px;
  color: var(--primary-text-color, #212121);
  background: var(--input-fill-color, transparent);
  border: 1px solid var(--input-idle-line-color, var(--divider-color, rgba(0,0,0,.25)));
  border-radius: 10px; outline: none;
}
input:focus, textarea:focus, select:focus { border-color: var(--primary-color, #03a9f4); }
textarea { resize: vertical; min-height: 68px; }
button {
  font: inherit; font-size: 14px; padding: 9px 16px; border-radius: 10px; cursor: pointer;
  color: var(--primary-text-color, #212121);
  background: transparent;
  border: 1px solid var(--divider-color, rgba(0,0,0,.22));
}
button:hover { background: var(--secondary-background-color, rgba(0,0,0,.05)); }
button.primary { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); border-color: transparent; }
button.primary:hover { filter: brightness(1.08); }
button.danger { color: var(--error-color, #d32f2f); }
button.link { border: none; padding: 6px 10px; }
.message { min-height: 20px; margin-top: 14px; font-size: 13px; color: var(--secondary-text-color, #777); word-break: break-word; }
.list { max-height: calc(100vh - 200px); overflow-y: auto; }
.row { display: flex; align-items: center; gap: 12px; padding: 12px 20px; cursor: pointer; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.07)); }
.row:last-child { border-bottom: none; }
.row:hover { background: var(--secondary-background-color, rgba(0,0,0,.04)); }
.row-main { flex: 1; min-width: 0; }
.row-title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-sub { font-size: 12px; color: var(--secondary-text-color, #777); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-cat { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: var(--secondary-background-color, rgba(0,0,0,.06)); color: var(--secondary-text-color, #666); }
.empty { padding: 40px 20px; text-align: center; color: var(--secondary-text-color, #777); font-size: 14px; }
.menu { position: relative; }
.menu summary {
  list-style: none; cursor: pointer; padding: 8px 14px; border-radius: 10px;
  border: 1px solid var(--divider-color, rgba(0,0,0,.22)); font-size: 13px; white-space: nowrap;
}
.menu summary::-webkit-details-marker { display: none; }
.menu-list {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 50;
  min-width: 170px; padding: 6px; border-radius: 12px;
  background: var(--ha-card-background, #fff);
  border: 1px solid var(--divider-color, rgba(0,0,0,.12));
  box-shadow: 0 12px 32px rgba(0,0,0,.18);
}
.menu-list button {
  display: block; width: 100%; text-align: left; font-size: 13px;
  border: none; background: transparent; padding: 9px 12px; border-radius: 8px;
}
dialog {
  max-width: 560px; width: calc(100% - 32px); padding: 0; border: none; border-radius: 16px;
  color: var(--primary-text-color, #212121);
  background: var(--ha-card-background, var(--card-background-color, #fff));
  box-shadow: 0 18px 50px rgba(0,0,0,.28);
}
dialog::backdrop { background: rgba(0,0,0,.45); }
.dialog-head { padding: 18px 20px; font-size: 17px; font-weight: 600; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.10)); }
.dialog-body { padding: 20px; max-height: 65vh; overflow-y: auto; }
.dialog-actions { padding: 14px 20px; justify-content: flex-end; border-top: 1px solid var(--divider-color, rgba(0,0,0,.10)); }
.cred-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08)); font-size: 13px; }
.cred-row .cred-main { flex: 1; }
.cred-row .cred-sub { font-size: 12px; color: var(--secondary-text-color, #777); margin-top: 2px; }
@media (max-width: 768px) {
  .head { gap: 8px; padding: 10px 12px; }
  .icon-btn { order: 1; }
  .head-main { flex: 1 1 auto; order: 2; }
  .badge { order: 3; }
  .head .menu { order: 4; }
  .search-bar { flex: 1 1 100%; order: 5; }
  .search-bar select { flex: 1 1 120px; width: auto; }
}
`;

export class VaultView {
  constructor(root, api, vault) {
    this.root = root;
    this.api = api;
    this.vault = vault;
    this.screen = 'loading';
    this.message = '';
    this.dialog = null;
    this.editing = null;
    this.credentials = [];
    this.search = '';
    this.category = '';
    this.fingerprint = { available: false, platform: false, reason: '' };
    this.idle = null;
    this.hiddenAt = null;

    this.root.addEventListener('click', (event) => {
      this.resetIdle();
      this.onClick(event);
    });
    this.root.addEventListener('input', (event) => {
      this.resetIdle();
      this.onInput(event);
    });
    this.root.addEventListener('change', (event) => {
      this.resetIdle();
      this.onChange(event);
    });
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const field = event.target.dataset ? event.target.dataset.field : '';
      if (field === 'password') this.unlockWithPassword();
    });
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
        this.clearIdle();
      } else {
        if (this.hiddenAt && Date.now() - this.hiddenAt > IDLE_MS && this.vault.unlocked) {
          this.lock();
        }
        this.hiddenAt = null;
        this.resetIdle();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  destroy() {
    this.clearIdle();
    document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  clearIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  resetIdle() {
    this.clearIdle();
    if (!this.vault.unlocked) return;
    this.idle = setTimeout(() => this.lock(), IDLE_MS);
  }

  async start() {
    this.screen = 'loading';
    this.render();
    if (!cryptoAvailable()) {
      this.screen = 'error';
      this.message = '当前页面不是安全上下文，WebCrypto 不可用。请通过 HTTPS 或 localhost 访问 HomeAssistant。';
      this.render();
      return;
    }
    try {
      await this.vault.load();
      this.screen = 'locked';
    } catch (err) {
      this.screen = 'error';
      this.message = err.message;
      this.render();
      return;
    }
    this.fingerprint = webAuthnState();
    if (this.fingerprint.available) {
      this.fingerprint.platform = await platformAuthenticatorAvailable();
      if (!this.fingerprint.platform) {
        this.fingerprint.reason = '当前设备没有可用的平台指纹/生物识别认证器';
      }
    }
    this.render();
  }

  // ------------------------------------------------------------------ 渲染

  render() {
    this.root.innerHTML = this.template();
    const dialog = this.root.querySelector('dialog[data-dialog]');
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch (err) {
        dialog.setAttribute('open', '');
      }
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        this.cancel();
      });
    }
  }

  messageBox() {
    return `<div class="message" data-message>${esc(this.message)}</div>`;
  }

  cardHead(title, subtitle, badge, actions = '') {
    const menuBtn = `<button class="icon-btn" data-action="toggle-menu" aria-label="打开侧边栏" title="打开 HomeAssistant 侧边栏">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>`;
    return `<div class="head">
      ${menuBtn}
      <div class="head-main"><div class="title">${esc(title)}</div><div class="subtitle">${subtitle}</div></div>
      <span class="badge">${esc(badge)}</span>${actions}
    </div>`;
  }

  template() {
    if (this.screen === 'loading') {
      return `<div class="card"><div class="body"><div class="empty">正在加载密码库…</div></div></div>`;
    }
    if (this.screen === 'error') {
      return `<div class="card">${this.cardHead('我的密码', '无法启动', '异常')}
        <div class="body"><p class="hint">${esc(this.message)}</p>${this.messageBox()}</div></div>`;
    }
    if (this.screen === 'locked') return this.lockedTemplate();
    return this.unlockedTemplate();
  }

  lockedTemplate() {
    const ready = this.fingerprint.available && this.fingerprint.platform
      && Object.keys(localWraps()).length > 0;
    const reason = this.fingerprint.available
      ? (this.fingerprint.platform ? '本设备已注册指纹' : this.fingerprint.reason)
      : this.fingerprint.reason;
    return `<div class="card">${this.cardHead('我的密码', '请输入主密码解锁', '已锁定')}
      <div class="body">
        <label class="field"><span>主密码</span><input type="password" autocomplete="current-password" data-field="password" autofocus></label>
        <div class="actions">
          <button class="primary" data-act="unlock">密码解锁</button>
          ${ready ? '<button data-act="fingerprint">指纹解锁</button>' : ''}
        </div>
        <p class="hint" style="margin-top:16px">${esc(reason || '')}</p>
        ${this.messageBox()}
      </div></div>`;
  }

  visibleItems() {
    const query = this.search.trim().toLowerCase();
    return this.vault.items.filter((item) => {
      if (this.category && item.category !== this.category) return false;
      if (!query) return true;
      return [item.title, item.category, item.link, item.text]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }

  listTemplate() {
    const items = this.visibleItems();
    if (!items.length) return `<div class="empty">没有匹配的记录</div>`;
    return items.map((item) => `<div class="row" data-act="edit" data-id="${esc(item.id)}">
      <div class="row-main">
        <div class="row-title">${esc(item.title)}</div>
        <div class="row-sub">${esc(item.link || item.date || '')}</div>
      </div>
      ${item.category ? `<span class="row-cat">${esc(item.category)}</span>` : ''}
    </div>`).join('');
  }

  unlockedTemplate() {
    const categories = this.vault.categories;
    const menu = `<details class="menu">
      <summary>菜单</summary>
      <div class="menu-list">
        <button data-act="import">导入旧数据</button>
        <button data-act="export">导出备份</button>
        <button data-act="credentials">指纹与凭据</button>
        <button data-act="password">修改主密码</button>
        <button data-act="lock">锁定</button>
      </div>
    </details>`;
    const actions = `
      <div class="search-bar">
        <input type="search" data-field="search" placeholder="搜索备注 / 分类 / 内容 / 链接" value="${esc(this.search)}">
        <select data-field="category">
          <option value="">全部分类</option>
          ${categories.map((name) => `<option value="${esc(name)}"${this.category === name ? ' selected' : ''}>${esc(name)}</option>`).join('')}
        </select>
        <button class="primary" data-act="add">新增</button>
      </div>
      ${menu}
      <input type="file" accept="application/json,.json" data-field="import-file" hidden>`;
    return `<div class="card">${this.cardHead(
      '我的密码', `<span data-count>${this.visibleItems().length}</span> 条记录 · 已解锁`, '已解锁', actions
    )}
      <div class="list" data-list>${this.listTemplate()}</div>
      <div class="body" style="padding-top:0">${this.messageBox()}</div>
    </div>
    ${this.editDialogTemplate()}
    ${this.credentialsDialogTemplate()}
    ${this.passwordDialogTemplate()}`;
  }

  editDialogTemplate() {
    if (this.dialog !== 'edit' || !this.editing) return '';
    const item = this.editing;
    return `<dialog data-dialog="edit">
      <div class="dialog-head">${item.id ? '密码信息' : '新增密码'}</div>
      <div class="dialog-body">
        <label class="field"><span>密码分类</span><input name="category" list="category-options" value="${esc(item.category)}">
          <datalist id="category-options">${this.vault.categories.map((name) => `<option value="${esc(name)}"></option>`).join('')}</datalist>
        </label>
        <label class="field"><span>备注信息</span><textarea name="title" rows="2">${esc(item.title)}</textarea></label>
        <label class="field"><span>加密内容</span><textarea name="text" rows="5">${esc(item.text)}</textarea></label>
        <label class="field"><span>关联链接</span><input name="link" type="url" value="${esc(item.link)}"></label>
        <button class="link" data-act="link">打开链接</button>
      </div>
      <div class="dialog-actions">
        ${item.id ? '<button class="danger" data-act="remove">删除</button>' : ''}
        <button data-act="cancel">取消</button>
        <button class="primary" data-act="save">保存</button>
      </div>
    </dialog>`;
  }

  credentialsDialogTemplate() {
    if (this.dialog !== 'credentials') return '';
    const wraps = localWraps();
    const rows = this.credentials.length
      ? this.credentials.map((item) => `<div class="cred-row">
          <div class="cred-main"><div>${esc(item.name || '未命名设备')}</div>
            <div class="cred-sub">${esc(item.created || '')} · 本设备${wraps[item.id] ? '可用' : '无本地数据'}</div></div>
          <button class="danger" data-act="revoke" data-id="${esc(item.id)}">撤销</button>
        </div>`).join('')
      : '<div class="empty">尚未注册任何指纹凭据</div>';
    return `<dialog data-dialog="credentials">
      <div class="dialog-head">指纹与凭据</div>
      <div class="dialog-body">
        <p class="hint">指纹解锁仅在本设备有效；更换设备后需用主密码解锁再重新注册。${esc(this.fingerprint.available ? '' : this.fingerprint.reason)}</p>
        <label class="field"><span>设备名称</span><input data-field="device-name" value="本设备"></label>
        <button class="primary" data-act="register"${this.fingerprint.platform ? '' : ' disabled'}>注册本设备指纹</button>
        <div style="margin-top:16px">${rows}</div>
      </div>
      <div class="dialog-actions"><button data-act="cancel">关闭</button></div>
    </dialog>`;
  }

  passwordDialogTemplate() {
    if (this.dialog !== 'password') return '';
    return `<dialog data-dialog="password">
      <div class="dialog-head">修改主密码</div>
      <div class="dialog-body">
        <p class="hint">数据密钥不变，已注册的指纹仍可继续解锁。</p>
        <label class="field"><span>新主密码（至少 8 位）</span><input type="password" data-field="new-password" autocomplete="new-password"></label>
        <label class="field"><span>确认新主密码</span><input type="password" data-field="new-password2" autocomplete="new-password"></label>
      </div>
      <div class="dialog-actions">
        <button data-act="cancel">取消</button>
        <button class="primary" data-act="password-save">保存</button>
      </div>
    </dialog>`;
  }

  // ------------------------------------------------------------------ 事件

  onInput(event) {
    const field = event.target.dataset ? event.target.dataset.field : '';
    if (field === 'search') {
      this.search = event.target.value;
      const list = this.root.querySelector('[data-list]');
      const count = this.root.querySelector('[data-count]');
      if (list) list.innerHTML = this.listTemplate();
      if (count) count.textContent = this.visibleItems().length;
    }
  }

  async onChange(event) {
    const field = event.target.dataset ? event.target.dataset.field : '';
    if (field === 'category') {
      this.category = event.target.value;
      const list = this.root.querySelector('[data-list]');
      const count = this.root.querySelector('[data-count]');
      if (list) list.innerHTML = this.listTemplate();
      if (count) count.textContent = this.visibleItems().length;
    }
    if (field === 'import-file' && event.target.files[0]) {
      try {
        const items = normalizeItems(JSON.parse(await event.target.files[0].text()));
        this.vault.items = this.vault.items.concat(items);
        await this.vault.save();
        this.render();
        this.toast(`已导入 ${items.length} 条记录`);
      } catch (err) {
        this.toast(`导入失败：${err.message}`);
      }
    }
  }

  async onClick(event) {
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const menu = this.root.querySelector('details.menu[open]');
    if (menu) menu.open = false;
    const action = target.dataset.act;
    try {
      switch (action) {
        case 'unlock': await this.unlockWithPassword(); break;
        case 'fingerprint': await this.unlockWithFingerprint(); break;
        case 'lock': this.lock(); break;
        case 'add': this.openEdit(null); break;
        case 'edit': this.openEdit(target.dataset.id); break;
        case 'save': await this.saveItem(); break;
        case 'remove': await this.removeItem(); break;
        case 'cancel': this.cancel(); break;
        case 'link': this.openLink(); break;
        case 'export': this.exportBackup(); break;
        case 'import': this.root.querySelector('[data-field="import-file"]').click(); break;
        case 'credentials': await this.openCredentials(); break;
        case 'register': await this.register(); break;
        case 'revoke': await this.revoke(target.dataset.id); break;
        case 'password': this.dialog = 'password'; this.render(); break;
        case 'password-save': await this.changePassword(); break;
        default: break;
      }
    } catch (err) {
      this.toast(err.message || '操作失败');
    }
  }

  toast(text) {
    this.message = text;
    const box = this.root.querySelector('[data-message]');
    if (box) box.textContent = text;
    this.root.dispatchEvent(new CustomEvent('hass-notification', {
      bubbles: true, composed: true, detail: { message: text },
    }));
  }

  cancel() {
    this.dialog = null;
    this.editing = null;
    this.render();
  }

  // ------------------------------------------------------------------ 业务

  async unlockWithPassword() {
    const input = this.root.querySelector('[data-field="password"]');
    const password = input ? input.value : '';
    if (!password) return this.toast('请输入主密码');
    await this.vault.unlockWithPassword(password);
    this.screen = 'unlocked';
    this.message = '已解锁';
    this.render();
    this.resetIdle();
  }

  async unlockWithFingerprint() {
    this.toast('请验证指纹…');
    const result = await authenticate(this.api);
    await this.vault.unlockWithCredential(result.credSecret, result.wrapped);
    this.screen = 'unlocked';
    this.message = '指纹解锁成功';
    this.render();
    this.resetIdle();
  }

  lock() {
    this.vault.lock();
    this.dialog = null;
    this.editing = null;
    this.search = '';
    this.category = '';
    this.screen = 'locked';
    this.clearIdle();
    this.render();
    this.toast('已锁定');
  }

  openEdit(id) {
    const item = id ? this.vault.items.find((entry) => entry.id === id) : null;
    this.editing = item ? { ...item } : { id: '', title: '', category: '', text: '', link: '' };
    this.dialog = 'edit';
    this.render();
  }

  dialogFields(name) {
    const dialog = this.root.querySelector(`[data-dialog="${name}"]`);
    if (!dialog) return null;
    return {
      dialog,
      value: (field) => {
        const element = dialog.querySelector(`[name="${field}"]`);
        return element ? element.value.trim() : '';
      },
    };
  }

  async saveItem() {
    const form = this.dialogFields('edit');
    if (!form) return;
    const item = {
      id: this.editing.id,
      category: form.value('category'),
      title: form.value('title'),
      text: form.value('text'),
      link: form.value('link'),
    };
    if (!item.title || !item.text) return this.toast('备注信息和加密内容不能为空');
    this.vault.upsert(item);
    await this.vault.save();
    this.dialog = null;
    this.editing = null;
    this.render();
    this.toast('已保存');
  }

  async removeItem() {
    if (!this.editing || !this.editing.id) return;
    if (!window.confirm('确定删除这条记录吗？')) return;
    this.vault.remove(this.editing.id);
    await this.vault.save();
    this.dialog = null;
    this.editing = null;
    this.render();
    this.toast('已删除');
  }

  openLink() {
    const form = this.dialogFields('edit');
    if (!form) return;
    const value = form.value('link');
    try {
      const url = new URL(value, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('协议不支持');
      window.open(url.href, '_blank', 'noopener');
    } catch (err) {
      this.toast('链接无效');
    }
  }

  exportBackup() {
    const blob = new Blob([this.vault.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `password-backup-${today()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.toast('已导出明文备份，请妥善保管并尽快删除');
  }

  async openCredentials() {
    this.credentials = await this.api.listCredentials();
    this.dialog = 'credentials';
    this.render();
  }

  async register() {
    if (!this.fingerprint.platform) return this.toast('当前环境不支持指纹解锁');
    const input = this.root.querySelector('[data-field="device-name"]');
    const name = (input && input.value.trim()) || '本设备';
    this.toast('请在设备上完成指纹验证…');
    await registerCredential(this.api, this.vault.key, name, this.vault.proof);
    this.credentials = await this.api.listCredentials();
    this.render();
    this.toast('指纹注册成功');
  }

  async revoke(id) {
    if (!window.confirm('确定撤销该指纹凭据吗？')) return;
    await this.api.deleteCredential(id, this.vault.proof);
    removeLocalWrap(id);
    this.credentials = await this.api.listCredentials();
    this.render();
    this.toast('凭据已撤销');
  }

  async changePassword() {
    const dialog = this.root.querySelector('[data-dialog="password"]');
    const first = dialog.querySelector('[data-field="new-password"]').value.trim();
    const second = dialog.querySelector('[data-field="new-password2"]').value.trim();
    if (first.length < 8) return this.toast('新主密码至少需要 8 位');
    if (first !== second) return this.toast('两次输入的新主密码不一致');
    await this.vault.changePassword(first);
    this.dialog = null;
    this.render();
    this.toast('主密码已更新，指纹凭据仍可继续使用');
  }
}
