# nb-search-cloud 自托管指南

`nb-search-cloud` 是面向团队与多用户场景的集中式搜索网关与执行服务，基于 Node.js 24 与 PostgreSQL 17 构建。它作为 `@nb-corp/nb-search` 的云端服务实现，提供集中式的 Provider 凭据托管、租户与分组隔离、以组为单位的 API Key 分发以及整数单位（Units）计量。

本指南说明如何在自建基础架构（Docker 容器或独立主机）上完成从源码构建、数据库角色配置、初始化到客户端调用的完整流程。

## 从公开仓库构建

Cloud 使用 `file:../nb-search` 引用同级 SDK。先构建 SDK，再安装 Cloud，确保安装的依赖包含 SDK 的运行文件与类型声明：

```sh
mkdir nb-search-sources && cd nb-search-sources
git clone https://github.com/NB-Corp/nb-search.git
git clone https://github.com/NB-Corp/nb-search-cloud.git
(cd nb-search && pnpm install --frozen-lockfile && pnpm build)
cd nb-search-cloud
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm build
pnpm web:build
```

---

## 架构与进程拓扑

自托管拓扑包含四个核心组件：

1. **HTTP API 进程**（`node dist/server.js`）：
   - 监听容器内 `0.0.0.0:3000`。
   - 承载同源静态管理控制台（托管于根路径 `/`，非 SPA 全局重定向）、管理员 REST API 与 `/v1` 远程协议端点。
   - **不负责终止 TLS**：生产环境须由前置反向代理（如 Nginx、Caddy 或云负载均衡器）终止 HTTPS，并确保精确的 `PUBLIC_ORIGIN` 与浏览器访问源对齐。
2. **执行 Worker 进程**（`node dist/server.js worker`）：
   - 独立常驻后台进程，负责从数据库队列认领并执行实际的搜索与抓取操作。
   - **同步与异步调用均依赖 Worker**：API 进程收到 `/v1` 搜索或抓取请求后，先将任务写入数据库队列。异步模式直接返回作业回执；同步模式则由 API 进程长轮询等待 Worker 将执行结果写回数据库。未运行 Worker 时，同步请求将等待直至超时。生产部署必须同时运行 API 与 Worker。
3. **PostgreSQL 数据库**：
   - 存储租户、用户账号、加密的搜索源凭据、作业队列状态与不可变结果产物（JSON Artifact，默认保留 72 小时）。
4. **客户端连接**：
   - 官方 SDK（`createNbSearchRemoteClient`）或官方 CLI（`--profile <name>`）通过标准 HTTP Protocol v1 调用服务端 `/v1` 接口，抓取仅支持公共 URL 输入。

---

## 当前支持的云端源目录

当前云端执行目录（`src/execution/catalog.ts`）内置支持以下操作，不同于本地 SDK 的全量清单：

| Provider | 操作标识 | 类别与输出 Schema | 说明与配置项 |
|---|---|---|---|
| `exa` | `search` | 搜索 (`nb-search.results@1`) | 默认端点 `https://api.exa.ai`，需配置 Exa API Key |
| `exa` | `contents` | 抓取 (`nb-search.fetch@1`) | URL 内容提取，复用 Exa 凭据 |
| `grok-multi-agent` | `research` | 搜索 (`nb-search.multi-agent-research@1`) | 深度多代理推演。需配置 API Key 与专用 Base URL，支持 `api_mode`（`chat_completions` 或 `messages`）、`reasoning_effort` 与 `model`。端点后缀必须与模式匹配 |

---

## 容器镜像构建

`nb-search-cloud` 依赖同级目录的 `@nb-corp/nb-search` SDK。多阶段构建必须将 `systems/` 目录作为构建上下文（Context）：

```sh
# 在 systems/ 根目录下执行构建
docker build -f nb-search-cloud/Dockerfile -t nb-search-cloud:local .
```

构建阶段自动编译同级 SDK、后端 TypeScript 源码与前端控制台，生成基于 `node:24.18.0-bookworm-slim` 的生产镜像。运行用户为非 root `10001:10001`（`nbcloud:nbcloud`），默认执行目录为 `/var/lib/nbcloud/execution`。

---

## 部署流程

### 第一步：规划数据库与准备运行环境

在目标 PostgreSQL 实例中提前创建好业务数据库（例如 `nb_search_cloud`，脚本不会自动创建数据库本身）。确保容器与数据库网络互通。

准备长期运行环境配置文件（例如 `/etc/nb-search-cloud/runtime.env`）：

