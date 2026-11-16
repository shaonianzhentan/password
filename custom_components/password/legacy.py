"""旧版（main 分支）密码文件的解密与格式转换。

旧版数据位于 .storage/password.json，是一个数组，每项：
  key    = 3DES(md5(旧主密码), 旧 HA UUID) 加密的条目随机 key
  text   = 3DES(条目 key, md5(旧主密码)) 加密的密码正文
  title / category / link / date 为明文元数据

旧实现的密钥派生把 md5 的十六进制字符串当作 Base64 解码，得到 24 字节
密钥与 8 字节 IV（见 main 分支 EncryptHelper.py / EncryptHelper.js）。

本模块只做内存转换：不读写密码库、不记录日志、不落盘明文。解密结果经已
鉴权的 websocket 返回给已解锁的前端，由前端逐条 AES-GCM 加密后写入新库。
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, modes
    try:
        from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
    except ImportError:
        from cryptography.hazmat.primitives.ciphers.algorithms import TripleDES
except ImportError:  # 不因缺少依赖导致整个集成加载失败
    Cipher = None
    modes = None
    TripleDES = None

MAX_ENTRIES = 10000
_HEX32 = re.compile(r'^[0-9a-fA-F]{32}$')


class LegacyError(Exception):
    """旧版数据无法解析或解密（错误信息中不包含任何明文）。"""


def md5_hex(value: str) -> str:
    return hashlib.md5(value.encode('utf-8')).hexdigest()


def server_key_from_secret(secret: Any) -> str:
    """接收旧主密码明文，或旧 config entry 里保存的 32 位 md5 密钥。"""
    value = str(secret or '').strip()
    if not value:
        raise LegacyError('请输入旧主密码或 32 位密钥')
    return value.lower() if _HEX32.match(value) else md5_hex(value)


def read_uuid(path: str | Path) -> str:
    """从 .storage/core.uuid 读取 HA 实例 UUID（旧版 IV 的材料）。"""
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as err:
        raise LegacyError(f'无法读取 core.uuid：{err}') from err
    value = (data.get('data') or {}).get('uuid') if isinstance(data, dict) else None
    if not value:
        raise LegacyError('core.uuid 中没有 UUID，请手动填写旧 HomeAssistant 的 UUID')
    return str(value)


def _key_iv(key_material: str, iv_material: str) -> tuple[bytes, bytes]:
    key = base64.b64decode(md5_hex(key_material))
    iv = base64.b64decode(md5_hex(iv_material)[:11] + '=')
    if len(key) != 24 or len(iv) != 8:
        raise LegacyError('密钥派生长度异常')
    return key, iv


def decrypt_3des(key_material: str, iv_material: str, ciphertext: str) -> str:
    if Cipher is None:
        raise LegacyError('当前环境缺少 cryptography，无法解密旧版 3DES 数据')
    key, iv = _key_iv(key_material, iv_material)
    try:
        raw = base64.b64decode(str(ciphertext or ''))
    except (ValueError, TypeError) as err:
        raise LegacyError(f'密文不是合法的 Base64：{err}') from err
    try:
        decryptor = Cipher(TripleDES(key), modes.CBC(iv)).decryptor()
        padded = decryptor.update(raw) + decryptor.finalize()
    except Exception as err:
        raise LegacyError('3DES 解密失败，请核对旧主密码与 UUID') from err
    if not padded:
        raise LegacyError('解密结果为空，请核对旧主密码与 UUID')
    padding = padded[-1]
    if not 1 <= padding <= 8 or padded[-padding:] != bytes([padding]) * padding:
        raise LegacyError('填充校验失败，旧主密码或 UUID 不正确')
    try:
        return padded[:-padding].decode('utf-8')
    except UnicodeDecodeError as err:
        raise LegacyError('解密结果不是 UTF-8 文本，旧主密码或 UUID 不正确') from err


def parse_entries(content: str) -> list[Any]:
    """解析旧版 password.json 的文本内容（也兼容 {data:[]} / {items:[]}）。"""
    try:
        data = json.loads(content)
    except (ValueError, TypeError) as err:
        raise LegacyError(f'文件不是合法的 JSON：{err}') from err
    if isinstance(data, list):
        entries = data
    elif isinstance(data, dict):
        entries = data.get('data') if isinstance(data.get('data'), list) else data.get('items')
    else:
        entries = None
    if not isinstance(entries, list):
        raise LegacyError('旧版密码文件应为条目数组')
    if len(entries) > MAX_ENTRIES:
        raise LegacyError(f'条目超过 {MAX_ENTRIES} 条上限')
    return entries


def _iso_date(value: Any) -> str:
    raw = str(value or '').strip()
    try:
        moment = datetime.strptime(raw, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except ValueError:
        moment = datetime.now(timezone.utc)
    return moment.isoformat().replace('+00:00', 'Z')


def convert_entries(
    entries: list[Any], server_key: str, old_uuid: str
) -> tuple[list[dict], list[str]]:
    """逐条解密并转换为新版 format 2 的明文字段；单条失败不影响其余数据。

    旧版 title → notes（列表显示名）、text → password（加密字段）、
    link → origins、date → updatedAt；用户名 / TOTP 旧版不存在，留空。
    """
    items: list[dict] = []
    failures: list[str] = []
    for index, entry in enumerate(entries, start=1):
        try:
            if not isinstance(entry, dict):
                raise LegacyError('条目格式错误')
            plain_key = decrypt_3des(server_key, old_uuid, entry.get('key') or '')
            plain_text = decrypt_3des(plain_key, server_key, entry.get('text') or '')
            link = str(entry.get('link') or '').strip()
            items.append({
                'id': str(uuid.uuid4()),
                'type': 'login',
                'category': str(entry.get('category') or ''),
                'notes': str(entry.get('title') or ''),
                'origins': [link] if link else [],
                'username': '',
                'password': plain_text,
                'totp': '',
                'updatedAt': _iso_date(entry.get('date')),
            })
        except (LegacyError, TypeError, ValueError) as err:
            failures.append(f'第 {index} 条：{err}')
    return items, failures
