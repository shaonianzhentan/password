#!/usr/bin/env python3
"""把旧版「我的密码」数据转换为新版可导入的明文 JSON。

旧版数据位于 .storage/password.json，采用两层 3DES-CBC：
  1. item['key']  = Enc(server_key, HA_UUID).Encrypt(随机条目key)
  2. item['text'] = Enc(条目key, server_key).Encrypt(明文内容)
其中 server_key = md5(旧主密码)，同时作为前端的 passwordKey；
Enc(a, b) 的密钥材料为 md5(a)，IV 为 md5(b)[:11] + '='，
且旧实现把 hex 字符串当作 Base64 解码得到 24 字节密钥 / 8 字节 IV。

用法：
  py tools/convert_v1.py --storage /path/to/config/.storage --out password_export.json
  py tools/convert_v1.py --storage /path/to/config --password '旧主密码' --uuid '旧UUID'

--storage 可以是 HA 配置目录或其下的 .storage 目录。
脚本只读取旧文件，绝不修改或删除它们；输出为明文，用完请立即删除。
依赖：cryptography（HomeAssistant 自带；普通环境可 pip install cryptography）。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import uuid
from datetime import date
from pathlib import Path
from typing import Any

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, modes
    try:
        from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
    except ImportError:
        from cryptography.hazmat.primitives.ciphers.algorithms import TripleDES
except ImportError:
    print('缺少 cryptography，请先执行：pip install cryptography', file=sys.stderr)
    sys.exit(1)


def md5_hex(text: str) -> str:
    return hashlib.md5(text.encode('utf-8')).hexdigest()


def old_key_iv(key_material: str, iv_material: str) -> tuple[bytes, bytes]:
    """复现旧 EncryptHelper 的 key/iv 派生（hex 当 Base64 解码）。"""
    key = base64.b64decode(md5_hex(key_material))
    iv = base64.b64decode(md5_hex(iv_material)[:11] + '=')
    if len(key) != 24 or len(iv) != 8:
        raise ValueError('密钥派生长度异常')
    return key, iv


def decrypt_3des(key_material: str, iv_material: str, ciphertext: str) -> str:
    key, iv = old_key_iv(key_material, iv_material)
    raw = base64.b64decode(ciphertext)
    decryptor = Cipher(TripleDES(key), modes.CBC(iv)).decryptor()
    padded = decryptor.update(raw) + decryptor.finalize()
    if not padded:
        raise ValueError('解密结果为空')
    padding = padded[-1]
    if not 1 <= padding <= 8 or padded[-padding:] != bytes([padding]) * padding:
        raise ValueError('填充校验失败（密钥或 UUID 可能不正确）')
    return padded[:-padding].decode('utf-8')


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default
    except (ValueError, OSError) as err:
        raise ValueError(f'无法读取 {path}：{err}') from err


def resolve_storage(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if (path / '.storage').is_dir():
        return path / '.storage'
    return path


def resolve_server_key(storage: Path, password: str | None, server_key: str | None) -> str:
    if server_key:
        value = server_key.strip().lower()
    elif password:
        value = md5_hex(password)
    else:
        entries = read_json(storage / 'core.config_entries', {}) or {}
        value = ''
        for entry in entries.get('data', {}).get('entries', []):
            if entry.get('domain') == 'password':
                value = (entry.get('data') or {}).get('key', '')
                break
        if not value:
            raise ValueError('未找到旧密钥，请用 --password 或 --server-key 指定')
    if len(value) != 32 or any(char not in '0123456789abcdef' for char in value):
        raise ValueError('server_key 应为 32 位 md5 十六进制字符串')
    return value


def resolve_uuid(storage: Path, value: str | None) -> str:
    if value:
        return value.strip()
    result = read_json(storage / 'core.uuid', {}) or {}
    uuid_value = (result.get('data') or {}).get('uuid', '')
    if not uuid_value:
        raise ValueError('无法读取 core.uuid，请用 --uuid 指定旧 HomeAssistant 的 UUID')
    return uuid_value


def convert(storage: Path, server_key: str, old_uuid: str) -> tuple[list[dict], list[str]]:
    source = read_json(storage / 'password.json', None)
    if not isinstance(source, list):
        raise ValueError('password.json 不存在或不是数组')

    items: list[dict] = []
    failures: list[str] = []
    for index, entry in enumerate(source, start=1):
        try:
            plain_key = decrypt_3des(server_key, old_uuid, entry['key'])
            plain_text = decrypt_3des(plain_key, server_key, entry['text'])
            items.append({
                'id': str(uuid.uuid4()),
                'title': str(entry.get('title') or ''),
                'category': str(entry.get('category') or ''),
                'text': plain_text,
                'link': str(entry.get('link') or ''),
                'date': str(entry.get('date') or date.today().isoformat()),
            })
        except Exception as err:  # 单条失败不影响其余数据
            failures.append(f'第 {index} 条：{err}')
    return items, failures


def main() -> int:
    parser = argparse.ArgumentParser(description='旧版密码数据 → 新版明文 JSON')
    parser.add_argument('--storage', required=True, help='HA 配置目录或 .storage 目录')
    parser.add_argument('--password', help='旧主密码（自动做 md5）')
    parser.add_argument('--server-key', help='config entry 中的 md5 值，优先于 --password')
    parser.add_argument('--uuid', help='旧 HomeAssistant 的 UUID（.storage/core.uuid）')
    parser.add_argument('--out', default='password_export.json', help='输出文件')
    parser.add_argument('--force', action='store_true', help='允许覆盖已存在的输出文件')
    args = parser.parse_args()

    storage = resolve_storage(args.storage)
    output = Path(args.out).expanduser().resolve()
    if output.exists() and not args.force:
        print(f'输出文件已存在：{output}（如需覆盖请加 --force）', file=sys.stderr)
        return 1
    if output == storage / 'password.json':
        print('输出路径不能是旧数据文件', file=sys.stderr)
        return 1

    try:
        server_key = resolve_server_key(storage, args.password, args.server_key)
        old_uuid = resolve_uuid(storage, args.uuid)
        items, failures = convert(storage, server_key, old_uuid)
    except ValueError as err:
        print(f'转换失败：{err}', file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'读取：{storage / "password.json"}')
    print(f'输出：{output}')
    print(f'成功 {len(items)} 条，失败 {len(failures)} 条')
    for failure in failures:
        print(f'  - {failure}')
    if failures:
        print('失败项通常是密钥或 UUID 不匹配，请核对后重试；旧文件未被修改。')
    print('注意：输出文件是明文密码，请导入新版后立即删除。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
