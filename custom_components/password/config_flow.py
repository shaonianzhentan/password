"""配置流：单实例，收集主密码与是否限制为管理员。

主密码在添加集成时填写并保存在 config entry；前端首次打开面板时用它
自动创建密码库，之后解锁仍需在浏览器输入主密码（或用指纹解锁）。
"""
from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import selector

from .manifest import manifest

DOMAIN = manifest.domain


def _schema() -> vol.Schema:
    return vol.Schema({
        vol.Required('master_password'): selector.TextSelector(
            selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
        ),
        vol.Required('require_admin', default=True): bool,
    })


class PasswordConfigFlow(ConfigFlow, domain=DOMAIN):

    VERSION = 2

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if self._async_current_entries():
            return self.async_abort(reason='single_instance_allowed')

        if user_input is None:
            return self.async_show_form(step_id='user', data_schema=_schema())

        password = str(user_input.get('master_password') or '').strip()
        if len(password) < 8:
            return self.async_show_form(
                step_id='user',
                data_schema=_schema(),
                errors={'base': 'weak_password'},
            )

        return self.async_create_entry(title=manifest.name, data={
            'master_password': password,
            'require_admin': bool(user_input.get('require_admin', True)),
        })
