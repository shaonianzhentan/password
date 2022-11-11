from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
import homeassistant.helpers.config_validation as cv

from .http import HttpView
from .manifest import manifest
from .const import DOMAIN

CONFIG_SCHEMA = cv.deprecated(DOMAIN)

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.http.register_view(HttpView)
    url = f'/{DOMAIN}-www'
    hass.http.register_static_path(url, hass.config.path(f"custom_components/{DOMAIN}/www"), False)

    url_path = entry.entry_id
    config = entry.data
    require_admin = config.get('require_admin', True)

    # 保存密钥
    hass.data.setdefault(f'{DOMAIN}-key', config.get('key'))

    hass.components.frontend.async_register_built_in_panel("iframe", manifest.name,
            "mdi:book-lock-outline", url_path,
            {"url": f"{url}/index.html?v={manifest.version}"},
            require_admin=require_admin,
        )
    return True

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    url_path = entry.entry_id
    hass.components.frontend.async_remove_panel(url_path)
    return True