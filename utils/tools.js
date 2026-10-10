export function detectLanguage(text = '') {
  if (/[一-龥]/.test(text)) return 'zh'
  if (/[぀-ゟ゠-ヿ]/.test(text)) return 'ja'
  if (/[가-힯]/.test(text)) return 'ko'
  return 'en'
}

export function detectEmotion(text = '') {
  if (/(哈哈|嘿嘿|呵呵|开心|高兴|快乐|😄|😊|😁)/i.test(text)) return 'happy'
  if (/(难过|伤心|哭|😭|😢|😔)/i.test(text)) return 'sad'
  if (/(生气|愤怒|烦|😡|😠)/i.test(text)) return 'angry'
  if (/(哇|太好了|棒|牛|厉害|🎉)/i.test(text)) return 'excited'
  return 'neutral'
}

export function buildEmotionHint(emotion, lang) {
  const hints = []
  if (emotion === 'happy') hints.push('对方心情不错 可以稍微活泼一点')
  if (emotion === 'sad') hints.push('对方有些难过 自然接话 不要套模板安慰或急着提建议')
  if (emotion === 'angry') hints.push('对方有点生气 平常说话即可 不要说教或机械劝冷静')
  if (emotion === 'excited') hints.push('对方很兴奋 可以自然接话 不必夸赞或附和')
  if (lang !== 'zh') {
    const langMap = { en: '英语', ja: '日语', ko: '韩语' }
    hints.push(`对方使用${langMap[lang] || lang} 请用相同语言回复`)
  }
  return hints.join(' ')
}

export function cleanCQCodes(text = '', preserveLines = false) {
  const cleaned = String(text).replace(/\[CQ:[^\]]+\]/g, ' ')
  return preserveLines ? cleaned.trim() : cleaned.replace(/\s+/g, ' ').trim()
}

export function stripLeadingAt(text = '') {
  return String(text).replace(/^@.*?\s+/, '').trim()
}

export function normalizeWhitespace(text = '') {
  return String(text).replace(/\s+/g, ' ').trim()
}

export function isGroupMessage(e = {}) {
  if (e.isGroup === true) return true
  return e.group_id !== undefined && e.group_id !== null && String(e.group_id) !== ''
}

export function shouldTriggerMessageReply(e = {}, botId, randomBubbleChance = 0, random = Math.random) {
  if (!isGroupMessage(e)) return true

  const sourceUserId = String(e.source?.user_id || e.source?.sender?.user_id || '')
  const hasBotId = botId !== undefined && botId !== null && String(botId) !== ''
  const repliedToBot = hasBotId && sourceUserId === String(botId)
  const mentionedBot = hasBotId && (
    (Array.isArray(e.message) && e.message.some(item => item.type === 'at' && String(item.qq) === String(botId))) ||
    [...String(e.msg || '').matchAll(/\[CQ:at,qq=(\d+)[^\]]*\]/g)].some(match => match[1] === String(botId))
  )
  if (Boolean(e.atBot) || mentionedBot || repliedToBot) return true

  const chance = Number(randomBubbleChance)
  if (!Number.isFinite(chance) || chance <= 0) return false
  if (chance >= 1) return true
  return random() < chance
}

export function isMeaningless(text = '') {
  const cleaned = normalizeWhitespace(cleanCQCodes(text))
  const meaningless = new Set(['哈哈', '哈哈哈', '？', '?', '。', '.', '嗯', '啊', '哦'])
  return !cleaned || cleaned.length < 2 || meaningless.has(cleaned)
}

export function inspectSpecialMessage(text = '', interjections = { emotion: [], pureIgnore: [] }) {
  const cleaned = normalizeWhitespace(cleanCQCodes(text))
  if (cleaned === '？' || cleaned === '?') {
    return { type: 'question_mark', shouldReply: Math.random() < 0.2, useAPI: false, content: '？' }
  }
  if (/^[？?]{2,}$/.test(cleaned)) {
    return { type: 'multiple_question', shouldReply: Math.random() < 0.3, useAPI: false, content: cleaned }
  }
  if (interjections.emotion.includes(cleaned)) {
    return { type: 'interjection', shouldReply: Math.random() < 0.1, useAPI: false, content: cleaned }
  }
  if (interjections.pureIgnore.includes(cleaned)) {
    return { type: 'ignore', shouldReply: false, useAPI: false }
  }
  if (/^\[CQ:face,id=\d+\]$/.test(text) || /^\[CQ:image/.test(text)) {
    return { type: 'emoji', shouldReply: false, useAPI: false }
  }
  return { type: 'normal', shouldReply: true, useAPI: true }
}

export function formatSpeakerLine(name, content) {
  return `【${name}】说: ${normalizeWhitespace(cleanCQCodes(content))}`
}

export function nowLabel() {
  const now = new Date()
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hour = String(now.getHours()).padStart(2, '0')
  const minute = String(now.getMinutes()).padStart(2, '0')
  const second = String(now.getSeconds()).padStart(2, '0')
  return `${year}年${month}月${day}日 ${weekdays[now.getDay()]} ${hour}:${minute}:${second}`
}

export function buildContextId(e) {
  return isGroupMessage(e) ? `group_${e.group_id}_user_${e.user_id}` : `user_${e.user_id}`
}

export function buildPublicMemoryId(groupId) {
  return `group_${groupId}_public`
}

export function clampArray(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max)
  return arr
}

export function extractJson(text = '') {
  const source = String(text).trim()
  try {
    return JSON.parse(source)
  } catch {
    const match = source.match(/```json\s*([\s\S]*?)\s*```/) || source.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (!match) return null
    try {
      return JSON.parse(match[1])
    } catch {
      return null
    }
  }
}

export function formatRelationshipKey(userA, userB) {
  return [String(userA), String(userB)].sort().join('_')
}

export function uniqueExportName(prefix, targetId = 'unknown') {
  return `${prefix}_${Date.now()}_${targetId}.txt`
}

export function contextBelongsToUser(contextId, userId) {
  const id = String(userId)
  return contextId === `user_${id}` || /^group_\d+_user_\d+$/.test(contextId) && contextId.endsWith(`_user_${id}`)
}

export function messageText(message) {
  if (!Array.isArray(message)) return String(message ?? '')
  return message.filter(item => item?.type === 'text').map(item => item.text || '').join('')
}

export function formatChatReply(reply, userMessage = '') {
  const text = cleanCQCodes(reply, true)
  // 只整理普通聊天的停顿；规范写作、技术内容与原文不做标点改写
  if (!/[一-龥]/.test(text) || /代码|程序|公式|数学|正则|链接|网址|原文|引用|照抄|翻译|作文|小说|诗|标点|JSON|SQL/i.test(userMessage) ||
      /`|https?:\/\/|[a-zA-Z]:[\\/]|\b\w+\.\w+|[=<>]/.test(text)) return text
  return text.replace(/[，。！？；：、,!?;]/g, ' ').replace(/\.(?=\s|$)/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
}

export function mentionedUserIds(e = {}) {
  const ids = [...String(e.msg || '').matchAll(/\[CQ:at,qq=(\d+)[^\]]*\]/g)].map(match => match[1])
  if (Array.isArray(e.message)) {
    ids.push(...e.message.filter(item => item?.type === 'at' && /^\d+$/.test(String(item.qq))).map(item => String(item.qq)))
  }
  return [...new Set(ids)]
}
