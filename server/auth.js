'use strict'

const crypto = require('crypto')

const COOKIE_NAME = 'xixi_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 天

function secret() {
  return process.env.SESSION_SECRET || 'xixi-club-dev-secret-please-change'
}

function accessCode() {
  return process.env.ACCESS_CODE || ''
}

function sign(value) {
  return crypto
    .createHmac('sha256', secret())
    .update(value)
    .digest('base64url')
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** 校验用户输入的口令是否正确 */
function checkCode(input) {
  const expected = accessCode()
  if (!expected) return false
  return safeEqual(String(input || '').trim(), expected)
}

/** 签发会话 token */
function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }))
    .toString('base64url')
  return payload + '.' + sign(payload)
}

/** 校验会话 token */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false

  const parts = token.split('.')
  if (parts.length !== 2) return false

  const [payload, signature] = parts
  if (!safeEqual(signature, sign(payload))) return false

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof data.exp === 'number' && data.exp > Date.now()
  } catch (e) {
    return false
  }
}

function parseCookies(header) {
  const out = {}
  if (!header) return out

  header.split(';').forEach((pair) => {
    const index = pair.indexOf('=')
    if (index === -1) return
    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  })

  return out
}

function readToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME]
}

function isAuthed(req) {
  return verifyToken(readToken(req))
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' || isHttps(res.req)
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ]
  if (secure) parts.push('Secure')
  res.setHeader('Set-Cookie', parts.join('; '))
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  )
}

function isHttps(req) {
  return (
    req.secure ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
  )
}

/** Express 中间件：要求已登录 */
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next()
  res.status(401).json({ error: 'UNAUTHORIZED', message: '请先输入访问口令' })
}

module.exports = {
  COOKIE_NAME,
  checkCode,
  issueToken,
  verifyToken,
  isAuthed,
  setSessionCookie,
  clearSessionCookie,
  requireAuth
}
