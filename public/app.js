/* 十一愿俱乐部 · 网站版前端
 * 数据全部来自服务端 /api，通过 SSE + 轮询保持多设备实时同步。
 */
(function () {
  'use strict'

  /* ============================================================
   * 小工具
   * ============================================================ */

  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel))

  const esc = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

  const money = (value) => (Math.round(Number(value || 0) * 100) / 100).toFixed(2)

  const makeId = () =>
    Date.now().toString() + Math.random().toString(36).slice(2, 8)

  const currentMonth = () => {
    const d = new Date()
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  }

  let toastTimer = null
  function toast(message, kind) {
    const el = $('#toast')
    el.textContent = message
    el.className = 'toast' + (kind ? ' ' + kind : '')
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { el.hidden = true }, 2600)
  }

  /* ============================================================
   * 小票解析（与原小程序逻辑保持一致）
   * ============================================================ */

  function getField(text, name) {
    const lines = text.split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const re = new RegExp('^(?:💫|🪐)?\\s*' + name + '\\s*[:：]\\s*(.*)$')
      const match = line.match(re)
      if (match) return match[1].trim()
    }

    return ''
  }

  function getNumberField(text, name) {
    const value = getField(text, name).replace(/[￥¥元,\s，]/g, '')
    if (!value || !/^\d+(\.\d+)?$/.test(value)) return null
    return Number(value)
  }

  function parseDate(value) {
    const year = new Date().getFullYear()
    let match = value.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)

    if (match) {
      return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0')
    }

    match = value.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/)

    if (match) {
      return year + '-' + match[1].padStart(2, '0') + '-' + match[2].padStart(2, '0')
    }

    return ''
  }

  function parseCompanions(value) {
    const parts = value.split(/[\s、,，;；|]+/)
    const names = []

    parts.forEach((part) => {
      const name = part.trim()
      if (name && names.indexOf(name) === -1) names.push(name)
    })

    return names
  }

  function splitAmount(names, total) {
    if (names.length === 0) return []

    const cents = Math.round(total * 100)
    const base = Math.floor(cents / names.length)
    const remainder = cents % names.length

    return names.map((name, index) => ({
      staffName: name,
      amount: (base + (index < remainder ? 1 : 0)) / 100
    }))
  }

  function parseReceipt(text) {
    const boss = getField(text, '老板')
    const companions = parseCompanions(getField(text, '陪陪'))
    const project = getField(text, '项目')
    const gift = getField(text, '礼物')
    const unitPrice = getNumberField(text, '金额')
    const quantity = getNumberField(text, '数量')
    const printedTotal = getNumberField(text, '总额')
    const stageManager = getField(text, '场控')
    const date = parseDate(getField(text, '日期'))

    const warnings = []
    let amount = 0

    if (printedTotal !== null) {
      amount = printedTotal
    } else if (unitPrice !== null && quantity !== null) {
      amount = Math.round(unitPrice * quantity * 100) / 100
      warnings.push('没有识别到总额，已按单价乘数量计算')
    } else {
      warnings.push('无法识别订单总额')
    }

    if (!boss) warnings.push('缺少老板')
    if (companions.length === 0) warnings.push('缺少陪陪名单')
    if (!project) warnings.push('缺少项目')
    if (unitPrice === null) warnings.push('无法识别金额')
    if (quantity === null) warnings.push('无法识别数量')
    if (!date) warnings.push('无法识别日期')

    const mismatch =
      printedTotal !== null &&
      unitPrice !== null &&
      quantity !== null &&
      Math.abs(printedTotal - unitPrice * quantity) > 0.011

    if (mismatch) warnings.push('总额与金额乘数量不一致，请核对')

    const fingerprint = [
      date,
      boss,
      companions.slice().sort().join(','),
      project,
      gift,
      unitPrice === null ? '' : money(unitPrice),
      quantity === null ? '' : String(quantity),
      money(amount),
      stageManager
    ].join('|')

    const valid =
      !!boss &&
      companions.length > 0 &&
      !!project &&
      unitPrice !== null &&
      quantity !== null &&
      !!date &&
      printedTotal !== null &&
      !mismatch

    return {
      id: makeId(),
      fingerprint,
      date,
      boss,
      companions,
      project,
      gift,
      unitPrice: unitPrice === null ? 0 : unitPrice,
      quantity: quantity === null ? 0 : quantity,
      amount,
      stageManager,
      allocations: splitAmount(companions, amount),
      valid,
      warning: warnings.join('；')
    }
  }

  /* ============================================================
   * 服务端通信
   * ============================================================ */

  const state = {
    staff: [],
    orders: [],
    revision: -1,
    preview: [],
    orderFilter: '',
    payrollMonth: currentMonth()
  }

  async function api(path, options) {
    const res = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options || {}))

    let body = null
    try { body = await res.json() } catch (e) { body = null }

    if (res.status === 401) {
      showLogin()
      throw new Error((body && body.message) || '登录已过期，请重新输入口令')
    }

    if (!res.ok) {
      throw new Error((body && body.message) || ('请求失败（' + res.status + '）'))
    }

    return body
  }

  /* ============================================================
   * 登录
   * ============================================================ */

  function showLogin() {
    $('#login-view').hidden = false
    $('#app-view').hidden = true
    closeStream()
  }

  function showApp() {
    $('#login-view').hidden = true
    $('#app-view').hidden = false
  }

  async function checkSession() {
    try {
      const info = await fetch('/api/session', { credentials: 'same-origin' })
        .then((r) => r.json())

      if (info.authed) {
        showApp()
        await refresh(true)
        openStream()
      } else {
        showLogin()
        if (info.demo) {
          const err = $('#login-error')
          err.textContent = '服务端未设置 ACCESS_CODE，直接点击「进入系统」即可。'
          err.hidden = false
        }
      }
    } catch (e) {
      showLogin()
    }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault()

    const code = $('#login-code').value
    const err = $('#login-error')
    const btn = $('#login-submit')

    err.hidden = true
    btn.disabled = true

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      })

      const body = await res.json()

      if (!res.ok) {
        err.textContent = body.message || '口令不正确'
        err.hidden = false
        return
      }

      $('#login-code').value = ''
      showApp()
      await refresh(true)
      openStream()
      toast('已连接，数据实时同步中', 'ok')
    } catch (e2) {
      err.textContent = '网络异常，请稍后重试'
      err.hidden = false
    } finally {
      btn.disabled = false
    }
  })

  $('#btn-logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
    showLogin()
    $('#login-code').focus()
  })

  /* ============================================================
   * 实时同步：SSE + 轮询兜底
   * ============================================================ */

  let stream = null
  let pollTimer = null
  let streamFailures = 0

  function setSync(mode, label) {
    const dot = $('#sync-dot')
    dot.className = 'sync-dot' + (mode ? ' ' + mode : '')
    $('#sync-text').textContent = label
  }

  function closeStream() {
    if (stream) { stream.close(); stream = null }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    setSync('', '未连接')
  }

  function openStream() {
    closeStream()

    try {
      stream = new EventSource('/api/events', { withCredentials: true })
    } catch (e) {
      startPolling()
      return
    }

    stream.onopen = () => {
      streamFailures = 0
      setSync('online', '实时同步中')
      stopPolling()
    }

    stream.onmessage = (event) => {
      let payload = null
      try { payload = JSON.parse(event.data) } catch (e) { return }

      if (payload.type === 'change' && payload.revision !== state.revision) {
        refresh(false)
      }
    }

    stream.onerror = () => {
      if (stream) { stream.close(); stream = null }
      streamFailures++
      startPolling()
    }
  }

  function startPolling() {
    if (pollTimer) return
    setSync('offline', '轮询同步中')

    pollTimer = setInterval(async () => {
      // 每 30 秒尝试切回 SSE
      if (streamFailures > 0 && !stream) {
        streamFailures = 0
        openStream()
        return
      }

      try {
        const info = await api('/api/revision')
        if (info.revision !== state.revision) await refresh(false)
      } catch (e) { /* 忽略，下一轮再试 */ }
    }, 4000)
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  /** 拉取最新数据并重绘 */
  async function refresh(showLoading) {
    try {
      const data = await api('/api/state')
      state.staff = data.staff || []
      state.orders = data.orders || []
      state.revision = data.revision
      renderAll()
      setSync('online', '实时同步中')
    } catch (e) {
      if (showLoading) toast(e.message, 'err')
      setSync('offline', '同步失败')
    }
  }

  /* ============================================================
   * Tab 切换
   * ============================================================ */

  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach((b) => b.classList.toggle('active', b === btn))
      const tab = btn.dataset.tab
      $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab))
      if (tab === 'payroll') renderPayroll()
    })
  })

  /* ============================================================
   * 批量结单
   * ============================================================ */

  $('#btn-parse').addEventListener('click', () => {
    const raw = $('#batch-text').value.trim()

    if (!raw) { toast('请先粘贴小票', 'err'); return }

    const chunks = raw
      .split(/(?=(?:💫|🪐)?\s*老板\s*[:：])/)
      .filter((part) => /老板\s*[:：]/.test(part))

    if (chunks.length === 0) {
      toast('没有识别到小票，请确认内容包含「老板：」字段', 'err')
      return
    }

    state.preview = chunks.map(parseReceipt)

    const validCount = state.preview.filter((o) => o.valid).length

    const message = $('#preview-message')
    message.textContent =
      '共识别 ' + state.preview.length + ' 张小票，其中 ' + validCount + ' 张通过基本检查。'
    message.hidden = false

    const fingerprints = state.orders.map((o) => o.fingerprint)
    const duplicates = state.preview.filter(
      (o) => o.valid && fingerprints.indexOf(o.fingerprint) !== -1
    ).length

    if (duplicates > 0) {
      message.textContent += ' 注意：有 ' + duplicates +
        ' 张与已保存订单内容相同。相同内容也可能是正常订单，系统不会自动跳过。'
    }

    renderPreview()
  })

  $('#btn-clear-preview').addEventListener('click', () => {
    state.preview = []
    $('#batch-text').value = ''
    $('#preview-message').hidden = true
    renderPreview()
    renderOrders()
  })

  function renderPreview() {
    const box = $('#preview-list')
    const list = state.preview

    $('#btn-save-orders').hidden = list.length === 0

    if (list.length === 0) { box.innerHTML = ''; return }

    box.innerHTML = list.map((item, index) => {
      const allocations = item.allocations.map((a) => `
        <div class="allocation-line"><span>${esc(a.staffName)}</span><span>¥${money(a.amount)}</span></div>
      `).join('')

      return `
      <div class="card preview-item" data-index="${index}">
        <div class="card-head">
          <h2 class="section-title">识别结果 ${index + 1}</h2>
          <button class="delete-btn" data-drop="${index}" type="button">移除</button>
        </div>
        <div class="data-line"><span>老板</span><span>${esc(item.boss) || '—'}</span></div>
        <div class="data-line"><span>日期</span><span>${esc(item.date) || '—'}</span></div>
        <div class="data-line"><span>项目</span><span>${esc(item.project) || '—'}</span></div>
        <div class="data-line"><span>礼物</span><span>${esc(item.gift) || '—'}</span></div>
        <div class="data-line"><span>单价</span><span>${esc(item.unitPrice)}</span></div>
        <div class="data-line"><span>数量</span><span>${esc(item.quantity)}</span></div>
        <div class="data-line total"><span>总额</span><span>¥${money(item.amount)}</span></div>
        <div class="data-line"><span>场控</span><span>${esc(item.stageManager) || '—'}</span></div>
        <div class="sub-title">陪陪平均分配</div>
        ${allocations || '<div class="hint">没有识别到陪陪名单</div>'}
        ${item.valid ? '<div class="status-ok">✓ 基本检查通过</div>' : ''}
        ${item.warning ? `<div class="warning">${esc(item.warning)}</div>` : ''}
      </div>`
    }).join('')
  }

  $('#preview-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-drop]')
    if (!btn) return
    state.preview.splice(Number(btn.dataset.drop), 1)
    renderPreview()
  })

  $('#btn-save-orders').addEventListener('click', async () => {
    const previews = state.preview

    if (previews.length === 0) { toast('请先识别小票', 'err'); return }

    const valid = previews.filter((o) => o.valid)
    const invalid = previews.length - valid.length

    if (valid.length === 0) {
      toast('有 ' + invalid + ' 张小票未通过检查，请核对后再保存', 'err')
      return
    }

    const fingerprints = state.orders.map((o) => o.fingerprint)
    const duplicates = valid.filter((o) => fingerprints.indexOf(o.fingerprint) !== -1).length

    let msg = '确定保存这 ' + valid.length + ' 张订单吗？保存后会计入工资统计。'
    if (invalid > 0) msg += '\n未通过检查的 ' + invalid + ' 张不会保存。'
    if (duplicates > 0) {
      msg += '\n其中 ' + duplicates + ' 张与已保存订单内容相同，请确认是否为正常下单。'
    }

    if (!window.confirm(msg)) return

    const btn = $('#btn-save-orders')
    btn.disabled = true

    try {
      const result = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ orders: valid })
      })

      state.preview = []
      $('#batch-text').value = ''
      $('#preview-message').hidden = true
      renderPreview()

      toast('已保存 ' + result.saved + ' 张订单', 'ok')
      await refresh(false)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      btn.disabled = false
    }
  })

  /* -------------------- 已保存订单 -------------------- */

  $('#orders-filter').addEventListener('change', (e) => {
    state.orderFilter = e.target.value
    renderOrders()
  })

  $('#btn-filter-clear').addEventListener('click', () => {
    state.orderFilter = ''
    $('#orders-filter').value = ''
    renderOrders()
  })

  function renderOrders() {
    const box = $('#orders-list')
    const filter = state.orderFilter

    const list = filter
      ? state.orders.filter((o) => String(o.date).indexOf(filter) === 0)
      : state.orders

    $('#orders-count').textContent = filter
      ? list.length + '/' + state.orders.length
      : String(state.orders.length)

    if (list.length === 0) {
      box.innerHTML = `<div class="empty">${filter ? '该月份还没有订单。' : '还没有订单记录。'}</div>`
      return
    }

    box.innerHTML = list.map((order) => {
      const allocations = order.allocations.map((a) =>
        `<span class="tag">${esc(a.staffName)} ¥${money(a.amount)}</span>`
      ).join('')

      return `
      <div class="row-item">
        <div class="row-main">
          <div class="row-top">
            <span>${esc(order.project) || '未填写项目'}</span>
            <span class="amount">¥${money(order.amount)}</span>
          </div>
          <div class="row-sub">日期：${esc(order.date)}　单价：${esc(order.unitPrice)} × ${esc(order.quantity)}</div>
          <div class="row-sub">老板：${esc(order.boss) || '—'}　场控：${esc(order.stageManager) || '—'}</div>
          <div class="row-sub">陪陪：${order.companions.map(esc).join('、') || '—'}</div>
          <div>${allocations}</div>
        </div>
        <button class="delete-btn" data-order="${esc(order.id)}" type="button">删除</button>
      </div>`
    }).join('')
  }

  $('#orders-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-order]')
    if (!btn) return

    if (!window.confirm('确定删除这笔订单吗？删除后该订单不再计入工资统计。')) return

    try {
      await api('/api/orders/' + encodeURIComponent(btn.dataset.order), { method: 'DELETE' })
      toast('订单已删除', 'ok')
      await refresh(false)
    } catch (err) {
      toast(err.message, 'err')
    }
  })

  /* ============================================================
   * 员工管理
   * ============================================================ */

  $('#btn-add-staff').addEventListener('click', async () => {
    const name = $('#staff-name').value.trim()
    const rate = Number($('#staff-rate').value)
    const allowance = Number($('#staff-allowance').value)
    const deduction = Number($('#staff-deduction').value)

    if (!name) { toast('请输入员工姓名', 'err'); return }

    if (
      !Number.isFinite(rate) || rate < 0 || rate > 100 ||
      !Number.isFinite(allowance) || allowance < 0 ||
      !Number.isFinite(deduction) || deduction < 0
    ) { toast('请检查工资设置', 'err'); return }

    try {
      await api('/api/staff', {
        method: 'POST',
        body: JSON.stringify({ name, rate, allowance, deduction })
      })

      $('#staff-name').value = ''
      $('#staff-rate').value = '30'
      $('#staff-allowance').value = '0'
      $('#staff-deduction').value = '0'

      toast('员工已添加', 'ok')
      await refresh(false)
    } catch (e) {
      toast(e.message, 'err')
    }
  })

  function renderStaff() {
    const box = $('#staff-list')
    $('#staff-count').textContent = String(state.staff.length)

    if (state.staff.length === 0) {
      box.innerHTML = '<div class="empty">请先添加员工。</div>'
      return
    }

    box.innerHTML = state.staff.map((person) => `
      <div class="row-item">
        <div class="row-main">
          <div class="row-top"><span>${esc(person.name)}</span></div>
          <div class="row-sub">提成 ${esc(person.rate)}%　补贴 ¥${money(person.allowance)}　扣款 ¥${money(person.deduction)}</div>
        </div>
        <button class="delete-btn" data-staff="${esc(person.id)}" type="button">删除</button>
      </div>`
    ).join('')
  }

  $('#staff-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-staff]')
    if (!btn) return

    if (!window.confirm('确定删除该员工吗？')) return

    try {
      await api('/api/staff/' + encodeURIComponent(btn.dataset.staff), { method: 'DELETE' })
      toast('员工已删除', 'ok')
      await refresh(false)
    } catch (err) {
      toast(err.message, 'err')
    }
  })

  /* ============================================================
   * 工资统计
   * ============================================================ */

  $('#payroll-month').addEventListener('change', (e) => {
    state.payrollMonth = e.target.value || currentMonth()
    renderPayroll()
  })

  function computePayroll() {
    const month = state.payrollMonth || currentMonth()

    const orders = state.orders.filter((order) => String(order.date).indexOf(month) === 0)

    let orderCents = 0
    orders.forEach((order) => { orderCents += Math.round(order.amount * 100) })

    let allocationCents = 0
    let commissionCents = 0
    let payableCents = 0

    const rows = state.staff.map((person) => {
      let allocated = 0
      let count = 0

      orders.forEach((order) => {
        order.allocations.forEach((allocation) => {
          if (allocation.staffName === person.name) {
            allocated += Math.round(allocation.amount * 100)
            count++
          }
        })
      })

      const commission = Math.round(allocated * person.rate / 100)
      const allowance = count > 0 ? Math.round(person.allowance * 100) : 0
      const deduction = count > 0 ? Math.round(person.deduction * 100) : 0
      const payable = commission + allowance - deduction

      allocationCents += allocated
      commissionCents += commission
      payableCents += payable

      return {
        id: person.id,
        name: person.name,
        orderCount: count,
        allocated,
        commission,
        allowance,
        deduction,
        payable
      }
    })

    const unknown = new Set()
    orders.forEach((order) => {
      order.allocations.forEach((a) => {
        if (!state.staff.some((p) => p.name === a.staffName)) unknown.add(a.staffName)
      })
    })

    return {
      month,
      orderCount: orders.length,
      orderCents,
      allocationCents,
      commissionCents,
      payableCents,
      rows,
      unknownNames: Array.from(unknown)
    }
  }

  function renderPayroll() {
    const data = computePayroll()

    $('#sum-order').textContent = '¥' + money(data.orderCents / 100)
    $('#sum-allocation').textContent = '¥' + money(data.allocationCents / 100)
    $('#sum-commission').textContent = '¥' + money(data.commissionCents / 100)
    $('#sum-payable').textContent = '¥' + money(data.payableCents / 100)

    const box = $('#payroll-list')

    if (state.staff.length === 0) {
      box.innerHTML = '<div class="empty">还没有员工，请先到「员工管理」添加。</div>'
      return
    }

    const rowsHtml = data.rows.map((person) => `
      <div class="row-item">
        <div class="row-main">
          <div class="row-top">
            <span>${esc(person.name)}</span>
            <span class="amount">¥${money(person.payable / 100)}</span>
          </div>
          <div class="row-sub">参与分配 ${person.orderCount} 次　分配金额 ¥${money(person.allocated / 100)}</div>
          <div class="row-sub">提成 ¥${money(person.commission / 100)}　补贴 ¥${money(person.allowance / 100)}　扣款 ¥${money(person.deduction / 100)}</div>
        </div>
      </div>`
    ).join('')

    const unknownHtml = data.unknownNames.length
      ? `<div class="warning">以下名字出现在订单里，但不在员工名单中，未计入工资：${data.unknownNames.map(esc).join('、')}</div>`
      : ''

    box.innerHTML = rowsHtml + unknownHtml
  }

  $('#btn-export-csv').addEventListener('click', () => {
    const data = computePayroll()

    const header = ['月份', '员工', '参与分配次数', '分配金额', '提成', '补贴', '扣款', '应发工资']
    const lines = [header.join(',')]

    data.rows.forEach((p) => {
      lines.push([
        data.month,
        '"' + p.name.replace(/"/g, '""') + '"',
        p.orderCount,
        money(p.allocated / 100),
        money(p.commission / 100),
        money(p.allowance / 100),
        money(p.deduction / 100),
        money(p.payable / 100)
      ].join(','))
    })

    lines.push('')
    lines.push(['合计', '', data.orderCount + ' 单', money(data.allocationCents / 100),
      money(data.commissionCents / 100), '', '', money(data.payableCents / 100)].join(','))

    download(
      new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
      '工资表-' + data.month + '.csv'
    )
  })

  function download(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  /* ============================================================
   * 备份 / 恢复
   * ============================================================ */

  $('#btn-backup').addEventListener('click', () => {
    window.location.href = '/api/backup/export'
  })

  $('#btn-restore').addEventListener('click', () => {
    $('#restore-file').click()
  })

  $('#restore-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]
    if (!file) return

    if (!window.confirm('导入备份会清空当前所有员工和订单，然后写入备份内容。确定继续吗？')) {
      e.target.value = ''
      return
    }

    try {
      const text = await file.text()
      const payload = JSON.parse(text)

      const result = await api('/api/backup/import', {
        method: 'POST',
        body: JSON.stringify({
          staff: payload.staff || [],
          orders: payload.orders || []
        })
      })

      toast('已恢复 ' + result.staff + ' 名员工、' + result.orders + ' 张订单', 'ok')
      await refresh(false)
    } catch (err) {
      toast('恢复失败：' + err.message, 'err')
    } finally {
      e.target.value = ''
    }
  })

  /* ============================================================
   * 汇总渲染
   * ============================================================ */

  function renderAll() {
    renderPreview()
    renderOrders()
    renderStaff()
    renderPayroll()
  }

  /* ============================================================
   * 初始化
   * ============================================================ */

  $('#orders-filter').value = ''
  $('#payroll-month').value = state.payrollMonth

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('#app-view').hidden) refresh(false)
  })

  checkSession()
})()
