'use strict'

const path = require('path')
const express = require('express')

const { pool, ensureSchema, getRevision, bumpRevision } = require('./db')
const auth = require('./auth')

const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', 1)
app.use(express.json({ limit: '5mb' }))

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const text = (value) => (value === null || value === undefined ? '' : String(value))

const toMoney = (value) => Math.round(num(value) * 100) / 100

function rowToStaff(row) {
  return {
    id: row.id,
    name: row.name,
    rate: num(row.rate),
    allowance: num(row.allowance),
    deduction: num(row.deduction)
  }
}

function rowToOrder(row) {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    date: row.order_date,
    boss: row.boss,
    companions: Array.isArray(row.companions) ? row.companions : [],
    project: row.project,
    gift: row.gift,
    unitPrice: num(row.unit_price),
    quantity: num(row.quantity),
    amount: num(row.amount),
    stageManager: row.stage_manager,
    allocations: Array.isArray(row.allocations) ? row.allocations : [],
    createdAt: row.created_at
  }
}

async function loadStaff() {
  const { rows } = await pool.query(
    'SELECT * FROM staff ORDER BY created_at ASC, name ASC'
  )
  return rows.map(rowToStaff)
}

async function loadOrders() {
  const { rows } = await pool.query(
    'SELECT * FROM orders ORDER BY order_date DESC, created_at DESC'
  )
  return rows.map(rowToOrder)
}

/* ------------------------------------------------------------------ *
 * 实时同步：SSE 广播
 * ------------------------------------------------------------------ */

const clients = new Set()

function broadcast(revision) {
  const payload = `data: ${JSON.stringify({ type: 'change', revision })}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch (e) {
      clients.delete(res)
    }
  }
}

/** 写操作后统一：递增版本号 + 通知所有在线客户端 */
async function notifyChange() {
  const revision = await bumpRevision()
  broadcast(revision)
  return revision
}

/* ------------------------------------------------------------------ *
 * 认证相关
 * ------------------------------------------------------------------ */

/**
 * 存活探针 —— Render 的健康检查指向这里。
 *
 * 只要 HTTP 服务还在跑就返回 200。数据库不通只作为信息返回，不让它拉低状态码：
 * 否则数据库一时连不上，Render 会判定健康检查失败，把部署挂 15 分钟然后 Timed Out，
 * 服务也跟着被回滚。数据库状态请用 /readyz 判断。
 */
app.get('/healthz', async (req, res) => {
  let db = 'ok'

  try {
    await pool.query('SELECT 1')
  } catch (e) {
    db = 'down'
  }

  res.set('Cache-Control', 'no-store')
  res.json({
    ok: true,
    db,
    accessCodeConfigured: Boolean(process.env.ACCESS_CODE)
  })
})

/** 就绪探针 —— 数据库不通返回 503，供人工排查用（Render 健康检查没指向它） */
app.get('/readyz', async (req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ready: true })
  } catch (e) {
    res.status(503).json({ ready: false, error: e.message })
  }
})

app.get('/api/session', (req, res) => {
  const misconfigured = auth.isMisconfigured()

  res.set('Cache-Control', 'no-store')
  res.json({
    authed: !misconfigured && auth.isAuthed(req),
    demo: !process.env.ACCESS_CODE && !misconfigured,
    misconfigured
  })
})

app.post('/api/login', (req, res) => {
  const code = (req.body && req.body.code) || ''

  if (!process.env.ACCESS_CODE) {
    auth.setSessionCookie(res, auth.issueToken())
    return res.json({ ok: true, notice: '未设置 ACCESS_CODE，已跳过口令校验' })
  }

  if (!auth.checkCode(code)) {
    return res.status(401).json({ error: 'BAD_CODE', message: '口令不正确' })
  }

  auth.setSessionCookie(res, auth.issueToken())
  res.json({ ok: true })
})

app.post('/api/logout', (req, res) => {
  auth.clearSessionCookie(res)
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ *
 * 数据接口
 * ------------------------------------------------------------------ */

app.get('/api/state', auth.requireAuth, async (req, res) => {
  try {
    const [revision, staff, orders] = await Promise.all([
      getRevision(),
      loadStaff(),
      loadOrders()
    ])

    res.set('Cache-Control', 'no-store')
    res.json({ revision, staff, orders })
  } catch (e) {
    console.error('[api/state]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  }
})

/** 只取版本号，用于轻量轮询兜底 */
app.get('/api/revision', auth.requireAuth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store')
    res.json({ revision: await getRevision() })
  } catch (e) {
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  }
})

/* ---------------------------- 员工 ---------------------------- */

app.post('/api/staff', auth.requireAuth, async (req, res) => {
  const body = req.body || {}
  const name = text(body.name).trim()
  const rate = num(body.rate)
  const allowance = num(body.allowance)
  const deduction = num(body.deduction)

  if (!name) {
    return res.status(400).json({ error: 'BAD_INPUT', message: '请输入员工姓名' })
  }
  if (rate < 0 || rate > 100 || allowance < 0 || deduction < 0) {
    return res.status(400).json({ error: 'BAD_INPUT', message: '请检查工资设置' })
  }

  try {
    const exists = await pool.query('SELECT 1 FROM staff WHERE name = $1', [name])
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: 'DUPLICATE', message: '员工已存在' })
    }

    const id = Date.now().toString() + Math.random().toString(36).slice(2, 8)
    const { rows } = await pool.query(
      `INSERT INTO staff (id, name, rate, allowance, deduction)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, name, rate, allowance, deduction]
    )

    const revision = await notifyChange()
    res.status(201).json({ staff: rowToStaff(rows[0]), revision })
  } catch (e) {
    console.error('[api/staff POST]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  }
})

