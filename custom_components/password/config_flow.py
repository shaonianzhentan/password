from __future__ import annotations

from typing import Any
import voluptuous as vol

from homeassistant.config_entries import ConfigFlow
from homeassistant.data_entry_flow import FlowResult

from .EncryptHelper import md5
from .manifest import manifest

DOMAIN = manifest.domain
DATA_SCHEMA = vol.Schema({
    vol.Required("key"): str,
    vol.Required("require_admin"): bool
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