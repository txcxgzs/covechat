import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.COVECHAT_BROWSER_PATH
    ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const baseUrl = process.env.COVECHAT_BASE_URL ?? "http://127.0.0.1:5174/";

const results = [];
for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  const page = await browser.newPage({ viewport });
  const consoleProblems = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleProblems.push(message.text());
  });
  page.on("pageerror", (error) => consoleProblems.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const title = await page.title();
  await page.getByLabel("用户名").fill(`qa_${viewport.name}`);
  await page.getByLabel("本地解锁口令").fill("correct horse battery staple");
  await page.getByLabel("确认口令").fill("correct horse battery staple");
  await page.getByRole("button", { name: "创建安全身份" }).click();
  await page.getByRole("heading", { name: "保存恢复码" }).waitFor({ timeout: 60000 });
  const recoveryCode = await page.locator(".recovery-code").innerText();
  await page.getByRole("button", { name: "我已安全保存，进入 CoveChat" }).click();
  await page.getByText("实验性安全预览", { exact: true }).waitFor();
  if (viewport.name === "desktop") {
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "解锁 CoveChat" }).waitFor();
    await page.getByLabel("本地解锁口令").fill("definitely the wrong passphrase");
    await page.getByRole("button", { name: "解锁" }).click();
    await page.getByRole("alert").waitFor({ timeout: 60000 });
    await page.getByLabel("本地解锁口令").fill("correct horse battery staple");
    await page.getByRole("button", { name: "解锁" }).click();
    await page.getByText("实验性安全预览", { exact: true }).waitFor({ timeout: 60000 });
    await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase("covechat-secure");
        request.onsuccess = resolve;
        request.onerror = reject;
      });
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "使用恢复码恢复账户" }).click();
    await page.getByLabel("用户名").fill(`qa_${viewport.name}`);
    await page.getByLabel("恢复码").fill(recoveryCode);
    await page.getByLabel("本地解锁口令").fill("new correct horse battery staple");
    await page.getByLabel("确认口令").fill("new correct horse battery staple");
    await page.getByRole("button", { name: "恢复并撤销旧设备" }).click();
    await page.getByText("实验性安全预览", { exact: true }).waitFor({ timeout: 60000 });
  }
  const bodyText = await page.locator("body").innerText();
  const heading = await page.getByRole("heading", { name: "消息" }).count();
  const preview = await page.getByText("实验性安全预览", { exact: true }).count();
  const overlay = await page.locator("vite-error-overlay").count();

  if (viewport.name === "desktop") {
    const composer = page.getByLabel("给 Maya 发消息");
    if (await composer.count() !== 1) {
      throw new Error(`Composer missing. body=${bodyText.slice(0, 500)} console=${consoleProblems.join(" | ")}`);
    }
    await composer.fill("一条仅在本地渲染的测试消息");
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByText("一条仅在本地渲染的测试消息", { exact: true }).waitFor();
    const attachmentBytes = Buffer.from("covechat encrypted attachment round trip", "utf8");
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "安全附件.txt",
      mimeType: "text/plain",
      buffer: attachmentBytes,
    });
    await page.getByText("安全附件.txt", { exact: true }).waitFor({ timeout: 60000 });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载并解密" }).click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    if (!downloadedPath || !fs.readFileSync(downloadedPath).equals(attachmentBytes)) {
      throw new Error("decrypted attachment did not match uploaded bytes");
    }
    await page.getByRole("button", { name: "验证安全码" }).click();
    await page.getByText("安全码已验证", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Switch to English" }).click();
    await page.getByRole("heading", { name: "Messages" }).waitFor();
    await page.getByText("Thanks for the update.", { exact: true }).waitFor();
    await page.getByText("Hi Alex, just checking in about the document you shared.", { exact: true }).waitFor();
  }

  const screenshot = path.join(os.tmpdir(), `covechat-${viewport.name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  results.push({ ...viewport, title, heading, preview, overlay, consoleProblems, screenshot });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
