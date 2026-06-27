import { formatRelationshipKey, detectEmotion, cleanCQCodes } from '../utils/tools.js'
import { LIMITS } from '../config/config.js'

export class SocialService {
  constructor(storage) {
    this.storage = storage
  }

  recordInteraction(e, targetUserId = null) {
    if (!e.isGroup || !targetUserId) return

    const groupId = String(e.group_id)
    const userId = String(e.user_id)
    const userName = e.sender?.card || e.sender?.nickname || userId
    const targetName = String(targetUserId) === String(e.self_id || e.bot?.uin || '')
      ? '机器人'
      : String(targetUserId)

    const relationships = this.storage.getRelationships()
    if (!relationships[groupId]) {
      relationships[groupId] = { relationships: {}, userNames: {} }
    }

    relationships[groupId].userNames[userId] = userName
    relationships[groupId].userNames[String(targetUserId)] = relationships[groupId].userNames[String(targetUserId)] || targetName

    const key = formatRelationshipKey(userId, targetUserId)
    if (!relationships[groupId].relationships[key]) {
      relationships[groupId].relationships[key] = {
        interactionCount: 0,
        atCount: 0,
        replyCount: 0,
        lastInteraction: 0,
        emotionStats: { happy: 0, sad: 0, angry: 0, excited: 0, neutral: 0 },
        topics: {},
        recentMessages: []
      }
    }

    const rel = relationships[groupId].relationships[key]
    rel.interactionCount++
    rel.lastInteraction = Date.now()
    if (e.atBot || cleanCQCodes(e.msg).includes(String(targetUserId))) rel.atCount++
    else if (e.source) rel.replyCount++

    const emotion = detectEmotion(e.msg)
    rel.emotionStats[emotion]++

    const keywords = cleanCQCodes(e.msg)
      .replace(/[^一-龥a-zA-Z]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length >= 2)
      .slice(0, 3)

    for (const word of keywords) {
      rel.topics[word] = (rel.topics[word] || 0) + 1
    }

    rel.recentMessages.push({
      from: userId,
      to: String(targetUserId),
      snippet: cleanCQCodes(e.msg).slice(0, 20),
      time: Date.now(),
      emotion
    })

    if (rel.recentMessages.length > LIMITS.maxRecentMessagesPerRelationship) {
      rel.recentMessages.shift()
    }

    this.storage.setRelationships(relationships)
  }

  buildGroupSummary(groupId) {
    const relationships = this.storage.getRelationships()
    const group = relationships[String(groupId)]
    if (!group || Object.keys(group.relationships).length === 0) return null

    const relList = Object.entries(group.relationships)
      .map(([key, data]) => {
        const [u1, u2] = key.split('_')
        return {
          name1: group.userNames[u1] || u1,
          name2: group.userNames[u2] || u2,
          count: data.interactionCount
        }
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    const userInteractionCount = {}
    for (const [key, data] of Object.entries(group.relationships)) {
      const [u1, u2] = key.split('_')
      userInteractionCount[u1] = (userInteractionCount[u1] || 0) + data.interactionCount
      userInteractionCount[u2] = (userInteractionCount[u2] || 0) + data.interactionCount
    }

    const socialCenter = Object.entries(userInteractionCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([uid, count]) => `${group.userNames[uid] || uid}(${count}次)`)

    return { relList, socialCenter }
  }
}
