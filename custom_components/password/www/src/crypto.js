/* 纯 WebCrypto 实现：PBKDF2 + AES-256-GCM + HMAC，零第三方依赖。 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const VAULT_VERSION = 2;
export const ITERATIONS = 600000;
const UNLOCK_CONTEXT = 'password/unlock/v2';
const IV_LENGTH = 12;

export function cryptoAvailable() {
  return !!(globalThis.crypto && globalThis.crypto.subtle);
}

function toBase64(bytes, urlSafe = false) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  let value = btoa(binary);
  if (urlSafe) {
    value = value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return value;
}

function fromBase64(value, urlSafe = false) {
  let text = urlSafe ? value.replace(/-/g, '+').replace(/_/g, '/') : value;
  while (text.length % 4) text += '=';
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const b64 = (bytes) => toBase64(bytes);
export const ub64 = (value) => fromBase64(value);
export const b64u = (bytes) => toBase64(bytes, true);
export const ub64u = (value) => fromBase64(value, true);

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function aesKey(keyBytes, usage) {
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [usage]);
}

export async function encryptBytes(keyBytes, dataBytes) {
  const iv = randomBytes(IV_LENGTH);
  const key = await aesKey(keyBytes, 'encrypt');
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 }, key, dataBytes
  );
  return { iv: b64(iv), ct: b64(new Uint8Array(encrypted)) };
}

export async function decryptBytes(keyBytes, payload) {
  const key = await aesKey(keyBytes, 'decrypt');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(payload.iv), tagLength: 128 },
    key,
    ub64(payload.ct)
  );
  return new Uint8Array(decrypted);
}

export async function encryptJson(keyBytes, value) {
  return encryptBytes(keyBytes, encoder.encode(JSON.stringify(value)));
}

export async function decryptJson(keyBytes, payload) {
  return JSON.parse(decoder.decode(await decryptBytes(keyBytes, payload)));
}

export async function deriveKek(password, salt, iterations = ITERATIONS) {
  const baseKey = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, baseKey, 256
  );
  return new Uint8Array(bits);
}

/** 解锁证明：服务端只保存该值，无法据此还原 vaultKey。 */
export async function unlockProof(vaultKey) {
  const key = await crypto.subtle.importKey(
    'raw', vaultKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(UNLOCK_CONTEXT));
  return b64(new Uint8Array(signature));
}
