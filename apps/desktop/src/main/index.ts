import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  safeStorage,
  powerMonitor,
  Tray,
  Menu,
  Notification,
  nativeImage
} from 'electron'
import { join } from 'path'
import { readFile, unlink, writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import axios from 'axios'
import type { AxiosRequestConfig } from 'axios'
import { TimerActionQueue } from './action-queue'
import type { TimerActionType } from './action-queue'

const apiBaseUrl = import.meta.env.MAIN_VITE_API_URL ?? 'http://localhost:3000'

const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 10_000
})

interface AuthResponse {
  accessToken: string
  refreshToken: string
  role: 'ADMIN' | 'EMPLOYEE'
  user: {
    id: string
    email: string
    timezone: string
  }
}

let accessToken: string | null = null
let refreshToken: string | null = null
let refreshPromise: Promise<AuthResponse> | null = null
let reconcileInterval: NodeJS.Timeout | null = null
let reconcilePromise: Promise<TimerState> | null = null
let screenshotInterval: NodeJS.Timeout | null = null
let inactivityInterval: NodeJS.Timeout | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let currentTimer: TimerState | null = null
let isQuitting = false
let canQuit = false
let quitPromise: Promise<void> | null = null
let currentUserId: string | null = null
let actionQueue: TimerActionQueue | null = null
let syncPromise: Promise<void> | null = null
let inactivityStopPromise: Promise<void> | null = null
const inactivityThresholdSeconds = 5 * 60

interface TimerState {
  id: string
  userId: string
  workDate: string
  accumulatedSeconds: number
  activeStartedAt: string | null
  createdAt: string
  updatedAt: string
}

function localWorkDate(timestamp: Date): string {
  const offset = timestamp.getTimezoneOffset() * 60_000
  return new Date(timestamp.getTime() - offset).toISOString().slice(0, 10)
}

function friendlyError(
  error: unknown,
  fallback = 'Something went wrong. Please try again.'
): Error {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error : new Error(fallback)
  }

  if (!error.response) {
    return new Error('Unable to connect to the server. Check that the API is running.')
  }

  const message = (error.response.data as { message?: string } | undefined)?.message
  return new Error(message ?? fallback)
}

async function cleanIpc<T>(operation: () => Promise<T>, fallback?: string): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      broadcast('tracker:connection-changed', false)
    }

    throw friendlyError(error, fallback)
  }
}

function authFilePath(): string {
  return join(app.getPath('userData'), 'auth-token.bin')
}

async function saveRefreshToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable')
  }

  await writeFile(authFilePath(), safeStorage.encryptString(token))
}

async function loadRefreshToken(): Promise<string | null> {
  try {
    const encryptedToken = await readFile(authFilePath())
    return safeStorage.decryptString(encryptedToken)
  } catch {
    return null
  }
}

async function clearStoredAuth(): Promise<void> {
  accessToken = null
  refreshToken = null
  currentUserId = null

  try {
    await unlink(authFilePath())
  } catch {
    // The user may already be logged out.
  }
}

function clearLocalTimerState(): void {
  currentTimer = null
  stopScreenshotSchedule()
  stopInactivitySchedule()
  updateTrayMenu()
  broadcast('tracker:timer-updated', null)
}

async function applyAuth(auth: AuthResponse): Promise<void> {
  if (currentUserId && currentUserId !== auth.user.id) {
    clearLocalTimerState()
  }

  accessToken = auth.accessToken
  refreshToken = auth.refreshToken
  currentUserId = auth.user.id
  await saveRefreshToken(auth.refreshToken)
}

async function refreshAuth(): Promise<AuthResponse> {
  if (refreshPromise) {
    return refreshPromise
  }

  refreshPromise = performRefresh()

  try {
    return await refreshPromise
  } finally {
    refreshPromise = null
  }
}

async function performRefresh(): Promise<AuthResponse> {
  const storedRefreshToken = refreshToken ?? (await loadRefreshToken())

  if (!storedRefreshToken) {
    throw new Error('You must log in first')
  }

  try {
    const response = await api.post<AuthResponse>('/auth/refresh', {
      client: 'desktop',
      refreshToken: storedRefreshToken
    })
    await applyAuth(response.data)
    return response.data
  } catch (error) {
    await clearStoredAuth()
    throw error
  }
}

