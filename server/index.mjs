import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const webRoot = path.join(projectRoot, "web");
const docsRoot = path.join(projectRoot, "docs");
const profilesFile = path.join(projectRoot, "config", "profiles.json");
const sessionsFile = path.join(projectRoot, "storage", "sessions.json");
const diskImagesRoot = path.join(projectRoot, "storage", "images");
const baseDiskIndexFile = path.join(diskImagesRoot, "index.json");
const extendDiskRoot = path.join(projectRoot, "storage", "extendDisk");
const startupDiskRoot = path.join(projectRoot, "storage", "startupDisk");
const startupDiskIndexFile = path.join(startupDiskRoot, "index.json");
const v86BiosRoot = path.join(projectRoot, "storage", "runtime", "v86", "bios");
const v86PackageRoot = await resolvePackageRoot("v86/package.json");
const v86BuildRoot = v86PackageRoot ? path.join(v86PackageRoot, "build") : null;
const supportedDiskExtensions = new Set([".img", ".ima", ".vfd", ".flp", ".iso", ".bin"]);
const execFileAsync = promisify(execFile);
const defaultBootDiskImageName = "msdos622_dosidle_a.img";
const knownGameFamilies = {
  pal95: {
    id: "pal95",
    name: "仙剑奇侠传 95",
    launchCommand: "RUNSAFE",
    compatibility: {
      storage: { level: "ready", summary: "当前方案直接挂载原始扩展盘镜像，不再重打 FAT16 数据盘。" },
      memory: { level: "ready", summary: "已支持通过系统盘脚本控制 HIMEM、EMM386、DOS=HIGH,UMB 等启动参数。" },
      vga: { level: "ready", summary: "已支持 VGA BIOS 与图形模式切换日志，便于观察 PAL95 的 320x200 图形模式。" },
      sound: { level: "partial", summary: "当前声音链路只通过启动盘脚本注入环境变量，不再改写原始游戏镜像内的 SETUP.DAT。" },
      timing: { level: "partial", summary: "当前依赖 v86 默认 CPU/PIT 时序，若出现速度异常，需要继续做专项调优。" }
    }
  }
};

const defaultProfiles = [
  { id: "dos-default", name: "MS-DOS 6.0 默认", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true },
  { id: "pal95", name: "仙剑 95 兼容预设", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: false }
];

