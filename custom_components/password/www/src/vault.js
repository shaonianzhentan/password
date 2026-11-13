/* 密码库状态机：明文元数据 + 逐条 AES-GCM 密文、按需解密、乐观锁保存。
 *
 * === 数据契约（format 2）===
 * .storage/password_vault.json 顶层：
 *   { format: 2, kdf, verifier, wrapped, items[], revision, updated }
 *   kdf      = { alg: 'PBKDF2-SHA256', salt: b64, iterations: 600000, hash: 'SHA-256' }
 *   verifier = HMAC(vaultKey, 'password/unlock/v1')，写命令携带它做解锁证明
 *   wrapped.password = { iv, ct }，主密码派生的 KEK 包裹随机 32 字节 vaultKey
 *   revision / updated 由服务端写入，revision 用于乐观锁
 *
 * items[] 每项：
 *   明文：id / type / category / origins[] / notes / updatedAt
 *   密文：enc = { alg: 'AES-256-GCM', iv, ct }，ct 解密后为
 *         { username, password, totp }
 *   notes 第一行作为列表显示名；type 目前固定 'login'
 *
 * AAD = JSON.stringify([id, type, category, origins, notes]) 的 UTF-8 字节，
 * 不含 updatedAt / revision。明文元数据一旦被改动，该条解密立即失败；
 * 编辑任一元数据字段都要用新 IV 重新加密这一条。
 *
 * 同步：全量 password/vault/get + 带 revision 的 password/vault/put；
 * 改一条只重加密一条，其余条目连同 IV 原样写回。
 * WebAuthn 包裹沿用「服务端 credSecret + 浏览器 localStorage 本地包裹」，
 * 不写入 vault 文件。
 */

import {
  VAULT_FORMAT, ITERATIONS, b64, ub64, randomBytes,
  deriveKek, encryptBytes, decryptBytes, encryptJson, decryptJson, unlockProof,
} from './crypto.js';

const encoder = new TextEncoder();
const now = () => new Date().toISOString();
const text = (value) => String(value == null ? '' : value);

const META_FIELDS = ['id', 'type', 'category', 'origins', 'notes'];
const SECRET_FIELDS = ['username', 'password', 'totp'];

function originsOf(value) {
  const list = Array.isArray(value) ? value : text(value).split(/[\n,]+/);
  return list.map((item) => text(item).trim()).filter(Boolean);
}

export function metaOf(item) {
  return {
    id: text(item.id) || crypto.randomUUID(),
    type: text(item.type) || 'login',
    category: text(item.category).trim(),
    origins: originsOf(item.origins),
    notes: text(item.notes),
  };
}

/** AAD 用 JSON 数组编码，避免分隔符歧义；顺序与字段集合必须长期固定。 */
export function aadOf(meta) {
  return encoder.encode(JSON.stringify(META_FIELDS.map((key) => meta[key])));
}

export function normalizeItems(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
  if (!list) throw new Error('导入文件格式不正确');
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      ...metaOf(item),
      username: text(item.username),
      password: text(item.password),
      totp: text(item.totp),
      updatedAt: text(item.updatedAt) || now(),
    }));
}

export class Vault {
  constructor(api) {
    this.api = api;
    this.exists = false;
    this.raw = null;
    this.key = null;
    this.proof = null;
    this.items = [];
    this.revision = 0;
  }

  get unlocked() {
    return !!this.key;
  }

  async load() {
    const data = await this.api.getVault();
    if (!data.exists) {
      // 主密码在添加集成时已填写，首次打开直接建库，无需初始化界面
      const password = data.masterPassword;
      if (!password) {
        throw new Error('未获取到集成中填写的主密码，请在集成配置中重新添加');
      }
      await this.initialize(password, []);
      this.lock();
      return false;
    }
    const vault = data.vault;
    if (!vault || vault.format !== VAULT_FORMAT) {
      throw new Error('密码库是旧格式，本版本不提供迁移。请删除 HA 配置目录下的 .storage/password_vault.json 后重新打开面板建库');
    }
    this.exists = true;
    this.raw = vault;
    this.revision = vault.revision || 0;
    return true;
  }

  async seal(item, key) {
    const meta = metaOf(item);
    const secret = {};
    for (const field of SECRET_FIELDS) secret[field] = text(item[field]);
    const enc = await encryptJson(key, secret, aadOf(meta));
    return {
      ...meta,
      updatedAt: item.updatedAt || now(),
      enc: { alg: 'AES-256-GCM', ...enc },
    };
  }

