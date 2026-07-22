import { chromium } from "playwright";

const baseUrl = process.env.COVECHAT_BASE_URL ?? "http://127.0.0.1:5174";
const passphrase = "correct horse battery staple";
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(-12);
const alice = `alice_${stamp}`;
const bob = `bob_${stamp}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.COVECHAT_BROWSER_PATH
    ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});

async function createUser(username) {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  if (process.env.COVECHAT_E2E_BYPASS_SETUP === "1") {
    await page.route("**/api/v1/setup/status", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true, publicOrigin: baseUrl }),
    }));
  }
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("本地解锁口令").fill(passphrase);
  await page.getByLabel("确认口令").fill(passphrase);
  await page.getByRole("button", { name: "创建安全身份" }).click();
  await page.getByRole("button", { name: "我已安全保存，进入 CoveChat" }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "我已安全保存，进入 CoveChat" }).click();
  return { context, page };
}

try {
  const sender = await createUser(alice);
  const receiver = await createUser(bob);
  await sender.page.getByLabel("用户名").fill(bob);
  await sender.page.getByLabel("输入加密消息").fill("真实未读状态测试");
  await sender.page.getByRole("button", { name: "发送消息" }).click();

  const conversation = receiver.page.locator(".conversation", { hasText: alice });
  await conversation.waitFor({ timeout: 60_000 });
  await conversation.locator("b").filter({ hasText: "1" }).waitFor();
  await conversation.click();
  await receiver.page.getByText("真实未读状态测试", { exact: true }).waitFor();
  await conversation.locator("b").waitFor({ state: "detached" });

  await receiver.page.reload({ waitUntil: "networkidle" });
  await receiver.page.getByLabel("本地解锁口令").fill(passphrase);
  await receiver.page.getByRole("button", { name: "解锁" }).click();
  const reloadedConversation = receiver.page.locator(".conversation", { hasText: alice });
  await reloadedConversation.waitFor({ timeout: 60_000 });
  if (await reloadedConversation.locator("b").count() !== 0) {
    throw new Error("read state did not persist after reload and unlock");
  }
  console.log(JSON.stringify({ alice, bob, unreadBeforeOpen: 1, unreadAfterReload: 0 }));
  await sender.context.close();
  await receiver.context.close();
} finally {
  await browser.close();
}
