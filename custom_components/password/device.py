"""设备层：用 HomeAssistant 的 core.uuid 派生的密钥包裹磁盘数据。

密钥材料（两种布局共用）：
  deviceKey = HKDF-SHA256(core.uuid, device.salt, "password/device/v1")
  device.id = HMAC(deviceKey, "password/device-id/v1")[:16]，仅用于展示与校验

format 3（整块 envelope，凭据文件与迁移兼容）：
  { format: 3, device: { alg, kdf, salt, id }, payload: { iv, ct }, created }
  payload.ct = AES-256-GCM(deviceKey, inner_json, aad=外层头字段)

format 4（密码库逐条 envelope，见 storage.py）：
  文件头仍是一份 device 头；keys 与 payload 数组的每一项各自独立 seal()，
  AAD = [作用域, device.id, 条目 id]，因此删除一条不必解开任何密文，
  也不能把某条的密文挪到另一条的 id 下面。

服务端只处理密文，不需要也拿不到浏览器内存里的主密码。core.uuid 是
「设备因子」而非机密：它与密码库同在 .storage 下，因此这一层防的是
「密码库文件被单独拷走」，而不是「整个配置目录泄露」——后者仍由主密码保护。

与旧版 3DES-CBC 的区别：uuid 只作密钥材料，绝不作 IV；每次写入都换
随机 nonce，AAD 绑定外层头，GCM 提供认证，避免静态 IV 与密文篡改。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # 不因缺少依赖导致整个集成加载失败
    AESGCM = None

FORMAT = 3          # 整块 envelope：凭据文件、旧版密码库与迁移兼容
VAULT_FORMAT = 4    # 逐条 envelope：当前密码库的磁盘格式（见 storage.py）
ALG = 'AES-256-GCM'
KDF = 'HKDF-SHA256'
KEYS_SCOPE = 'password/keys/v1'
ITEM_SCOPE = 'password/item/v1'
KEY_INFO = b'password/device/v1'
ID_INFO = b'password/device-id/v1'
NONCE_LENGTH = 12
SALT_LENGTH = 16


class DeviceError(Exception):
    """设备层无法解开（UUID 不匹配、文件损坏或环境缺少依赖）。"""


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')


def ub64(value: Any) -> bytes:
    return base64.b64decode(str(value or ''))


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """RFC 5869 HKDF-SHA256（标准库实现，避免额外依赖）。"""
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out = b''
    block = b''
    counter = 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


def read_uuid(path: str | Path) -> str:
    """读取 .storage/core.uuid 中的 HA 实例 UUID。"""
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as err:
        raise DeviceError(f'无法读取 core.uuid：{err}') from err
    value = (data.get('data') or {}).get('uuid') if isinstance(data, dict) else None
    if not value:
        raise DeviceError('core.uuid 中没有 UUID，请确认 HomeAssistant 已正常启动')
    return str(value)


def device_key(uuid: str, salt: bytes) -> bytes:
    return hkdf_sha256(str(uuid).encode('utf-8'), salt, KEY_INFO)


def device_id(key: bytes) -> str:
    return hmac.new(key, ID_INFO, hashlib.sha256).hexdigest()[:16]


def _aad(envelope: dict) -> bytes:
    head = envelope['device']
    return json.dumps(
        [FORMAT, head['alg'], head['kdf'], head['salt'], envelope['created']],
        separators=(',', ':'), ensure_ascii=False,
    ).encode('utf-8')


def is_envelope(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and data.get('format') == FORMAT
        and isinstance(data.get('device'), dict)
        and isinstance(data.get('payload'), dict)
    )


def wrap(
    inner: dict, uuid: str, salt: bytes | None = None,
    created: str | None = None, previous: dict | None = None,
) -> dict:
    """包裹 inner；给 previous 时沿用它的 salt / created，只换随机 nonce。

    这样常规写入的设备指纹保持稳定；只有 recover 显式换 salt 才轮换。
    """
    if AESGCM is None:
        raise DeviceError('当前环境缺少 cryptography，无法启用设备层加密')
    if previous is not None and is_envelope(previous):
        if salt is None:
            salt = ub64(previous['device']['salt'])
        if created is None:
            created = str(previous.get('created') or '') or None
    salt = salt or os.urandom(SALT_LENGTH)
    key = device_key(uuid, salt)
    envelope = {
        'format': FORMAT,
        'device': {
            'alg': ALG,
            'kdf': KDF,
            'salt': b64(salt),
            'id': device_id(key),
        },
        'payload': {},
        'created': created or datetime.now(timezone.utc).isoformat(),
    }
    nonce = os.urandom(NONCE_LENGTH)
    plain = json.dumps(inner, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ct = AESGCM(key).encrypt(nonce, plain, _aad(envelope))
    envelope['payload'] = {'iv': b64(nonce), 'ct': b64(ct)}
    return envelope


def unwrap(envelope: dict, uuid: str) -> dict:
    if AESGCM is None:
        raise DeviceError('当前环境缺少 cryptography，无法解开设备层')
    try:
        head = envelope['device']
        key = device_key(uuid, ub64(head['salt']))
        if not hmac.compare_digest(device_id(key), str(head.get('id') or '')):
            raise DeviceError('设备指纹不匹配，密码库可能由另一台 HomeAssistant 的 UUID 包裹')
        nonce = ub64(envelope['payload']['iv'])
        ct = ub64(envelope['payload']['ct'])
        plain = AESGCM(key).decrypt(nonce, ct, _aad(envelope))
        inner = json.loads(plain.decode('utf-8'))
    except DeviceError:
        raise
    except (KeyError, TypeError, ValueError) as err:
        raise DeviceError(f'设备层数据损坏：{err}') from err
    except Exception as err:
        # cryptography 的 InvalidTag：uuid 不匹配或密文被篡改
        raise DeviceError('设备 UUID 不匹配或密码库已被篡改，请在面板中指定旧 UUID 恢复') from err
    if not isinstance(inner, dict):
        raise DeviceError('设备层内容格式无效')
    return inner


# ------------------------------------------------------------ 逐项（format 4）


def scope_aad(scope: str, device_id: str, ident: str = '') -> bytes:
    """逐项 envelope 的 AAD：绑定作用域、设备指纹与条目 id。

    id 必须参与 AAD：否则能写文件的人可以把 A 条的密文挪到 B 条的 id 下面，
    或用同一条密文伪造出多条记录，而前端无从察觉。绑定 device.id 则让密文
    无法在「不同 salt / 不同密码库文件」之间调包。
    """
    return json.dumps(
        [scope, device_id, ident], separators=(',', ':')
    ).encode('utf-8')


def seal(plain: dict, key: bytes, aad: bytes) -> dict:
    """用设备密钥加密一条记录，返回 {iv, ct}（每次随机 nonce）。"""
    if AESGCM is None:
        raise DeviceError('当前环境缺少 cryptography，无法启用设备层加密')
    nonce = os.urandom(NONCE_LENGTH)
    body = json.dumps(plain, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ct = AESGCM(key).encrypt(nonce, body, aad)
    return {'iv': b64(nonce), 'ct': b64(ct)}


def unseal(blob: Any, key: bytes, aad: bytes) -> dict:
    """解开一条记录；AAD 不符或密文被改动都会抛 DeviceError。"""
    if AESGCM is None:
        raise DeviceError('当前环境缺少 cryptography，无法解开设备层')
    if not isinstance(blob, dict):
        raise DeviceError('设备层条目格式无效')
    try:
        nonce = ub64(blob['iv'])
        ct = ub64(blob['ct'])
    except (KeyError, TypeError, ValueError) as err:
        raise DeviceError(f'设备层条目缺少 iv / ct：{err}') from err
    try:
        plain = json.loads(AESGCM(key).decrypt(nonce, ct, aad).decode('utf-8'))
    except ValueError as err:
        raise DeviceError(f'设备层条目内容损坏：{err}') from err
    except Exception as err:
        raise DeviceError('密文校验失败：数据已被篡改，或与当前设备密钥不匹配') from err
    if not isinstance(plain, dict):
        raise DeviceError('设备层条目内容格式无效')
    return plain
