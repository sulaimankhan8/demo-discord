import { db } from "../db/index.js";
import { users } from "../db/schema.js";

export async function createUser(username) {
  const [user] = await db
    .insert(users)
    .values({ username })
    .returning();

  return user;
}
