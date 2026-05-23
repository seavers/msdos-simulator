import { CanvasTerminal } from "./core/canvas-terminal.js";
import { EmulatorRuntime } from "./emulator/emulator-runtime.js";

const elements = {
  baseDiskSelect: document.querySelector("#base-disk-select"),
  bootButton: document.querySelector("#boot-button"),
  closeStartupDiskDialogButton: document.querySelector("#close-startup-disk-dialog"),
  cpuProfile: document.querySelector("#cpu-profile"),
  eventLog: document.querySelector("#event-log"),
  fileInput: document.querySelector("#image-file"),
  gamePackageSelect: document.querySelector("#game-package-select"),
  generateBootButton: document.querySelector("#generate-boot-button"),
  heroStatus: document.querySelector("#hero-status"),
  imageSource: document.querySelector("#image-source"),
  imageStatus: document.querySelector("#image-status"),
  memorySize: document.querySelector("#memory-size"),
  pauseButton: document.querySelector("#pause-button"),
  profileSelect: document.querySelector("#profile-select"),
  refreshImagesButton: document.querySelector("#refresh-images-button"),
  resetButton: document.querySelector("#reset-button"),
  runtimeAssetsStatus: document.querySelector("#runtime-assets-status"),
  runtimeMode: document.querySelector("#runtime-mode"),
  screen: document.querySelector("#dos-screen"),
  serverImageField: document.querySelector("#server-image-field"),
  serverImageSelect: document.querySelector("#server-image-select"),
  soundEnabled: document.querySelector("#sound-enabled"),
  startupDialog: document.querySelector("#startup-disk-dialog"),
  startupDiskAutoRun: document.querySelector("#startup-disk-auto-run"),
  startupDiskCdrom: document.querySelector("#startup-disk-cdrom"),
  startupDiskDescription: document.querySelector("#startup-disk-description"),
  startupDiskDosIdle: document.querySelector("#startup-disk-dosidle"),
  startupDiskMscdex: document.querySelector("#startup-disk-mscdex"),
  startupDiskName: document.querySelector("#startup-disk-name"),
  startupDiskNote: document.querySelector("#startup-disk-note"),
  startupDiskOptimizeMemory: document.querySelector("#startup-disk-optimize-memory"),
  startupDiskPackageSelect: document.querySelector("#startup-disk-package-select"),
  startupDiskSound: document.querySelector("#startup-disk-sound"),
  startupDiskSubmitButton: document.querySelector("#startup-disk-submit-button"),
  startupDiskSwitchC: document.querySelector("#startup-disk-switch-c"),
  uploadImageField: document.querySelector("#upload-image-field"),
  v86Screen: document.querySelector("#v86-screen")
};

const terminal = new CanvasTerminal(elements.screen);
const display = createDisplayManager(elements.screen, elements.v86Screen);
const runtime = new EmulatorRuntime(terminal, {
  onLifecycle: updateLifecycle
});
const SETTINGS_KEY = "msdos-simulator-settings";
const DEFAULT_BASE_DISK_NAME = "msdos622_dosidle_a.img";

let profiles = [];
let baseDiskImages = [];
let startupDisks = [];
let availableGamePackages = [];
let runtimeAssets = null;
let activeLocalImage = null;
let inputBuffer = "";

bootstrap().catch((error) => {
  appendLog(`初始化失败: ${error.message}`);
});

