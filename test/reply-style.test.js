import test from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, SYSTEM_PROMPT } from '../config/config.js'

test('reply style distinguishes casual chat from substantive questions', () => {
  assert.match(SYSTEM_PROMPT, /通常一两句话说完就停/)
  assert.match(SYSTEM_PROMPT, /根据问题复杂度完整回答 不限制篇幅/)
  assert.match(SYSTEM_PROMPT, /即使没有出现"详细"两个字也要提供足够信息/)
})

test('normal replies have no local character or line limit', () => {
  assert.equal('maxReplyChars' in LIMITS, false)
  assert.equal('maxReplyLines' in LIMITS, false)
})

test('the prompt rejects padding in detailed answers', () => {
  assert.match(SYSTEM_PROMPT, /详细也不要重复凑字数/)
})
