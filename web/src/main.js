import { CanvasTerminal } from "./core/canvas-terminal.js";
import { EmulatorRuntime } from "./emulator/emulator-runtime.js";

const elements = {
  bootButton: document.querySelector("#boot-button"),
  closeStartupPreviewDialogButton: document.querySelector("#close-startup-preview-dialog"),
  cpuProfile: document.querySelector("#cpu-profile"),
  eventLog: document.querySelector("#event-log"),
  fileInput: document.querySelector("#image-file"),
  gamePackageSelect: document.querySelector("#game-package-select"),
  heroStatus: document.querySelector("#hero-status"),
  imageSource: document.querySelector("#image-source"),
  imageStatus: document.querySelector("#image-status"),
  memorySize: document.querySelector("#memory-size"),
  pauseButton: document.querySelector("#pause-button"),
  previewStartupButton: document.querySelector("#preview-startup-button"),
  profileSelect: document.querySelector("#profile-select"),
  refreshImagesButton: document.querySelector("#refresh-images-button"),
  resetButton: document.querySelector("#reset-button"),
  runtimeAssetsStatus: document.querySelector("#runtime-assets-status"),
  runtimeMode: document.querySelector("#runtime-mode"),
  screen: document.querySelector("#dos-screen"),
  serverImageField: document.querySelector("#server-image-field"),
  serverImageSelect: document.querySelector("#server-image-select"),
  soundEnabled: document.querySelector("#sound-enabled"),
  startupDiskAutoRun: document.querySelector("#startup-disk-auto-run"),
  startupDiskCdrom: document.querySelector("#startup-disk-cdrom"),
  startupDiskDosIdle: document.querySelector("#startup-disk-dosidle"),
  startupDiskMscdex: document.querySelector("#startup-disk-mscdex"),
  startupDiskNote: document.querySelector("#startup-disk-note"),
  startupDiskOptimizeMemory: document.querySelector("#startup-disk-optimize-memory"),
  startupDiskSound: document.querySelector("#startup-disk-sound"),
  startupDiskSwitchC: document.querySelector("#startup-disk-switch-c"),
  startupPreviewAutoexec: document.querySelector("#startup-preview-autoexec"),
  startupPreviewConfig: document.querySelector("#startup-preview-config"),
  startupPreviewDialog: document.querySelector("#startup-preview-dialog"),
  startupPreviewSummary: document.querySelector("#startup-preview-summary"),
  systemDiskDescription: document.querySelector("#system-disk-description"),
  uploadImageField: document.querySelector("#upload-image-field"),
  v86Screen: document.querySelector("#v86-screen")
};

const terminal = new CanvasTerminal(elements.screen);
const display = createDisplayManager(elements.screen, elements.v86Screen);
const runtime = new EmulatorRuntime(terminal, {
  onLifecycle: updateLifecycle
});
const SETTINGS_KEY = "msdos-simulator-settings";
const DEFAULT_SYSTEM_DISK_NAME = "msdos622_dosidle_a.img";

let profiles = [];
let systemDiskImages = [];
let availableGamePackages = [];
let runtimeAssets = null;
let activeLocalImage = null;
let inputBuffer = "";

bootstrap().catch((error) => {
  appendLog(`初始化失败: ${error.message}`);
});

async function bootstrap() {
  // 步骤 1：先绑定事件和待机画面，让页面在异步资源返回前就绪。
  bindEvents();
  terminal.renderStatus("MS-DOS 6.0 Simulator", "正在检测 v86 运行时与系统盘目录...");
  syncPauseButton();

  // 步骤 2：并行加载配置、系统盘、扩展硬盘与 v86 运行时状态。
  const [profileItems, baseImages, gamePackages, assets] = await Promise.all([
    fetchJson("/api/profiles"),
    fetchJson("/api/base-disk-images"),
    fetchJson("/api/game-packages"),
    fetchJson("/api/runtime-assets")
  ]);

  profiles = profileItems;
  systemDiskImages = baseImages;
  availableGamePackages = gamePackages;
  runtimeAssets = assets;

  populateProfiles(profiles);
  populateSystemDiskImages(systemDiskImages);
  populateGamePackages(availableGamePackages);
  applyRuntimeAssets(runtimeAssets);
  syncImageSource();
  syncSelectedImageStatus();

  elements.runtimeMode.textContent = "适配器: v86";
  loadSettings();

  terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择系统盘并确认脚本参数后启动。");
  appendLog("系统已就绪，当前流程为：选择系统盘 -> 调整 CONFIG/AUTOEXEC 参数 -> 预览或直接启动。");
}

