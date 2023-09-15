import EncryptHelper from './EncryptHelper'
import dayjs from 'dayjs'

const PASSWORD_KEY = 'password-key'

class HomeAssistant {

  get passwordKey() {
    return sessionStorage[PASSWORD_KEY]
  }

  http(method, data) {
    let m = method.toLocaleLowerCase()
    let url = '/api/password'
    let body = null
    // 授权
    if (!('token' in data)) {
      data['token'] = this.getToken(this.passwordKey)
    }

    switch (m) {
      case 'get':
      case 'delete':
        let arr = Object.keys(data).map(key => key + '=' + encodeURIComponent(data[key]))
        url = url + '?' + arr.join('&') + `&t=${Date.now()}`
        break;
      case 'post':
      case 'put':
        body = JSON.stringify(data)
        break;
    }
    return parent.document.querySelector('home-assistant').hass.fetchWithAuth(url, {
      method,
      body,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    }).then(res => res.json())
  }

  getToken(key) {
    return EncryptHelper.prototype.md5(key + dayjs().format('YYYYMMDDHH'))
  }

  /**
   * 登录
   * @param {string} key 
   * @returns 
   */
  async login(key) {
    if (!key) {
      top.alert("请输入密钥")
      return false
    }

    const passwordKey = EncryptHelper.prototype.md5(key)
    const res = await this.http('get', { type: 'login', token: this.getToken(passwordKey) })
    if (res.code == '0') {
      sessionStorage['password-key'] = passwordKey
      return true
    }
    top.alert("密钥错误！")
    return false
  }

  /**
   * 获取列表
   * @returns
   */
  async getList() {
    const res = await this.http('get', { type: 'list' })
    res.data.reverse()
    return res
  }

  /**
   * 获取详情
   * @param {string} key 
   * @returns
   */
  async getInfo(key) {
    const res = await this.http('get', { type: 'info', key })
    const { data, code, message } = res
    if (code != '0') {
      top.alert(message)
      return {}
    }
    const helper = new EncryptHelper(data.key, this.passwordKey)
    data.text = helper.Decrypt(data.text)
    return data
  }

  /**
   * 新增
   * @param {object} param0 
   * @returns 
   */
  put({ title, category, text }) {
    const key = `${Date.now()}T${Math.random().toString(16).substr(-4)}`
    const helper = new EncryptHelper(key, this.passwordKey)
    return this.http('put', { key, title, category, text: helper.Encrypt(text) })
  }

  /**
   * 更新
   * @param {object} param0 
   * @returns 
   */
  post({ key, title, category, text }) {
    const helper = new EncryptHelper(key, this.passwordKey)
    return this.http('post', {
      key,
      title,
      category,
      text: helper.Encrypt(text)
    })
  }

  /**
   * 删除
   * @param {string} key 
   * @returns 
   */
  delete(key) {
    return this.http('delete', { key })
  }
}

const ha = new HomeAssistant()
export default ha