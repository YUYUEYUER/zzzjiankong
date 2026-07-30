# 霜镜

霜镜是一套可私有部署的上游余额监控面板。它登录你拥有的 New API、Sub2API 或兼容站点账号，读取原始余额，通过四则运算公式转换为人民币，并在低余额时通过 Resend 或飞书告警。你手动充值后，系统连续两次检测到恢复会自动发送恢复通知并结单。

![上游余额监控面板总览](docs/images/01-dashboard.png)

> 文档截图由隔离的本地样本数据生成，只使用虚构账号、掩码 Key 与 `example.com` 域名，不包含真实商家、账号、余额、令牌或通知地址。

## 图文快速上手

### 1. 启动并登录面板

安装依赖、构建前端并启动服务：

```bash
npm install
npm run build
npm start
```

打开 `http://localhost:8787`。首次运行时自拟管理员用户名，并使用页面生成的强密码完成初始化；以后使用该管理员账号登录。

![管理员登录](docs/images/00-login.png)

### 2. 创建上游

点击右上角 **添加上游**，填写便于自己识别的名称，例如 `newapi` 或 `sub2api`。默认使用服务器直连；已经在系统设置中导入 Clash 订阅时，也可以启用自动优选并固定出口。

![添加上游](docs/images/02-add-upstream.png)

创建后会自动进入添加账号流程。也可以随时点击某个上游右侧的 **+** 添加更多账号。

### 3. 添加监控账号

选择平台并填写上游地址。优先使用上游官方令牌，避免依赖账号密码登录。

| 平台 | 推荐凭据 | 适用范围 |
| --- | --- | --- |
| New API | 个人资料中的账户访问令牌 + User ID | 读取账户总余额，并列出 Key 用量与分组倍率 |
| New API | API Key | 只监控该 Key 的有限额度 |
| Sub2API | `sk-` API Key | 通过 `/v1/usage` 读取该 Key 的余额与倍率 |
| Sub2API | 登录态 JSON 或内置浏览器登录 | 读取账户余额、全部分组倍率及 Key 列表 |

Sub2API 提供三种接入方式：直接填写 API Key、导入登录态 JSON，或点击 **打开内置浏览器登录**。浏览器方式会打开独立的系统 Chrome；你正常完成 Cloudflare 验证与登录后，AT/RT 或会话 Cookie 会写入应用的加密凭据库。独立 Chrome 配置目录仍可能保留浏览器原生 Cookie、LocalStorage 与缓存，具体边界见下方“浏览器会话数据”。

![添加 Sub2API 监控账号](docs/images/03-add-sub2-account.png)

点击 **测试连接** 确认余额能够读取，再点击 **添加账号**。快速添加默认使用以下配置：

- 余额低于 `¥10` 建立告警。
- 每 `5` 分钟检测一次。
- 余额恢复到 `¥15` 后开始恢复确认。
- Resend 与飞书按各自启用状态发送通知。

需要修改接口路径、余额字段、换算公式或阈值时，点击 **高级设置**。

![余额转换公式与告警阈值](docs/images/06-converter.png)

图中示例把 New API quota 按 `x / 500000 * 1` 转换为人民币，并设置 `¥10` 触发、`¥15` 恢复。实际接入时应按上游返回值的单位调整公式；先点击 **测试公式**，确认结果后再保存。

### 4. 查看余额、倍率和 Key

主页面按上游汇总人民币余额。点击账号条幅展开详情，可查看：

- Sub2API 全部分组的基础倍率、账号专属倍率、峰值倍率和当前有效倍率。
- 每个 API Key 的掩码标识、剩余额度、已使用额度、所属分组与倍率。
- New API 账户访问令牌能够读取到的 Key 用量和分组信息。

![查看分组倍率和 API Key](docs/images/04-rates-and-keys.png)

页面和接口不会返回完整 API Key。应用凭据字段在后端加密保存，详情中始终使用掩码显示；持久 Chrome 配置目录属于单独的浏览器会话存储，不在这项加密承诺内。

### 5. 配置通知与自动结单

点击右上角齿轮进入 **通知与结单**：

1. 配置 Resend 发件人、收件人和 API Key，然后单独测试邮件链路。
2. 配置飞书群机器人 Webhook，然后单独测试飞书链路。
3. 保存恢复确认次数和未恢复重复提醒周期。
4. 余额低于阈值时系统自动建单；手动充值后，连续检测达到恢复阈值便发送恢复通知并结单。

![配置 Resend、飞书与自动结单](docs/images/05-notifications.png)

