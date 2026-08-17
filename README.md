# Next Tracking

Next Tracking is a time-tracking MVP with:

- an Electron desktop app for employees
- a React web portal for admins and employees
- a Fastify + Prisma API with PostgreSQL

## What it does

- start and stop daily time tracking from the desktop app
- continue the same day's timer instead of splitting time into separate sessions
- handle timezone-aware day boundaries
- stop tracking automatically after 5 minutes of inactivity
- queue timer actions locally when offline and sync them later
- capture screenshots every 10 minutes while tracking
- let admins review employee time and screenshots
- let employees review and delete screenshots with a 10-minute time deduction
- invite employees by email

## Stack

- Backend: Fastify, Prisma, PostgreSQL
- Web: React, Vite, TypeScript
- Desktop: Electron, React, better-sqlite3
- Infra: AWS EC2, RDS, S3, PM2, nginx, GitHub Actions

## Repo structure

```text
apps/
  api/
  admin/
  desktop/
```

## Local setup

### Prerequisites

- Node.js 22+
- pnpm 11
- Docker

### Install dependencies

```bash
pnpm install
```

If native builds are blocked:

```bash
pnpm approve-builds
```

### Start PostgreSQL

```bash
docker compose up -d
```

Postgres runs on `localhost:5433`.

### API env

Create `apps/api/.env`:

```env
DATABASE_URL=postgresql://tracker:tracker@localhost:5433/tracker
JWT_SECRET=replace-this
ADMIN_ORIGIN=http://localhost:5174
AWS_REGION=eu-north-1
S3_BUCKET_NAME=your-screenshots-bucket
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=yourgmail@gmail.com
SMTP_PASS=your_app_password
MAIL_FROM=yourgmail@gmail.com
INVITE_BASE_URL=http://localhost:5174
SCREENSHOT_RETENTION_DAYS=30
```

### Prisma

```bash
cd apps/api
pnpm exec prisma migrate dev
pnpm exec prisma generate
```

### Seed demo users

```bash
cd apps/api
pnpm exec tsx src/create-admin.ts
pnpm exec tsx src/create-user.ts
```

### Run locally

From the repo root:

```bash
pnpm dev:api
pnpm dev:admin
pnpm dev:desktop
```

Defaults:

- API: `http://localhost:3000`
- Web: `http://localhost:5174`

## Environment variables

### API

Required:

- `DATABASE_URL`
- `JWT_SECRET`

Common:

- `ADMIN_ORIGIN`
- `AWS_REGION`
- `S3_BUCKET_NAME`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
- `INVITE_BASE_URL`
- `SCREENSHOT_RETENTION_DAYS`

### Web

- `VITE_API_URL`
  defaults to `http://localhost:3000`

### Desktop

- `MAIN_VITE_API_URL`
  defaults to `http://localhost:3000`

## Desktop builds

```bash
pnpm --filter nexttracking-desktop build:win
pnpm --filter nexttracking-desktop build:mac
pnpm --filter nexttracking-desktop build:linux
```

## Deployment

Production uses:

- EC2 for app hosting
- RDS for PostgreSQL
- S3 for screenshots
- PM2 for the API
- nginx for the web app and reverse proxy

Important files:

- [ecosystem.config.cjs](./ecosystem.config.cjs)
- [.github/workflows/deploy.yml](./.github/workflows/deploy.yml)

GitHub Actions deploy requires these secrets:

- `EC2_HOST`
- `EC2_USER`
- `EC2_SSH_KEY`
- `EC2_PORT` if not `22`

RDS TLS is configured through:

```text
NODE_EXTRA_CA_CERTS=/etc/next-tracking/rds-ca.pem
```

## Screenshot cleanup

```bash
cd apps/api
pnpm run cleanup:screenshots
```
