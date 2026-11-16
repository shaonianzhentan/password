"""我的密码 —— HomeAssistant 自定义集成。

注册侧边栏自定义面板（顶层 Custom Element，非 iframe）与 websocket 命令。
前端 JS 由 panel_custom 的 module_url 直接加载，业务请求全部走 HA 自身的
websocket 通道，不注册自定义 HTTP 端点。
"""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import async_remove_panel
from homeassistant.components.http import StaticPathConfig
from homeassistant.components import panel_custom
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .manifest import manifest
from .websocket import async_register_commands

_LOGGER = logging.getLogger(__name__)
DOMAIN = manifest.domain
# 1) 静态资源路径必须与面板路由 /password 分开：同名目录资源会让直接访问
#    或刷新 /password 被当成目录请求，返回 403 Forbidden。
# 2) 路径里带集成版本：password-panel.js 的相对 import 会继承这个前缀，
#    升级后所有 JS 模块一并换 URL，不必依赖浏览器强制刷新。
STATIC_URL = f'/{DOMAIN}_static/{manifest.version}'
MODULE_URL = f'{STATIC_URL}/password-panel.js'


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """升级到 v3：清除历史配置里保存的明文主密码。

    密码库内容（kdf / wrapped / verifier / items）完全不动，用户仍用原主密码
    解锁；只是服务端不再持有任何密码材料。
    """
    if entry.version < 3:
        data = dict(entry.data)
        removed = 'master_password' in data
        data.pop('master_password', None)
        try:
            hass.config_entries.async_update_entry(entry, data=data, version=3)
        except TypeError:  # 旧版 HA 的 async_update_entry 不接受 version
            hass.config_entries.async_update_entry(entry, data=data)
        if removed:
            _LOGGER.info('已从集成配置中移除明文主密码，密码库内容保持不变')
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    domain_data = hass.data.setdefault(DOMAIN, {})

    # websocket 命令与静态路径没有反注册接口，重载时只注册一次
    if not domain_data.get('commands_registered'):
        async_register_commands(hass)
        domain_data['commands_registered'] = True
    if not domain_data.get('static_registered'):
        www = str(Path(__file__).parent / 'www')
        await hass.http.async_register_static_paths([
            StaticPathConfig(STATIC_URL, www, False)
        ])
        domain_data['static_registered'] = True

    try:
        async_remove_panel(hass, DOMAIN)
    except Exception:  # 面板尚未注册
        pass

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name='password-panel',
        frontend_url_path=DOMAIN,
        sidebar_title=manifest.name,
        sidebar_icon='mdi:book-lock-outline',
        module_url=MODULE_URL,
        config={'version': manifest.version},
        require_admin=entry.data.get('require_admin', True),
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    try:
        async_remove_panel(hass, DOMAIN)
    except Exception as err:
        _LOGGER.debug('移除面板失败：%s', err)
    return True
