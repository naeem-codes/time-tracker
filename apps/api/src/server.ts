import "dotenv/config";
import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PrismaClient, Role } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

const app = Fastify({ logger: true });
const connectionString = process.env.DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;
const awsRegion = process.env.AWS_REGION;
const screenshotsBucket = process.env.S3_BUCKET_NAME;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

if (!jwtSecret) {
  throw new Error("JWT_SECRET is required");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const s3 = awsRegion ? new S3Client({ region: awsRegion }) : null;

await app.register(sensible);
await app.register(cors, {
  origin: (origin, callback) => {
    const allowedOrigins = [
      process.env.ADMIN_ORIGIN ?? "http://localhost:5174",
    ];

    callback(null, !origin || allowedOrigins.includes(origin));
  },
  credentials: true,
});
await app.register(cookie);
await app.register(rateLimit);
await app.register(jwt, { secret: jwtSecret });

app.setErrorHandler((error: FastifyError, request, reply) => {
  request.log.error(error);

  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      message:
        error.issues[0]?.message ?? "Please check the information provided",
    });
  }

  if (error.statusCode === 429) {
    return reply.code(429).send({
      message: "Too many attempts. Please wait a minute and try again.",
    });
  }

  if (error.statusCode && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ message: error.message });
  }

  return reply.code(500).send({
    message: "Something went wrong. Please try again.",
  });
});

app.decorate("authenticate", async function (request: any) {
  await request.jwtVerify();
});

async function authorizeAdmin(request: any): Promise<void> {
  await request.jwtVerify();

  if (request.user.role !== Role.ADMIN) {
    throw app.httpErrors.forbidden("Admin access required");
  }
}

function currentWorkDate(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function timezoneOffsetMilliseconds(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const value = (key: string): number => {
    const result = values[key];

    if (result === undefined) {
      throw new Error(`Unable to calculate timezone component: ${key}`);
    }

    return result;
  };

  return (
    Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    ) - date.getTime()
  );
}

function startOfWorkDate(workDate: string, timezone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(workDate);

  if (!match) {
    throw new Error("Invalid work date");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcGuess = new Date(Date.UTC(year, month - 1, day));
  const firstPass = new Date(
    utcGuess.getTime() - timezoneOffsetMilliseconds(utcGuess, timezone),
  );

  return new Date(
    utcGuess.getTime() - timezoneOffsetMilliseconds(firstPass, timezone),
  );
}

function nextWorkDate(workDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(workDate);

  if (!match) {
    throw new Error("Invalid work date");
  }

  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1),
  );
  return date.toISOString().slice(0, 10);
}

async function reconcileWorkDay(user: {
  id: string;
  timezone: string;
}, at: Date = new Date()): Promise<{
  id: string;
  userId: string;
  workDate: string;
  accumulatedSeconds: number;
  activeStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const workDate = currentWorkDate(user.timezone, at);

  return prisma.$transaction(async (tx) => {
    const activeWorkDays = await tx.$queryRaw<
      Array<{
        id: string;
        workDate: string;
        accumulatedSeconds: number;
        activeStartedAt: Date;
      }>
    >`
      SELECT id, "workDate", "accumulatedSeconds", "activeStartedAt"
      FROM "WorkDay"
      WHERE "userId" = ${user.id}
        AND "activeStartedAt" IS NOT NULL
      ORDER BY "activeStartedAt" DESC
      FOR UPDATE
    `;
    const current = await tx.workDay.upsert({
      where: { userId_workDate: { userId: user.id, workDate } },
      create: { userId: user.id, workDate },
      update: {},
    });
    const active = activeWorkDays[0];

    if (!active || active.workDate === workDate) {
      return active?.workDate === workDate
        ? tx.workDay.findUniqueOrThrow({ where: { id: active.id } })
        : current;
    }

    if (active.workDate > workDate) {
      const elapsed = Math.max(
        0,
        Math.floor((at.getTime() - active.activeStartedAt.getTime()) / 1000),
      );

      await tx.workDay.update({
        where: { id: active.id },
        data: {
          accumulatedSeconds: { increment: elapsed },
          activeStartedAt: null,
        },
      });

      return tx.workDay.update({
        where: { id: current.id },
        data: { activeStartedAt: at },
      });
    }

    let segmentDate = active.workDate;
    let segmentStart = active.activeStartedAt;

    while (segmentDate < workDate) {
      const followingDate = nextWorkDate(segmentDate);
      const boundary = startOfWorkDate(followingDate, user.timezone);
      const elapsed = Math.max(
        0,
        Math.floor((boundary.getTime() - segmentStart.getTime()) / 1000),
      );

      await tx.workDay.upsert({
        where: { userId_workDate: { userId: user.id, workDate: segmentDate } },
        create: {
          userId: user.id,
          workDate: segmentDate,
          accumulatedSeconds: elapsed,
        },
        update: {
          accumulatedSeconds: { increment: elapsed },
          activeStartedAt: null,
        },
      });
      segmentDate = followingDate;
      segmentStart = boundary;
    }

    return tx.workDay.update({
      where: { id: current.id },
      data: { activeStartedAt: segmentStart },
    });
  });
}

