import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StorageService } from '../services/storage.js'
import { LIMITS } from '../config/config.js'

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aitalk-storage-'))
  const storage = new StorageService({ dataDir: dir, startTimers: false })
  t.after(async () => {
    await storage.close()
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(dir, { recursive: true, force: true })
  })
  return storage
}
const limits = { ...LIMITS, dailyGlobalTokens: 100, dailyUserTokens: 100, dailyGroupTokens: 100 }

test('concurrent reservations and process restart cannot exceed daily budget', async t => {
  const storage = await fixture(t)
  const now = Date.now()
  const results = await Promise.allSettled([
    storage.reserveTokenBudget({ userId: 1 }, 60, limits, now),
    storage.reserveTokenBudget({ userId: 2 }, 60, limits, now)
  ])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'DAILY_BUDGET')
  const saved = JSON.parse(await fs.readFile(storage.filePaths.meta, 'utf8'))
  assert.equal(saved.tokenBudget.used.global, 60)
  const restarted = new StorageService({ dataDir: storage.dataDir, startTimers: false })
  await assert.rejects(restarted.reserveTokenBudget({ userId: 3 }, 50, limits, now), { code: 'DAILY_BUDGET' })
  await restarted.close()
  const reservation = results.find(x => x.status === 'fulfilled').value
  await storage.settleTokenBudget(reservation, { total_tokens: 10 })
  assert.equal(storage.getDailyBudget(now).used.global, 10)
  await storage.reserveTokenBudget({ userId: 3 }, 50, limits, now)
  assert.equal(storage.getDailyBudget(now).used.global, 60)
})

test('user and group budgets are checked before any debit', async t => {
  const storage = await fixture(t)
  const tight = { ...limits, dailyUserTokens: 70, dailyGroupTokens: 60 }
  await storage.reserveTokenBudget({ userId: 1, groupId: 10 }, 50, tight)
  await assert.rejects(storage.reserveTokenBudget({ userId: 2, groupId: 10 }, 20, tight), { code: 'DAILY_BUDGET' })
  await assert.rejects(storage.reserveTokenBudget({ userId: 1, groupId: 20 }, 30, tight), { code: 'DAILY_BUDGET' })
  assert.equal(storage.getDailyBudget().used.global, 50)
})

test('unknown usage keeps reservations and midnight uses Asia Shanghai', async t => {
  const storage = await fixture(t)
  const before = Date.UTC(2026, 9, 9, 15, 59, 59)
  const reservation = await storage.reserveTokenBudget({ userId: 1 }, 30, limits, before)
  await storage.settleTokenBudget(reservation, null)
  assert.equal(storage.getDailyBudget(before).used.global, 30)
  const after = before + 2000
  await storage.reserveTokenBudget({ userId: 1 }, 40, limits, after)
  await storage.settleTokenBudget(reservation, { total_tokens: 5 })
  assert.equal(storage.getDailyBudget(after).day, '2026-10-10')
  assert.equal(storage.getDailyBudget(after).used.global, 40)
})

test('context limits work for both direct append and replacement', async t => {
  const storage = await fixture(t)
  for (let i = 0; i < LIMITS.maxContext + 3; i++) storage.appendContext('user_1', { role: 'user', content: String(i) })
  assert.equal(storage.getContext('user_1').length, LIMITS.maxContext)
  storage.replaceContext('group_1_public', storage.getContext('user_1'))
  assert.equal(storage.getContext('group_1_public').length, LIMITS.maxPublicMemory)
})

test('user facts and clearing are scoped to the current conversation', async t => {
  const storage = await fixture(t)
  storage.mergeImportantFacts('group_1_user_1', { facts: ['喜欢音乐', '喜欢音乐'] })
  storage.mergeImportantFacts('group_2_user_1', { facts: ['喜欢编程'] })
  storage.mergeImportantFacts('user_1', { facts: ['私人信息'] })
  assert.equal(storage.getImportantInfo().get('group_1_user_1_info').facts.length, 1)
  storage.clearConversationData('group_1_user_1')
  assert.ok(storage.getImportantInfo().has('group_2_user_1_info'))
  assert.ok(storage.getImportantInfo().has('user_1_info'))
})

test('continuous updates do not defer persistence and queued writes use snapshots', async t => {
  const storage = await fixture(t)
  storage.appendContext('user_1', { role: 'user', content: 'before' })
  const timer = storage.writeDebounceTimers.get('context')
  storage.scheduleFlush('context')
  assert.equal(storage.writeDebounceTimers.get('context'), timer)
  const write = storage.enqueueWrite('context')
  storage.getContext('user_1').push({ role: 'assistant', content: 'after' })
  await write
  const saved = JSON.parse(await fs.readFile(storage.filePaths.context, 'utf8'))
  assert.equal(saved.user_1.length, 1)
})

test('invalid usage cannot corrupt counters and write failures reject cleanly', async t => {
  const storage = await fixture(t)
  storage.recordUsage({ total_tokens: '5', prompt_tokens: -1, completion_tokens: Number.NaN })
  assert.equal(storage.getStats().totalTokens, 0)
  const original = storage.atomicWrite
  storage.atomicWrite = async () => { throw new Error('disk failure') }
  await assert.rejects(storage.enqueueWrite('meta'), /disk failure/)
  storage.atomicWrite = original
})
