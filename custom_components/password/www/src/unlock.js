/* WebAuthn 平台认证器：注册、解锁与本地密钥包裹。

vaultKey 的指纹包裹只存在浏览器 localStorage，服务端只持有 credSecret；
解锁时服务端验证断言后才下发 credSecret，两边都单独无法解出数据密钥。
*/

import { b64u, ub64u, randomBytes, encryptBytes } from './crypto.js';

const STORE_KEY = 'password.webauthn.wraps';
const encoder = new TextEncoder();

export function webAuthnState() {
  if (!globalThis.isSecureContext) {
    return { available: false, reason: '需要 HTTPS 或 localhost 才能使用指纹解锁' };
  }
  if (!globalThis.PublicKeyCredential || !navigator.credentials) {
    return { available: false, reason: '当前浏览器不支持 WebAuthn' };
  }
  return { available: true, reason: '' };
}

export async function platformAuthenticatorAvailable() {
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (err) {
    return false;
  }
}

export function localWraps() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (err) {
    return {};
  }
}

function saveWraps(wraps) {
  localStorage.setItem(STORE_KEY, JSON.stringify(wraps));
}

export function setLocalWrap(id, wrapped, name) {
  const wraps = localWraps();
  wraps[id] = { ...wrapped, name, created: new Date().toISOString() };
  saveWraps(wraps);
}

export function removeLocalWrap(id) {
  const wraps = localWraps();
  delete wraps[id];
  saveWraps(wraps);
}

function credentialResponse(credential, keys) {
  const result = {};
  for (const key of keys) {
    const value = credential.response[key];
    if (value) result[key] = b64u(new Uint8Array(value));
  }
  return result;
}

/** 在已用密码解锁（内存中有 vaultKey）的前提下注册指纹。 */
export async function registerCredential(api, vaultKey, name, proof) {
  const options = await api.registerOptions();
  const publicKey = {
    challenge: ub64u(options.challenge),
    rp: { id: options.rpId, name: options.rpName },
    user: {
      id: encoder.encode(options.userId),
      name: options.userName,
      displayName: options.userName,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'discouraged',
    },
    attestation: 'none',
    timeout: 60000,
  };

  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error('已取消注册');

  const id = b64u(new Uint8Array(credential.rawId));
  const secret = randomBytes(32);
  const wrapped = await encryptBytes(secret, vaultKey);

  try {
    await api.registerVerify({
      challenge: options.challenge,
      credential: {
        id: credential.id,
        rawId: id,
        type: credential.type,
        response: credentialResponse(credential, ['clientDataJSON', 'attestationObject']),
      },
      credSecret: b64u(secret),
      name,
      unlockProof: proof,
    });
    setLocalWrap(id, wrapped, name);
    return id;
  } catch (err) {
    removeLocalWrap(id);
    throw err;
  }
}

/** 指纹解锁：返回服务端下发的 credSecret 与本设备的本地包裹。 */
export async function authenticate(api) {
  const wraps = localWraps();
  if (!Object.keys(wraps).length) {
    throw new Error('本设备尚未注册指纹，请先用密码解锁后注册');
  }
  const options = await api.authOptions();
  const allowCredentials = (options.allowCredentials || [])
    .filter((item) => wraps[item.id])
    .map((item) => ({ type: 'public-key', id: ub64u(item.id), transports: ['internal'] }));
  if (!allowCredentials.length) {
    throw new Error('本设备凭据已在服务端撤销，请重新注册');
  }

  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: ub64u(options.challenge),
      rpId: options.rpId,
      allowCredentials,
      userVerification: 'required',
      timeout: 60000,
    },
  });
  if (!credential) throw new Error('已取消验证');

  const id = b64u(new Uint8Array(credential.rawId));
  if (!wraps[id]) throw new Error('本设备没有该凭据的本地解锁数据');

  const data = await api.authVerify({
    challenge: options.challenge,
    credential: {
      id: credential.id,
      rawId: id,
      type: credential.type,
      response: credentialResponse(credential, [
        'clientDataJSON', 'authenticatorData', 'signature', 'userHandle',
      ]),
    },
  });
  return { id, credSecret: ub64u(data.credSecret), wrapped: wraps[id] };
}
