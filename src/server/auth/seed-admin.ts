import { eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { ROLE_ADMIN, STATUS_ACTIVE, users } from "../db/schema";
import { env } from "../env";
import { hashPassword } from "./password";

/**
 * Create the admin account if, and only if, none exists. Deliberately not an
 * upsert: changing ADMIN_PASSWORD in .env later must not reset a password the
 * operator has since changed in the app.
 */
export async function seedAdmin(db: DB): Promise<void> {
  const existing = db.select().from(users).where(eq(users.role, ROLE_ADMIN)).get();
  if (existing) {
    console.log(`[DB] Admin account present: ${existing.username}`);
    return;
  }
  const { ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_EMAIL } = env();
  if (!ADMIN_PASSWORD) {
    throw new Error(
      "No admin account exists and ADMIN_PASSWORD is empty. Run `npm run setup` (it generates one), " +
        "or set ADMIN_PASSWORD in .env. There is no default: a default admin password is a backdoor.",
    );
  }
  const username = ADMIN_USERNAME.trim().toLowerCase();
  db.insert(users)
    .values({
      username,
      email: ADMIN_EMAIL.trim().toLowerCase(),
      passwordHash: await hashPassword(ADMIN_PASSWORD),
      role: ROLE_ADMIN,
      status: STATUS_ACTIVE,
    })
    .run();
  console.log(`[DB] Seeded admin account: ${username}`);
}
