import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestGuard } from '../services/request-guard.js'
import { LIMITS } from '../config/config.js'

const limits = { ...LIMITS, cooldownMs: 0 }

test('rolling limits do not reset at a shared minute boundary', () => {
  let now = 59999
  const guard = new RequestGuard({ ...limits, rateLimitPerMinute: 1 }, () => now)
  guard.acquire({ userId: 1 })()
  now = 60000
  assert.throws(() => guard.acquire({ userId: 1 }), { code: 'RATE_LIMIT' })
  now = 119999
  guard.acquire({ userId: 1 })()
})

test('one user cannot call the API in parallel across groups', () => {
  const guard = new RequestGuard(limits)
  const release = guard.acquire({ userId: 1, groupId: 10 })
  assert.throws(() => guard.acquire({ userId: 1, groupId: 20 }), { code: 'BUSY' })
  release(); release()
  guard.acquire({ userId: 1, groupId: 20 })()
  assert.equal(guard.active, 0)
})

test('group and global request caps also cover different users', () => {
  const group = new RequestGuard({ ...limits, groupRateLimitPerMinute: 1 })
  group.acquire({ userId: 1, groupId: 10 })()
  assert.throws(() => group.acquire({ userId: 2, groupId: 10 }), { code: 'RATE_LIMIT' })
  group.acquire({ userId: 2, groupId: 20 })()
  const global = new RequestGuard({ ...limits, globalRateLimitPerMinute: 1 })
  global.acquire({ userId: 1, groupId: 10 })()
  assert.throws(() => global.acquire({ userId: 2, groupId: 20 }), { code: 'RATE_LIMIT' })
})

test('cooldown starts with the attempt and remains after failure', () => {
  let now = 0
  const guard = new RequestGuard(LIMITS, () => now)
  guard.acquire({ userId: 1 })()
  now = 1
  assert.throws(() => guard.acquire({ userId: 1 }), { code: 'COOLDOWN' })
  now = LIMITS.cooldownMs
  guard.acquire({ userId: 1 })()
})

test('global concurrency and repeated notices are bounded', () => {
  let now = 0
  const guard = new RequestGuard({ ...limits, maxConcurrentRequests: 1 }, () => now)
  const release = guard.acquire({ userId: 1 })
  assert.throws(() => guard.acquire({ userId: 2 }), { code: 'BUSY' })
  release()
  assert.equal(guard.shouldNotify(1), true)
  assert.equal(guard.shouldNotify(1), false)
  now = limits.noticeCooldownMs
  assert.equal(guard.shouldNotify(1), true)
  assert.throws(() => guard.acquire({}), { code: 'INVALID_USER' })
})

test('master bypasses rate and concurrency caps without consuming normal slots or windows', () => {
  const guard = new RequestGuard({ ...LIMITS, maxConcurrentRequests: 1, globalRateLimitPerMinute: 1, groupRateLimitPerMinute: 1 })
  const ordinary = guard.acquire({ userId: 1, groupId: 1 })
  for (let i = 0; i < 2; i++) {
    const master = guard.acquire({ userId: 2, groupId: 1, isMaster: true })
    assert.throws(() => guard.acquire({ userId: 2, isMaster: true }), { code: 'BUSY' })
    assert.equal(guard.active, 1)
    master()
  }
  assert.throws(() => guard.acquire({ userId: 3, isMaster: 'true' }), { code: 'BUSY' })
  assert.equal(guard.windows.get('global').length, 1)
  ordinary()
  assert.equal(guard.active, 0)
})
