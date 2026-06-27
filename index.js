import plugin from '../../lib/plugins/plugin.js'
import { RULES } from './config/config.js'
import { chatService } from './services/chat.js'

export class DeepSeekChat extends plugin {
  constructor() {
    super({
      name: '智能对话',
      dsc: '基于DeepSeek的智能对话插件',
      event: 'message',
      priority: 5000,
      rule: RULES
    })
  }

  async clearAllContext(e) { return chatService.dispatch('clearAllContext', e) }
  async clearMyContext(e) { return chatService.dispatch('clearMyContext', e) }
  async showContextStats(e) { return chatService.dispatch('showContextStats', e) }
  async showTokenStats(e) { return chatService.dispatch('showTokenStats', e) }
  async archiveContexts(e) { return chatService.dispatch('archiveContexts', e) }
  async generateChatReport(e) { return chatService.dispatch('generateChatReport', e) }
  async blacklistGroup(e) { return chatService.dispatch('blacklistGroup', e) }
  async blacklistUser(e) { return chatService.dispatch('blacklistUser', e) }
  async unblacklistGroup(e) { return chatService.dispatch('unblacklistGroup', e) }
  async unblacklistUser(e) { return chatService.dispatch('unblacklistUser', e) }
  async showBlacklist(e) { return chatService.dispatch('showBlacklist', e) }
  async analyzeRelationship(e) { return chatService.dispatch('analyzeRelationship', e) }
  async showGroupRelationships(e) { return chatService.dispatch('showGroupRelationships', e) }
  async showMySocialStats(e) { return chatService.dispatch('showMySocialStats', e) }
  async toggleDebugMode(e) { return chatService.dispatch('toggleDebugMode', e) }
  async exportChatHistory(e) { return chatService.dispatch('exportChatHistory', e) }
  async exportGroupHistory(e) { return chatService.dispatch('exportGroupHistory', e) }
  async chat(e) { return chatService.dispatch('chat', e) }
}

export default DeepSeekChat
