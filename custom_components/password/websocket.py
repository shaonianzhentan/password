"""通过 HomeAssistant websocket 通道提供密码库接口。

不注册任何自定义 HTTP 端点：所有请求都走 HA 已鉴权的 websocket 连接，
按 connection.user 做管理员校验，命令与响应不出现在 URL 或访问日志中。

服务端零知识：主密码只在浏览器内存，config entry 不保存任何密码材料；
磁盘上的 password_vault.json 是逐条设备层 envelope（见 storage.py），
服务端读写时自动解开/包裹，前端只看到 format 2 的条目明文元数据。

条目级接口是并发的关键：vault/put 那种「整库回传」已经被 item/put、
item/delete、items/put 取代——服务端按明文 id 定位记录，两条记录的写入互
不覆盖，改一条只重算一条，删一条不需要解开任何条目密文。敏感字段（username
/ password / totp）始终由前端逐条加密；服务端只做结构校验，写操作需要
unlockProof（由 vaultKey 派生的 HMAC）。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from . import device
from . import legacy
from . import webauthn as wa
from .manifest import manifest
from .storage import MAX_ITEMS, VaultError, VaultStorage, proof_ok

_LOGGER = logging.getLogger(__name__)
DOMAIN = manifest.domain
PREFIX = f'{DOMAIN}/'
# 旧版 password.json 通过 websocket 上传，拒绝任意大的消息体
MAX_LEGACY_CONTENT = 2_000_000
ID_MAX_LENGTH = 64
ID_CHARS = set(
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
)

COMMANDS = (
    f'{PREFIX}vault/get',
    f'{PREFIX}keys/put',
    f'{PREFIX}item/put',
    f'{PREFIX}items/put',
    f'{PREFIX}item/delete',
    f'{PREFIX}legacy/convert',
    f'{PREFIX}device/info',
    f'{PREFIX}device/recover',
    f'{PREFIX}webauthn/register/options',
    f'{PREFIX}webauthn/register/verify',
    f'{PREFIX}webauthn/authenticate/options',
    f'{PREFIX}webauthn/authenticate/verify',
    f'{PREFIX}webauthn/credentials/list',
    f'{PREFIX}webauthn/credentials/delete',
)

# schema 行为（HA 2026.x 实测，decorators.py:149-152）：
# 1) 只声明 type 时 len(schema) == 1，HA 置 func._ws_schema = False，该命令
#    不做 schema 校验，多余字段直接放行；
# 2) 声明了额外字段时，HA 用 BASE_COMMAND_MESSAGE_SCHEMA.extend(schema) 校验，
#    未知字段被拒（extra keys not allowed）。因此必须按命令逐个声明前端可能
#    携带的字段；无附加字段的命令保持空字典。
# 3) 关键限制：base schema 已占用 id（probatio.Required("id") = cv.positive_int，
#    即 websocket 消息序号）。extend 时后写的键会覆盖前值，所以业务字段绝不能
#    叫 id —— 否则校验器拿消息序号（数字）去比对字符串，必报
#    "expected str at 'id'. Got 43"。记录 id 一律放在 item 内或用 itemId 这类名字。
_ORIGIN_KEY = {vol.Optional('accessOrigin'): str}

COMMAND_SCHEMAS: dict[str, dict] = {
    'vault/get': {},
    'keys/put': {
        vol.Required('kdf'): dict,
        vol.Required('wrapped'): dict,
        vol.Optional('verifier'): str,
        vol.Optional('create'): bool,
        vol.Optional('baseRevision'): int,
        vol.Optional('unlockProof'): str,
    },
    'item/put': {
        vol.Required('item'): dict,
        # 上次看到的 updatedAt，用于逐项 CAS；新增时不传
        vol.Optional('base'): str,
        vol.Optional('unlockProof'): str,
    },
    'items/put': {
        vol.Required('items'): list,
        vol.Optional('unlockProof'): str,
    },
    'item/delete': {
        vol.Required('itemId'): str,
        vol.Optional('unlockProof'): str,
    },
    'legacy/convert': {
        vol.Required('content'): str,
        vol.Required('secret'): str,
        vol.Required('unlockProof'): str,
        vol.Optional('uuid'): str,
    },
    'device/info': {},
    'device/recover': {
        vol.Required('oldUuid'): str,
    },
    'webauthn/register/options': {**_ORIGIN_KEY},
    'webauthn/register/verify': {
        vol.Required('challenge'): str,
        vol.Required('credential'): dict,
        vol.Required('credSecret'): str,
        vol.Required('unlockProof'): str,
        vol.Optional('name'): str,
        **_ORIGIN_KEY,
    },
    'webauthn/authenticate/options': {**_ORIGIN_KEY},
    'webauthn/authenticate/verify': {
        vol.Required('challenge'): str,
        vol.Required('credential'): dict,
        **_ORIGIN_KEY,
    },
    'webauthn/credentials/list': {},
    'webauthn/credentials/delete': {
        vol.Required('credentialId'): str,
        vol.Required('unlockProof'): str,
    },
}


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


def _access_host(hass, msg) -> str:
    """浏览器看到的 host（含端口），用于 WebAuthn 的 RP ID 与 origin 校验。

    HA 的 ActiveConnection 不暴露握手请求对象，所以由前端传 location.origin。
    这个值只是「期望值」，不是信任锚：parse_client_data 要求认证器签名的
    clientDataJSON.origin 与它一致，parse_auth_data 校验 rpIdHash，一次性
    challenge 也绑定同一个 host（options 与 verify 不能换域名）。
    """
    reported = msg.get('accessOrigin')
    if isinstance(reported, str) and reported.startswith(('http://', 'https://')):
        host = urlparse(reported).netloc
        if host and host.isascii() and all(
            char.isalnum() or char in '.-:[]' for char in host
        ):
            return host
    for url in (hass.config.external_url, hass.config.internal_url):
        if url:
            return urlparse(url).netloc
    raise WsError(
        'unknown_error',
        '无法确定访问域名：请更新前端页面，或配置 HomeAssistant 内部/外部 URL',
    )


# ------------------------------------------------------------- 结构校验


def _valid_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= ID_MAX_LENGTH
        and all(char in ID_CHARS for char in value)
    )


def _valid_item(item: Any) -> bool:
    """只校验明文元数据与密文容器的形状，不解析密文内容。"""
    if not isinstance(item, dict) or not _valid_id(item.get('id')):
        return False
    for key in ('type', 'category', 'notes'):
        if not isinstance(item.get(key), str):
            return False
    origins = item.get('origins')
    if not isinstance(origins, list) or not all(
        isinstance(origin, str) for origin in origins
    ):
        return False
    enc = item.get('enc')
    return (
        isinstance(enc, dict)
        and isinstance(enc.get('alg'), str)
        and isinstance(enc.get('iv'), str)
        and isinstance(enc.get('ct'), str)
        and bool(enc.get('ct'))
    )


def _valid_kdf(kdf: Any) -> bool:
    return (
        isinstance(kdf, dict)
        and isinstance(kdf.get('salt'), str)
        and bool(kdf.get('salt'))
        and isinstance(kdf.get('iterations'), int)
        and int(kdf.get('iterations') or 0) > 0
    )


def _valid_wrapped(wrapped: Any) -> bool:
    password = wrapped.get('password') if isinstance(wrapped, dict) else None
    return (
        isinstance(password, dict)
        and isinstance(password.get('iv'), str)
        and isinstance(password.get('ct'), str)
    )


async def _verifier(hass) -> str:
    return await hass.async_add_executor_job(_storage(hass).verifier)


async def _require_unlock(hass, proof: Any) -> None:
    """指纹注册、凭据撤销、旧数据转换共用的解锁证明校验。"""
    if not proof_ok(await _verifier(hass), proof):
        raise WsError('not_allowed', '请先解锁密码库')


# --------------------------------------------------------------------- vault


async def _vault_get(hass, connection, msg, host):
    info = await hass.async_add_executor_job(_storage(hass).device_info)
    state = await hass.async_add_executor_job(_storage(hass).read_state)
    return {
        'exists': state['exists'],
        'kdf': state['kdf'],
        'wrapped': state['wrapped'],
        'keysRevision': state['keysRevision'],
        'items': state['items'],
        'revision': state['revision'],
        'deviceUuid': info['uuid'],
        'deviceId': info['id'],
        'deviceWrapped': info['wrapped'],
        'canManageDevice': bool(connection.user and connection.user.is_admin),
    }


async def _keys_put(hass, connection, msg, host):
    kdf = msg.get('kdf') or {}
    wrapped = msg.get('wrapped') or {}
    if not _valid_kdf(kdf) or not _valid_wrapped(wrapped):
        raise WsError('invalid_format', '密钥参数格式无效')
    return await hass.async_add_executor_job(
        _storage(hass).put_keys,
        bool(msg.get('create')),
        kdf,
        wrapped,
        str(msg.get('verifier') or ''),
        msg.get('baseRevision'),
        msg.get('unlockProof'),
    )


async def _item_put(hass, connection, msg, host):
    item = msg.get('item')
    if not _valid_item(item):
        raise WsError('invalid_format', '记录数据格式无效')
    return await hass.async_add_executor_job(
        _storage(hass).put_item,
        item,
        msg.get('base'),
        msg.get('unlockProof'),
    )


async def _items_put(hass, connection, msg, host):
    items = msg.get('items') or []
    if len(items) > MAX_ITEMS:
        raise WsError('invalid_format', f'记录数超过 {MAX_ITEMS} 条上限')
    if not all(_valid_item(item) for item in items):
        raise WsError('invalid_format', '记录数据格式无效')
    return await hass.async_add_executor_job(
        _storage(hass).put_items, items, msg.get('unlockProof')
    )


async def _item_delete(hass, connection, msg, host):
    ident = msg.get('itemId')
    if not _valid_id(ident):
        raise WsError('invalid_format', '记录 id 无效')
    return await hass.async_add_executor_job(
        _storage(hass).delete_item, ident, msg.get('unlockProof')
    )


# ------------------------------------------------------------- 设备层恢复


async def _device_info(hass, connection, msg, host):
    """设备 UUID 不匹配时，前端仍需要显示「当前」UUID 以对照旧值。"""
    info = await hass.async_add_executor_job(_storage(hass).device_info)
    return {
        'deviceUuid': info['uuid'],
        'deviceId': info['id'],
        'deviceWrapped': info['wrapped'],
    }


async def _device_recover(hass, connection, msg, host):
    """用旧 UUID 解开 envelope，再用当前 UUID 重新包裹（仅处理密文）。

    不要求 unlockProof：解不开外层时前端根本拿不到 wrapped.password，
    也就无法解锁，要求解锁证明会形成死锁。GCM tag 即旧 UUID 正确的证明。
    """
    user = connection.user
    if not user or not user.is_admin:
        raise WsError('not_allowed', '仅管理员可执行设备重新绑定')
    old_uuid = str(msg.get('oldUuid') or '').strip()
    if not old_uuid:
        raise WsError('invalid_format', '请填写旧 HomeAssistant 的 UUID')
    try:
        done = await hass.async_add_executor_job(_storage(hass).recover, old_uuid)
        info = await hass.async_add_executor_job(_storage(hass).device_info)
    except device.DeviceError as err:
        raise WsError('device_mismatch', str(err)) from err
    return {
        'vault': done['vault'],
        'credentials': done['credentials'],
        'deviceUuid': info['uuid'],
        'deviceId': info['id'],
    }


# ----------------------------------------------------------- 旧版历史数据转换


async def _legacy_convert(hass, connection, msg, host):
    """解密旧版 3DES 文件，返回新版明文字段；明文只在已解锁的浏览器内存里。"""
    await _require_unlock(hass, msg.get('unlockProof'))

    content = str(msg.get('content') or '')
    if not content or len(content) > MAX_LEGACY_CONTENT:
        raise WsError('invalid_format', '历史数据文件为空或超过 2MB 上限')
    try:
        server_key = legacy.server_key_from_secret(msg.get('secret'))
        given_uuid = str(msg.get('uuid') or '').strip()
        old_uuid = given_uuid or await hass.async_add_executor_job(
            legacy.read_uuid, hass.config.path('.storage', 'core.uuid')
        )
        entries = legacy.parse_entries(content)
        items, failures = legacy.convert_entries(entries, server_key, old_uuid)
    except legacy.LegacyError as err:
        raise WsError('invalid_format', str(err)) from err

    if not items:
        hint = failures[0] if failures else '文件中没有条目'
        raise WsError('invalid_format', f'没有可导入的记录：{hint}')
    return {
        'items': items,
        'total': len(entries),
        'converted': len(items),
        'failures': failures[:20],
    }


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
    await _require_unlock(hass, msg.get('unlockProof'))

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

    store = await hass.async_add_executor_job(
        _storage(hass).load_credentials
    )
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
    await hass.async_add_executor_job(_storage(hass).save_credentials, store)
    return {'id': parsed['credential_id']}


async def _auth_options(hass, connection, msg, host):
    user = connection.user
    store = await hass.async_add_executor_job(
        _storage(hass).load_credentials
    )
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
    store = await hass.async_add_executor_job(
        _storage(hass).load_credentials
    )
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

    await hass.async_add_executor_job(_storage(hass).save_credentials, store)
    return {'credSecret': record['cred_secret']}


async def _credentials_list(hass, connection, msg, host):
    store = await hass.async_add_executor_job(
        _storage(hass).load_credentials
    )
    return [
        {
            'id': item['id'],
            'name': item.get('name', ''),
            'created': item.get('created', ''),
        }
        for item in store['credentials']
    ]


async def _credentials_delete(hass, connection, msg, host):
    await _require_unlock(hass, msg.get('unlockProof'))
    credential_id = msg.get('credentialId')
    store = await hass.async_add_executor_job(
        _storage(hass).load_credentials
    )
    before = len(store['credentials'])
    store['credentials'] = [
        item for item in store['credentials'] if item.get('id') != credential_id
    ]
    if len(store['credentials']) == before:
        raise WsError('not_found', '凭据不存在')
    await hass.async_add_executor_job(_storage(hass).save_credentials, store)
    return {}


HANDLERS = {
    'vault/get': _vault_get,
    'keys/put': _keys_put,
    'item/put': _item_put,
    'items/put': _items_put,
    'item/delete': _item_delete,
    'legacy/convert': _legacy_convert,
    'device/info': _device_info,
    'device/recover': _device_recover,
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
        host = _access_host(hass, msg) if command in HOST_COMMANDS else ''
        result = await handler(hass, connection, msg, host)
    except WsError as err:
        connection.send_error(msg['id'], err.code, err.message)
        return
    except VaultError as err:
        # 存储层的业务错误（冲突 / 未解锁 / 记录不存在）原样带给前端
        connection.send_error(msg['id'], err.code, err.message)
        return
    except device.DeviceError as err:
        # 设备 UUID 不匹配：前端据此进入「指定旧 UUID」恢复界面
        connection.send_error(msg['id'], 'device_mismatch', str(err))
        return
    except Exception:
        _LOGGER.exception('处理 password/%s 失败', command)
        connection.send_error(msg['id'], 'unknown_error', '处理请求失败')
        return
    connection.send_result(msg['id'], result)


def _ws(command: str):
    """按 HA 官方约定生成带装饰器的命令处理函数。"""
    schema = {
        vol.Required('type'): f'{PREFIX}{command}',
        **COMMAND_SCHEMAS[command],
    }

    @websocket_api.websocket_command(schema)
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
