import os, json
from homeassistant.components.http import HomeAssistantView

class HttpView(HomeAssistantView):

    url = "/api/password"
    name = "api:password"
    requires_auth = True

    async def get(self, request):
        query = request.query
        key = query.get('key')

        # 判断密钥是否匹配
        if key != 'md5(当前key+年月日时)':
            return self.json_message("密钥错误", message_code='1')

        # 读取本地文件
        return self.result()

    async def put(self, request):
        body = request.json()

        key = body.get('key')
        title = body.get('title')
        category = body.get('category')
        text = body.get('text')

        # 保存到文件
        return self.result()

    async def post(self, request):
        return self.result()

    async def delete(self, request):
        query = request.query
        key = query.get('key')
        # 删除文件



        return self.result()

    def result(self):
        # 读取所有文件

        return self.json({
            'code': '0',
            'data': []
        })