import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const webRoot = path.join(projectRoot, "web");
const docsRoot = path.join(projectRoot, "docs");
const profilesFile = path.join(projectRoot, "storage", "profiles.json");
const sessionsFile = path.join(projectRoot, "storage", "sessions.json");

const defaultProfiles = [
  { id: "dos-default", name: "MS-DOS 6.0 默认", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true },
  { id: "pal95", name: "仙剑 95 兼容预设", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true }
];

await ensureJsonFile(profilesFile, defaultProfiles);
await ensureJsonFile(sessionsFile, []);

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendJson(response, 400, { message: "Missing request url." });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    // 步骤 1：优先处理后端 API，为前端提供配置与会话管理能力。
    if (url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", now: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/profiles" && request.method === "GET") {
      const profiles = await readJson(profilesFile, defaultProfiles);
      sendJson(response, 200, profiles.length > 0 ? profiles : defaultProfiles);
      return;
    }

    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const payload = await readBody(request);
      const sessions = await readJson(sessionsFile, []);

      // 步骤 2：记录本次镜像与启动参数，形成后续审计、恢复与多镜像管理的基础数据。
      const session = {
        id: `session-${Date.now()}`,
        createdAt: new Date().toISOString(),
        ...payload
      };

      sessions.unshift(session);
      await writeFile(sessionsFile, JSON.stringify(sessions.slice(0, 20), null, 2));
      sendJson(response, 201, session);
      return;
    }

    if (url.pathname.startsWith("/docs/")) {
      await sendFile(response, path.join(docsRoot, url.pathname.replace("/docs/", "")));
      return;
    }

    // 步骤 3：其余请求统一走静态资源分发，让前端应用可直接独立运行。
    const targetPath = url.pathname === "/" ? path.join(webRoot, "index.html") : path.join(webRoot, url.pathname);
    await sendFile(response, targetPath);
  } catch (error) {
    sendJson(response, 500, { message: error.message });
  }
});

const host = "127.0.0.1";
const port = 3000;

server.listen(port, host, () => {
  console.log(`MS-DOS simulator server running at http://${host}:${port}`);
});

async function sendFile(response, filePath) {
  const safePath = path.normalize(filePath);
  const allowedRoots = [webRoot, docsRoot];

  if (!allowedRoots.some((root) => safePath.startsWith(root))) {
    sendJson(response, 403, { message: "Forbidden" });
    return;
  }

  if (!existsSync(safePath)) {
    sendJson(response, 404, { message: "Not found" });
    return;
  }

  const buffer = await readFile(safePath);
  response.writeHead(200, {
    "Content-Type": getContentType(safePath)
  });
  response.end(buffer);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(filePath, fallback) {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function ensureJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) {
    await writeFile(filePath, JSON.stringify(fallback, null, 2));
  }
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  return "application/octet-stream";
}
