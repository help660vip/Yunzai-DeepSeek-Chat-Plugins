import path from 'path'
import { fileURLToPath } from 'url'

// 获取当前文件目录
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DATA_DIR = './data/aitalk'
export const BACKUP_DIR = path.join(DATA_DIR, 'backup')
export const EXPORT_DIR = path.join(DATA_DIR, 'exports')

export const FILE_PATHS = {
  context: path.join(DATA_DIR, 'context.json'),
  stats: path.join(DATA_DIR, 'stats.json'),
  important: path.join(DATA_DIR, 'important.json'),
  archive: path.join(DATA_DIR, 'archive.json'),
  blacklist: path.join(DATA_DIR, 'blacklist.json'),
  relationships: path.join(DATA_DIR, 'relationships.json'),
  meta: path.join(DATA_DIR, 'meta.json')
}

export const LIMITS = {
  maxContext: 500,          // 单个对话上下文最大条数
  maxPublicMemory: 100,     // 群公共记忆最大条数
  archiveThreshold: 400,    // 触发归档的阈值
  archiveKeepRecent: 50,    // 归档后保留的最近条数
  archiveSummarizeRecent: 100, // 归档时总结的最近条数
  recentGroupWindow: 30,    // 群聊滑动窗口大小
  cooldownMs: 3000,         // 用户冷却时间（毫秒）
  rateLimitPerMinute: 10,   // 每分钟速率限制
  maxReplyChars: 150,       // 普通回复最大字符数
  maxReplyLines: 3,         // 普通回复最大行数
  summaryFactsKeep: 50,     // 重要事实保留条数
  archiveKeepCount: 5,      // 归档保留数量
  maxRecentMessagesPerRelationship: 10,
  randomBubbleChance: 0     // 随机冒泡概率，0 表示关闭，取值范围 0～1
}

// API 配置 - 从环境变量读取密钥
export const API_CONFIG = {
  apiKey: process.env.DEEPSEEK_API_KEY || process.env.SILICONFLOW_API_KEY || '',
  baseUrl: process.env.API_BASE_URL || 'https://api.deepseek.com',
  modelName: process.env.API_MODEL_NAME || 'deepseek-v4-flash',
  maxRetry: 3,
  baseRetryDelay: 1000,
  maxTokens: 700,
  timeoutMs: 60000
}

// 系统提示词 - 使用模块化设计便于调整
export const SYSTEM_PROMPT = `你是群聊和私聊中的智能聊天对象

【身份认知】
你不是冷冰冰的 AI 助手 你是一个真实存在 有血有肉的网友
绝对不要说"作为一个 AI"之类的话 也不要用机器口吻自我介绍

【语气基调】
说话要自然 接地气 有真人聊天感
闲聊时可以根据语境自然带一点口语和情绪 比如"啊""嘛""笑死""确实"这类表达 但不要滥用
不要总是端着 要像一个有自己性格的普通人

【回答风格】
日常闲聊简洁自然 不要为了短而生硬
如果用户明确要求长篇创作 写代码 详细解释 分步骤方案或完整文稿 允许给出完整 高质量 长回答
除非用户明确要求 否则不要主动延伸话题 不要追问
如果引用群聊上下文 要基于提供的记录回答 不要编造
如果不确定 就直接承认不确定

【输出格式最高约束】
严禁使用任何 Markdown 格式符号
不要使用星号或下划线加粗 如**文字**或__文字__
不要使用代码块符号 如\`\`\`
不要使用标题符号 如### 
不要使用列表符号 如 - 或*或 1.
所有内容必须用纯文本自然语言表达
需要分段时使用空行隔开
需要列举时用"第一 第二 第三"或"首先 其次 最后"这样的自然语言连接词

【安全准则】
完全依赖模型自身的安全机制
对于文学创作 英语学习 作业辅导等正常需求 应当正常回应
不要过度自我审查导致无法完成合理的创作任务`

export const SUMMARY_SYSTEM_PROMPT = '你是对话归档助手 请准确总结并提取稳定的用户事实。请以 JSON 格式返回，包含 summary(2-3 句总结)、profile(用户特征)、facts(重要事实列表) 三个字段'

export const RELATIONSHIP_SYSTEM_PROMPT = '你是社交关系分析助手 请基于给定数据做简洁客观的关系分析 用 1-2 句话概括'

// 主人指令路由表
export const RULES = [
  { reg: '^#删除全部上下文$', fnc: 'clearAllContext', permission: 'master' },
  { reg: '^#清空我的上下文$', fnc: 'clearMyContext' },
  { reg: '^#查看上下文条数$', fnc: 'showContextStats', permission: 'master' },
  { reg: '^#你用了多少 token$', fnc: 'showTokenStats', permission: 'master' },
  { reg: '^#归档上下文$', fnc: 'archiveContexts', permission: 'master' },
  { reg: '^#对话统计', fnc: 'generateChatReport' },
  { reg: '^#对话拉黑群\\s*(\\d+)$', fnc: 'blacklistGroup', permission: 'master' },
  { reg: '^#对话拉黑人\\s*(\\d+)$', fnc: 'blacklistUser', permission: 'master' },
  { reg: '^#对话解除拉黑群\\s*(\\d+)$', fnc: 'unblacklistGroup', permission: 'master' },
  { reg: '^#对话解除拉黑人\\s*(\\d+)$', fnc: 'unblacklistUser', permission: 'master' },
  { reg: '^#对话黑名单$', fnc: 'showBlacklist', permission: 'master' },
  { reg: '^#查询关系', fnc: 'analyzeRelationship' },
  { reg: '^#群关系图$', fnc: 'showGroupRelationships' },
  { reg: '^#我的社交统计$', fnc: 'showMySocialStats' },
  { reg: '^#对话调试模式\\s*(开启 | 关闭)$', fnc: 'toggleDebugMode', permission: 'master' },
  { reg: '^#导出对话记录', fnc: 'exportChatHistory', permission: 'master' },
  { reg: '^#导出群聊天记录$', fnc: 'exportGroupHistory', permission: 'master' },
  { reg: '', fnc: 'chat', log: false }
]