```env
# 运行时 DML 连接（仅授予应用表读写权限的专用角色）
DATABASE_URL=postgres://nbcloud_runtime:runtime_secure_password_12@postgres.internal:5432/nb_search_cloud

# 访问域与 Cookie 安全
PUBLIC_ORIGIN=https://search.example.com
COOKIE_MODE=production
HOST=0.0.0.0
PORT=3000
NODE_ENV=production

# 搜索源密钥加密主密钥 (32 字节标准 Base64) 与版本标识
CLOUD_SECRET_MASTER_KEY=<base64-of-32-random-bytes>
CLOUD_SECRET_KEY_ID=2026-09-master-1

# 执行临时主目录 (容器内已有 10001 属权，不可为空)
CLOUD_EXECUTION_HOME=/var/lib/nbcloud/execution
```

> **主密钥说明与恢复边界**：
> - 生成方法：使用密码学随机生成 32 字节 Base64：`openssl rand -base64 32`。
> - 控制台中录入的 Provider 密钥采用 AES-256-GCM 加密落库，主密钥不存入数据库，数据库备份不包含此密钥，须在外部密钥库妥善保管。
> - 若环境变量中误改了 `CLOUD_SECRET_KEY_ID`，修正回原 ID 即可恢复识别；但若 `CLOUD_SECRET_MASTER_KEY` 遗失，已存 Provider 凭据将无法解密，须在控制台重新录入。
> - 首次体验或初始化时可暂不配置主密钥；系统允许启动并完成管理设置，但在录入凭据或发起搜索时会提示未配置。

---

### 第二步：配置数据库角色与权限 (`db:provision`)

数据库采用特权分离设计：
- `DATABASE_ADMIN_URL`：具备 `CREATEROLE` 的特权账号，仅用于执行初始化脚本。
- `MIGRATION_DATABASE_URL`：Schema 所有者角色（如 `nbcloud_owner`），负责执行 DDL 建表。
- `DATABASE_URL`：常驻业务角色（如 `nbcloud_runtime`），仅有 DML 读写权限。

> **警告：集群级角色变更影响**
> `provision-database` 会对 `MIGRATION_DATABASE_URL` 和 `DATABASE_URL` 中指定的角色执行 `CREATE ROLE` 或 `ALTER ROLE` 重置密码与权限。**这两个连接必须使用专门为本项目新建的独立角色名，切勿指向集群中已有的共享业务角色**，否则其密码与全局权限会被直接修改。

准备包含三角色的临时环境变量（执行后即可丢弃包含 Admin DSN 的临时配置）：

```sh
docker run --rm \
  -e DATABASE_ADMIN_URL="postgres://postgres:admin_password@postgres.internal:5432/nb_search_cloud" \
  -e MIGRATION_DATABASE_URL="postgres://nbcloud_owner:owner_secure_password_12@postgres.internal:5432/nb_search_cloud" \
  -e DATABASE_URL="postgres://nbcloud_runtime:runtime_secure_password_12@postgres.internal:5432/nb_search_cloud" \
  nb-search-cloud:local node dist/cli/provision-database.js
```

成功后输出 `database_roles_provisioned`。

---

### 第三步：执行数据表结构迁移 (`db:migrate`)

数据库迁移仅需 `DATABASE_URL` 与 `MIGRATION_DATABASE_URL`，不要求 HTTP、Cookie 或 Master Key 等配置。此处为方便起见可直接复用已准备的 `runtime.env` 并临时附加 Schema Owner 连接：

```sh
docker run --rm \
  --env-file /etc/nb-search-cloud/runtime.env \
  -e MIGRATION_DATABASE_URL="postgres://nbcloud_owner:owner_secure_password_12@postgres.internal:5432/nb_search_cloud" \
  nb-search-cloud:local node dist/server.js migrate
```

迁移完成后输出 `schema_version=2`，并自动收回 runtime 角色对迁移记录表的写权限。此后 `MIGRATION_DATABASE_URL` 即可从部署环境中移除。

---

### 第四步：初始化租户与管理员账号 (`bootstrap-admin`)

账号初始化与重置工具仅依赖 `DATABASE_URL`（无需 HTTP/Cookie 等设置，同样可方便地复用 `runtime.env`）。为了避免密码泄露至 shell 历史记录或进程列表，CLI 拒绝通过 `--password` 参数传参。

推荐使用 TTY 交互模式安全输入（系统会提示输入密码两次并隐藏回显）：

```sh
docker run --rm -it \
  --env-file /etc/nb-search-cloud/runtime.env \
  nb-search-cloud:local node dist/cli/bootstrap-admin.js \
  --tenant default \
  --username admin
```

若在自动化运维脚本中通过管道传入，必须显式附加 `--password-stdin` 参数：

