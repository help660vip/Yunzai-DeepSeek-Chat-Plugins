import test from 'node:test'
import assert from 'node:assert/strict'
import { SocialService } from '../services/social.js'
import { LIMITS } from '../config/config.js'

function fixture() {
  const relationships = {}
  return { social: new SocialService({ getRelationships: () => relationships, setRelationships: () => {} }), relationships }
}

test('human mentions and quotes are collected once with exact target counts', () => {
  const { social, relationships } = fixture()
  social.recordGroupMessage({ group_id: 1, isGroup: false, user_id: 10, self_id: 99, sender: { nickname: '甲' },
    msg: '[CQ:at,qq=20] 你好', message: [{ type: 'at', qq: 20 }], source: { user_id: 20 }
  }, 99)
  const rel = relationships['1'].relationships['10_20']
  assert.equal(rel.interactionCount, 1)
  assert.equal(rel.atCount, 1)
  assert.equal(rel.replyCount, 1)
  assert.equal(relationships['1'].userNames['10'], '甲')
  social.recordInteraction({ group_id: 1, user_id: 10, self_id: 99, msg: '数量是2099', source: { user_id: 21 } }, 20)
  assert.equal(rel.atCount, 1)
  assert.equal(rel.replyCount, 1)
})

test('mass mentions are bounded and exclude self and bot', () => {
  const { social, relationships } = fixture()
  social.recordGroupMessage({ group_id: 1, user_id: 10, self_id: 99, msg: '大家好',
    message: [10, 99, ...Array.from({ length: 10 }, (_, i) => i + 20)].map(qq => ({ type: 'at', qq }))
  }, 99)
  assert.equal(Object.keys(relationships['1'].relationships).length, 5)
  assert.equal(relationships['1'].relationships['10_10'], undefined)
  assert.equal(relationships['1'].relationships['10_99'], undefined)
})

test('topic keys and history cannot grow without bound', () => {
  const { social, relationships } = fixture()
  for (let i = 0; i < 80; i++) social.recordInteraction({ group_id: 1, user_id: 10, msg: String.fromCharCode(0x4e00 + i).repeat(200) }, 20)
  social.recordInteraction({ group_id: 1, user_id: 10, msg: 'constructor' }, 20)
  const rel = relationships['1'].relationships['10_20']
  assert.equal(Object.keys(rel.topics).length, LIMITS.maxTopicsPerRelationship)
  assert.equal(rel.topics.constructor, 1)
  assert.ok(Object.keys(rel.topics).every(word => word.length <= 40))
  assert.equal(rel.recentMessages.length, LIMITS.maxRecentMessagesPerRelationship)
})