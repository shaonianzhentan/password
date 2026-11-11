"""通过 HomeAssistant websocket 通道提供密码库接口。

不注册任何自定义 HTTP 端点：所有请求都走 HA 已鉴权的 websocket 连接，
按 connection.user 做管理员校验，命令与响应不出现在 URL 或访问日志中。
vault 是前端加密后的整库密文；写操作需要 unlockProof（由 vaultKey 派生的
HMAC）与 revision 乐观锁，防止未解锁者覆盖数据。
"""
from __future__ import annotations

import hmac
import logging
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from . import webauthn as wa
from .manifest import manifest
from .storage import VaultStorage

_LOGGER = logging.getLogger(__name__)
DOMAIN = manifest.domain
PREFIX = f'{DOMAIN}/'
VAULT_FIELDS = ('version', 'kdf', 'wrapped', 'blob', 'verifier')

COMMANDS = (
    f'{PREFIX}vault/get',
    f'{PREFIX}vault/put',
    f'{PREFIX}webauthn/register/options',
    f'{PREFIX}webauthn/register/verify',
    f'{PREFIX}webauthn/authenticate/options',
    f'{PREFIX}webauthn/authenticate/verify',
    f'{PREFIX}webauthn/credentials/list',
    f'{PREFIX}webauthn/credentials/delete',
)


class WsError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _storage(hass) -> VaultStorage:
    key = f'{DOMAIN}_storage'
    if key not in hass.data:
        hass.data[key] = VaultStorage(hass)
    return hass.data[key]


def _config_value(hass, key, default=None):
    entries = hass.config_entries.async_entries(DOMAIN)
    return entries[0].data.get(key, default) if entries else default


def _check_admin(hass, connection) -> bool:
    require_admin = bool(_config_value(hass, 'require_admin', True))
    user = connection.user
    return not require_admin or bool(user and user.is_admin)


def _access_host(hass, connection) -> str:
    """浏览器看到的 host（含端口），用于 WebAuthn 的 RP ID 与 origin 校验。"""
    request = getattr(connection, 'request', None)
    host = getattr(request, 'host', None)
    if host:
        return host
    for url in (hass.config.external_url, hass.config.internal_url):
        if url:
            return urlparse(url).netloc
    raise WsError(
        'unknown_error', '无法确定访问域名，请配置 HomeAssistant 内部/外部 URL'
    )


def _valid_vault(vault: Any) -> bool:
    return (
        isinstance(vault, dict)
        and vault.get('version') == 2
        and isinstance(vault.get('kdf'), dict)
        and isinstance(vault.get('wrapped'), dict)
        and isinstance(vault.get('blob'), dict)
        and isinstance(vault.get('verifier'), str)
        and len(vault['verifier']) >= 20
    )


def _proof_ok(vault: dict | None, proof: Any) -> bool:
    if not vault or not isinstance(proof, str):
        return False
    return hmac.compare_digest(proof, vault.get('verifier', ''))


async def _load_vault(hass):
    return await hass.async_add_executor_job(_storage(hass).load_vault)


async def _load_credentials(hass) -> dict:
    return await hass.async_add_executor_job(_storage(hass).load_credentials)


async def _save_credentials(hass, data: dict) -> None:
    await hass.async_add_executor_job(_storage(hass).save_credentials, data)


# --------------------------------------------------------------------- vault

async def _vault_get(hass, connection, msg, host):
    vault = await _load_vault(hass)
    if vault is None:
        return {
            'exists': False,
            'vault': None,
            'masterPassword': _config_value(hass, 'master_password'),
        }
    public = {key: value for key, value in vault.items() if key != 'verifier'}
    return {'exists': True, 'vault': public}


async def _vault_put(hass, connection, msg, host):
    incoming = msg.get('vault')
    if not _valid_vault(incoming):
        raise WsError('invalid_format', '密码库数据格式无效')

    current = await _load_vault(hass)
    create = bool(msg.get('create'))
    if create and current is not None:
        raise WsError('already_exists', '密码库已初始化')
    if not create:
        if current is None:
            raise WsError('not_found', '密码库尚未初始化')
        if not _proof_ok(current, msg.get('unlockProof')):
            raise WsError('not_allowed', '未解锁或密钥不匹配')
        if msg.get('revision') != current.get('revision'):
            raise WsError('conflict', '数据已被其它页面修改，请刷新后重试')

    clean = {key: incoming[key] for key in VAULT_FIELDS}
    clean['revision'] = (current.get('revision', 0) if current else 0) + 1
    clean['updated'] = datetime.now(timezone.utc).isoformat()
    await hass.async_add_executor_job(_storage(hass).save_vault, clean)
    return {'revision': clean['revision'], 'updated': clean['updated']}


# ------------------------------------------------------------------ WebAuthn

async def _register_options(hass, connection, msg, host):
    user = connection.user
    challenge = wa.challenges.create('register', user.id, host)
    return {
        'challenge': challenge,
        'rpId': wa.rp_id_from_host(host),
        'rpName': manifest.name,
        'userId': user.id,
        'userName': user.name or user.id,
    }


