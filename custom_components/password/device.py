"""设备层：用 HomeAssistant 的 core.uuid 把密码库整体包成加密 envelope。

磁盘格式（format 3）：
  { format: 3, device: { alg, kdf, salt, id }, payload: { iv, ct }, created }
  deviceKey = HKDF-SHA256(core.uuid, device.salt, "password/device/v1")
  payload.ct = AES-256-GCM(deviceKey, inner_json, aad=外层头字段)
  device.id  = HMAC(deviceKey, "password/device-id/v1")[:8].hex()，仅用于展示

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

FORMAT = 3
ALG = 'AES-256-GCM'
KDF = 'HKDF-SHA256'
KEY_INFO = b'password/device/v1'
ID_INFO = b'password/device-id/v1'
NONCE_LENGTH = 12
SALT_LENGTH = 16


class DeviceError(Exception):
    """设备层无法解开（UUID 不匹配、文件损坏或环境缺少依赖）。"""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')


def _ub64(value: Any) -> bytes:
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
            salt = _ub64(previous['device']['salt'])
        if created is None:
            created = str(previous.get('created') or '') or None
    salt = salt or os.urandom(SALT_LENGTH)
    key = device_key(uuid, salt)
    envelope = {
        'format': FORMAT,
        'device': {
            'alg': ALG,
            'kdf': KDF,
            'salt': _b64(salt),
            'id': device_id(key),
        },
        'payload': {},
        'created': created or datetime.now(timezone.utc).isoformat(),
    }
    nonce = os.urandom(NONCE_LENGTH)
    plain = json.dumps(inner, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ct = AESGCM(key).encrypt(nonce, plain, _aad(envelope))
    envelope['payload'] = {'iv': _b64(nonce), 'ct': _b64(ct)}
    return envelope


def unwrap(envelope: dict, uuid: str) -> dict:
    if AESGCM is None:
        raise DeviceError('当前环境缺少 cryptography，无法解开设备层')
    try:
        head = envelope['device']
        key = device_key(uuid, _ub64(head['salt']))
        if not hmac.compare_digest(device_id(key), str(head.get('id') or '')):
            raise DeviceError('设备指纹不匹配，密码库可能由另一台 HomeAssistant 的 UUID 包裹')
        nonce = _ub64(envelope['payload']['iv'])
        ct = _ub64(envelope['payload']['ct'])
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