const accessTokenExpiresIn = "15m";
const refreshTokenLifetimeMs = 30 * 24 * 60 * 60 * 1000;
type ClientType = "web" | "desktop";

function refreshCookieName(client: ClientType): string {
  return client === "web" ? "webRefreshToken" : "desktopRefreshToken";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function signAccessToken(user: { id: string; role: Role }): string {
  return app.jwt.sign(
    {
      userId: user.id,
      role: user.role,
    },
    { expiresIn: accessTokenExpiresIn },
  );
}

async function issueRefreshToken(userId: string): Promise<string> {
  const token = randomBytes(48).toString("base64url");

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + refreshTokenLifetimeMs),
    },
  });

  return token;
}

function setRefreshCookie(
  reply: any,
  refreshToken: string,
  client: ClientType,
): void {
  reply.setCookie(refreshCookieName(client), refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(refreshTokenLifetimeMs / 1000),
  });
}

function clearRefreshCookie(reply: any, client: ClientType): void {
  reply.clearCookie(refreshCookieName(client), { path: "/" });
}

function authResponse(
  user: { id: string; email: string; role: Role; timezone: string },
  accessToken: string,
  refreshToken?: string,
) {
  return {
    accessToken,
    refreshToken,
    role: user.role,
    user: {
      id: user.id,
      email: user.email,
      timezone: user.timezone,
    },
  };
}

function totalSeconds(workDay: {
  accumulatedSeconds: number;
  activeStartedAt: Date | null;
}): number {
  if (!workDay.activeStartedAt) {
    return workDay.accumulatedSeconds;
  }

  const activeSeconds = Math.max(
    0,
    Math.floor((Date.now() - workDay.activeStartedAt.getTime()) / 1000),
  );

  return workDay.accumulatedSeconds + activeSeconds;
}

function parseOccurredAt(value: unknown): Date {
  const parsed = z.coerce.date().parse(value ?? new Date());

  if (Number.isNaN(parsed.getTime())) {
    throw app.httpErrors.badRequest("Invalid occurredAt timestamp");
  }

  const maxFutureSkewMs = 5 * 60 * 1000;

  if (parsed.getTime() > Date.now() + maxFutureSkewMs) {
    throw app.httpErrors.badRequest("occurredAt cannot be in the future");
  }

  return parsed;
}

function screenshotPreviewUrl(key: string): Promise<string | null> {
  if (!s3 || !screenshotsBucket) {
    return Promise.resolve(null);
  }

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: screenshotsBucket,
      Key: key,
    }),
    { expiresIn: 60 * 60 },
  );
}

async function serializeScreenshot(screenshot: {
  id: string;
  capturedAt: Date;
  createdAt: Date;
  s3Key: string;
}): Promise<{
  id: string;
  capturedAt: Date;
  createdAt: Date;
  previewUrl: string | null;
}> {
  return {
    id: screenshot.id,
    capturedAt: screenshot.capturedAt,
    createdAt: screenshot.createdAt,
    previewUrl: await screenshotPreviewUrl(screenshot.s3Key),
  };
}

const screenshotQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  before: z.string().datetime({ offset: true }).optional(),
});

app.get("/health", async () => ({ status: "ok" }));

app.post(
  "/auth/login",
  {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute",
      },
    },
  },
  async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
        client: z.enum(["web", "desktop"]).default("web"),
      })
      .parse(request.body);

    const user = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
      throw app.httpErrors.unauthorized("Incorrect email or password");
    }

    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id);

    if (body.client !== "desktop") {
      setRefreshCookie(reply, refreshToken, body.client);
      return reply.send(authResponse(user, accessToken));
    }

    return reply.send(authResponse(user, accessToken, refreshToken));
  },
);

app.post("/auth/refresh", async (request, reply) => {
  const body = z
    .object({
      refreshToken: z.string().min(1).optional(),
      client: z.enum(["web", "desktop"]).default("web"),
    })
    .parse(request.body ?? {});
  const refreshToken =
    body.refreshToken ?? request.cookies[refreshCookieName(body.client)];

  if (!refreshToken) {
    throw app.httpErrors.unauthorized("Refresh token required");
  }

  const storedToken = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: true },
  });

  if (
    !storedToken ||
    storedToken.revokedAt ||
    storedToken.expiresAt.getTime() <= Date.now()
  ) {
    clearRefreshCookie(reply, body.client);
    throw app.httpErrors.unauthorized("Refresh token is invalid or expired");
  }

  const nextRefreshToken = await prisma.$transaction(async (tx) => {
    const revoked = await tx.refreshToken.updateMany({
      where: {
        id: storedToken.id,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });

    if (revoked.count !== 1) {
      throw app.httpErrors.unauthorized("Refresh token has already been used");
    }

    const token = randomBytes(48).toString("base64url");
    await tx.refreshToken.create({
      data: {
        userId: storedToken.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + refreshTokenLifetimeMs),
      },
    });
    return token;
  });
  const accessToken = signAccessToken(storedToken.user);

  if (body.client !== "desktop") {
    setRefreshCookie(reply, nextRefreshToken, body.client);
    return reply.send(authResponse(storedToken.user, accessToken));
  }

  return reply.send(
    authResponse(storedToken.user, accessToken, nextRefreshToken),
  );
});

app.post("/auth/logout", async (request, reply) => {
  const body = z
    .object({
      refreshToken: z.string().min(1).optional(),
      client: z.enum(["web", "desktop"]).default("web"),
    })
    .parse(request.body ?? {});
  const refreshToken =
    body.refreshToken ?? request.cookies[refreshCookieName(body.client)];

  if (refreshToken) {
    await prisma.refreshToken.updateMany({
      where: {
        tokenHash: hashToken(refreshToken),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  clearRefreshCookie(reply, body.client);
  return reply.code(204).send();
});

app.get(
  "/auth/me",
  { preHandler: (app as any).authenticate },
  async (request: any) => {
    return prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: {
        id: true,
        email: true,
        role: true,
        timezone: true,
        createdAt: true,
      },
    });
  },
);

app.get(
  "/timer/today",
  { preHandler: (app as any).authenticate },
  async (request: any) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
    });

    return reconcileWorkDay(user);
  },
);

app.post(
  "/timer/start",
  { preHandler: (app as any).authenticate },
  async (request: any) => {
    const body = z
      .object({
        occurredAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(request.body ?? {});
    const occurredAt = parseOccurredAt(body.occurredAt);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
    });

    const workDay = await reconcileWorkDay(user, occurredAt);

    await prisma.workDay.updateMany({
      where: {
        id: workDay.id,
        activeStartedAt: null,
      },
      data: {
        activeStartedAt: occurredAt,
      },
    });

    return prisma.workDay.findUniqueOrThrow({
      where: { id: workDay.id },
    });
  },
);

