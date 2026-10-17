[English](README.md) | 简体中文

# MacPanel

自研 macOS 服务器面板。Go 单二进制(~13MB,常驻内存 ~20-30MB),前端零构建链、无 CDN 依赖,全部资源由二进制内嵌。

<p align="center">
  <img src="docs/dashboard.png" width="960" alt="MacPanel 仪表盘:CPU / 内存 / 网络 / 磁盘实时曲线、磁盘挂载与 Top 进程">
</p>

## 功能

| 模块 | 说明 |
|---|---|
| 仪表盘 | CPU / 内存 / 网络 / 磁盘 I/O 实时曲线(5s 采样,75 分钟历史)、Top 进程、磁盘挂载 |
| 快速入口 | 内置导航页:收藏内网服务(LAN / ZeroTier / 隧道地址),自由增改、分组、排序、删除;仪表盘同步展示 |
| 服务 | launchd(LaunchAgents/LaunchDaemons 只读+用户域可操作)、`brew services` 启停 |
| 监控项 | 自定义监控(launchd / 端口 / HTTP / 进程名),60s 自动检查,可直接重启关联服务 |
| 计划任务 | crontab 可视化增删改/启用禁用;写回前自动备份到 `data/cron-backup/`(保留 20 份) |
| 端口/入口 | 监听端口+进程名,收藏、已知服务标注、HTTP 探测、快捷打开 |
| 网站 | Caddy 反代/静态站管理:生成 Caddyfile → `caddy validate` → 热加载 |
| 容器 | Apple `container` 管理:列表/启停/删除/日志/创建 |
| 应用商店 | brew 型 + container 型常用应用(参考宝塔/1Panel 目录),后台 job 实时日志 |
| 终端 | 网页 SSH(PTY),xterm.js,支持窗口 resize 与快捷命令 |
| AI 助手 | DeepSeek / OpenAI 兼容接口,SSE 流式;可附带系统实时快照做诊断 |
| 安全 | argon2id、会话+CSRF、登录限速、入口路径、IP 白名单、TLS、审计日志 |

## 快速开始

```bash
./build.sh                          # 构建
./macpanel                          # 默认监听 :9000,数据目录 ~/macpanel/data
```

首次访问 `http://<主机>:9000/` 会进入初始化向导:创建管理员(密码 ≥10 位)后自动生成**入口路径**(如 `/p_xxxx/`),请立即收藏。

### launchd 常驻

```bash
./install.sh                        # 构建并把 plist 渲染为当前 checkout 路径,
                                    # 安装 launchd agent 并启动面板
```

agent(`com.macpanel`)登录自启、进程保活;日志在 `<checkout>/data/panel.log`。卸载:`launchctl bootout gui/$(id -u)/com.macpanel && rm ~/Library/LaunchAgents/com.macpanel.plist`。

## 安全设计(按公网直连标准)

监听 `:9000` 会绑定 IPv4+IPv6 双栈 —— 若主机有公网 IPv6(如 `panel.example.com` 直连模式),面板即暴露公网。以下机制默认生效:

1. **入口路径**:除 `/api/*`、`/assets/*` 外的所有路径 302 到入口;扫描器拿不到页面结构
2. **argon2id** 密码哈希;用户不存在时也做等时哈希,防时间侧信道
3. **登录限速**:同 IP 5 次失败锁 15 分钟(指数退避 15m→30m→60m→120m)
4. **会话**:256-bit token,HttpOnly + SameSite=Lax,24h 滑动过期;TLS 开启时自动加 Secure
5. **CSRF**:所有非 GET API 要求 `X-Panel-CSRF` 头;安全响应头(X-Frame-Options/CSP/nosniff)
6. **审计**:登录、终端打开、所有运维操作记入 `data/audit.log`(JSONL)

**强烈建议初始化后立即配置 TLS**(设置 → 安全/网络):填入 acme.sh 签发的证书/私钥路径,重启面板即启用 HTTPS,可选配 HTTP 跳转端口。示例:

```bash
~/.acme.sh/acme.sh --issue --dns dns_cf -d panel.example.com   # 复用现有 CF token
```

可选:**IP 白名单**(设置里每行一条,支持 `192.168.31.` 前缀写法)。

### ⚠️ 终端页风险

Web 终端 = 登录后可获得主机任意命令执行能力(PTY)。已做:仅登录会话可用 + 每次打开审计。请务必:启用 TLS(否则终端流量明文)、不与他人共享会话、定期查看审计日志。

## 配置文件

`data/config.json`(0600)。常规修改走界面;直接改文件后重启面板。

```jsonc
{
  "listen": ":9000",          // 监听地址(重启生效)
  "http_port": "",            // TLS 启用时的 HTTP→HTTPS 跳转端口
  "entrance": "p_xxxxxx",     // 入口路径
  "tls_cert": "", "tls_key": "",  // 两者都填才启用 HTTPS(重启生效)
  "session_hours": 24,
  "ip_allowlist": [],
  "known_services": [{"port": 8083, "name": "Nextcloud", "url": "http://192.168.64.4:8083"}],
  "ai": {"base_url": "https://api.deepseek.com", "model": "deepseek-chat", "key": "sk-..."}
}
```

## 目录结构

```
~/macpanel/
├── macpanel              # 二进制
├── data/                 # 运行数据(自动创建)
│   ├── config.json       # 配置(0600)
│   ├── audit.log         # 审计日志
│   ├── cron-backup/      # crontab 写回前备份
│   ├── caddy/Caddyfile   # 面板生成的 Caddy 配置
│   └── panel.log         # launchd 启动时的 stdout/stderr
├── com.macpanel.plist    # launchd agent
└── web/                  # 前端源码(go:embed 内嵌,改完需重新 build)
```

## 网站管理(Caddy)

站点模型:反代(`reverse_proxy 127.0.0.1:PORT`)或静态(`root * DIR + file_server`);TLS 支持 无 / internal(Caddy 自签 CA,仅内网可信)/ 证书文件(acme.sh 签发的 fullchain.cer + .key 路径)。

保存后面板:生成 `data/caddy/Caddyfile` → `caddy validate` → 写 brew 默认位置 `/opt/homebrew/etc/Caddyfile`(一行 import)→ `caddy reload` 热加载。未装 Caddy 时仅保存配置,应用商店一键安装。

## 计划任务约定

面板解析 crontab 标准 5 字段 + `@reboot` 等特殊调度;行尾 ` # 备注` 会被识别为任务名;注释掉的定时行 = 已禁用(切换即加/去 `# `,写回前自动备份)。

## 容器

基于 Apple `container`(`container ls/logs/run/stop/start/delete`)。应用商店的容器应用走 `docker.m.daocloud.io` 镜像源;`container run` 参数有白名单校验(端口映射/环境变量/挂载格式)。

## 开发

```bash
./build.sh                 # = go vet + go build
go run ./cmd/wstest ws://127.0.0.1:9000/api/terminal <session-cookie>   # 终端 WS 冒烟测试
```

- 后端:Go stdlib + gopsutil/v4 + gorilla/websocket + creack/pty + x/crypto/argon2
- 前端:原生 JS SPA(hash 路由),canvas 自绘图表,xterm.js 已 vendor 到 `web/assets/`
- CSP 为 `default-src 'self'`,**前端禁止内联脚本/事件**,一律 `data-act` 事件委托
