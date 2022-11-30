import datetime
from homeassistant.components.http import HomeAssistantView
from .storage import StorageData
from .manifest import manifest
from .EncryptHelper import EncryptHelper, md5
from .const import MAC_KEY

sd = StorageData('password')

class HttpView(HomeAssistantView):

    url = "/api/password"
    name = "api:password"
    requires_auth = True

    def get_helper(self, request):
        hass = request.app["hass"]
        server_key = hass.data.get(f'{manifest.domain}-key')
        helper = EncryptHelper(server_key, MAC_KEY)
        return helper, server_key, hass

    async def get(self, request):
        helper, server_key, hass = self.get_helper(request)

        query = request.query
        _type = query.get('type')
        key = query.get('key')
        token = query.get('token')

        # 判断密钥是否匹配
        now = datetime.datetime.now()
        if token != md5(server_key + now.strftime('%Y%m%d%H')):
            hass.loop.create_task(hass.services.async_call('persistent_notification', 'create', {
                'title': '我的密码',
                'message':  f'客户端{request.remote}【{now.strftime("%Y-%m-%d %H:%M:%S")}】登录失败'
            }))
            return self.json_message("密钥错误", message_code='1')

        _list = sd.load()
        if _type == 'login':
            # 
            if len(_list) > 0:
                try:
                    item = _list[0]
                    helper.Decrypt(item['key'])
                except Exception as ex:
                    print(ex)
                    return self.json_message("当前密码文件无法解密，请在集成选项中输入MAC值更新密码文件", message_code='1')

            return self.json_message("登录成功", message_code='0')

        # 获取列表
        if _type == 'list':
            return self.json({
                'code': '0',
                'data': list(map(lambda item: {
                    'key': item['key'],
                    'title': item['title'],
                    'category': item['category']
                }, _list))
            })

        # 获取详情
        if _type == 'info':
            data = sd.get(key)
            if data is None:
                return self.json_message("未找到数据", message_code='1')
            else:
                try:
                    data['key'] = helper.Decrypt(key)
                    return self.json({ 'code': '0', 'data': data})
                except Exception as ex:
                    pass

        return self.json_message("未知错误", message_code='1')

    async def put(self, request):
        helper, server_key, hass = self.get_helper(request)

        body = await request.json()
        key = body.get('key')

        sd.add({
            'key': helper.Encrypt(key),
            'title': body.get('title'),
            'category': body.get('category'),
            'text': body.get('text'),
            'date': datetime.datetime.now().strftime('%Y-%m-%d')
        })
        return self.json_message("添加成功", message_code='0')

    async def post(self, request):
        helper, server_key, hass = self.get_helper(request)

        body = await request.json()
        key = body.get('key')

        sd.update({
            'key': helper.Encrypt(key),
            'title': body.get('title'),
            'category': body.get('category'),
            'text': body.get('text'),
            'date': datetime.datetime.now().strftime('%Y-%m-%d')
        })
        return self.json_message("更新成功", message_code='0')

    async def delete(self, request):
        helper, server_key, hass = self.get_helper(request)

        query = request.query
        key = query.get('key')
        
        sd.delete(key)
        return self.json_message("删除成功", message_code='0')