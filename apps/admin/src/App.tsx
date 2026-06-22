import { FormEvent, useEffect, useMemo, useState } from "react";
import logo from "./logo.svg";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
type Role = "ADMIN" | "EMPLOYEE";

interface CurrentUser {
  id: string;
  email: string;
  timezone: string;
}

interface User extends CurrentUser {
  role: Role;
  createdAt: string;
}

interface Screenshot {
  id: string;
  capturedAt: string;
  createdAt: string;
  previewUrl: string | null;
}

interface ScreenshotPage {
  items: Screenshot[];
  nextCursor: string | null;
}

interface WorkDay {
  id: string;
  workDate: string;
  accumulatedSeconds: number;
  activeStartedAt: string | null;
  totalSeconds: number;
  isActive: boolean;
  screenshotCount: number;
}

interface TimeRow extends CurrentUser {
  totalSeconds: number;
  isActive: boolean;
  workDay: WorkDay | null;
}

interface AuthResponse {
  accessToken: string;
  role: Role;
  user: CurrentUser;
}

type DashboardView = "overview" | "screenshots";
type QuickDateFilter = "today" | "yesterday" | "custom";

let accessToken = "";
let refreshPromise: Promise<AuthResponse | null> | null = null;

function localDate(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDate(date);
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function friendlyDate(date: string): string {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
}

function quickFilterForDate(date: string): QuickDateFilter {
  if (date === localDate()) return "today";
  if (date === daysAgo(1)) return "yesterday";
  return "custom";
}

function readViewFromUrl(): DashboardView {
  if (typeof window === "undefined") return "overview";

  const view = new URLSearchParams(window.location.search).get("view");
  return view === "screenshots" ? "screenshots" : "overview";
}

function writeViewToUrl(view: DashboardView): void {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);

  if (view === "overview") {
    url.searchParams.delete("view");
  } else {
    url.searchParams.set("view", view);
  }

  window.history.replaceState({}, "", url);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof TypeError) {
    return "Unable to connect to the server. Check that the API is running.";
  }
  return error instanceof Error ? error.message : fallback;
}

async function refreshAccessToken(): Promise<AuthResponse | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: "web" }),
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const auth = (await response.json()) as AuthResponse;
      accessToken = auth.accessToken;
      return auth;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

async function apiRequest<T>(
  path: string,
  options?: RequestInit,
  retry = true,
): Promise<T> {
  const headers = new Headers(options?.headers);

  if (!headers.has("Content-Type") && options?.body) {
    headers.set("Content-Type", "application/json");
  }

  headers.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });
  const body = await response.json().catch(() => null);

  if (response.status === 401 && retry && (await refreshAccessToken())) {
    return apiRequest<T>(path, options, false);
  }
  if (response.status === 401) window.dispatchEvent(new Event("auth-expired"));
  if (!response.ok) throw new Error(body?.message ?? "Request failed");
  return body as T;
}

function Shell({
  role,
  email,
  view,
  children,
  onLogout,
  onViewChange,
}: {
  role: Role;
  email: string;
  view: DashboardView;
  children: React.ReactNode;
  onLogout: () => void;
  onViewChange: (view: DashboardView) => void;
}): React.JSX.Element {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img src={logo} alt="N" />
          <div>
            <strong>Next Tracking</strong>
            <span>{role === "ADMIN" ? "Next Tracking Admin" : "Next Tracking Employee"}</span>
          </div>
        </div>
        <nav>
          <button
            className={view === "overview" ? "nav-active" : ""}
            onClick={() => onViewChange("overview")}
          >
            <span className="nav-icon">◫</span> Overview
          </button>
          <button>
            <span className="nav-icon">◎</span>{" "}
            {role === "ADMIN" ? "Employees" : "Work logs"}
          </button>
          <button
            className={view === "screenshots" ? "nav-active" : ""}
            onClick={() => onViewChange("screenshots")}
          >
            <span className="nav-icon">▧</span> Screenshots
          </button>
        </nav>
        <div className="sidebar-user">
          <b>{email[0].toUpperCase()}</b>
          <span>{email}</span>
        </div>
        <button className="logout" onClick={onLogout}>
          Sign out
        </button>
      </aside>
      {children}
    </div>
  );
}

