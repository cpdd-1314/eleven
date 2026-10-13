# 十一愿俱乐部 · 批量结单与工资结算

从微信小程序改造成的 **网站版本**：批量粘贴小票 → 自动识别 → 陪陪平均分配 → 月度工资结算。
数据存放在 **Render PostgreSQL**，多台手机 / 电脑实时同步，不再依赖单机本地缓存。

- 前端：原生 HTML / CSS / JS，零构建，手机与电脑自适应
- 后端：Node.js + Express + `pg`
- 数据库：Render PostgreSQL
- 实时同步：Server-Sent Events（SSE）推送 + 4 秒轮询兜底
- 访问口令：环境变量 `ACCESS_CODE`，未登录看不到任何数据

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| **批量结单** | 一次粘贴多张小票，自动识别老板 / 陪陪 / 项目 / 礼物 / 金额 / 数量 / 总额 / 场控 / 日期；自动校验「总额 = 单价 × 数量」；按张预览、单张移除；重复订单只提醒不拦截 |
| **陪陪分配** | 订单总额在陪陪之间平均分配，余数（分）从前往后依次补 1 分，保证合计精确等于总额 |
| **员工管理** | 姓名 + 提成比例 + 每月补贴 + 每月扣款；已被订单引用的员工禁止删除，保留历史数据 |
| **工资统计** | 按月份统计订单总额、分配总额、提成合计、应发工资合计与每人明细；支持一键导出 CSV |
| **数据安全** | 一键下载 JSON 备份 / 从备份恢复；口令登录，30 天会话 |

工资口径：**应发工资 ＝ 个人分配金额 × 提成比例 ＋ 每月补贴 − 每月扣款**
（补贴与扣款仅在当月有分配记录时计一次）

---

## 一、部署到 Render（推荐，可一键完成）

### 先搞清楚：数据库从哪来

`render.yaml` **不会**创建数据库，而是要求你提供一个 `DATABASE_URL`。这么做是因为：

> **Render 免费套餐每个 workspace 只允许 1 个免费 PostgreSQL。**
> 如果账号里已经有一个（别的项目在用），再点 Blueprint 会报
> `cannot have more than one active free tier database`，
> 数据库建不出来，Web Service 也会被连带取消（`canceled: another action failed`）。

所以数据库按下面三选一，拿到连接串后填进 `DATABASE_URL` 即可：

| 方案 | 成本 | 说明 |
| --- | --- | --- |
| **Neon**（推荐） | 免费永久 | 免费档无到期限制，0.5 GB 足够存几万条订单。GitHub 登录即可，不用信用卡 |
| Render 付费 Postgres | 约 $6/月 | 最省心，和 Web Service 同区域内网直连 |
| 复用已有的免费 Render 库 | 免费 | 零注册，但**创建满 30 天就会被删**，且可能与旧项目的表名冲突 |

#### 用 Neon（推荐步骤）

1. 打开 https://neon.tech ，用 GitHub 账号登录。
2. 新建一个 Project，区域选 **Singapore**（离 Render 的 singapore 区近）。
3. 进 Project → **Connection string** → 复制 **Pooled connection** 那一条。
   形如：`postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
4. 这条串待会粘贴到 Render 的 `DATABASE_URL`。

> 代码已自动识别：连接串含 `.internal` 或指向 localhost 时不启用 SSL，其余一律
> `sslmode=require`，所以 Neon / Render 外部串都能直接连，不用改代码。

### 方式 A：Blueprint 一键部署（推荐）

1. 把本仓库推送到 GitHub（见下方第二节）。
2. 打开 Render Dashboard → **New** → **Blueprint**。
3. 选择本仓库，Render 会读取根目录的 `render.yaml`，规划出 1 个 Web Service。
4. 在参数页填两个值：
   - `DATABASE_URL` → 上面拿到的连接串
   - `ACCESS_CODE` → 你想要的访问口令（例如 `xixi2026`）
5. 点 **Apply**，等待 3～5 分钟。

完成后访问 Render 给你的 `https://xxx.onrender.com`，输入口令即可使用。

如果 Blueprint 之前已经建过并且失败了，进 Blueprint 详情页点右上角 **Manual sync**
重新拉取 `render.yaml` 并重试即可。

Blueprint 深链：

```
https://dashboard.render.com/blueprint/new?repo=https://github.com/cpdd-1314/eleven
```

### 方式 B：手动创建（Blueprint 出问题时用这个）

1. Render → **New** → **Web Service**，连接本仓库：
   - Runtime：`Node`
   - Build Command：`npm install --omit=dev`
   - Start Command：`node server/index.js`
   - Health Check Path：`/healthz`
   - Instance Type：`Free`
   - Region：`Singapore`