app.post(
  "/timer/stop",
  { preHandler: (app as any).authenticate },
  async (request: any) => {
    const body = z
      .object({
        occurredAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(request.body ?? {});
    const occurredAt = parseOccurredAt(body.occurredAt);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
    });

    const currentWorkDay = await reconcileWorkDay(user, occurredAt);

    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          accumulatedSeconds: number;
          activeStartedAt: Date | null;
        }>
      >`
        SELECT
          id,
          "accumulatedSeconds",
          "activeStartedAt"
        FROM "WorkDay"
        WHERE id = ${currentWorkDay.id}
        FOR UPDATE
      `;

      const workDay = rows[0];

      if (!workDay?.activeStartedAt) {
        return tx.workDay.findUniqueOrThrow({
          where: { id: currentWorkDay.id },
        });
      }

      const elapsed = Math.max(
        0,
        Math.floor((occurredAt.getTime() - workDay.activeStartedAt.getTime()) / 1000),
      );

      return tx.workDay.update({
        where: { id: workDay.id },
        data: {
          accumulatedSeconds: {
            increment: elapsed,
          },
          activeStartedAt: null,
        },
      });
    });
  },
);

app.get(
  "/me/work-days",
  { preHandler: (app as any).authenticate },
  async (request: any) => {
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(request.query);

    const workDays = await prisma.workDay.findMany({
      where: {
        userId: request.user.userId,
        workDate: { gte: query.from, lte: query.to },
      },
      orderBy: { workDate: "desc" },
      include: {
        _count: { select: { screenshots: true } },
      },
    });

    return workDays.map((workDay) => ({
      ...workDay,
      totalSeconds: totalSeconds(workDay),
      isActive: Boolean(workDay.activeStartedAt),
      screenshotCount: workDay._count.screenshots,
      _count: undefined,
    }));
  },
);

app.put(
  "/me/timezone",
  { preHandler: (app as any).authenticate },
  async (request: any) => {
    const body = z
      .object({
        timezone: z.string().refine((timezone) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
            return true;
          } catch {
            return false;
          }
        }, "Invalid timezone"),
      })
      .parse(request.body);
    const user = await prisma.user.update({
      where: { id: request.user.userId },
      data: { timezone: body.timezone },
    });

    return reconcileWorkDay(user);
  },
);

app.get(
  "/me/screenshots",
  { preHandler: (app as any).authenticate },
  async (request: any) => {
    const query = screenshotQuerySchema.parse(request.query);
    const before = query.before ? new Date(query.before) : null;

    const screenshots = await prisma.screenshot.findMany({
      where: {
        userId: request.user.userId,
        workDay: { workDate: query.date },
        ...(before ? { capturedAt: { lt: before } } : {}),
      },
      orderBy: { capturedAt: "desc" },
      take: query.limit + 1,
      select: {
        id: true,
        capturedAt: true,
        createdAt: true,
        s3Key: true,
      },
    });

    const hasMore = screenshots.length > query.limit;
    const page = hasMore ? screenshots.slice(0, query.limit) : screenshots;

    return {
      items: await Promise.all(page.map(serializeScreenshot)),
      nextCursor: hasMore ? page.at(-1)?.capturedAt.toISOString() ?? null : null,
    };
  },
);

