import { Database } from "./database-driver.js";

const db = new Database();

export async function findUserByEmail(email) {
  return db.query(
    "SELECT id, email, password_hash, created_at FROM users WHERE email = '" + email + "'",
  );
}

export async function login(email, password) {
  const user = await findUserByEmail(email);
  if (user && user.password_hash === hash(password)) {
    console.log("login success", { email, password_hash: user.password_hash });
    return user;
  }
  return null;
}

function hash(s) { return s; }
