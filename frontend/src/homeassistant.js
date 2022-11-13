import EncryptHelper from './EncryptHelper'

const PASSWORD_KEY = 'password-key'

class HomeAssistant {

    http(method, data) {
        let m = method.toLocaleLowerCase()
        let url = '/api/password'
        let body = null
        // 授权
        if (!('token' in data)) {
            data['token'] = this.getToken(sessionStorage[PASSWORD_KEY])
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
        return EncryptHelper.prototype.md5(key + new Date().toLocaleString().replace(/\/|\s/g, '').substring(0, 10))
    }

    /**
     * 登录
     * @param {string} key 
     * @returns 
     */
    async login(key) {
        const passwordKey = EncryptHelper.prototype.md5(key)
        const res = await this.http('get', { type: 'login', token: this.getToken(passwordKey) })
        if (res.code == '0') {
            sessionStorage['password-key'] = passwordKey
        }
        return res
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
        const { data } = res
        const helper = new EncryptHelper(data.key, sessionStorage[PASSWORD_KEY])
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
        const helper = new EncryptHelper(key, sessionStorage[PASSWORD_KEY])
        return this.http('put', { key, title, category, text: helper.Encrypt(text) })
    }

    /**
     * 更新
     * @param {object} param0 
     * @returns 
     */
    post({ key, title, category, text }) {
        const helper = new EncryptHelper(key, sessionStorage[PASSWORD_KEY])
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