/* 密码库状态机：明文元数据 + 逐条 AES-GCM 密文、按需解密、条目级提交。
 *
 * === 磁盘契约（format 4，见服务端 storage.py）===
 * .storage/password_vault.json 顶层：
 *   { format: 4, device: { alg, kdf, salt, id }, created,
 *     keys: { iv, ct },                 // kdf / verifier / wrapped 的设备层 envelope
 *     payload: [ { id, iv, ct }, ... ], // 每条记录一份独立 envelope
 *     revision }
 * 设备层完全由服务端负责：前端看不到也不需要设备密钥。
 *
 * === 前端契约 ===
 * keys 解开后是 { format: 2, kdf, verifier, wrapped.password, keysRevision }
 *   kdf      = { alg: 'PBKDF2-SHA256', salt: b64, iterations: 600000, hash: 'SHA-256' }
 *   verifier = HMAC(vaultKey, 'password/unlock/v1')，写操作作为 unlockProof
 *   wrapped.password = { iv, ct }，主密码派生的 KEK 包裹随机 32 字节 vaultKey
 *
 * items[] 每项：
 *   明文：id / type / category / origins[] / notes / updatedAt
 *   密文：enc = { alg: 'AES-256-GCM', iv, ct }，解密后为 { username, password, totp }
 *   notes 第一行作为列表显示名；type 目前固定 'login'
 *
 * AAD = JSON.stringify([id, type, category, origins, notes]) 的 UTF-8 字节，
 * 不含 updatedAt / revision。明文元数据一旦被改动，该条解密立即失败；
 * 编辑任一元数据字段都要用新 IV 重新加密这一条。
 *
 * 同步：解锁时全量 vault/get，此后只提交单条——
 *   upsert → item/put（带上一次看到的 updatedAt 做逐项 CAS）
 *   remove → item/delete（按 id 删，服务端不解开任何条目密文）
 *   importItems → items/put 批量
 * 两台设备改不同记录互不覆盖；改同一条会得到 item_conflict。
 *
 * 服务端零知识：主密码只在浏览器内存，config entry 不保存任何密码材料；
 * 磁盘上的条目是服务端再包一层设备层密钥，前端只看到 format 2 的元数据。
 * WebAuthn 包裹沿用「服务端 credSecret + 浏览器 localStorage 本地包裹」，
 * 不写入 vault 文件。
 */

