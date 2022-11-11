import datetime
from homeassistant.components.http import HomeAssistantView
from .storage import StorageData
from .manifest import manifest
from .EncryptHelper import EncryptHelper
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
        return helper, server_key

    async def get(self, request):
        helper, server_key = self.get_helper(request)

        query = request.query
        key = query.get('key')

        # 判断密钥是否匹配
        if key != helper.md5(server_key + datetime.datetime.now().strftime('%Y%m%d%H')):
            return self.json_message("密钥错误", message_code='1')

        _list = sd.load()
        for item in _list:
            item['key'] = helper.Decrypt(item['key'])

        # 读取本地文件
        return self.json({
            'code': '0',
            'data': _list
        })

    async def put(self, request):
        helper, server_key = self.get_helper(request)

        body = request.json()
        key = body.get('key')

        sd.add({
            'key': helper.Encrypt(key),
            'title': body.get('title'),
            'category': body.get('category'),
            'text': body.get('text')
        })
        return self.json_message("添加成功", message_code='0')

    async def post(self, request):
        helper, server_key = self.get_helper(request)

        body = request.json()
        key = body.get('key')

        sd.update({
            'key': helper.Encrypt(key),
            'title': body.get('title'),
            'category': body.get('category'),
            'text': body.get('text')
        })
        return self.json_message("更新成功", message_code='0')

    async def delete(self, request):
        helper, server_key = self.get_helper(request)

        query = request.query
        key = query.get('key')
        
        sd.delete(helper.Encrypt(key))
        return self.json_message("删除成功", message_code='0')