import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { createRef, ref } from 'lit/directives/ref.js';

// @ts-ignore
import ha from './homeassistant.js'

import '@material/mwc-top-app-bar-fixed'
import '@material/web/textfield/outlined-text-field.js'


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
    return html`
    ${ha.passwordKey ? '' : html`<ha-dialog open ${ref(this.dialogLoginRef)} heading="我的密码">
    
        <md-outlined-text-field label="密钥" type="password" autofocus class="form-item" ${ref(this.passwordRef)}></md-outlined-text-field>
    
        
      <mwc-button slot="primaryAction" raised @click=${this._loginClick.bind(this)}>登录</mwc-button>

    </ha-dialog>`
      }

    <ha-dialog id="dialog-edit" ${ref(this.dialogEditRef)} heading="${this.key ? '密码信息' : '新增密码'}">
      <div>
        <md-outlined-text-field class="form-item" ${ref(this.categoryRef)} label="密码分类">
          <ha-select slot="trailingicon" style="width: 130px;">
          ${this.categories.map(ele => html`<mwc-list-item value="${ele}" @click="${() => (this.categoryRef.value as any).value = ele}">${ele}</mwc-list-item>`)}
          </ha-select>
        </md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.titleRef)} type="textarea" rows="2" label="备注信息"></md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.textRef)} type="textarea" rows="5" label="加密内容"></md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.linkRef)} type="url" label="关联链接">
          <mwc-button slot="trailingicon" @click=${this._linkClick.bind(this)}>跳转</mwc-button>
        </md-outlined-text-field>
      </div>

      <mwc-button slot="secondaryAction" @click=${{ handleEvent: () => (this.dialogEditRef.value as any).open = false }}>取消</mwc-button>    
      ${this.key ? html`<mwc-button  slot="secondaryAction" outlined  @click=${this._removeClick.bind(this)}>删除</mwc-button>` : ''}
      <mwc-button slot="primaryAction" raised  @click=${this._saveClick.bind(this)}>保存</mwc-button>
  
    </ha-dialog>

    <mwc-top-app-bar-fixed>
      
      <div slot="title" @click=${() => this.fire('hass-toggle-menu')} >我的密码</div>
      <ha-icon-button slot="actionItems" @click=${{ handleEvent: () => this._searchClick() }}>
        <ha-icon icon="mdi:magnify"></ha-icon>
      </ha-icon-button> 
      <ha-icon-button slot="actionItems" @click=${{ handleEvent: () => this._addClick() }}>
        <ha-icon icon="mdi:plus"></ha-icon>
      </ha-icon-button> 
    </mwc-top-app-bar-fixed>

    ${this.showSearch ? html`<div class="search-panel">
    <md-outlined-text-field label="搜索" ${ref(this.searchValueRef)} autofocus @input="${this._search.bind(this)}" >
      <ha-select slot="trailingicon" ${ref(this.searchCategoryRef)} @change="${this._search.bind(this)}" style="width: 130px;">
      <mwc-list-item value="">全部</mwc-list-item>
      ${this.categories.map(ele => html`<mwc-list-item value="${ele}">${ele}</mwc-list-item>`)}
      </ha-select>
    </md-outlined-text-field>
  </div>` : ''}
    
    <mwc-list style="min-width: 100%;">
      ${this.list.map((item, index) => html`<mwc-list-item twoline graphic="icon" @click=${{ handleEvent: () => this._onItemClick(item) }}>
       <span>${item.title}</span>
       <span slot="secondary">${item.link}</span>
       
       <span slot="graphic" >${index + 1}</span>
       
      </mwc-list-item>
      <li divider role="separator"></li>`)}
    </mwc-list>
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
    dialog.show()
  }

  private async _loginClick() {
    const password: any = this.passwordRef.value
    const value = password.value.trim()
    if (value) {
      // 登录
      await ha.login(value)

      const dialog: any = this.dialogLoginRef.value
      dialog.close()
      this.loadData()
    }
  }

  private _searchClick() {
    if (!ha.passwordKey) return this._showLoginDialog()
    this.showSearch = !this.showSearch
    if (this.showSearch) {
      this.source = JSON.parse(JSON.stringify(this.list))
      // 获取焦点
      setTimeout(() => {
        const searchValue: any = this.searchValueRef.value
        searchValue.focus()
      }, 100)
    } else {
      this.list = JSON.parse(JSON.stringify(this.source))
    }
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
      dialog.show()
      this.key = ''
      this._setValue(this.categoryRef.value, '')
      this._setValue(this.titleRef.value, '')
      this._setValue(this.textRef.value, '')
      this._setValue(this.linkRef.value, '')
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
      dialog.close()
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
        dialog.close()
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
  .search-panel{
    padding: 8px 8px 0 8px;
  }
  .search-panel md-outlined-text-field{
    width: 100%;
  }
  .mdc-top-app-bar{
    height: 56px;
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

    setTimeout(() => {
      var sheet = new CSSStyleSheet()
      sheet.replaceSync(`
      .mdc-top-app-bar__row{ height: 56px; }
      .mdc-top-app-bar__section { padding: 4px 12px; }`)

      const appbar: any = this.shadowRoot?.querySelector('mwc-top-app-bar-fixed')?.shadowRoot

      appbar.adoptedStyleSheets = [...appbar.adoptedStyleSheets, sheet]
    }, 60)
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'my-password': MyPassword
  }
}
