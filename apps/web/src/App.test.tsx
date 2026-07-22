import { describe, expect, it } from "vitest";
import { copy } from "./i18n";

describe("preview safeguards", () => {
  it("keeps the Chinese and English resource keys aligned", () => {
    expect(Object.keys(copy["zh-CN"])).toEqual(Object.keys(copy.en));
  });

  // 所有 i18n 文案必须是非空字符串，避免空翻译导致 UI 缺失文字。
  it("keeps every localization value a non-empty string", () => {
    for (const [locale, dict] of Object.entries(copy)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${locale}.${key} must be string`).toBe("string");
        expect((value as string).length, `${locale}.${key} must not be empty`).toBeGreaterThan(0);
      }
    }
  });
});
