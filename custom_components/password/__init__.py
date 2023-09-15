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
    url = f'/{url_path}'
    hass.http.register_static_path(url, hass.config.path(f"custom_components/{DOMAIN}/www"), False)

    module_url = f"{url}/my-password.js?v={manifest.version}"
    #hass.components.frontend.add_extra_js_url(hass, module_url)

    await hass.components.panel_custom.async_register_panel(
            frontend_url_path='my-password',
            webcomponent_name="my-password",
            sidebar_title=manifest.name,
            sidebar_icon="mdi:book-lock-outline",
            module_url=module_url,
            config={},
            require_admin=require_admin
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