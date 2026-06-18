import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import argon2 from "argon2";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error("DATABASE_URL is required");
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
try {
    const passwordHash = await argon2.hash("password123");
    const user = await prisma.user.upsert({
        where: {
            email: "employee@example.com",
        },
        update: {
            passwordHash,
            timezone: "Asia/Karachi",
        },
        create: {
            email: "employee@example.com",
            passwordHash,
            timezone: "Asia/Karachi",
        },
    });
    console.log(`User ready: ${user.email}`);
}
finally {
    await prisma.$disconnect();
}
//# sourceMappingURL=create-user.js.map