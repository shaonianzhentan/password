from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
import homeassistant.helpers.config_validation as cv

from .const import DOMAIN, WWW, VERSION

CONFIG_SCHEMA = cv.deprecated(DOMAIN)

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.http.register_view(HttpView)
    hass.http.register_static_path(WWW, hass.config.path(f"custom_components/{DOMAIN}/www"), False)
    hass.components.frontend.async_register_built_in_panel(
                        "iframe",
                        "书签",
                        "mdi:bookmark",
                        DOMAIN,
                        { "url": f"{WWW}/index.html?ver={VERSION}" },
                        require_admin=entry.options.get('require_admin', False))
    entry.async_on_unload(entry.add_update_listener(update_listener))
    return True

async def update_listener(hass, entry):
    """Handle options update."""
    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)

async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    hass.components.frontend.async_remove_panel(DOMAIN)
    return True