import { describe, expect, it } from "vitest";

import { parseRetryAfterMs } from "@/lib/channels/uazapi/retry-after";

describe("parseRetryAfterMs", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");

  it("aceita delta-seconds e HTTP-date", () => {
    expect(parseRetryAfterMs("30", now)).toBe(30_000);
    expect(parseRetryAfterMs("Mon, 28 Sep 2026 12:00:45 GMT", now)).toBe(45_000);
  });

  it("recusa header ausente/inválido e limita zero e valores extremos", () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs("not-a-date", now)).toBeNull();
    expect(parseRetryAfterMs("0", now)).toBe(1_000);
    expect(parseRetryAfterMs("999999999", now)).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
