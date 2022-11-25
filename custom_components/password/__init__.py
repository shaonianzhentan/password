from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
import homeassistant.helpers.config_validation as cv

from .http import HttpView
from .manifest import manifest
from .const import DOMAIN
from .const import MAC_KEY
from .storage import StorageData
from .EncryptHelper import EncryptHelper

sd = StorageData('password')

CONFIG_SCHEMA = cv.deprecated(DOMAIN)

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:

    url_path = entry.entry_id
    config = entry.data
    require_admin = config.get('require_admin', True)

    # 保存密钥
    server_key = config.get('key')
    hass.data.setdefault(f'{DOMAIN}-key', server_key)

    hass.http.register_view(HttpView)
    url = f'/{url_path}-www'
    hass.http.register_static_path(url, hass.config.path(f"custom_components/{DOMAIN}/www"), False)

    hass.components.frontend.async_register_built_in_panel("iframe", manifest.name,
            "mdi:book-lock-outline", url_path,
            {"url": f"{url}/index.html?v={manifest.version}"},
            require_admin=require_admin,
        )
    # 判断是否异常
    _list = sd.load()
    if len(_list) > 0:
        item = _list[0]
        helper = EncryptHelper(server_key, MAC_KEY)
        try:
            helper.Decrypt(item['key'])
        except Exception as ex:
            print(ex)
            await hass.services.async_call('persistent_notification', 'create', {
                'title': manifest.name,
                'message': '当前密码文件无法解密，请在集成选项中输入MAC值更新密码文件'
            })
    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    url_path = entry.entry_id
    hass.components.frontend.async_remove_panel(url_path)
    manifest.update()
    return True