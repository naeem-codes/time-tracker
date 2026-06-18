import Database from 'better-sqlite3'

export type TimerActionType = 'START' | 'STOP'

export interface QueuedTimerAction {
  id: number
  userId: string
  action: TimerActionType
  occurredAt: string
}

export class TimerActionQueue {
  private readonly database: Database.Database

  constructor(path: string) {
    this.database = new Database(path)
    this.database.pragma('journal_mode = WAL')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS timer_action_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('START', 'STOP')),
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  enqueue(userId: string, action: TimerActionType, occurredAt: string): void {
    this.database
      .prepare(
        `
          INSERT INTO timer_action_queue (user_id, action, occurred_at)
          VALUES (?, ?, ?)
        `
      )
      .run(userId, action, occurredAt)
  }

  list(userId: string): QueuedTimerAction[] {
    return this.database
      .prepare(
        `
          SELECT id, user_id AS userId, action, occurred_at AS occurredAt
          FROM timer_action_queue
          WHERE user_id = ?
          ORDER BY id ASC
        `
      )
      .all(userId) as QueuedTimerAction[]
  }

  remove(id: number): void {
    this.database.prepare('DELETE FROM timer_action_queue WHERE id = ?').run(id)
  }

  count(userId: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM timer_action_queue WHERE user_id = ?')
      .get(userId) as { count: number }

    return row.count
  }

  close(): void {
    this.database.close()
  }
}