import {
  ITERATIONS, b64, ub64, randomBytes,
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

/** 时间戳统一成 toISOString 形态。
 * 服务端对可解析的 updatedAt 原样保留，因此前端缓存与磁盘字符串逐字符一致，
 * 下一次编辑的 CAS 比对不会被误判成冲突。 */
function stampOf(value) {
  const raw = text(value).trim();
  if (!raw) return now();
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? now() : new Date(ms).toISOString();
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

/** 兼容旧版转换脚本产出的 title / text / link / date 字段。 */
function legacyDate(value) {
  const raw = text(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return now();
  const moment = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(moment.getTime()) ? now() : moment.toISOString();
}

export function normalizeItems(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
  if (!list) throw new Error('导入文件格式不正确');
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const old = item.title !== undefined || item.text !== undefined || item.link !== undefined;
      const meta = metaOf({
        ...item,
        category: item.category,
        origins: old ? [item.link] : item.origins,
        notes: old ? (item.notes ?? item.title) : item.notes,
      });
      return {
        ...meta,
        username: old ? '' : text(item.username),
        // 旧版 text 是密码正文，必须放进加密字段，不能落到明文元数据 notes
        password: old ? text(item.text) : text(item.password),
        totp: old ? '' : text(item.totp),
        updatedAt: old ? legacyDate(item.date) : (text(item.updatedAt) || now()),
      };
    });
}

export class Vault {
  constructor(api) {
    this.api = api;
    this.exists = false;
    // 头部：解锁参数（明文元数据，不含任何密钥材料）
    this.kdf = null;
    this.wrapped = null;
    this.keysRevision = 0;
    // 运行时：主密码派生的数据密钥与解锁证明，只存在于内存
    this.key = null;
    this.proof = null;
    // 条目缓存（服务端快照）与全局 revision
    this.items = [];
    this.revision = 0;
    this.device = { uuid: '', id: '', wrapped: false, canManage: false };
  }

  get unlocked() {
    return !!this.key;
  }

  /** 返回 'setup'（需设置主密码）或 'ready'（可解锁）。 */
  async load() {
    const data = await this.api.getVault();
    this.device = {
      uuid: data.deviceUuid || '',
      id: data.deviceId || '',
      wrapped: Boolean(data.deviceWrapped),
      canManage: Boolean(data.canManageDevice),
    };
    if (!data.exists) {
      this.exists = false;
      this.items = [];
      return 'setup';
    }
    if (!data.kdf || !data.wrapped) {
      throw new Error('密码库缺少解锁参数，请检查 .storage/password_vault.json 是否损坏');
    }
    this.exists = true;
    this.kdf = data.kdf;
    this.wrapped = data.wrapped;
    this.keysRevision = data.keysRevision || 0;
    this.items = Array.isArray(data.items) ? data.items : [];
    this.revision = data.revision || 0;
    return 'ready';
  }

  async seal(item, key) {
    const meta = metaOf(item);
    const secret = {};
    for (const field of SECRET_FIELDS) secret[field] = text(item[field]);
    const enc = await encryptJson(key, secret, aadOf(meta));
    return {
      ...meta,
      updatedAt: stampOf(item.updatedAt),
      enc: { alg: 'AES-256-GCM', ...enc },
    };
  }

  async initialize(password, importedItems = []) {
    // password 只作局部变量派生 KEK，不写入 state / storage / sessionStorage
    const salt = randomBytes(16);
    const key = randomBytes(32);
    const kek = await deriveKek(password, salt, ITERATIONS);
    const proof = await unlockProof(key);
    const kdf = {
      alg: 'PBKDF2-SHA256', salt: b64(salt), iterations: ITERATIONS, hash: 'SHA-256',
    };
    const wrapped = { password: await encryptBytes(kek, key) };

    const result = await this.api.putKeys({
      create: true, kdf, wrapped, verifier: proof,
    });
    this.key = key;
    this.proof = proof;
    this.kdf = kdf;
    this.wrapped = wrapped;
    this.keysRevision = result.keysRevision || 1;
    this.revision = result.revision || 1;
    this.exists = true;
    this.items = [];

    const items = [];
    for (const item of normalizeItems(importedItems)) {
      items.push(await this.seal(item, key));
    }
    if (items.length) {
      const saved = await this.api.putItems({ items, unlockProof: proof });
      this.items = items;
      this.revision = saved.revision || this.revision;
    }
  }

  async unlockWithPassword(password) {
    if (!this.kdf) throw new Error('密码库尚未初始化');
    const salt = ub64(this.kdf.salt);
    const kek = await deriveKek(password, salt, this.kdf.iterations || ITERATIONS);
    let key;
    try {
      key = await decryptBytes(kek, this.wrapped.password);
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

  /* 两条解锁路径都是「用 KEK / 本地密钥解开一段 GCM 密文」，GCM 的认证标签
   * 本身就能证明密钥正确，所以这里不必再去试探条目——否则单条元数据被改动
   * 会导致整个库都解不开。逐条损坏只在 reveal 该条时报错。 */
  async adoptKey(key) {
    this.key = key;
    this.proof = await unlockProof(key);
  }

  lock() {
    this.key = null;
    this.proof = null;
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

  /** 只重加密被修改的这一条，并提交到服务端（带逐项 CAS）。 */
  async upsert(item) {
    if (!this.unlocked) throw new Error('请先解锁');
    const sealed = await this.seal({ ...item, updatedAt: now() }, this.key);
    const cached = this.items.find((entry) => entry.id === sealed.id);
    const payload = { item: sealed, unlockProof: this.proof };
    // 新增不传 base；编辑带上一次看到的 updatedAt，服务端据此判断是否被别人改过
    if (cached) payload.base = text(cached.updatedAt);

    const result = await this.api.putItem(payload);
    const stored = result.item;
    const index = this.items.findIndex((entry) => entry.id === stored.id);
    if (index >= 0) this.items[index] = stored;
    else this.items.unshift(stored);
    this.revision = result.revision || this.revision;
    return stored;
  }

  /** 批量写入（导入备份 / 旧版转换）：一次提交，全成或全不成。 */
  async importItems(plainItems) {
    if (!this.unlocked) throw new Error('请先解锁');
    const existing = new Set(this.items.map((item) => item.id));
    const sealed = [];
    for (const item of plainItems) {
      const next = { ...item };
      if (!next.id || existing.has(next.id)) next.id = crypto.randomUUID();
      existing.add(next.id);
      sealed.push(await this.seal(next, this.key));
    }
    if (!sealed.length) return 0;
    const result = await this.api.putItems({ items: sealed, unlockProof: this.proof });
    this.items = [...sealed, ...this.items];
    this.revision = result.revision || this.revision;
    return sealed.length;
  }

  /** 按 id 删除单条；返回 false 表示服务端已经没有这条（幂等）。 */
  async remove(id) {
    if (!this.unlocked) throw new Error('请先解锁');
    const result = await this.api.deleteItem({ itemId: id, unlockProof: this.proof });
    if (result.deleted) this.items = this.items.filter((item) => item.id !== id);
    this.revision = result.revision || this.revision;
    return Boolean(result.deleted);
  }

  async changePassword(password) {
    if (!this.unlocked) throw new Error('请先解锁');
    const salt = randomBytes(16);
    const kek = await deriveKek(password, salt, ITERATIONS);
    const kdf = {
      alg: 'PBKDF2-SHA256', salt: b64(salt), iterations: ITERATIONS, hash: 'SHA-256',
    };
    const wrapped = {
      ...this.wrapped,
      password: await encryptBytes(kek, this.key),
    };
    const result = await this.api.putKeys({
      kdf,
      wrapped,
      verifier: this.proof,
      baseRevision: this.keysRevision,
      unlockProof: this.proof,
    });
    this.kdf = kdf;
    this.wrapped = wrapped;
    this.keysRevision = result.keysRevision || this.keysRevision + 1;
    this.revision = result.revision || this.revision;
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