Resend 和飞书独立记录结果：一个渠道失败不会覆盖另一个渠道的成功状态。

## 核心能力

- New API：默认使用“个人资料 → 安全 → 访问令牌”生成的用户访问令牌，配合 User ID 免登录读取整个账户余额。左侧“API 密钥”用于读取单枚调用密钥的余额；配合用户访问令牌还能自动定位该 Key 的分组倍率。系统兼容带或不带 `sk-`，也保留密码登录回退。
- Sub2API：优先支持用户生成的 `sk-` API Key，通过 `/v1/usage` 免登录读取钱包、订阅或密钥剩余额度，并通过 `/v1/sub2api/billing` 读取该 Key 的当前有效倍率；同时保留 Access Token、Refresh Token 和密码登录链路。
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
2. 至少更换 `MASTER_KEY` 和 `SESSION_SECRET`，并保持 `SEED_DEMO=false`。`ADMIN_PASSWORD` 留空时首次打开面板完成管理员初始化。
3. 启动服务：

```bash
docker compose up -d --build
```

运行镜像与项目的 Playwright `1.61.1` 版本严格匹配，内置 Chromium 及系统依赖；入口只以 root 修正旧数据卷权限，随后立即降权到 `pwuser`。Compose 同时加载 Playwright 官方同版本的 seccomp profile，以支持非 root Chromium sandbox。Compose 模式适合无头验证，不提供 VNC；需要人工接管时请在有 GUI/X11/VNC 的受控主机运行并设置 `TURNSTILE_HEADLESS=false`。

数据保存在 Docker 卷 `frosted-data` 中。服务器需允许访问上游域名、`challenges.cloudflare.com`，以及你启用的 Resend/飞书/第三方解题服务。生产环境建议通过 Caddy、Nginx 或 Tailscale 提供 HTTPS 和访问限制。账号凭据锁目前是单进程锁，不要为同一数据卷同时启动多个应用副本。

### 浏览器会话数据

应用数据库中的上游凭据使用 AES-256-GCM 加密；交互登录使用的 Chrome 配置目录位于 `data/upstream-browser-profiles/<站点哈希>-system-chrome/`，其中的 Cookie、LocalStorage 和缓存由 Chrome 自己管理，不再经过应用层加密。`data/` 默认不会进入 Git，但部署时仍应：

- 只允许应用运行用户访问数据目录，并保护磁盘快照、Docker 卷备份和迁移包。
- 不把浏览器配置目录同步到公开对象存储、日志平台或代码仓库。
- 账号授权撤销后，同时在上游注销会话；确认不再复用任何浏览器登录态时，停止服务并删除 `data/upstream-browser-profiles/`。

## 面板登录安全

- 首次打开时自拟管理员用户名，页面默认生成满足复杂度要求的强密码。
- 在 Cloudflare Turnstile 创建站点后，填写 `DASHBOARD_TURNSTILE_SITE_KEY` 和 `DASHBOARD_TURNSTILE_SECRET_KEY`，登录和首次初始化会自动启用人机验证。
- 登录后进入“系统设置 → 账户安全”扫描二维码启用 TOTP，并离线保存一次性恢复码。
- 反向代理部署时设置 `APP_ORIGIN=https://你的域名`；仅在可信代理后方设置 `TRUST_PROXY=true`。

## 转换公式示例

```text
x                         # 原始值已经是人民币
x * 7.2                   # 美元按固定汇率折算
x / 500000 * 1            # New API 内部 quota 按当前默认规则折算
(x - 5) * 7.2             # 扣除不可用额度后折算
```

系统同时保存原始余额和折算人民币余额。告警阈值、趋势和事件结单均使用折算人民币余额。

## 站点接入建议

- 需要监控整个 New API 用户账户余额时，使用“个人资料 → 安全 → 访问令牌”生成的用户访问令牌，并填写账户 User ID；令牌按页面显示的原始值提交，不加 `Bearer` 或 `sk-`。
- 只监控某一枚 New API 调用密钥额度时，使用左侧“API 密钥”创建的有限额度密钥；无限额度密钥无法返回可监控的有限余额。若还要读取该 Key 创建时选择的分组倍率，需要额外填写用户访问令牌与 User ID；辅助令牌只访问 Key 列表和用户分组接口，不参与 Key 余额鉴权。
- Sub2API 新版优先使用“API 密钥”页面生成的 `sk-` 调用令牌；官方 `/v1/usage` 返回 USD `remaining`，默认用 `x * 7.2` 折算人民币。有限密钥读取密钥额度，钱包模式读取账户余额，订阅模式读取当前周期最小剩余额度；`/v1/sub2api/billing` 同时返回分组倍率、用户覆盖倍率、峰值倍率和最终有效倍率。无限订阅无法形成有限余额告警。
- 旧版 Sub2API 或需要监控用户资料接口时，继续保存 Access Token + Refresh Token；密码用于 AT/RT 全部失效后的回退登录。
- 不要在多个上游站点复用同一个密码。
- `MASTER_KEY` 丢失后无法解密已有凭据，部署时必须妥善备份。

