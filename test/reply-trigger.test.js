import test from 'node:test'
import assert from 'node:assert/strict'
import { isGroupMessage, shouldTriggerMessageReply } from '../utils/tools.js'

test('events with group_id are treated as group messages', () => {
  const event = { isGroup: false, group_id: 123456, user_id: 10001 }
  assert.equal(isGroupMessage(event), true)
  assert.equal(shouldTriggerMessageReply(event, 99999, 0), false)
})

test('zero bubble chance does not call the random function or reply', () => {
  let randomCalled = false
  const random = () => {
    randomCalled = true
    return 0
  }

  assert.equal(shouldTriggerMessageReply({ isGroup: true }, 99999, 0, random), false)
  assert.equal(shouldTriggerMessageReply({ isGroup: true }, 99999, '0', random), false)
  assert.equal(randomCalled, false)
})

test('invalid and negative chances do not trigger random replies', () => {
  assert.equal(shouldTriggerMessageReply({ isGroup: true }, 99999, Number.NaN), false)
  assert.equal(shouldTriggerMessageReply({ isGroup: true }, 99999, -0.1), false)
})

test('a valid chance triggers only when the random value is lower', () => {
  assert.equal(shouldTriggerMessageReply({ isGroup: true }, 99999, 0.2, () => 0.19), true)
  assert.equal(shouldTriggerMessageReply({ isGroup: true }, 99999, 0.2, () => 0.2), false)
})

test('private messages, mentions, and replies to the bot still trigger', () => {
  assert.equal(shouldTriggerMessageReply({ user_id: 10001 }, 99999, 0), true)
  assert.equal(shouldTriggerMessageReply({ isGroup: true, atBot: true }, 99999, 0), true)
  assert.equal(shouldTriggerMessageReply({ isGroup: true, source: { user_id: 99999 } }, 99999, 0), true)
})
