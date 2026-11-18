import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import helloPackage from "../../plugins/hello.nexterm-plugin?raw";

const worker = {postMessage: vi.fn(), onmessage: async (_event: {data: Pick<File, "size" | "text">}) => {}};

describe("local plugin package reader", () => {
  beforeAll(async () => {
    vi.stubGlobal("self", worker);
    await import("../plugins/packageReader.worker");
  });
  afterAll(() => vi.unstubAllGlobals());

  it("does not release a review candidate until a slow file has been read and validated", async () => {
    let finish!: (contents: string) => void;
    const contents = new Promise<string>(resolve => {finish = resolve;});
    worker.postMessage.mockClear();
    const pending = worker.onmessage({data: {size: helloPackage.length, text: () => contents}});
    expect(worker.postMessage).not.toHaveBeenCalled();
    finish(helloPackage); await pending;
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({bundle: JSON.parse(helloPackage)});
  });
  it.each(["{", "{}"])("returns only an error for unreadable or invalid packages: %s", async input => {
    await worker.onmessage({data: new Blob([input])});
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({error: expect.any(String)}));
  });
  it("rejects oversized files before reading them", async () => {
    const text = vi.fn();
    await worker.onmessage({data: {size: 2 * 1024 * 1024 + 1, text}});
    expect(text).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenLastCalledWith({error: expect.stringContaining("2 MiB"), code: "tooLarge"});
  });
});
