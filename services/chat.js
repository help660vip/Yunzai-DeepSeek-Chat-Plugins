import { CHAT_REMINDER, LIMITS, RELATIONSHIP_SYSTEM_PROMPT, RULES, SUMMARY_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../config/config.js'
import { deepSeekApi } from './api.js'
import { storageService } from './storage.js'
import { SocialService } from './social.js'
import { RequestGuard, RequestLimitError } from './request-guard.js'
import { buildChatMessages, estimateMessageTokens, estimateTokens, truncateTokenText } from '../utils/context.js'
import {
  buildContextId, buildEmotionHint, buildPublicMemoryId, cleanCQCodes, contextBelongsToUser,
  detectEmotion, detectLanguage, extractJson, formatChatReply, formatSpeakerLine,
  isGroupMessage, isMeaningless, messageText, mentionedUserIds, nowLabel, shouldTriggerMessageReply,
  inspectSpecialMessage, uniqueExportName
} from '../utils/tools.js'

const isLimitError = error => ['BUSY', 'COOLDOWN', 'RATE_LIMIT', 'DAILY_BUDGET', 'INPUT_TOO_LONG', 'INVALID_USER'].includes(error.code)

export class ChatService {
  constructor(options = {}) {
    this.storage = options.storage || storageService
    this.api = options.api || deepSeekApi
    this.limits = { ...LIMITS, ...options.limits }
    this.social = new SocialService(this.storage)
    this.guard = options.guard || new RequestGuard(this.limits)
    this.processingQueue = new Set()
    this.debugMode = false
    this.archiving = false
    this.interjections = {
      emotion: ['草', '卧槽', '我草', '艹', '绷', '绷不住了', '崩', '笑死', '笑死我了', 'xswl', '牛', '牛逼', '牛批', 'nb', 'NB', '6', '666', '6666', '哈哈', '哈哈哈', 'hhhh', 'hhh', '好家伙', '好耶', 'woc', 'wtf', 'WTF'],
      pureIgnore: ['嗯', '哦', '啊', '呃', '额', '。', '.']
    }
    if (options.startTimers !== false) this.startScheduledTasks()
  }

  getRules() { return RULES }
  startScheduledTasks() {
    this.archiveTimer = setInterval(() => {
      this.autoArchiveContexts().catch(error => globalThis.logger?.error?.(`[智能对话] 自动归档失败 ${error.message}`))
    }, 60 * 60 * 1000)
    this.archiveTimer.unref?.()
  }
  close() { clearInterval(this.archiveTimer) }

  async dispatch(fnc, e) {
    const rule = RULES.find(item => item.fnc === fnc)
    if (!rule || typeof this[fnc] !== 'function') return false
    if (rule.permission === 'master' && e.isMaster !== true) {
      await e.reply('这个要主人来操作', true)
      return true
    }
    if (e.isMaster !== true && this.isBlacklisted(e)) return false
    try {
      return await this[fnc](e)
    } catch (error) {
      await this.handleError(e, error)
      return true
    }
  }

  isBlacklisted(e) {
    const blacklist = this.storage.getBlacklist()
    return blacklist.groups?.includes(String(e.group_id)) || blacklist.users?.includes(String(e.user_id))
  }
  subject(e) {
    return { userId: e.user_id, isMaster: e.isMaster === true, ...(isGroupMessage(e) ? { groupId: String(e.group_id) } : {}) }
  }
  queueKey(e) { if (e.isMaster === true) return buildContextId(e); return isGroupMessage(e) ? `group_${e.group_id}` : `user_${e.user_id}` }
  shouldTriggerReply(e) {
    return shouldTriggerMessageReply(e, e.self_id || e.bot?.uin || globalThis.Bot?.uin, this.limits.randomBubbleChance)
  }
  async handleError(e, error) {
    if (!isLimitError(error)) globalThis.logger?.error?.(`[智能对话] 请求失败 ${error.message}`)
    if (this.guard.shouldNotify(e.user_id)) await e.reply(isLimitError(error) ? error.message : '出了点问题 等会吧', true)
  }
  buildBaseSystemPrompt(e, userMsg) {
    const emotionHint = buildEmotionHint(detectEmotion(userMsg), detectLanguage(userMsg))
    // 昵称和群名不能进入 system，避免昵称中的文本被当作规则
    return `${SYSTEM_PROMPT}\n当前时间 ${nowLabel()}\n当前环境 ${isGroupMessage(e) ? '群聊' : '私聊'}\n${emotionHint}`
  }
  async randomDelay() {
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000))
  }

  async callModel(messages, options = {}) {
    const isMaster = options.subject?.isMaster === true
    if (!isMaster && estimateMessageTokens(messages) > this.limits.maxPromptTokens) {
      throw new RequestLimitError('INPUT_TOO_LONG', '这条太长了 分几条发吧')
    }
    this.api.ensureConfigured()
    const release = this.guard.acquire(options.subject)
    const maxTokens = isMaster
      ? (options.maxTokens ?? this.api.config.masterMaxTokens ?? null)
      : Math.min(options.maxTokens ?? this.api.config.maxTokens, this.api.config.maxTokens)
    const estimate = estimateMessageTokens(messages) + (maxTokens || 0)
    let reservation
    try {
      const result = await this.api.request(messages, {
        ...options, maxTokens, isMaster,
        beforeAttempt: async () => {
          if (!isMaster) reservation = await this.storage.reserveTokenBudget(options.subject, estimate, this.limits)
        },
        onUsage: async (usage, content) => {
          this.storage.recordUsage(usage || {
            prompt_tokens: estimateMessageTokens(messages),
            completion_tokens: typeof content === 'string' ? estimateTokens(content) : 0
          })
          if (reservation && usage) await this.storage.settleTokenBudget(reservation, usage)
        }
      })
      return result.content
    } finally {
      release()
    }
  }

  async runArchiveBatch(threshold, actor) {
    if (this.archiving) return 0
    this.archiving = true
    let archived = 0
    let attempted = 0
    try {
      for (const [key, value] of [...this.storage.getContextMap().entries()]) {
        if (key.endsWith('_public') || !Array.isArray(value) || value.length < threshold) continue
        if (actor?.isMaster !== true && attempted >= this.limits.maxArchivesPerRun) break
        attempted++
        try {
          if (await this.archiveContext(key, value, actor)) archived++
        } catch (error) {
          if (isLimitError(error)) break
          globalThis.logger?.error?.(`[智能对话] 归档失败 ${error.message}`)
        }
      }
      return archived
    } finally { this.archiving = false }
  }
  async autoArchiveContexts() { return this.runArchiveBatch(this.limits.archiveThreshold) }

  async archiveContext(contextId, context, actor) {
    const match = contextId.match(/^(?:group_(\d+)_)?user_(\d+)$/)
    if (!match) return false
    const subject = actor?.isMaster === true ? actor : { userId: match[2], ...(match[1] ? { groupId: match[1] } : {}) }
    const queueKey = match[1] ? `group_${match[1]}` : `user_${match[2]}`
    const userKey = `user_${match[2]}`
    if (this.processingQueue.has(queueKey) || this.processingQueue.has(userKey)) return false
    this.processingQueue.add(queueKey)
    this.processingQueue.add(userKey)
    try {
      const previous = this.storage.getArchives().get(contextId)?.at(-1)?.summary || ''
      const rows = []
      const system = { role: 'system', content: `${SUMMARY_SYSTEM_PROMPT}\n当前用户QQ ${match[2]}` }
      const makeMessages = () => [system, { role: 'user', content: JSON.stringify({
        previousSummary: truncateTokenText(previous, 2000), messages: rows
      }) }]
      // 总结最早的消息，只移除确实送入摘要的部分，不能总结最近100条却删除前350条
      const count = Math.min(this.limits.archiveSummarizeRecent, context.length - this.limits.archiveKeepRecent)
      for (const msg of context.slice(0, Math.max(0, count))) {
        rows.push({ role: msg.role, content: msg.content })
        if (subject.isMaster !== true && estimateMessageTokens(makeMessages()) > this.limits.maxPromptTokens) { rows.pop(); break }
      }
      if (!rows.length) return false
      const raw = await this.callModel(makeMessages(), { subject, temperature: 0.2, maxTokens: 500 })
      const parsed = extractJson(raw)
      if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) throw new Error('摘要格式无效 原记录已保留')
      // 清空指令或其他操作改变了上下文时，丢弃旧请求的归档结果
      if (this.storage.getContextMap().get(contextId) !== context) return false
      this.storage.appendArchive(contextId, { summary: parsed.summary.trim(), timestamp: Date.now(), messageCount: rows.length })
      this.storage.mergeImportantFacts(contextId, { profile: parsed.profile, facts: parsed.facts })
      this.storage.replaceContext(contextId, context.slice(rows.length))
      return true
    } finally {
      this.processingQueue.delete(queueKey)
      this.processingQueue.delete(userKey)
    }
  }
  async archiveContexts(e) {
    const archived = await this.runArchiveBatch(101, this.subject(e))
    await e.reply(`这次归档了${archived}个上下文${e.isMaster === true ? '' : ` 每次最多处理${this.limits.maxArchivesPerRun}个`}`, true)
    return true
  }
  async showTokenStats(e) {
    if (isGroupMessage(e)) {
      await e.reply('请私聊查看 Token 统计', true)
      return true
    }
    const stats = this.storage.getStats()
    const daily = this.storage.getDailyBudget()
    await e.reply(`Token使用统计：\n总调用次数: ${stats.totalCalls}\n总Token消耗: ${stats.totalTokens}\n输入Token: ${stats.promptTokens}\n输出Token: ${stats.completionTokens}\n今日预算占用: ${daily.used.global || 0}/${this.limits.dailyGlobalTokens} (${daily.day})\n统计开始时间: ${new Date(stats.lastReset).toLocaleString('zh-CN')}`, true)
    return true
  }

  async showContextStats(e) {
    let userContexts = 0
    let publicMemories = 0
    let totalMessages = 0
    for (const [key, value] of this.storage.getContextMap().entries()) {
      if (key.includes('_public')) publicMemories++
      else userContexts++
      totalMessages += value.length
    }
    await e.reply(`上下文统计：\n用户对话数: ${userContexts}\n群公共记忆数: ${publicMemories}\n总消息条数: ${totalMessages}\n重要信息条数: ${this.storage.getImportantInfo().size}\n归档数量: ${this.storage.getArchives().size}`, true)
    return true
  }

  async clearMyContext(e) {
    const contextId = buildContextId(e)
    if (this.storage.clearConversationData(contextId)) {
      await e.reply('好 你的记录清掉了', true)
    } else {
      await e.reply('本来就没什么记录', true)
    }
    return true
  }

  async clearAllContext(e) {
    this.storage.clearAllContexts()
    await e.reply('好 删了', true)
    return true
  }

  async blacklistGroup(e) {
    const match = e.msg.match(/^#对话拉黑群\s*(\d+)$/)
    if (!match) return false
    const groupId = match[1]
    const blacklist = this.storage.getBlacklist()
    blacklist.groups ||= []
    if (blacklist.groups.includes(groupId)) await e.reply('该群已在黑名单中', true)
    else {
      blacklist.groups.push(groupId)
      this.storage.setBlacklist(blacklist)
      await e.reply(`已拉黑群 ${groupId}`, true)
    }
    return true
  }

  async blacklistUser(e) {
    const match = e.msg.match(/^#对话拉黑人\s*(\d+)$/)
    if (!match) return false
    const userId = match[1]
    const blacklist = this.storage.getBlacklist()
    blacklist.users ||= []
    if (blacklist.users.includes(userId)) await e.reply('该用户已在黑名单中', true)
    else {
      blacklist.users.push(userId)
      this.storage.setBlacklist(blacklist)
      await e.reply(`已拉黑用户 ${userId}`, true)
    }
    return true
  }

  async unblacklistGroup(e) {
    const match = e.msg.match(/^#对话解除拉黑群\s*(\d+)$/)
    if (!match) return false
    const groupId = match[1]
    const blacklist = this.storage.getBlacklist()
    blacklist.groups ||= []
    const index = blacklist.groups.indexOf(groupId)
    if (index === -1) await e.reply('该群不在黑名单中', true)
    else {
      blacklist.groups.splice(index, 1)
      this.storage.setBlacklist(blacklist)
      await e.reply(`已解除拉黑群 ${groupId}`, true)
    }
    return true
  }

  async unblacklistUser(e) {
    const match = e.msg.match(/^#对话解除拉黑人\s*(\d+)$/)
    if (!match) return false
    const userId = match[1]
    const blacklist = this.storage.getBlacklist()
    blacklist.users ||= []
    const index = blacklist.users.indexOf(userId)
    if (index === -1) await e.reply('该用户不在黑名单中', true)
    else {
      blacklist.users.splice(index, 1)
      this.storage.setBlacklist(blacklist)
      await e.reply(`已解除拉黑用户 ${userId}`, true)
    }
    return true
  }

  async showBlacklist(e) {
    const groups = this.storage.getBlacklist().groups || []
    const users = this.storage.getBlacklist().users || []
    if (groups.length === 0 && users.length === 0) {
      await e.reply('黑名单为空', true)
      return true
    }
    let msg = '当前黑名单：\n'
    if (groups.length > 0) msg += `拉黑群(${groups.length}个)：\n${groups.join(', ')}\n`
    if (users.length > 0) msg += `拉黑用户(${users.length}个)：\n${users.join(', ')}`
    await e.reply(msg, true)
    return true
  }

  async analyzeRelationship(e) {
    if (!isGroupMessage(e)) {
      await e.reply('这个功能只能在群里使用', true)
      return true
    }
    const botId = e.self_id || e.bot?.uin || globalThis.Bot?.uin
    const atList = mentionedUserIds(e).filter(id => id !== String(botId))
    if (atList.length !== 2) {
      await e.reply('请@两个人来查询关系 例如：#查询关系 @A @B', true)
      return true
    }

    const relationships = this.storage.getRelationships()
    const groupId = String(e.group_id)
    const [user1, user2] = atList
    const key = [user1, user2].sort().join('_')
    const rel = relationships[groupId]?.relationships?.[key]
    if (!rel) {
      await e.reply('这两个人在群里还没什么互动记录', true)
      return true
    }

    const name1 = relationships[groupId].userNames[user1] || user1
    const name2 = relationships[groupId].userNames[user2] || user2
    const total = Object.values(rel.emotionStats).reduce((sum, value) => sum + value, 0)
    const topTopics = Object.entries(rel.topics).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([word, count]) => `${word}(${count}次)`).join('、') || '无明显话题'
    const recentMsg = rel.recentMessages.at(-1)?.snippet || '无'
    const analysis = await this.callModel([
      { role: 'system', content: RELATIONSHIP_SYSTEM_PROMPT },
      { role: 'user', content: `根据以下数据分析两人关系 用1到2句话概括：\n${name1}(${user1})和${name2}(${user2})\n总互动${rel.interactionCount}次 @${rel.atCount}次 回复${rel.replyCount}次\n情绪统计:${JSON.stringify(rel.emotionStats)} 总计:${total}\n常聊话题:${topTopics}\n最近对话:${recentMsg}` }
    ], { temperature: 0.4, maxTokens: 120, subject: this.subject(e) })
    await e.reply(`${name1} 和 ${name2} 的关系：\n${formatChatReply(analysis)}`, true)
    return true
  }

  async showGroupRelationships(e) {
    if (!isGroupMessage(e)) {
      await e.reply('这个功能只能在群里使用', true)
      return true
    }
    const summary = this.social.buildGroupSummary(e.group_id)
    if (!summary) {
      await e.reply('本群还没有足够的互动数据', true)
      return true
    }
    let msg = '本群社交网络：\n\n互动最多的组合：\n'
    summary.relList.forEach((rel, index) => {
      msg += `${index + 1}. ${rel.name1} ↔ ${rel.name2} (${rel.count}次)\n`
    })
    msg += `\n社交中心：\n${summary.socialCenter.join('、')}`
    await e.reply(msg, true)
    return true
  }

  async showMySocialStats(e) {
    if (!isGroupMessage(e)) {
      await e.reply('这个功能只能在群里使用', true)
      return true
    }
    const group = this.storage.getRelationships()[String(e.group_id)]
    if (!group) {
      await e.reply('本群还没有互动数据', true)
      return true
    }
    const userId = String(e.user_id)
    const myRelations = []
    for (const [key, data] of Object.entries(group.relationships)) {
      const [u1, u2] = key.split('_')
      if (u1 === userId || u2 === userId) {
        const other = u1 === userId ? u2 : u1
        myRelations.push({
          name: group.userNames[other] || other,
          count: data.interactionCount,
          atCount: data.atCount,
          replyCount: data.replyCount
        })
      }
    }
    if (myRelations.length === 0) {
      await e.reply('你在本群还没有互动记录', true)
      return true
    }
    myRelations.sort((a, b) => b.count - a.count)
    const top3 = myRelations.slice(0, 3)
    let msg = '你的社交统计：\n\n最常互动的3个人：\n'
    top3.forEach((rel, index) => {
      msg += `${index + 1}. ${rel.name} (${rel.count}次)\n`
    })
    msg += `\n总计@次数: ${myRelations.reduce((sum, item) => sum + item.atCount, 0)}\n总计回复次数: ${myRelations.reduce((sum, item) => sum + item.replyCount, 0)}`
    await e.reply(msg, true)
    return true
  }

  async generateChatReport(e) {
    const atMatch = e.msg.match(/\[CQ:at,qq=(\d+)\]/)
    let targetUserId = e.user_id
    if (atMatch) {
      if (e.isMaster !== true) {
        await e.reply('只有主人可以查看别人的对话统计', true)
        return true
      }
      targetUserId = atMatch[1]
    }

    const userContexts = []
    for (const [key, value] of this.storage.getContextMap().entries()) {
      if (contextBelongsToUser(key, targetUserId)) userContexts.push(...value)
    }
    if (userContexts.length === 0) {
      await e.reply('暂无对话记录', true)
      return true
    }

    const userMessages = userContexts.filter(item => item.role === 'user')
    const totalMessages = userMessages.length || 1
    const avgLength = Math.round(userMessages.reduce((sum, item) => sum + cleanCQCodes(item.content).length, 0) / totalMessages)
    const wordCount = {}
    for (const msg of userMessages) {
      const words = cleanCQCodes(msg.content).replace(/[^一-龥a-zA-Z]/g, ' ').split(/\s+/).filter(word => word.length >= 2)
      for (const word of words) wordCount[word] = (wordCount[word] || 0) + 1
    }
    const topWords = Object.entries(wordCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word, count]) => `${word}(${count}次)`).join('、')
    const hourCount = Array(24).fill(0)
    for (const msg of userMessages.filter(item => item.timestamp)) hourCount[new Date(item.timestamp).getHours()]++
    const emotionCount = { happy: 0, sad: 0, angry: 0, excited: 0, neutral: 0 }
    for (const msg of userMessages) emotionCount[detectEmotion(msg.content)]++
    const langCount = { zh: 0, en: 0, ja: 0, ko: 0 }
    for (const msg of userMessages) langCount[detectLanguage(msg.content)]++
    const mainLang = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0][0]
    const report = `对话分析报告\n\n用户QQ: ${targetUserId}\n总对话条数: ${userMessages.length}\n平均消息长度: ${avgLength}字\n\n常用词Top10:\n${topWords}\n\n活跃时段: ${hourCount.indexOf(Math.max(...hourCount))}:00-${hourCount.indexOf(Math.max(...hourCount)) + 1}:00\n\n情绪分布: ${Object.entries(emotionCount).map(([k, v]) => `${k}:${Math.round(v / totalMessages * 100)}%`).join(' ')}\n\n主要语言: ${mainLang}\n\n最近对话: ${userContexts.at(-1)?.timestamp ? new Date(userContexts.at(-1).timestamp).toLocaleString('zh-CN') : '未知'}`
    await e.reply(report, true)
    return true
  }

  async toggleDebugMode(e) {
    const match = e.msg.match(/^#对话调试模式\s*(开启|关闭)$/)
    if (!match) return false
    this.debugMode = match[1] === '开启'
    await e.reply(`调试模式已${match[1]}`, true)
    return true
  }

  async exportChatHistory(e) {
    const atMatch = e.msg.match(/\[CQ:at,qq=(\d+)\]/)
    if (!atMatch) {
      await e.reply('请@要导出记录的用户', true)
      return true
    }
    const targetUserId = atMatch[1]
    const userContexts = []
    for (const [key, value] of this.storage.getContextMap().entries()) {
      if (contextBelongsToUser(key, targetUserId)) userContexts.push(...value)
    }
    if (userContexts.length === 0) {
      await e.reply('该用户暂无对话记录', true)
      return true
    }
    let content = `========== 对话记录导出 ==========\n用户QQ: ${targetUserId}\n导出时间: ${new Date().toLocaleString('zh-CN')}\n总消息数: ${userContexts.length}\n=====================================\n\n`
    for (const msg of userContexts) {
      content += `[${msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '未知'}] ${msg.role === 'user' ? '用户' : '机器人'}: ${cleanCQCodes(msg.content)}\n\n`
    }
    const filePath = await this.storage.exportText(uniqueExportName('temp', targetUserId), content)
    await e.reply(`对话记录已导出 文件路径：${filePath}`, true)
    return true
  }

  async exportGroupHistory(e) {
    if (!isGroupMessage(e)) {
      await e.reply('这个功能只能在群里使用', true)
      return true
    }
    const publicMemoryId = buildPublicMemoryId(e.group_id)
    const publicMemory = this.storage.getContextMap().get(publicMemoryId)
    if (!publicMemory?.length) {
      await e.reply('本群暂无公共记忆', true)
      return true
    }
    let content = `========== 群聊天记录导出 ==========\n群号: ${e.group_id}\n群名: ${e.group_name || '未知'}\n导出时间: ${new Date().toLocaleString('zh-CN')}\n总消息数: ${publicMemory.length}\n======================================\n\n`
    for (const msg of publicMemory) {
      content += `[${msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '未知'}] ${cleanCQCodes(msg.content)}\n\n`
    }
    const filePath = await this.storage.exportText(uniqueExportName('temp_group', e.group_id), content)
    await e.reply(`群聊天记录已导出 文件路径：${filePath}`, true)
    return true
  }

  async getQuotedMessage(e) {
    try {
      let reply
      if (typeof e.getReply === 'function') reply = await e.getReply()
      let text = reply?.message || reply?.raw_message || e.source?.message || e.source?.raw_message
      if (!text && (e.source?.seq || e.source?.message_id) && isGroupMessage(e)) {
        const group = (e.bot || globalThis.Bot)?.pickGroup?.(e.group_id)
        const history = await group?.getChatHistory?.(e.source.seq || e.source.message_id, 1)
        text = history?.[0]?.message || history?.[0]?.raw_message
      }
      const cleaned = cleanCQCodes(messageText(text), true)
      return (e.isMaster === true ? cleaned : cleaned.slice(0, this.limits.maxQuotedChars)) || null
    } catch (error) {
      globalThis.logger?.error?.(`[智能对话] 获取引用失败 ${error.message}`)
      return null
    }
  }

  async sendReply(e, reply) { await e.reply(String(reply).trim(), true) }

  async chat(e) {
    const selfId = e.self_id || e.bot?.uin || globalThis.Bot?.uin
    if (!e.user_id || (selfId != null && String(e.user_id) === String(selfId)) || this.isBlacklisted(e)) return false
    const rawMsg = String(e.msg || messageText(e.message))
    if (rawMsg.trimStart().startsWith('#')) return false
    const cleanedMsg = cleanCQCodes(rawMsg, true)
    if (!cleanedMsg) return false
    const triggered = this.shouldTriggerReply(e)
    if (e.isMaster !== true && cleanedMsg.length > this.limits.maxMessageChars) {
      if (triggered) await this.handleError(e, new RequestLimitError('INPUT_TOO_LONG', '这条太长了 分几条发吧'))
      return triggered
    }
    const userName = String(e.sender?.card || e.sender?.nickname || e.user_id).slice(0, 80)
    if (isGroupMessage(e)) this.storage.pushGroupWindow(e.group_id, formatSpeakerLine(userName, cleanedMsg))
    this.social.recordGroupMessage(e, selfId)
    if (!triggered) return false

    const queueKey = this.queueKey(e)
    const userKey = `user_${e.user_id}`
    if (this.processingQueue.has(queueKey) || this.processingQueue.has(userKey)) return true
    this.processingQueue.add(queueKey)
    this.processingQueue.add(userKey)
    const startedAt = Date.now()
    try {
      const special = inspectSpecialMessage(cleanedMsg, this.interjections)
      if (!special.useAPI) {
        if (special.shouldReply && this.guard.shouldNotify(e.user_id)) await e.reply(special.content, true)
        return special.shouldReply
      }
      // 用快照组装请求，失败或清空期间不把未完成消息写进记忆
      const contextId = buildContextId(e)
      const context = this.storage.getContext(contextId)
      const publicMemoryId = isGroupMessage(e) ? buildPublicMemoryId(e.group_id) : null
      const window = isGroupMessage(e) ? this.storage.getGroupWindow(e.group_id).slice(0, -1) : []
      const groupRecords = window.length ? window : (this.storage.getContextMap().get(publicMemoryId) || []).map(msg => msg.content)
      const quoted = e.source ? await this.getQuotedMessage(e) : null
      const archive = this.storage.getArchives().get(contextId)?.at(-1)
      const info = this.storage.getImportantInfo().get(`${contextId}_info`)
      const background = [
        { kind: '当前对话者', text: JSON.stringify({ name: userName, userId: String(e.user_id), groupName: String(e.group_name || '').slice(0, 80) }) },
        ...(quoted ? [{ kind: '用户引用的消息', text: quoted }] : []),
        ...(info?.facts?.length ? [{ kind: '当前会话用户事实', text: info.facts.slice(-5).map(item => item.content).join('\n') }] : []),
        ...(archive?.summary ? [{ kind: '当前会话历史摘要', text: archive.summary }] : []),
        ...(isGroupMessage(e) ? groupRecords.slice(-this.limits.recentGroupWindow).reverse().map(text => ({ kind: '群聊发言', text })) : [])
      ]
      const messages = buildChatMessages({
        systemPrompt: this.buildBaseSystemPrompt(e, cleanedMsg), reminder: CHAT_REMINDER,
        history: context, current: cleanedMsg, background, isMaster: e.isMaster === true
      }, this.limits)
      const reply = await this.callModel(messages, { subject: this.subject(e) })
      const cleanReply = formatChatReply(reply, cleanedMsg)
      if (!cleanReply) throw new Error('API返回空回复')
      if (this.storage.getContextMap().get(contextId) !== context) return true
      await this.randomDelay()
      if (this.storage.getContextMap().get(contextId) !== context) return true
      const outgoing = this.debugMode ? `${cleanReply}\n[调试] 上下文:${context.length}条 Token:${this.storage.getStats().totalTokens} 耗时:${Date.now() - startedAt}ms` : cleanReply
      await this.sendReply(e, outgoing)
      if (this.storage.getContextMap().get(contextId) !== context) return true
      this.storage.appendContext(contextId, { role: 'user', content: cleanedMsg, timestamp: startedAt })
      this.storage.appendContext(contextId, { role: 'assistant', content: cleanReply, timestamp: Date.now() })
      if (publicMemoryId) {
        if (!isMeaningless(cleanedMsg)) this.storage.appendContext(publicMemoryId, { role: 'user', content: formatSpeakerLine(userName, cleanedMsg), timestamp: startedAt })
        if (!isMeaningless(cleanReply)) this.storage.appendContext(publicMemoryId, { role: 'assistant', content: formatSpeakerLine('机器人', cleanReply), timestamp: Date.now() })
      }
      this.social.recordInteraction(e, selfId == null ? null : String(selfId))
      return true
    } catch (error) {
      await this.handleError(e, error)
      return true
    } finally {
      this.processingQueue.delete(queueKey)
      this.processingQueue.delete(userKey)
    }
  }
}

export const chatService = new ChatService()
