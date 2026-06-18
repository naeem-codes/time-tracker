import { useEffect, useState } from 'react'
import logo from './assets/n-logo.svg'

interface TimerState {
  id: string
  userId: string
  workDate: string
  accumulatedSeconds: number
  activeStartedAt: string | null
  createdAt: string
  updatedAt: string
}

function calculateDisplayedSeconds(timer: TimerState | null): number {
  if (!timer) {
    return 0
  }

  if (!timer.activeStartedAt) {
    return timer.accumulatedSeconds
  }

  const elapsedSeconds = Math.floor((Date.now() - new Date(timer.activeStartedAt).getTime()) / 1000)

  return timer.accumulatedSeconds + Math.max(elapsedSeconds, 0)
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback

  return error.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '')
}

function App(): React.JSX.Element {
  const [email, setEmail] = useState('employee@example.com')
  const [password, setPassword] = useState('password123')
  const [loggedIn, setLoggedIn] = useState(false)
  const [timer, setTimer] = useState<TimerState | null>(null)
  const [displayedSeconds, setDisplayedSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [online, setOnline] = useState(true)

  useEffect(() => {
    void window.tracker
      .restoreSession()
      .then((session) => {
        if (!session) return

        setEmail(session.user.email)
        setTimer(session.timer)
        setLoggedIn(true)
      })
      .catch(() => undefined)
      .finally(() => setRestoring(false))
  }, [])

  useEffect(() => {
    const removeTimerListener = window.tracker.onTimerUpdated(setTimer)
    const removeConnectionListener = window.tracker.onConnectionChanged(setOnline)
    const removeSessionListener = window.tracker.onSessionExpired(() => {
      setTimer(null)
      setLoggedIn(false)
      setError('Your session expired. Please sign in again.')
    })

    return () => {
      removeTimerListener()
      removeConnectionListener()
      removeSessionListener()
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      setDisplayedSeconds(calculateDisplayedSeconds(timer))
    }, 1000)

    return () => clearInterval(interval)
  }, [timer])

  async function login(): Promise<void> {
    try {
      setError(null)
      setLoading(true)

      await window.tracker.login(email, password)
      const today = await window.tracker.getToday()

      setTimer(today)
      setLoggedIn(true)
    } catch (caughtError) {
      setError(errorMessage(caughtError, 'Unable to sign in. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  async function startTimer(): Promise<void> {
    try {
      setError(null)
      setLoading(true)
      setTimer(await window.tracker.start())
    } catch (caughtError) {
      setError(errorMessage(caughtError, 'Unable to start tracking. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  async function stopTimer(): Promise<void> {
    try {
      setError(null)
      setLoading(true)
      setTimer(await window.tracker.stop())
    } catch (caughtError) {
      setError(errorMessage(caughtError, 'Unable to stop tracking. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  async function logout(): Promise<void> {
    setLoading(true)
    await window.tracker.logout()
    setTimer(null)
    setLoggedIn(false)
    setLoading(false)
  }

  if (restoring) {
    return (
      <main className="app-shell login-shell">
        <section className="login-card">
          <img className="login-logo" src={logo} alt="N" />
          <p className="eyebrow">Restoring session</p>
          <h1>Welcome back</h1>
        </section>
      </main>
    )
  }

  if (!loggedIn) {
    return (
      <main className="app-shell login-shell">
        <section className="login-card">
          <img className="login-logo" src={logo} alt="N" />
          <p className="eyebrow">Focused work, clearly tracked</p>
          <h1>Welcome back</h1>
          <p className="subtle">Sign in to start tracking your day.</p>

          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault()
              void login()
            }}
          >
            <label>
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                type="email"
              />
            </label>

            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                type="password"
              />
            </label>

            <button className="primary-button" disabled={loading} type="submit">
              {loading ? 'Signing in...' : 'Sign in'}
              <span aria-hidden="true">→</span>
            </button>
          </form>

          {error && <p className="error-message">{error}</p>}
        </section>
      </main>
    )
  }

  const isRunning = Boolean(timer?.activeStartedAt)
  const todayLabel = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date())

  return (
    <main className="app-shell tracker-shell">
      <header className="topbar">
        <div className="brand">
          <img className="header-logo" src={logo} alt="N" />
          <div>
            <strong>Time Tracker</strong>
            <span>Desktop</span>
          </div>
        </div>

        <button className="profile-chip" disabled={loading} onClick={() => void logout()}>
          <span className="avatar">{email.charAt(0).toUpperCase()}</span>
          <span>{email}</span>
          <small>Sign out</small>
        </button>
      </header>

      <section className="tracker-card">
        <div className="tracker-heading">
          <div>
            <p className="eyebrow">{todayLabel}</p>
            <h1>Your focus time</h1>
          </div>
          <span className={`status-badge ${isRunning ? 'status-running' : ''}`}>
            <span className="status-dot" />
            {isRunning ? 'Tracking' : 'Paused'}
          </span>
        </div>

        <div className="timer-wrap">
          <div className={`timer-orbit ${isRunning ? 'timer-orbit-running' : ''}`}>
            <div className="timer-center">
              <span>Today</span>
              <strong>{formatDuration(displayedSeconds)}</strong>
              <small>{isRunning ? 'Keep the momentum going' : 'Ready when you are'}</small>
            </div>
          </div>
        </div>

        <button
          className={`timer-button ${isRunning ? 'stop-button' : ''}`}
          disabled={loading}
          onClick={() => void (isRunning ? stopTimer() : startTimer())}
        >
          <span className={`control-icon ${isRunning ? 'stop-icon' : 'play-icon'}`} />
          {loading ? 'Updating...' : isRunning ? 'Stop tracking' : 'Start tracking'}
        </button>

        <div className="detail-grid">
          <div className="detail-card">
            <span>Screenshot capture</span>
            <strong>{isRunning ? 'Active' : 'Waiting'}</strong>
            <small>Every 10 minutes</small>
          </div>
          <div className="detail-card">
            <span>Server connection</span>
            <strong>{online ? 'Connected' : 'Offline'}</strong>
            <small>{online ? 'Timer state is synchronized' : 'Will retry automatically'}</small>
          </div>
        </div>

        {error && <p className="error-message">{error}</p>}
      </section>
    </main>
  )
}

export default App
