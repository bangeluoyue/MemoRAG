# MemoRAG v1.17 最小部署

部署 A～C 已完成，ES+IK 镜像已在本地构建。用户已手动准备 ECS 基础软件，MemoRAG 服务尚未启动、ES 镜像尚未安装到 ECS；本文中的应用部署、数据库写入、账号初始化、DNS/安全组变更与模型调用均**尚未执行**。进入 D 前须获得用户确认。每个检查点单独运行，失败即停止，不把后续步骤串成一键脚本，也不自动重试。

## 架构与本次审查

```text
浏览器 HTTPS → ECS Nginx → React dist
                         └ /api、/health → 127.0.0.1:3000 Node（systemd）
Node → Neon pooled PostgreSQL（TLS verify-full）
     → Zilliz Free-01（HTTPS/gRPC TLS + Token）
     → 127.0.0.1:9200 ES 9.5.4 + IK 9.5.4（Compose）
     → 现有 OpenAI 兼容模型端点（qwen-plus / text-embedding-v3，1024 维）
```

EPUB 只用 Milvus；生活笔记继续用 PostgreSQL + ES + Milvus + RRF。没有更改 Graph、Prompt、检索、同步或认证语义。ECS 不运行 PostgreSQL、Milvus、etcd、MinIO、Kibana 或 Attu。

2026-10-16 首次通过现有 `~/.ssh/config` 中的 **aliyun** 别名只读检查，用户为 admin；后续统一 `ssh aliyun` / `scp ... aliyun:...`，不写死 IP。ECS 为 Alibaba Cloud Linux 3.2104 U12 x86_64，2 核，内存 3563 MiB（当时 available 2908 MiB），Swap 1024 MiB；49 GiB 根盘当时剩余 40 GiB。当时 Docker 26.1.3、Compose 2.27.0 可用，Node、Nginx 未安装，`vm.max_map_count=65530`。用户随后报告已手动准备 Nginx 1.24.0、Node.js 22.22.3、npm 10.9.8，Docker/Compose 版本不变；本次 Git 收尾未 SSH 复查。首次检查监听端口有 22、8888，8888 用途及 sysctl 当前值留待 D 确认；未更改端口、防火墙或安全组。

提交前代码基线为 `b7a3a267a7c202a5935f702adf30e5afbe4e44a8`。阶段 A 的只读 `git ls-remote` 确认远端 main 为 `73ebd4903296d7725cfaa53706952987a81f4966`，提交前本地 main ahead 27。本次收尾将部署文件按明确清单纳入 `feat(deploy): prepare MemoRAG cloud deployment` 提交，不自动推送；提交后的实际 Hash 和 ahead/behind 以 `git log -1`、`git status -sb` 为准。进入 D 后可确认推送再获取该提交，或使用下方显式文件清单传输，不能直接在 ECS 拉旧 main。

## 兼容性与私有配置

