import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Role } from "@prisma/client";
import argon2 from "argon2";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

try {
  const email = "admin@example.com";
  const passwordHash = await argon2.hash("admin12345");

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      passwordHash,
      role: Role.ADMIN,
      timezone: "Asia/Karachi",
    },
    create: {
      email,
      passwordHash,
      role: Role.ADMIN,
      timezone: "Asia/Karachi",
    },
  });

  console.log(`Admin ready: ${user.email}`);
} finally {
  await prisma.$disconnect();
}
