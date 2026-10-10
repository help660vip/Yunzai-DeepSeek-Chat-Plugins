import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, LIMITS } from '../config/config.js'
import { clampArray } from '../utils/tools.js'
import { RequestLimitError } from './request-guard.js'

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) ?? fallback
  } catch (error) {
    globalThis.logger?.warn?.(`[存储] 读取 ${filePath} 失败 ${error.message}`)
    return fallback
  }
}

const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const budgetDay = now => new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

export class StorageService {
  constructor(options = {}) {
    this.dataDir = options.dataDir || DATA_DIR
    this.backupDir = path.join(this.dataDir, 'backup')
    this.exportDir = path.join(this.dataDir, 'exports')
    this.filePaths = Object.fromEntries(['context', 'stats', 'important', 'archive', 'blacklist', 'relationships', 'meta']
      .map(key => [key, path.join(this.dataDir, `${key}.json`)]))
    for (const dir of [this.dataDir, this.backupDir, this.exportDir]) fs.mkdirSync(dir, { recursive: true })
    this.contextMap = new Map(Object.entries(readJson(this.filePaths.context, {}))
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.filter(msg => typeof msg?.content === 'string' && ['user', 'assistant'].includes(msg.role))
        .slice(-(key.endsWith('_public') ? LIMITS.maxPublicMemory : LIMITS.maxContext))]))
    this.archives = new Map(Object.entries(readJson(this.filePaths.archive, {})).filter(([, value]) => Array.isArray(value)))
    this.importantInfo = new Map(Object.entries(readJson(this.filePaths.important, {})))
    this.stats = readJson(this.filePaths.stats, {})
    for (const key of ['totalCalls', 'totalTokens', 'promptTokens', 'completionTokens']) this.stats[key] = nonnegative(this.stats[key])
    this.stats.lastReset ||= Date.now()
    this.blacklist = readJson(this.filePaths.blacklist, { groups: [], users: [] })
    this.relationships = readJson(this.filePaths.relationships, {})
    this.meta = readJson(this.filePaths.meta, { lastBackupDate: null })
    this.writeQueue = []
    this.isWriting = false
    this.writeDebounceTimers = new Map()
    this.groupWindows = new Map()
    this.tempCounter = 0
    if (options.startTimers !== false) {
      this.backupTimer = setInterval(() => {
        this.maybeBackup().catch(error => globalThis.logger?.error?.(`[存储] 备份失败 ${error.message}`))
      }, 60 * 60 * 1000)
      this.backupTimer.unref?.()
    }
  }

  async processWriteQueue() {
    if (this.isWriting) return
    this.isWriting = true
    try {
      while (this.writeQueue.length) {
        const task = this.writeQueue.shift()
        try {
          await this.atomicWrite(task.filePath, task.data)
          task.resolve()
        } catch (error) {
          globalThis.logger?.error?.(`[存储] 写入失败 ${error.message}`)
          task.reject(error)
        }
      }
    } finally {
      this.isWriting = false
    }
  }

  async atomicWrite(filePath, data) {
    const tempPath = `${filePath}.tmp.${process.pid}.${this.tempCounter++}`
    try {
      await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8')
      const fd = await fs.promises.open(tempPath, 'r+')
      try { await fd.sync() } finally { await fd.close() }
      await fs.promises.rename(tempPath, filePath)
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {})
      throw error
    }
  }

  scheduleFlush(key) {
    // 第一次变脏后一秒落盘，持续群消息不会无限推迟写入
    if (this.writeDebounceTimers.has(key)) return
    this.writeDebounceTimers.set(key, setTimeout(() => {
      this.writeDebounceTimers.delete(key)
      this.enqueueWrite(key).catch(error => globalThis.logger?.error?.(`[存储] 刷新失败 ${error.message}`))
    }, 1000))
  }

  enqueueWrite(key) {
    const mapping = {
      context: () => Object.fromEntries(this.contextMap),
      archive: () => Object.fromEntries(this.archives),
      important: () => Object.fromEntries(this.importantInfo),
      stats: () => this.stats,
      blacklist: () => this.blacklist,
      relationships: () => this.relationships,
      meta: () => this.meta
    }
    if (!mapping[key]) return Promise.resolve()
    // 入队时固定快照，避免异步写盘期间引用又被修改
    const data = JSON.parse(JSON.stringify(mapping[key]()))
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ filePath: this.filePaths[key], data, resolve, reject })
      void this.processWriteQueue()
    })
  }

  async flushAll() {
    for (const key of [...this.writeDebounceTimers.keys()]) {
      clearTimeout(this.writeDebounceTimers.get(key))
      this.writeDebounceTimers.delete(key)
      await this.enqueueWrite(key)
    }
    while (this.writeQueue.length || this.isWriting) await new Promise(resolve => setTimeout(resolve, 10))
  }

  async close() {
    clearInterval(this.backupTimer)
    await this.flushAll()
  }

  getContextMap() { return this.contextMap }
  getContext(contextId) {
    if (!this.contextMap.has(contextId)) this.contextMap.set(contextId, [])
    return this.contextMap.get(contextId)
  }
  appendContext(contextId, message) {
    const context = this.getContext(contextId)
    context.push(message)
    clampArray(context, contextId.endsWith('_public') ? LIMITS.maxPublicMemory : LIMITS.maxContext)
    this.scheduleFlush('context')
    return context
  }
  replaceContext(contextId, nextContext) {
    this.contextMap.set(contextId, nextContext.slice(-(contextId.endsWith('_public') ? LIMITS.maxPublicMemory : LIMITS.maxContext)))
    this.scheduleFlush('context')
  }
  deleteContext(contextId) {
    this.contextMap.delete(contextId)
    this.scheduleFlush('context')
  }
  clearConversationData(contextId) {
    const a = this.contextMap.delete(contextId)
    const b = this.archives.delete(contextId)
    const c = this.importantInfo.delete(`${contextId}_info`)
    if (a) this.scheduleFlush('context')
    if (b) this.scheduleFlush('archive')
    if (c) this.scheduleFlush('important')
    return a || b || c
  }
  clearAllContexts() {
    this.contextMap.clear()
    this.archives.clear()
    this.importantInfo.clear()
    this.groupWindows.clear()
    for (const key of ['context', 'archive', 'important']) this.scheduleFlush(key)
  }
  getArchives() { return this.archives }
  appendArchive(contextId, archive) {
    const list = this.archives.get(contextId) || []
    list.push(archive)
    clampArray(list, LIMITS.archiveKeepCount)
    this.archives.set(contextId, list)
    this.scheduleFlush('archive')
  }
  getImportantInfo() { return this.importantInfo }
  mergeImportantFacts(contextId, payload) {
    const key = `${contextId}_info`
    const current = this.importantInfo.get(key) || { profile: {}, facts: [], updatedAt: 0 }
    if (payload?.profile && typeof payload.profile === 'object' && !Array.isArray(payload.profile)) {
      current.profile = { ...current.profile, ...payload.profile }
    }
    if (Array.isArray(payload?.facts)) {
      const known = new Set(current.facts.map(item => item.content))
      for (const item of payload.facts) {
        if (typeof item !== 'string') continue
        const content = item.trim().slice(0, 500)
        if (!content || known.has(content)) continue
        current.facts.push({ content, time: Date.now() })
        known.add(content)
      }
      clampArray(current.facts, LIMITS.summaryFactsKeep)
    }
    current.updatedAt = Date.now()
    this.importantInfo.set(key, current)
    this.scheduleFlush('important')
  }
  getStats() { return this.stats }
  recordUsage(usage = {}) {
    const prompt = nonnegative(usage?.prompt_tokens)
    const completion = nonnegative(usage?.completion_tokens)
    this.stats.totalCalls++
    this.stats.promptTokens += prompt
    this.stats.completionTokens += completion
    this.stats.totalTokens += Math.max(nonnegative(usage?.total_tokens), prompt + completion)
    this.scheduleFlush('stats')
  }

  getDailyBudget(now = Date.now()) {
    const day = budgetDay(now)
    if (this.meta.tokenBudget?.day !== day) this.meta.tokenBudget = { day, used: {} }
    return this.meta.tokenBudget
  }

  async reserveTokenBudget(subject, amount, limits = LIMITS, now = Date.now()) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('无效 Token 预算')
    const ledger = this.getDailyBudget(now)
    const scopes = [['global', limits.dailyGlobalTokens], [`user:${subject.userId}`, limits.dailyUserTokens]]
    if (subject.groupId != null) scopes.push([`group:${subject.groupId}`, limits.dailyGroupTokens])
    if (scopes.some(([key, max]) => nonnegative(ledger.used[key]) + amount > max)) {
      throw new RequestLimitError('DAILY_BUDGET', '今天聊得有点多了 明天再来吧')
    }
    for (const [key] of scopes) ledger.used[key] = nonnegative(ledger.used[key]) + amount
    // 请求发出前持久化预占；重启和未知结果的失败请求无法清零额度
    await this.enqueueWrite('meta')
    return { ledger, keys: scopes.map(([key]) => key), amount }
  }

  async settleTokenBudget(reservation, usage) {
    if (!usage || this.meta.tokenBudget !== reservation.ledger) return
    const actual = nonnegative(usage.total_tokens)
    for (const key of reservation.keys) {
      reservation.ledger.used[key] = Math.max(0, nonnegative(reservation.ledger.used[key]) - reservation.amount + actual)
    }
    await this.enqueueWrite('meta')
  }

  getBlacklist() { return this.blacklist }
  setBlacklist(blacklist) { this.blacklist = blacklist; this.scheduleFlush('blacklist') }
  getRelationships() { return this.relationships }
  setRelationships(relationships) { this.relationships = relationships; this.scheduleFlush('relationships') }
  pushGroupWindow(groupId, entry) {
    const key = String(groupId)
    const list = this.groupWindows.get(key) || []
    list.push(String(entry).slice(0, LIMITS.maxMessageChars + 100))
    clampArray(list, LIMITS.recentGroupWindow)
    this.groupWindows.set(key, list)
    return list
  }
  getGroupWindow(groupId) { return this.groupWindows.get(String(groupId)) || [] }
  async exportText(filename, content) {
    if (path.basename(filename) !== filename) throw new Error('无效导出文件名')
    const filePath = path.join(this.exportDir, filename)
    await fs.promises.writeFile(filePath, content, 'utf8')
    return filePath
  }
  async maybeBackup() {
    const dateLabel = budgetDay(Date.now())
    if (this.meta.lastBackupDate === dateLabel) return false
    await this.flushAll()
    await Promise.all(Object.values(this.filePaths).map(async src => {
      if (fs.existsSync(src)) await fs.promises.copyFile(src, path.join(this.backupDir, `${dateLabel}_${path.basename(src)}`))
    }))
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const file of await fs.promises.readdir(this.backupDir)) {
      const fullPath = path.join(this.backupDir, file)
      if ((await fs.promises.stat(fullPath)).mtimeMs < sevenDaysAgo) await fs.promises.unlink(fullPath)
    }
    this.meta.lastBackupDate = dateLabel
    this.scheduleFlush('meta')
    return true
  }
}

export const storageService = new StorageService()
