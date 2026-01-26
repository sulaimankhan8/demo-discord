import http from "k6/http";
import { check } from "k6";

export const options = {
  vus: 50,
  duration: "2m",
};

const BASE_URL = "https://demo-discord.onrender.com";

export default function () {
  let before = null;
  const seen = new Set();

  for (let i = 0; i < 20; i++) {
    const url = before
      ? `${BASE_URL}/api/messages?before=${before}`
      : `${BASE_URL}/api/messages`;

    const res = http.get(url);
    const body = JSON.parse(res.body);

    check(res, { ok: (r) => r.status === 200 });

    for (const m of body.messages) {
      if (seen.has(m.snowflake)) {
        throw new Error("❌ DUPLICATE MESSAGE DETECTED");
      }
      seen.add(m.snowflake);
    }

    if (body.messages.length === 0) break;
    before = body.messages[0].snowflake;
  }
}