## Clash 代理出口

Docker Compose 会启动一个仅在内部网络可见的 Mihomo 服务。先在 `.env` 设置强随机 `MIHOMO_SECRET`，再到“系统设置 → 代理池”导入 HTTPS Clash 订阅。订阅地址使用 AES-256-GCM 加密保存，界面和日志不会回显完整地址。

- 节点只按可用性与延迟排序，不把登录、Turnstile、401 或 403 结果计入质量评分。
- 代理在“上游”层启用；同一上游的所有账号共用一个固定节点和独立 HTTP listener。
- 余额 API、站点探测和 Chromium 验证复用同一出口；采集或登录进行中禁止重新分配节点。
- 订阅更新先在临时配置中完成加载与健康检查，失败会恢复旧订阅、节点分配和运行配置。
- 更新订阅不会主动切换仍然可用的固定节点；可在上游编辑弹窗手动“重新分配”。
- Mihomo 控制端口和代理端口不映射到宿主公网；Compose 会等待其健康检查通过，应用也会自动退避重试同步。

本地非 Docker 运行时，需要自行启动 Mihomo，并配置 `MIHOMO_CONTROLLER_URL`、`MIHOMO_SECRET`、`MIHOMO_SHARED_DIR`、`MIHOMO_RUNTIME_PATH` 和 `UPSTREAM_PROXY_HOST`。动态代理 listener 与控制器默认只绑定 `127.0.0.1`；不要在没有防火墙和访问控制时改为公网地址。

## 上游 Cloudflare / Turnstile 处理

Cloudflare Turnstile token 只有 5 分钟有效期、只能验证一次，并且必须由目标站点服务端校验。霜镜因此采用分层认证状态机，不缓存或重放挑战 token：

```mermaid
flowchart LR
  A[正式 API / Access Token] -->|不可用| B[已验证浏览器会话]
  B -->|失效| C[直接密码登录]
  C -->|检测到挑战| D[真实 Chromium 页面流程]
  D --> E{同一浏览器内验真}
  E -->|明确返回 AT/RT| F[加密保存 AT/RT]
  E -->|资料接口成功| G[加密保存会话]
  E -->|交互挑战| H[可见浏览器人工接管]
  E -->|失败| I[保留旧凭据并报告原因]
```

检测同时覆盖 Cloudflare 官方的 `cf-mitigated: challenge` 响应头、上游 JSON 错误以及 HTML 挑战页。普通 403/429 不会仅凭状态码被误判为 Turnstile。

### New API 的两层防护位置

- **New API 原生 Turnstile**：公开 `/api/status` 通过 `turnstile_check` 与 `turnstile_site_key` 暴露当前开关；官方中间件保护 `/api/user/login`、注册、邮箱验证、重置密码和签到等接口。登录 token 必须按官方协议放在 `?turnstile=...` 查询参数中，霜镜同时保留常见二改站点的请求体字段兼容。
- **站点外层 Cloudflare WAF / Managed Challenge**：不属于 New API 固定路由，可按 IP、频率和规则动态出现在状态、登录、个人资料或令牌接口。霜镜因此在所有上游 JSON 请求上统一检测挑战响应，而不是只检查登录接口。

正式监控仍优先使用 New API 的个人访问令牌与 User ID；原生 Turnstile 或外层 WAF 被触发时再进入浏览器状态机。

### 默认：真实 Chromium 页面流程

将以下配置写入 `.env`：

```dotenv
TURNSTILE_SOLVER=browser
TURNSTILE_HEADLESS=false  # 可见浏览器；无桌面服务器运行自动流程时设为 true
TURNSTILE_DISABLE_BROWSER_SANDBOX=false
```

Docker 镜像已内置 Chromium。裸机首次使用时先安装依赖：

```bash
npm install
```

Windows 或 macOS：

```bash
npx playwright install chromium
```

Linux：

```bash
npx playwright install --with-deps chromium
```

浏览器模式会：

