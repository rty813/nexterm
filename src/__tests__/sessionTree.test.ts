import { describe, expect, it } from "vitest";
import { filterGroupOptions, groupOptions } from "../utils/sessionTree";

describe("group options of the session form", () => {
  it("offers every group and its parent folders once", () => {
    expect(groupOptions(["生产>华东", "生产 > 华北", "", "测试", "生产>华东"])).toEqual(["测试", "生产", "生产>华北", "生产>华东"]);
  });

  it("shows all options for an empty or already chosen value and filters while typing", () => {
    const options = ["Dev", "Prod", "Prod>East", "Staging>Prod mirror"];
    expect(filterGroupOptions(options, "")).toEqual(options);
    expect(filterGroupOptions(options, "prod")).toEqual(options);
    expect(filterGroupOptions(options, "pro")).toEqual(["Prod", "Prod>East", "Staging>Prod mirror"]);
    expect(filterGroupOptions(options, "east")).toEqual(["Prod>East"]);
    expect(filterGroupOptions(options, "new")).toEqual([]);
  });
});
