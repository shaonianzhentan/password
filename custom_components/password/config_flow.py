"""配置流：单实例，只收集访问限制；主密码由前端首次打开面板时设置。

明文主密码只存在于浏览器内存，config entry 不保存任何密码材料。
表单里显示当前 core.uuid，提示用户单独抄存，作为设备层的恢复凭据。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow
from homeassistant.data_entry_flow import FlowResult

from . import device
from .manifest import manifest

DOMAIN = manifest.domain


def _schema() -> vol.Schema:
    return vol.Schema({
        vol.Required('require_admin', default=True): bool,
    })


class PasswordConfigFlow(ConfigFlow, domain=DOMAIN):

    VERSION = 3

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason='single_instance_allowed')

        if user_input is None:
            try:
                uuid_text = await self.hass.async_add_executor_job(
                    device.read_uuid,
                    Path(self.hass.config.path('.storage', 'core.uuid')),
                )
            except device.DeviceError:
                uuid_text = '（未能读取，请确认 HomeAssistant 已正常启动）'
            return self.async_show_form(
                step_id='user',
                data_schema=_schema(),
                description_placeholders={'uuid': uuid_text},
            )

        return self.async_create_entry(title=manifest.name, data={
            'require_admin': bool(user_input.get('require_admin', True)),
        })