function bindEvents() {
  elements.fileInput.addEventListener("change", handleFileSelected);
  elements.imageSource.addEventListener("change", () => {
    syncImageSource();
    saveSettings();
  });
  elements.pauseButton.addEventListener("click", handlePauseToggle);
  elements.profileSelect.addEventListener("change", () => {
    syncProfileSelection();
    saveSettings();
  });
  elements.serverImageSelect.addEventListener("change", () => {
    syncSelectedImageStatus();
    saveSettings();
  });
  elements.gamePackageSelect.addEventListener("change", () => {
    syncStartupOptionDefaults();
    saveSettings();
  });
  elements.memorySize.addEventListener("change", saveSettings);
  elements.cpuProfile.addEventListener("change", saveSettings);
  elements.soundEnabled.addEventListener("change", saveSettings);
  elements.startupDiskNote.addEventListener("change", () => {
    syncSelectedImageStatus();
    saveSettings();
  });
  elements.previewStartupButton.addEventListener("click", handlePreviewStartupScripts);
  elements.refreshImagesButton.addEventListener("click", refreshSystemDiskImages);
  elements.bootButton.addEventListener("click", handleBoot);
  elements.resetButton.addEventListener("click", handleReset);
  elements.closeStartupPreviewDialogButton.addEventListener("click", () => elements.startupPreviewDialog.close());

  for (const element of [
    elements.startupDiskOptimizeMemory,
    elements.startupDiskAutoRun,
    elements.startupDiskSound,
    elements.startupDiskDosIdle,
    elements.startupDiskCdrom,
    elements.startupDiskMscdex,
    elements.startupDiskSwitchC
  ]) {
    element.addEventListener("change", () => {
      syncStartupOptionStates();
      syncSelectedImageStatus();
      saveSettings();
    });
  }

  window.addEventListener("keydown", async (event) => {
    if (!["Backspace", "Enter"].includes(event.key) && event.key.length !== 1) {
      return;
    }

    if (!runtime.currentAdapter || !runtime.shouldCaptureKeyboard()) {
      return;
    }

    event.preventDefault();

    if (event.key === "Backspace") {
      inputBuffer = inputBuffer.slice(0, -1);
      terminal.setInputBuffer(inputBuffer);
      return;
    }

    if (event.key === "Enter") {
      const command = inputBuffer;
      inputBuffer = "";
      terminal.setInputBuffer("");
      await runtime.handleCommand(command);
      return;
    }

    inputBuffer += event.key;
    terminal.setInputBuffer(inputBuffer);
  });
}

async function handleFileSelected(event) {
  const [file] = event.target.files;

  if (!file) {
    activeLocalImage = null;
    syncSelectedImageStatus();
    return;
  }

  // 步骤 1：读取本地镜像头部，快速判断它是否具备标准引导扇区签名。
  const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const hasBootSignature = header[510] === 0x55 && header[511] === 0xaa;

  activeLocalImage = {
    file,
    name: file.name,
    size: file.size,
    sizeLabel: formatBytes(file.size),
    hasBootSignature,
    driveType: inferDriveType(file.name, file.size)
  };

  // 步骤 2：把本地镜像元信息和当前参数记入会话表，为后续兼容性定位保留上下文。
  await fetchJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      imageMeta: activeLocalImage,
      config: collectConfig()
    })
  });

  appendLog(`已载入本地镜像: ${file.name} (${activeLocalImage.sizeLabel})，Boot Signature: ${hasBootSignature ? "0x55AA" : "缺失"}`);
  syncSelectedImageStatus();
}

