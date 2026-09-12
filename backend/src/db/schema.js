import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  bigint,
  primaryKey,
  jsonb,
  boolean,
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
  snowflake: bigint("snowflake", { mode: "string" }).notNull().unique(),
  username: text("username").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

/* ---------------- REACTION AUDIT LOG ---------------- */

export const messageReactions = pgTable("message_reactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageSnowflake: bigint("message_snowflake", { mode: "string" }).notNull(),
  userId: text("user_id").notNull(),
  emojiCode: text("emoji_code").notNull(),
  action: text("action").notNull().default("ADDED"),
  createdAt: timestamp("created_at").defaultNow(),
});

/* ---------------- REACTION COUNTERS ---------------- */
export const messageReactionCounts = pgTable(
  "message_reaction_counts",
  {
    messageSnowflake: bigint("message_snowflake", { mode: "string" }).notNull(),
    emojiCode: text("emoji_code").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageSnowflake, t.emojiCode] }),
  })
);

/* ---------------- ANALYTICS EVENTS ---------------- */

export const analyticsEvents =
  pgTable(
    "analytics_events",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      eventType:
        text("event_type")
          .notNull(),

      payload:
        jsonb("payload")
          .notNull(),

      createdAt:
        timestamp("created_at")
          .defaultNow(),
    }
  );

/* ---------------- NOTIFICATIONS ---------------- */

export const notifications =
  pgTable(
    "notifications",
    {
      id: uuid("id")
        .defaultRandom()
        .primaryKey(),

      userId:
        uuid("user_id")
          .notNull(),

      type:
        text("type")
          .notNull(),

      title:
        text("title"),

      payload:
        jsonb("payload"),

      isRead:
        boolean("is_read")
          .default(false),

      createdAt:
        timestamp("created_at")
          .defaultNow(),
    }
  );

/* ---------------- USER NOTIFICATION SETTINGS ---------------- */

export const userNotificationSettings =
  pgTable(
    "user_notification_settings",
    {
      userId:
        uuid("user_id")
          .primaryKey(),

      pushEnabled:
        integer("push_enabled")
          .default(1),

      emailEnabled:
        integer("email_enabled")
          .default(0),

      soundEnabled:
        integer("sound_enabled")
          .default(1),
    }
  );