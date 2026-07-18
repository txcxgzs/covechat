// === CoveChat 第 6 轮新增的 Origin 校验和限流 E2E 测试 ===
//
// 这个文件独立于 smoke.mjs，专门覆盖第 6 轮新增的安全中间件：
//   - require_origin：POST/PUT/DELETE 校验 Origin 头（services/api/src/main.rs）
//   - anonymous_rate_limit：匿名接口按 IP 限流（onboarding/challenge/recovery）
//   - authenticated_rate_limit：认证接口按 device_id 限流
//   - events WebSocket handler 手动校验 Origin
//
// 与 smoke.mjs 的区别：
//   - 不用 Playwright/Chrome，只用 Node 内置的 fetch（Node 18+）和 http/https 模块
//   - 不测前端 UI，只测后端 HTTP 行为（通过 Vite dev server 代理转发）
//   - 用环境变量控制哪些测试跑（避免在没 Redis / 没设 ALLOWED_ORIGINS 时假性失败）
//
// 运行前置条件：
//   1. 后端 cargo run 已启动（默认 127.0.0.1:8080）
//   2. 前端 dev server 已启动（默认 127.0.0.1:5173，会代理 /api → 后端）
//   3. 按需设置环境变量（见下文）
//
// 环境变量：
//   - COVECHAT_BASE_URL：dev server 地址，默认 http://127.0.0.1:5173
//   - COVECHAT_ALLOWED_ORIGIN：后端配置的合法 Origin（如 http://127.0.0.1:5173）。
//       设置后才会跑测试 1 和测试 4（Origin 校验类）。
//       注意：后端必须用相同的 ALLOWED_ORIGINS 启动，否则测试无意义。
//   - COVECHAT_REDIS_URL：后端使用的 Redis 地址。
//       设置后才会跑测试 3（限流类），因为无 Redis 时限流降级放行。
//
// 退出码：
//   - 0：全部 pass 或全部 skip
//   - 1：有 fail

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

// === 配置读取 ===

// dev server 地址。默认 5173（与 smoke.mjs 默认 5174 不同，可通过环境变量对齐）
const baseUrl = process.env.COVECHAT_BASE_URL ?? "http://127.0.0.1:5173";
// 后端 ALLOWED_ORIGINS 中配置的合法 Origin。未设置时跳过 Origin 校验类测试
const allowedOrigin = process.env.COVECHAT_ALLOWED_ORIGIN;
// Redis URL。未设置时跳过限流类测试（无 Redis 时后端限流降级放行）
const redisUrl = process.env.COVECHAT_REDIS_URL;

// 测试结果数组，最后统一输出 JSON
const results = [];

/**
 * 记录一条测试结果
 * @param {string} name - 测试名
 * @param {"pass"|"fail"|"skip"} status - 状态
 * @param {string} detail - 详情
 */
function record(name, status, detail) {
  results.push({ name, status, detail });
}

// === 工具函数 ===

/**
 * 用 Node 内置 fetch 发送 POST 请求
 *
 * Node 的 fetch（基于 undici）不会像浏览器那样自动加 Origin 头，
 * 所以默认就是"不带 Origin"（模拟 curl 行为）。
 * 通过 options.origin 显式传入才会带上 Origin 头。
 *
 * @param {string} path - 路径（如 /api/v1/onboarding）
 * @param {object} [options] - 选项
 * @param {string} [options.body] - 请求体（JSON 字符串）
 * @param {string|undefined} [options.origin] - Origin 头；undefined=不发
 * @param {Record<string, string>} [options.headers] - 额外头
 * @returns {Promise<{status: number, body: string}>}
 */
async function postJson(path, options = {}) {
  const url = new URL(path, baseUrl).toString();
  const headers = {
    "content-type": "application/json",
    ...(options.headers ?? {}),
  };
  if (options.origin !== undefined) {
    headers.origin = options.origin;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: options.body ?? "{}",
  });
  const body = await response.text();
  return { status: response.status, body };
}

/**
 * 探测 WebSocket 升级握手的结果
 *
 * 不真正建立 WebSocket 连接，只发一个 GET Upgrade 请求，看服务器返回：
 *   - 101 Switching Protocols：升级成功（Origin 校验通过）
 *   - 403 Forbidden：Origin 被拒绝（后端 events handler 的行为）
 *   - 其他状态码：其他错误（如 401 未认证）
 *
 * 用 Node 内置 http/https 模块而不是 WebSocket，是因为 WebSocket 客户端
 * 不允许自定义 Origin 头（浏览器才会自动加），手写握手请求可以完全控制 headers。
 *
 * @param {string} path - WebSocket 路径（如 /api/v1/events/xxx）
 * @param {string|undefined} [origin] - Origin 头；undefined=不发
 * @returns {Promise<{upgraded: boolean, statusCode: number, error?: string}>}
 */
