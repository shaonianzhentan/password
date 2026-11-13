#!/usr/bin/env python3
"""把旧版「我的密码」数据转换为新版可直接导入的明文 JSON。

旧版数据位于 .storage/password.json，采用两层 3DES-CBC：
  1. item['key']  = Enc(server_key, HA_UUID).Encrypt(随机条目key)
  2. item['text'] = Enc(条目key, server_key).Encrypt(明文内容)
其中 server_key = md5(旧主密码)，同时作为前端的 passwordKey；
Enc(a, b) 的密钥材料为 md5(a)，IV 为 md5(b)[:11] + '='，
且旧实现把 hex 字符串当作 Base64 解码得到 24 字节密钥 / 8 字节 IV。

解密与字段映射复用 custom_components/password/legacy.py（与面板
「导入历史数据」完全同一套实现），输出格式与「导出备份」一致：
  title→notes、text→password、link→origins、date→updatedAt，
可直接用面板的「导入备份」导入，无需再手动整理字段。

用法：
  py tools/convert_v1.py --storage /path/to/config/.storage --out password_export.json
  py tools/convert_v1.py --storage /path/to/config --password '旧主密码' --uuid '旧UUID'

--storage 可以是 HA 配置目录或其下的 .storage 目录。
脚本只读取旧文件，绝不修改或删除它们；输出为明文，用完请立即删除。
依赖：cryptography（HomeAssistant 自带；普通环境可 pip install cryptography）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'custom_components' / 'password'))
import legacy  # noqa: E402  与集成共用同一份解密实现


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
        value = legacy.server_key_from_secret(server_key)
    elif password:
        value = legacy.md5_hex(password)
    else:
        entries = read_json(storage / 'core.config_entries', {}) or {}
        value = ''
        for entry in entries.get('data', {}).get('entries', []):
            if entry.get('domain') == 'password':
                value = (entry.get('data') or {}).get('key', '')
                break
        if not value:
            raise ValueError('未找到旧密钥，请用 --password 或 --server-key 指定')
        value = legacy.server_key_from_secret(value)
    if len(value) != 32 or any(char not in '0123456789abcdef' for char in value):
        raise ValueError('server_key 应为 32 位 md5 十六进制字符串')
    return value


def resolve_uuid(storage: Path, value: str | None) -> str:
    if value:
        return value.strip()
    return legacy.read_uuid(storage / 'core.uuid')


def convert(storage: Path, server_key: str, old_uuid: str) -> tuple[list[dict], list[str]]:
    source = read_json(storage / 'password.json', None)
    if not isinstance(source, list):
        raise ValueError('password.json 不存在或不是数组')
    return legacy.convert_entries(source, server_key, old_uuid)


def main() -> int:
    parser = argparse.ArgumentParser(description='旧版密码数据 → 新版可导入的明文 JSON')
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
    except (ValueError, legacy.LegacyError) as err:
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
    print('注意：输出文件是明文密码，请在面板「导入备份」导入后立即删除。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