async function handlePreviewStartupScripts() {
  try {
    const preview = await fetchStartupPreview();
    elements.startupPreviewSummary.textContent = `${preview.description} | 复用键: ${preview.configKey}`;
    if (preview.note) {
      elements.startupPreviewSummary.textContent = `${elements.startupPreviewSummary.textContent} | 备注: ${preview.note}`;
    }
    elements.startupPreviewConfig.value = preview.configSys;
    elements.startupPreviewAutoexec.value = preview.autoexecBat;
    elements.startupPreviewDialog.showModal();
    appendLog(`已预览系统盘脚本: ${preview.systemDiskName} -> ${preview.startupDiskName}`);
  } catch (error) {
    appendLog(`预览脚本失败: ${error.message}`);
  }
}

async function handleBoot() {
  try {
    const selectedProfile = profiles.find((profile) => profile.id === elements.profileSelect.value) || profiles[0];
    const config = collectConfig(selectedProfile);
    const selectedImage = resolveSelectedImage();
    let bootDisk = selectedImage;

    if (elements.imageSource.value === "server") {
      // 步骤 1：启动前根据系统盘和脚本参数查找可复用成品盘；没有命中时再生成新的启动盘。
      const resolvedStartupDisk = await fetchJson("/api/startup-disks", {
        method: "POST",
        body: JSON.stringify(buildStartupRequestPayload())
      });

      appendLog(`${resolvedStartupDisk.reused ? "复用" : "生成"}系统启动盘: ${resolvedStartupDisk.disk.name}`);
      appendLog(`系统盘路径: ${resolvedStartupDisk.paths.baseImagePath}`);
      appendLog(`启动盘路径: ${resolvedStartupDisk.paths.bootDiskPath}`);
      appendLog(`启动盘索引: ${resolvedStartupDisk.paths.metadataPath}`);
      appendLog(`启动盘说明: ${resolvedStartupDisk.preview.description}`);
      if (resolvedStartupDisk.disk.note) {
        appendLog(`系统盘备注: ${resolvedStartupDisk.disk.note}`);
      }

      bootDisk = {
        imageMeta: resolvedStartupDisk.disk,
        diskImage: {
          source: "server",
          name: resolvedStartupDisk.disk.name,
          size: resolvedStartupDisk.disk.size,
          url: resolvedStartupDisk.disk.url,
          driveType: resolvedStartupDisk.disk.driveType
        }
      };
    }

    const attachments = await resolveSelectedAttachments(config);
    inputBuffer = "";
    terminal.setInputBuffer("");
    elements.runtimeMode.textContent = "适配器: v86";

    appendLog(`准备启动: adapter=v86, image=${bootDisk.imageMeta.name}, profile=${selectedProfile?.name || "custom"}, attachments=${attachments.length}`);
    appendCompatibilityLogs(attachments);

    await runtime.boot({
      adapterType: "v86",
      attachments,
      config,
      display,
      diskImage: bootDisk.diskImage,
      imageMeta: bootDisk.imageMeta,
      onLog: appendLog,
      profile: selectedProfile,
      runtimeAssets
    });

    syncPauseButton();
  } catch (error) {
    appendLog(`启动前检查失败: ${error.message}`);
  }
}

async function handleReset() {
  inputBuffer = "";
  terminal.setInputBuffer("");
  await runtime.reset();
  syncPauseButton();
  appendLog("会话已重置。");
}

async function handlePauseToggle() {
  if (runtime.isPaused()) {
    await runtime.resume("手动恢复");
    appendLog("模拟器已手动恢复。");
  } else if (runtime.isRunning()) {
    await runtime.pause("手动暂停");
    appendLog("模拟器已手动暂停。");
  }

  syncPauseButton();
}

async function refreshSystemDiskImages() {
  const previousSelection = elements.serverImageSelect.value;
  systemDiskImages = await fetchJson("/api/base-disk-images");
  populateSystemDiskImages(systemDiskImages);

  if (previousSelection && systemDiskImages.some((image) => image.name === previousSelection)) {
    elements.serverImageSelect.value = previousSelection;
  }

  syncSelectedImageStatus();
  appendLog(`系统盘目录已刷新，当前共 ${systemDiskImages.length} 个。`);
}

