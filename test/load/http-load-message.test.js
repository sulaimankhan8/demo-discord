import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    mixed_http: {
      executor: "ramping-vus",
      stages: [
        { duration: "10s", target: 50 },
        { duration: "10s", target: 150 },
        { duration: "10s", target: 300 },
        { duration: "10s", target: 500 },
        { duration: "10s", target: 800 },
        { duration: "10s", target: 1000 },
        { duration: "20s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<20000"],
  },
};

const BASE_URL = "https://demo-discord.onrender.com";

export default function () {
  const user = `user_${__VU}`;

  // login (idempotent)
  http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ username: user }),
    { headers: { "Content-Type": "application/json" } }
  );

  // 90% latest reads, 10% scroll
  if (__VU % 10 === 0) {
    const res = http.get(
      `${BASE_URL}/api/messages?before=999999999999999999`
    );
    check(res, { scroll_ok: (r) => r.status === 200 });
  } else {
    const res = http.get(`${BASE_URL}/api/messages`);
    check(res, { read_ok: (r) => r.status === 200 });
  }

  sleep(1);
}
