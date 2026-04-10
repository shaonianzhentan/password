import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { createRef, ref } from 'lit/directives/ref.js';

// @ts-ignore
import ha from './homeassistant.js'

import '@material/web/button/filled-button.js'
import '@material/web/button/filled-tonal-button.js'
import '@material/web/button/outlined-button.js'
import '@material/web/textfield/outlined-text-field.js'
import '@material/web/list/list.js'
import '@material/web/list/list-item.js'
import '@material/web/dialog/dialog.js'
import '@material/web/select/outlined-select.js'
import '@material/web/select/select-option.js'
import '@material/web/iconbutton/icon-button.js'
import '@material/web/icon/icon.js'
import '@material/web/fab/fab.js'

interface IItem {
  key: string;
  title: string;
  category: string;
  text?: string;
  link?: string;
  date?: string;
}

/**
 * An example element.
 *
 * @slot - This element has a slot
 * @csspart button - The button
 */
@customElement('my-password')
export class MyPassword extends LitElement {

  @property()
  key = ''

  /**
   * The number of times the button has been clicked.
   */
  @property({ type: Array })
  list = [] as IItem[]

  source = [] as IItem[]

  @property({ type: Array })
  categories = [] as string[]

  @property({ type: Boolean })
  showSearch = false

  @property({ type: Boolean })
  showCategoryDropdown = false

  @property()
  categoryFilter = ''

  dialogLoginRef = createRef()
  passwordRef = createRef()

  dialogEditRef = createRef()
  categoryRef = createRef()
  titleRef = createRef()
  textRef = createRef()
  linkRef = createRef()

  searchValueRef = createRef()
  searchCategoryRef = createRef()

  render() {
    // 未授权
    if (!ha.passwordKey) {
      return html`<md-dialog 
      @cancel=${(e: Event) => e.preventDefault()}
      open ${ref(this.dialogLoginRef)}>
      <div slot="headline">我的密码</div>
      <div slot="content">
        <md-outlined-text-field label="密钥" type="password" autofocus class="form-item" ${ref(this.passwordRef)}></md-outlined-text-field>
      </div>
      <div slot="actions">
        <md-filled-button slot="action" @click=${this._loginClick.bind(this)}>登录</md-filled-button>
      </div>
    </md-dialog>`
    }

    return html`
    <md-dialog id="dialog-edit" ${ref(this.dialogEditRef)}>
      <div slot="headline">${this.key ? '密码信息' : '新增密码'}</div>
      <div slot="content">
        <div class="combo-input">
          <md-outlined-text-field class="form-item" ${ref(this.categoryRef)} label="密码分类" 
          @input="${this._categoryInput.bind(this)}" 
          @click="${() => this.showCategoryDropdown = true}" 
          @blur="${() => setTimeout(() => this.showCategoryDropdown = false, 150)}"></md-outlined-text-field>
          ${this.showCategoryDropdown ? html`<div class="dropdown">
            ${this.categories.filter(cat => !this.categoryFilter || cat.includes(this.categoryFilter)).map(cat => html`<div class="dropdown-item" @mousedown="${() => this._selectCategory(cat)}">${cat}</div>`)}
            ${this.categories.filter(cat => !this.categoryFilter || cat.includes(this.categoryFilter)).length === 0 ? html`<div class="dropdown-item empty">无匹配分类</div>` : ''}
          </div>` : ''}
        </div>
        <md-outlined-text-field class="form-item" ${ref(this.titleRef)} type="textarea" rows="2" label="备注信息"></md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.textRef)} type="textarea" rows="5" label="加密内容"></md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.linkRef)} type="url" label="关联链接">
          <md-tonal-button slot="trailingicon" @click=${this._linkClick.bind(this)}>跳转</md-tonal-button>
        </md-outlined-text-field>
      </div>
      <div slot="actions">
        <md-outlined-button slot="action" @click=${{ handleEvent: () => (this.dialogEditRef.value as any).open = false }}>取消</md-outlined-button>    
        ${this.key ? html`<md-outlined-button slot="action" @click=${this._removeClick.bind(this)}>删除</md-outlined-button>` : ''}
        <md-filled-button slot="action" @click=${this._saveClick.bind(this)}>保存</md-filled-button>
      </div>
    </md-dialog>

    ${this.showSearch ? html`<div class="search-panel">
    <md-outlined-text-field label="搜索" ${ref(this.searchValueRef)} @input="${this._search.bind(this)}"></md-outlined-text-field>
    <md-outlined-select ${ref(this.searchCategoryRef)} @change="${this._search.bind(this)}">
    <md-select-option value="">全部</md-select-option>
    ${this.categories.map(ele => html`<md-select-option value="${ele}">${ele}</md-select-option>`)}
    </md-outlined-select>
  </div>` : ''}
    
    <md-list style="min-width: 100%;">
      ${this.list.map((item, index) => html`<md-list-item @click=${{ handleEvent: () => this._onItemClick(item) }}>
       <div slot="headline">${item.title}</div>
       <div slot="supporting-text">${item.link}</div>
       <div slot="start">${index + 1}</div>
      </md-list-item>`)}
    </md-list>

    <div class="fab-container">
      <md-fab @click=${this._searchClick.bind(this)} aria-label="搜索">
        <md-icon slot="icon">
          <svg viewBox="0 0 24 24">
            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
          </svg>
        </md-icon>
      </md-fab>
      <md-fab @click=${this._addClick.bind(this)} aria-label="添加">
        <md-icon slot="icon">
          <svg viewBox="0 0 24 24">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
          </svg>
        </md-icon>
      </md-fab>
    </div>
    `
  }

