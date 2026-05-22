import { createServer } from "node:http";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFat16Image, describeSourceDirectory } from "./fat16-image-builder.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const webRoot = path.join(projectRoot, "web");
const docsRoot = path.join(projectRoot, "docs");
const profilesFile = path.join(projectRoot, "storage", "profiles.json");
const sessionsFile = path.join(projectRoot, "storage", "sessions.json");
const diskImagesRoot = path.join(projectRoot, "storage", "images");
const generatedDiskRoot = path.join(projectRoot, "storage", "generated");
const v86BiosRoot = path.join(projectRoot, "storage", "runtime", "v86", "bios");
const v86PackageRoot = await resolvePackageRoot("v86/package.json");
const v86BuildRoot = v86PackageRoot ? path.join(v86PackageRoot, "build") : null;
const supportedDiskExtensions = new Set([".img", ".ima", ".vfd", ".flp", ".iso", ".bin"]);
const gamePackages = [
  {
    id: "pal95",
    name: "仙剑奇侠传 95",
    sourceDirectory: "./download/pal95",
    volumeLabel: "PAL95",
    imageFileName: "pal95-hdd.img",
    metadataFileName: "pal95-hdd.json",
    preferredSlot: "hda",
    launchCommand: "C:\\\rRUNSAFE\r",
    compatibility: {
      storage: { level: "ready", summary: "已支持把 pal95 目录固化为 FAT16 数据盘，并以 hda 方式挂载到 DOS。" },
      memory: { level: "ready", summary: "已支持把总内存参数传给 v86；XMS/EMS 仍取决于 dos 启动镜像中的 CONFIG.SYS/AUTOEXEC.BAT。" },
      vga: { level: "ready", summary: "已支持 VGA BIOS 与图形模式切换，前端会记录分辨率/色深变化，便于观察 320x200 256 色进入情况。" },
      sound: { level: "partial", summary: "当前默认优先走静音兼容启动，以绕过 PLAY 模块报错；SB16 / AdLib 仍需后续继续调试。" },
      timing: { level: "partial", summary: "当前依赖 v86 的 PIT/CPU 调度，已适合首轮验证；若存在动画或音乐速度异常，需要继续做专项时序调优。" }
    }
  }
];

const defaultProfiles = [
  { id: "dos-default", name: "MS-DOS 6.0 默认", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true },
  { id: "pal95", name: "仙剑 95 兼容预设", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: false }
];

