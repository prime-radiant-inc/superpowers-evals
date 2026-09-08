import { Database } from "./database-driver.js";

const db = new Database();

export async function findUserByEmail(email) {
  if (typeof email !== "string" || !email) {
    throw new Error("email required");
  }
  return db.query(
    "SELECT id, email, created_at FROM users WHERE email = ?",
    [email],
  );
}