app.put('/api/staff/:id', auth.requireAuth, async (req, res) => {
  const body = req.body || {}
  const rate = num(body.rate)
  const allowance = num(body.allowance)
  const deduction = num(body.deduction)

  if (rate < 0 || rate > 100 || allowance < 0 || deduction < 0) {
    return res.status(400).json({ error: 'BAD_INPUT', message: '请检查工资设置' })
  }

  try {
    const { rows } = await pool.query(
      `UPDATE staff SET rate = $2, allowance = $3, deduction = $4
        WHERE id = $1 RETURNING *`,
      [req.params.id, rate, allowance, deduction]
    )

    if (rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '员工不存在' })
    }

    const revision = await notifyChange()
    res.json({ staff: rowToStaff(rows[0]), revision })
  } catch (e) {
    console.error('[api/staff PUT]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  }
})

app.delete('/api/staff/:id', auth.requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1', [req.params.id])
    if (rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '员工不存在' })
    }

    const person = rowToStaff(rows[0])
    const used = await pool.query(
      `SELECT 1 FROM orders
        WHERE allocations @> $1::jsonb
        LIMIT 1`,
      [JSON.stringify([{ staffName: person.name }])]
    )

    if (used.rowCount > 0) {
      return res.status(409).json({
        error: 'IN_USE',
        message: '该员工已出现在订单记录中，为保留历史数据，暂不允许删除。'
      })
    }

    await pool.query('DELETE FROM staff WHERE id = $1', [req.params.id])
    const revision = await notifyChange()
    res.json({ ok: true, revision })
  } catch (e) {
    console.error('[api/staff DELETE]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  }
})

/* ---------------------------- 订单 ---------------------------- */