2. 在 **Environment** 里添加：
   | Key | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon 的 Pooled connection string（或 Render 已有的 Internal Database URL） |
   | `ACCESS_CODE` | 你的访问口令 |
   | `SESSION_SECRET` | 一串长随机字符串 |
   | `NODE_VERSION` | `22` |
3. 保存并部署。

> 数据表会在服务首次启动时自动创建，无需手动执行 SQL。
> 用的是同一套 `render.yaml` 里的参数，效果完全一样。

### 部署后自检 / 常见问题

部署完先打开 `https://你的地址/healthz`，对照返回的 JSON 判断状态：

```json
{ "ok": true, "db": "ok", "accessCodeConfigured": true }
```

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `"db": "down"` | `DATABASE_URL` 没填或填错 | Environment 里补上正确的连接串，Save 后会自动重新部署 |
| `"accessCodeConfigured": false` | `ACCESS_CODE` 没填 | 生产环境会**保护性拒绝所有数据请求**（返回 503），页面会提示你去配置。补上即可恢复 |
| 日志出现 `Timed Out` | 健康检查连续失败 | 我们的 `/healthz` 已改为只要进程活着就返回 200，数据库问题不会再拖挂部署 |
| 服务能开但数据加载失败 | 数据库连不上 | 访问 `/readyz` 看具体报错，通常是连接串写错或 Neon 项目被暂停 |

> 环境变量**不会**在 Blueprint 同步时自动补齐。如果创建时没弹表单，就到
> **Web Service → Environment → Add Environment Variable** 手动加，
> 保存后 Render 会自动触发一次新部署。

### 复用已有的免费 Render 数据库

如果不想注册 Neon，也可以直接用账号里那个已有的免费库：

1. Render Dashboard → 打开那个 **Postgres** 实例 → **Connections** → 复制 **Internal Database URL**。
2. 把它填进 Web Service 的 `DATABASE_URL`。

两个需要留意的地方：

- 该库仍然会在**创建满 30 天后被删除**（有 14 天宽限期），这是免费档的硬限制。
- 本应用会建 `staff`、`orders`、`sync_meta` 三张表。如果旧项目里已经有同名的 `orders` 表，
  两边会互相干扰 —— 这种情况下建议改用 Neon。

---

## 二、推送到 GitHub

先在 GitHub 上建一个**空仓库**（不要勾选 Add README / .gitignore / license）：

👉 https://github.com/new — 仓库名填 `十一愿俱乐部`，可见性按需选择。

然后本地推送：

```bash
cd 十一愿俱乐部
git init
git add .
git commit -m "feat: 十一愿俱乐部网站版（Render Postgres 实时同步）"

# 把 <你的账号> 换成 GitHub 用户名
git remote add origin https://github.com/<你的账号>/十一愿俱乐部.git
git branch -M main
git push -u origin main
```

> 如果服务名不是 `xixi-club`，建议同时在
> **Settings → Secrets and variables → Actions → Variables** 里新建变量 `SERVICE_URL`，
> 值为完整的 Render 地址（`https://xxx.onrender.com`）。这是给保活工作流用的，见第六节。

---

## 三、本地开发

```bash
npm install

cp .env.example .env
# 编辑 .env：填入本地 PostgreSQL 的 DATABASE_URL / ACCESS_CODE / SESSION_SECRET

export $(grep -v '^#' .env | xargs)   # 或者用 dotenv / direnv
npm start
# 打开 http://localhost:3000
```

本地没有 PostgreSQL 时，用 Docker 起一个最快：

```bash
docker run -d --name xixi-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=xixi_club postgres:16
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/xixi_club
```

---

## 四、环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL 连接串。Blueprint 自动注入 |
| `ACCESS_CODE` | ✅ | 网站访问口令。**不设置就等于完全公开**，日志里会有警告 |
| `SESSION_SECRET` | 建议 | 会话签名密钥，Blueprint 自动生成 |
| `PORT` | 自动 | Render 自动注入，本地默认 3000 |

---

## 五、API 速查

所有 `/api/*` 接口（除 `/api/session`、`/api/login`）都需要登录 Cookie。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 存活探针，**只要服务在跑就返回 200**；body 里带数据库状态与口令配置状态。Render 健康检查指向它 |
| `GET` | `/readyz` | 就绪探针，数据库不通返回 503。排查问题时看这个 |
| `GET` | `/api/session` | 查询当前登录状态 |
| `POST` | `/api/login` | `{ code }` 登录 |
| `POST` | `/api/logout` | 退出登录 |
| `GET` | `/api/state` | 一次性拉取 `{ revision, staff, orders }` |
| `GET` | `/api/revision` | 只取版本号（轮询用） |
| `GET` | `/api/events` | SSE 实时推送通道 |
| `POST` | `/api/staff` | 新增员工 |
| `PUT` | `/api/staff/:id` | 修改员工提成 / 补贴 / 扣款 |
| `DELETE` | `/api/staff/:id` | 删除员工（被订单引用时返回 409） |
| `POST` | `/api/orders` | 批量保存订单 `{ orders: [...] }` |
| `DELETE` | `/api/orders/:id` | 删除订单 |
| `GET` | `/api/backup/export` | 导出全部数据为 JSON |
| `POST` | `/api/backup/import` | 从 JSON 恢复（会先清空） |

