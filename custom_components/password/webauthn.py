"""WebAuthn 服务端校验。

使用标准库自带的精简 CBOR 编解码解析 attestationObject / COSE 公钥，
签名验证使用 HomeAssistant 自带的 cryptography，无第三方 pip 依赖。
challenge 只保存在内存中，一次性消费且有过期时间。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import struct
import threading
import time
from typing import Any, NamedTuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa

CHALLENGE_TTL = 120
FLAG_UP = 0x01
FLAG_UV = 0x04
FLAG_AT = 0x40


class WebAuthnError(Exception):
    """WebAuthn 校验失败。"""


class CBORError(WebAuthnError):
    """CBOR 数据不合法。"""


class CBORTag(NamedTuple):
    """CBOR 语义标签（major type 6）。"""

    tag: int
    value: Any


class CBORSimple(NamedTuple):
    """CBOR 简单值（major type 7，布尔/空值/浮点除外）。"""

    value: int


CBOR_UNDEFINED = object()
_MAX_CBOR_BYTES = 1 << 20
_MAX_CBOR_DEPTH = 16


def _cbor_arg(ai: int, data: bytes, pos: int) -> tuple[int | None, int]:
    """读取 initial byte 之后的附加参数，None 表示不定长编码。"""
    if ai < 24:
        return ai, pos
    sizes = {24: 1, 25: 2, 26: 4, 27: 8}
    if ai in sizes:
        size = sizes[ai]
        if pos + size > len(data):
            raise CBORError('CBOR 数据截断')
        return int.from_bytes(data[pos:pos + size], 'big'), pos + size
    if ai == 31:
        return None, pos
    raise CBORError('非法的 CBOR 附加信息')


def _cbor_head(mt: int, arg: int) -> bytes:
    """编码 initial byte 及附加参数，始终使用最短的定长形式。"""
    if arg < 0 or arg >= 1 << 64:
        raise CBORError('CBOR 数值超范围')
    if arg < 24:
        return bytes(((mt << 5) | arg,))
    for ai, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
        if arg < 1 << (8 * size):
            return bytes(((mt << 5) | ai,)) + arg.to_bytes(size, 'big')
    raise CBORError('CBOR 数值超范围')


def _cbor_string(
    mt: int, arg: int | None, data: bytes, pos: int
) -> tuple[bytes | str, int]:
    if arg is not None:
        if arg > len(data) - pos:
            raise CBORError('CBOR 字符串长度越界')
        raw = data[pos:pos + arg]
        pos += arg
    else:
        chunks = []
        while True:
            if pos >= len(data):
                raise CBORError('不定长 CBOR 字符串未结束')
            if data[pos] == 0xFF:
                pos += 1
                break
            if data[pos] >> 5 != mt:
                raise CBORError('不定长 CBOR 字符串分块类型不符')
            chunk_arg, pos = _cbor_arg(data[pos] & 0x1F, data, pos + 1)
            if chunk_arg is None or chunk_arg > len(data) - pos:
                raise CBORError('CBOR 字符串长度越界')
            chunks.append(data[pos:pos + chunk_arg])
            pos += chunk_arg
        raw = b''.join(chunks)
    if mt == 2:
        return raw, pos
    try:
        return raw.decode('utf-8'), pos
    except UnicodeDecodeError as err:
        raise CBORError('CBOR 文本不是合法 UTF-8') from err


def _cbor_item(data: bytes, pos: int, depth: int) -> tuple[Any, int]:
    """解码一个 CBOR 项，返回 (值, 结束偏移)；允许其后还有附加数据。"""
    if depth > _MAX_CBOR_DEPTH:
        raise CBORError('CBOR 嵌套过深')
    if pos >= len(data):
        raise CBORError('CBOR 数据截断')
    initial = data[pos]
    pos += 1
    mt, ai = initial >> 5, initial & 0x1F

    if mt == 7:
        if ai < 20:
            return CBORSimple(ai), pos
        if ai == 20:
            return False, pos
        if ai == 21:
            return True, pos
        if ai == 22:
            return None, pos
        if ai == 23:
            return CBOR_UNDEFINED, pos
        if ai == 24:
            if pos >= len(data):
                raise CBORError('CBOR 数据截断')
            value = data[pos]
            pos += 1
            if value < 32:
                raise CBORError('非法的 CBOR 简单值')
            return CBORSimple(value), pos
        if ai in (25, 26, 27):
            fmt = {25: '>e', 26: '>f', 27: '>d'}[ai]
            size = struct.calcsize(fmt)
            if pos + size > len(data):
                raise CBORError('CBOR 数据截断')
            return struct.unpack(fmt, data[pos:pos + size])[0], pos + size
        raise CBORError('非法的 CBOR 结束标记')

    arg, pos = _cbor_arg(ai, data, pos)
    if mt == 6:
        if arg is None:
            raise CBORError('不定长 CBOR 标签')
        value, pos = _cbor_item(data, pos, depth + 1)
        return CBORTag(arg, value), pos
    if mt == 0 or mt == 1:
        if arg is None:
            raise CBORError('不定长 CBOR 整数')
        return (arg if mt == 0 else -1 - arg), pos
    if mt == 2 or mt == 3:
        return _cbor_string(mt, arg, data, pos)
    if mt == 4 or mt == 5:
        remaining = arg
        if remaining is not None:
            minimum = 1 if mt == 4 else 2
            if remaining > (len(data) - pos) // minimum:
                raise CBORError('CBOR 容器长度越界')
        items: list[Any] = []
        while True:
            if remaining is None:
                if pos >= len(data):
                    raise CBORError('不定长 CBOR 容器未结束')
                if data[pos] == 0xFF:
                    pos += 1
                    break
            elif remaining == 0:
                break
            else:
                remaining -= 1
            item, pos = _cbor_item(data, pos, depth + 1)
            if mt == 5:
                value, pos = _cbor_item(data, pos, depth + 1)
                items.append((item, value))
            else:
                items.append(item)
        if mt == 4:
            return items, pos
        result: dict[Any, Any] = {}
        for key, value in items:
            try:
                result[key] = value
            except TypeError as err:
                raise CBORError('CBOR map 键类型不支持') from err
        return result, pos
    raise CBORError('未知的 CBOR 类型')


def cbor_decode_one(data: bytes, pos: int = 0) -> tuple[Any, int]:
    """解码一段字节中的第一个 CBOR 项，用于解析 authData 内嵌的 COSE 公钥。"""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise CBORError('CBOR 数据类型错误')
    data = bytes(data)
    if len(data) > _MAX_CBOR_BYTES:
        raise CBORError('CBOR 数据过大')
    return _cbor_item(data, pos, 0)


def cbor_loads(data: bytes) -> Any:
    """解码完整的一段 CBOR 数据。"""
    value, pos = cbor_decode_one(data)
    if pos != len(data):
        raise CBORError('CBOR 数据存在多余字节')
    return value


def cbor_dumps(value: Any, depth: int = 0) -> bytes:
    """编码 Python 值为 CBOR；只需覆盖 WebAuthn/COSE 使用到的类型。"""
    if depth > _MAX_CBOR_DEPTH:
        raise CBORError('CBOR 嵌套过深')
    if value is None:
        return b'\xf6'
    if value is CBOR_UNDEFINED:
        return b'\xf7'
    if value is False:
        return b'\xf4'
    if value is True:
        return b'\xf5'
    if isinstance(value, int):
        return _cbor_head(0, value) if value >= 0 else _cbor_head(1, -1 - value)
    if isinstance(value, float):
        return b'\xfb' + struct.pack('>d', value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return _cbor_head(2, len(raw)) + raw
    if isinstance(value, str):
        raw = value.encode('utf-8')
        return _cbor_head(3, len(raw)) + raw
    if isinstance(value, CBORTag):
        return _cbor_head(6, value.tag) + cbor_dumps(value.value, depth + 1)
    if isinstance(value, CBORSimple):
        if 0 <= value.value < 24:
            return bytes((0xe0 | value.value,))
        if 32 <= value.value <= 255:
            return b'\xf8' + bytes((value.value,))
        raise CBORError('非法的 CBOR 简单值')
    if isinstance(value, (list, tuple)):
        return _cbor_head(4, len(value)) + b''.join(
            cbor_dumps(item, depth + 1) for item in value
        )
    if isinstance(value, dict):
        return _cbor_head(5, len(value)) + b''.join(
            cbor_dumps(key, depth + 1) + cbor_dumps(item, depth + 1)
            for key, item in value.items()
        )
    raise CBORError(f'不支持的 CBOR 类型：{type(value).__name__}')


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def b64u_decode(value: str) -> bytes:
    if not isinstance(value, str):
        raise WebAuthnError('编码错误')
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def rp_id_from_host(host: str) -> str:
    if host.startswith('['):
        end = host.find(']')
        return host[1:end] if end > 0 else host
    return host.split(':')[0]


def allowed_origins(host: str) -> set[str]:
    return {f'https://{host}', f'http://{host}'}


class ChallengeStore:
    """一次性 challenge，绑定操作类型、HA 用户与访问域名。"""

    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def _purge(self) -> None:
        now = time.time()
        for key in [k for k, v in self._items.items() if v['expires'] <= now]:
            self._items.pop(key, None)

    def create(self, kind: str, user_id: str, host: str) -> str:
        with self._lock:
            self._purge()
            challenge = b64u(secrets.token_bytes(32))
            self._items[challenge] = {
                'kind': kind,
                'user_id': user_id,
                'host': host,
                'expires': time.time() + CHALLENGE_TTL,
            }
        return challenge

    def consume(self, challenge: str, kind: str, user_id: str, host: str) -> bool:
        with self._lock:
            self._purge()
            item = self._items.pop(challenge, None)
        if not item:
            return False
        return (
            item['kind'] == kind
            and item['user_id'] == user_id
            and item['host'] == host
            and item['expires'] > time.time()
        )


challenges = ChallengeStore()


def parse_client_data(
    encoded: str, expected_type: str, challenge: str, host: str
) -> bytes:
    raw = b64u_decode(encoded)
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as err:
        raise WebAuthnError('clientDataJSON 无效') from err
    if data.get('type') != expected_type:
        raise WebAuthnError('认证数据类型错误')
    if not hmac.compare_digest(str(data.get('challenge', '')), challenge):
        raise WebAuthnError('challenge 不匹配')
    if data.get('origin') not in allowed_origins(host):
        raise WebAuthnError('来源域名不匹配')
    return raw


def parse_auth_data(auth_data: bytes, rp_id: str) -> tuple[int, int]:
    if len(auth_data) < 37:
        raise WebAuthnError('authenticatorData 过短')
    expected = hashlib.sha256(rp_id.encode('utf-8')).digest()
    if not hmac.compare_digest(auth_data[:32], expected):
        raise WebAuthnError('RP ID 不匹配')
    flags = auth_data[32]
    if not flags & FLAG_UP:
        raise WebAuthnError('缺少用户 presence 验证')
    if not flags & FLAG_UV:
        raise WebAuthnError('缺少用户身份验证（指纹/PIN）')
    return flags, struct.unpack('>I', auth_data[33:37])[0]


def parse_registration(
    attestation_object: str, credential_id: str, rp_id: str
) -> dict[str, Any]:
    """从 attestationObject 提取凭据 ID、COSE 公钥与签名计数。"""
    try:
        obj = cbor_loads(b64u_decode(attestation_object))
        auth_data = obj['authData']
    except Exception as err:
        raise WebAuthnError(f'attestationObject 解析失败：{err}') from err

    if not isinstance(auth_data, bytes):
        raise WebAuthnError('authData 无效')
    flags, sign_count = parse_auth_data(auth_data, rp_id)
    if not flags & FLAG_AT:
        raise WebAuthnError('缺少 attestedCredentialData')

    if len(auth_data) < 55:
        raise WebAuthnError('attestedCredentialData 过短')
    cred_len = struct.unpack('>H', auth_data[53:55])[0]
    offset = 55 + cred_len
    if len(auth_data) <= offset:
        raise WebAuthnError('缺少 COSE 公钥')
    if not hmac.compare_digest(auth_data[55:offset], b64u_decode(credential_id)):
        raise WebAuthnError('凭据 ID 不匹配')

    try:
        cose, _ = cbor_decode_one(auth_data[offset:])
    except Exception as err:
        raise WebAuthnError(f'COSE 公钥解析失败：{err}') from err
    if not isinstance(cose, dict) or not cose.get(3):
        raise WebAuthnError('COSE 公钥无效')

    return {
        'credential_id': credential_id,
        'public_key': b64u(cbor_dumps(cose)),
        'alg': cose[3],
        'sign_count': sign_count,
    }


def load_public_key(encoded: str):
    cose = cbor_loads(b64u_decode(encoded))
    if not isinstance(cose, dict):
        raise WebAuthnError('公钥格式无效')
    kty = cose.get(1)
    if kty == 2:
        crv = cose.get(-1)
        curves = {1: ec.SECP256R1, 2: ec.SECP384R1, 3: ec.SECP521R1}
        if crv not in curves:
            raise WebAuthnError('不支持的椭圆曲线')
        numbers = ec.EllipticCurvePublicNumbers(
            int.from_bytes(cose[-2], 'big'),
            int.from_bytes(cose[-3], 'big'),
            curves[crv](),
        )
        return numbers.public_key()
    if kty == 3:
        numbers = rsa.RSAPublicNumbers(
            int.from_bytes(cose[-2], 'big'),
            int.from_bytes(cose[-1], 'big'),
        )
        return numbers.public_key()
    if kty == 1:
        return ed25519.Ed25519PublicKey.from_public_bytes(cose[-2])
    raise WebAuthnError('不支持的公钥类型')


def verify_signature(public_key, alg: int, signed: bytes, signature: bytes) -> None:
    try:
        if alg == -7:
            public_key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
        elif alg == -257:
            public_key.verify(signature, signed, padding.PKCS1v15(), hashes.SHA256())
        elif alg == -8:
            public_key.verify(signature, signed)
        else:
            raise WebAuthnError('不支持的签名算法')
    except InvalidSignature as err:
        raise WebAuthnError('签名验证失败') from err


def verify_assertion(
    credential: dict, response: dict, challenge: str, host: str
) -> int:
    """校验断言，返回新的签名计数。"""
    client_bytes = parse_client_data(
        response['clientDataJSON'], 'webauthn.get', challenge, host
    )
    auth_data = b64u_decode(response['authenticatorData'])
    _, sign_count = parse_auth_data(auth_data, rp_id_from_host(host))
    signed = auth_data + hashlib.sha256(client_bytes).digest()
    signature = b64u_decode(response['signature'])
    verify_signature(
        load_public_key(credential['public_key']),
        credential['alg'],
        signed,
        signature,
    )
    stored = credential.get('sign_count') or 0
    if stored and sign_count and sign_count <= stored:
        raise WebAuthnError('认证器计数器异常，凭据可能被复制')
    return sign_count
