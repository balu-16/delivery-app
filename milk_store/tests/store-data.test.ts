import { afterEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('store demo data', () => {
  it('applies a claimed task and restores it from the journal after reload', async () => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.resetModules()
    const { useDB } = await import('@dairydirect/shared/mock-db/db')
    const db = useDB.getState().db
    const task = db.pickingTasks.find((item) => item.status === 'waiting_to_pick')!
    const manager = db.workforce.find((member) => member.role === 'store_manager')!

    useDB.getState().apply({
      t: 'picking.claim', taskId: task.id, assigneeId: manager.id, at: db.demoNow,
    })

    expect(useDB.getState().db.pickingTasks.find((item) => item.id === task.id))
      .toMatchObject({ status: 'being_picked', assigneeId: manager.id })
    expect(useDB.getState().db.orders.find((order) => order.id === task.orderId))
      .toMatchObject({ status: 'picking' })

    vi.resetModules()
    const reloaded = await import('@dairydirect/shared/mock-db/db')
    expect(reloaded.useDB.getState().db.pickingTasks.find((item) => item.id === task.id))
      .toMatchObject({ status: 'being_picked', assigneeId: manager.id })
    expect(reloaded.useDB.getState().db.orders.find((order) => order.id === task.orderId))
      .toMatchObject({ status: 'picking' })
  })
})
