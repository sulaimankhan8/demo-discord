import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";

/* ---------------- USERS ---------------- */

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  username: text("username").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

/* ---------------- MESSAGES ---------------- */

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  snowflake: bigint("snowflake", { mode: "number" }).notNull(),
  username: text("username").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

/* ---------------- REACTION AUDIT LOG ---------------- */

export const messageReactions = pgTable("message_reactions", {
  id: uuid("id").defaultRandom().primaryKey(),

  messageId: uuid("message_id").notNull(),
  userId: uuid("user_id").notNull(),

  emojiCode: integer("emoji_code").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

/* ---------------- REACTION COUNTERS ---------------- */
export const messageReactionCounts = pgTable(
  "message_reaction_counts",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),

    emojiCode: integer("emoji_code").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey(t.messageId, t.emojiCode),
  })
);

