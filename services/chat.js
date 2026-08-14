import { LIMITS, RELATIONSHIP_SYSTEM_PROMPT, RULES, SUMMARY_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../config/config.js'
import { deepSeekApi } from './api.js'
import { storageService } from './storage.js'
import { SocialService } from './social.js'
import {
  buildContextId,
  buildEmotionHint,
  buildPublicMemoryId,
  cleanCQCodes,
  detectEmotion,
  detectLanguage,
  extractJson,
  formatSpeakerLine,
  isMeaningless,
  normalizeWhitespace,
  nowLabel,
  shouldAllowLongAnswer,
  shouldTriggerMessageReply,
  inspectSpecialMessage,
  uniqueExportName
} from '../utils/tools.js'

class ChatService {
  constructor() {
    this.storage = storageService
    this.social = new SocialService(this.storage)
    this.lastReplyTime = new Map()
    this.processingQueue = new Map()
    this.debugMode = false
    this.interjections = {
      emotion: ['草', '卧槽', '我草', '艹', '绷', '绷不住了', '崩', '笑死', '笑死我了', 'xswl', '牛', '牛逼', '牛批', 'nb', 'NB', '6', '666', '6666', '哈哈', '哈哈哈', 'hhhh', 'hhh', '好家伙', '好耶', 'woc', 'wtf', 'WTF'],
      pureIgnore: ['嗯', '哦', '啊', '呃', '额', '。', '.']
    }
    this.sensitiveWords = {
      political: ['习近平', '习大大', 'xjp', '总书记', '毛泽东', '六四', '天安门事件', '法轮功', '台独', '藏独', '疆独', '港独'],
      nsfw: ['做爱', '性交', 'porn', 'sex', '黄片', 'av', '裸照', '色情', '约炮'],
      violence: ['杀人', '自杀', '爆炸', '炸弹', '恐怖袭击', '枪支', '刀人'],
      illegal: ['毒品', '海洛因', '冰毒', '走私', '诈骗', '洗钱', '赌博', '买枪'],
      discrimination: ['黑鬼', 'nigger', '支那', '小日本', '棒子', '穆畜'],
      other: ['器官买卖', '人体器官']
    }

    this.startScheduledTasks()
  }

  getRules() {
    return RULES
  }

  startScheduledTasks() {
    setInterval(() => {
      this.autoArchiveContexts().catch(error => logger?.error?.(`[智能对话] 自动归档失败: ${error.message}`))
    }, 60 * 60 * 1000)
  }

  async dispatch(fnc, e) {
    if (typeof this[fnc] !== 'function') return false
    return this[fnc](e)
  }

  containsSensitiveWord(text) {
    const normalized = normalizeWhitespace(text).replace(/\s+/g, '').toLowerCase()
    for (const category of Object.keys(this.sensitiveWords)) {
      for (const word of this.sensitiveWords[category]) {
        if (normalized.includes(String(word).toLowerCase())) return { matched: true, category, word }
      }
    }
    return { matched: false }
  }

  isBlacklisted(e) {
    const blacklist = this.storage.getBlacklist()
    return blacklist.groups?.includes(String(e.group_id)) || blacklist.users?.includes(String(e.user_id))
  }

  shouldTriggerReply(e) {
    const botQQ = e.self_id || e.bot?.uin || globalThis.Bot?.uin
    return shouldTriggerMessageReply(e, botQQ, LIMITS.randomBubbleChance)
  }

  checkCooldown(userId) {
    const now = Date.now()
    const last = this.lastReplyTime.get(String(userId)) || 0
    return now - last >= LIMITS.cooldownMs
  }

  setCooldown(userId) {
    this.lastReplyTime.set(String(userId), Date.now())
  }

  buildBaseSystemPrompt(e, userName, userMsg) {
    const lang = detectLanguage(userMsg)
    const emotion = detectEmotion(userMsg)
    const emotionHint = buildEmotionHint(emotion, lang)
    let prompt = `${SYSTEM_PROMPT}\n\n当前时间：${nowLabel()}`
    if (emotionHint) prompt += `\n${emotionHint}`
    if (e.isGroup) {
      prompt += `\n当前环境：群聊 ${e.group_name || e.group_id}`
      prompt += `\n当前对话者：${userName}`
      prompt += `\n你可以参考给定的最近群聊记录回答 但不要虚构未出现的内容`
    } else {
      prompt += `\n当前环境：与 ${userName} 私聊`
    }
    if (shouldAllowLongAnswer(userMsg)) {
      prompt += '\n这次用户明显需要详细回答 允许输出完整内容'
    }
    return prompt
  }

  async randomDelay() {
    const delay = 1000 + Math.random() * 2000
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  async callModel(messages, options = {}) {
    const result = await deepSeekApi.request(messages, options)
    if (!options.skipStats) this.storage.recordUsage(result.usage)
    return result.content
  }

  buildGroupWindowMessages(groupId) {
    return this.storage.getGroupWindow(groupId).map(item => ({ role: 'user', content: item }))
  }

  async autoArchiveContexts() {
    const contextMap = this.storage.getContextMap()
    let archived = 0
    for (const [key, value] of contextMap.entries()) {
      if (key.includes('_public')) continue
      if (Array.isArray(value) && value.length >= LIMITS.archiveThreshold) {
        await this.archiveContext(key, value)
        archived++
      }
    }
    if (archived > 0) logger?.info?.(`[智能对话] 自动归档了 ${archived} 个上下文`)
  }

  async archiveContext(contextId, context) {
    const recentContext = context.slice(-LIMITS.archiveSummarizeRecent)
    const prompt = `请总结以下对话 最近对话如下：\n\n${recentContext.map(msg => `${msg.role === 'user' ? '用户' : '助手'}: ${cleanCQCodes(msg.content)}`).join('\n')}\n\n请输出 JSON，格式如下：{"summary":"2到3句总结","profile":{},"facts":["..."]}`
    const messages = [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ]

    const raw = await this.callModel(messages, { skipStats: true, temperature: 0.2, maxTokens: 500 })
    const parsed = extractJson(raw) || { summary: cleanCQCodes(raw), profile: {}, facts: [] }
    this.storage.appendArchive(contextId, {
      summary: String(parsed.summary || cleanCQCodes(raw)).trim(),
      timestamp: Date.now(),
      messageCount: context.length
    })

    const userIdMatch = contextId.match(/user_(\d+)/)
    if (userIdMatch) {
      this.storage.mergeImportantFacts(userIdMatch[1], {
        profile: parsed.profile || {},
        facts: Array.isArray(parsed.facts) ? parsed.facts : []
      })
    }

    const nextContext = context.slice(-LIMITS.archiveKeepRecent)
    this.storage.replaceContext(contextId, nextContext)
  }

  async archiveContexts(e) {
    await e.reply('开始归档 请稍等', true)
    let archived = 0
    for (const [key, value] of this.storage.getContextMap().entries()) {
      if (key.includes('_public')) continue
      if (Array.isArray(value) && value.length > 100) {
        await this.archiveContext(key, value)
        archived++
      }
    }
    await e.reply(`归档完成 处理了${archived}个上下文`, true)
    return true
  }

  async showTokenStats(e) {
    if (e.isGroup) {
      await e.reply('请私聊查看 Token 统计', true)
      return true
    }
    const stats = this.storage.getStats()
    await e.reply(`Token使用统计：\n总调用次数: ${stats.totalCalls}\n总Token消耗: ${stats.totalTokens}\n输入Token: ${stats.promptTokens}\n输出Token: ${stats.completionTokens}\n统计开始时间: ${new Date(stats.lastReset).toLocaleString('zh-CN')}`, true)
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
    if (this.storage.getContextMap().has(contextId)) {
      this.storage.deleteContext(contextId)
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
    if (!e.isGroup) {
      await e.reply('这个功能只能在群里使用', true)
      return true
    }
    const atList = [...e.msg.matchAll(/\[CQ:at,qq=(\d+)\]/g)].map(match => match[1])
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
    ], { temperature: 0.4, maxTokens: 120 })
    await e.reply(`${name1} 和 ${name2} 的关系：\n${analysis}`, true)
    return true
  }

  async showGroupRelationships(e) {
    if (!e.isGroup) {
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
    if (!e.isGroup) {
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
      if (!e.isMaster) {
        await e.reply('只有主人可以查看别人的对话统计', true)
        return true
      }
      targetUserId = atMatch[1]
    }

    const userContexts = []
    for (const [key, value] of this.storage.getContextMap().entries()) {
      if (key.includes(`_user_${targetUserId}`) && !key.includes('_public')) userContexts.push(...value)
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
      if (key.includes(`_user_${targetUserId}`) && !key.includes('_public')) userContexts.push(...value)
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
    if (!e.isGroup) {
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

  async isReplyToBot(e) {
    try {
      const botQQ = e.self_id || Bot.uin || e.bot?.uin
      if (!botQQ || !e.source) return false
      const sourceUserId = String(e.source.user_id || e.source.sender?.user_id || '')
      return sourceUserId === String(botQQ)
    } catch {
      return false
    }
  }

  async getQuotedMessage(e) {
    try {
      if (typeof e.getReply === 'function') {
        const reply = await e.getReply()
        if (reply?.message) return cleanCQCodes(String(reply.message))
      }
      if (e.source?.message) return cleanCQCodes(String(e.source.message))
      if (e.source?.raw_message) return cleanCQCodes(String(e.source.raw_message))
      if ((e.source?.seq || e.source?.message_id) && e.isGroup && e.group_id) {
        const msgId = e.source.seq || e.source.message_id
        const group = Bot.pickGroup(e.group_id)
        if (group && typeof group.getChatHistory === 'function') {
          const history = await group.getChatHistory(msgId, 1)
          if (history?.[0]?.message) return cleanCQCodes(String(history[0].message))
        }
      }
    } catch (error) {
      logger?.error?.(`[智能对话] 获取引用消息失败: ${error.message}`)
    }
    return null
  }

  async sendReply(e, cleanReply) {
    const text = String(cleanReply).trim()
    // 直接发送，不再限制长度或转合并转发
    await e.reply(text, true)
  }

  async chat(e) {
    const selfId = e.self_id || Bot.uin || e.bot?.uin
    if (String(e.user_id) === String(selfId)) return false
    if (this.isBlacklisted(e)) return false

    const userName = e.sender?.card || e.sender?.nickname || String(e.user_id)
    const rawMsg = e.msg || ''
    const cleanedMsg = cleanCQCodes(rawMsg)
    if (!cleanedMsg) return false

    if (e.isGroup) {
      this.storage.pushGroupWindow(e.group_id, formatSpeakerLine(userName, cleanedMsg))
    }

    const queueKey = e.isGroup ? `group_${e.group_id}` : `user_${e.user_id}`

    if (!this.shouldTriggerReply(e)) return false

    const special = inspectSpecialMessage(cleanedMsg, this.interjections)
    if (!special.useAPI) {
      if (special.shouldReply) await e.reply(special.content, true)
      return special.shouldReply
    }

    if (!this.storage.canPassRateLimit(e.user_id)) {
      await e.reply('你问得太快啦 休息一下吧', true)
      return true
    }

    if (!this.checkCooldown(e.user_id)) return false
    if (this.processingQueue.get(queueKey)) return false
    this.processingQueue.set(queueKey, true)

    const startedAt = Date.now()
    try {
      await this.randomDelay()

      const contextId = buildContextId(e)
      const publicMemoryId = e.isGroup ? buildPublicMemoryId(e.group_id) : null
      const context = this.storage.getContext(contextId)
      const publicMemory = publicMemoryId ? this.storage.getContext(publicMemoryId) : []
      const quoted = e.source ? await this.getQuotedMessage(e) : null
      if (quoted) {
        context.push({ role: 'assistant', content: quoted, timestamp: Date.now() })
      }

      context.push({ role: 'user', content: cleanedMsg, timestamp: Date.now() })
      if (publicMemoryId && !isMeaningless(cleanedMsg)) {
        publicMemory.push({ role: 'user', content: formatSpeakerLine(userName, cleanedMsg), timestamp: Date.now() })
        if (publicMemory.length > LIMITS.maxPublicMemory) publicMemory.splice(0, publicMemory.length - LIMITS.maxPublicMemory)
      }

      const systemPrompt = this.buildBaseSystemPrompt(e, userName, cleanedMsg)
      const messages = [{ role: 'system', content: systemPrompt }]
      if (e.isGroup) {
        const groupWindow = this.buildGroupWindowMessages(e.group_id)
        if (groupWindow.length) messages.push({ role: 'system', content: `最近群聊记录：\n${groupWindow.map(item => item.content).join('\n')}` })
      }

      const archive = this.storage.getArchives().get(contextId)?.at(-1)
      if (archive?.summary) messages.push({ role: 'system', content: `历史对话摘要：${archive.summary}` })

      const info = this.storage.getImportantInfo().get(`user_${e.user_id}_info`)
      if (info) {
        const facts = (info.facts || []).slice(-5).map(item => item.content).join('; ')
        if (facts) messages.push({ role: 'system', content: `已知用户信息：${facts}` })
      }

      messages.push(...context)
      const reply = await this.callModel(messages)
      const cleanReply = String(reply).replace(/\[CQ:[^\]]+\]/g, ' ').trim()

      // 已移除本地敏感词审查，完全依赖 DeepSeek 模型自身的安全机制
      // 避免误杀正常创作内容（如作文、小说、英语学习等场景）

      context.push({ role: 'assistant', content: cleanReply, timestamp: Date.now() })
      if (publicMemoryId && !isMeaningless(cleanReply)) {
        publicMemory.push({ role: 'assistant', content: formatSpeakerLine('机器人', cleanReply), timestamp: Date.now() })
        if (publicMemory.length > LIMITS.maxPublicMemory) publicMemory.splice(0, publicMemory.length - LIMITS.maxPublicMemory)
      }

      this.storage.scheduleFlush('context')
      this.setCooldown(e.user_id)
      this.social.recordInteraction(e, String(selfId))

      if (this.debugMode) {
        const duration = Date.now() - startedAt
        await this.sendReply(e, `${cleanReply}\n[调试] 上下文:${context.length}条 Token:${this.storage.getStats().totalTokens} 耗时:${duration}ms`)
      } else {
        await this.sendReply(e, cleanReply)
      }
      return true
    } catch (error) {
      logger?.error?.(`[智能对话] API错误: ${error.message}`)
      await e.reply('出了点问题 等会吧', true)
      return false
    } finally {
      this.processingQueue.delete(queueKey)
    }
  }
}

export const chatService = new ChatService()
