/* 复用 HomeAssistant 已鉴权的 websocket 通道（hass.callWS）。
 * 不发起任何自定义 HTTP 请求；hass 由面板的 set hass 注入。
 */

const PREFIX = 'password/';

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
    registerOptions: () => call('webauthn/register/options'),
    registerVerify: (payload) => call('webauthn/register/verify', payload),
    authOptions: () => call('webauthn/authenticate/options'),
    authVerify: (payload) => call('webauthn/authenticate/verify', payload),
    listCredentials: () => call('webauthn/credentials/list'),
    deleteCredential: (id, proof) => call(
      'webauthn/credentials/delete', { id, unlockProof: proof }
    ),
  };
}