function ScreenshotModal({
  screenshot,
  onClose,
  onDelete,
  deleting,
}: {
  screenshot: Screenshot | null;
  onClose: () => void;
  onDelete?: (screenshot: Screenshot) => void;
  deleting?: boolean;
}): React.JSX.Element | null {
  if (!screenshot?.previewUrl) return null;

  return (
    <div className="modal-backdrop screenshot-backdrop" onClick={onClose}>
      <div className="screenshot-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Captured image</span>
            <h2>{new Date(screenshot.capturedAt).toLocaleString()}</h2>
          </div>
          <div className="modal-button-row">
            <a
              className="ghost-button"
              href={screenshot.previewUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open in new tab
            </a>
            <a
              className="ghost-button"
              download={`screenshot-${screenshot.capturedAt}.jpg`}
              href={screenshot.previewUrl}
            >
              Download
            </a>
            {onDelete && (
              <button
                className="ghost-button danger-button"
                disabled={deleting}
                onClick={() => onDelete(screenshot)}
                type="button"
              >
                {deleting ? "Deleting..." : "Delete screenshot"}
              </button>
            )}
            <button className="ghost-button" onClick={onClose} type="button">
              Close
            </button>
          </div>
        </div>
        <img
          alt={`Screenshot captured at ${new Date(screenshot.capturedAt).toLocaleTimeString()}`}
          src={screenshot.previewUrl}
        />
      </div>
    </div>
  );
}

function ScreenshotPanel({
  screenshots,
  emptyText,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
}: {
  screenshots: Screenshot[];
  emptyText: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (screenshot: Screenshot) => void;
}): React.JSX.Element {
  return (
    <>
      <div className="screenshots">
        {screenshots.map((screenshot) => (
          <button
            className="screenshot"
            key={screenshot.id}
            onClick={() => onOpen(screenshot)}
            type="button"
          >
            {screenshot.previewUrl ? (
              <img
                alt={`Screenshot captured at ${new Date(screenshot.capturedAt).toLocaleTimeString()}`}
                src={screenshot.previewUrl}
              />
            ) : (
              <span>Preview unavailable</span>
            )}
            <small>{new Date(screenshot.capturedAt).toLocaleTimeString()}</small>
          </button>
        ))}
        {!screenshots.length && (
          <div className="empty-activity">
            <span>▧</span>
            <strong>No screenshots yet</strong>
            <small>{emptyText}</small>
          </div>
        )}
      </div>
      {(hasMore || loadingMore) && (
        <div className="load-more-wrap">
          <button
            className="ghost-button"
            disabled={loadingMore}
            onClick={onLoadMore}
            type="button"
          >
            {loadingMore ? "Loading..." : "Load more screenshots"}
          </button>
        </div>
      )}
    </>
  );
}

function QuickDateFilters({
  selectedDate,
  onChange,
}: {
  selectedDate: string;
  onChange: (date: string) => void;
}): React.JSX.Element {
  const activeFilter = quickFilterForDate(selectedDate);

  return (
    <div className="quick-filters">
      <button
        className={activeFilter === "today" ? "quick-filter active" : "quick-filter"}
        onClick={() => onChange(localDate())}
        type="button"
      >
        Today
      </button>
      <button
        className={activeFilter === "yesterday" ? "quick-filter active" : "quick-filter"}
        onClick={() => onChange(daysAgo(1))}
        type="button"
      >
        Yesterday
      </button>
    </div>
  );
}

async function fetchScreenshotPage(
  path: string,
  before?: string | null,
): Promise<ScreenshotPage> {
  const search = new URLSearchParams();

  if (before) {
    search.set("before", before);
  }

  search.set("limit", "12");

  return apiRequest<ScreenshotPage>(`${path}${path.includes("?") ? "&" : "?"}${search.toString()}`);
}

function EmployeeDashboard({
  user,
  onLogout,
}: {
  user: CurrentUser;
  onLogout: () => void;
}): React.JSX.Element {
  const [view, setView] = useState<DashboardView>(() => readViewFromUrl());
  const [workDays, setWorkDays] = useState<WorkDay[]>([]);
  const [selectedDate, setSelectedDate] = useState(localDate);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [nextScreenshotCursor, setNextScreenshotCursor] = useState<string | null>(null);
  const [loadingMoreScreenshots, setLoadingMoreScreenshots] = useState(false);
  const [activeScreenshot, setActiveScreenshot] = useState<Screenshot | null>(null);
  const [deletingScreenshotId, setDeletingScreenshotId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadWorkDays(preferredDate?: string): Promise<void> {
    const rows = await apiRequest<WorkDay[]>(
      `/me/work-days?from=${daysAgo(29)}&to=${localDate()}`,
    );
    setWorkDays(rows);
    setSelectedDate(preferredDate ?? rows[0]?.workDate ?? localDate());
  }

  useEffect(() => {
    setLoading(true);
    void loadWorkDays()
      .catch((caught) =>
        setError(errorMessage(caught, "Unable to load your work logs.")),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void fetchScreenshotPage(`/me/screenshots?date=${selectedDate}`)
      .then((page) => {
        setScreenshots(page.items);
        setNextScreenshotCursor(page.nextCursor);
      })
      .catch(() => {
        setScreenshots([]);
        setNextScreenshotCursor(null);
      });
  }, [selectedDate]);

  useEffect(() => {
    writeViewToUrl(view);
  }, [view]);

  async function loadMoreScreenshots(): Promise<void> {
    if (!nextScreenshotCursor) return;

    setLoadingMoreScreenshots(true);

    try {
      const page = await fetchScreenshotPage(
        `/me/screenshots?date=${selectedDate}`,
        nextScreenshotCursor,
      );
      setScreenshots((current) => [...current, ...page.items]);
      setNextScreenshotCursor(page.nextCursor);
    } finally {
      setLoadingMoreScreenshots(false);
    }
  }

  async function deleteScreenshot(screenshot: Screenshot): Promise<void> {
    if (
      !window.confirm(
        "Delete this screenshot? It will also deduct 10 minutes from your tracked time for that day.",
      )
    ) {
      return;
    }

    setDeletingScreenshotId(screenshot.id);

    try {
      await apiRequest<void>(`/me/screenshots/${screenshot.id}`, {
        method: "DELETE",
      });
      setActiveScreenshot(null);
      await Promise.all([
        loadWorkDays(selectedDate),
        fetchScreenshotPage(`/me/screenshots?date=${selectedDate}`).then((page) => {
          setScreenshots(page.items);
          setNextScreenshotCursor(page.nextCursor);
        }),
      ]);
    } catch (caught) {
      setError(
        errorMessage(caught, "Unable to delete the screenshot right now."),
      );
    } finally {
      setDeletingScreenshotId(null);
    }
  }

  const totalSeconds = workDays.reduce((sum, day) => sum + day.totalSeconds, 0);
  const today = workDays.find((day) => day.workDate === localDate());
  const selectedDay = workDays.find((day) => day.workDate === selectedDate);

  return (
    <Shell
      email={user.email}
      onLogout={onLogout}
      onViewChange={setView}
      role="EMPLOYEE"
      view={view}
    >
      <main className="content">
        <header>
          <div>
            <span className="eyebrow">
              {view === "overview" ? "Personal overview" : "Captured activity"}
            </span>
            <h1>{view === "overview" ? "Your work activity" : "Your screenshots"}</h1>
            <p>
              {view === "overview"
                ? "Review your tracked time and captured activity."
                : "Open any screenshot to inspect it in full size."}
            </p>
          </div>
          <div className="profile-summary">
            <strong>{user.email}</strong>
            <span>{user.timezone}</span>
          </div>
        </header>

        {view === "overview" && (
          <section className="metrics">
            <article>
              <span>Today</span>
              <strong>{formatDuration(today?.totalSeconds ?? 0)}</strong>
              <small>
                {today?.isActive ? "Timer currently running" : "Timer stopped"}
              </small>
            </article>
            <article>
              <span>Last 30 days</span>
              <strong>{formatDuration(totalSeconds)}</strong>
              <small>Across {workDays.length} tracked days</small>
            </article>
            <article>
              <span>Screenshots</span>
              <strong>
                {workDays.reduce((sum, day) => sum + day.screenshotCount, 0)}
              </strong>
              <small>Captured during this period</small>
            </article>
          </section>
        )}

        {error && <p className="error">{error}</p>}

        {view === "overview" ? (
          <section className="single-panel-grid">
            <article className="panel team-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Recent history</span>
                  <h2>Work logs</h2>
                </div>
                {loading && <span className="loading">Refreshing...</span>}
              </div>
              <div className="table">
                <div className="table-row employee-log-row table-header">
                  <span>Date</span>
                  <span>Status</span>
                  <span>Screenshots</span>
                  <span>Tracked</span>
                </div>
                {workDays.map((day) => (
                  <button
                    className={`table-row employee-log-row ${selectedDate === day.workDate ? "selected" : ""}`}
                    key={day.id}
                    onClick={() => setSelectedDate(day.workDate)}
                  >
                    <strong>{friendlyDate(day.workDate)}</strong>
                    <span className={`status ${day.isActive ? "active" : ""}`}>
                      <i /> {day.isActive ? "Tracking" : "Complete"}
                    </span>
                    <span>{day.screenshotCount}</span>
                    <strong>{formatDuration(day.totalSeconds)}</strong>
                  </button>
                ))}
                {!workDays.length && <div className="empty">No work logs yet.</div>}
              </div>
            </article>
          </section>
        ) : (
          <section className="single-panel-grid">
            <article className="panel screenshot-page-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">{friendlyDate(selectedDate)}</span>
                  <h2>Screenshot gallery</h2>
                </div>
                <div className="panel-meta">
                  <QuickDateFilters
                    onChange={setSelectedDate}
                    selectedDate={selectedDate}
                  />
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(event) => setSelectedDate(event.target.value)}
                  />
                  <strong>{formatDuration(selectedDay?.totalSeconds ?? 0)}</strong>
                </div>
              </div>
              <ScreenshotPanel
                emptyText="No screenshots were captured for the selected day."
                hasMore={Boolean(nextScreenshotCursor)}
                loadingMore={loadingMoreScreenshots}
                onLoadMore={() => void loadMoreScreenshots()}
                onOpen={setActiveScreenshot}
                screenshots={screenshots}
              />
            </article>
          </section>
        )}
      </main>
      <ScreenshotModal
        onClose={() => setActiveScreenshot(null)}
        onDelete={deleteScreenshot}
        deleting={Boolean(
          activeScreenshot && deletingScreenshotId === activeScreenshot.id,
        )}
        screenshot={activeScreenshot}
      />
    </Shell>
  );
}

function AdminDashboard({
  user,
  onLogout,
}: {
  user: CurrentUser;
  onLogout: () => void;
}): React.JSX.Element {
  const [view, setView] = useState<DashboardView>(() => readViewFromUrl());
  const [date, setDate] = useState(localDate);
  const [users, setUsers] = useState<User[]>([]);
  const [timeRows, setTimeRows] = useState<TimeRow[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [nextScreenshotCursor, setNextScreenshotCursor] = useState<string | null>(null);
  const [loadingMoreScreenshots, setLoadingMoreScreenshots] = useState(false);
  const [activeScreenshot, setActiveScreenshot] = useState<Screenshot | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedRow = timeRows.find((row) => row.id === selectedUserId) ?? null;
  const totalTracked = useMemo(
    () => timeRows.reduce((total, row) => total + row.totalSeconds, 0),
    [timeRows],
  );

  async function loadDashboard(): Promise<void> {
    const [nextUsers, nextRows] = await Promise.all([
      apiRequest<User[]>("/admin/users"),
      apiRequest<TimeRow[]>(`/admin/time?date=${date}`),
    ]);
    setUsers(nextUsers);
    setTimeRows(nextRows);
    setSelectedUserId((current) => current ?? nextRows[0]?.id ?? null);
  }

  useEffect(() => {
    setLoading(true);
    void loadDashboard()
      .catch((caught) =>
        setError(errorMessage(caught, "Unable to load the dashboard.")),
      )
      .finally(() => setLoading(false));
  }, [date]);

  useEffect(() => {
    if (!selectedUserId) {
      setScreenshots([]);
      setNextScreenshotCursor(null);
      return;
    }

    void fetchScreenshotPage(`/admin/users/${selectedUserId}/screenshots?date=${date}`)
      .then((page) => {
        setScreenshots(page.items);
        setNextScreenshotCursor(page.nextCursor);
      })
      .catch(() => {
        setScreenshots([]);
        setNextScreenshotCursor(null);
      });
  }, [selectedUserId, date]);

  useEffect(() => {
    writeViewToUrl(view);
  }, [view]);

  async function loadMoreScreenshots(): Promise<void> {
    if (!selectedUserId || !nextScreenshotCursor) return;

    setLoadingMoreScreenshots(true);

    try {
      const page = await fetchScreenshotPage(
        `/admin/users/${selectedUserId}/screenshots?date=${date}`,
        nextScreenshotCursor,
      );
      setScreenshots((current) => [...current, ...page.items]);
      setNextScreenshotCursor(page.nextCursor);
    } finally {
      setLoadingMoreScreenshots(false);
    }
  }

  async function createEmployee(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setLoading(true);
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest<User>("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          timezone: form.get("timezone"),
        }),
      });
      setShowCreate(false);
      await loadDashboard();
    } catch (caught) {
      setError(errorMessage(caught, "Unable to create the employee."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell
      email={user.email}
      onLogout={onLogout}
      onViewChange={setView}
      role="ADMIN"
      view={view}
    >
      <main className="content">
        <header>
          <div>
            <span className="eyebrow">
              {view === "overview" ? "Team overview" : "Captured activity"}
            </span>
            <h1>{view === "overview" ? "Good day, Admin" : "Screenshot gallery"}</h1>
            <p>
              {view === "overview"
                ? "Here is how the team is doing."
                : "Browse captured screenshots and open them in full size."}
            </p>
          </div>
          <div className="header-actions">
            <input
              value={date}
              onChange={(event) => setDate(event.target.value)}
              type="date"
            />
            <button onClick={() => setShowCreate(true)}>+ Add employee</button>
          </div>
        </header>

        {view === "overview" && (
          <section className="metrics">
            <article>
              <span>Total employees</span>
              <strong>{timeRows.length}</strong>
              <small>
                {users.filter((item) => item.role === "ADMIN").length} admin
                account
              </small>
            </article>
            <article>
              <span>Tracking now</span>
              <strong>{timeRows.filter((row) => row.isActive).length}</strong>
              <small>Currently active timers</small>
            </article>
            <article>
              <span>Total time</span>
              <strong>{formatDuration(totalTracked)}</strong>
              <small>Across the selected day</small>
            </article>
          </section>
        )}
        {error && <p className="error">{error}</p>}

        {view === "overview" ? (
          <section className="single-panel-grid">
            <article className="panel team-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Daily activity</span>
                  <h2>Employee time</h2>
                </div>
                {loading && <span className="loading">Refreshing...</span>}
              </div>
              <div className="table">
                <div className="table-row table-header">
                  <span>Employee</span>
                  <span>Status</span>
                  <span>Tracked</span>
                </div>
                {timeRows.map((row) => (
                  <button
                    className={`table-row ${row.id === selectedUserId ? "selected" : ""}`}
                    key={row.id}
                    onClick={() => setSelectedUserId(row.id)}
                  >
                    <span className="employee">
                      <b>{row.email[0].toUpperCase()}</b>
                      <span>
                        <strong>{row.email}</strong>
                        <small>{row.timezone}</small>
                      </span>
                    </span>
                    <span className={`status ${row.isActive ? "active" : ""}`}>
                      <i /> {row.isActive ? "Tracking" : "Stopped"}
                    </span>
                    <strong>{formatDuration(row.totalSeconds)}</strong>
                  </button>
                ))}
                {!timeRows.length && <div className="empty">No employees yet.</div>}
              </div>
            </article>
          </section>
        ) : (
          <section className="dashboard-grid screenshot-page-grid">
            <article className="panel team-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Select employee</span>
                  <h2>Employees</h2>
                </div>
              </div>
              <div className="table">
                <div className="table-row table-header">
                  <span>Employee</span>
                  <span>Status</span>
                  <span>Tracked</span>
                </div>
                {timeRows.map((row) => (
                  <button
                    className={`table-row ${row.id === selectedUserId ? "selected" : ""}`}
                    key={row.id}
                    onClick={() => setSelectedUserId(row.id)}
                  >
                    <span className="employee">
                      <b>{row.email[0].toUpperCase()}</b>
                      <span>
                        <strong>{row.email}</strong>
                        <small>{row.timezone}</small>
                      </span>
                    </span>
                    <span className={`status ${row.isActive ? "active" : ""}`}>
                      <i /> {row.isActive ? "Tracking" : "Stopped"}
                    </span>
                    <strong>{formatDuration(row.totalSeconds)}</strong>
                  </button>
                ))}
              </div>
            </article>
            <article className="panel screenshot-page-panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Activity detail</span>
                  <h2>Screenshots</h2>
                </div>
                {selectedRow ? (
                  <div className="panel-meta">
                    <QuickDateFilters onChange={setDate} selectedDate={date} />
                    <strong>{selectedRow.email}</strong>
                    <span>{formatDuration(selectedRow.totalSeconds)} tracked</span>
                  </div>
                ) : null}
              </div>
              {selectedRow ? (
                <>
                  <div className="selected-user">
                    <b>{selectedRow.email[0].toUpperCase()}</b>
                    <div>
                      <strong>{selectedRow.email}</strong>
                      <span>{friendlyDate(date)}</span>
                    </div>
                  </div>
                  <ScreenshotPanel
                    emptyText="No screenshots were captured for this employee on the selected day."
                    hasMore={Boolean(nextScreenshotCursor)}
                    loadingMore={loadingMoreScreenshots}
                    onLoadMore={() => void loadMoreScreenshots()}
                    onOpen={setActiveScreenshot}
                    screenshots={screenshots}
                  />
                </>
              ) : (
                <div className="empty-activity">
                  Select an employee to view screenshots.
                </div>
              )}
            </article>
          </section>
        )}
      </main>
      <ScreenshotModal
        onClose={() => setActiveScreenshot(null)}
        screenshot={activeScreenshot}
      />

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <form
            className="modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void createEmployee(event)}
          >
            <div>
              <span className="eyebrow">New account</span>
              <h2>Add employee</h2>
            </div>
            <label>
              Email
              <input name="email" required type="email" />
            </label>
            <label>
              Temporary password
              <input minLength={8} name="password" required type="password" />
            </label>
            <label>
              Timezone
              <input defaultValue="Asia/Karachi" name="timezone" required />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button disabled={loading} type="submit">
                {loading ? "Creating..." : "Create employee"}
              </button>
            </div>
          </form>
        </div>
      )}
    </Shell>
  );
}

