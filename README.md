# PASSWORD

在 HomeAssistant 中管理我的密码。原生 JavaScript 侧边栏面板 + WebAuthn 指纹解锁 + 主密码解锁，无框架、无构建步骤。

[![hacs_badge](https://img.shields.io/badge/Home-Assistant-%23049cdb)](https://www.home-assistant.io/)
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)

## 架构

- `custom_components/password/` —— HA 自定义集成。通过 `panel_custom.async_register_panel` 注册**侧边栏面板**（顶层 Custom Element，非 iframe），JS 由 `module_url` 直接加载，无需 Lovelace 资源注册。
- `custom_components/password/www/` —— 原生 ES modules 前端，`password-panel.js` 是入口，内部为卡片模块 `password-vault-card`，主内容铺满整个面板。
- `custom_components/password/websocket.py` 等 —— 通过 HA 自身的 websocket 通道提供 `password/*` 命令与 WebAuthn 断言校验，**不注册自定义 HTTP 端点**；数据落在 `.storage/password_vault.json` 与 `.storage/password_webauthn.json`。
- `tools/convert_v1.py` —— 旧版数据一次性离线转换脚本，不随集成分发，需手动下载运行。

前端只使用浏览器原生能力：Custom Elements、Shadow DOM、WebCrypto（PBKDF2 + AES-256-GCM + HMAC）、WebAuthn。没有 npm、TypeScript、Vite 或任何第三方库。业务请求统一通过 `hass.callWS()` 走 HA 的 websocket 连接；集成的静态路径只用于加载面板 JS 文件。

## 安装

1. HACS → 集成 → 自定义仓库，添加本仓库，类别选 **Integration**；或手动把 `custom_components/password/` 复制到 HA 配置目录。
2. 重启 HomeAssistant。
3. 设置 → 设备与服务 → 添加集成 → 搜索「我的密码」，填写**主密码**（至少 8 位），可选「仅管理员可访问」。
4. 侧边栏出现「我的密码」；首次打开会用该主密码自动创建密码库，无需单独的初始化步骤。

> 升级安装后若界面未变化，请强制刷新浏览器（Ctrl/Cmd + Shift + R）。

## 重要前提：HTTPS

WebCrypto 与 WebAuthn 都要求安全上下文，因此**必须通过 `https://` 或 `localhost` 访问 HomeAssistant**。使用 `http://局域网IP:8123` 时面板会提示「当前页面不是安全上下文」，密码与指纹均无法使用；建议配置反向代理证书或 Nabu Casa 远程访问。指纹解锁还额外要求设备存在可用的平台认证器（Windows Hello / Touch ID / Android 生物识别）。

## 使用

1. **解锁**：打开面板进入锁定页，输入添加集成时填写的主密码；也可在解锁后通过菜单「修改主密码」更换（已注册的指纹凭据不受影响）。
2. **指纹解锁**：解锁后打开右上角「菜单」→「指纹与凭据」→ 输入设备名 → 注册本设备指纹。之后锁定页会出现「指纹解锁」。两种解锁方式拿到的是同一个数据密钥；换设备需重新注册，凭据可随时撤销。
3. **导入旧数据**：先手动下载 `tools/convert_v1.py` 到本机运行转换，再在「菜单」→「导入旧数据」中选择导出的 JSON。
4. 面板顶部是应用栏：左侧 HA 图标用于打开/收起 HomeAssistant 侧边栏（移动端必需），中间是标题、记录数与搜索框，右侧是分类筛选、新增与「菜单」（导入旧数据 / 导出备份 / 指纹与凭据 / 修改主密码 / 锁定）。支持搜索、分类、新增/编辑/删除、关联链接、导出明文备份、空闲 5 分钟自动锁定。

## 从旧版迁移

新版与旧版数据格式**完全不兼容**，转换脚本不随 HACS 集成分发，请先手动下载 `tools/convert_v1.py` 到本机，离线转换一次：

```bash
py tools/convert_v1.py --storage /path/to/config/.storage --password '旧主密码' --out password_export.json
```

- `--storage` 可传 HA 配置目录或其下的 `.storage` 目录；脚本自动读取 `password.json`、`core.uuid`、`core.config_entries`。
- 若 HA 已重装导致 UUID 变化，用 `--uuid '旧UUID'` 指定；也可用 `--server-key <config entry 中的 md5>` 代替 `--password`。
- 依赖 `cryptography`（HA 自带；普通 Python 环境执行 `pip install cryptography`）。
- 脚本**只读取**旧文件，不会修改或删除 `.storage/password.json`；逐条解密，失败项会列出。
- 输出是**明文 JSON**，在面板菜单「导入旧数据」载入后请立即删除。
- 数据量大或解密失败时，先核对 `--password` 与 `--uuid` 是否正确。

## 数据与备份

| 文件 | 内容 |
|---|---|
| `.storage/password_vault.json` | 加密后的整库密文、KDF 参数、被包裹的密钥、解锁证明、版本号 |
| `.storage/password_webauthn.json` | 指纹凭据公钥、签名计数、设备名、每凭据的解锁密钥 |
| `.storage/core.config_entries` | 添加集成时填写的主密码（用于首次自动建库） |
| 浏览器 `localStorage` | 本设备的指纹密钥包裹（不含数据密钥明文） |

密码库本身是 AES-GCM 密文，但主密码保存在 HA 集成配置里，**能接触 HA 配置文件或管理员账号的人可以解开密码库**，请按 HA 常规做法保护配置目录与管理员权限。指纹包裹只存在浏览器本地，服务端仅有对应解锁密钥。请定期使用菜单「导出备份」保存明文副本并离线保管——**主密码与备份同时丢失时数据无法恢复**。

## 安全说明

- 全部数据以 32 字节随机 `vaultKey` 加密，密码路径用 PBKDF2-SHA256（60 万次）派生的密钥包裹，指纹路径用随机 `credSecret` 包裹；`vaultKey` 只在浏览器内存中，不写入 localStorage、不挂全局对象。
- 主密码在添加集成时填写并保存在 HA config entry，首次打开面板时用于自动建库。这与「服务端零知识」不同，服务端具备解开密码库的能力。
- 业务请求全部走 HA 已鉴权的 websocket 连接，按 `connection.user` 判定管理员权限；不产生独立的 HTTP 端点、URL 参数与反向代理访问日志。写命令还需携带由 `vaultKey` 派生的 HMAC 解锁证明，并用 `revision` 做乐观锁。
- 复用 websocket 并不改变「主密码保存在 config entry」这一事实，也不是额外的传输加密；收益是取消独立 HTTP 端点、减少请求内容出现在日志中的可能，并与 HA 自身的权限体系保持一致。
- WebAuthn 要求 `userVerification=required`，challenge 一次性且 2 分钟过期，服务端校验 origin、RP ID、签名与计数器。
- 面板运行在 HA 顶层文档，请勿安装来源不明的其它自定义卡片/插件。

## 自定义面板头部

侧边栏面板是本项目自己的 Custom Element，顶部头部没有任何配置项，直接改文件即可：

- `custom_components/password/www/src/panel-header.js` 导出 `PANEL_HEADER_STYLES`（CSS）与 `PANEL_HEADER_HTML`（HTML）。把这两个导出换成你自己的内容即完成自定义，不需要改 `main.js`。
- 默认头部是具名插槽 `<slot name="header">` 的 fallback，不自定义时行为与原来一致。

运行时也提供两种注入方式：

```html
<password-panel>
  <div slot="header">这里写任意 HTML</div>
</password-panel>
```

```js
document.querySelector('password-panel').setHeader('<div>自定义头部</div>');
document.querySelector('password-panel').setHeader(null); // 恢复默认
```

- 插槽 / `setHeader()` 注入的内容位于 light DOM，样式由外部页面提供；直接改 `panel-header.js` 时样式随 shadow DOM 注入。
- 头部里带 `data-action="toggle-menu"` 的元素点击后会打开 HA 侧边栏，自定义头部保留该属性即可复用。
- `setHeader()` 使用 `innerHTML` 注入，**只放自己编写的静态 HTML**，不要拼接 HA 状态、URL 参数或用户输入，避免 XSS。

## 引用

- https://github.com/material-components/material-web （旧版曾使用，现已移除）
- HomeAssistant 官方文档：Custom panels / Register resources
