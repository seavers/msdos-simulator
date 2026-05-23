import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildFat16Image, describeSourceDirectory } from "./fat16-image-builder.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const webRoot = path.join(projectRoot, "web");
const docsRoot = path.join(projectRoot, "docs");
const profilesFile = path.join(projectRoot, "storage", "profiles.json");
const sessionsFile = path.join(projectRoot, "storage", "sessions.json");
const diskImagesRoot = path.join(projectRoot, "storage", "images");
const baseDiskIndexFile = path.join(diskImagesRoot, "index.json");
const generatedDiskRoot = path.join(projectRoot, "storage", "generated");
const startupFloppyRoot = path.join(projectRoot, "storage", "startupFloppyDisk");
const startupFloppyIndexFile = path.join(startupFloppyRoot, "index.json");
const v86BiosRoot = path.join(projectRoot, "storage", "runtime", "v86", "bios");
const v86PackageRoot = await resolvePackageRoot("v86/package.json");
const v86BuildRoot = v86PackageRoot ? path.join(v86PackageRoot, "build") : null;
const supportedDiskExtensions = new Set([".img", ".ima", ".vfd", ".flp", ".iso", ".bin"]);
const execFileAsync = promisify(execFile);
const defaultBootDiskImageName = "msdos622_dosidle_a.img";
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
await ensureJsonFile(baseDiskIndexFile, []);
await ensureDirectory(generatedDiskRoot);
await ensureDirectory(startupFloppyRoot);
await ensureJsonFile(startupFloppyIndexFile, []);
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

    if (url.pathname.startsWith("/startup-floppy-disks/")) {
      const fileName = path.basename(decodeURIComponent(url.pathname.replace("/startup-floppy-disks/", "")));
      await sendFile(response, path.join(startupFloppyRoot, fileName), [startupFloppyRoot]);
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
  const records = await readJson(startupFloppyIndexFile, []);
  const startupDisks = [];

  // 步骤 1：按索引逐个校验磁盘文件仍然存在，并把动态大小、时间等信息补齐返回给前端。
  for (const record of records) {
    const imagePath = path.join(startupFloppyRoot, record.imageFileName);

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
  logServerStep("pal95", `开始物化游戏盘，sound=${launchSoundEnabled ? "on" : "off"}`);
  logServerStep("pal95", `固定游戏目录: ${path.resolve(gamePackage.sourceDirectory)}`);
  logServerStep("pal95", `输出硬盘镜像: ${imagePath}`);
  logServerStep("pal95", `输出元数据: ${metadataPath}`);
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
  logServerStep("pal95", `开始写入 FAT16 游戏盘，共注入 ${virtualFiles.length} 个附加文件。`);
  await buildFat16Image({
    sourceDirectory: gamePackage.sourceDirectory,
    outputPath: imagePath,
    metadataPath,
    volumeLabel: gamePackage.volumeLabel,
    virtualFiles
  });

  const imageStat = await stat(imagePath);
  logServerStep("pal95", `游戏盘写入完成: ${imagePath} (${formatBytes(imageStat.size)})`);

  return {
    id: gamePackage.id,
    name: gamePackage.name,
    launchCommand: launchSoundEnabled ? "C:\\\rRUNPAL\r" : gamePackage.launchCommand,
    compatibility: gamePackage.compatibility,
    paths: {
      diskImagePath: imagePath,
      metadataPath
    },
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

async function previewStartupDisk(options = {}) {
  const normalizedOptions = normalizeStartupDiskOptions(options);
  const baseImage = await resolveBaseDiskImageByName(normalizedOptions.baseImageName);
  const selectedPackage = normalizedOptions.packageId ? gamePackages.find((item) => item.id === normalizedOptions.packageId) : null;
  const configKey = buildStartupDiskConfigKey(baseImage, normalizedOptions);

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
    autoexecBat: buildStartupAutoexecBat(normalizedOptions)
  };
}

async function resolveStartupDisk(options = {}) {
  const normalizedOptions = normalizeStartupDiskOptions(options);
  const baseImage = await resolveBaseDiskImageByName(normalizedOptions.baseImageName);
  const selectedPackage = normalizedOptions.packageId ? gamePackages.find((item) => item.id === normalizedOptions.packageId) : null;
  const configKey = buildStartupDiskConfigKey(baseImage, normalizedOptions);

  if (normalizedOptions.packageId && !selectedPackage) {
    throw new Error(`未找到游戏包: ${normalizedOptions.packageId}`);
  }

  if (normalizedOptions.autoRunGame && !selectedPackage) {
    throw new Error("自动执行游戏前，请先选择一个扩展硬盘游戏包。");
  }

  const records = await readJson(startupFloppyIndexFile, []);
  const reusableRecord = records.find((record) => record.configKey === configKey && existsSync(path.join(startupFloppyRoot, record.imageFileName)));

  // 步骤 1：启动前先按基础盘和脚本参数查找是否已有完全相同的系统启动盘，有就直接复用。
  if (reusableRecord) {
    const imagePath = path.join(startupFloppyRoot, reusableRecord.imageFileName);
    const fileStat = await stat(imagePath);
    logServerStep("startup", `复用已存在启动盘: ${imagePath}`);

    reusableRecord.lastUsedAt = new Date().toISOString();
    await writeFile(startupFloppyIndexFile, JSON.stringify(records, null, 2));

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
        autoexecBat: buildStartupAutoexecBat(normalizedOptions)
      },
      paths: {
        baseImagePath: baseImage.filePath,
        bootDiskPath: imagePath,
        metadataPath: startupFloppyIndexFile
      }
    };
  }

  const imageFileName = buildStartupDiskFileName(normalizedOptions.displayName || selectedPackage?.name || baseImage.name);
  const imagePath = path.join(startupFloppyRoot, imageFileName);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "startup-floppy-"));
  const configPath = path.join(tempRoot, "CONFIG.SYS");
  const autoexecPath = path.join(tempRoot, "AUTOEXEC.BAT");
  logServerStep("startup", `开始生成启动盘，基础盘=${baseImage.filePath}`);
  logServerStep("startup", `输出目录: ${startupFloppyRoot}`);
  logServerStep("startup", `输出镜像: ${imagePath}`);
  logServerStep("startup", `索引文件: ${startupFloppyIndexFile}`);

  try {
    // 步骤 1：先复制一份基础盘，后续所有加工都在新镜像上完成，避免污染原始盘。
    await copyFile(baseImage.filePath, imagePath);

    // 步骤 2：根据勾选参数生成最小启动配置，只覆盖 DOS 启动脚本，不修改其他系统文件。
    await writeFile(configPath, buildStartupConfigSys(normalizedOptions), "ascii");
    await writeFile(autoexecPath, buildStartupAutoexecBat(normalizedOptions), "ascii");
    logServerStep("startup", `临时 CONFIG.SYS: ${configPath}`);
    logServerStep("startup", `临时 AUTOEXEC.BAT: ${autoexecPath}`);

    await execFileAsync("mcopy", ["-o", "-i", imagePath, configPath, "::CONFIG.SYS"]);
    await execFileAsync("mcopy", ["-o", "-i", imagePath, autoexecPath, "::AUTOEXEC.BAT"]);
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
  await writeFile(startupFloppyIndexFile, JSON.stringify(records, null, 2));
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
      autoexecBat: buildStartupAutoexecBat(normalizedOptions)
    },
    paths: {
      baseImagePath: baseImage.filePath,
      bootDiskPath: imagePath,
      metadataPath: startupFloppyIndexFile
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

function buildStartupAutoexecBat(options) {
  const lines = ["@echo off"];

  // 步骤 2：把 MSCDEX 与底层 CD 驱动拆开控制，便于继续定位到底是哪一层触发了兼容问题。
  if (options.includeMscdex) {
    lines.push(options.optimizeMemory ? "LH MSCDEX.EXE /D:banana /L:R" : "MSCDEX.EXE /D:banana /L:R");
  }

  if (options.includeDosIdle) {
    lines.push(options.optimizeMemory ? "LH DOSIDLE" : "DOSIDLE");
  }

  if (options.autoRunGame) {
    lines.push("C:");
  }

  if (options.autoRunGame && options.packageId === "pal95") {
    lines.push(options.soundEnabled ? "RUNPAL" : "RUNSAFE");
  }

  return [...lines, ""].join("\r\n");
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

function buildStartupDiskConfigKey(baseImage, options) {
  const payload = {
    baseImageName: baseImage.name,
    baseImageSize: baseImage.size,
    baseImageUpdatedAt: baseImage.updatedAt,
    packageId: options.packageId,
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
    `游戏包: ${selectedPackage?.name || "无"}`,
    `常规内存优化: ${options.optimizeMemory ? "开" : "关"}`,
    `DOSIDLE: ${options.includeDosIdle ? "开" : "关"}`,
    `CD 驱动: ${options.includeCdDriver ? "开" : "关"}`,
    `MSCDEX: ${options.includeMscdex ? "开" : "关"}`,
    `自动执行游戏: ${options.autoRunGame ? "开" : "关"}`
  ];

  if (selectedPackage?.id === "pal95") {
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
    url: `/startup-floppy-disks/${encodeURIComponent(record.imageFileName)}`,
    catalog: "storage/startupFloppyDisk",
    options: record.options || {}
  };
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
