# “霜镜”生产发布全局审查报告

审查对象：当前工作区中的实际代码、配置、测试与部署脚本。审查日期：2026-07-30。以下先列问题，后列架构、攻击面、有效控制、盲区、整改清单与发布结论。

## P0

### P0-01 首次初始化接口在公网暴露，首个请求可接管唯一管理员

- **位置**：[`.env.example`](.env.example#L9)、[`deploy-linux.sh`](deploy-linux.sh#L20)、[`deploy-linux.sh`](deploy-linux.sh#L50)、[`server/index.js`](server/index.js#L408)、[`server/index.js`](server/index.js#L415)、[`docker/Caddyfile`](docker/Caddyfile#L30)。
- **证据**：部署脚本从 `.env.example` 生成 `.env`，但没有生成 `ADMIN_PASSWORD`；空密码使服务进入首次设置状态。全新生产容器中，并发向 `/api/session/setup` 提交两个不同管理员，返回 `201` 与 `409`，`201` 请求中的 `RemoteFirst` 成为管理员且立即获得有效会话。Caddy 将该接口作为普通应用路径公开。
- **攻击路径或故障过程**：运维执行部署脚本并完成 DNS/TLS 后，应用在未初始化状态对公网可达；攻击者先于运维调用设置接口，设置用户名、密码和二次验证状态；随后登录并读取账号凭据、打开远程桌面、控制持久化浏览器资料。
- **影响范围和最坏结果**：平台完全失陷；所有上游 Token、Cookie、LocalStorage、通知密钥、代理订阅及浏览器会话均处于攻击者控制下。严重度为 P0，因为默认部署路径直接形成未认证远程接管。
- **最小复现步骤**：以空 `ADMIN_PASSWORD` 和全新数据卷启动；并发发送两个 `POST /api/session/setup`；观察一个请求获得 `201` 和会话 Cookie；使用该 Cookie 请求 `/api/dashboard` 得到 `200`。
- **根因**：初始化身份建立被设计为公开的“先到先得”事务，部署流程没有一次性引导令牌、控制台内初始化或预置管理员密码，也没有在初始化完成前阻断公网入口。
- **推荐修复**：部署时强制生成高熵一次性 `BOOTSTRAP_TOKEN`，只通过本机控制台输出；设置接口同时要求该令牌并使用原子 compare-and-set；更稳妥的是部署脚本离线创建管理员后才启动 Caddy。初始化完成后永久禁用该路由，并记录审计事件。
- **必须新增的回归测试**：无令牌、错误令牌、重复令牌均失败；两个并发正确请求只能有一个提交且失败请求不会破坏存储队列；未初始化实例经 Caddy 不能访问除健康检查外的任何路径；初始化后路由返回 `404/410`。

## P1

### P1-01 任一写事务异常会永久毒化 JSON 存储队列并产生内存/磁盘分叉

- **位置**：[`server/store.js`](server/store.js#L243)、[`server/store.js`](server/store.js#L250)、[`server/index.js`](server/index.js#L1111)。
- **证据**：`mutate()` 将新事务直接接到 `this.queue.then(...)`，既未从前一次 rejection 恢复，也在持久化成功前直接修改活动对象。隔离实例中，认证后请求不存在事件的 acknowledge 接口得到 `500 事件不存在`；随后创建上游和修改设置均继续返回相同 `500`，后续 mutator 没有执行。模拟 `ENOSPC` 时，内存值已变更而磁盘值仍为旧值，后续事务仍被相同 rejection 阻断。
- **攻击路径或故障过程**：合法管理员提交触发业务异常的请求，或磁盘短暂满/权限异常；Promise 队列进入 rejected 状态；此后所有写操作继承旧异常，服务看似存活但不能恢复；若 mutator 已改内存，API 读与重启后的磁盘状态不一致。
- **影响范围和最坏结果**：所有配置、余额、事件、通知结果、凭据轮换停止持久化；重启导致已展示成功的数据回滚，监控和审计失真。并发首次设置中的失败者也可触发此路径。
- **最小复现步骤**：登录后 `POST /api/incidents/does-not-exist/acknowledge`；再 `POST /api/upstreams`；观察第二个请求复现第一个错误且数据未创建。
- **根因**：把串行化 Promise 本身当作持久队列状态，缺少 rejection 隔离；事务不在副本上执行，也没有原子替换文件。
- **推荐修复**：每次事务以 `this.queue.catch(() => undefined).then(...)` 启动；在深拷贝上执行 mutator，先写同目录临时文件并 `fsync`，原子 rename 成功后再交换内存状态；区分业务异常和持久化异常并暴露存储健康状态。
- **必须新增的回归测试**：mutator 抛错后下一事务仍成功；`ENOSPC/EACCES` 后内存与磁盘均保持旧值；进程在写入各阶段终止后文件仍可解析；并发事务保持顺序且不丢更新。

### P1-02 账号采集 URL 允许私网、明文 HTTP 和 userinfo，形成带凭据 SSRF 与凭据回显

- **位置**：[`server/index.js`](server/index.js#L121)、[`server/index.js`](server/index.js#L125)、[`server/collectors.js`](server/collectors.js#L15)、[`server/collectors.js`](server/collectors.js#L60)、[`server/collectors.js`](server/collectors.js#L96)、[`server/collectors.js`](server/collectors.js#L1651)、[`test/api-key-details.integration.test.js`](test/api-key-details.integration.test.js#L132)。
- **证据**：账号 schema 只要求通用 URL；collector 仅限制 `http/https`，同源重定向检查没有阻断私网、环回、链路本地、云元数据、IPv6 或解析变化，并将响应完整 `text()` 到内存。现有集成测试使用 `http://127.0.0.1` 并确认收到私有 `Authorization`。隔离 API 接受 `http://audit-user:audit-pass@frosted-audit-upstream:8080`，创建响应和 dashboard 均原样回显 userinfo。
- **攻击路径或故障过程**：有账号编辑权限的操作者把 `baseUrl` 指向容器网络服务、宿主网关或元数据地址；平台带 Bearer/Cookie/Cloudflare Access 头发起请求。使用 HTTP 时凭据以明文离开容器；利用超大或慢响应可进一步消耗内存和连接。
- **影响范围和最坏结果**：读取内部管理接口或云实例凭据、横向移动、向内部服务发送认证请求、泄露上游 Token，并可造成进程 OOM。URL userinfo 还会进入 API 状态和浏览器可见数据。
- **最小复现步骤**：在 Compose 网络启动记录请求头的本地 HTTP 服务；创建 `baseUrl=http://127.0.0.1:PORT` 或容器 DNS 地址的账号并测试；观察服务收到 Authorization，dashboard 回显 URL userinfo。
- **根因**：Clash 订阅已有的 SSRF 防护没有复用于账号采集；地址仅做语法和协议校验，缺少解析后网络策略、DNS 固定和响应上限。
- **推荐修复**：账号地址仅允许 HTTPS，拒绝 userinfo；对每次连接和每个重定向解析全部 A/AAAA，阻断 loopback、private、link-local、CGNAT、ULA、multicast、unspecified 和元数据网段；将解析结果固定到连接并校验证书主机名；配置显式出站 allowlist/egress firewall；流式读取并限制状态行、头、正文、总时长和低速率。
- **必须新增的回归测试**：覆盖 IPv4/IPv6 私网、整数/混合编码 IP、DNS 重绑定、CNAME、重定向到私网、userinfo、HTTP 降级、超大/慢响应；断言任何拒绝路径均未发送 Authorization/Cookie。

### P1-03 noVNC WebSocket 不校验 Origin，注销后既有远程桌面连接仍可控制浏览器

- **位置**：[`docker/Caddyfile`](docker/Caddyfile#L12)、[`docker/Caddyfile`](docker/Caddyfile#L13)、[`docker/Caddyfile`](docker/Caddyfile#L21)、[`server/index.js`](server/index.js#L489)。
- **证据**：`forward_auth` 只在 WebSocket 握手阶段检查会话，没有 Origin allowlist 或连接级撤销。使用有效会话 Cookie、`Origin: https://cross-site.example` 的手工 TLS WebSocket 握手返回 `101 Switching Protocols`。已建立 noVNC socket 后调用 logout 得到 `200`，1.5 秒后 socket 仍为 OPEN；同一旧 Cookie 的新连接会被拒绝。
- **攻击路径或故障过程**：攻击者从同站点边界内的恶意子域或已获 Cookie 的页面建立 noVNC socket；用户注销或管理员轮换会话后，Caddy 不再重新鉴权，存量双向连接继续传递键鼠与屏幕数据。
- **影响范围和最坏结果**：接管有头 Chromium，读取和操作同源持久化登录态，发起充值或账号操作。SameSite=Strict 只能缓解跨站请求，不能解决同站点恶意子域和已建立连接。
- **最小复现步骤**：登录并打开 `/browser/websockify`；调用 `/api/session/logout`；持续在原 socket 上发送 VNC 帧并确认连接未关闭；另以任意 Origin 和有效 Cookie 握手，观察 `101`。
- **根因**：把 HTTP 握手授权等同于 WebSocket 全生命周期授权，且未定义浏览器远程桌面的 Origin 与会话撤销协议。
- **推荐修复**：在 WebSocket 边界严格校验 `Origin` 与规范化外部 HTTPS origin；使用短期、一次性、绑定用户/会话版本/Origin 的 VNC ticket；注销、密码或 2FA 变更时主动关闭关联 socket；限制连接数、空闲时长和绝对时长。
- **必须新增的回归测试**：缺失/外站/同站恶意子域 Origin 均拒绝；合法 Origin 成功；logout、密码变更、会话版本提升后存量 socket 在限定时间内关闭；重连必须重新取 ticket。

### P1-04 浏览器资料按 Origin 全局共享，多个同源账号会串用身份

- **位置**：[`server/upstream-login.js`](server/upstream-login.js#L57)、[`server/upstream-login.js`](server/upstream-login.js#L61)、[`server/upstream-login.js`](server/upstream-login.js#L406)、[`server/upstream-login.js`](server/upstream-login.js#L414)、[`server/upstream-login.js`](server/upstream-login.js#L449)、[`server/index.js`](server/index.js#L525)、[`server/index.js`](server/index.js#L549)、[`server/index.js`](server/index.js#L1090)。
- **证据**：profile ID 是 `sha256(origin)`，`activeOrigins` 也只以 origin 为键；登录与“进入上游”都复用同一目录。账号保存的 `browserProfileId` 没有传入 open-upstream，删除账号也不删除或解除资料所有权。
- **攻击路径或故障过程**：同一 New API/Sub2API 域名下配置账号 A、B；B 执行浏览器登录后覆盖同一 profile 的 Cookie/LocalStorage；随后从 A 点击“进入上游”，实际进入 B 的登录态。并发操作还会互相阻塞或覆盖。
- **影响范围和最坏结果**：账号间越权、错误充值/消费、审计主体错配；删除账号后旧身份仍保留在数据卷中。
- **最小复现步骤**：为同一 origin 创建两个不同用户账号；分别登录并设置不同 LocalStorage 标识；从第一个账号进入上游，观察最后一次登录身份和标识。
- **根因**：把网络 origin 错当作账号/浏览器身份所有权主键，数据模型未建立 `Account -> BrowserProfile` 的一对一或显式共享关系。
- **推荐修复**：profile ID 至少绑定 account UUID 和 origin；open、login、删除、迁移都必须使用并校验账号拥有的 profile；需要共享时建立显式、可审计的 profile 实体和授权关系；删除使用可恢复的隔离区并清理敏感资料。
- **必须新增的回归测试**：两个同源账号的 Cookie、LocalStorage、缓存和锁完全隔离；移动/改 URL 后按策略迁移或新建；删除后不可再打开旧资料；同一账号重启容器后仍复用原身份且不产生第二设备资料。

### P1-05 测试账号和浏览器登录路径绕过上游固定代理，可能意外直连

- **位置**：[`src/quick-account.js`](src/quick-account.js#L111)、[`src/api.js`](src/api.js#L46)、[`server/index.js`](server/index.js#L836)、[`server/index.js`](server/index.js#L914)、[`server/index.js`](server/index.js#L525)、[`server/upstream-login.js`](server/upstream-login.js#L97)、[`server/collectors.js`](server/collectors.js#L2338)。
- **证据**：快速账号草稿发送空 `upstreamId`；`/api/accounts/test` 直接采集，没有先解析最终上游及其代理策略，保存时才补建/关联上游。浏览器登录与 open-upstream 参数也没有上游代理信息。隔离复现中，空 upstreamId 的测试直接命中本地服务；同一请求带 `auto_sticky` 上游后返回 `UPSTREAM_PROXY_NOT_READY` 且没有直连。
- **攻击路径或故障过程**：运维认为某上游强制经过 Mihomo，先在新增账号弹窗点击“测试”或发起浏览器登录；请求在账号正式关联前从主网络直接访问目标，暴露宿主出口 IP，并绕过审计和代理隔离。
- **影响范围和最坏结果**：真实出口、地域和账号关联泄露；受限网络策略失效；代理故障时行为不一致。
- **最小复现步骤**：配置 fixed/auto_sticky 上游且代理未就绪；对相同目标分别调用空 upstreamId 和正确 upstreamId 的账号测试；记录目标侧连接，前者直连成功而后者 fail-closed。
- **根因**：代理策略附着在 Upstream，但测试和浏览器 API 的请求契约允许在没有稳定 Upstream 身份时访问网络。
- **推荐修复**：任何出站操作必须先解析存在的 upstreamId，并统一进入单一 egress policy 层；强制代理模式下代理不可用必须 fail-closed；浏览器进程也应使用对应代理并限制 DNS/QUIC 旁路。
- **必须新增的回归测试**：采集测试、定时监控、登录、进入上游和重定向全部经过同一代理；代理停止时五条路径均不产生直连；DNS 查询和 IPv6/QUIC 也受代理策略约束。

### P1-06 通知没有持久化 outbox，进程崩溃或提供商超时会永久丢失状态通知

- **位置**：[`server/monitor.js`](server/monitor.js#L72)、[`server/monitor.js`](server/monitor.js#L103)、[`server/monitor.js`](server/monitor.js#L159)、[`server/monitor.js`](server/monitor.js#L174)、[`server/notifications.js`](server/notifications.js#L52)、[`server/notifications.js`](server/notifications.js#L83)、[`server/notifications.js`](server/notifications.js#L110)。
- **证据**：incident 的 opened/resolved 状态先在 store 事务中提交，事务返回后才 `sendTransition()`；发送结果又通过第二次事务记录。直接复现中，opened 状态提交后未调用发送，下一次同状态采集不再产生 transition；恢复后 incident 被结单，也没有补发缺失的 opened/recovered 通知。Resend/飞书 fetch 没有 AbortSignal，响应正文也不设上限。
- **攻击路径或故障过程**：容器在状态提交与发送之间重启，或通知端点保持慢连接；业务状态已经推进，后续轮询看不到新 transition，因此不会重试；慢请求还会占住监控任务。
- **影响范围和最坏结果**：低余额、恢复和自动结单通知静默丢失；SRE 误以为通知成功，造成余额耗尽或业务中断。
- **最小复现步骤**：调用 `applySuccess` 产生 opened transition，仅提交状态而跳过 `sendTransition`；再次提交相同余额；观察不再产生 opened；恢复余额后检查 notifications 仍缺记录。
- **根因**：状态机与外部副作用之间没有 transactional outbox、幂等键和可恢复派发器。
- **推荐修复**：在同一 store 事务中写 incident 与 outbox 事件；独立 worker 以稳定 event ID 幂等发送，持久化 attempt/nextAttempt/error/confirmedAt；使用有抖动的指数退避、超时、正文上限和死信状态。
- **必须新增的回归测试**：在提交后、发送前、发送后记录前分别模拟崩溃，重启后恰好完成一次逻辑通知；提供商 5xx、429、超时、超大响应均可重试且不阻塞监控；重复派发保持幂等。

### P1-07 跨实体检查与写入不在同一事务，能创建孤儿账号并使下次启动失败

- **位置**：[`server/index.js`](server/index.js#L778)、[`server/index.js`](server/index.js#L780)、[`server/index.js`](server/index.js#L922)、[`server/index.js`](server/index.js#L951)、[`server/index.js`](server/index.js#L1036)、[`server/index.js`](server/index.js#L1042)、[`server/index.js`](server/index.js#L1090)、[`server/monitor.js`](server/monitor.js#L53)、[`server/store.js`](server/store.js#L142)。
- **证据**：删除上游、创建/移动账号的存在性检查通过 `store.snapshot()` 在事务外完成，随后才排队写入；账号删除也未与正在运行的 monitor account lock 协调。并发隔离测试可让“删除上游”和“创建关联账号”都成功，最终 JSON 中账号引用已删除 upstream；下一次 `store.init()` 的外键校验拒绝该文件，应用不能启动。
- **攻击路径或故障过程**：两个正常管理请求在检查与提交窗口交错，或 monitor 正在采集时删除账号；不变量在写入时没有再次验证，持久化出非法图；重启时严格校验将故障从单个请求扩大为全站启动失败。
- **影响范围和最坏结果**：账号、快照、事件、通知与上游所有权错乱；重启后长时间停机，需要人工修复 JSON。
- **最小复现步骤**：为同一 upstream 并发执行 DELETE upstream 与 POST account；通过延迟让两个预检查都先通过；检查 JSON 中孤儿 `upstreamId`，重启并观察初始化失败。
- **根因**：JsonStore 只提供串行写函数，没有在事务副本内统一执行读取、约束验证和写入，也没有领域级锁顺序。
- **推荐修复**：所有存在性、唯一性和级联规则都在同一个 `mutate` 副本内检查；提交前执行完整 schema/FK 校验；定义 upstream/account/browser/monitor 锁顺序；提供损坏文件隔离和只读恢复启动模式。
- **必须新增的回归测试**：并发创建/删除、移动/删除、采集/删除、凭据轮换/测试的交错测试；任意成功提交后完整模型校验均通过；重启可读取最后一次成功提交。

### P1-08 不同 Origin 可无限创建有头 Chromium 任务，且任务/Compose 均无资源上限

- **位置**：[`server/upstream-login.js`](server/upstream-login.js#L10)、[`server/upstream-login.js`](server/upstream-login.js#L13)、[`server/upstream-login.js`](server/upstream-login.js#L403)、[`server/upstream-login.js`](server/upstream-login.js#L446)、[`server/upstream-login.js`](server/upstream-login.js#L483)、[`server/upstream-login.js`](server/upstream-login.js#L499)、[`docker-compose.yml`](docker-compose.yml#L1)。
- **证据**：并发限制只由 `activeOrigins` 实现，因此每个不同 origin 都可启动一个 Chromium。captured job 的 TTL 只在查询 job 时检查；browse job 的 `expiresAt` 为空且没有定时回收。Compose 没有 pids、内存、CPU、连接或磁盘配额。
- **攻击路径或故障过程**：认证会话批量提交不同域名的登录/浏览任务；每个任务创建浏览器进程、profile、CDP 与 VNC 可见页面；不查询旧 job 即不触发回收，直至容器或宿主耗尽资源。
- **影响范围和最坏结果**：Node、Chromium、Xvfb 或整个宿主 OOM/进程耗尽；JSON 写入和监控被连带终止，持久卷缓存持续增长。
- **最小复现步骤**：循环为不同 `https://host-N.invalid` 发起登录任务；统计 Chromium PID、job Map、profile 目录和内存；观察数量随 origin 线性增长且 browse job 不自动过期。
- **根因**：资源治理以 origin 去重代替全局/用户配额，生命周期清理由读取请求驱动，部署层没有第二道资源边界。
- **推荐修复**：建立全局和每用户队列、最大活动/排队数、绝对 TTL 和 finally 回收；单浏览器复用受控 context 或使用专用 worker 池；设置 Compose `pids_limit`、memory/cpu、ulimit、磁盘配额和监控告警。
- **必须新增的回归测试**：超过配额返回 `429/503`；客户端失联、任务未查询、启动失败和容器重建都回收进程/锁；压力测试证明资源稳定且监控仍按时运行。

### P1-09 高频快照导致整文件重写和整表下发，单账号即可产生不可接受的 I/O 与带宽

- **位置**：[`server/index.js`](server/index.js#L140)、[`server/monitor.js`](server/monitor.js#L116)、[`server/monitor.js`](server/monitor.js#L117)、[`server/store.js`](server/store.js#L239)、[`server/store.js`](server/store.js#L253)、[`server/index.js`](server/index.js#L287)、[`src/App.jsx`](src/App.jsx#L83)。
- **证据**：允许 1 分钟轮询并保留 90 天快照，即每账号 129,600 行。按当前字段构造的紧凑样本约 23.11 MiB；每次写入会 clone 并重写完整 JSON，dashboard 又返回全部 snapshots，前端每 30 秒刷新。单账号理论下行约 65 GiB/天，尚未计 pretty-print、HTTP/TLS 和多账号放大。
- **攻击路径或故障过程**：配置一个 1 分钟账号并长期运行；JSON 与响应持续增长；每个采集写放大，多个在线页面重复下载历史；事件循环、磁盘和网络逐步饱和，写失败后进一步触发 P1-01。
- **影响范围和最坏结果**：监控延迟、UI 卡死、备份窗口失控、磁盘耗尽、数据文件损坏或服务不可用。
- **最小复现步骤**：生成 129,600 条单账号快照，调用 dashboard 并记录 payload、序列化时间和内存；以 30 秒频率请求计算日流量；执行一次 mutate 记录写入字节数。
- **根因**：时间序列、配置和事件共用单个 JSON 文档，API 没有分页/聚合，UI 无条件轮询整个状态。
- **推荐修复**：将快照/事件迁移到支持事务和索引的数据库；按账号和时间索引，服务器聚合与分页；dashboard 仅返回当前状态和增量游标；设置 retention、压缩/降采样、配额和磁盘水位保护。
- **必须新增的回归测试**：以目标生产账号数和 90 天数据做容量基准；断言 dashboard payload 上限、分页稳定性、写放大、p95 延迟、磁盘水位降级与 retention 正确。

### P1-10 只有单份数据卷和单版本主密钥，丢卷或丢密钥均不可恢复

- **位置**：[`server/security.js`](server/security.js#L6)、[`server/security.js`](server/security.js#L53)、[`server/security.js`](server/security.js#L64)、[`server/store.js`](server/store.js#L223)、[`server/store.js`](server/store.js#L253)、[`docker-compose.yml`](docker-compose.yml#L47)、[`docker-compose.yml`](docker-compose.yml#L75)、[`deploy-linux.sh`](deploy-linux.sh#L1)。
- **证据**：所有密文使用同一个由 `MASTER_KEY` 派生的 AES-256-GCM key，密文没有 key ID/版本和双读机制。正常持久化覆盖单一 JSON；仅迁移场景产生局部备份。Compose 只有本机 named volume，部署脚本没有定时备份、离站复制、校验、恢复演练或密钥轮换命令。
- **攻击路径或故障过程**：误删/损坏卷导致全部配置、事件和凭据消失；`.env` 丢失或密钥误轮换导致所有凭据认证解密失败；没有受支持的回退或批量重加密流程。
- **影响范围和最坏结果**：平台数据永久丢失，所有上游账号需要人工重建；若旧密钥泄露，又不能平滑重加密和撤销。
- **最小复现步骤**：复制数据文件，使用不同 MASTER_KEY 启动；读取任一密文时报认证失败；检查仓库部署产物，找不到完整备份/恢复与 key-version 流程。
- **根因**：数据卷被当作备份，密钥被当作不可变配置，没有定义 RPO/RTO、密钥生命周期和灾难恢复责任边界。
- **推荐修复**：制定并实现加密、版本化、离站备份；周期性完整备份和可验证增量；密文封装 `keyId/version`，支持 active+previous key 双读及后台重加密；密钥进入独立 secret manager/KMS；提供自动化恢复演练和完整性报告。
- **必须新增的回归测试**：空机恢复到指定 RPO；旧/新密钥混合数据可读并完成轮换；错误密钥不覆盖原数据；备份损坏被检测；定期恢复演练满足目标 RTO。

## P2

### P2-01 当前前端缺失账号迁移/删除等完整生命周期入口，硬删除又不可撤销

- **位置**：[`src/api.js`](src/api.js#L44)、[`src/api.js`](src/api.js#L45)、[`src/App.jsx`](src/App.jsx#L240)、[`src/components/AccountModal.jsx`](src/components/AccountModal.jsx#L523)、[`src/components/StatusDashboard.jsx`](src/components/StatusDashboard.jsx#L224)、[`server/index.js`](server/index.js#L1090)。
- **证据**：API 客户端声明了 move/delete，但当前 React 组件图中没有调用；账号弹窗底部只有测试、取消、保存。历史只截取前 12 条，没有搜索、分页或完整筛选。后端删除账号会同步移除其快照/事件且没有回收站、导出确认或可恢复审计载荷。
- **攻击路径或故障过程**：运维无法从现有页面完成迁移、删除和部分通知控制，只能绕过 UI 调 API；误删后历史和证据立即消失。禁用账号时旧的绿色状态仍保留，容易误判为正在监控。
- **影响范围和最坏结果**：生产操作不完整、误操作概率上升、审计与余额历史不可恢复，停用账号状态误导值班人员。
- **最小复现步骤**：启动现有前端，打开账号编辑和状态历史；确认无迁移/删除入口且历史最多 12 条；调用 DELETE 后刷新，相关历史全部消失。
- **根因**：后端能力与当前主 UI 路由脱节，数据生命周期没有软删除、保留和审计模型。
- **推荐修复**：补齐迁移、禁用、软删除、恢复、凭据清除、通知覆盖等工作流；危险操作使用明确对象名确认并记录不可变审计；禁用状态单独展示；历史使用服务端分页和筛选。
- **必须新增的回归测试**：Playwright 覆盖创建、编辑、迁移、禁用、软删除、恢复、凭据轮换和筛选；验证误操作确认、权限、审计、历史保留及移动端布局。

### P2-02 上游名称不唯一且未知名称会隐式创建，账号可关联到错误代理边界

- **位置**：[`server/index.js`](server/index.js#L173)、[`server/index.js`](server/index.js#L701)、[`server/index.js`](server/index.js#L734)、[`server/index.js`](server/index.js#L922)、[`server/index.js`](server/index.js#L929)、[`server/index.js`](server/index.js#L951)。
- **证据**：名称查找返回第一个规范化匹配项，但创建/更新上游不强制 canonical name 唯一；账号只提供名称且匹配不到时会静默创建 direct 上游。快速账号路径正会发送空 upstreamId 和自由文本名称。
- **攻击路径或故障过程**：存在大小写、全角/半角或空白等规范化后重名的上游；账号创建按名称命中列表中的第一个对象，或拼写错误生成 direct 上游，从而使用错误代理、聚合和通知配置。
- **影响范围和最坏结果**：余额归属错误、代理策略绕过、删除/迁移对象不确定、审计显示与实际对象不一致。
- **最小复现步骤**：创建两个规范化后同名上游，再用该名称和空 upstreamId 创建账号；观察账号绑定第一个对象；提交轻微拼写差异，观察自动生成 direct 上游。
- **根因**：可变展示名称同时承担用户输入和外键解析职责，且隐式创建改变安全策略。
- **推荐修复**：所有账号写操作必须使用 UUID；数据库/事务层对 canonical name 加唯一约束；移除隐式创建，要求显式确认新建上游及其代理模式。
- **必须新增的回归测试**：Unicode NFKC、大小写、前后空白重名均返回 `409`；未知 UUID/名称失败且不产生新对象；重命名不改变已有外键。

### P2-03 同一 TOTP 时间步可重复验证，缺少重放状态

- **位置**：[`server/security.js`](server/security.js#L170)、[`server/security.js`](server/security.js#L172)、[`server/index.js`](server/index.js#L475)。
- **证据**：验证函数只调用 OTP 库并允许 30 秒容差，没有持久化最近接受的 counter。隔离调用中同一个 TOTP code 连续验证两次，结果为 `{first:true, second:true}`。登录 challenge 自身是单次使用，这是缓解措施，但底层 TOTP 不提供重放保证。
- **攻击路径或故障过程**：同一有效窗口内截获 OTP；在并发挑战、未来新增敏感操作或多实例部署中重复使用该 code。
- **影响范围和最坏结果**：二次验证的抗重放能力弱于预期；与会话窃取或初始化问题组合时扩大接管窗口。
- **最小复现步骤**：为固定 secret 生成当前 TOTP；连续两次调用 verify；两次均为 true。
- **根因**：只验证密码学有效性，没有把 OTP counter 纳入用户认证状态。
- **推荐修复**：验证成功后以用户为键原子保存最后接受 counter，仅接受更大的 counter；多实例时使用共享强一致存储；保持 challenge 单次消费和失败限速。
- **必须新增的回归测试**：同 counter 第二次失败；容差窗口中旧 counter 不可回退；两个并发验证仅一个成功；恢复码仍严格单次使用。

### P2-04 发布供应链与容器不可变性门禁不完整

- **位置**：[`.npmrc`](.npmrc#L3)、[`.github/workflows/security-regression.yml`](.github/workflows/security-regression.yml#L15)、[`.github/workflows/security-regression.yml`](.github/workflows/security-regression.yml#L58)、[`Dockerfile`](Dockerfile#L20)、[`Dockerfile`](Dockerfile#L27)、[`docker-compose.yml`](docker-compose.yml#L28)、[`docker-compose.yml`](docker-compose.yml#L38)。
- **证据**：`.npmrc` 全局关闭 audit；默认 npmmirror 不实现 audit API，显式切换 npm 官方 registry 后本次结果为 0 个已知生产依赖漏洞。CI action 使用可变 tag 而非 commit SHA，流水线不执行 npm audit 或镜像 CVE 阈值。基础镜像已按 digest 固定，这是有效控制。运行镜像中 `/app/server` 和 `/app/node_modules` 归 `pwuser` 且 owner 可写，Compose 未启用只读根文件系统或资源限制。
- **攻击路径或故障过程**：未来依赖漏洞不会在默认安装/CI 阶段阻断；被劫持的 action tag 或可写应用目录可改变构建/运行结果；浏览器或 Node 进程被利用后可持久修改应用文件直到容器重建。
- **影响范围和最坏结果**：供应链植入未被门禁发现，运行时入侵扩大为代码篡改；缺少镜像级 CVE 证据导致发布风险不可量化。
- **最小复现步骤**：运行默认 `npm audit` 观察 registry 能力/配置，再显式指定官方 registry；检查 workflow `uses:` 与镜像扫描步骤；容器内以 Node 运行 UID 验证 `/app/server` 可写。
- **根因**：依赖完整性、漏洞审计、action provenance 和运行时不可变性没有形成统一发布策略。
- **推荐修复**：CI 使用可信 registry 执行 `npm ci` 和审计，增加 SBOM 签名、镜像扫描与严重度阈值；actions 固定完整 SHA；多阶段镜像把代码设为 root-owned 只读，运行时只写显式 data/tmp/profile 挂载；启用 `read_only` 和 tmpfs。
- **必须新增的回归测试**：CI 对已知高危 fixture 阻断；校验 action SHA 和基础镜像 digest；容器测试断言代码/依赖不可写、数据目录可写；扫描报告作为发布制品留存。

## P3

### P3-01 集成测试启动等待固定 10 秒，在并行构建负载下出现偶发失败

- **位置**：[`test/api-key-details.integration.test.js`](test/api-key-details.integration.test.js#L11)、[`test/api-key-details.integration.test.js`](test/api-key-details.integration.test.js#L27)。
- **证据**：首次并行执行生产构建和全量测试时 107/108 通过，唯一失败为 `test server did not start`；该测试单独重跑通过，随后全量重跑 108/108 通过。测试以轮询和固定约 10 秒上限等待随机端口服务。
- **攻击路径或故障过程**：CPU/磁盘负载较高的 CI 中，子进程启动超过硬编码窗口，产生与功能无关的红灯，掩盖真实回归并诱发人工重跑习惯。
- **影响范围和最坏结果**：发布门禁不稳定，安全测试结果可信度下降；不是运行时安全漏洞。
- **最小复现步骤**：并行执行 `npm run build` 与 `npm test` 并施加 CPU 压力；观察启动超时；单独重跑通过。
- **根因**：测试没有使用子进程 ready 信号或健康端点同步，固定超时未考虑 CI 资源波动。
- **推荐修复**：服务监听成功时显式发送 IPC ready；测试等待该信号并在失败时输出子进程 stdout/stderr；为 CI 单独配置合理超时，不以盲 sleep 判定就绪。
- **必须新增的回归测试**：在限 CPU 环境重复运行集成测试；验证就绪握手、启动失败诊断和子进程清理均确定性通过。

## 总结

### 1. 架构与信任边界图

```mermaid
flowchart LR
  U[操作员浏览器] -->|HTTPS / WSS| C[Caddy: TLS 与动态 Docker DNS]
  C -->|/ 与 /api| A[Express + React 静态资源]
  C -->|/browser/* 先 forward_auth| N[noVNC / websockify]
  N --> V[x11vnc]
  V --> X[Xvfb + Openbox]
  X --> B[有头 Chromium]
  A --> J[(frosted-data: JSON 状态)]
  A --> P[(浏览器 profiles/Cookie/LocalStorage/cache)]
  A --> M[Monitor + Collectors]
  A -->|CDP 127.0.0.1| B
  M -->|direct 或 fail-closed proxy| H[Mihomo]
  H --> E[不可信代理节点 / 上游服务]
  M --> R[Resend / 飞书]
  A --> S[Clash 订阅下载与解析]
  S --> Q[(frosted-proxy: provider/runtime)]
  Q --> H

  subgraph TB1[信任边界 A: Internet]
    U
  end
  subgraph TB2[信任边界 B: 入口与应用容器]
    C
    A
    N
    V
    X
    B
    M
  end
  subgraph TB3[持久化边界]
    J
    P
    Q
  end
  subgraph TB4[外部不可信服务]
    E
    R
  end
```

控制流以 Caddy 为唯一公网入口；`/browser/*` 在握手时回调 Express 会话鉴权。Monitor 读取 Account 及其 Upstream 策略，调用 collector，再写 Snapshot/Incident 并发送通知。持久化边界包括 `frosted-data`、`frosted-proxy`、Caddy 数据卷及卷外 `.env` 主密钥。当前最重要的所有权缺陷是 BrowserProfile 实际按 Origin 共享，而不是由 Account 拥有。

### 2. 攻击面矩阵

| 攻击面 | 入口/数据 | 当前控制 | 已确认缺口 | 最高严重度 |
|---|---|---|---|---|
| 首次设置/登录 | 公网 HTTP API | 密码策略、bcrypt、限速 | 首次设置先到先得 | P0 |
| 已认证管理 API | Cookie + JSON | sessionVersion、Origin 检查、Zod | JSON 队列毒化、跨实体竞态 | P1 |
| 上游采集 | baseUrl + Token/Cookie | 同源重定向、超时 | SSRF、HTTP 明文、无正文上限 | P1 |
| Clash 订阅/Mihomo | URL、YAML、节点 | HTTPS、私网阻断、DNS 固定、controller secret、fail-closed | 恶意真实节点行为待验证 | 待验证 |
| noVNC WebSocket | Cookie、Origin、VNC 帧 | Caddy forward_auth、端口不直出 | Origin 未校验、注销不断开 | P1 |
| Chromium/CDP | profile、Cookie、LocalStorage | CDP loopback、非 root、sandbox | profile 跨账号、任务无总配额 | P1 |
| 通知 | 邮箱、Webhook、消息 | 脱敏状态、HTML 转义 | 无 outbox、超时/正文上限 | P1 |
| JSON 数据 | 凭据、快照、事件、审计 | AES-GCM、schema/FK 启动校验 | 单文件、非原子事务、无 DR | P1 |
| 代理/转发头 | Host/Proto/XFF | Caddy 重写 XFF；实测限速不可绕过 | 公网部署拓扑仍需复验 | 待验证 |
| 构建与容器 | npm、actions、镜像 | lock integrity、基础镜像 digest、cap-drop、seccomp | audit/镜像门禁和只读根缺失 | P2 |

### 3. 已确认有效的安全控制

- AES-256-GCM 使用随机 12 字节 nonce 和认证 tag；密码使用 bcrypt cost 12；用户名执行 NFKC 与大小写规范化。
- 会话签名绑定用户名和 `sessionVersion`；Cookie 实测为 `Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/`、12 小时。注销后旧 Cookie 的新 HTTP/WebSocket 请求被拒绝。
- TOTP 登录 challenge 在当前进程内单次消费；恢复码以 HMAC 形式保存且单次使用。
- Helmet/CSP、`frame-ancestors`/X-Frame-Options 生效；未发现 `dangerouslySetInnerHTML` 路径；React 输出与通知 HTML 有转义。
- 状态变更 API 有 Origin 校验；经 Caddy 注入不同 `X-Forwarded-For` 的 7 次错误登录返回 `401,401,401,401,401,429,429`，客户端头未绕过限速。
- Clash 订阅路径实现 HTTPS、私网/元数据阻断、重定向复验、DNS 固定与大小限制；Mihomo controller 使用 secret 和内部网络；固定代理未就绪时采集 fail-closed。
- app/noVNC 未直接映射宿主端口；CDP 只监听 `127.0.0.1`。实测 Chromium 为有头模式，noVNC 画布 1440x900 且非空；`chrome://sandbox` 显示 namespace、PID/network namespace、Seccomp-BPF 均启用。
- Node 运行进程实测 UID/GID 1001、`CapEff=0`、`NoNewPrivs=1`、Seccomp mode 2；Compose 已 drop capabilities 并禁止提权。
- Caddy 的 HTTP 到 HTTPS、HSTS、本地 TLS、动态 Docker DNS均可用。强杀并重建 app 后，Caddy 从 `503` 在约 2 秒内恢复为 `200`。
- 重建 app 后浏览器 LocalStorage 标记仍保留；强杀留下的 Chrome lock 在重新打开 profile 时被清理并成功启动。
- Caddy 日志中的 Cookie/Set-Cookie 被标为 REDACTED；应用和 Caddy 日志对本次 fixture 凭据的精确扫描均为 0 命中。

### 4. 未覆盖或无法验证的风险

- **待验证**：没有使用真实 New API、Sub2API、Resend、飞书、Cloudflare Access 或真实代理订阅凭据，因此第三方特定响应、限速、重定向和错误格式兼容性尚未验证。
- **待验证**：公网 DNS、ACME 证书签发、云防火墙、宿主 SSH、Docker daemon 权限和实际反向代理链；本次 HTTPS 使用 Caddy 本地 CA。
- **待验证**：生产是否另有离站备份、secret manager、密钥托管和恢复演练；仓库内未见这些实现。
- **待验证**：恶意真实 Mihomo 节点的流量观察、DNS 泄露、UDP/QUIC 行为和 provider 更新失败；本次未向第三方发送破坏性流量。
- **待验证**：完整镜像/OS CVE 扫描。本次官方 npm registry 审计为 0 个已知生产依赖漏洞，但不覆盖基础系统包、Chromium 和供应链未知漏洞。
- **待验证**：真实上游页面的所有弹窗、充值、挑战、恢复确认和自动结单端到端闭环；当前代码审查已确认 UI 生命周期缺口。
- **待验证**：Safari/Firefox、窄屏、长文本、断网重连和辅助技术的完整 UX/无障碍矩阵。

### 5. 整改清单

**立即**

1. 停止公网发布；封闭首次设置接口并实现一次性引导令牌/离线初始化。
2. 修复 JsonStore rejection 隔离、copy-on-write 和原子落盘，增加存储健康检查。
3. 为账号 URL 实现完整 SSRF/HTTPS/响应上限策略，并在网络层增加 egress allowlist。
4. noVNC 增加 Origin、短期 ticket 和存量连接撤销。

**发布前**

1. 将 BrowserProfile 归属改为 Account 级，补齐删除、迁移与同源隔离。
2. 所有采集、测试、登录和浏览统一执行 Upstream 代理策略并证明 fail-closed。
3. 引入持久化通知 outbox、幂等派发、超时、重试和死信。
4. 将跨实体约束移入同一事务并完成并发模型测试。
5. 为浏览器任务、容器、WebSocket、响应、缓存和磁盘建立配额与告警。
6. 迁移快照/事件存储，dashboard 改为分页/聚合/增量。
7. 实施版本化备份、恢复演练与 MASTER_KEY 轮换。
8. 补齐账号全生命周期 UI 和端到端测试；修复上游唯一性与隐式 direct 创建。
9. 关闭 TOTP counter 重放，完成 CI 供应链与镜像扫描门禁。

**发布后**

1. 持续做容量、故障注入、通知供应商和真实上游兼容性演练。
2. 建立 SLO：采集新鲜度、通知延迟、队列深度、浏览器数量、磁盘水位、备份 RPO/RTO。
3. 固定 actions SHA、签名/SBOM/制品来源，并按周期复扫 npm、OS、Chromium 与镜像。
4. 扩展浏览器、移动端、无障碍与断网恢复测试矩阵。

### 6. 发布结论

**阻止发布。** 当前默认部署存在可重复验证的未认证管理员接管 P0；同时存在存储队列永久失效、带凭据 SSRF、noVNC 会话撤销失效、跨账号浏览器身份混用、代理绕过、通知丢失、数据关系竞态、资源耗尽和不可恢复等 P1。至少完成“立即”和“发布前”项目并通过所列回归测试、恢复演练和重新审查后，才可重新评估为有条件发布。

### 7. 验证执行记录

| 验证项 | 结果 |
|---|---|
| `npm run build` | 通过；Vite 构建 4,987 modules |
| `npm test` | 最终全量 108/108 通过；首次与构建并行时出现 1 个启动超时，单测与全量重跑均通过 |
| `npm audit --omit=dev --registry=https://registry.npmjs.org` | 0 个已知漏洞 |
| `docker compose ... config --quiet` | 通过 |
| `bash -n deploy-linux.sh`、两个 entrypoint `sh -n` | 通过 |
| `caddy validate` | 通过 |
| `mihomo -t` | 通过 |
| 隔离生产 Compose 健康与鉴权 | root HTTP 308；HTTPS 200；health 200；未登录 browser 401；登录后 dashboard/browser 200 |
| noVNC/Chromium | 有头、非空画面、1440x900；CDP loopback；sandbox 验证通过 |
| app 重建恢复 | Caddy 503 后恢复 200；profile/LocalStorage 保留；残留 lock 清理成功 |
| 凭据日志检查 | fixture secret 精确匹配 0；Cookie/Set-Cookie 已脱敏 |

本次所有攻击验证均在本地隔离容器和样本上完成，没有使用真实凭据，也没有向真实第三方服务发送破坏性流量。