async function bootstrap() {
  // 步骤 1：先绑定事件和默认待机画面，让页面可以在异步资源返回前就绪。
  bindEvents();
  terminal.renderStatus("MS-DOS 6.0 Simulator", "正在检测 v86 运行时、基础盘目录和启动盘目录...");
  syncPauseButton();

  // 步骤 2：并行加载配置、基础盘、启动盘、扩展硬盘清单和 v86 运行时状态。
  const [profileItems, baseImages, startupDiskItems, gamePackages, assets] = await Promise.all([
    fetchJson("/api/profiles"),
    fetchJson("/api/base-disk-images"),
    fetchJson("/api/startup-disks"),
    fetchJson("/api/game-packages"),
    fetchJson("/api/runtime-assets")
  ]);

  profiles = profileItems;
  baseDiskImages = baseImages;
  startupDisks = startupDiskItems;
  availableGamePackages = gamePackages;
  runtimeAssets = assets;

  populateProfiles(profiles);
  populateBaseDiskOptions(baseDiskImages);
  populateStartupDisks(startupDisks);
  populateGamePackages(availableGamePackages);
  populateStartupDiskPackageOptions(availableGamePackages);
  applyRuntimeAssets(runtimeAssets);
  syncImageSource();
  syncSelectedImageStatus();

  // 步骤 3：标记当前适配器，并恢复上次保存的选择项。
  elements.runtimeMode.textContent = "适配器: v86";
  loadSettings();

  terminal.renderStatus("MS-DOS 6.0 Simulator", "请先生成或选择启动盘，再点击启动。");
  appendLog("系统已就绪，当前流程为：选择基础盘 -> 生成启动盘 -> 选择启动盘 -> 启动。");
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
  elements.gamePackageSelect.addEventListener("change", saveSettings);
  elements.memorySize.addEventListener("change", saveSettings);
  elements.cpuProfile.addEventListener("change", saveSettings);
  elements.soundEnabled.addEventListener("change", saveSettings);
  elements.generateBootButton.addEventListener("click", openStartupDiskDialog);
  elements.refreshImagesButton.addEventListener("click", () => refreshStartupDisks({ announce: true }));
  elements.bootButton.addEventListener("click", handleBoot);
  elements.resetButton.addEventListener("click", handleReset);
  elements.closeStartupDiskDialogButton.addEventListener("click", closeStartupDiskDialog);
  elements.startupDiskSubmitButton.addEventListener("click", handleGenerateStartupDisk);
  elements.startupDiskPackageSelect.addEventListener("change", syncStartupDialogOptions);

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

async function handleBoot() {
  try {
    const selectedProfile = profiles.find((profile) => profile.id === elements.profileSelect.value) || profiles[0];
    const config = collectConfig(selectedProfile);
    const selectedImage = resolveSelectedImage();

    const requiresBoundPackage = selectedImage.imageMeta.options?.autoRunGame || selectedImage.imageMeta.options?.autoSwitchToCDrive;

    if (elements.imageSource.value === "server" && requiresBoundPackage && selectedImage.imageMeta.packageId && selectedImage.imageMeta.packageId !== elements.gamePackageSelect.value) {
      throw new Error(`所选启动盘绑定了 ${selectedImage.imageMeta.packageName}，请在“扩展硬盘”中选择相同游戏包。`);
    }

    const attachments = await resolveSelectedAttachments(config);
    inputBuffer = "";
    terminal.setInputBuffer("");
    elements.runtimeMode.textContent = "适配器: v86";

    appendLog(`准备启动: adapter=v86, image=${selectedImage.imageMeta.name}, profile=${selectedProfile?.name || "custom"}, attachments=${attachments.length}`);
    appendCompatibilityLogs(attachments);

    await runtime.boot({
      adapterType: "v86",
      attachments,
      config,
      display,
      diskImage: selectedImage.diskImage,
      imageMeta: selectedImage.imageMeta,
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

async function openStartupDiskDialog() {
  if (elements.imageSource.value !== "server") {
    elements.imageSource.value = "server";
    syncImageSource();
    appendLog("生成启动盘仅支持服务端基础盘，已切换到服务端镜像模式。");
  }

  // 步骤 1：打开弹出层前刷新基础盘和启动盘目录，保证用户看到的都是最新内容。
  await Promise.all([
    refreshBaseDiskImages({ announce: false, preserveSelection: true }),
    refreshStartupDisks({ announce: false, preserveSelection: true })
  ]);

  populateStartupDiskPackageOptions(availableGamePackages);
  elements.startupDiskPackageSelect.value = elements.gamePackageSelect.value || "pal95";
  elements.startupDiskOptimizeMemory.checked = true;
  elements.startupDiskSound.checked = false;
  elements.startupDiskDosIdle.checked = false;
  elements.startupDiskCdrom.checked = false;
  elements.startupDiskMscdex.checked = false;
  elements.startupDiskSwitchC.checked = true;
  elements.startupDiskAutoRun.checked = Boolean(elements.startupDiskPackageSelect.value);
  elements.startupDiskName.value = "";
  elements.startupDiskNote.value = "";
  syncStartupDialogOptions();
  elements.startupDialog.showModal();
}

function closeStartupDiskDialog() {
  elements.startupDialog.close();
}

async function handleGenerateStartupDisk() {
  try {
    const selectedPackageId = elements.startupDiskPackageSelect.value;
    const payload = {
      baseImageName: elements.baseDiskSelect.value,
      packageId: selectedPackageId,
      displayName: elements.startupDiskName.value.trim(),
      note: elements.startupDiskNote.value.trim(),
      soundEnabled: elements.startupDiskSound.checked,
      optimizeMemory: elements.startupDiskOptimizeMemory.checked,
      includeDosIdle: elements.startupDiskDosIdle.checked,
      includeCdDriver: elements.startupDiskCdrom.checked,
      includeMscdex: elements.startupDiskMscdex.checked,
      autoSwitchToCDrive: elements.startupDiskSwitchC.checked,
      autoRunGame: elements.startupDiskAutoRun.checked
    };

    appendLog(`开始生成启动盘，基础盘=${payload.baseImageName}，游戏包=${selectedPackageId || "无"}`);
    const generatedResult = await fetchJson("/api/startup-disks", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    // 步骤 2：生成完成后刷新启动盘列表，并自动把新盘设为当前启动目标。
    await refreshStartupDisks({ announce: false, preserveSelection: false });
    elements.serverImageSelect.value = generatedResult.disk.id;
    elements.imageSource.value = "server";
    elements.gamePackageSelect.value = selectedPackageId || "";
    syncImageSource();
    syncSelectedImageStatus();
    saveSettings();
    closeStartupDiskDialog();

    appendLog(`启动盘已生成: ${generatedResult.disk.name}`);
    appendLog(`基础盘路径: ${generatedResult.paths.baseImagePath}`);
    appendLog(`启动盘路径: ${generatedResult.paths.bootDiskPath}`);
    appendLog(`启动盘索引: ${generatedResult.paths.metadataPath}`);
  } catch (error) {
    appendLog(`生成启动盘失败: ${error.message}`);
  }
}

async function refreshBaseDiskImages({ announce = false, preserveSelection = true } = {}) {
  const previousSelection = elements.baseDiskSelect.value;
  baseDiskImages = await fetchJson("/api/base-disk-images");
  populateBaseDiskOptions(baseDiskImages);

  if (preserveSelection && previousSelection && baseDiskImages.some((image) => image.name === previousSelection)) {
    elements.baseDiskSelect.value = previousSelection;
  }

  if (announce) {
    appendLog(`基础盘目录已刷新，当前共 ${baseDiskImages.length} 个。`);
  }
}

async function refreshStartupDisks({ announce = false, preserveSelection = true } = {}) {
  const previousSelection = elements.serverImageSelect.value;
  startupDisks = await fetchJson("/api/startup-disks");
  populateStartupDisks(startupDisks);

  if (preserveSelection && previousSelection && startupDisks.some((image) => image.id === previousSelection)) {
    elements.serverImageSelect.value = previousSelection;
  }

  syncSelectedImageStatus();

  if (announce) {
    appendLog(`启动盘目录已刷新，当前共 ${startupDisks.length} 个。`);
  }
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
    appendLog("仙剑 95 兼容预设默认使用静音启动，用于绕过 PLAY 模块报错。");
  }
}

function syncImageSource() {
  const useServerImage = elements.imageSource.value === "server";
  elements.serverImageField.classList.toggle("hidden", !useServerImage);
  elements.startupDiskDescription.classList.toggle("hidden", !useServerImage);
  elements.uploadImageField.classList.toggle("hidden", useServerImage);
  syncSelectedImageStatus();
}

function syncStartupDialogOptions() {
  const selectedPackageId = elements.startupDiskPackageSelect.value;
  const hasPackage = Boolean(selectedPackageId);
  elements.startupDiskAutoRun.disabled = !hasPackage;
  elements.startupDiskSound.disabled = selectedPackageId !== "pal95";

  if (!hasPackage) {
    elements.startupDiskAutoRun.checked = false;
    elements.startupDiskSound.checked = false;
    elements.startupDiskCdrom.checked = false;
    elements.startupDiskMscdex.checked = false;
    elements.startupDiskDosIdle.checked = false;
    elements.startupDiskOptimizeMemory.checked = true;
  } else if (selectedPackageId === "pal95") {
    // 步骤 1：PAL95 默认优先走最小环境，先把常规内存腾出来，再逐步加回 DOSIDLE / 光驱 / 声卡变量。
    elements.startupDiskOptimizeMemory.checked = true;
    elements.startupDiskCdrom.checked = false;
    elements.startupDiskMscdex.checked = false;
    elements.startupDiskDosIdle.checked = false;
    elements.startupDiskSound.checked = false;
  }
}

function collectConfig(profile = null) {
  return {
    memoryMb: Number(elements.memorySize.value || profile?.memoryMb || 16),
    cpuProfile: elements.cpuProfile.value || profile?.cpuProfile || "486dx2",
    soundEnabled: elements.soundEnabled.checked
  };
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

function populateBaseDiskOptions(items) {
  if (items.length === 0) {
    elements.baseDiskSelect.innerHTML = '<option value="">基础盘目录暂无镜像</option>';
    return;
  }

  elements.baseDiskSelect.innerHTML = items.map((image) => `<option value="${image.name}">${image.name} · ${image.sizeLabel} · ${image.driveType}</option>`).join("");
  const preferredImage = items.find((image) => image.name.toLowerCase() === DEFAULT_BASE_DISK_NAME);
  elements.baseDiskSelect.value = preferredImage?.name || items[0].name;
}

function populateStartupDisks(items) {
  if (items.length === 0) {
    elements.serverImageSelect.innerHTML = '<option value="">启动盘目录暂无镜像</option>';
    return;
  }

  elements.serverImageSelect.innerHTML = items.map((image) => {
    const packageName = image.packageName || "通用 DOS";
    return `<option value="${image.id}">${image.name} · ${image.sizeLabel} · ${packageName} · ${image.catalog}</option>`;
  }).join("");
}

function populateGamePackages(items) {
  const availableItems = items.filter((item) => item.available);
  elements.gamePackageSelect.innerHTML = ['<option value="">不挂载扩展硬盘</option>', ...availableItems.map((item) => `<option value="${item.id}">${item.name} · ${item.totalSizeLabel} · ${item.preferredSlot.toUpperCase()}</option>`)].join("");
  elements.gamePackageSelect.disabled = availableItems.length === 0;

  const preferredGamePackage = availableItems.find((item) => item.id === "pal95");
  if (preferredGamePackage) {
    elements.gamePackageSelect.value = preferredGamePackage.id;
  }
}

function populateStartupDiskPackageOptions(items) {
  const availableItems = items.filter((item) => item.available);
  elements.startupDiskPackageSelect.innerHTML = ['<option value="">不绑定扩展硬盘</option>', ...availableItems.map((item) => `<option value="${item.id}">${item.name}</option>`)].join("");
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
    const selectedImage = startupDisks.find((image) => image.id === elements.serverImageSelect.value);

    if (!selectedImage) {
      throw new Error("启动盘目录中未找到可启动镜像，请先点击“生成启动盘”。");
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

  // 步骤 1：启动前先在服务端把游戏目录固化为 FAT16 数据盘，避免前端直接处理大量原始文件。
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
    syncStartupDiskDescription(selectedImage.imageMeta);
  } catch (error) {
    elements.imageStatus.textContent = error.message.replace("Error: ", "");
    syncStartupDiskDescription(null);
  }
}

function syncStartupDiskDescription(startupDisk) {
  if (elements.imageSource.value !== "server") {
    elements.startupDiskDescription.textContent = "当前使用本地上传镜像，启动盘说明仅对服务端生成盘生效。";
    return;
  }

  if (!startupDisk) {
    elements.startupDiskDescription.textContent = "请选择或生成启动盘镜像，启动时只会使用这里选中的成品盘。";
    return;
  }

  elements.startupDiskDescription.textContent = startupDisk.description || `基础盘: ${startupDisk.baseImageName || "未知"}。`;
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
    startupDisk: elements.serverImageSelect.value,
    profile: elements.profileSelect.value,
    gamePackage: elements.gamePackageSelect.value,
    memorySize: elements.memorySize.value,
    cpuProfile: elements.cpuProfile.value,
    soundEnabled: elements.soundEnabled.checked
  };

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage 不可用（如隐私模式）时静默忽略
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
    syncImageSource();
  }

  if (settings.profile && Array.from(elements.profileSelect.options).some((opt) => opt.value === settings.profile)) {
    elements.profileSelect.value = settings.profile;
  }

  const savedStartupDisk = settings.startupDisk || settings.serverImage;
  if (savedStartupDisk && Array.from(elements.serverImageSelect.options).some((opt) => opt.value === savedStartupDisk)) {
    elements.serverImageSelect.value = savedStartupDisk;
  } else if (settings.serverImage) {
    const legacyDisk = startupDisks.find((disk) => disk.name === settings.serverImage);
    if (legacyDisk) {
      elements.serverImageSelect.value = legacyDisk.id;
    }
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

  // 步骤 4：pal95 当前优先保证“能进游戏”，因此在读取旧设置后仍强制回到静音兼容默认值。
  if (elements.profileSelect.value === "pal95") {
    elements.soundEnabled.checked = false;
  }

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