  private _linkClick() {
    const link = this._getValue(this.linkRef.value)
    if (link) {
      window.open(link)
    }
  }

  private _showLoginDialog() {
    const dialog: any = this.dialogLoginRef.value
    dialog.open = true
  }

  private async _loginClick() {
    const password: any = this.passwordRef.value
    const value = password.value.trim()
    if (value) {
      // 登录
      await ha.login(value)

      const dialog: any = this.dialogLoginRef.value
      dialog.open = false
      this.loadData()
    }
  }

  private _searchClick() {
    if (!ha.passwordKey) return this._showLoginDialog()
    this.showSearch = !this.showSearch
    if (this.showSearch) {
      this.source = JSON.parse(JSON.stringify(this.list))
    } else {
      this.list = JSON.parse(JSON.stringify(this.source))
    }
  }

  private _categoryInput() {
    const field: any = this.categoryRef.value
    this.categoryFilter = field?.value?.trim() || ''
    this.showCategoryDropdown = true
  }

  private _selectCategory(cat: string) {
    this._setValue(this.categoryRef.value, cat)
    this.categoryFilter = cat
    this.showCategoryDropdown = false
  }


  private _search() {
    const searchValue: any = this.searchValueRef.value
    const searchCategory: any = this.searchCategoryRef.value
    let arr = this.source
    if (searchValue.value) arr = arr.filter(ele => ele.title.includes(searchValue.value))
    if (searchCategory.value) arr = arr.filter(ele => ele.category == searchCategory.value)
    this.list = arr
  }

  private _addClick() {
    if (!ha.passwordKey) return this._showLoginDialog()

    const dialog: any = this.dialogEditRef.value
    if (dialog) {
      dialog.open = true
      this.key = ''
      this._setValue(this.categoryRef.value, '')
      this._setValue(this.titleRef.value, '')
      this._setValue(this.textRef.value, '')
      this._setValue(this.linkRef.value, '')
      this.showCategoryDropdown = false
    }
  }

  private async _saveClick() {
    const { key } = this
    const category = this._getValue(this.categoryRef.value)
    const title = this._getValue(this.titleRef.value)
    const text = this._getValue(this.textRef.value)
    const link = this._getValue(this.linkRef.value)

    if (!(category && title && text)) return;

    const params = { title, category, text, link }
    const res = key ? await ha.post({ ...params, key }) : await ha.put(params)

    this.toast(res.message)
    if (res.code == 0) {
      this.loadData()
      const dialog: any = this.dialogEditRef.value
      dialog.open = false
    }
  }

  private async _removeClick() {
    if (top?.confirm('确定删除吗？')) {
      const titleElement: any = this.titleRef.value
      const key = titleElement.dataset['key']
      const res = await ha.delete(key)
      this.toast(res.message)
      if (res.code == 0) {
        this.loadData()
        const dialog: any = this.dialogEditRef.value
        dialog.open = false
      }
    }
  }

  private async _onItemClick(item: IItem) {
    const dialog: any = this.dialogEditRef.value
    if (dialog) {
      dialog.open = true
      this._setValue(this.categoryRef.value, item.category)
      this._setValue(this.titleRef.value, item.title)
      this._setValue(this.linkRef.value, item.link || '')
      const titleElement: any = this.titleRef.value
      titleElement.dataset['key'] = item.key

      const res = await ha.getInfo(item.key)
      this.key = res.key
      this._setValue(this.textRef.value, res.text)
      this.showCategoryDropdown = false
    }
  }

  private _setValue(ele: any, value: string) {
    ele.value = value
  }

  private _getValue(ele: any) {
    return ele.value.trim()
  }

  static styles = css`
  .form-item {
    width: 100%;
    margin: 10px 0;
  }
  .search-panel {
    padding: 16px;
    border-bottom: 1px solid var(--md-sys-color-outline);
    display: flex;
    gap: 16px;
    align-items: flex-end;
  }
  .combo-input {
    position: relative;
    width: 100%;
  }
  .dropdown {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 9999;
    max-height: 240px;
    overflow: auto;
    background-color: var(--md-sys-color-surface, #fff);
    opacity: 1;
    border: 1px solid var(--md-sys-color-outline);
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.12);
  }
  .dropdown-item {
    padding: 10px 14px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dropdown-item:hover {
    background: var(--md-sys-color-surface-variant);
  }
  .dropdown-item.empty {
    color: var(--md-sys-color-outline);
    cursor: default;
  }
  .app-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px;
    background-color: var(--md-sys-color-surface-container);
    border-bottom: 1px solid var(--md-sys-color-outline);
  }
  .header-title {
    font-size: 20px;
    font-weight: 500;
    cursor: pointer;
  }
  .header-actions {
    display: flex;
    gap: 8px;
  }
  .fab-container {
    position: fixed;
    bottom: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  `

  //#region HomeAssistant

  fire(type: string, data = {}) {
    const event: any = new Event(type, {
      bubbles: true,
      cancelable: false,
      composed: true
    });
    event.detail = data;
    this.dispatchEvent(event);
  }

  toast(message: string) {
    this.fire("hass-notification", { message })
  }

  //#endregion

  async loadData() {
    if (!ha.passwordKey) return
    const res = await ha.getList()
    this.list = res.data
    this.categories = Array.from(new Set(this.list.map(ele => ele.category)))
  }

  connectedCallback() {
    super.connectedCallback()
    this.loadData()
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'my-password': MyPassword
  }
}
