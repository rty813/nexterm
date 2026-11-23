import { describe, expect, it } from "vitest";
import { closeActionOf, withCloseAction } from "../utils/closeAction";

describe("closeActionOf", () => {
  it("uses the explicit choice", () => {
    expect(closeActionOf({ closeToTray: false, closeAction: "tray" })).toBe("tray");
    expect(closeActionOf({ closeToTray: true, closeAction: "quit" })).toBe("quit");
    expect(closeActionOf({ closeToTray: false, closeAction: "ask" })).toBe("ask");
  });
  it("falls back to closeToTray for older settings", () => {
    expect(closeActionOf({ closeToTray: true })).toBe("ask");
    expect(closeActionOf({ closeToTray: false })).toBe("quit");
  });
  it("keeps closeToTray in step", () => {
    expect(withCloseAction({ closeToTray: true }, "quit")).toEqual({ closeToTray: false, closeAction: "quit" });
    expect(withCloseAction({ closeToTray: false }, "tray")).toEqual({ closeToTray: true, closeAction: "tray" });
  });
});
