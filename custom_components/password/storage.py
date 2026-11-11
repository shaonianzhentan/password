"""密码库与 WebAuthn 凭据的本地存储。

使用标准库做原子写，避免依赖 HomeAssistant 内部 JSON helper；
所有同步 IO 都由调用方通过 hass.async_add_executor_job 执行。
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

VAULT_FILE = 'password_vault.json'
CREDENTIALS_FILE = 'password_webauthn.json'
STORAGE_DIR = '.storage'


class VaultStorage:

    def __init__(self, hass) -> None:
        self._dir = Path(hass.config.path(STORAGE_DIR))
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

    def load_vault(self) -> dict | None:
        with self._lock:
            data = self._read(VAULT_FILE, None)
        return data if isinstance(data, dict) else None

    def save_vault(self, vault: dict) -> None:
        with self._lock:
            self._write(VAULT_FILE, vault)

    def load_credentials(self) -> dict:
        with self._lock:
            data = self._read(CREDENTIALS_FILE, None)
        if not isinstance(data, dict) or not isinstance(data.get('credentials'), list):
            return {'version': 2, 'credentials': []}
        return data

    def save_credentials(self, data: dict) -> None:
        with self._lock:
            self._write(CREDENTIALS_FILE, data)