async function authenticatedRequest<T>(config: AxiosRequestConfig): Promise<T> {
  if (!accessToken) {
    await refreshAuth()
  }

  try {
    const response = await api.request<T>({
      ...config,
      headers: {
        ...config.headers,
        Authorization: `Bearer ${accessToken}`
      }
    })
    return response.data
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) {
      throw error
    }

    await refreshAuth()
    const response = await api.request<T>({
      ...config,
      headers: {
        ...config.headers,
        Authorization: `Bearer ${accessToken}`
      }
    })
    return response.data
  }
}

function isRetryableActionError(error: unknown): boolean {
  return axios.isAxiosError(error) && (!error.response || error.response.status >= 500)
}

function optimisticTimerState(action: TimerActionType, occurredAt: string): TimerState {
  const timestamp = new Date(occurredAt)
  const nextWorkDate = localWorkDate(timestamp)
  const existing =
    currentTimer?.userId === currentUserId && currentTimer.workDate === nextWorkDate
      ? currentTimer
      : null
  const accumulatedSeconds =
    action === 'STOP' && existing?.activeStartedAt
      ? existing.accumulatedSeconds +
        Math.max(
          0,
          Math.floor((timestamp.getTime() - new Date(existing.activeStartedAt).getTime()) / 1000)
        )
      : (existing?.accumulatedSeconds ?? 0)

  return {
    id: existing?.id ?? `local-${nextWorkDate}`,
    userId: currentUserId ?? existing?.userId ?? 'local',
    workDate: nextWorkDate,
    accumulatedSeconds,
    activeStartedAt: action === 'START' ? occurredAt : null,
    createdAt: existing?.createdAt ?? occurredAt,
    updatedAt: occurredAt
  }
}

async function syncQueuedTimerActions(): Promise<void> {
  if (syncPromise) {
    return syncPromise
  }

  if (!actionQueue || !currentUserId) {
    return
  }

  syncPromise = (async () => {
    const userId = currentUserId

    if (!userId) {
      return
    }

    const actions = actionQueue?.list(userId) ?? []

    for (const action of actions) {
      await authenticatedRequest<TimerState>({
        method: 'POST',
        url: action.action === 'START' ? '/timer/start' : '/timer/stop',
        data: { occurredAt: action.occurredAt }
      })
      actionQueue?.remove(action.id)
    }
  })()

  try {
    await syncPromise
  } finally {
    syncPromise = null
  }
}

async function performTimerAction(action: TimerActionType): Promise<TimerState> {
  if (!currentUserId) {
    throw new Error('You must log in first')
  }

  const occurredAt = new Date().toISOString()

  try {
    await syncQueuedTimerActions()
    const timer = await authenticatedRequest<TimerState>({
      method: 'POST',
      url: action === 'START' ? '/timer/start' : '/timer/stop',
      data: { occurredAt }
    })

    updateTrackingSchedule(timer)
    broadcast('tracker:timer-updated', timer)
    broadcast('tracker:connection-changed', true)
    return timer
  } catch (error) {
    if (!isRetryableActionError(error)) {
      throw error
    }

    actionQueue?.enqueue(currentUserId, action, occurredAt)
    const timer = optimisticTimerState(action, occurredAt)
    updateTrackingSchedule(timer)
    broadcast('tracker:timer-updated', timer)
    broadcast('tracker:connection-changed', false)
    return timer
  }
}

async function fetchTimerState(): Promise<TimerState> {
  await syncQueuedTimerActions()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  if (timezone) {
    await authenticatedRequest<TimerState>({
      method: 'PUT',
      url: '/me/timezone',
      data: { timezone }
    })
  }

  return authenticatedRequest<TimerState>({
    method: 'GET',
    url: '/timer/today'
  })
}

async function capturePrimaryDisplay(): Promise<{
  contentType: 'image/jpeg' | 'image/png'
  data: Buffer
}> {
  const primaryDisplay = screen.getPrimaryDisplay()
  const thumbnailSize = {
    width: Math.max(1, Math.floor(primaryDisplay.size.width * primaryDisplay.scaleFactor)),
    height: Math.max(1, Math.floor(primaryDisplay.size.height * primaryDisplay.scaleFactor))
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize
  })

  const primarySource =
    sources.find((source) => source.display_id === String(primaryDisplay.id)) ?? sources[0]

  if (!primarySource) {
    throw new Error('No screen source available')
  }

  const jpeg = primarySource.thumbnail.toJPEG(70)

  if (jpeg.byteLength > 0) {
    return {
      contentType: 'image/jpeg',
      data: jpeg
    }
  }

  const png = primarySource.thumbnail.toPNG()

  if (png.byteLength > 0) {
    return {
      contentType: 'image/png',
      data: png
    }
  }

  throw new Error('Screen capture returned an empty image. Check screen recording permissions.')
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show()
  }
}

