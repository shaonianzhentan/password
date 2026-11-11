"""WebAuthn 服务端校验。

依赖 cbor2 解析 attestationObject / COSE 公钥，签名验证使用 HomeAssistant
自带的 cryptography。challenge 只保存在内存中，一次性消费且有过期时间。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import secrets
import struct
import threading
import time
from typing import Any

import cbor2
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa

CHALLENGE_TTL = 120
FLAG_UP = 0x01
FLAG_UV = 0x04
FLAG_AT = 0x40


class WebAuthnError(Exception):
    """WebAuthn 校验失败。"""


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
        obj = cbor2.loads(b64u_decode(attestation_object))
        auth_data = obj['authData']
    except Exception as err:
        raise WebAuthnError('attestationObject 解析失败') from err

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
        cose = cbor2.CBORDecoder(io.BytesIO(auth_data[offset:])).decode()
    except Exception as err:
        raise WebAuthnError('COSE 公钥解析失败') from err
    if not isinstance(cose, dict) or not cose.get(3):
        raise WebAuthnError('COSE 公钥无效')

    return {
        'credential_id': credential_id,
        'public_key': b64u(cbor2.dumps(cose)),
        'alg': cose[3],
        'sign_count': sign_count,
    }


def load_public_key(encoded: str):
    cose = cbor2.loads(b64u_decode(encoded))
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
