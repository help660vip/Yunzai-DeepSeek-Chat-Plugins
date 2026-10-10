import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

test('invalid budget environment values cannot remove protective limits', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      "import { API_CONFIG, LIMITS } from './config/config.js'; console.log(JSON.stringify([API_CONFIG.maxTokens, LIMITS.dailyUserTokens, API_CONFIG.masterMaxTokens, API_CONFIG.masterTimeoutMs, LIMITS.masterHistoryTokens]))"
    ], { env: { ...process.env, API_MAX_TOKENS: value, CHAT_DAILY_USER_TOKENS: value, API_MASTER_MAX_TOKENS: value, API_MASTER_TIMEOUT_MS: value, CHAT_MASTER_HISTORY_TOKENS: value }, encoding: 'utf8' }))
    assert.deepEqual(result, [2048, 60000, null, 300000, 64000])
  }
})
test('master configuration is independent of normal limits and respects timer capacity', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { API_CONFIG, LIMITS } from './config/config.js'; console.log(JSON.stringify([API_CONFIG.maxTokens, API_CONFIG.masterMaxTokens, API_CONFIG.masterTimeoutMs, LIMITS.masterHistoryTokens]))"
  ], { env: { ...process.env, API_MAX_TOKENS: '128', API_MASTER_MAX_TOKENS: '16000', API_MASTER_TIMEOUT_MS: '2147483648', CHAT_MASTER_HISTORY_TOKENS: '80000' }, encoding: 'utf8' }))
  assert.deepEqual(result, [128, 16000, 2147483647, 80000])
})