async function captureScheduledScreenshot(): Promise<void> {
  try {
    const capturedAt = new Date().toISOString()
    const screenshot = await capturePrimaryDisplay()
    await authenticatedRequest({
      method: 'POST',
      url: '/me/screenshots',
      data: {
        capturedAt,
        imageBase64: screenshot.data.toString('base64'),
        mimeType: screenshot.contentType
      }
    })
    console.log(`Captured screenshot: ${screenshot.data.byteLength} bytes (${screenshot.contentType})`)
    showNotification('Screenshot captured', 'Your activity screenshot was captured successfully.')
  } catch (error) {
    console.error('Screenshot capture failed:', error)
    showNotification(
      'Screenshot capture failed',
      'Open N Time to check screen capture permissions.'
    )
  }
}

function startScreenshotSchedule(): void {
  if (screenshotInterval) {
    return
  }

  screenshotInterval = setInterval(() => void captureScheduledScreenshot(), 10 * 60 * 1000)
}

function stopScreenshotSchedule(): void {
  if (screenshotInterval) {
    clearInterval(screenshotInterval)
    screenshotInterval = null
  }
}

async function stopTrackingForInactivity(): Promise<void> {
  if (inactivityStopPromise || !currentTimer?.activeStartedAt) {
    return
  }

  inactivityStopPromise = (async () => {
    try {
      const timer = await performTimerAction('STOP')
      const isPending = Boolean(actionQueue?.count(timer.userId))

      showNotification(
        'Tracking stopped',
        isPending
          ? 'You were inactive for 5 minutes. The stop has been saved offline and will sync automatically.'
          : 'You were inactive for 5 minutes, so tracking was stopped automatically.'
      )
    } catch (error) {
      console.error('Unable to stop tracking for inactivity:', friendlyError(error).message)
    }
  })()

  try {
    await inactivityStopPromise
  } finally {
    inactivityStopPromise = null
  }
}

function startInactivitySchedule(): void {
  if (inactivityInterval) {
    return
  }

  inactivityInterval = setInterval(() => {
    if (!currentTimer?.activeStartedAt || inactivityStopPromise) {
      return
    }

    if (powerMonitor.getSystemIdleTime() >= inactivityThresholdSeconds) {
      void stopTrackingForInactivity()
    }
  }, 15_000)
}

function stopInactivitySchedule(): void {
  if (inactivityInterval) {
    clearInterval(inactivityInterval)
    inactivityInterval = null
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

function updateTrackingSchedule(timer: TimerState): void {
  currentTimer = timer

  if (timer.activeStartedAt) {
    startScreenshotSchedule()
    startInactivitySchedule()
  } else {
    stopScreenshotSchedule()
    stopInactivitySchedule()
  }

  updateTrayMenu()
}

async function reconcileTimer(): Promise<TimerState | null> {
  if (reconcilePromise) {
    return reconcilePromise
  }

  reconcilePromise = fetchTimerState()

  try {
    const timer = await reconcilePromise
    updateTrackingSchedule(timer)
    broadcast('tracker:timer-updated', timer)
    broadcast('tracker:connection-changed', true)
    return timer
  } catch (error) {
    broadcast('tracker:connection-changed', false)

    if (axios.isAxiosError(error) && error.response?.status === 401) {
      await clearStoredAuth()
      broadcast('tracker:session-expired', null)
    }

    return null
  } finally {
    reconcilePromise = null
  }
}

function startReconcileSchedule(): void {
  stopReconcileSchedule()
  reconcileInterval = setInterval(() => void reconcileTimer(), 60_000)
}

function stopReconcileSchedule(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval)
    reconcileInterval = null
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  }

  mainWindow?.show()
  mainWindow?.focus()
}

async function setTimerFromTray(shouldRun: boolean): Promise<void> {
  if (!accessToken && !(await loadRefreshToken())) {
    showMainWindow()
    showNotification('Sign in required', 'Open N Time and sign in before tracking.')
    return
  }

  try {
    const timer = await performTimerAction(shouldRun ? 'START' : 'STOP')
    const isPending = Boolean(actionQueue?.count(timer.userId))
    showNotification(
      shouldRun ? 'Tracking started' : 'Tracking stopped',
      isPending
        ? 'Saved offline and will synchronize automatically.'
        : shouldRun
          ? 'N Time is now tracking your work.'
          : 'Your tracked time has been saved.'
    )
  } catch (error) {
    showNotification('Unable to update timer', friendlyError(error).message)
  }
}