- 打开上游登录页，识别 `.cf-turnstile`、Cloudflare iframe、隐藏 token 输入框等 DOM
- 填入账号密码并完成页面原有的验证与登录流程
- 只接受明确的 `access_token` / `refresh_token`；不会把 2FA 或会话用的通用 `data.token` 当成 AT
- 登录请求一旦提交便把挑战 token 标记为已消费，禁止后端再次重放
- New API 会在同一个浏览器上下文调用资料接口验真，再加密保存会话 Cookie 与对应 User-Agent
- Sub2API 在拿到新 AT/RT 后立即建立凭据检查点，即使随后余额接口故障也不会丢失轮换后的 RT
- 浏览器任务进入有界 worker 队列，面板状态包含 worker、active、queued、成功/失败和平均耗时；队列满时快速失败而不是拖垮服务器
- Docker 启动时会以 `pwuser` 实际启动并关闭一次 Chromium，提前暴露浏览器或 sandbox 配置错误

服务器上的交互式挑战可能无法在无头模式完成。此时错误会明确标记为“需要人工交互”；将 `TURNSTILE_HEADLESS=false` 后，可在有桌面环境的受控机器上完成一次验证，后续轮询优先复用已验证会话。Chromium sandbox 默认开启；只有在隔离、低权限容器确实无法启用时才设置 `TURNSTILE_DISABLE_BROWSER_SANDBOX=true`。

### 长期稳定路径

1. **New API 正式令牌**：优先使用“个人资料 → 安全 → 访问令牌”与 User ID。这类令牌不同于左侧“API 密钥”。密码登录通常只建立会话；除非上游明确返回 `access_token`，霜镜不会声称自动生成了个人访问令牌。
2. **Sub2API API Key**：使用用户侧 `sk-` 调用令牌访问 `/v1/usage` 和 `/v1/sub2api/billing`，不经过网页登录；多个密钥支持固定槽位故障切换或轮询调度。
3. **Sub2API AT/RT**：旧站继续保存 Access Token + Refresh Token，系统会按 JWT 或上游返回的过期时间提前续期并保存轮换结果。
4. **浏览器会话复用**：适合登录受 Turnstile 保护、资料接口本身允许会话访问的 New API 二改站点。
5. **人工接管**：交互挑战、设备确认或站点额外 2FA 出现时，使用可见浏览器完成一次授权，而不是无限重试。
6. **自管上游 Cloudflare**：为监控服务器使用固定出口 IP，并通过窄范围 WAF Skip 规则只放行指定主机、路径和来源；或在账号“高级设置”填写 Cloudflare Access Service Token。两个 Access 请求头只会发送到当前上游同源地址，不会发送给挑战 iframe。不要全站关闭防护，也不要放行动态公网 IP。

Cloudflare 官方参考：[服务端验证与 token 生命周期](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[识别挑战页响应](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/)、[WAF Skip 规则](https://developers.cloudflare.com/waf/custom-rules/skip/)、[Access Service Token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)。

### 备选：第三方打码

将所选服务写入 `.env`：

```dotenv
TURNSTILE_SOLVER=capsolver
CAPSOLVER_API_KEY=your-capsolver-key

# 或
# TURNSTILE_SOLVER=2captcha
# TWOCAPTCHA_API_KEY=your-2captcha-key
```

第三方服务会接触目标站点 URL、sitekey 和解题任务元数据，使用前应确认上游条款与数据边界。关闭自动处理：`TURNSTILE_SOLVER=none`，改为正式令牌、人工完成浏览器验证或粘贴一次性 Turnstile Token。

## 公开仓库脱敏检查

仓库已经忽略 `.env`、`data/`、`design/` 与日志文件。公开或推送仓库前仍需检查以下内容：

- 不要提交 `.env`、数据卷备份、Clash 订阅、服务日志或浏览器用户目录。
- Sub2API 登录态 JSON 含 AT/RT，导入后应从下载目录删除；默认文件名 `sub2api-session-*.json` 已加入 `.gitignore`，但仍不应长期保留。
- 截图只能使用隔离样本；完整 API Key、邮箱、真实域名、Webhook、二维码和余额均应替换或遮盖。
- 不要把真实令牌写入 issue、提交信息、测试夹具、命令历史或 README 示例。
- `docs/images/` 仅存放可公开的脱敏图片；`design/` 用于本机设计过程且不会进入 Git。

推送前至少执行：

```bash
git status --short
git diff --check
git grep -n -I -E '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9_-]{20,}|/hook/[A-Za-z0-9-]{20,})'
```

最后一条命令没有输出代表未命中这些常见格式，但仍需人工检查域名、邮箱、无固定前缀的访问令牌和图片内容。

## 验证

```bash
npm test
npm run build
```