await ensureJsonFile(profilesFile, defaultProfiles);
await ensureJsonFile(sessionsFile, []);
await ensureDirectory(diskImagesRoot);
await ensureJsonFile(baseDiskIndexFile, []);
await ensureDirectory(extendDiskRoot);
await ensureDirectory(startupDiskRoot);
await ensureJsonFile(startupDiskIndexFile, []);
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

    if (url.pathname === "/api/base-disk-images" && request.method === "GET") {
      sendJson(response, 200, await listBaseDiskImages());
      return;
    }

    if (url.pathname === "/api/base-disk-images" && request.method === "POST") {
      const payload = await readBody(request);
      sendJson(response, 201, await uploadBaseDiskImage(payload));
      return;
    }

    if (url.pathname.startsWith("/api/base-disk-images/") && request.method === "PATCH") {
      const imageName = path.basename(decodeURIComponent(url.pathname.replace("/api/base-disk-images/", "")));
      const payload = await readBody(request);
      sendJson(response, 200, await updateBaseDiskImageMetadata(imageName, payload));
      return;
    }

    if (url.pathname.startsWith("/api/base-disk-images/") && request.method === "DELETE") {
      const imageName = path.basename(decodeURIComponent(url.pathname.replace("/api/base-disk-images/", "")));
      sendJson(response, 200, await deleteBaseDiskImage(imageName));
      return;
    }

    if (url.pathname === "/api/startup-disks" && request.method === "GET") {
      sendJson(response, 200, await listStartupDisks());
      return;
    }

    if (url.pathname === "/api/startup-disks/preview" && request.method === "POST") {
      const payload = await readBody(request);
      sendJson(response, 200, await previewStartupDisk(payload));
      return;
    }

    if (url.pathname === "/api/startup-disks" && request.method === "POST") {
      const payload = await readBody(request);
      sendJson(response, 200, await resolveStartupDisk(payload));
      return;
    }

    if (url.pathname === "/api/game-packages" && request.method === "GET") {
      sendJson(response, 200, await listGamePackages());
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

    if (url.pathname.startsWith("/startup-disks-files/")) {
      const fileName = path.basename(decodeURIComponent(url.pathname.replace("/startup-disks-files/", "")));
      await sendFile(response, path.join(startupDiskRoot, fileName), [startupDiskRoot]);
      return;
    }

    if (url.pathname.startsWith("/extend-disks-files/")) {
      const fileName = path.basename(decodeURIComponent(url.pathname.replace("/extend-disks-files/", "")));
      await sendFile(response, path.join(extendDiskRoot, fileName), [extendDiskRoot]);
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
    logServerStep("error", error.stack || error.message);
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

async function listBaseDiskImages() {
  const metadataIndex = await readBaseDiskIndex();
  const diskImages = await collectDiskImages(diskImagesRoot, "/disk-images/", "storage/images");
  return sortDiskImages(diskImages).map(({ filePath, ...diskImage }) => ({
    ...diskImage,
    note: metadataIndex.get(diskImage.name)?.note || ""
  }));
}

async function listStartupDisks() {
  const records = await readJson(startupDiskIndexFile, []);
  const startupDisks = [];

  // 步骤 1：按索引逐个校验磁盘文件仍然存在，并把动态大小、时间等信息补齐返回给前端。
  for (const record of records) {
    const imagePath = path.join(startupDiskRoot, record.imageFileName);

    if (!existsSync(imagePath)) {
      continue;
    }

    const fileStat = await stat(imagePath);
    startupDisks.push({
      ...buildStartupDiskPayload(record),
      size: fileStat.size,
      sizeLabel: formatBytes(fileStat.size),
      updatedAt: fileStat.mtime.toISOString(),
      hasBootSignature: await detectBootSignature(imagePath),
      driveType: inferDriveType(record.imageFileName, fileStat.size)
    });
  }

  return startupDisks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function uploadBaseDiskImage(payload = {}) {
  const imageName = path.basename(String(payload.name || "")).trim();

  if (!imageName) {
    throw new Error("请提供系统盘文件名。");
  }

  if (!supportedDiskExtensions.has(path.extname(imageName).toLowerCase())) {
    throw new Error(`不支持的系统盘格式: ${imageName}`);
  }

  const contentBase64 = String(payload.contentBase64 || "");

  if (!contentBase64) {
    throw new Error("上传内容为空。");
  }

  const filePath = path.join(diskImagesRoot, imageName);

  if (existsSync(filePath)) {
    throw new Error(`系统盘已存在: ${imageName}`);
  }

  // 步骤 1：把上传的原始镜像直接写入 storage/images，并同步记录备注元数据。
  await writeFile(filePath, Buffer.from(contentBase64, "base64"));
  await saveBaseDiskNote(imageName, String(payload.note || "").trim());
  logServerStep("system-disk", `已上传系统盘: ${filePath}`);

  return {
    image: (await listBaseDiskImages()).find((item) => item.name === imageName) || null
  };
}

async function updateBaseDiskImageMetadata(imageName, payload = {}) {
  const filePath = path.join(diskImagesRoot, imageName);

  if (!existsSync(filePath)) {
    throw new Error(`未找到系统盘: ${imageName}`);
  }

  await saveBaseDiskNote(imageName, String(payload.note || "").trim());
  logServerStep("system-disk", `已更新系统盘备注: ${filePath}`);

  return {
    image: (await listBaseDiskImages()).find((item) => item.name === imageName) || null
  };
}

async function deleteBaseDiskImage(imageName) {
  const filePath = path.join(diskImagesRoot, imageName);

  if (!existsSync(filePath)) {
    throw new Error(`未找到系统盘: ${imageName}`);
  }

  // 步骤 2：删除系统盘文件后同步清理备注元数据，避免管理列表残留脏记录。
  await rm(filePath, { force: true });
  await removeBaseDiskNote(imageName);
  logServerStep("system-disk", `已删除系统盘: ${filePath}`);

  return { deleted: true, name: imageName };
}

function sortDiskImages(diskImages) {
  return diskImages.sort((left, right) => {
    if (left.name.toLowerCase() === defaultBootDiskImageName) {
      return -1;
    }
    if (right.name.toLowerCase() === defaultBootDiskImageName) {
      return 1;
    }
    if (left.catalog !== right.catalog) {
      return left.catalog.localeCompare(right.catalog, "zh-CN");
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

async function listGamePackages() {
  const diskImages = await collectDiskImages(extendDiskRoot, "/extend-disks-files/", "storage/extendDisk");
  return diskImages.map((diskImage) => buildGamePackageFromDiskImage(diskImage));
}

async function previewStartupDisk(options = {}) {
  const normalizedOptions = normalizeStartupDiskOptions(options);
  const baseImage = await resolveBaseDiskImageByName(normalizedOptions.baseImageName);
  const selectedPackage = normalizedOptions.packageId ? await resolveGamePackageById(normalizedOptions.packageId) : null;
  const configKey = buildStartupDiskConfigKey(baseImage, selectedPackage, normalizedOptions);

  if (normalizedOptions.packageId && !selectedPackage) {
    throw new Error(`未找到游戏包: ${normalizedOptions.packageId}`);
  }

  if (normalizedOptions.autoRunGame && !selectedPackage) {
    throw new Error("自动执行游戏前，请先选择一个扩展硬盘游戏包。");
  }

  return {
    configKey,
    description: buildStartupDescription(selectedPackage, baseImage, normalizedOptions),
    note: normalizedOptions.note,
    systemDiskName: baseImage.name,
    startupDiskName: buildDefaultStartupDiskName(selectedPackage, normalizedOptions),
    configSys: buildStartupConfigSys(normalizedOptions),
    autoexecBat: buildStartupAutoexecBat(selectedPackage, normalizedOptions)
  };
}

async function resolveStartupDisk(options = {}) {
  const normalizedOptions = normalizeStartupDiskOptions(options);
  const baseImage = await resolveBaseDiskImageByName(normalizedOptions.baseImageName);
  const selectedPackage = normalizedOptions.packageId ? await resolveGamePackageById(normalizedOptions.packageId) : null;
  const configKey = buildStartupDiskConfigKey(baseImage, selectedPackage, normalizedOptions);

  if (normalizedOptions.packageId && !selectedPackage) {
    throw new Error(`未找到游戏包: ${normalizedOptions.packageId}`);
  }

  if (normalizedOptions.autoRunGame && !selectedPackage) {
    throw new Error("自动执行游戏前，请先选择一个扩展硬盘游戏包。");
  }

  const records = await readJson(startupDiskIndexFile, []);
  const reusableRecord = records.find((record) => record.configKey === configKey && existsSync(path.join(startupDiskRoot, record.imageFileName)));

  // 步骤 1：启动前先按基础盘和脚本参数查找是否已有完全相同的系统启动盘，有就直接复用。
  if (reusableRecord) {
    const imagePath = path.join(startupDiskRoot, reusableRecord.imageFileName);
    const fileStat = await stat(imagePath);
    logServerStep("startup", `复用已存在启动盘: ${imagePath}`);

    reusableRecord.lastUsedAt = new Date().toISOString();
    await writeFile(startupDiskIndexFile, JSON.stringify(records, null, 2));

    return {
      reused: true,
      disk: {
        ...buildStartupDiskPayload(reusableRecord),
        size: fileStat.size,
        sizeLabel: formatBytes(fileStat.size),
        updatedAt: fileStat.mtime.toISOString(),
        hasBootSignature: await detectBootSignature(imagePath),
        driveType: inferDriveType(reusableRecord.imageFileName, fileStat.size)
      },
      preview: {
        configKey,
        description: reusableRecord.description,
        configSys: buildStartupConfigSys(normalizedOptions),
        autoexecBat: buildStartupAutoexecBat(selectedPackage, normalizedOptions)
      },
      paths: {
        baseImagePath: baseImage.filePath,
        bootDiskPath: imagePath,
        metadataPath: startupDiskIndexFile
      }
    };
  }

  const imageFileName = buildStartupDiskFileName(normalizedOptions.displayName || selectedPackage?.name || baseImage.name);
  const imagePath = path.join(startupDiskRoot, imageFileName);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "startup-floppy-"));
  const configPath = path.join(tempRoot, "CONFIG.SYS");
  const autoexecPath = path.join(tempRoot, "AUTOEXEC.BAT");
  const startupVirtualFiles = buildStartupVirtualFiles(selectedPackage);
  logServerStep("startup", `开始生成启动盘，基础盘=${baseImage.filePath}`);
  logServerStep("startup", `输出目录: ${startupDiskRoot}`);
  logServerStep("startup", `输出镜像: ${imagePath}`);
  logServerStep("startup", `索引文件: ${startupDiskIndexFile}`);

  try {
    // 步骤 1：先复制一份基础盘，后续所有加工都在新镜像上完成，避免污染原始盘。
    await copyFile(baseImage.filePath, imagePath);

    // 步骤 2：根据勾选参数生成最小启动配置，只覆盖 DOS 启动脚本，不修改其他系统文件。
    await writeFile(configPath, buildStartupConfigSys(normalizedOptions), "ascii");
    await writeFile(autoexecPath, buildStartupAutoexecBat(selectedPackage, normalizedOptions), "ascii");
    logServerStep("startup", `临时 CONFIG.SYS: ${configPath}`);
    logServerStep("startup", `临时 AUTOEXEC.BAT: ${autoexecPath}`);

    await execFileAsync("mcopy", ["-o", "-i", imagePath, configPath, "::CONFIG.SYS"]);
    await execFileAsync("mcopy", ["-o", "-i", imagePath, autoexecPath, "::AUTOEXEC.BAT"]);

    // 步骤 3：把辅助批处理和说明文件写入 A 盘，避免再改写原始扩展盘镜像。
    for (const virtualFile of startupVirtualFiles) {
      const tempFilePath = path.join(tempRoot, virtualFile.name);
      await writeFile(tempFilePath, virtualFile.content);
      await execFileAsync("mcopy", ["-o", "-i", imagePath, tempFilePath, `::${virtualFile.name}`]);
    }

    logServerStep("startup", `已写回镜像系统配置: ${imagePath}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  // 步骤 3：写入本地索引，把生成来源、参数和说明保存下来，供页面后续直接展示和选择。
  const fileStat = await stat(imagePath);
  const record = {
    id: `startup-${Date.now()}`,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    configKey,
    imageFileName,
    name: normalizedOptions.displayName || buildDefaultStartupDiskName(selectedPackage, normalizedOptions),
    description: buildStartupDescription(selectedPackage, baseImage, normalizedOptions),
    note: normalizedOptions.note,
    packageId: selectedPackage?.id || "",
    packageName: selectedPackage?.name || "",
    baseImageName: baseImage.name,
    baseImageCatalog: baseImage.catalog,
    options: normalizedOptions
  };

  records.unshift(record);
  await writeFile(startupDiskIndexFile, JSON.stringify(records, null, 2));
  logServerStep("startup", `启动盘生成完成: ${imagePath} (${formatBytes(fileStat.size)})`);

  return {
    reused: false,
    disk: {
      ...buildStartupDiskPayload(record),
      size: fileStat.size,
      sizeLabel: formatBytes(fileStat.size),
      updatedAt: fileStat.mtime.toISOString(),
      hasBootSignature: await detectBootSignature(imagePath),
        driveType: inferDriveType(imageFileName, fileStat.size)
    },
    preview: {
      configKey,
      description: record.description,
      configSys: buildStartupConfigSys(normalizedOptions),
      autoexecBat: buildStartupAutoexecBat(selectedPackage, normalizedOptions)
    },
    paths: {
      baseImagePath: baseImage.filePath,
      bootDiskPath: imagePath,
      metadataPath: startupDiskIndexFile
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

function buildStartupConfigSys(options) {
  const lines = ["DEVICE=HIMEM.SYS /testmem:off"];

  // 步骤 1：在可选的常规内存优化模式下启用 HMA/UMB，并尝试把后续驱动尽量搬出常规内存。
  if (options.optimizeMemory) {
    lines.push("DOS=HIGH,UMB", "DEVICE=EMM386.EXE NOEMS", "FILES=30", "BUFFERS=20", "STACKS=0,0");
  } else {
    lines.push("FILES=40", "BUFFERS=30");
  }

  if (options.includeCdDriver) {
    lines.push("", options.optimizeMemory ? "DEVICEHIGH=cd1.SYS /D:banana" : "DEVICE=cd1.SYS /D:banana", "LASTDRIVE=Z");
  }

  return [...lines, ""].join("\r\n");
}

function buildStartupAutoexecBat(selectedPackage, options) {
  const lines = ["@echo off"];

  // 步骤 2：把 MSCDEX 与底层 CD 驱动拆开控制，便于继续定位到底是哪一层触发了兼容问题。
  if (options.includeMscdex) {
    lines.push(options.optimizeMemory ? "LH MSCDEX.EXE /D:banana /L:R" : "MSCDEX.EXE /D:banana /L:R");
  }

  if (options.includeDosIdle) {
    lines.push(options.optimizeMemory ? "LH DOSIDLE" : "DOSIDLE");
  }

  if (options.autoRunGame && selectedPackage?.familyId === "pal95") {
    lines.push(options.soundEnabled ? "RUNPAL" : "RUNSAFE");
  } else if (options.autoRunGame && selectedPackage) {
    lines.push("C:");
  }

  return [...lines, ""].join("\r\n");
}

function buildStartupVirtualFiles(selectedPackage) {
  if (!selectedPackage || selectedPackage.familyId !== "pal95") {
    return [];
  }

  return [
    {
      name: "RUNSAFE.BAT",
      content: ["@ECHO OFF", "SET BLASTER=", "SET SOUND=", "SET MIDI=", "C:", "CD \\", "PAL.EXE"].join("\r\n") + "\r\n"
    },
    {
      name: "RUNPAL.BAT",
      content: ["@ECHO OFF", "SET BLASTER=A220 I7 D1 H5 T6", "SET SOUND=C:\\", "SET MIDI=SYNTH:1 MAP:E MODE:0", "C:", "CD \\", "PAL.EXE"].join("\r\n") + "\r\n"
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
        "C:",
        "CD \\",
        "DIR PAL.EXE",
        "ECHO.",
        "ECHO 当前方案不会改写 C 盘镜像内的 SETUP.DAT。"
      ].join("\r\n") + "\r\n"
    },
    {
      name: "PALREAD.TXT",
      content: [
        "PAL95 启动说明",
        "",
        "1. 当前方案直接挂载 storage/extendDisk 下的原始镜像作为 C 盘。",
        "2. RUNSAFE/RUNPAL 仅放在 A 盘，不会改写 C 盘镜像中的 SETUP.DAT。",
        "3. 如果原始镜像需要特定 SETUP.DAT、批处理或目录结构，请先在线下调整。"
      ].join("\r\n") + "\r\n"
    }
  ];
}

async function collectDiskImages(rootPath, urlPrefix, catalog) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const diskImages = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (!supportedDiskExtensions.has(extension)) {
      continue;
    }

    const filePath = path.join(rootPath, entry.name);
    const fileStat = await stat(filePath);

    diskImages.push({
      name: entry.name,
      size: fileStat.size,
      sizeLabel: formatBytes(fileStat.size),
      updatedAt: fileStat.mtime.toISOString(),
      hasBootSignature: await detectBootSignature(filePath),
      driveType: inferDriveType(entry.name, fileStat.size),
      url: `${urlPrefix}${encodeURIComponent(entry.name)}`,
      catalog,
      filePath
    });
  }

  return diskImages;
}

async function resolveBaseDiskImageByName(imageName) {
  const diskImages = await collectDiskImages(diskImagesRoot, "/disk-images/", "storage/images");
  const image = sortDiskImages(diskImages).find((item) => item.name === imageName);

  if (!image) {
    throw new Error(`未找到基础镜像: ${imageName}`);
  }

  return image;
}

async function resolveGamePackageById(packageId) {
  const gamePackages = await listGamePackages();
  return gamePackages.find((item) => item.id === packageId) || null;
}

function normalizeStartupDiskOptions(options = {}) {
  const includeCdDriver = options.includeCdDriver !== false;

  return {
    baseImageName: String(options.baseImageName || defaultBootDiskImageName),
    packageId: String(options.packageId || ""),
    displayName: String(options.displayName || "").trim(),
    note: String(options.note || "").trim(),
    soundEnabled: Boolean(options.soundEnabled),
    optimizeMemory: options.optimizeMemory !== false,
    includeDosIdle: options.includeDosIdle !== false,
    includeCdDriver,
    includeMscdex: typeof options.includeMscdex === "boolean" ? options.includeMscdex : includeCdDriver,
    autoRunGame: Boolean(options.autoRunGame)
  };
}

function buildStartupDiskConfigKey(baseImage, selectedPackage, options) {
  const payload = {
    baseImageName: baseImage.name,
    baseImageSize: baseImage.size,
    baseImageUpdatedAt: baseImage.updatedAt,
    packageId: selectedPackage?.id || "",
    packageImageName: selectedPackage?.mount?.name || "",
    packageImageSize: selectedPackage?.mount?.size || 0,
    packageImageUpdatedAt: selectedPackage?.mount?.updatedAt || "",
    soundEnabled: options.soundEnabled,
    optimizeMemory: options.optimizeMemory,
    includeDosIdle: options.includeDosIdle,
    includeCdDriver: options.includeCdDriver,
    includeMscdex: options.includeMscdex,
    autoRunGame: options.autoRunGame
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function buildStartupDiskFileName(sourceName) {
  const safeName = slugifyFileName(path.parse(sourceName).name) || "startup-disk";
  return `${safeName}-${Date.now()}.img`;
}

function buildDefaultStartupDiskName(selectedPackage, options) {
  const packageName = selectedPackage?.name || "通用 DOS";
  const soundLabel = options.soundEnabled ? "声音版" : "静音版";
  return `${packageName} 启动盘 (${soundLabel})`;
}

function buildStartupDescription(selectedPackage, baseImage, options) {
  const segments = [
    `基础盘: ${baseImage.name}`,
    `扩展盘: ${selectedPackage?.mount?.name || "无"}`,
    `常规内存优化: ${options.optimizeMemory ? "开" : "关"}`,
    `DOSIDLE: ${options.includeDosIdle ? "开" : "关"}`,
    `CD 驱动: ${options.includeCdDriver ? "开" : "关"}`,
    `MSCDEX: ${options.includeMscdex ? "开" : "关"}`,
    `自动执行游戏: ${options.autoRunGame ? "开" : "关"}`
  ];

  if (selectedPackage?.familyId === "pal95") {
    segments.push(`声音模式: ${options.soundEnabled ? "RUNPAL" : "RUNSAFE"}`);
  }

  if (options.note) {
    segments.push(`备注: ${options.note}`);
  }

  return segments.join(" | ");
}

function buildStartupDiskPayload(record) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    note: record.note || "",
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || record.createdAt,
    configKey: record.configKey || "",
    baseImageName: record.baseImageName,
    packageId: record.packageId || "",
    packageName: record.packageName || "",
    imageFileName: record.imageFileName,
    url: `/startup-disks-files/${encodeURIComponent(record.imageFileName)}`,
    catalog: "storage/startupDisk",
    options: record.options || {}
  };
}

function buildGamePackageFromDiskImage(diskImage) {
  const family = inferKnownGameFamily(diskImage.name);
  const preferredSlot = diskImage.driveType === "cdrom" ? "cdrom" : "hda";

  return {
    id: diskImage.name,
    familyId: family?.id || "",
    name: family?.name || path.parse(diskImage.name).name,
    available: true,
    preferredSlot,
    sourcePath: diskImage.filePath,
    launchCommand: family?.launchCommand || "",
    compatibility: family?.compatibility || null,
    mount: {
      name: diskImage.name,
      url: diskImage.url,
      size: diskImage.size,
      sizeLabel: diskImage.sizeLabel,
      updatedAt: diskImage.updatedAt,
      driveType: preferredSlot === "cdrom" ? "cdrom" : "hardDisk"
    }
  };
}

function inferKnownGameFamily(fileName) {
  const normalizedName = fileName.toLowerCase();

  if (normalizedName.includes("pal95") || normalizedName.includes("xianjian") || normalizedName.includes("仙剑")) {
    return knownGameFamilies.pal95;
  }

  return null;
}

function slugifyFileName(value) {
  return value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function logServerStep(scope, message) {
  console.log(`[${scope}] ${message}`);
}

async function readJson(filePath, fallback) {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function readBaseDiskIndex() {
  const records = await readJson(baseDiskIndexFile, []);
  return new Map(records.map((record) => [record.name, record]));
}

async function saveBaseDiskNote(imageName, note) {
  const records = await readJson(baseDiskIndexFile, []);
  const nextRecords = records.filter((record) => record.name !== imageName);

  if (note) {
    nextRecords.push({
      name: imageName,
      note,
      updatedAt: new Date().toISOString()
    });
  }

  await writeFile(baseDiskIndexFile, JSON.stringify(nextRecords, null, 2));
}

async function removeBaseDiskNote(imageName) {
  const records = await readJson(baseDiskIndexFile, []);
  const nextRecords = records.filter((record) => record.name !== imageName);
  await writeFile(baseDiskIndexFile, JSON.stringify(nextRecords, null, 2));
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
