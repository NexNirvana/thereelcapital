import { expect, test } from "./test.ts";

// The local D1 keeps counters between runs when playwright is started by hand (ports.ts stateDir),
// and a counter lasts 10 minutes. Math.random() addresses could therefore collide with a leftover
// counter and fail at random. Instead the address is derived from a per-process salt (the start
// time, so two runs differ) and a sequence number (so two calls in a run differ): no collisions,
// and a failure is reproducible from its address.
const runSalt = Math.floor(Date.now() / 1000) % 65_536;
let sequence = 0;
const freshIp = () => `10.${runSalt >> 8}.${runSalt & 255}.${1 + (sequence++ % 250)}`;

// Better Auth keys the counters by `cf-connecting-ip` and path, so a made-up address per test
// keeps these runs apart from each other and from the rest of the suite.
async function attempts(
  request: import("@playwright/test").APIRequestContext,
  path: string,
  ip: string,
  data: object,
) {
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    const response = await request.post(path, {
      headers: { "cf-connecting-ip": ip },
      data,
    });
    statuses.push(response.status());
  }
  return statuses;
}

test("activation links and recovery codes are limited to 5 attempts per 10 minutes", async ({
  request,
}) => {
  const link = await attempts(request, "/api/auth/activation/redeem", freshIp(), {
    token: "x".repeat(43),
  });
  expect(link.slice(0, 5)).not.toContain(429);
  expect(link.slice(5)).toEqual(Array(7).fill(429));
  const code = await attempts(request, "/api/auth/recovery/redeem", freshIp(), {
    code: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA",
  });
  expect(code.slice(0, 5)).not.toContain(429);
  expect(code.slice(5)).toEqual(Array(7).fill(429));
});