```sh
cat /path/to/admin_pass.txt | docker run --rm -i \
  --env-file /etc/nb-search-cloud/runtime.env \
  nb-search-cloud:local node dist/cli/bootstrap-admin.js \
  --tenant default \
  --username admin \
  --password-stdin
```

*密码要求：12 至 128 个字符，UTF-8 编码不超过 512 字节。*

如日后需离线重置管理员密码，可使用相同参数调用维护命令（会立即使该用户现有全部登录会话失效）：

```sh
docker run --rm -it \
  --env-file /etc/nb-search-cloud/runtime.env \
  nb-search-cloud:local node dist/cli/reset-password.js \
  --tenant default \
  --username admin
```

---

## 启动服务

### 1. 启动 HTTP API 容器

```sh
docker run -d \
  --name nb-search-api \
  --restart unless-stopped \
  --env-file /etc/nb-search-cloud/runtime.env \
  -p 127.0.0.1:3000:3000 \
  nb-search-cloud:local
```

### 2. 启动执行 Worker 容器

```sh
docker run -d \
  --name nb-search-worker \
  --restart unless-stopped \
  --env-file /etc/nb-search-cloud/runtime.env \
  nb-search-cloud:local node dist/server.js worker
```

### 3. 配置反向代理 (以 Nginx 为例)

反向代理负责终止外部 HTTPS，并将请求转发至宿主机 `127.0.0.1:3000`：

```nginx
server {
    listen 443 ssl http2;
    server_name search.example.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

---

## 控制台配置与密钥签发

服务就绪后，访问 `https://search.example.com/`：

1. **登录控制台**：输入初始化创建的租户标识（`default`）、用户名（`admin`）及密码。在 `COOKIE_MODE=production` 下签发 `__Host-nbcloud_session` Cookie。
2. **配置 Providers**：进入 Providers 页面，录入上游服务商凭据（如 Exa 或 Grok API Key）。凭据录入后由 Master Key 加密存储，控制台不再回显明文。
3. **管理分组 (Groups) 与设置路由**：
   - 在 Groups 页面配置允许该组使用的 Lane（如 `exa.search`、`gma.research`）；
   - 设定各个 Lane 每次执行消耗的计量整数单位（**Units**，如普通搜索设为 1，深度研究设为 10）；
   - 配置默认搜索源（Default Search Lane）。
4. **签发 API Key**：
   - 进入 API Keys 管理页面，为指定 Group 签发新 Key（格式为 `nbc_...`）。
   - 调用方凭此 Key 访问时，自动绑定该组所拥有的 Lane 权限与配额。

---

## 客户端接入

客户端调用直接指向服务根 Origin `https://search.example.com/`（底层路由自动派发至 `/v1/search`、`/v1/fetch`、`/v1/capabilities`，无需附加 `/api/` 路径）。

### 方式一：官方 CLI 配置远程 Profile

在客户端机器的 `$NB_SEARCH_HOME/profiles.json` 中配置远程连接：

```json
{
  "schema_version": "1",
  "profiles": {
    "mycloud": {
      "kind": "remote",
      "base_url": "https://search.example.com/",
      "token_env": "NB_SEARCH_CLOUD_TOKEN"
    }
  }
}
```

配置环境变量并发起远程查询：

```sh
export NB_SEARCH_CLOUD_TOKEN="nbc_your_api_key_here"
nb-search --profile mycloud search "distributed systems consensus"
```

### 方式二：Node.js SDK 远程客户端

```typescript
import { createNbSearchRemoteClient } from '@nb-corp/nb-search';

const client = createNbSearchRemoteClient({
  base_url: 'https://search.example.com/',
  access_key: process.env.NB_SEARCH_CLOUD_TOKEN!
});

const result = await client.search({
  action: 'run',
  query: 'distributed database consistency models',
  execution: 'sync'
});
```

---

## 运行约束与计量须知

1. **Units 计量规则**：
   - 计量使用整数单位（Units），单次搜索消耗为 `Query 数量 × 所选 Lane 的 Units`。
   - 任务准入时系统记录预占额度；任务派发后，无论上游调用成功、超时还是调用方主动取消，均按实际占用资源完成 Units 扣减结算。
2. **并发与配额**：
   - 单用户并发活跃任务上限为 4，单租户并发上限为 16。
   - 队列等待上限为 300 秒。
3. **产物存储与生命周期**：
   - 异步任务不可变 JSON 产物存储于数据库表中，单结果大小上限为 16 MiB。
   - 产物在成功发布后默认保留 72 小时，过期后系统自动清理。
4. **平滑停机**：
   - API 与 Worker 进程均监听 `SIGINT` 与 `SIGTERM` 信号，停机时安全终止调度循环并关闭数据库连接池。
