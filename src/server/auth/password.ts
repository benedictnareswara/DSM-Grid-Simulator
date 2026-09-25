import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

// bcrypt only reads the first 72 bytes. Rejecting longer passwords up front keeps
// two passwords that share those 72 bytes from both working.
export const MAX_PASSWORD_BYTES = 72;

export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error("Password must be at most 72 bytes.");
  }
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** False on any malformed input: a bad hash or an over-long password is a failed login, not a 500. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}