await ensureJsonFile(profilesFile, defaultProfiles);
await ensureJsonFile(sessionsFile, []);
await ensureDirectory(diskImagesRoot);
await ensureDirectory(generatedDiskRoot);
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

    if (url.pathname === "/api/game-packages" && request.method === "GET") {
      sendJson(response, 200, await listGamePackages());
      return;
    }

    if (url.pathname.startsWith("/api/game-packages/") && url.pathname.endsWith("/materialize") && request.method === "POST") {
      const packageId = path.basename(url.pathname.replace("/materialize", ""));
      const payload = await readBody(request);
      sendJson(response, 200, await materializeGamePackage(packageId, payload));
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

    if (url.pathname.startsWith("/generated-disks/")) {
      const fileName = path.basename(decodeURIComponent(url.pathname.replace("/generated-disks/", "")));
      await sendFile(response, path.join(generatedDiskRoot, fileName), [generatedDiskRoot]);
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

async function listGamePackages() {
  const packages = [];

  for (const gamePackage of gamePackages) {
    const available = existsSync(gamePackage.sourceDirectory);
    let fileCount = 0;
    let totalSize = 0;

    if (available) {
      const description = await describeSourceDirectory(gamePackage.sourceDirectory);
      fileCount = description.fileCount;
      totalSize = description.totalSize;
    }

    packages.push({
      id: gamePackage.id,
      name: gamePackage.name,
      available,
      preferredSlot: gamePackage.preferredSlot,
      sourceDirectory: gamePackage.sourceDirectory,
      fileCount,
      totalSize,
      totalSizeLabel: totalSize > 0 ? formatBytes(totalSize) : "0 KB",
      launchCommand: gamePackage.launchCommand,
      compatibility: gamePackage.compatibility
    });
  }

  return packages;
}

async function materializeGamePackage(packageId, options = {}) {
  const gamePackage = gamePackages.find((item) => item.id === packageId);

  if (!gamePackage) {
    throw new Error(`未找到游戏包: ${packageId}`);
  }

  if (!existsSync(gamePackage.sourceDirectory)) {
    throw new Error(`游戏包目录不存在: ${gamePackage.sourceDirectory}`);
  }

  const imagePath = path.join(generatedDiskRoot, gamePackage.imageFileName);
  const metadataPath = path.join(generatedDiskRoot, gamePackage.metadataFileName);
  const launchSoundEnabled = Boolean(options.soundEnabled);
  const originalSetupBuffer = await readFile(path.join(gamePackage.sourceDirectory, "SETUP.DAT"));
  const silentSetupBuffer = buildPal95SilentSetup(originalSetupBuffer);
  const virtualFiles = [
    {
      name: "RUNPAL.BAT",
      content: [
        "@ECHO OFF",
        "COPY /Y SETPSND.DAT SETUP.DAT >NUL",
        "SET BLASTER=A220 I7 D1 H5 T6",
        "SET SOUND=C:\\",
        "SET MIDI=SYNTH:1 MAP:E MODE:0",
        "PAL.EXE"
      ].join("\r\n") + "\r\n"
    },
    {
      name: "RUNSAFE.BAT",
      content: [
        "@ECHO OFF",
        "COPY /Y SETPNOS.DAT SETUP.DAT >NUL",
        "SET BLASTER=",
        "SET SOUND=",
        "SET MIDI=",
        "PAL.EXE"
      ].join("\r\n") + "\r\n"
    },
    {
      name: "PALDIAG.BAT",
      content: [
        "@ECHO OFF",
        "ECHO PAL95 DOS 兼容诊断",
        "ECHO ------------------------------",
        "VER",
        "MEM",
        "SET BLASTER",
        "DIR PAL.EXE",
        "ECHO.",
        "ECHO 先执行 RUNSAFE 绕过 PLAY 模块，再视情况尝试 RUNPAL。"
      ].join("\r\n") + "\r\n"
    },
    {
      name: "PALREAD.TXT",
      content: [
        "PAL95 DOS 模拟提示",
        "",
        "1. 先执行 PALDIAG 查看 DOS 内存与 BLASTER 环境。",
        "2. 优先执行 RUNSAFE 绕过 PLAY 模块的声卡初始化。",
        "3. 若静音模式可进游戏，再尝试 RUNPAL 验证声音。",
        "4. 若黑屏或卡死，重点关注 VGA 模式切换日志。"
      ].join("\r\n") + "\r\n"
    },
    {
      name: "SETPSND.DAT",
      content: originalSetupBuffer
    },
    {
      name: "SETPNOS.DAT",
      content: silentSetupBuffer
    }
  ];

  // 步骤 1：先把游戏目录固化成一块新的 FAT16 数据盘，保证前端拿到的始终是与当前目录同步的镜像。
  await buildFat16Image({
    sourceDirectory: gamePackage.sourceDirectory,
    outputPath: imagePath,
    metadataPath,
    volumeLabel: gamePackage.volumeLabel,
    virtualFiles
  });

  const imageStat = await stat(imagePath);

  return {
    id: gamePackage.id,
    name: gamePackage.name,
    launchCommand: launchSoundEnabled ? "C:\\\rRUNPAL\r" : gamePackage.launchCommand,
    compatibility: gamePackage.compatibility,
    mount: {
      name: gamePackage.imageFileName,
      url: `/generated-disks/${encodeURIComponent(gamePackage.imageFileName)}`,
      size: imageStat.size,
      sizeLabel: formatBytes(imageStat.size),
      driveType: "hardDisk",
      preferredSlot: gamePackage.preferredSlot
    }
  };
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

function buildPal95SilentSetup(originalSetupBuffer) {
  const silentSetupBuffer = Buffer.from(originalSetupBuffer);

  // 步骤 1：保留文件头标识，只清空已知的声音设备选项区，优先构造“无声卡”兼容配置。
  for (let offset = 8; offset <= 18 && offset + 1 < silentSetupBuffer.length; offset += 2) {
    silentSetupBuffer.writeUInt16LE(0, offset);
  }

  return silentSetupBuffer;
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