async function stopTrackingAndQuit(): Promise<void> {
  if (quitPromise) {
    return quitPromise
  }

  isQuitting = true
  stopScreenshotSchedule()
  stopReconcileSchedule()
  stopInactivitySchedule()

  quitPromise = (async () => {
    try {
      if (currentTimer?.activeStartedAt) {
        currentTimer = await performTimerAction('STOP')
      }
    } catch (error) {
      console.error('Unable to stop tracking before quitting:', friendlyError(error).message)
    } finally {
      actionQueue?.close()
      actionQueue = null
      canQuit = true
      app.quit()
    }
  })()

  return quitPromise
}

function updateTrayMenu(): void {
  if (!tray) {
    return
  }

  const isTracking = Boolean(currentTimer?.activeStartedAt)
  tray.setToolTip(isTracking ? 'N Time - Tracking' : 'N Time - Paused')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open N Time', click: showMainWindow },
      { type: 'separator' },
      {
        label: isTracking ? 'Tracking in progress' : 'Start tracking',
        enabled: !isTracking,
        click: () => void setTimerFromTray(true)
      },
      {
        label: 'Stop tracking',
        enabled: isTracking,
        click: () => void setTimerFromTray(false)
      },
      { type: 'separator' },
      {
        label: 'Quit N Time',
        click: () => void stopTrackingAndQuit()
      }
    ])
  )
}

function createTray(): void {
  if (tray) {
    return
  }

  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 20, height: 20 }))
  tray.on('click', showMainWindow)
  updateTrayMenu()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
      showNotification(
        'N Time is running in the background',
        'Tracking and screenshots will continue.'
      )
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  actionQueue = new TimerActionQueue(join(app.getPath('userData'), 'tracker.sqlite'))

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('tracker:login', async (_, credentials: { email: string; password: string }) => {
    return cleanIpc(async () => {
      clearLocalTimerState()
      const response = await api.post<AuthResponse>('/auth/login', {
        ...credentials,
        client: 'desktop'
      })
      await applyAuth(response.data)
      startReconcileSchedule()
      broadcast('tracker:connection-changed', true)

      return response.data
    }, 'Unable to sign in. Please try again.')
  })

  ipcMain.handle('tracker:get-today', async () => {
    return cleanIpc(async () => {
      const timer = await fetchTimerState()
      updateTrackingSchedule(timer)
      broadcast('tracker:connection-changed', true)
      return timer
    })
  })

  ipcMain.handle('tracker:start', async () => {
    return cleanIpc(async () => {
      return performTimerAction('START')
    }, 'Unable to start tracking. Please try again.')
  })

  ipcMain.handle('tracker:stop', async () => {
    return cleanIpc(async () => {
      return performTimerAction('STOP')
    }, 'Unable to stop tracking. Please try again.')
  })

  ipcMain.handle('tracker:restore-session', async () => {
    const storedRefreshToken = refreshToken ?? (await loadRefreshToken())

    if (!storedRefreshToken) {
      return null
    }

    try {
      const auth = await refreshAuth()
      const timer = await fetchTimerState()

      updateTrackingSchedule(timer)
      startReconcileSchedule()
      return { user: auth.user, timer }
    } catch {
      await clearStoredAuth()
      return null
    }
  })

  ipcMain.handle('tracker:logout', async () => {
    const storedRefreshToken = refreshToken ?? (await loadRefreshToken())

    if (storedRefreshToken) {
      await api
        .post('/auth/logout', { refreshToken: storedRefreshToken, client: 'desktop' })
        .catch(() => undefined)
    }

    stopScreenshotSchedule()
    stopReconcileSchedule()
    clearLocalTimerState()
    await clearStoredAuth()
  })

  createWindow()
  createTray()

  powerMonitor.on('suspend', () => {
    stopScreenshotSchedule()
    if (currentTimer?.activeStartedAt) {
      void stopTrackingForInactivity()
    }
  })

  powerMonitor.on('resume', () => {
    void reconcileTimer()
  })

  powerMonitor.on('unlock-screen', () => {
    void reconcileTimer()
  })

  app.on('before-quit', (event) => {
    if (canQuit) {
      return
    }

    event.preventDefault()
    void stopTrackingAndQuit()
  })

  app.on('activate', function () {
    showMainWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (isQuitting) {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
