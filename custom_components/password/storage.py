"""密码库与 WebAuthn 凭据的本地存储（设备层 envelope）。

磁盘上的 password_vault.json / password_webauthn.json 都是 device.wrap
生成的 format 3 envelope，服务端读写时自动包裹/解开；内存里流转的仍是
前端可见的 format 2 密码库（inner），因此前端数据契约不变。

兼容升级：读到裸 format 2 文件时原样返回，下一次写入自动包成 envelope
（懒迁移），无需主密码参与。所有同步 IO 都由调用方通过
hass.async_add_executor_job 执行。
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from . import device

VAULT_FILE = 'password_vault.json'
CREDENTIALS_FILE = 'password_webauthn.json'
STORAGE_DIR = '.storage'


class VaultStorage:

    def __init__(self, hass) -> None:
        self._dir = Path(hass.config.path(STORAGE_DIR))
        self._uuid_path = Path(hass.config.path(STORAGE_DIR, 'core.uuid'))
        self._lock = threading.Lock()

    def _path(self, name: str) -> Path:
        return self._dir / name

    def _read(self, name: str, default: Any) -> Any:
        path = self._path(name)
        try:
            with path.open('r', encoding='utf-8') as file:
                return json.load(file)
        except FileNotFoundError:
            return default
        except (ValueError, OSError):
            return default

    def _write(self, name: str, data: Any) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._path(name)
        tmp = path.with_name(path.name + '.tmp')
        with tmp.open('w', encoding='utf-8') as file:
            json.dump(data, file, ensure_ascii=False, separators=(',', ':'))
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp, path)

    def current_uuid(self) -> str:
        return device.read_uuid(self._uuid_path)

    def _seal(self, name: str, inner: dict, uuid: str) -> dict:
        return device.wrap(inner, uuid, previous=self._read(name, None))

    def load_vault(self) -> dict | None:
        with self._lock:
            data = self._read(VAULT_FILE, None)
        if not isinstance(data, dict):
            return None
        if device.is_envelope(data):
            return device.unwrap(data, self.current_uuid())
        return data

    def save_vault(self, vault: dict) -> None:
        with self._lock:
            self._write(VAULT_FILE, self._seal(VAULT_FILE, vault, self.current_uuid()))

    def load_credentials(self) -> dict:
        with self._lock:
            data = self._read(CREDENTIALS_FILE, None)
        if device.is_envelope(data):
            data = device.unwrap(data, self.current_uuid())
        if not isinstance(data, dict) or not isinstance(data.get('credentials'), list):
            return {'version': 2, 'credentials': []}
        return data

    def save_credentials(self, data: dict) -> None:
        with self._lock:
            self._write(
                CREDENTIALS_FILE,
                self._seal(CREDENTIALS_FILE, data, self.current_uuid()),
            )

    def device_info(self) -> dict:
        """给面板展示：当前 UUID、当前密码库的设备指纹、是否已有设备层。"""
        with self._lock:
            data = self._read(VAULT_FILE, None)
        try:
            uuid = self.current_uuid()
        except device.DeviceError:
            uuid = ''
        envelope = data if device.is_envelope(data) else None
        return {
            'uuid': uuid,
            'id': str(envelope['device'].get('id') or '') if envelope else '',
            'wrapped': envelope is not None,
        }

    @staticmethod
    def _unwrap_any(envelope: dict, old_uuid: str, current_uuid: str) -> dict:
        """优先用旧 UUID 解，失败再试当前 UUID（部分文件可能已重绑过）。"""
        try:
            return device.unwrap(envelope, old_uuid)
        except device.DeviceError:
            if old_uuid == current_uuid:
                raise
            return device.unwrap(envelope, current_uuid)

    def recover(self, old_uuid: str) -> dict:
        """用旧 UUID 解开全部 envelope，再用当前 UUID 重新包裹。

        GCM tag 校验本身就是「旧 UUID 正确」的证明，因此不需要主密码或
        unlockProof，避免「解不开外层 → 无法解锁 → 拿不到解锁证明」的死锁。
        """
        current = self.current_uuid()
        done = {'vault': False, 'credentials': False}
        with self._lock:
            for name, key in ((VAULT_FILE, 'vault'), (CREDENTIALS_FILE, 'credentials')):
                data = self._read(name, None)
                if not isinstance(data, dict):
                    continue
                wrapped = device.is_envelope(data)
                created = str(data.get('created') or '') or None if wrapped else None
                inner = self._unwrap_any(data, old_uuid, current) if wrapped else data
                # 重新绑定时显式轮换 salt，让设备指纹随新 UUID 更新
                self._write(name, device.wrap(
                    inner, current,
                    salt=os.urandom(device.SALT_LENGTH), created=created,
                ))
                done[key] = True
        return done
