import { describe, expect, it } from "vitest";
import { getConversations, getSeedMessages } from "./data";
import { copy } from "./i18n";

describe("preview safeguards", () => {
  // 验证本地演示数据在中英文下条数一致、id 唯一且对齐。
  // data.ts 中的演示数据目前未被 App.tsx 直接引用（会话列表已改为读取加密本地历史），
  // 但保留契约测试作为兜底，防止后续误用导致中英文不一致。
  it("renders only local demonstration data", () => {
    const zhConversations = getConversations("zh-CN");
    const enConversations = getConversations("en");
    expect(zhConversations).toHaveLength(6);
    expect(enConversations).toHaveLength(6);
    expect(zhConversations.map((item) => item.id)).toEqual(enConversations.map((item) => item.id));
    expect(new Set(zhConversations.map((item) => item.id)).size).toBe(6);

    const zhMessages = getSeedMessages("zh-CN");
    const enMessages = getSeedMessages("en");
    expect(zhMessages).toHaveLength(enMessages.length);
    expect(enMessages.every((message) => message.text.length > 0)).toBe(true);
    expect(zhMessages.every((message) => message.text.length > 0)).toBe(true);
    expect(zhMessages.map((item) => item.id)).toEqual(enMessages.map((item) => item.id));
  });

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
