import { LitElement, css, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { createRef, ref } from 'lit/directives/ref.js';

import ha from './homeassistant.js'

import '@material/mwc-top-app-bar-fixed'
import '@material/web/all'

interface IItem {
  key: string;
  title: string;
  category: string;
  text?: string;
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
  /**
   * Copy for the read the docs hint.
   */
  @property()
  key = ''

  /**
   * The number of times the button has been clicked.
   */
  @property({ type: Array })
  list = [] as IItem[]

  dialogLoginRef = createRef()
  passwordRef = createRef()


  dialogEditRef = createRef()
  categoryRef = createRef()
  titleRef = createRef()
  textRef = createRef()
  linkRef = createRef()

  render() {
    return html`
    ${ha.passwordKey ? '' : html`<md-dialog open ${ref(this.dialogLoginRef)}>
      <div slot="headline">
        我的密码
      </div>
      <div slot="content" method="dialog">
        <md-filled-text-field label="密钥" type="password" class="form-item"  ${ref(this.passwordRef)}></md-filled-text-field>
      </div>
      <div slot="actions">
        <md-text-button @click=${this._loginClick.bind(this)}>登录</md-text-button>
      </div>
    </md-dialog>`
      }

    <md-dialog id="dialog-edit" ${ref(this.dialogEditRef)}>
      <div slot="headline">
        ${this.key ? '密码信息' : '新增密码'}
      </div>
      <div slot="content" method="dialog">
        <md-outlined-text-field class="form-item" ${ref(this.categoryRef)} label="密码分类">
          <md-text-button slot="trailingicon">选择</md-text-button>
        </md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.titleRef)} type="textarea" rows="2" label="备注信息"></md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.textRef)} type="textarea" rows="5" label="加密内容"></md-outlined-text-field>
        <md-outlined-text-field class="form-item" ${ref(this.linkRef)} label="关联链接"></md-outlined-text-field>
      </div>
      <div slot="actions">
        <md-outlined-button @click=${this._removeClick.bind(this)}>删除</md-outlined-button>
        <md-outlined-button @click=${this._saveClick.bind(this)}>保存</md-outlined-button>
        <md-text-button @click=${{ handleEvent: () => (this.dialogEditRef.value as any).open = false }}>取消</md-text-button>
      </div>
    </md-dialog>

    <mwc-top-app-bar-fixed> 
      <ha-menu-button slot="navigationIcon"></ha-menu-button> 
      <div slot="title">我的密码</div>
      <ha-icon-button slot="actionItems" @click=${{ handleEvent: () => this._searchClick() }}>🔎</ha-icon-button> 
      <ha-icon-button slot="actionItems" @click=${{ handleEvent: () => this._addClick() }}>+</ha-icon-button> 
    </mwc-top-app-bar-fixed>


    <md-list style="min-width: 100%;">
      ${this.list.map(item => html`<md-list-item headline="${item.title}" @click=${{ handleEvent: () => this._onItemClick(item) }}></md-list-item>`)}
    </md-list>
    `
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
    }
  }

  private _searchClick() {
    if (!ha.passwordKey) return this._showLoginDialog()
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
    }
  }

  private async _saveClick() {
    const { key } = this
    const category = this._getValue(this.categoryRef.value)
    const title = this._getValue(this.titleRef.value)
    const text = this._getValue(this.textRef.value)

    if (!(category && title && text)) return;

    const params = { title, category, text }
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
    return ele.value
  }

  static styles = css`
  .form-item {
    width: 100%;
    margin: 10px 0;
  }
  `

  //#region HomeAssistant

  fire(type: string, data: object) {
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
    const res = await ha.getList()
    this.list = res.data
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