  async initialize(password, importedItems = []) {
    const salt = randomBytes(16);
    const key = randomBytes(32);
    const kek = await deriveKek(password, salt, ITERATIONS);
    const proof = await unlockProof(key);
    const items = [];
    for (const item of normalizeItems(importedItems)) {
      items.push(await this.seal(item, key));
    }
    const vault = {
      format: VAULT_FORMAT,
      kdf: { alg: 'PBKDF2-SHA256', salt: b64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
      verifier: proof,
      wrapped: { password: await encryptBytes(kek, key) },
      items,
    };
    const result = await this.api.putVault({ create: true, vault });
    this.key = key;
    this.proof = proof;
    this.items = items;
    this.revision = result.revision;
    this.raw = vault;
    this.exists = true;
  }

  async unlockWithPassword(password) {
    if (!this.raw) throw new Error('密码库尚未初始化');
    const salt = ub64(this.raw.kdf.salt);
    const kek = await deriveKek(password, salt, this.raw.kdf.iterations || ITERATIONS);
    let key;
    try {
      key = await decryptBytes(kek, this.raw.wrapped.password);
    } catch (err) {
      throw new Error('主密码错误');
    }
    await this.adoptKey(key);
  }

  async unlockWithCredential(credSecret, wrapped) {
    let key;
    try {
      key = await decryptBytes(credSecret, wrapped);
    } catch (err) {
      throw new Error('本地指纹数据已损坏，请用主密码解锁后重新注册');
    }
    await this.adoptKey(key);
  }

  async adoptKey(key) {
    const items = Array.isArray(this.raw.items) ? this.raw.items : [];
    // 用第一条自检密钥是否正确；列表本身不需要解密任何条目。
    if (items.length) {
      try {
        await decryptJson(key, items[0].enc, aadOf(metaOf(items[0])));
      } catch (err) {
        throw new Error('数据解密失败，密钥不正确或明文元数据已被改动');
      }
    }
    this.key = key;
    this.proof = await unlockProof(key);
    this.items = items;
  }

  lock() {
    this.key = null;
    this.proof = null;
    this.items = [];
  }

  /** 只解密指定条目；列表渲染不触发任何解密。 */
  async reveal(id) {
    if (!this.unlocked) throw new Error('请先解锁');
    const entry = this.items.find((item) => item.id === id);
    if (!entry) return null;
    const meta = metaOf(entry);
    let secret;
    try {
      secret = await decryptJson(this.key, entry.enc, aadOf(meta));
    } catch (err) {
      throw new Error('该条记录解密失败，明文元数据可能已被改动');
    }
    return {
      ...meta,
      username: text(secret.username),
      password: text(secret.password),
      totp: text(secret.totp),
      updatedAt: entry.updatedAt,
    };
  }

  /** 只重加密被修改的这一条，其余条目连同 IV 原样保留。 */
  async upsert(item) {
    if (!this.unlocked) throw new Error('请先解锁');
    const sealed = await this.seal({ ...item, updatedAt: now() }, this.key);
    const index = item.id ? this.items.findIndex((entry) => entry.id === item.id) : -1;
    if (index >= 0) this.items[index] = sealed;
    else this.items.unshift(sealed);
  }

  async importItems(plainItems) {
    const existing = new Set(this.items.map((item) => item.id));
    for (const item of plainItems) {
      const next = { ...item };
      if (!next.id || existing.has(next.id)) next.id = crypto.randomUUID();
      existing.add(next.id);
      await this.upsert(next);
    }
  }

  remove(id) {
    this.items = this.items.filter((item) => item.id !== id);
  }

  async save() {
    if (!this.unlocked) throw new Error('请先解锁');
    const vault = {
      format: VAULT_FORMAT,
      kdf: this.raw.kdf,
      wrapped: this.raw.wrapped,
      verifier: this.proof,
      items: this.items,
    };
    const result = await this.api.putVault({
      vault,
      unlockProof: this.proof,
      revision: this.revision,
    });
    this.raw = vault;
    this.revision = result.revision;
  }

  async changePassword(password) {
    if (!this.unlocked) throw new Error('请先解锁');
    const salt = randomBytes(16);
    const kek = await deriveKek(password, salt, ITERATIONS);
    this.raw = {
      ...this.raw,
      kdf: { alg: 'PBKDF2-SHA256', salt: b64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
      wrapped: {
        ...this.raw.wrapped,
        password: await encryptBytes(kek, this.key),
      },
    };
    await this.save();
  }

  get categories() {
    return Array.from(new Set(this.items.map((item) => item.category).filter(Boolean)));
  }

  async exportJson() {
    if (!this.unlocked) throw new Error('请先解锁');
    const plain = [];
    for (const entry of this.items) {
      const meta = metaOf(entry);
      const secret = await decryptJson(this.key, entry.enc, aadOf(meta));
      plain.push({ ...meta, ...secret, updatedAt: entry.updatedAt });
    }
    return JSON.stringify(plain, null, 2);
  }
}
