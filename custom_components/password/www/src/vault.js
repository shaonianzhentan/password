/* 密码库状态机：初始化、两种解锁路径、条目 CRUD、保存与备份。 */

import {
  VAULT_VERSION, ITERATIONS, b64, ub64, randomBytes,
  deriveKek, encryptBytes, decryptBytes, encryptJson, decryptJson, unlockProof,
} from './crypto.js';

const today = () => new Date().toISOString().slice(0, 10);

export function normalizeItems(data) {
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
  if (!list) throw new Error('导入文件格式不正确');
  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || crypto.randomUUID()),
      title: String(item.title || ''),
      category: String(item.category || ''),
      text: String(item.text || ''),
      link: String(item.link || ''),
      date: String(item.date || today()),
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
    this.exists = true;
    this.raw = data.vault || null;
    this.revision = this.raw ? this.raw.revision : 0;
    return true;
  }

  async initialize(password, importedItems = []) {
    const salt = randomBytes(16);
    const key = randomBytes(32);
    const kek = await deriveKek(password, salt, ITERATIONS);
    const proof = await unlockProof(key);
    const vault = {
      version: VAULT_VERSION,
      kdf: { salt: b64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
      wrapped: { password: await encryptBytes(kek, key) },
      blob: await encryptJson(key, { version: VAULT_VERSION, items: importedItems }),
      verifier: proof,
    };
    const result = await this.api.putVault({ create: true, vault });
    this.key = key;
    this.proof = proof;
    this.items = importedItems;
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
    let data;
    try {
      data = await decryptJson(key, this.raw.blob);
    } catch (err) {
      throw new Error('数据解密失败，密钥不正确');
    }
    this.key = key;
    this.proof = await unlockProof(key);
    this.items = Array.isArray(data.items) ? data.items : [];
  }

  lock() {
    this.key = null;
    this.proof = null;
    this.items = [];
  }

  async save() {
    if (!this.unlocked) throw new Error('请先解锁');
    const blob = await encryptJson(this.key, {
      version: VAULT_VERSION,
      items: this.items,
    });
    const vault = {
      version: VAULT_VERSION,
      kdf: this.raw.kdf,
      wrapped: this.raw.wrapped,
      blob,
      verifier: this.proof,
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
      kdf: { salt: b64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
      wrapped: {
        ...this.raw.wrapped,
        password: await encryptBytes(kek, this.key),
      },
    };
    await this.save();
  }

  upsert(item) {
    if (item.id) {
      const index = this.items.findIndex((entry) => entry.id === item.id);
      if (index >= 0) {
        this.items[index] = { ...this.items[index], ...item, date: today() };
        return;
      }
    }
    this.items.unshift({
      id: crypto.randomUUID(),
      title: '',
      category: '',
      text: '',
      link: '',
      date: today(),
      ...item,
    });
  }

  remove(id) {
    this.items = this.items.filter((item) => item.id !== id);
  }

  get categories() {
    return Array.from(new Set(this.items.map((item) => item.category).filter(Boolean)));
  }

  exportJson() {
    return JSON.stringify(this.items, null, 2);
  }
}