function probeWebSocket(path, origin) {
  return new Promise((resolve) => {
    const url = new URL(path, baseUrl);
    const isSecure = url.protocol === "https:" || url.protocol === "wss:";
    const lib = isSecure ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isSecure ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          connection: "upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          // Sec-WebSocket-Key 必须是 16 字节的 base64，否则握手会被拒
          "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
          ...(origin !== undefined ? { origin } : {}),
        },
      },
      (res) => {
        // 普通 HTTP 响应（非 101 升级）：说明连接被拒绝（如 403 Origin 拒绝 / 401 未认证）
        res.resume(); // 释放响应流，避免内存泄漏
        resolve({ upgraded: false, statusCode: res.statusCode });
      },
    );
    req.on("upgrade", () => {
      // 101 升级成功：Origin 校验通过
      req.destroy(); // 立即关闭，不需要真正通信
      resolve({ upgraded: true, statusCode: 101 });
    });
    req.on("error", (err) => {
      resolve({ upgraded: false, statusCode: 0, error: err.message });
    });
    req.end();
  });
}

/**
 * 生成一个随机的 UUID v4（用于 device_id 占位）
 * 后端 create_challenge 会先做限流检查，再查 device_id 是否存在，
 * 所以用不存在的 device_id 也能触发限流逻辑。
 */
function randomDeviceId() {
  return crypto.randomUUID();
}

// === 测试用例 ===

/**
 * 测试 1：POST /api/v1/onboarding 带非法 Origin 应返回 403
 *
 * 后端 require_origin 中间件行为（services/api/src/main.rs）：
 *   - ALLOWED_ORIGINS 非空时，POST/PUT/DELETE 的 Origin 头必须在允许列表里
 *   - 不在列表里 → 返回 403 Forbidden
 *
 * 这个测试发送 Origin: https://evil.example.com，预期被中间件拦截返回 403。
 * 注意：Origin 校验在 body 解析之前，所以 body 无效不影响测试结果。
 *
 * 跳过条件：未设置 COVECHAT_ALLOWED_ORIGIN（说明后端在开发模式，不会拦截）
 */
async function testOnboardingRejectsBadOrigin() {
  const name = "测试 1：POST /api/v1/onboarding 带非法 Origin 应返回 403";
  if (!allowedOrigin) {
    record(
      name,
      "skip",
      "未设置 COVECHAT_ALLOWED_ORIGIN，跳过（需后端用 ALLOWED_ORIGINS 启动）",
    );
    return;
  }
  try {
    const { status } = await postJson("/api/v1/onboarding", {
      origin: "https://evil.example.com",
      // body 无所谓，Origin 校验先于 body 解析
      body: JSON.stringify({ account: {}, device: {} }),
    });
    if (status === 403) {
      record(name, "pass", "收到 403（非法 Origin 被中间件拒绝）");
    } else {
      record(
        name,
        "fail",
        `预期 403，实际 ${status}（后端可能未设置 ALLOWED_ORIGINS，或中间件未生效）`,
      );
    }
  } catch (err) {
    record(name, "fail", `请求失败：${err.message}`);
  }
}

/**
 * 测试 2：开发模式下 POST /api/v1/onboarding 不带 Origin 应放行（非 403）
 *
 * 后端 require_origin 中间件行为：
 *   - ALLOWED_ORIGINS 为空（未设置或空字符串）= 开发模式
 *   - 开发模式下放行所有请求，不做 Origin 校验
 *
 * Node fetch 默认不自动加 Origin 头（与浏览器不同），模拟 curl 行为。
 * 期望：放行到 handler，因 body 无效返回 400/422 等业务错误（不是 403）。
 *
 * 跳过条件：设置了 COVECHAT_ALLOWED_ORIGIN（说明后端启用了 Origin 校验，此测试不适用）
 */
async function testOnboardingPassesWithoutOriginInDevMode() {
  const name = "测试 2：开发模式下 POST /api/v1/onboarding 不带 Origin 应放行（非 403）";
  if (allowedOrigin) {
    record(
      name,
      "skip",
      "已设置 COVECHAT_ALLOWED_ORIGIN，跳过开发模式测试（后端启用了 Origin 校验）",
    );
    return;
  }
  try {
    const { status, body } = await postJson("/api/v1/onboarding", {
      body: JSON.stringify({ account: {}, device: {} }),
    });
    if (status === 403) {
      record(
        name,
        "fail",
        `收到 403，但开发模式应放行（body=${body.slice(0, 200)}）`,
      );
    } else {
      record(
        name,
        "pass",
        `收到 ${status}（非 403，开发模式放行到 handler）`,
      );
    }
  } catch (err) {
    record(name, "fail", `请求失败：${err.message}`);
  }
}

