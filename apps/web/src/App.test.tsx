import { describe, expect, it } from "vitest";
import { getConversations, getSeedMessages } from "./data";
import { copy } from "./i18n";

describe("preview safeguards", () => {
  it("renders only local demonstration data", () => {
    expect(getConversations("zh-CN")).toHaveLength(6);
    expect(getSeedMessages("en").every((message) => message.text.length > 0)).toBe(true);
  });

  it("keeps the Chinese and English resource keys aligned", () => {
    expect(Object.keys(copy["zh-CN"])).toEqual(Object.keys(copy.en));
  });
});