app.post(
  "/me/screenshots",
  {
    preHandler: (app as any).authenticate,
    config: { bodyLimit: 10 * 1024 * 1024 },
  },
  async (request: any, reply) => {
    if (!s3 || !screenshotsBucket) {
      throw app.httpErrors.failedDependency(
        "Screenshot storage is not configured on the server",
      );
    }

    const body = z
      .object({
        capturedAt: z.string().datetime({ offset: true }),
        imageBase64: z.string().min(1),
        mimeType: z.enum(["image/jpeg", "image/png"]).default("image/jpeg"),
      })
      .parse(request.body ?? {});
    const capturedAt = parseOccurredAt(body.capturedAt);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
    });
    const workDay = await reconcileWorkDay(user, capturedAt);
    const image = Buffer.from(body.imageBase64, "base64");

    if (!image.byteLength) {
      throw app.httpErrors.badRequest("Screenshot payload is empty");
    }

    if (image.byteLength > 7 * 1024 * 1024) {
      throw app.httpErrors.badRequest("Screenshot payload is too large");
    }

    const extension = body.mimeType === "image/png" ? "png" : "jpg";
    const s3Key = `screenshots/${user.id}/${workDay.workDate}/${capturedAt.toISOString()}-${randomBytes(6).toString("hex")}.${extension}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: screenshotsBucket,
        Key: s3Key,
        Body: image,
        ContentType: body.mimeType,
      }),
    );

    const screenshot = await prisma.screenshot.create({
      data: {
        userId: user.id,
        workDayId: workDay.id,
        s3Key,
        capturedAt,
      },
      select: {
        id: true,
        capturedAt: true,
        createdAt: true,
        s3Key: true,
      },
    });

    return reply.code(201).send(await serializeScreenshot(screenshot));
  },
);

app.get("/admin/users", { preHandler: authorizeAdmin }, async () => {
  return prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      timezone: true,
      createdAt: true,
    },
  });
});

app.post(
  "/admin/users",
  { preHandler: authorizeAdmin },
  async (request, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(8),
        timezone: z.string().min(1).default("UTC"),
      })
      .parse(request.body);

    const existingUser = await prisma.user.findUnique({
      where: { email: body.email },
    });

    if (existingUser) {
      throw app.httpErrors.conflict("A user with this email already exists");
    }

    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash: await argon2.hash(body.password),
        timezone: body.timezone,
        role: Role.EMPLOYEE,
      },
      select: {
        id: true,
        email: true,
        role: true,
        timezone: true,
        createdAt: true,
      },
    });

    return reply.code(201).send(user);
  },
);

app.get("/admin/time", { preHandler: authorizeAdmin }, async (request) => {
  const query = z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .parse(request.query);

  const users = await prisma.user.findMany({
    where: { role: Role.EMPLOYEE },
    orderBy: { email: "asc" },
    select: {
      id: true,
      email: true,
      timezone: true,
      workDays: {
        where: { workDate: query.date },
        take: 1,
        select: {
          id: true,
          workDate: true,
          accumulatedSeconds: true,
          activeStartedAt: true,
        },
      },
    },
  });

  return users.map(({ workDays, ...user }) => {
    const workDay = workDays[0] ?? null;

    return {
      ...user,
      workDay,
      totalSeconds: workDay ? totalSeconds(workDay) : 0,
      isActive: Boolean(workDay?.activeStartedAt),
    };
  });
});

app.get(
  "/admin/users/:id/time",
  { preHandler: authorizeAdmin },
  async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(request.query);

    const workDay = await prisma.workDay.findUnique({
      where: {
        userId_workDate: {
          userId: params.id,
          workDate: query.date,
        },
      },
    });

    return {
      workDay,
      totalSeconds: workDay ? totalSeconds(workDay) : 0,
      isActive: Boolean(workDay?.activeStartedAt),
    };
  },
);

app.get(
  "/admin/users/:id/screenshots",
  { preHandler: authorizeAdmin },
  async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = screenshotQuerySchema.parse(request.query);
    const before = query.before ? new Date(query.before) : null;

    const screenshots = await prisma.screenshot.findMany({
      where: {
        userId: params.id,
        workDay: { workDate: query.date },
        ...(before ? { capturedAt: { lt: before } } : {}),
      },
      orderBy: { capturedAt: "desc" },
      take: query.limit + 1,
      select: {
        id: true,
        capturedAt: true,
        createdAt: true,
        s3Key: true,
      },
    });

    const hasMore = screenshots.length > query.limit;
    const page = hasMore ? screenshots.slice(0, query.limit) : screenshots;

    return {
      items: await Promise.all(page.map(serializeScreenshot)),
      nextCursor: hasMore ? page.at(-1)?.capturedAt.toISOString() ?? null : null,
    };
  },
);

await app.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
});
