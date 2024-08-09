import os
from homeassistant.util.json import load_json
from homeassistant.helpers.json import save_json
from homeassistant.helpers.storage import STORAGE_DIR
from homeassistant.core import async_get_hass
from pathlib import Path

class StorageData():

    def __init__(self, filename) -> None:
        self.file_path = f'{Path(__file__).resolve().parent.parent.parent}/{STORAGE_DIR}/{filename}.json'
        # print(self.file_path)

    async def get_uuid(self):
        ''' 获取唯一标识 '''
        hass = async_get_hass()
        config_path = hass.config.path(f'{STORAGE_DIR}/core.uuid')
        result = await hass.async_add_executor_job(load_json, config_path)
        return result['data']['uuid']

    def load(self):
        '''读取'''
        return load_json(self.file_path, [])

    def get(self, key):
        '''获取数据'''
        result = self.load()
        for item in result:
            if item['key'] == key:
                return item

    def add(self, data):
        '''添加'''
        result = self.load()
        result.append(data)
        save_json(self.file_path, result)
        return result

    def update(self, data):
        '''更新'''
        result = self.load()
        is_edit = False
        for index, item in enumerate(result):
            if item['key'] == data['key']:
                result[index] = data
                is_edit = True
                break
        if is_edit:
            save_json(self.file_path, result)
        return result

    def delete(self, key):
        '''删除'''
        result = self.load()
        del_index = None
        for index, item in enumerate(result):
            if item['key'] == key:
                del_index = index
                break
        if del_index is not None:
            del result[del_index]
            save_json(self.file_path, result)
        return result

    def save(self, data):
        '''保存文件'''
        save_json(self.file_path, data)