function App(): React.JSX.Element {
  const [session, setSession] = useState<AuthResponse | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [email, setEmail] = useState("employee@example.com");
  const [password, setPassword] = useState("password123");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void refreshAccessToken()
      .then(setSession)
      .finally(() => setRestoring(false));
    const expire = (): void => setSession(null);
    window.addEventListener("auth-expired", expire);
    return () => window.removeEventListener("auth-expired", expire);
  }, []);

  async function login(event: FormEvent): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, client: "web" }),
      });
      const body = (await response.json()) as AuthResponse & {
        message?: string;
      };
      if (!response.ok) throw new Error(body.message ?? "Unable to sign in");
      accessToken = body.accessToken;
      setSession(body);
    } catch (caught) {
      setError(errorMessage(caught, "Unable to sign in. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  async function logout(): Promise<void> {
    await fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "web" }),
    }).catch(() => undefined);
    accessToken = "";
    setSession(null);
  }

  if (restoring) {
    return (
      <main className="login-page">
        <section className="login-card">
          <img src={logo} alt="N" />
          <span className="eyebrow">Restoring session</span>
          <h1>Welcome back</h1>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="login-page">
        <section className="login-card">
          <img src={logo} alt="N" />
          <span className="eyebrow">Time tracking portal</span>
          <h1>Welcome back</h1>
          <p>Sign in to review time and activity.</p>
          <form onSubmit={(event) => void login(event)}>
            <label>
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
              />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
              />
            </label>
            <button disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return session.role === "ADMIN" ? (
    <AdminDashboard onLogout={() => void logout()} user={session.user} />
  ) : (
    <EmployeeDashboard onLogout={() => void logout()} user={session.user} />
  );
}

export default App;
