import { createServer } from "node:http";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
const diskImagesRoot = path.join(projectRoot, "storage", "images");
const v86BiosRoot = path.join(projectRoot, "storage", "runtime", "v86", "bios");
const v86PackageRoot = await resolvePackageRoot("v86/package.json");
const v86BuildRoot = v86PackageRoot ? path.join(v86PackageRoot, "build") : null;
const supportedDiskExtensions = new Set([".img", ".ima", ".vfd", ".flp", ".iso", ".bin"]);

const defaultProfiles = [
  { id: "dos-default", name: "MS-DOS 6.0 默认", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true },
  { id: "pal95", name: "仙剑 95 兼容预设", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true }
];

await ensureJsonFile(profilesFile, defaultProfiles);
await ensureJsonFile(sessionsFile, []);
await ensureDirectory(diskImagesRoot);
await ensureDirectory(v86BiosRoot);

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      sendJson(response, 400, { message: "Missing request url." });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    // 步骤 1：优先处理后端 API，把配置、镜像目录和运行时状态统一暴露给前端。
    if (url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", now: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/profiles" && request.method === "GET") {
      const profiles = await readJson(profilesFile, defaultProfiles);
      sendJson(response, 200, profiles.length > 0 ? profiles : defaultProfiles);
      return;
    }

    if (url.pathname === "/api/runtime-assets" && request.method === "GET") {
      sendJson(response, 200, getRuntimeAssetsStatus());
      return;
    }

    if (url.pathname === "/api/disk-images" && request.method === "GET") {
      sendJson(response, 200, await listDiskImages());
      return;
    }

    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const payload = await readBody(request);
      const sessions = await readJson(sessionsFile, []);

      // 步骤 2：记录本次镜像与启动参数，形成后续恢复、追踪和兼容性调优的基础数据。
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

    if (url.pathname.startsWith("/vendor/v86/")) {
      await handleV86AssetRequest(response, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/disk-images/")) {
      const fileName = path.basename(decodeURIComponent(url.pathname.replace("/disk-images/", "")));
      await sendFile(response, path.join(diskImagesRoot, fileName), [diskImagesRoot]);
      return;
    }

    if (url.pathname.startsWith("/docs/")) {
      await sendFile(response, path.join(docsRoot, url.pathname.replace("/docs/", "")), [docsRoot]);
      return;
    }

    // 步骤 3：其余请求统一走静态资源分发，让本地页面可以直接运行。
    const targetPath = url.pathname === "/" ? path.join(webRoot, "index.html") : path.join(webRoot, url.pathname);
    await sendFile(response, targetPath, [webRoot]);
  } catch (error) {
    sendJson(response, 500, { message: error.message });
  }
});

const host = "127.0.0.1";
const port = 3000;

server.listen(port, host, () => {
  console.log(`MS-DOS simulator server running at http://${host}:${port}`);
});

async function handleV86AssetRequest(response, pathname) {
  const vendorPath = decodeURIComponent(pathname.replace("/vendor/v86/", ""));
  const isBiosFile = vendorPath.startsWith("bios/");
  const relativePath = isBiosFile ? vendorPath.replace(/^bios\//, "") : vendorPath;
  const targetRoot = isBiosFile ? v86BiosRoot : v86BuildRoot;

  if (!targetRoot) {
    sendJson(response, 404, { message: "v86 package not installed." });
    return;
  }

  await sendFile(response, path.join(targetRoot, relativePath), [targetRoot]);
}

async function sendFile(response, filePath, allowedRoots) {
  const safePath = path.normalize(filePath);

  if (!allowedRoots.some((root) => safePath === root || safePath.startsWith(`${root}${path.sep}`))) {
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

async function listDiskImages() {
  const entries = await readdir(diskImagesRoot, { withFileTypes: true });
  const diskImages = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (!supportedDiskExtensions.has(extension)) {
      continue;
    }

    const filePath = path.join(diskImagesRoot, entry.name);
    const fileStat = await stat(filePath);

    diskImages.push({
      name: entry.name,
      size: fileStat.size,
      sizeLabel: formatBytes(fileStat.size),
      updatedAt: fileStat.mtime.toISOString(),
      hasBootSignature: await detectBootSignature(filePath),
      driveType: inferDriveType(entry.name, fileStat.size),
      url: `/disk-images/${encodeURIComponent(entry.name)}`
    });
  }

  diskImages.sort((left, right) => {
    if (left.name.toLowerCase() === "dos6.22.img") {
      return -1;
    }
    if (right.name.toLowerCase() === "dos6.22.img") {
      return 1;
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });

  return diskImages;
}

async function detectBootSignature(filePath) {
  const fileHandle = await open(filePath, "r");

  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await fileHandle.read(buffer, 0, 512, 0);

    if (bytesRead < 512) {
      return false;
    }

    return buffer[510] === 0x55 && buffer[511] === 0xaa;
  } finally {
    await fileHandle.close();
  }
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

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

async function resolvePackageRoot(specifier) {
  try {
    return path.dirname(fileURLToPath(import.meta.resolve(specifier)));
  } catch {
    return null;
  }
}

function getRuntimeAssetsStatus() {
  const status = {
    v86: {
      packageInstalled: Boolean(v86BuildRoot),
      biosReady: false,
      ready: false,
      moduleUrl: "/vendor/v86/libv86.mjs",
      scriptUrl: "/vendor/v86/libv86.js",
      wasmUrl: "/vendor/v86/v86.wasm",
      biosUrl: "/vendor/v86/bios/seabios.bin",
      vgaBiosUrl: "/vendor/v86/bios/vgabios.bin",
      missing: []
    }
  };

  if (!v86BuildRoot || !existsSync(path.join(v86BuildRoot, "libv86.mjs"))) {
    status.v86.missing.push("libv86.mjs");
  }

  if (!v86BuildRoot || !existsSync(path.join(v86BuildRoot, "v86.wasm"))) {
    status.v86.missing.push("v86.wasm");
  }

  if (!existsSync(path.join(v86BiosRoot, "seabios.bin"))) {
    status.v86.missing.push("seabios.bin");
  }

  if (!existsSync(path.join(v86BiosRoot, "vgabios.bin"))) {
    status.v86.missing.push("vgabios.bin");
  }

  status.v86.biosReady = !status.v86.missing.includes("seabios.bin") && !status.v86.missing.includes("vgabios.bin");
  status.v86.ready = status.v86.packageInstalled && status.v86.missing.length === 0;

  return status;
}

function inferDriveType(fileName, size) {
  const extension = path.extname(fileName).toLowerCase();

  if (extension === ".iso") {
    return "cdrom";
  }

  if (size <= 2_949_120) {
    return "floppy";
  }

  return "hardDisk";
}

function formatBytes(size) {
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (filePath.endsWith(".wasm")) {
    return "application/wasm";
  }

  return "application/octet-stream";
}