- Milvus Token 已在 `getConfig()` 和 `createMilvusClient()` 传递，SDK 根据 `https://` 自动启用 TLS。原 SDK 3.0.6 的官方兼容表对应 Milvus 3.x；本次将依赖**精确固定为 2.6.17**并更新锁文件，匹配目标 2.6.x；全部 Mock 通过，云端真实连接尚未验证。[SDK 兼容表](https://milvus-io.github.io/milvus-sdk-node/reference/migration-compatibility/)
- `pg@8.23.1` 的 `ssl` 和连接串参数兼容当前 Neon pooled URL。当前开发 URL 的 `sslmode=require` 在已安装解析器中也执行证书校验；生产副本显式使用 `sslmode=verify-full` + `DATABASE_SSL=true`，不使用 `rejectUnauthorized:false`。URL 内 SSL 参数可覆盖代码 `ssl`，因此不要把 URL 改成 disable/no-verify。[node-postgres SSL](https://node-postgres.com/features/ssl)
- Migration 仅是现有两份 SQL：`001_create_life_notes.sql`、`002_create_auth.sql`。没有 session-level SET、临时表、命名 prepared statement 或 advisory lock，当前 pooled 事务模式没有已知阻碍；工具用单个 `pg.Client` 顺序执行原 SQL。002 自带 BEGIN/COMMIT，001 一次提交整个 SQL。若 pooled 实测失败，停止，私下从 Neon 控制台复制 Direct URL 至 `DATABASE_MIGRATION_URL` 后另行确认再执行，**不猜测主机名，不修改 SQL 语义**。[Neon pooling](https://neon.com/docs/connect/connection-pooling)
- ES 客户端保留已验收的 `8.19.2`，安装源码确认自动发送 `compatible-with=8`；ES 9.x 官方支持相邻主版本的 REST compatibility。部署后仍需真实验证 search/index/deleteByQuery，不能把 Mock 当作 ES 9.5.4 真实联调。[Elastic 兼容协议](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/compatibility)
- 新增 `MEMORAG_ENV_FILE`：指定后只读该文件，文件缺失立即失败；不回退到开发 `.env`。环境中已设置的值按 dotenv 原有规则优先。systemd 从干净服务环境加载 `/etc/memorag/production.env`，不要继承个人 shell 的开发开关。

已经运行本地工具 `node backend/src/cli/prepare-production-env.js`：生成 Git 忽略的 `backend/.env.production`（0600），只复制数据库、Zilliz 和模型配置；保持现有模型/端点，明确 1024 维；新生成独立的 Session Secret、管理员初始密码和部署测试员密码。不会覆盖任何已有目标文件，不连接任何服务；原 `.env` 未改动。此工具只供首次生成，不要靠删除私有文件重复生成。密钥不在本文、Compose、Dockerfile 或前端中。

生产默认关闭的真实变量：`ENABLE_WEB_SEARCH`、`ENABLE_RERANK`、`ENABLE_NOTE_RERANK`、`LANGSMITH_TRACING`、`LANGSMITH_TRACING_V2`、`LANGCHAIN_TRACING`、`LANGCHAIN_TRACING_V2`、`ENABLE_NOTE_LANGSMITH_TRACING`。不运行 OpenEvals 命令。

`production.env.example` 是无密钥模板。真实文件只用编辑器/私有传输查看和配置，不执行 `cat`、`source`、`set -x`、`systemctl show ... Environment` 或带密码的命令行。`DEPLOY_TESTER_PASSWORD` 仅供初始化工具，调用现有服务重置测试员密码；完成后可从服务器私有文件中移除该项。

## 初始化契约

入口为 `node backend/src/cli/init-deployment.js <postgres|milvus|elasticsearch|accounts>`：

- 不加参数：纯离线 dry-run，不构造外部客户端。
- `--check`：仅适用于前三项，会读取真实服务，阶段 D 获准后使用。
- `--execute`：实际写操作，**每一项执行前单独说明并确认**。失败立即退出，日志只显示安全类别，无连接串或上游原文。

Milvus 默认 Collection 名来自现有配置：`ebook_collection`、`life_notes`。先检查**两者**再写任何一个；存在则检查所有所需字段、类型、主键、autoID、长度下限、维度、COSINE 索引就绪和加载状态。兼容时只复用，不修改、不补索引、不重加载；不兼容就报告字段名/类别并停止。只为不存在的 Collection 创建 Schema、`AUTOINDEX + COSINE` 和加载。新集合中途失败会保留现场，下一次检查会报告不完整集合，不自动修复/覆盖/删除。Zilliz 使用 AUTOINDEX，不能照搬本地 IVF_FLAT 的建索引配置；现有检索参数保持不变，真实查询兼容性在 D 验证。[Zilliz 索引限制](https://docs.zilliz.com/docs/limits)

| Collection | 字段（与现有读写适配器一致） |
| --- | --- |
| ebook_collection | `id` VARCHAR(100) 手动主键；`book_id` VARCHAR(100)；`book_name` VARCHAR(200)；`chapter_num`、`index` INT32；`content` VARCHAR(10000)；`vector` FLOAT_VECTOR(1024) |
| life_notes | `note_id` VARCHAR(128) 手动主键；`user_id` VARCHAR(128)；`knowledge_base` VARCHAR(32)；`title` VARCHAR(2000)；`content` VARCHAR(65535)；`metadata` JSON；`vector` FLOAT_VECTOR(1024) |

EPUB 长度复用已验收旧 Schema 和当前入库测试；笔记 ID 按当前校验 128，标题最多 500 个 JS 字符，2000 字节容纳其 UTF-8，正文使用 Milvus VARCHAR 最大 65535 字节。没有新增业务字段。现有笔记业务未限制正文长度；超大正文仍可能同步失败，本轮不改业务校验，演示用短笔记。字符串限制按 UTF-8 **字节**计算。

ES `life_notes` 初始化使用 `elasticsearch/life-notes-index.json`：1 shard、0 replicas；三个范围/标识字段 keyword，title/content 使用 `ik_max_word` + `ik_smart`。创建前查存在性，存在只校验 mapping，不覆盖。禁止依靠第一条笔记自动创建无 IK 的默认 mapping。

## 资源预算

| 项目 | 起始预算 |
| --- | --- |
| ES | JVM Xms/Xmx 512 MiB，容器上限 1536 MiB（包含堆外、IK、映射和缓存），禁用 ML；CPU 1.5 核上限 |
| Node | V8 old space 384 MiB，systemd 总内存上限 768 MiB；真实 RSS 在 D 测量 |
| OS、Docker、Nginx | 预留约 0.7～1 GiB，当前空载已用约 655 MiB |
| 磁盘 | 镜像与依赖预留约 5～8 GiB；ES 日志轮转 3×10 MiB，数据持久卷保留 |

3.5 GiB 支持低并发演示的起始预算；不是实际压力测试结果。Swap 保留 1 GiB，ES memory lock 不依赖 Swap。先测 `docker stats --no-stream`、`free -m`、`systemctl show memorag -p MemoryCurrent` 及 OOM 状态再调容器上限/Heap。若 512 MiB 堆不足，停止并报告，不删除 ES、不改 Hybrid RAG、不升级付费资源。尽量在本机构建前端和 ES 镜像，避免 ECS 上同时构建、入库、问答。

Compose 与两个 systemd 单元均 `Restart=no`，失败由人检查后再启动。启用 systemd 后正常开机按 ES→Node 顺序启动；运行期间健康检查只报告，不反复重启或重跑云端初始化。

## 阶段 C 复验

在仓库根目录执行（不安装依赖、不启动业务服务）：

```bash
bash deploy/check-offline.sh
```

脚本令 `MEMORAG_ENV_FILE=/dev/null`，用假的 loopback 地址/密钥覆盖配置并关闭所有追踪；预加载网络拦截器，只允许本机 Mock TCP，阻断外部 TCP。不会读取开发/生产秘密文件。测试使用 NODE_ENV=test，前端构建单独显式使用 NODE_ENV=production；最终 JS 约 249.36 kB（gzip 77.01 kB）。后端测试、前端测试和构建、Compose 解析及四个 dry-run 一次执行，任何错误停止。

阶段 A～C 原验证结果：后端 18/18 文件通过（包含 9 项部署安全 Mock），前端 2 个文件 10/10，Vite 23 个模块构建成功。另用本地已有 Nginx 镜像在 `--network none` 下配临时自签名证书做 `nginx -t`，通过；systemd 单元在临时副本替换为本机 Node 路径后语法校验通过，服务器仍须校验真实路径。

用户随后实际执行 `docker compose -f deploy/elasticsearch/compose.yaml build` 和 `bash deploy/check-offline.sh`，提供的结果为：Elasticsearch 9.5.4 + IK 镜像 `memorag-elasticsearch-ik:9.5.4` 已构建成功，后端 **180/180**、前端 **10/10**、Vite 生产构建及四个初始化 dry-run 均通过，未调用真实云数据库或付费模型。本次收尾只做 Diff、安全与静态配置/语法复核，不重复完整测试或构建。尚未安装镜像到 ECS，未启动 ES 做服务器内存实测，未访问 Neon、Zilliz、模型、Embedding、Judge 或 LangSmith；离线通过不代表线上部署成功。

当前真实凭证（包括 DB 密码）比对全部 Git 历史 blob 与前端产物均无命中，常见 sk- 密钥格式也无命中；真实 `.env.production` 被 Git 忽略。这不能证明聊天、截图或外部日志中未泄露过旧密钥。如曾公开粘贴过凭证，应先在对应控制台轮换，再私下更新生产文件；本轮不自行轮换外部服务密钥。

## 阶段 D：逐项确认后执行

下面不是本轮执行记录。每完成一个编号就检查并报告，再进入下一个；云端写入、账号密码重置、DNS/安全组变更和真实模型调用各有独立确认点。

1. **前置检查与 ECS 安装（服务器变更，需确认）**

   先确认域名、证书与 ECS 所在区域；域名解析至中国内地公网服务器时还需核对备案/接入要求，不能假设已有域名就能直接访问。[阿里云备案要求](https://help.aliyun.com/en/icp-filing/basic-icp-service/support/for-the-record-process-faq) 没有域名/证书就停在此检查点，可准备仅 loopback 的后端，不能开放正式 HTTP 登录。

   复查 `ssh -G aliyun`、`ssh aliyun`（仅限 D 获准后）。用户已完成 Docker、Compose、Nginx、Node/npm 安装，先核对版本和 systemd 使用的 `/usr/local/bin/node` 路径，不重复安装或覆盖。以下仅供缺失软件时参考：Alibaba Cloud Linux 3 使用 `sudo dnf install -y nginx curl tar xz`；Node 22.22.3 x86_64 官方二进制及校验文件来自 `https://nodejs.org/dist/v22.22.3/`，校验 SHA256 后安装并链接到服务路径，不使用 admin 的 nvm 路径作为服务路径。保留已有 Docker/Compose。

   `sudo useradd --system --home-dir /nonexistent --shell /sbin/nologin memorag`（先 `id memorag` 判断是否存在）。创建 `/opt/memorag`、`/etc/memorag`；密钥目录 `root:memorag 0750`，私有文件 `root:memorag 0640`。安装 sysctl 文件：`sudo install -m 0644 /opt/memorag/deploy/sysctl/90-memorag-es.conf /etc/sysctl.d/90-memorag-es.conf`，再单独执行 `sudo sysctl -p /etc/sysctl.d/90-memorag-es.conf` 并核对数值。

   安全组只考虑 443、用于 ACME/HTTPS 跳转的 80 和限定来源的 SSH 22。3000、9200、9300、数据库端口不得开放。8888 先确认用途；不得擅自停止服务。安全组/主机防火墙每次变更都另行确认。`getenforce` 若 Enforcing，安装 `policycoreutils-python-utils`，按需用 `httpd_sys_content_t` 标记前端目录并启用 `httpd_can_network_connect` 允许 Nginx 连 loopback API；不关闭 SELinux。

2. **发布明确文件清单并准备 ES（服务器变更，需确认）**

   在本机先完成 C；从根目录用 `tar -czf /tmp/memorag-v117-release.tgz backend/src backend/sql backend/package.json backend/package-lock.json frontend/dist deploy` 打包。清单不含 backend/.env、node_modules、历史数据或私钥。传输并检查 tar 清单后解压至 `/opt/memorag`。私有文件**单独**通过 SSH 传输，安装至 `/etc/memorag/production.env` 后清理暂存副本；不要放入发布包或 Web root。所有发布代码和 dist 建议 `root:root`、目录可读可遍历，服务用户只需读；真实环境文件保持上述权限。

   `/opt/memorag/backend` 运行 `npm ci --omit=dev --ignore-scripts`，并确认 Node 解析 SDK 版本为 2.6.17。本机 ES 镜像已构建，无需重复 build；确认后 `docker save memorag-elasticsearch-ik:9.5.4` 导出并传输/load 到 ECS，再检查镜像标识。Dockerfile 严格固定 ES/IK 9.5.4；保留 IK 自带词典，不启用远程词典。[IK 官方安装](https://github.com/infinilabs/analysis-ik)

   安装 `memorag-elasticsearch.service` 后 `sudo systemctl daemon-reload`，单次 `sudo systemctl start memorag-elasticsearch`。检查 `docker compose ps`、`curl -fsS http://127.0.0.1:9200/_cluster/health`、`curl -fsS http://127.0.0.1:9200/_cat/plugins`、`docker stats --no-stream`、OOM/容器退出状态。无效状态立即停止，保留卷和日志。确认稳定后才 `sudo systemctl enable memorag-elasticsearch`。

3. **Neon、Zilliz、ES 初始化（分别确认写入）**

   从 `/opt/memorag` 开始，下列命令每次只执行一条；`sudo -u memorag` 用户能读密钥文件和发布目录。只读检查也应在 D 授权后进行。

   ```bash
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js postgres --check
   # 确认：创建 SQL 表/索引；不迁移旧数据
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js postgres --execute
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js postgres --check
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js milvus --check
   # 确认：仅创建不存在的两个 Collection、索引及加载；无 Embedding
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js milvus --execute
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js milvus --check
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js elasticsearch --check
   # 确认：创建不存在的本机 ES 索引；不写假笔记
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js elasticsearch --execute
   ```

   Neon 检查三张表，Zilliz 检查两个 Schema、索引及加载；ES 用 `_analyze` 测 IK（只分析文本，不入库）。不调用模型。已有表由原 SQL 的 IF NOT EXISTS 复用，不自动修复已有不兼容表；若不是预期的新空数据库，先停下人工核对 Schema。免费集群如果暂停，只恢复现有 Free-01，不创建/升级资源。

4. **账号与 Node（云端写入，需确认）**

   首先明确：`accounts --execute` 复用原认证服务，初始化缺失管理员/测试员、清理过期 Session、将测试员密码改为私有文件中的随机 `DEPLOY_TESTER_PASSWORD` 并使其旧 Session 失效；不覆盖已有管理员密码。此时 Nginx 仍未公开应用。

   ```bash
   sudo -u memorag env MEMORAG_ENV_FILE=/etc/memorag/production.env /usr/local/bin/node backend/src/cli/init-deployment.js accounts --execute
   sudo install -m 0644 deploy/systemd/memorag.service /etc/systemd/system/memorag.service
   sudo systemd-analyze verify /etc/systemd/system/memorag.service /etc/systemd/system/memorag-elasticsearch.service
   sudo systemctl daemon-reload
   sudo systemctl start memorag
   curl -fsS http://127.0.0.1:3000/health
   ```

   启动服务也会复用原认证 initialize（清理过期 Session，必要时补缺失账号），必须纳入此次云端写入授权。`/health` 只证明 HTTP 进程存活，返回 `dependencies=not_checked`，不能代替上一步三服务检查。检查 `systemctl status`、`ss -ltn`（Node/ES 仅 loopback）后再 enable。日志只私下查看，勿分享包含个人数据的完整日志。

5. **Nginx 与 HTTPS（域名/证书单独检查点）**

   已有免费或自有证书时，将证书链/私钥放到私有目录并修改配置路径；没有时可用免费 ACME（不购买证书服务）。先确认域名 DNS/备案和 80 验证可达，再仅安装 `bootstrap-http.conf`（用真实域名替换 demo.example.com），创建 `/var/lib/memorag-acme`。该站点只有 ACME 静态目录，其余一律 503，无登录页面/API。检查发行版 `/etc/nginx/nginx.conf` 的默认站点，避免默认欢迎页/其他站点冲突；改前备份，不覆盖其他服务。

   使用已安装/可用的 ACME 客户端 webroot 模式签发免费证书，例如 `certbot certonly --webroot -w /var/lib/memorag-acme -d <真实域名> --email <自己的邮箱> --agree-tos`。AL3 的 certbot 来源需先查 dnf 仓库是否提供，缺包则停止确认可用安装方式，不套用 apt、不购买证书。签发流程和 DNS/安全组操作在 D 中逐项说明；续期配置同样须检查，使用 deploy hook 在 `nginx -t` 成功后 reload。

   证书存在后，将真实域名替换后的 `memorag.conf` 安装至 `/etc/nginx/conf.d/memorag.conf`，将 `memorag-proxy.inc` 安装至 `/etc/nginx/memorag-proxy.inc`，移走临时 bootstrap 站点；执行 `sudo nginx -t` 成功才 reload/start。SSL 配置同时覆盖 `/api/auth/login` 和 `/api/`，不剥离 `/api`；前端无生产 API URL 要修改。上传服务上限 25 MiB，Nginx 26 MiB 含 multipart 开销。API/upload 600 秒读等待，无自动代理重试。

   用 `curl -I https://<域名>/`、HTTP 跳转检查及浏览器证书检查；只在证书可信、HTTPS 正常后输入正式账号密码。HttpOnly + SameSite=Lax + Secure Cookie，同域无需额外 CORS。后端已有失败限流通过 loopback 代理会共享 IP 计数，Nginx 另按真实连接 IP 限登录频率；演示中不要反复输错密码。

6. **演示数据和功能验收（真实模型/Embedding 另外确认）**

   先 HTTPS 管理员/测试员登录、退出、权限及 Cookie 验证。再由用户选择两本合法、公开可演示的小 EPUB，先本地 dry-run 统计分块和批次，说明预计模型/Embedding 调用后**等待明确授权**。网页管理员上传两本，经既有 resume 流程入库；确认动态列表、选书、至少一条问答与来源。不可迁移本地历史 Collection。

   假笔记通过测试员 HTTPS 页面或现有 `notes` CLI 写入。例如准备三条“周六10点图书馆学习”“周日15点公园慢跑”“下周三19点复习数据库索引”的非敏感短笔记；CLI 必须用 `--user-id account-tester`，默认 dry-run，明确授权后才 `--execute`。每条新增/修改都会调用 Embedding；问答会调用 Embedding/LLM，删除也会改三端数据，均先确认范围。逐条验证 synced、CRUD、ES/Milvus 两路召回、RRF 和引用、账号间隔离；失败停止，不自动 retry 或清理。最终保留约定演示数据；本轮不再次运行 Judge、LangSmith 或 OpenEvals。

## 停止与回滚

错误时停止当前阶段，保留日志/资源并报告。需要停止服务可在确认后 `systemctl stop memorag`、`systemctl stop memorag-elasticsearch`（Compose stop 保留卷）。回滚代码仅切回明确的旧发布文件并恢复对应配置，先核对新数据是否仍兼容；不运行 prune、down -v、volume rm、DROP、删除/重建 Collection 或批量回滚数据库。本轮未准备任何自动清理、收费资源或自动重试任务。
