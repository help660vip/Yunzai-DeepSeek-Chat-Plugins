import fs from 'fs'
import path from 'path'
import { BACKUP_DIR, DATA_DIR, EXPORT_DIR, FILE_PATHS, LIMITS } from '../config/config.js'
import { clampArray } from '../utils/tools.js'

// 文件锁管理器，防止并发写入冲突
class FileLockManager {
  constructor() {
    this.locks = new Map()
  }

  async acquire(filePath) {
    while (this.locks.get(filePath)) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    this.locks.set(filePath, true)
  }

  release(filePath) {
    this.locks.delete(filePath)
  }
}

const fileLockManager = new FileLockManager()

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const content = fs.readFileSync(filePath, 'utf-8')
    if (!content.trim()) return fallback
    return JSON.parse(content)
  } catch (error) {
    logger?.warn?.(`[存储] 读取 ${filePath} 失败，使用默认值：${error.message}`)
    return fallback
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export class StorageService {
  constructor() {
    ensureDir(DATA_DIR)
    ensureDir(BACKUP_DIR)
    ensureDir(EXPORT_DIR)

    this.contextMap = new Map(Object.entries(readJson(FILE_PATHS.context, {})))
    this.archives = new Map(Object.entries(readJson(FILE_PATHS.archive, {})))
    this.importantInfo = new Map(Object.entries(readJson(FILE_PATHS.important, {})))
    this.stats = readJson(FILE_PATHS.stats, {
      totalCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      lastReset: Date.now()
    })
    this.blacklist = readJson(FILE_PATHS.blacklist, { groups: [], users: [] })
    this.relationships = readJson(FILE_PATHS.relationships, {})
    this.meta = readJson(FILE_PATHS.meta, { lastBackupDate: null })

    // 异步写入队列和防抖控制
    this.writeQueue = []
    this.isWriting = false
    this.writeDebounceTimers = new Map()
    
    this.groupWindows = new Map()
    this.rateLimitCounter = new Map()

    this.rateLimitResetTimer = setInterval(() => {
      this.rateLimitCounter.clear()
    }, 60 * 1000)

    // 备份检查改为每小时一次
    this.backupTimer = setInterval(() => {
      this.maybeBackup().catch(error => logger?.error?.(`[存储] 备份失败：${error.message}`))
    }, 60 * 60 * 1000)

    // 启动异步写入处理器
    this.startWriteProcessor()
  }

  // 启动后台写入处理器，按顺序处理写入请求
  startWriteProcessor() {
    const processQueue = async () => {
      if (this.isWriting || this.writeQueue.length === 0) return
      
      this.isWriting = true
      const task = this.writeQueue.shift()
      
      try {
        await this.atomicWrite(task.filePath, task.data)
        task.resolve()
      } catch (error) {
        logger?.error?.(`[存储] 原子写入失败：${error.message}`)
        task.reject(error)
      } finally {
        this.isWriting = false
        setImmediate(processQueue)
      }
    }

    // 简单轮询处理队列
    setInterval(() => {
      if (this.writeQueue.length > 0 && !this.isWriting) {
        processQueue()
      }
    }, 100)
  }

  // 原子写入：先写临时文件，再重命名，确保断电不丢数据
  async atomicWrite(filePath, data) {
    await fileLockManager.acquire(filePath)
    
    try {
      const tempPath = `${filePath}.tmp.${Date.now()}`
      const serialized = JSON.stringify(data, null, 2)
      
      // 写入临时文件
      await fs.promises.writeFile(tempPath, serialized, 'utf-8')
      const fd = await fs.promises.open(tempPath, 'r+')
      await fd.sync()
      await fd.close()
      
      // 原子重命名
      await fs.promises.rename(tempPath, filePath)
      
      logger?.debug?.(`[存储] 原子写入成功：${filePath}`)
    } catch (error) {
      // 清理可能残留的临时文件
      const dir = path.dirname(filePath)
      const baseName = path.basename(filePath)
      if (fs.existsSync(dir)) {
        const files = await fs.promises.readdir(dir)
        for (const file of files) {
          if (file.startsWith(baseName + '.tmp.')) {
            await fs.promises.unlink(path.join(dir, file)).catch(() => {})
          }
        }
      }
      throw error
    } finally {
      fileLockManager.release(filePath)
    }
  }

  // 带防抖的调度写入，避免频繁写盘
  scheduleFlush(key) {
    if (this.writeDebounceTimers.has(key)) {
      clearTimeout(this.writeDebounceTimers.get(key))
    }
    
    const timer = setTimeout(() => {
      this.enqueueWrite(key)
      this.writeDebounceTimers.delete(key)
    }, 1000)
    
    this.writeDebounceTimers.set(key, timer)
  }

  // 将写入任务加入队列
  enqueueWrite(key) {
    const mapping = {
      context: () => ({ data: Object.fromEntries(this.contextMap), filePath: FILE_PATHS.context }),
      archive: () => ({ data: Object.fromEntries(this.archives), filePath: FILE_PATHS.archive }),
      important: () => ({ data: Object.fromEntries(this.importantInfo), filePath: FILE_PATHS.important }),
      stats: () => ({ data: this.stats, filePath: FILE_PATHS.stats }),
      blacklist: () => ({ data: this.blacklist, filePath: FILE_PATHS.blacklist }),
      relationships: () => ({ data: this.relationships, filePath: FILE_PATHS.relationships }),
      meta: () => ({ data: this.meta, filePath: FILE_PATHS.meta })
    }

    const getter = mapping[key]
    if (!getter) return Promise.resolve()
    
    const { data, filePath } = getter()
    
    return new Promise((resolve, reject) => {
      this.writeQueue.push({ filePath, data, resolve, reject })
    })
  }

  // 强制立即刷新所有待写入数据
  async flushAll() {
    const pending = [...this.writeDebounceTimers.keys()]
    for (const key of pending) {
      clearTimeout(this.writeDebounceTimers.get(key))
      this.writeDebounceTimers.delete(key)
      await this.enqueueWrite(key)
    }
    
    while (this.writeQueue.length > 0 || this.isWriting) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  getContextMap() {
    return this.contextMap
  }

  getContext(contextId) {
    if (!this.contextMap.has(contextId)) this.contextMap.set(contextId, [])
    return this.contextMap.get(contextId)
  }

  appendContext(contextId, message) {
    const context = this.getContext(contextId)
    context.push(message)
    clampArray(context, LIMITS.maxContext)
    this.scheduleFlush('context')
    return context
  }

  replaceContext(contextId, nextContext) {
    this.contextMap.set(contextId, nextContext)
    this.scheduleFlush('context')
  }

  deleteContext(contextId) {
    this.contextMap.delete(contextId)
    this.scheduleFlush('context')
  }

  clearConversationData(contextId, userId) {
    const deletedContext = this.contextMap.delete(contextId)
    const deletedArchive = this.archives.delete(contextId)
    const deletedImportant = this.importantInfo.delete(`user_${userId}_info`)

    if (deletedContext) this.scheduleFlush('context')
    if (deletedArchive) this.scheduleFlush('archive')
    if (deletedImportant) this.scheduleFlush('important')

    return deletedContext || deletedArchive || deletedImportant
  }

  clearAllContexts() {
    this.contextMap.clear()
    this.archives.clear()
    this.importantInfo.clear()
    this.scheduleFlush('context')
    this.scheduleFlush('archive')
    this.scheduleFlush('important')
  }

  getArchives() {
    return this.archives
  }

  appendArchive(contextId, archive) {
    if (!this.archives.has(contextId)) this.archives.set(contextId, [])
    const list = this.archives.get(contextId)
    list.push(archive)
    clampArray(list, LIMITS.archiveKeepCount)
    this.scheduleFlush('archive')
  }

  getImportantInfo() {
    return this.importantInfo
  }

  mergeImportantFacts(userId, payload) {
    const key = `user_${userId}_info`
    const current = this.importantInfo.get(key) || {
      userId: String(userId),
      profile: {},
      facts: [],
      updatedAt: 0
    }

    if (payload?.profile && typeof payload.profile === 'object') {
      current.profile = { ...current.profile, ...payload.profile }
    }

    if (Array.isArray(payload?.facts)) {
      current.facts.push(...payload.facts.filter(Boolean).map(item => ({ content: String(item), time: Date.now() })))
      clampArray(current.facts, LIMITS.summaryFactsKeep)
    }

    current.updatedAt = Date.now()
    this.importantInfo.set(key, current)
    this.scheduleFlush('important')
  }

  getStats() {
    return this.stats
  }

  recordUsage(usage = {}) {
    this.stats.totalCalls++
    this.stats.totalTokens += usage.total_tokens || 0
    this.stats.promptTokens += usage.prompt_tokens || 0
    this.stats.completionTokens += usage.completion_tokens || 0
    this.scheduleFlush('stats')
  }

  getBlacklist() {
    return this.blacklist
  }

  setBlacklist(blacklist) {
    this.blacklist = blacklist
    this.scheduleFlush('blacklist')
  }

  getRelationships() {
    return this.relationships
  }

  setRelationships(relationships) {
    this.relationships = relationships
    this.scheduleFlush('relationships')
  }

  pushGroupWindow(groupId, entry) {
    const key = String(groupId)
    if (!this.groupWindows.has(key)) this.groupWindows.set(key, [])
    const list = this.groupWindows.get(key)
    list.push(entry)
    clampArray(list, LIMITS.recentGroupWindow)
    return list
  }

  getGroupWindow(groupId) {
    return this.groupWindows.get(String(groupId)) || []
  }

  canPassRateLimit(userId) {
    const key = String(userId)
    const count = this.rateLimitCounter.get(key) || 0
    if (count >= LIMITS.rateLimitPerMinute) return false
    this.rateLimitCounter.set(key, count + 1)
    return true
  }

  async exportText(filename, content) {
    const filePath = path.join(EXPORT_DIR, filename)
    await fs.promises.writeFile(filePath, content, 'utf-8')
    return filePath
  }

  async maybeBackup() {
    const dateLabel = new Date().toISOString().slice(0, 10)
    if (this.meta.lastBackupDate === dateLabel) return false

    const files = [
      ['context', 'context.json'],
      ['important', 'important.json'],
      ['stats', 'stats.json'],
      ['archive', 'archive.json'],
      ['blacklist', 'blacklist.json'],
      ['relationships', 'relationships.json'],
      ['meta', 'meta.json']
    ]

    await this.flushAll()

    await Promise.all(files.map(async ([, name]) => {
      const src = path.join(DATA_DIR, name)
      const dest = path.join(BACKUP_DIR, `${dateLabel}_${name}`)
      if (fs.existsSync(src)) {
        await fs.promises.copyFile(src, dest)
      }
    }))

    const entries = await fs.promises.readdir(BACKUP_DIR)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    await Promise.all(entries.map(async file => {
      const fullPath = path.join(BACKUP_DIR, file)
      const stat = await fs.promises.stat(fullPath)
      if (stat.mtimeMs < sevenDaysAgo) await fs.promises.unlink(fullPath)
    }))

    this.meta.lastBackupDate = dateLabel
    this.scheduleFlush('meta')
    return true
  }
}

export const storageService = new StorageService()