app.post('/api/orders', auth.requireAuth, async (req, res) => {
  const list = (req.body && req.body.orders) || []

  if (!Array.isArray(list) || list.length === 0) {
    return res.status(400).json({ error: 'BAD_INPUT', message: '没有可保存的订单' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const saved = []

    for (const item of list) {
      const id = text(item.id) || Date.now().toString() + Math.random().toString(36).slice(2, 8)
      const allocations = Array.isArray(item.allocations) ? item.allocations : []
      const companions = Array.isArray(item.companions) ? item.companions : []

      const { rows } = await client.query(
        `INSERT INTO orders
           (id, fingerprint, order_date, boss, companions, project, gift,
            unit_price, quantity, amount, stage_manager, allocations)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          id,
          text(item.fingerprint),
          text(item.date) || '',
          text(item.boss),
          JSON.stringify(companions),
          text(item.project),
          text(item.gift),
          toMoney(item.unitPrice),
          toMoney(item.quantity),
          toMoney(item.amount),
          text(item.stageManager),
          JSON.stringify(allocations)
        ]
      )

      if (rows.length > 0) saved.push(rowToOrder(rows[0]))
    }

    await client.query('COMMIT')

    const revision = await notifyChange()
    res.status(201).json({ saved: saved.length, orders: saved, revision })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[api/orders POST]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  } finally {
    client.release()
  }
})

app.delete('/api/orders/:id', auth.requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id])

    if (rowCount === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '订单不存在' })
    }

    const revision = await notifyChange()
    res.json({ ok: true, revision })
  } catch (e) {
    console.error('[api/orders DELETE]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  }
})

/* ------------------------- 备份 / 恢复 ------------------------- */

app.get('/api/backup/export', auth.requireAuth, async (req, res) => {
  try {
    const [staff, orders] = await Promise.all([loadStaff(), loadOrders()])
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

    res.set('Content-Type', 'application/json; charset=utf-8')
    res.set(
      'Content-Disposition',
      `attachment; filename="xixi-club-backup-${stamp}.json"`
    )
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), staff, orders }, null, 2))
  } catch (e) {
    console.error('[api/backup/export]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  }
})

app.post('/api/backup/import', auth.requireAuth, async (req, res) => {
  const body = req.body || {}
  const staff = Array.isArray(body.staff) ? body.staff : []
  const orders = Array.isArray(body.orders) ? body.orders : []

  if (staff.length === 0 && orders.length === 0) {
    return res.status(400).json({ error: 'BAD_INPUT', message: '备份内容为空' })
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM orders')
    await client.query('DELETE FROM staff')

    for (const person of staff) {
      await client.query(
        `INSERT INTO staff (id, name, rate, allowance, deduction)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        [
          text(person.id) || Date.now().toString() + Math.random().toString(36).slice(2, 8),
          text(person.name).trim(),
          num(person.rate),
          toMoney(person.allowance),
          toMoney(person.deduction)
        ]
      )
    }

    for (const item of orders) {
      await client.query(
        `INSERT INTO orders
           (id, fingerprint, order_date, boss, companions, project, gift,
            unit_price, quantity, amount, stage_manager, allocations)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          text(item.id) || Date.now().toString() + Math.random().toString(36).slice(2, 8),
          text(item.fingerprint),
          text(item.date) || '',
          text(item.boss),
          JSON.stringify(Array.isArray(item.companions) ? item.companions : []),
          text(item.project),
          text(item.gift),
          toMoney(item.unitPrice),
          toMoney(item.quantity),
          toMoney(item.amount),
          text(item.stageManager),
          JSON.stringify(Array.isArray(item.allocations) ? item.allocations : [])
        ]
      )
    }

    await client.query('COMMIT')

    const revision = await notifyChange()
    res.json({ ok: true, staff: staff.length, orders: orders.length, revision })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[api/backup/import]', e)
    res.status(500).json({ error: 'DB_ERROR', message: e.message })
  } finally {
    client.release()
  }
})

/* ------------------------------------------------------------------ *
 * 实时推送通道
 * ------------------------------------------------------------------ */

app.get('/api/events', auth.requireAuth, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()

  try {
    const revision = await getRevision()
    res.write(`data: ${JSON.stringify({ type: 'hello', revision })}\n\n`)
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`)
  }

  clients.add(res)

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch (e) {
      /* 忽略 */
    }
  }, 25000)

  req.on('close', () => {
    clearInterval(heartbeat)
    clients.delete(res)
  })
})

/* ------------------------------------------------------------------ *
 * 静态页面
 * ------------------------------------------------------------------ */

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
})

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('[db] ✗ 缺少环境变量 DATABASE_URL')
    console.error('     环境变量 → Environment → Add Environment Variable，粘贴 Postgres 连接串后 Save。')
    console.error('     Neon 示例：postgresql://user:pass@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require')
  } else {
    try {
      await ensureSchema()
      console.log('[db] ✓ 数据表已就绪')
    } catch (e) {
      console.error('[db] ✗ 初始化失败：', e.message)
      console.error('     请检查 DATABASE_URL 是否正确、数据库实例是否可用、IP/网络是否放通。')
    }
  }

  if (auth.isMisconfigured()) {
    console.error('[auth] ✗ 生产环境未设置 ACCESS_CODE，已开启保护：所有数据接口返回 503。')
    console.error('     请在 Environment 里添加 ACCESS_CODE，否则网站无法使用。')
  } else if (!process.env.ACCESS_CODE) {
    console.warn('[auth] ⚠ 未设置 ACCESS_CODE（非生产环境），网站不校验口令。')
  } else {
    console.log('[auth] ✓ 访问口令已启用')
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] 十一愿俱乐部已启动，端口 ${PORT}`)
    console.log(`[server] 自检：http://localhost:${PORT}/healthz`)
  })
}

start()
