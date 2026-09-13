import { PrismaClient, Role } from "@prisma/client";
import { hash } from "argon2";

const email = (process.env.ADMIN_EMAIL || "admin@wings.rw").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required");
if (!password || password.length < 10)
  throw new Error("ADMIN_PASSWORD must contain at least 10 characters");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  throw new Error("ADMIN_EMAIL must be a valid email");

const db = new PrismaClient();

async function main() {
  const passwordHash = await hash(password);
  const user = await db.user.upsert({
    where: { email },
    update: {
      role: Role.ADMIN,
      active: true,
      passwordHash,
      passwordChangedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
      sessionVersion: { increment: 1 },
    },
    create: {
      email,
      name: "System Administrator",
      role: Role.ADMIN,
      passwordHash,
    },
  });
  await db.session.deleteMany({ where: { userId: user.id } });
  console.log(`Admin account is ready: ${email}`);
}

main().finally(() => db.$disconnect());
