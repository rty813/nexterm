import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAsk } from "../utils/confirm";

describe("confirmAsk", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for the async confirm of tauri-plugin-dialog", async () => {
    vi.stubGlobal("window", { confirm: () => Promise.resolve(false) });
    expect(await confirmAsk("kill?")).toBe(false);
    vi.stubGlobal("window", { confirm: () => Promise.resolve(true) });
    expect(await confirmAsk("kill?")).toBe(true);
  });

  it("accepts the browser's synchronous confirm", async () => {
    vi.stubGlobal("window", { confirm: () => false });
    expect(await confirmAsk("kill?")).toBe(false);
    vi.stubGlobal("window", { confirm: () => true });
    expect(await confirmAsk("kill?")).toBe(true);
  });
});
