import "dotenv/config";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;
const awsRegion = process.env.AWS_REGION;
const screenshotsBucket = process.env.S3_BUCKET_NAME;
const retentionDays = Number(process.env.SCREENSHOT_RETENTION_DAYS ?? "30");

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

if (!awsRegion) {
  throw new Error("AWS_REGION is required");
}

if (!screenshotsBucket) {
  throw new Error("S3_BUCKET_NAME is required");
}

if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
  throw new Error("SCREENSHOT_RETENTION_DAYS must be a positive number");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const s3 = new S3Client({ region: awsRegion });

const batchSize = 100;
const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

async function cleanupBatch(): Promise<number> {
  const screenshots = await prisma.screenshot.findMany({
    where: {
      capturedAt: { lt: cutoff },
    },
    orderBy: { capturedAt: "asc" },
    take: batchSize,
    select: {
      id: true,
      s3Key: true,
      capturedAt: true,
    },
  });

  if (!screenshots.length) {
    return 0;
  }

  const response = await s3.send(
    new DeleteObjectsCommand({
      Bucket: screenshotsBucket,
      Delete: {
        Objects: screenshots.map((screenshot) => ({ Key: screenshot.s3Key })),
        Quiet: false,
      },
    }),
  );
  const deletedKeys = new Set(
    (response.Deleted ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => Boolean(key)),
  );

  if (response.Errors?.length) {
    for (const error of response.Errors) {
      console.error(
        `Failed to delete S3 object ${error.Key ?? "<unknown>"}: ${error.Code ?? "Unknown"} ${error.Message ?? ""}`.trim(),
      );
    }
  }

  const deletedScreenshots = screenshots.filter((screenshot) =>
    deletedKeys.has(screenshot.s3Key),
  );

  if (!deletedScreenshots.length) {
    console.warn(
      `No screenshots were removed from S3 for the current batch ending at ${screenshots.at(-1)?.capturedAt.toISOString()}.`,
    );
    return 0;
  }

  await prisma.screenshot.deleteMany({
    where: {
      id: {
        in: deletedScreenshots.map((screenshot) => screenshot.id),
      },
    },
  });

  const failedCount = screenshots.length - deletedScreenshots.length;

  if (failedCount > 0) {
    console.warn(
      `Skipped deleting ${failedCount} screenshot records because their S3 objects were not removed.`,
    );
  }

  return deletedScreenshots.length;
}

let deletedCount = 0;

try {
  while (true) {
    const removed = await cleanupBatch();

    if (removed === 0) {
      break;
    }

    deletedCount += removed;
  }

  console.log(
    `Screenshot cleanup complete. Removed ${deletedCount} screenshots older than ${cutoff.toISOString()}.`,
  );
} finally {
  await prisma.$disconnect();
}
