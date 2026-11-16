import { describe, expect, it } from "vitest";
import { canReuseSsh, duplicateReusesSsh } from "../utils/duplicate";
import type { ConnectionStatus, SessionConfig } from "../types/domain";

const leaf = (protocol: string, status: ConnectionStatus) => ({ session: { protocol } as SessionConfig, status });

describe("duplicate session", () => {
  it("reuses only a connected SSH pane", () => {
    expect(canReuseSsh(leaf("ssh", "connected"))).toBe(true);
    expect(canReuseSsh(leaf("ssh", "connecting"))).toBe(false);
    expect(canReuseSsh(leaf("ssh", "disconnected"))).toBe(false);
    expect(canReuseSsh(leaf("telnet", "connected"))).toBe(false);
    expect(canReuseSsh(leaf("local", "connected"))).toBe(false);
  });

  it("shortcut follows the setting, defaulting to reuse", () => {
    expect(duplicateReusesSsh(undefined, leaf("ssh", "connected"))).toBe(true);
    expect(duplicateReusesSsh(true, leaf("ssh", "connected"))).toBe(true);
    expect(duplicateReusesSsh(false, leaf("ssh", "connected"))).toBe(false);
    expect(duplicateReusesSsh(true, leaf("ssh", "disconnected"))).toBe(false);
    expect(duplicateReusesSsh(true, leaf("serial", "connected"))).toBe(false);
  });
});