/**
 * 测试 3：限流——连续 POST /api/v1/auth/challenges/{device_id} 11 次，第 11 次应 429
 *
 * 后端 create_challenge 限流（services/api/src/main.rs）：
 *   - anonymous_rate_limit(scope="challenge", limit=10, window=60s)
 *   - 按 X-Forwarded-For 的 IP 限流；缺失时用 "anonymous" 兜底
 *   - 无 Redis 时降级放行（不会返回 429）
 *
 * 用一个不存在的 device_id 也能触发限流，因为限流检查在 device 查找之前。
 * 前 10 次应返回 404（device 不存在），第 11 次应返回 429（被限流）。
 *
 * 跳过条件：未设置 COVECHAT_REDIS_URL（无 Redis 时限流降级放行，测试无意义）
 */
async function testChallengeRateLimit() {
  const name = "测试 3：连续打 create_challenge 11 次，第 11 次应返回 429";
  if (!redisUrl) {
    record(
      name,
      "skip",
      "未设置 COVECHAT_REDIS_URL，跳过（无 Redis 时限流降级放行，不会返回 429）",
    );
    return;
  }
  try {
    const deviceId = randomDeviceId();
    const path = `/api/v1/auth/challenges/${deviceId}`;
    // 前 10 次应该返回 404（device 不存在），但限流计数会累加
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const { status } = await postJson(path);
      statuses.push(status);
    }
    // 第 11 次应该被限流（429）
    const { status: finalStatus } = await postJson(path);
    if (finalStatus === 429) {
      record(
        name,
        "pass",
        `前 10 次状态：[${statuses.join(",")}]，第 11 次返回 429（限流生效）`,
      );
    } else {
      record(
        name,
        "fail",
        `预期第 11 次 429，实际 ${finalStatus}（前 10 次：[${statuses.join(",")}]）`,
      );
    }
  } catch (err) {
    record(name, "fail", `请求失败：${err.message}`);
  }
}

/**
 * 测试 4：WebSocket /api/v1/events/{device_id} 带非法 Origin 应被拒绝
 *
 * 后端 events handler 行为（services/api/src/main.rs）：
 *   - WebSocket 升级是 GET 请求，不经过 require_origin 中间件
 *   - 在 handler 内手动校验 Origin：ALLOWED_ORIGINS 非空时，Origin 必须在允许列表
 *   - 不在列表 → 返回 403 Forbidden（不升级 WebSocket）
 *
 * 用 http 模块发送带非法 Origin 的升级请求，预期返回 403（不升级）。
 *
 * 跳过条件：未设置 COVECHAT_ALLOWED_ORIGIN
 */
async function testEventsWebSocketRejectsBadOrigin() {
  const name = "测试 4：WebSocket /api/v1/events 带非法 Origin 应被拒绝（403 或不升级）";
  if (!allowedOrigin) {
    record(
      name,
      "skip",
      "未设置 COVECHAT_ALLOWED_ORIGIN，跳过",
    );
    return;
  }
  try {
    const deviceId = randomDeviceId();
    const { upgraded, statusCode, error } = await probeWebSocket(
      `/api/v1/events/${deviceId}`,
      "https://evil.example.com",
    );
    if (error) {
      record(name, "fail", `握手请求错误：${error}`);
      return;
    }
    if (!upgraded && statusCode === 403) {
      record(name, "pass", "收到 403（非法 Origin 被拒绝升级）");
    } else if (!upgraded) {
      // 其他非升级响应也算"被拒绝"，但不是预期 403，标记为 fail 便于排查
      record(
        name,
        "fail",
        `预期 403，实际 statusCode=${statusCode}（未升级但状态码不对）`,
      );
    } else {
      record(
        name,
        "fail",
        `预期拒绝升级，实际升级成功（statusCode=${statusCode}，Origin 校验未生效）`,
      );
    }
  } catch (err) {
    record(name, "fail", `请求失败：${err.message}`);
  }
}

// === 主入口 ===

// 所有测试函数按顺序执行。每个函数内部自己决定是否 skip
const tests = [
  testOnboardingRejectsBadOrigin,
  testOnboardingPassesWithoutOriginInDevMode,
  testChallengeRateLimit,
  testEventsWebSocketRejectsBadOrigin,
];

for (const test of tests) {
  await test();
}

// 输出 JSON 结果数组，便于人和脚本解析
console.log(JSON.stringify(results, null, 2));

// 退出码：有 fail=1，全 pass 或全 skip=0
const hasFail = results.some((r) => r.status === "fail");
process.exit(hasFail ? 1 : 0);
