from __future__ import annotations

from typing import Any
import voluptuous as vol

from homeassistant.data_entry_flow import FlowResult
from homeassistant.core import callback
from homeassistant.config_entries import ConfigFlow, OptionsFlow, ConfigEntry

from .EncryptHelper import EncryptHelper, md5
from .manifest import manifest
from .const import MAC_KEY
from .storage import StorageData

sd = StorageData('password')

DOMAIN = manifest.domain
DATA_SCHEMA = vol.Schema({
    vol.Required("key"): str,
    vol.Required("require_admin", default=True): bool
})

class SimpleConfigFlow(ConfigFlow, domain=DOMAIN):

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is None:
            return self.async_show_form(step_id="user", data_schema=DATA_SCHEMA)

        user_input['key'] = md5(user_input['key'])
        return self.async_create_entry(title=DOMAIN, data=user_input)

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry):
        return OptionsFlowHandler(entry)


class OptionsFlowHandler(OptionsFlow):
    def __init__(self, config_entry: ConfigEntry):
        self.config_entry = config_entry

    async def async_step_init(self, user_input=None):
        return await self.async_step_user(user_input)

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is None:
            options = self.config_entry.options
            errors = {}
            DATA_SCHEMA = vol.Schema({
                vol.Required("mac_key", default=MAC_KEY): str
            })
            return self.async_show_form(step_id="user", data_schema=DATA_SCHEMA, errors=errors)
        # 选项更新
        mac_key = user_input['mac_key']
        if mac_key != MAC_KEY:
            server_key = self.hass.data.get(f'{manifest.domain}-key')
            try:
                helper = EncryptHelper(server_key, MAC_KEY)
                _helper = EncryptHelper(server_key, mac_key)
                _list = sd.load()
                for item in _list:
                    # 原始MAC解密
                    _key = _helper.Decrypt(item['key'])
                    # 本地MAC加密
                    item['key'] = helper.Encrypt(_key)
                sd.save(_list)
            except Exception as ex:
                print(ex)
                DATA_SCHEMA = vol.Schema({
                    vol.Required("mac_key", default=mac_key): str
                })
                return self.async_show_form(step_id="user", data_schema=DATA_SCHEMA, errors={
                    'base': 'decrypt'
                })

        del user_input['mac_key']
        return self.async_create_entry(title='', data=user_input)