function syncProfileSelection() {
  const profile = profiles.find((item) => item.id === elements.profileSelect.value);

  if (!profile) {
    return;
  }

  elements.memorySize.value = String(profile.memoryMb);
  elements.cpuProfile.value = profile.cpuProfile;
  elements.soundEnabled.checked = Boolean(profile.soundEnabled);

  if (profile.id === "pal95" && Array.from(elements.gamePackageSelect.options).some((option) => option.value === "pal95")) {
    elements.gamePackageSelect.value = "pal95";
    applyPal95StartupDefaults();
    appendLog("仙剑 95 兼容预设默认使用静音启动和最小系统盘脚本。");
  }
}

function applyPal95StartupDefaults() {
  elements.startupDiskOptimizeMemory.checked = true;
  elements.startupDiskAutoRun.checked = true;
  elements.startupDiskSound.checked = false;
  elements.startupDiskDosIdle.checked = false;
  elements.startupDiskCdrom.checked = false;
  elements.startupDiskMscdex.checked = false;
  elements.startupDiskSwitchC.checked = true;
  syncStartupOptionStates();
}

function syncStartupOptionDefaults() {
  if (elements.gamePackageSelect.value === "pal95") {
    applyPal95StartupDefaults();
    return;
  }

  syncStartupOptionStates();
}

function syncStartupOptionStates() {
  const hasPackage = Boolean(elements.gamePackageSelect.value);
  elements.startupDiskAutoRun.disabled = !hasPackage;
  elements.startupDiskSound.disabled = elements.gamePackageSelect.value !== "pal95";

  if (!hasPackage) {
    elements.startupDiskAutoRun.checked = false;
    elements.startupDiskSound.checked = false;
  }
}

function syncImageSource() {
  const useServerImage = elements.imageSource.value === "server";
  elements.serverImageField.classList.toggle("hidden", !useServerImage);
  elements.systemDiskDescription.classList.toggle("hidden", !useServerImage);
  elements.previewStartupButton.disabled = !useServerImage;
  elements.uploadImageField.classList.toggle("hidden", useServerImage);
  syncSelectedImageStatus();
}

function collectConfig(profile = null) {
  return {
    memoryMb: Number(elements.memorySize.value || profile?.memoryMb || 16),
    cpuProfile: elements.cpuProfile.value || profile?.cpuProfile || "486dx2",
    soundEnabled: elements.soundEnabled.checked
  };
}

function buildStartupRequestPayload() {
  return {
    baseImageName: elements.serverImageSelect.value,
    packageId: elements.gamePackageSelect.value || "",
    soundEnabled: elements.startupDiskSound.checked,
    optimizeMemory: elements.startupDiskOptimizeMemory.checked,
    includeDosIdle: elements.startupDiskDosIdle.checked,
    includeCdDriver: elements.startupDiskCdrom.checked,
    includeMscdex: elements.startupDiskMscdex.checked,
    note: elements.startupDiskNote.value.trim(),
    autoSwitchToCDrive: elements.startupDiskSwitchC.checked,
    autoRunGame: elements.startupDiskAutoRun.checked
  };
}

async function fetchStartupPreview() {
  if (elements.imageSource.value !== "server") {
    throw new Error("预览脚本仅支持服务端系统盘。");
  }

  if (!elements.serverImageSelect.value) {
    throw new Error("请先选择系统盘镜像。");
  }

  return fetchJson("/api/startup-disks/preview", {
    method: "POST",
    body: JSON.stringify(buildStartupRequestPayload())
  });
}

function populateProfiles(items) {
  const fallbackProfiles = items.length > 0 ? items : [
    { id: "dos-default", name: "MS-DOS 6.0 默认", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true },
    { id: "pal95", name: "仙剑 95 兼容预设", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: false }
  ];

  elements.profileSelect.innerHTML = fallbackProfiles.map((profile) => `<option value="${profile.id}">${profile.name}</option>`).join("");
  profiles = fallbackProfiles;
  syncProfileSelection();
}

