import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    http_test: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 1 },
      
      ],
    },
  },
};

const BASE_URL = "http://43.204.147.168:4000";

export default function () {
  const username = `user_${__VU}_${__ITER}`;

  // LOGIN
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ username }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );

  check(loginRes, {
    "login OK": (r) => r.status === 200,
  });

  // FETCH HISTORY
  const historyRes = http.get(`${BASE_URL}/api/messages`);

  check(historyRes, {
    "history OK": (r) => r.status === 200,
  });

  sleep(1);
}
