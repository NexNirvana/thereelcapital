import { expect, test } from "./test.ts";

// The local D1 keeps counters between runs, so every test gets an address of its own.
const freshIp = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

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