function populateSystemDiskImages(items) {
  if (items.length === 0) {
    elements.serverImageSelect.innerHTML = '<option value="">系统盘目录暂无镜像</option>';
    return;
  }

  elements.serverImageSelect.innerHTML = items.map((image) => `<option value="${image.name}">${image.name} · ${image.sizeLabel} · ${image.driveType}</option>`).join("");
  const preferredImage = items.find((image) => image.name.toLowerCase() === DEFAULT_SYSTEM_DISK_NAME);
  elements.serverImageSelect.value = preferredImage?.name || items[0].name;
}

function populateGamePackages(items) {
  const availableItems = items.filter((item) => item.available);
  elements.gamePackageSelect.innerHTML = ['<option value="">不挂载扩展硬盘</option>', ...availableItems.map((item) => `<option value="${item.id}">${item.name} · ${item.totalSizeLabel} · ${item.preferredSlot.toUpperCase()}</option>`)].join("");
  elements.gamePackageSelect.disabled = availableItems.length === 0;

  const preferredGamePackage = availableItems.find((item) => item.id === "pal95");
  if (preferredGamePackage) {
    elements.gamePackageSelect.value = preferredGamePackage.id;
    applyPal95StartupDefaults();
  }
}

function applyRuntimeAssets(assets) {
  if (assets?.v86?.ready) {
    elements.runtimeAssetsStatus.textContent = "v86 运行时已就绪";
    return;
  }

  const missing = assets?.v86?.missing?.join(", ") || "未知资源";
  elements.runtimeAssetsStatus.textContent = `v86 缺失: ${missing}`;
}

function updateLifecycle(status, context) {
  const labels = {
    idle: "引擎未启动",
    booting: "启动中",
    running: "运行中",
    paused: "已暂停",
    error: "启动失败"
  };

  elements.heroStatus.textContent = labels[status] || status;
  syncPauseButton();

  if (status === "error" && context?.error) {
    appendLog(`启动失败: ${context.error.message}`);
    return;
  }

  if (status === "paused" && context?.pauseReason) {
    appendLog(`生命周期切换: paused (${context.pauseReason})`);
    return;
  }

  if (status === "running" && context?.resumeReason) {
    appendLog(`生命周期切换: running (${context.resumeReason})`);
    return;
  }

  appendLog(`生命周期切换: ${status}`);
}

function resolveSelectedImage() {
  if (elements.imageSource.value === "server") {
    const selectedImage = systemDiskImages.find((image) => image.name === elements.serverImageSelect.value);

    if (!selectedImage) {
      throw new Error("服务端系统盘目录中未找到可启动镜像，请先把基础 DOS 盘放入 storage/images/。");
    }

    return {
      imageMeta: selectedImage,
      diskImage: {
        source: "server",
        name: selectedImage.name,
        size: selectedImage.size,
        url: selectedImage.url,
        driveType: selectedImage.driveType
      }
    };
  }

  if (!activeLocalImage) {
    throw new Error("请先选择本地镜像文件。");
  }

  return {
    imageMeta: activeLocalImage,
    diskImage: {
      source: "upload",
      name: activeLocalImage.name,
      size: activeLocalImage.size,
      file: activeLocalImage.file,
      driveType: activeLocalImage.driveType
    }
  };
}

