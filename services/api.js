import fetch from 'node-fetch'
import { API_CONFIG } from '../config/config.js'

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class DeepSeekApiService {
  constructor(options = {}) {
    this.config = { ...API_CONFIG, ...options }
  }

  ensureConfigured() {
    if (!this.config.apiKey) {
      throw new Error('未配置 DeepSeek API Key，请设置 DEEPSEEK_API_KEY 或 SILICONFLOW_API_KEY 环境变量')
    }
  }

  async request(messages, extra = {}) {
    this.ensureConfigured()
    let lastError = null

    for (let attempt = 1; attempt <= this.config.maxRetry; attempt++) {
      try {
        const requestBody = {
          model: this.config.modelName,
          messages,
          temperature: extra.temperature ?? 0.8,
          top_p: extra.topP ?? 0.9,
          stream: false,
          enable_thinking: false
        }
        const maxTokens = extra.maxTokens ?? this.config.maxTokens
        if (Number.isFinite(maxTokens) && maxTokens > 0) {
          requestBody.max_tokens = Math.floor(maxTokens)
        }

        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify(requestBody),
          timeout: this.config.timeoutMs
        })

        if (!response.ok) {
          throw new Error(`API请求失败: ${response.status} ${response.statusText}`)
        }

        const data = await response.json()
        const content = data?.choices?.[0]?.message?.content
        if (!content) {
          throw new Error('API返回数据格式错误')
        }

        return {
          content,
          usage: data.usage || {
            total_tokens: 0,
            prompt_tokens: 0,
            completion_tokens: 0
          },
          raw: data
        }
      } catch (error) {
        lastError = error
        if (attempt < this.config.maxRetry) {
          const delay = this.config.baseRetryDelay * Math.pow(2, attempt - 1)
          await wait(delay)
        }
      }
    }

    throw lastError
  }
}

export const deepSeekApi = new DeepSeekApiService()
