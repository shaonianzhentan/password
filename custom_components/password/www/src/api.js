/* 复用 HomeAssistant 已鉴权的 websocket 通道（hass.callWS）。
 * 不发起任何自定义 HTTP 请求；hass 由面板的 set hass 注入。
 */

const PREFIX = 'password/';

/* 浏览器实际访问的 origin。HA 的 websocket 连接不暴露握手请求的 Host，
 * 由前端传给服务端生成 WebAuthn 的 RP ID / 期望 origin；服务端仍会用
 * 认证器签名的 clientDataJSON.origin、rpIdHash 与一次性 challenge 复核，
 * 不会把这个值直接当成可信来源。 */
const ACCESS_ORIGIN = globalThis.location ? globalThis.location.origin : '';
const withOrigin = (payload = {}) => ({ accessOrigin: ACCESS_ORIGIN, ...payload });

export function createApi(hass) {
  async function call(command, payload = {}) {
    if (!hass || typeof hass.callWS !== 'function') {
      throw new Error('未获取到 HomeAssistant websocket 连接，请刷新页面');
    }
    try {
      return await hass.callWS({ type: PREFIX + command, ...payload });
    } catch (err) {
      throw new Error((err && err.message) || '请求失败');
    }
  }

  return {
    getVault: () => call('vault/get'),
    putVault: (payload) => call('vault/put', payload),
    registerOptions: () => call('webauthn/register/options', withOrigin()),
    registerVerify: (payload) => call(
      'webauthn/register/verify', withOrigin(payload)
    ),
    authOptions: () => call('webauthn/authenticate/options', withOrigin()),
    authVerify: (payload) => call(
      'webauthn/authenticate/verify', withOrigin(payload)
    ),
    listCredentials: () => call('webauthn/credentials/list'),
    deleteCredential: (id, proof) => call(
      'webauthn/credentials/delete', { credentialId: id, unlockProof: proof }
    ),
  };
}