async function resolveSelectedAttachments(config) {
  const selectedPackageId = elements.gamePackageSelect.value;

  if (!selectedPackageId) {
    return [];
  }

  const selectedPackage = availableGamePackages.find((item) => item.id === selectedPackageId && item.available);

  if (!selectedPackage) {
    throw new Error("所选扩展硬盘不可用，请先确认 pal95 游戏目录存在。");
  }

  // 步骤 3：启动前先在服务端把游戏目录固化为 FAT16 数据盘，避免前端直接处理大量原始文件。
  appendLog(`正在准备扩展硬盘: ${selectedPackage.name}`);
  const materializedPackage = await fetchJson(`/api/game-packages/${encodeURIComponent(selectedPackage.id)}/materialize`, {
    method: "POST",
    body: JSON.stringify({
      soundEnabled: Boolean(config?.soundEnabled)
    })
  });

  appendLog(`扩展硬盘已就绪: ${materializedPackage.name} -> ${materializedPackage.mount.preferredSlot.toUpperCase()} (${materializedPackage.mount.sizeLabel})，当前推荐命令为 ${materializedPackage.launchCommand.includes("RUNSAFE") ? "RUNSAFE" : "RUNPAL"}。`);
  if (materializedPackage.paths?.diskImagePath) {
    appendLog(`扩展硬盘路径: ${materializedPackage.paths.diskImagePath}`);
  }
  if (materializedPackage.paths?.metadataPath) {
    appendLog(`镜像元数据路径: ${materializedPackage.paths.metadataPath}`);
  }

  return [
    {
      id: materializedPackage.id,
      label: materializedPackage.name,
      launchCommand: materializedPackage.launchCommand,
      compatibility: materializedPackage.compatibility,
      preferredSlot: materializedPackage.mount.preferredSlot,
      diskImage: {
        source: "server",
        name: materializedPackage.mount.name,
        size: materializedPackage.mount.size,
        url: materializedPackage.mount.url,
        driveType: materializedPackage.mount.driveType
      }
    }
  ];
}

function syncSelectedImageStatus() {
  try {
    const selectedImage = resolveSelectedImage();
    elements.imageStatus.textContent = `${selectedImage.imageMeta.name} · ${selectedImage.imageMeta.sizeLabel || formatBytes(selectedImage.imageMeta.size)} · ${selectedImage.imageMeta.driveType}`;
    syncSystemDiskDescription(selectedImage.imageMeta);
  } catch (error) {
    elements.imageStatus.textContent = error.message.replace("Error: ", "");
    syncSystemDiskDescription(null);
  }
}

function syncSystemDiskDescription(systemDisk) {
  if (elements.imageSource.value !== "server") {
    elements.systemDiskDescription.textContent = "当前使用本地上传镜像，系统盘脚本参数仅对服务端系统盘生效。";
    return;
  }

  if (!systemDisk) {
    elements.systemDiskDescription.textContent = "请选择服务端系统盘镜像。";
    return;
  }

  const selectedPackage = availableGamePackages.find((item) => item.id === elements.gamePackageSelect.value);
  const packageLabel = selectedPackage?.name || "无扩展硬盘";
  const segments = [`系统盘: ${systemDisk.name}`, `游戏包: ${packageLabel}`];

  if (elements.startupDiskNote.value.trim()) {
    segments.push(`备注: ${elements.startupDiskNote.value.trim()}`);
  }

  elements.systemDiskDescription.textContent = segments.join(" | ");
}