async def _register_verify(hass, connection, msg, host):
    vault = await _load_vault(hass)
    if not _proof_ok(vault, msg.get('unlockProof')):
        raise WsError('not_allowed', '请先使用密码解锁')

    user = connection.user
    challenge = str(msg.get('challenge', ''))
    if not wa.challenges.consume(challenge, 'register', user.id, host):
        raise WsError('expired', '验证已过期，请重试')

    credential = msg.get('credential') or {}
    response = credential.get('response') or {}
    try:
        wa.parse_client_data(
            response['clientDataJSON'], 'webauthn.create', challenge, host
        )
        parsed = wa.parse_registration(
            response['attestationObject'],
            credential['id'],
            wa.rp_id_from_host(host),
        )
        secret = wa.b64u_decode(msg.get('credSecret', ''))
    except (KeyError, TypeError, ValueError, wa.WebAuthnError) as err:
        raise WsError('invalid_registration', f'注册校验失败：{err}') from err
    if len(secret) != 32:
        raise WsError('invalid_registration', '解锁凭据长度无效')

    store = await _load_credentials(hass)
    store['credentials'] = [
        item for item in store['credentials']
        if item.get('id') != parsed['credential_id']
    ]
    store['credentials'].append({
        'id': parsed['credential_id'],
        'public_key': parsed['public_key'],
        'alg': parsed['alg'],
        'sign_count': parsed['sign_count'],
        'cred_secret': wa.b64u(secret),
        'user_id': user.id,
        'name': str(msg.get('name', '') or '本设备')[:64],
        'created': datetime.now(timezone.utc).isoformat(),
    })
    await _save_credentials(hass, store)
    return {'id': parsed['credential_id']}


async def _auth_options(hass, connection, msg, host):
    user = connection.user
    store = await _load_credentials(hass)
    challenge = wa.challenges.create('authenticate', user.id, host)
    return {
        'challenge': challenge,
        'rpId': wa.rp_id_from_host(host),
        'allowCredentials': [
            {'type': 'public-key', 'id': item['id']}
            for item in store['credentials']
        ],
    }


async def _auth_verify(hass, connection, msg, host):
    user = connection.user
    challenge = str(msg.get('challenge', ''))
    if not wa.challenges.consume(challenge, 'authenticate', user.id, host):
        raise WsError('expired', '验证已过期，请重试')

    credential = msg.get('credential') or {}
    response = credential.get('response') or {}
    store = await _load_credentials(hass)
    record = next(
        (item for item in store['credentials'] if item.get('id') == credential.get('id')),
        None,
    )
    if record is None:
        raise WsError('not_found', '凭据不存在或已被删除')
    try:
        record['sign_count'] = wa.verify_assertion(
            record, response, challenge, host
        )
    except (KeyError, TypeError, ValueError, wa.WebAuthnError) as err:
        raise WsError('invalid_assertion', f'指纹验证失败：{err}') from err

    await _save_credentials(hass, store)
    return {'credSecret': record['cred_secret']}


async def _credentials_list(hass, connection, msg, host):
    store = await _load_credentials(hass)
    return [
        {
            'id': item['id'],
            'name': item.get('name', ''),
            'created': item.get('created', ''),
        }
        for item in store['credentials']
    ]


async def _credentials_delete(hass, connection, msg, host):
    vault = await _load_vault(hass)
    if not _proof_ok(vault, msg.get('unlockProof')):
        raise WsError('not_allowed', '请先解锁')
    credential_id = msg.get('id')
    store = await _load_credentials(hass)
    before = len(store['credentials'])
    store['credentials'] = [
        item for item in store['credentials'] if item.get('id') != credential_id
    ]
    if len(store['credentials']) == before:
        raise WsError('not_found', '凭据不存在')
    await _save_credentials(hass, store)
    return {}


HANDLERS = {
    'vault/get': _vault_get,
    'vault/put': _vault_put,
    'webauthn/register/options': _register_options,
    'webauthn/register/verify': _register_verify,
    'webauthn/authenticate/options': _auth_options,
    'webauthn/authenticate/verify': _auth_verify,
    'webauthn/credentials/list': _credentials_list,
    'webauthn/credentials/delete': _credentials_delete,
}

# 只有涉及 challenge / origin 的命令才需要浏览器访问域名
HOST_COMMANDS = {
    'webauthn/register/options',
    'webauthn/register/verify',
    'webauthn/authenticate/options',
    'webauthn/authenticate/verify',
}


async def _execute(hass: HomeAssistant, connection, msg, command: str) -> None:
    """统一的权限校验、命令分派与响应。"""
    try:
        if not _check_admin(hass, connection):
            raise WsError('not_allowed', '权限不足')
        handler = HANDLERS.get(command)
        if handler is None:
            raise WsError('unknown_command', '未知命令')
        host = _access_host(hass, connection) if command in HOST_COMMANDS else ''
        result = await handler(hass, connection, msg, host)
    except WsError as err:
        connection.send_error(msg['id'], err.code, err.message)
        return
    except Exception:
        _LOGGER.exception('处理 password/%s 失败', command)
        connection.send_error(msg['id'], 'unknown_error', '处理请求失败')
        return
    connection.send_result(msg['id'], result)


def _ws(command: str):
    """按 HA 官方约定生成带装饰器的命令处理函数。"""
    @websocket_api.websocket_command({
        vol.Required('type'): f'{PREFIX}{command}',
    })
    @websocket_api.async_response
    async def handler(hass: HomeAssistant, connection, msg) -> None:
        await _execute(hass, connection, msg, command)

    handler.__name__ = f'ws_{command.replace("/", "_")}'
    return handler


WS_HANDLERS = tuple(_ws(command[len(PREFIX):]) for command in COMMANDS)


def async_register_commands(hass: HomeAssistant) -> None:
    """注册全部 websocket 命令（由集成 setup 调用一次）。"""
    for handler in WS_HANDLERS:
        websocket_api.async_register_command(hass, handler)
