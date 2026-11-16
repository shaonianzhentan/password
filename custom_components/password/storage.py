"""密码库与 WebAuthn 凭据的本地存储。

password_vault.json（format 4，逐条 envelope）：
  {
    format: 4,
    device: { alg, kdf, salt, id },             # 文件级设备密钥头
    created: '...',
    keys:   { iv, ct },                         # 只包一份：kdf / verifier / wrapped / keysRevision
    payload: [ { id, iv, ct }, ... ],           # 每条记录一份独立 envelope
    revision: 12
  }

  deviceKey = HKDF-SHA256(core.uuid, device.salt, "password/device/v1")
  AAD(keys) = ["password/keys/v1", device.id]
  AAD(item) = ["password/item/v1", device.id, item.id]

payload 是数组的意义在于**寻址**：服务端只认明文的 id，就能单条新增、编辑、
删除不同记录，两条记录的写入互不覆盖；改一条只重算一条，删一条不必解开任何
条目密文（只比明文 id）。只拷走密码库文件的人看到的仍然只有「条目数 + 随机
id」，分类 / 域名 / 备注 / 时间都在 envelope 里，与旧版整块包裹的安全等级一致。

兼容：读到旧的 format 3 整块 envelope、或裸 format 2 时自动拆成 format 4
（懒迁移，不需要主密码），迁移前原文另存 password_vault.json.v3.bak。
password_webauthn.json 仍是整块 envelope（凭据不需要逐条寻址）。

并发：所有「读 → 改 → 写」都收在一次方法调用里并持有同一把锁，调用方必须把
整个方法交给 hass.async_add_executor_job 执行（一次调用 = 一个 executor job），
服务端因此是串行提交的，不存在「两个请求都通过 revision 校验再互相覆盖」的窗口。
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import threading
import uuid as uuidlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import device

_LOGGER = logging.getLogger(__name__)

VAULT_FILE = 'password_vault.json'
CREDENTIALS_FILE = 'password_webauthn.json'
STORAGE_DIR = '.storage'
BACKUP_SUFFIX = '.v3.bak'
FORMAT = device.VAULT_FORMAT
# 一条记录在 envelope 里保存的字段（id 在外面明文保存，用于寻址）
ITEM_FIELDS = ('type', 'category', 'origins', 'notes', 'updatedAt', 'enc')
MAX_ITEMS = 10000


class VaultError(Exception):
    """可预期的业务错误，由 websocket 层映射成对应错误码。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def proof_ok(verifier: str, proof: Any) -> bool:
    """解锁证明比对：verifier = HMAC(vaultKey, 'password/unlock/v1')。"""
    return bool(verifier) and isinstance(proof, str) and hmac.compare_digest(proof, verifier)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class VaultStorage:

    def __init__(self, hass) -> None:
        self._dir = Path(hass.config.path(STORAGE_DIR))
        self._uuid_path = Path(hass.config.path(STORAGE_DIR, 'core.uuid'))
        # RLock：公开方法持锁，内部迁移 / 重建会在同一线程内再次进入
        self._lock = threading.RLock()

    # ---------------------------------------------------------------- 基础 IO

    def _path(self, name: str) -> Path:
        return self._dir / name

    def _read(self, name: str, default: Any, strict: bool = False) -> Any:
        path = self._path(name)
        try:
            with path.open('r', encoding='utf-8') as file:
                return json.load(file)
        except FileNotFoundError:
            return default
        except (ValueError, OSError) as err:
            if strict:
                # 文件存在但读不出来：绝不能当成「还没有密码库」，否则前端
                # 会进入建库流程把这个文件覆盖掉。
                raise VaultError('invalid_format', f'密码库文件无法读取：{err}') from err
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

    def _backup(self, name: str) -> None:
        """迁移前把旧文件原样另存一份（本身是密文，留着无妨）。"""
        path = self._path(name)
        target = path.with_name(path.name + BACKUP_SUFFIX)
        if target.exists():
            return
        try:
            target.write_bytes(path.read_bytes())
        except OSError as err:
            _LOGGER.warning('写入迁移备份失败：%s', err)

    def current_uuid(self) -> str:
        return device.read_uuid(self._uuid_path)

    # ------------------------------------------------------------ 设备密钥

    @staticmethod
    def _key(doc: dict, uuid: str) -> bytes:
        """按文件头派生的设备密钥，并用 device.id 复核 UUID 是否正确。"""
        head = doc.get('device')
        if not isinstance(head, dict):
            raise VaultError('invalid_format', '密码库缺少设备层头部')
        try:
            salt = device.ub64(head['salt'])
            claimed = str(head.get('id') or '')
        except (KeyError, TypeError, ValueError) as err:
            raise VaultError('invalid_format', f'设备层头部无效：{err}') from err
        key = device.device_key(uuid, salt)
        if not hmac.compare_digest(device.device_id(key), claimed):
            raise device.DeviceError(
                '设备指纹不匹配，密码库可能由另一台 HomeAssistant 的 UUID 包裹'
            )
        return key

    def _open_header(self, doc: dict, uuid: str) -> tuple[bytes, dict, str]:
        """解开 keys，返回 (deviceKey, keys, deviceId)。不碰任何条目。"""
        key = self._key(doc, uuid)
        did = str((doc.get('device') or {}).get('id') or '')
        try:
            keys = device.unseal(
                doc.get('keys'), key, device.scope_aad(device.KEYS_SCOPE, did)
            )
        except device.DeviceError as err:
            raise VaultError('invalid_format', f'密码库头部无法解开：{err}') from err
        if not isinstance(keys.get('kdf'), dict) or not isinstance(keys.get('wrapped'), dict):
            raise VaultError('invalid_format', '密码库头部缺少 kdf / wrapped')
        return key, keys, did

    def _read_items(self, doc: dict, key: bytes, did: str) -> list[dict]:
        items = []
        for entry in doc.get('payload') or []:
            ident = str(entry.get('id') or '') if isinstance(entry, dict) else ''
            try:
                plain = device.unseal(
                    entry, key, device.scope_aad(device.ITEM_SCOPE, did, ident)
                )
            except device.DeviceError as err:
                # 单条坏掉不影响其余记录：数据仍在文件里，只是这一条跳过了
                _LOGGER.warning('条目 %s 无法解开：%s', ident or '(无 id)', err)
                continue
            items.append({'id': ident, **{field: plain.get(field) for field in ITEM_FIELDS}})
        return items

    def _read_entry(self, entry: dict, key: bytes, did: str, ident: str) -> dict | None:
        try:
            plain = device.unseal(
                entry, key, device.scope_aad(device.ITEM_SCOPE, did, ident)
            )
        except device.DeviceError:
            return None
        return {'id': ident, **{field: plain.get(field) for field in ITEM_FIELDS}}

    # ------------------------------------------------------------- 文件装载

    def _doc(self, uuid: str | None = None) -> dict | None:
        """读出 format 4 文档；旧格式就地迁移。"""
        data = self._read(VAULT_FILE, None, strict=True)
        if data is None:
            return None
        if not isinstance(data, dict) or not data:
            raise VaultError('invalid_format', '密码库文件格式无效')
        if data.get('format') == FORMAT:
            return data
        return self._migrate(data, uuid or self.current_uuid())

    def _migrate(self, data: dict, uuid: str) -> dict:
        doc = self._from_legacy(data, uuid, uuid)
        with self._lock:
            self._backup(VAULT_FILE)
            self._write(VAULT_FILE, doc)
        _LOGGER.info('密码库已从旧格式迁移为逐条 envelope（format %s）', FORMAT)
        return doc

    def _from_legacy(self, data: dict, source_uuid: str, target_uuid: str) -> dict:
        """把 format 3 整块 / 裸 format 2 拆成 format 4，全程不需要主密码。"""
        old_salt = None
        if device.is_envelope(data):
            inner = device.unwrap(data, source_uuid)
            try:
                old_salt = device.ub64((data.get('device') or {}).get('salt'))
            except (TypeError, ValueError):
                old_salt = None
            created = str(data.get('created') or '') or None
        elif data.get('format') == 2:
            # 裸 format 2：旧版「懒迁移」遗留的文件，没有任何设备层
            inner = data
            created = str(inner.get('updated') or '') or None
        else:
            raise VaultError('invalid_format', '密码库格式无法识别，本版本只支持 format 4 / 3 / 2')

        if not isinstance(inner, dict) or inner.get('format') != 2:
            raise VaultError(
                'invalid_format',
                '密码库内层不是 format 2，本版本不提供迁移；请先备份，再删除 '
                '.storage/password_vault.json 后重新打开面板建库',
            )

        # 同一台机器上迁移：沿用旧 salt，设备指纹保持不变；换机器重绑才轮换
        salt = old_salt if (source_uuid == target_uuid and old_salt) else os.urandom(
            device.SALT_LENGTH
        )
        key = device.device_key(str(target_uuid), salt)
        did = device.device_id(key)

        payload = []
        for item in inner.get('items') or []:
            if not isinstance(item, dict):
                continue
            ident = str(item.get('id') or '') or str(uuidlib.uuid4())
            plain = self._plain_from_item(item, str(item.get('updatedAt') or ''))
            if not isinstance(plain['enc'].get('ct'), str) or not plain['enc']['ct']:
                _LOGGER.warning('迁移时跳过缺少密文的条目 %s', ident)
                continue
            payload.append({
                'id': ident,
                **device.seal(plain, key, device.scope_aad(device.ITEM_SCOPE, did, ident)),
            })

        keys_plain = {
            'format': 2,
            'kdf': inner.get('kdf') or {},
            'verifier': str(inner.get('verifier') or ''),
            'wrapped': inner.get('wrapped') or {},
            'keysRevision': 1,
        }
        return {
            'format': FORMAT,
            'device': {
                'alg': device.ALG,
                'kdf': device.KDF,
                'salt': device.b64(salt),
                'id': did,
            },
            'created': created or now_iso(),
            'keys': device.seal(
                keys_plain, key, device.scope_aad(device.KEYS_SCOPE, did)
            ),
            'payload': payload,
            'revision': int(inner.get('revision') or 0),
        }

    # ------------------------------------------------------------- 对外读取

    def read_state(self) -> dict:
        """面板读全量：头部参数 + 全部条目明文元数据 + revision。"""
        with self._lock:
            uuid = self.current_uuid()
            doc = self._doc(uuid)
            if doc is None:
                return {
                    'exists': False, 'kdf': None, 'wrapped': None,
                    'keysRevision': 0, 'items': [], 'revision': 0,
                }
            key, keys, did = self._open_header(doc, uuid)
            items = self._read_items(doc, key, did)
        return {
            'exists': True,
            'kdf': keys.get('kdf') or {},
            'wrapped': keys.get('wrapped') or {},
            'keysRevision': int(keys.get('keysRevision') or 0),
            'items': items,
            'revision': int(doc.get('revision') or 0),
        }

    def verifier(self) -> str:
        """只解开 keys 取校验值，给指纹注册 / 旧数据转换做解锁证明。"""
        with self._lock:
            uuid = self.current_uuid()
            doc = self._doc(uuid)
            if doc is None:
                return ''
            _, keys, _ = self._open_header(doc, uuid)
            return str(keys.get('verifier') or '')

    def device_info(self) -> dict:
        """给面板展示：当前 UUID、当前密码库的设备指纹、是否已有设备层。

        刻意不触发迁移：UUID 不匹配时这里仍要能显示「当前」UUID 供对照。
        """
        with self._lock:
            data = self._read(VAULT_FILE, None)
        try:
            uuid = self.current_uuid()
        except device.DeviceError:
            uuid = ''
        head = None
        if isinstance(data, dict):
            if data.get('format') == FORMAT or device.is_envelope(data):
                head = data.get('device') if isinstance(data.get('device'), dict) else {}
        return {
            'uuid': uuid,
            'id': str((head or {}).get('id') or ''),
            'wrapped': head is not None,
        }

    # ------------------------------------------------------------- 写入接口

    def put_keys(
        self, create: bool, kdf: dict, wrapped: dict, verifier: str,
        base_revision: int | None, proof: str | None,
    ) -> dict:
        """首次建库或修改主密码：只重包 vaultKey，不动任何条目。"""
        with self._lock:
            uuid = self.current_uuid()
            doc = self._doc(uuid)
            if create:
                if doc is not None:
                    raise VaultError('already_exists', '密码库已初始化')
                salt = os.urandom(device.SALT_LENGTH)
                key = device.device_key(str(uuid), salt)
                did = device.device_id(key)
                doc = {
                    'format': FORMAT,
                    'device': {
                        'alg': device.ALG, 'kdf': device.KDF,
                        'salt': device.b64(salt), 'id': did,
                    },
                    'created': now_iso(),
                    'keys': device.seal(
                        {
                            'format': 2, 'kdf': kdf, 'verifier': verifier,
                            'wrapped': wrapped, 'keysRevision': 1,
                        },
                        key, device.scope_aad(device.KEYS_SCOPE, did),
                    ),
                    'payload': [],
                    'revision': 1,
                }
                self._write(VAULT_FILE, doc)
                return {'keysRevision': 1, 'revision': 1}

            if doc is None:
                raise VaultError('not_found', '密码库尚未初始化')
            key, keys, did = self._open_header(doc, uuid)
            if not proof_ok(str(keys.get('verifier') or ''), proof):
                raise VaultError('not_allowed', '未解锁或密钥不匹配')
            current = int(keys.get('keysRevision') or 0)
            if base_revision is not None and int(base_revision) != current:
                raise VaultError('conflict', '主密码已在其它设备被修改，请刷新后重试')

            next_keys = {
                'format': 2,
                'kdf': kdf,
                'verifier': verifier or str(keys.get('verifier') or ''),
                'wrapped': wrapped,
                'keysRevision': current + 1,
            }
            doc = {
                **doc,
                'keys': device.seal(next_keys, key, device.scope_aad(device.KEYS_SCOPE, did)),
                'revision': int(doc.get('revision') or 0) + 1,
            }
            self._write(VAULT_FILE, doc)
        return {'keysRevision': current + 1, 'revision': doc['revision']}

    def put_item(self, item: dict, base: str | None, proof: str | None) -> dict:
        """新增或编辑一条记录。

        base 是前端上次看到的 updatedAt：为 None 表示新增，给了值就做逐项 CAS，
        这样「A 删了 X、B 还在改 X」会得到明确的 not_found，而不是悄悄复活。
        """
        ident = str(item.get('id') or '')
        with self._lock:
            uuid = self.current_uuid()
            doc = self._doc(uuid)
            if doc is None:
                raise VaultError('not_found', '密码库尚未初始化')
            key, keys, did = self._open_header(doc, uuid)
            if not proof_ok(str(keys.get('verifier') or ''), proof):
                raise VaultError('not_allowed', '未解锁或密钥不匹配')

            occupied = False
            existing = None
            for entry in doc.get('payload') or []:
                if entry.get('id') == ident:
                    occupied = True
                    existing = self._read_entry(entry, key, did, ident)
                    break

            if base is None:
                # 用 occupied 而不是 existing 判断：某条密文坏掉时 existing 为
                # None，但它仍占着这个 id，不能当成「新增」写出重复 id。
                if occupied:
                    raise VaultError('conflict', '该记录已存在，请刷新后重试')
            else:
                if existing is None:
                    raise VaultError(
                        'item_conflict' if occupied else 'not_found',
                        '该记录无法解开，请先导出备份再修复'
                        if occupied else '该记录已被删除',
                    )
                if str(existing.get('updatedAt') or '') != str(base):
                    raise VaultError('item_conflict', '该记录已被其它设备修改，请刷新后重试')

            plain = self._plain_from_item(item, now_iso())
            sealed = {
                'id': ident,
                **device.seal(plain, key, device.scope_aad(device.ITEM_SCOPE, did, ident)),
            }
            payload = []
            replaced = False
            for entry in doc.get('payload') or []:
                if entry.get('id') == ident:
                    payload.append(sealed)
                    replaced = True
                else:
                    payload.append(entry)
            if not replaced:
                payload.insert(0, sealed)  # 新增排在最前，与列表「最新在上」一致

            doc = {
                **doc, 'payload': payload,
                'revision': int(doc.get('revision') or 0) + 1,
            }
            self._write(VAULT_FILE, doc)
        return {'item': {'id': ident, **plain}, 'revision': doc['revision']}

    def put_items(self, items: list[dict], proof: str | None) -> dict:
        """批量写入（导入备份 / 旧版转换）：一次调用一次落盘，全成或全不成。"""
        with self._lock:
            uuid = self.current_uuid()
            doc = self._doc(uuid)
            if doc is None:
                raise VaultError('not_found', '密码库尚未初始化')
            key, keys, did = self._open_header(doc, uuid)
            if not proof_ok(str(keys.get('verifier') or ''), proof):
                raise VaultError('not_allowed', '未解锁或密钥不匹配')

            incoming = {}
            for item in items:
                incoming[str(item.get('id') or '')] = self._plain_from_item(
                    item, self._stamp(item.get('updatedAt'))
                )

            payload = []
            replaced = set()
            for entry in doc.get('payload') or []:
                ident = str(entry.get('id') or '')
                if ident in incoming:
                    payload.append({
                        'id': ident,
                        **device.seal(
                            incoming[ident], key,
                            device.scope_aad(device.ITEM_SCOPE, did, ident),
                        ),
                    })
                    replaced.add(ident)
                else:
                    payload.append(entry)
            added = 0
            for ident in reversed(list(incoming)):
                if ident in replaced:
                    continue
                payload.insert(0, {
                    'id': ident,
                    **device.seal(
                        incoming[ident], key,
                        device.scope_aad(device.ITEM_SCOPE, did, ident),
                    ),
                })
                added += 1

            if len(payload) > MAX_ITEMS:
                raise VaultError('invalid_format', f'记录数超过 {MAX_ITEMS} 条上限')
            doc = {
                **doc, 'payload': payload,
                'revision': int(doc.get('revision') or 0) + 1,
            }
            self._write(VAULT_FILE, doc)
        return {
            'added': added, 'replaced': len(replaced),
            'total': len(payload), 'revision': doc['revision'],
        }

    def delete_item(self, ident: str, proof: str | None) -> dict:
        """按明文 id 删除一条记录：不需要解开任何条目密文。"""
        with self._lock:
            uuid = self.current_uuid()
            doc = self._doc(uuid)
            if doc is None:
                raise VaultError('not_found', '密码库尚未初始化')
            _, keys, _ = self._open_header(doc, uuid)
            if not proof_ok(str(keys.get('verifier') or ''), proof):
                raise VaultError('not_allowed', '未解锁或密钥不匹配')

            payload = doc.get('payload') or []
            remaining = [entry for entry in payload if entry.get('id') != ident]
            if len(remaining) == len(payload):
                # 幂等：已被别的设备删掉不算错误，前端提示「该记录已不存在」即可
                return {'deleted': False, 'revision': int(doc.get('revision') or 0)}

            doc = {
                **doc, 'payload': remaining,
                'revision': int(doc.get('revision') or 0) + 1,
            }
            self._write(VAULT_FILE, doc)
        return {'deleted': True, 'revision': doc['revision']}

    # ------------------------------------------------------------- 设备重绑

    def recover(self, old_uuid: str) -> dict:
        """用旧 UUID 解开全部 envelope，再用当前 UUID 重新包裹（仅处理密文）。

        不要求 unlockProof：解不开外层时前端根本拿不到 wrapped.password，
        也就无法解锁，要求解锁证明会形成死锁。GCM tag 即旧 UUID 正确的证明。
        """
        current = self.current_uuid()
        done = {'vault': False, 'credentials': False}
        with self._lock:
            data = self._read(VAULT_FILE, None)
            if isinstance(data, dict) and data:
                if data.get('format') == FORMAT:
                    doc = self._rebind(data, old_uuid, current)
                else:
                    doc = self._from_legacy(data, old_uuid, current)
                self._write(VAULT_FILE, doc)
                done['vault'] = True

            cred = self._read(CREDENTIALS_FILE, None)
            if isinstance(cred, dict) and cred:
                inner = self._unwrap_any(cred, old_uuid, current)
                self._write(CREDENTIALS_FILE, device.wrap(
                    inner, current,
                    salt=os.urandom(device.SALT_LENGTH), created=None,
                ))
                done['credentials'] = True
        return done

    def _rebind(self, doc: dict, old_uuid: str, current: str) -> dict:
        """解开 format 4 文档，换 salt 后用当前 UUID 重新包裹。"""
        source_key, did = self._source_key(doc, old_uuid, current)
        try:
            keys_plain = device.unseal(
                doc.get('keys'), source_key, device.scope_aad(device.KEYS_SCOPE, did)
            )
            items_plain = []
            for entry in doc.get('payload') or []:
                ident = str(entry.get('id') or '')
                items_plain.append((ident, device.unseal(
                    entry, source_key, device.scope_aad(device.ITEM_SCOPE, did, ident)
                )))
        except device.DeviceError as err:
            raise VaultError('invalid_format', f'密码库内容无法解开：{err}') from err

        salt = os.urandom(device.SALT_LENGTH)
        key = device.device_key(str(current), salt)
        new_id = device.device_id(key)
        return {
            'format': FORMAT,
            'device': {
                'alg': device.ALG, 'kdf': device.KDF,
                'salt': device.b64(salt), 'id': new_id,
            },
            'created': str(doc.get('created') or '') or now_iso(),
            'keys': device.seal(
                keys_plain, key, device.scope_aad(device.KEYS_SCOPE, new_id)
            ),
            'payload': [
                {
                    'id': ident,
                    **device.seal(
                        plain, key,
                        device.scope_aad(device.ITEM_SCOPE, new_id, ident),
                    ),
                }
                for ident, plain in items_plain
            ],
            'revision': int(doc.get('revision') or 0),
        }

    def _source_key(self, doc: dict, old_uuid: str, current: str) -> tuple[bytes, str]:
        """优先用旧 UUID 推密钥；文件其实已重绑过时退回当前 UUID。"""
        try:
            key = self._key(doc, old_uuid)
        except device.DeviceError:
            if old_uuid == current:
                raise
            key = self._key(doc, current)
        return key, str((doc.get('device') or {}).get('id') or '')

    # --------------------------------------------------------- WebAuthn 凭据

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
                device.wrap(data, self.current_uuid(), previous=self._read(CREDENTIALS_FILE, None)),
            )

    @staticmethod
    def _unwrap_any(envelope: dict, old_uuid: str, current_uuid: str) -> dict:
        """优先用旧 UUID 解，失败再试当前 UUID（部分文件可能已重绑过）。"""
        try:
            return device.unwrap(envelope, old_uuid)
        except device.DeviceError:
            if old_uuid == current_uuid:
                raise
            return device.unwrap(envelope, current_uuid)

    # ----------------------------------------------------------------- 小工具

    @staticmethod
    def _plain_from_item(item: dict, stamp: str) -> dict:
        origins = [
            str(value).strip()
            for value in (item.get('origins') or [])
            if str(value).strip()
        ]
        return {
            'type': str(item.get('type') or 'login'),
            'category': str(item.get('category') or ''),
            'origins': origins,
            'notes': str(item.get('notes') or ''),
            'updatedAt': stamp,
            'enc': item.get('enc') if isinstance(item.get('enc'), dict) else {},
        }

    @staticmethod
    def _stamp(value: Any) -> str:
        """批量导入时保留原 updatedAt，非法值退回当前时间。

        合法值必须**原样返回**，不能重新序列化：前端缓存里存的就是它发上来的
        字符串，逐字符不一致会让下一次编辑被误判成 item_conflict。
        """
        raw = str(value or '').strip()
        if not raw:
            return now_iso()
        try:
            datetime.fromisoformat(raw.replace('Z', '+00:00'))
        except ValueError:
            return now_iso()
        return raw
