# 霜镜

霜镜是一套可私有部署的上游余额监控面板。它登录你拥有的 New API、Sub2API 或兼容站点账号，读取原始余额，通过四则运算公式转换为人民币，并在低余额时通过 Resend 或飞书告警。你手动充值后，系统连续两次检测到恢复会自动发送恢复通知并结单。

## 核心能力

- New API：默认使用“个人资料 → 安全 → 访问令牌”生成的用户访问令牌，配合 User ID 免登录读取整个账户余额。左侧“API 密钥”属于另一类凭据，只用于读取某一枚调用密钥的剩余额度；系统兼容带或不带 `sk-`。也保留密码登录回退。
- Sub2API：支持 Access Token、Refresh Token 和密码登录；遇 CF 同样先过盾，失败回退 AT/RT。
- 自定义站点：可以配置用户接口路径和余额 JSON 字段。
- 转换器：只允许变量 `x`、数字、括号和 `+ - * /`。
- 告警闭环：低余额建单、通知去重、手动充值、连续恢复确认、自动结单。
- 通知：Resend 邮件、飞书群机器人 Webhook。
- 安全：首次自定义管理员用户名、bcrypt 强密码、Cloudflare Turnstile、TOTP 两步验证、一次性恢复码；上游凭据继续使用 AES-256-GCM 加密。

## 本地运行

```bash
npm install
npm run dev
```

前端开发地址为 `http://localhost:5173`，后端接口为 `http://localhost:8787`。

生产模式：

```bash
npm run build
npm start
```

访问 `http://localhost:8787`。

## Docker 部署

1. 将 `.env.example` 复制为 `.env`。
2. 至少更换 `MASTER_KEY` 和 `SESSION_SECRET`。`ADMIN_PASSWORD` 留空时首次打开面板完成管理员初始化。
3. 启动服务：

```bash
docker compose up -d --build
```

数据保存在 Docker 卷 `frosted-data` 中。生产环境建议通过 Caddy、Nginx 或 Tailscale 提供 HTTPS 和访问限制。

## 面板登录安全

- 首次打开时自拟管理员用户名，页面默认生成满足复杂度要求的强密码。
- 在 Cloudflare Turnstile 创建站点后，填写 `DASHBOARD_TURNSTILE_SITE_KEY` 和 `DASHBOARD_TURNSTILE_SECRET_KEY`，登录和首次初始化会自动启用人机验证。
- 登录后进入“系统设置 → 账户安全”扫描二维码启用 TOTP，并离线保存一次性恢复码。
- 反向代理部署时设置 `APP_ORIGIN=https://你的域名`；仅在可信代理后方设置 `TRUST_PROXY=true`。

## 转换公式示例

```text
x                         # 原始值已经是人民币
x * 7.2                   # 美元按固定汇率折算
x / 500000 * 7.2          # New API 内部 quota 折算
(x - 5) * 7.2             # 扣除不可用额度后折算
```

系统同时保存原始余额和折算人民币余额。告警阈值、趋势和事件结单均使用折算人民币余额。

## 站点接入建议

- 需要监控整个 New API 用户账户余额时，使用“个人资料 → 安全 → 访问令牌”生成的用户访问令牌，并填写账户 User ID；令牌按页面显示的原始值提交，不加 `Bearer` 或 `sk-`。
- 只监控某一枚调用密钥额度时，使用左侧“API 密钥”创建的有限额度密钥；无限额度密钥无法返回可监控的有限余额。两类凭据用途不同，不应混填。
- Sub2API 推荐保存 Access Token + Refresh Token；密码用于 token 全部失效时的回退登录。
- 不要在多个上游站点复用同一个密码。
- `MASTER_KEY` 丢失后无法解密已有凭据，部署时必须妥善备份。

## Sub2API Turnstile 自动过盾

部分 Sub2API 站点在 `/api/v1/auth/login` 上启用了 Cloudflare Turnstile。霜镜会在密码登录时：

1. 先尝试直接登录（无盾站点可立即拿到 AT/RT）。
2. 若上游返回 Turnstile 相关错误，启动自动过盾。
3. 成功后持久化新的 Access / Refresh Token。

### 默认：浏览器 DOM 识别 + 模拟真实操作（推荐）

```bash
TURNSTILE_SOLVER=browser
TURNSTILE_HEADLESS=true   # 调试时可改为 false 观察页面
```

首次使用需安装 Chromium：

```bash
npm install
npx playwright install chromium
```

浏览器模式会：

- 打开上游登录页，识别 `.cf-turnstile`、Cloudflare iframe、隐藏 token 输入框等 DOM
- 模拟鼠标移动、滚动、点击复选框、填入邮箱密码并提交
- 优先拦截登录接口响应拿到 AT/RT；否则提取 `cf-turnstile-response` 后再走 API 登录

### 备选：第三方打码

```bash
TURNSTILE_SOLVER=capsolver
CAPSOLVER_API_KEY=your-capsolver-key

# 或
# TURNSTILE_SOLVER=2captcha
# TWOCAPTCHA_API_KEY=your-2captcha-key
```

关闭自动过盾：`TURNSTILE_SOLVER=none`，改为人工粘贴 AT/RT 或一次性 Turnstile Token。

## 验证

```bash
npm test
npm run build
```