function syncPauseButton() {
  if (!runtime.currentAdapter) {
    elements.pauseButton.textContent = "暂停";
    elements.pauseButton.disabled = true;
    return;
  }

  elements.pauseButton.textContent = runtime.isPaused() ? "继续" : "暂停";
  elements.pauseButton.disabled = false;
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[runtime ${timestamp}] ${message}`);
  elements.eventLog.textContent = `[${timestamp}] ${message}\n${elements.eventLog.textContent}`.trim();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  if (!response.ok) {
    let errorMessage = `Request failed: ${response.status}`;

    try {
      const payload = await response.json();
      if (payload?.message) {
        errorMessage = `${errorMessage} - ${payload.message}`;
      }
    } catch {
      // 响应体不是 JSON 时回退到默认状态码提示
    }

    throw new Error(errorMessage);
  }

  return response.json();
}

function formatBytes(size) {
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function inferDriveType(fileName, size) {
  const extension = fileName.toLowerCase().split(".").pop();

  if (extension === "iso") {
    return "cdrom";
  }

  if (size <= 2_949_120) {
    return "floppy";
  }

  return "hardDisk";
}

function saveSettings() {
  const settings = {
    imageSource: elements.imageSource.value,
    systemDisk: elements.serverImageSelect.value,
    profile: elements.profileSelect.value,
    gamePackage: elements.gamePackageSelect.value,
    memorySize: elements.memorySize.value,
    cpuProfile: elements.cpuProfile.value,
    soundEnabled: elements.soundEnabled.checked,
    startupDiskOptimizeMemory: elements.startupDiskOptimizeMemory.checked,
    startupDiskAutoRun: elements.startupDiskAutoRun.checked,
    startupDiskSound: elements.startupDiskSound.checked,
    startupDiskDosIdle: elements.startupDiskDosIdle.checked,
    startupDiskCdrom: elements.startupDiskCdrom.checked,
    startupDiskMscdex: elements.startupDiskMscdex.checked,
    startupDiskSwitchC: elements.startupDiskSwitchC.checked,
    startupDiskNote: elements.startupDiskNote.value
  };

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

function loadSettings() {
  let settings;

  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return;
  }

  if (!settings) {
    return;
  }

  if (settings.imageSource) {
    elements.imageSource.value = settings.imageSource;
  }

  if (settings.profile && Array.from(elements.profileSelect.options).some((opt) => opt.value === settings.profile)) {
    elements.profileSelect.value = settings.profile;
  }

  if (settings.systemDisk && Array.from(elements.serverImageSelect.options).some((opt) => opt.value === settings.systemDisk)) {
    elements.serverImageSelect.value = settings.systemDisk;
  }

  if (settings.gamePackage && Array.from(elements.gamePackageSelect.options).some((opt) => opt.value === settings.gamePackage)) {
    elements.gamePackageSelect.value = settings.gamePackage;
  }

  if (settings.memorySize) {
    elements.memorySize.value = settings.memorySize;
  }

  if (settings.cpuProfile) {
    elements.cpuProfile.value = settings.cpuProfile;
  }

  if (typeof settings.soundEnabled === "boolean") {
    elements.soundEnabled.checked = settings.soundEnabled;
  }

  for (const [key, element] of Object.entries({
    startupDiskOptimizeMemory: elements.startupDiskOptimizeMemory,
    startupDiskAutoRun: elements.startupDiskAutoRun,
    startupDiskSound: elements.startupDiskSound,
    startupDiskDosIdle: elements.startupDiskDosIdle,
    startupDiskCdrom: elements.startupDiskCdrom,
    startupDiskMscdex: elements.startupDiskMscdex,
    startupDiskSwitchC: elements.startupDiskSwitchC
  })) {
    if (typeof settings[key] === "boolean") {
      element.checked = settings[key];
    }
  }

  if (elements.profileSelect.value === "pal95") {
    elements.soundEnabled.checked = false;
  }

  if (typeof settings.startupDiskNote === "string") {
    elements.startupDiskNote.value = settings.startupDiskNote;
  }

  syncStartupOptionStates();
  syncImageSource();
  syncSelectedImageStatus();
}

function appendCompatibilityLogs(attachments) {
  for (const attachment of attachments) {
    if (!attachment.compatibility) {
      continue;
    }

    const compatibilityLines = Object.entries(attachment.compatibility).map(([key, item]) => `${key}=${item.level}`);
    appendLog(`兼容性画像: ${attachment.label} -> ${compatibilityLines.join(", ")}`);
  }
}

function createDisplayManager(canvas, v86Screen) {
  return {
    showTerminal() {
      canvas.classList.remove("hidden");
      v86Screen.classList.add("hidden");
    },
    mountV86Surface() {
      canvas.classList.add("hidden");
      v86Screen.classList.remove("hidden");
      v86Screen.innerHTML = "";

      const surface = document.createElement("div");
      surface.className = "v86-surface";
      v86Screen.append(surface);
      window.requestAnimationFrame(() => {
        v86Screen.focus();
      });
      return surface;
    },
    clearV86Surface() {
      v86Screen.innerHTML = "";
    },
    focusV86Surface() {
      v86Screen.focus();
    }
  };
}
