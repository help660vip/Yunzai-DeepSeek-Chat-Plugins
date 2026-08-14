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

test('the default tone is calm without becoming cold', () => {
  assert.match(SYSTEM_PROMPT, /默认语气平静克制/)
  assert.match(SYSTEM_PROMPT, /友好但不过度热情或熟络/)
  assert.match(SYSTEM_PROMPT, /不要比对方表现得更兴奋/)
  assert.match(SYSTEM_PROMPT, /克制不等于冷淡/)
  assert.doesNotMatch(SYSTEM_PROMPT, /有血有肉|笑死/)
})
