import os
from homeassistant.util.json import load_json, save_json
from homeassistant.helpers.storage import STORAGE_DIR

class StorageData():

    def __init__(self, filename) -> None:
        self.file_path = os.path.abspath(f'{STORAGE_DIR}/{filename}.json')

    def load(self):
        '''读取'''
        return load_json(self.file_path, [])

    def add(self, data):
        '''添加'''
        result = self.load()
        result.append(data)
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