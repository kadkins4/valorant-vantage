import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Minimal Response stub — henrik.get() only reads ok/status/headers.get/json.
function resp(body: unknown, status = 200, retryAfter?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => (k === "retry-after" ? (retryAfter ?? null) : null),
    },
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  process.env.VAL_API_KEY = "test-key";
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules(); // fresh module = reset the throttle's `last` between tests
});

describe("henrik.get retry", () => {
  it("retries a transient HTTP 500 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resp({}, 500))
      .mockResolvedValueOnce(resp({ data: "ok" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const { henrik } = await import("@/lib/henrik");
    const p = henrik.account("name", "tag");
    await vi.runAllTimersAsync();

    expect(await p).toEqual({ data: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network error (rejected fetch) then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(resp({ data: "ok" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const { henrik } = await import("@/lib/henrik");
    const p = henrik.account("name", "tag");
    await vi.runAllTimersAsync();

    expect(await p).toEqual({ data: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on persistent 500", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    const { henrik } = await import("@/lib/henrik");
    const p = henrik.account("name", "tag");
    // Attach the rejection handler before draining timers so the run is observed.
    const settled = expect(p).rejects.toThrow(/HTTP 500/);
    await vi.runAllTimersAsync();
    await settled;
    // initial attempt + 4 retries = 5 calls
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not retry a 4xx client error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp({}, 404));
    vi.stubGlobal("fetch", fetchMock);

    const { henrik } = await import("@/lib/henrik");
    const p = henrik.account("name", "tag");
    const settled = expect(p).rejects.toThrow(/HTTP 404/);
    await vi.runAllTimersAsync();
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
