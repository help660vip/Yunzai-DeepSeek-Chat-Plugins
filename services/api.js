import { API_CONFIG } from '../config/config.js'

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function normalizeUsage(usage) {
  if (!usage || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(
    key => Number.isSafeInteger(usage[key]) && usage[key] >= 0
  )) return null
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: Math.max(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens)
  }
}

export class DeepSeekApiService {
  constructor(options = {}) {
    this.config = { ...API_CONFIG, ...options }
    this.fetch = options.fetch || globalThis.fetch
    this.wait = options.wait || wait
  }

  ensureConfigured() {
    if (!this.config.apiKey) throw new Error('未配置 API Key 请设置 DEEPSEEK_API_KEY 或 SILICONFLOW_API_KEY')
  }

  async request(messages, extra = {}) {
    this.ensureConfigured()
    const isMaster = extra.isMaster === true
    const maxTokens = isMaster
      ? (extra.maxTokens ?? this.config.masterMaxTokens ?? null)
      : Math.min(extra.maxTokens ?? this.config.maxTokens, this.config.maxTokens)
    if (maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error('输出 Token 上限必须为正整数')
    const maxRetry = Math.max(1, Math.min(3, Math.floor(this.config.maxRetry) || 1))
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      // 预算不足直接退出，不把限额错误当成网络故障重试
      await extra.beforeAttempt?.(attempt)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), isMaster ? this.config.masterTimeoutMs : this.config.timeoutMs)
      let retryable = false
      let phase = 'fetch'
      let lastError
      try {
        const response = await this.fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({
            model: this.config.modelName,
            messages,
            temperature: extra.temperature ?? 0.8,
            top_p: extra.topP ?? 0.9,
            ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
            stream: false,
            enable_thinking: false
          }),
          signal: controller.signal
        })
        phase = 'response'
        if (!response.ok) {
          retryable = [429, 500, 502, 503, 504].includes(response.status)
          await response.body?.cancel?.().catch(() => {})
          throw Object.assign(new Error(`API请求失败 ${response.status}`), { status: response.status })
        }
        const data = await response.json()
        const usage = normalizeUsage(data?.usage)
        // 即使响应内容无效，也统计服务商已经报告的消耗
        await extra.onUsage?.(usage, data?.choices?.[0]?.message?.content)
        const content = data?.choices?.[0]?.message?.content
        if (typeof content !== 'string' || !content.trim()) throw new Error('API返回数据格式错误')
        return { content, usage, raw: data }
      } catch (error) {
        lastError = error
        // 超时结果不明，保留预算且不自动重发；4xx和无效响应也不重试
        if (phase === 'fetch' && !controller.signal.aborted && error.name !== 'AbortError') retryable = true
        if (!retryable || attempt === maxRetry) throw error
      } finally {
        clearTimeout(timer)
      }
      await this.wait(this.config.baseRetryDelay * Math.pow(2, attempt - 1))
      if (!lastError) throw new Error('API请求失败')
    }
  }
}

export const deepSeekApi = new DeepSeekApiService()
