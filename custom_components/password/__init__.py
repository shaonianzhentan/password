from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
import homeassistant.helpers.config_validation as cv
from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.frontend import async_register_built_in_panel, async_remove_panel

from .http import HttpView
from .manifest import manifest
from .storage import StorageData
from .EncryptHelper import EncryptHelper

sd = StorageData('password')

DOMAIN = manifest.domain
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
    await hass.http.async_register_static_paths([
        StaticPathConfig(url, hass.config.path(f"custom_components/{DOMAIN}/www"), False)
    ])


    async_register_built_in_panel(
        hass,
        "iframe",
        sidebar_title=manifest.name,
        sidebar_icon="mdi:book-lock-outline",
        frontend_url_path=DOMAIN,
        config={"url": f"{url_path}/index.html?v={manifest.version}"},
        require_admin=require_admin
    )

    # 判断是否异常
    _list = await hass.async_add_executor_job(sd.load)
    if len(_list) > 0:
        item = _list[0]
        helper = EncryptHelper(server_key, await sd.get_uuid())
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
    async_remove_panel(hass, 'my-password')
    await hass.async_add_executor_job(manifest.update)
    return True