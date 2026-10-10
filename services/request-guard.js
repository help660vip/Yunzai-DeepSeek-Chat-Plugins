import { LIMITS } from '../config/config.js'

export class RequestLimitError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// 不排队积压请求；检查与占位同步完成，所有调用入口共用同一实例
export class RequestGuard {
  constructor(limits = LIMITS, now = Date.now) {
    this.limits = limits
    this.now = now
    this.windows = new Map()
    this.lastStarted = new Map()
    this.activeUsers = new Set()
    this.active = 0
    this.notices = new Map()
  }

  acquire({ userId, groupId, isMaster = false } = {}) {
    const now = this.now()
    const user = String(userId ?? '')
    if (!user) throw new RequestLimitError('INVALID_USER', '这条消息暂时处理不了')
    for (const [key, timestamps] of this.windows) {
      const recent = timestamps.filter(time => now - time < 60000)
      if (recent.length) this.windows.set(key, recent)
      else this.windows.delete(key)
    }
    for (const [key, time] of this.lastStarted) if (now - time >= 60000) this.lastStarted.delete(key)
    const privileged = isMaster === true
    if (this.activeUsers.has(user) || (!privileged && this.active >= this.limits.maxConcurrentRequests)) {
      throw new RequestLimitError('BUSY', '正忙着呢 等会再来吧')
    }
    if (!privileged) {
      if (this.lastStarted.has(user) && now - this.lastStarted.get(user) < this.limits.cooldownMs) {
        throw new RequestLimitError('COOLDOWN', '慢点发 我还没缓过来')
      }
      const scopes = [
        [`user:${user}`, this.limits.rateLimitPerMinute],
        ['global', this.limits.globalRateLimitPerMinute]
      ]
      if (groupId != null) scopes.push([`group:${groupId}`, this.limits.groupRateLimitPerMinute])
      if (scopes.some(([key, max]) => (this.windows.get(key)?.length || 0) >= max)) {
        throw new RequestLimitError('RATE_LIMIT', '发得有点快 歇会再聊吧')
      }
      for (const [key] of scopes) this.windows.set(key, [...(this.windows.get(key) || []), now])
      this.lastStarted.set(user, now)
    }
    this.activeUsers.add(user)
    if (!privileged) this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeUsers.delete(user)
      if (!privileged) this.active--
    }
  }

  shouldNotify(userId) {
    const now = this.now()
    for (const [key, time] of this.notices) if (now - time >= this.limits.noticeCooldownMs) this.notices.delete(key)
    const key = String(userId)
    if (this.notices.has(key)) return false
    this.notices.set(key, now)
    return true
  }
}
