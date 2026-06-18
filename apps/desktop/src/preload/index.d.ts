import { ElectronAPI } from '@electron-toolkit/preload'

export interface TimerState {
  id: string
  userId: string
  workDate: string
  accumulatedSeconds: number
  activeStartedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TrackerAPI {
  login(email: string, password: string): Promise<{ user: { email: string } }>
  restoreSession(): Promise<{ user: { email: string }; timer: TimerState } | null>
  logout(): Promise<void>
  getToday(): Promise<TimerState>
  start(): Promise<TimerState>
  stop(): Promise<TimerState>
  onTimerUpdated(callback: (timer: TimerState) => void): () => void
  onConnectionChanged(callback: (online: boolean) => void): () => void
  onSessionExpired(callback: () => void): () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    tracker: TrackerAPI
  }
}