### 实时同步是怎么做的

- 服务端维护一张 `sync_meta` 表，任何写操作都会让 `revision + 1`，随后通过 SSE 广播给所有在线客户端。
- 前端收到通知后拉取最新 `/api/state` 并重绘，顶部状态点显示「实时同步中」。
- 如果 SSE 断开（例如免费实例休眠、代理断流），前端自动降级为每 4 秒轮询 `/api/revision`，并定期尝试切回 SSE。所以弱网下也不会出现数据不同步。

---

## 六、⚠️ Render 免费套餐的坑（务必看）

| 项目 | 免费额度 | 后果 |
| --- | --- | --- |
| **免费数据库数量** | **每个 workspace 只能有 1 个** | 已有免费库时，Blueprint 建第二个会报 `cannot have more than one active free tier database`，Web Service 被连带取消 |
| **PostgreSQL** | 1 GB 存储，**创建 30 天后过期** | 过期后数据会被删除（有 14 天宽限期供你升级）。**这是最大的坑** |
| **Web Service** | 512 MB 内存 / 0.1 CPU，**闲置 15 分钟休眠** | 下次访问首次打开要等 30～60 秒冷启动 |
| 实例时长 | 每月 750 小时 / 工作区 | 一个常驻服务够用，多个会超 |

**应对方案（按推荐度排序）**

1. **提前升级数据库**：Render 付费 Postgres 最低约 $6/月，无 30 天限制。这是唯一能长期稳定保存数据的办法。
2. **定期备份**：页面底部「下载数据备份」导出 JSON，保存到本地或网盘。哪怕数据库被删也能一键恢复。
3. **换永久免费的数据库**：把 `DATABASE_URL` 指向 Neon / Supabase 的免费 Postgres（Neon 免费档永久有效，不用换代码，改环境变量即可），Render 只负责跑服务。
4. **防休眠（仓库已内置）**：`.github/workflows/keepalive.yml` 每 10 分钟访问一次 `/healthz`，
   让免费实例保持清醒，避免每次打开都要等 30～60 秒冷启动。
   仓库建好后到 **Actions** 页签点一次 **Run workflow** 手动跑通即可，之后会自动定时执行。
   单服务常驻约消耗 730 实例小时/月，落在免费额度 750 小时以内。
   如果不想用，直接删掉这个文件就行。

> 建议：正式用来记账的话，直接上付费 Postgres（约 $6/月），并把「下载数据备份」养成每周点一次的习惯。

---

## 七、数据表结构

```sql
staff(id, name UNIQUE, rate, allowance, deduction, created_at)

orders(id, fingerprint, order_date, boss, companions JSONB, project, gift,
       unit_price, quantity, amount, stage_manager, allocations JSONB, created_at)

sync_meta(id, revision, updated_at)   -- 实时同步版本号
```

`allocations` 形如 `[{"staffName":"冷屿","amount":30},{"staffName":"阿青","amount":30}]`。

---

## 八、小票识别格式

```
💫 老板：小明
🪐 陪陪：冷屿、阿青
项目：王者荣耀
礼物：皮肤
金额：30
数量：2
总额：60
场控：小昔
日期：2026/10/12
```

- 日期支持 `2026-10-12` / `2026/10/12` / `2026年10月12日` / `10/12`（当年）
- 金额支持带 `￥` `¥` `元` 和千分位逗号
- 多张小票可直接连着粘贴，系统按「老板：」自动切分
- 缺字段或金额对不上会给出黄色警告，且该张不会被保存

---

## 九、项目结构

```
十一愿俱乐部/
├── package.json
├── render.yaml            # Render Blueprint（Web Service + Postgres）
├── .env.example
├── .github/workflows/
│   └── keepalive.yml      # 每 10 分钟唤醒一次，规避免费实例休眠
├── server/
│   ├── index.js           # API + SSE + 静态文件服务
│   ├── db.js              # 连接池、建表、版本号
│   └── auth.js            # 口令校验、HMAC 签名会话
└── public/
    ├── index.html
    ├── style.css
    └── app.js             # 小票解析 + 结算 + 实时同步
```

## License

MIT
