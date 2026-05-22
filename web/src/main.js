import { CanvasTerminal } from "./core/canvas-terminal.js";
import { EmulatorRuntime } from "./emulator/emulator-runtime.js";

const elements = {
  adapterSelect: document.querySelector("#adapter-select"),
  bootButton: document.querySelector("#boot-button"),
  cpuProfile: document.querySelector("#cpu-profile"),
  eventLog: document.querySelector("#event-log"),
  fileInput: document.querySelector("#image-file"),
  heroStatus: document.querySelector("#hero-status"),
  imageSource: document.querySelector("#image-source"),
  imageStatus: document.querySelector("#image-status"),
  gamePackageSelect: document.querySelector("#game-package-select"),
  memorySize: document.querySelector("#memory-size"),
  pauseButton: document.querySelector("#pause-button"),
  powerSaveEnabled: document.querySelector("#power-save-enabled"),
  promptIdleEnabled: document.querySelector("#prompt-idle-enabled"),
  profileSelect: document.querySelector("#profile-select"),
  refreshImagesButton: document.querySelector("#refresh-images-button"),
  resetButton: document.querySelector("#reset-button"),
  runtimeAssetsStatus: document.querySelector("#runtime-assets-status"),
  runtimeMode: document.querySelector("#runtime-mode"),
  screen: document.querySelector("#dos-screen"),
  serverImageField: document.querySelector("#server-image-field"),
  serverImageSelect: document.querySelector("#server-image-select"),
  soundEnabled: document.querySelector("#sound-enabled"),
  autoLaunchEnabled: document.querySelector("#auto-launch-enabled"),
  uploadImageField: document.querySelector("#upload-image-field"),
  v86Screen: document.querySelector("#v86-screen")
};

const terminal = new CanvasTerminal(elements.screen);
const display = createDisplayManager(elements.screen, elements.v86Screen);
const runtime = new EmulatorRuntime(terminal, {
  onLifecycle: updateLifecycle
});
const AUTO_PAUSE_REASON_PAGE_BLUR = "页面失焦";
const AUTO_PAUSE_REASON_DOS_PROMPT = "dos-prompt-idle";
const SETTINGS_KEY = "msdos-simulator-settings";

let profiles = [];
let serverImages = [];
let availableGamePackages = [];
let runtimeAssets = null;
let activeLocalImage = null;
let inputBuffer = "";
let autoPauseReason = "";

bootstrap().catch((error) => {
  appendLog(`初始化失败: ${error.message}`);
});

async function bootstrap() {
  // 步骤 1：先建立事件和默认待机画面，让页面可以在异步资源返回前就绪。
  bindEvents();
  terminal.renderStatus("MS-DOS 6.0 Simulator", "正在检测 v86 运行时与固定目录镜像...");
  syncPauseButton();

  // 步骤 2：并行加载配置、固定镜像列表、扩展硬盘清单和 v86 运行时状态。
  const [profileItems, diskImages, gamePackages, assets] = await Promise.all([
    fetchJson("/api/profiles"),
    fetchJson("/api/disk-images"),
    fetchJson("/api/game-packages"),
    fetchJson("/api/runtime-assets")
  ]);

  profiles = profileItems;
  serverImages = diskImages;
  availableGamePackages = gamePackages;
  runtimeAssets = assets;

  populateProfiles(profiles);
  populateServerImages(serverImages);
  populateGamePackages(availableGamePackages);
  applyRuntimeAssets(runtimeAssets);
  syncImageSource();
  syncSelectedImageStatus();

  // 步骤 3：如果真实内核资源已经就绪，就默认切到 v86 作为首要启动路径。
  if (runtimeAssets?.v86?.ready) {
    elements.adapterSelect.value = "v86";
  }
  elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;

  // 步骤 4：从 localStorage 恢复上次用户选择的参数，覆盖默认值。
  loadSettings();

  elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;

  terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择 dos6.22.img 并点击启动。");
  appendLog("系统已就绪，当前首要目标是通过 v86 启动 dos6.22.img。");
}

function bindEvents() {
  elements.fileInput.addEventListener("change", handleFileSelected);
  elements.imageSource.addEventListener("change", () => { syncImageSource(); saveSettings(); });
  elements.pauseButton.addEventListener("click", handlePauseToggle);
  elements.powerSaveEnabled.addEventListener("change", () => {
    appendLog(elements.powerSaveEnabled.checked ? "节能模式已开启。" : "节能模式已关闭。");
    saveSettings();
  });
  elements.promptIdleEnabled.addEventListener("change", () => {
    appendLog(elements.promptIdleEnabled.checked ? "DOS 提示符自动 idle 已开启。" : "DOS 提示符自动 idle 已关闭。");
    saveSettings();
  });
  elements.profileSelect.addEventListener("change", () => { syncProfileSelection(); saveSettings(); });
  elements.serverImageSelect.addEventListener("change", () => { syncSelectedImageStatus(); saveSettings(); });
  elements.adapterSelect.addEventListener("change", () => {
    elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;
    syncPauseButton();
    saveSettings();
  });
  elements.gamePackageSelect.addEventListener("change", saveSettings);
  elements.memorySize.addEventListener("change", saveSettings);
  elements.cpuProfile.addEventListener("change", saveSettings);
  elements.soundEnabled.addEventListener("change", saveSettings);
  elements.autoLaunchEnabled.addEventListener("change", saveSettings);
  elements.refreshImagesButton.addEventListener("click", refreshServerImages);
  elements.bootButton.addEventListener("click", handleBoot);
  elements.resetButton.addEventListener("click", handleReset);

  // 步骤 4：仅在页面失焦时触发自动节能暂停，保证行为稳定可预期。
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);

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
  const selectedProfile = profiles.find((profile) => profile.id === elements.profileSelect.value) || profiles[0];
  const config = collectConfig(selectedProfile);
  const selectedImage = resolveSelectedImage();
  const attachments = await resolveSelectedAttachments();
  const startupAutomation = resolveStartupAutomation(attachments, config);

  inputBuffer = "";
  autoPauseReason = "";
  terminal.setInputBuffer("");
  elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;

  appendLog(`准备启动: adapter=${elements.adapterSelect.value}, image=${selectedImage.imageMeta.name}, profile=${selectedProfile?.name || "custom"}, attachments=${attachments.length}`);
  appendCompatibilityLogs(attachments);

  await runtime.boot({
    adapterType: elements.adapterSelect.value,
    attachments,
    config,
    display,
    diskImage: selectedImage.diskImage,
    idlePolicy: collectIdlePolicy(),
    imageMeta: selectedImage.imageMeta,
    onAutoPauseRequested: handleAutoPauseRequested,
    onLog: appendLog,
    profile: selectedProfile,
    runtimeAssets,
    startupAutomation
  });

  syncPauseButton();
}

async function handleReset() {
  inputBuffer = "";
  autoPauseReason = "";
  terminal.setInputBuffer("");
  await runtime.reset();
  syncPauseButton();
  appendLog("会话已重置。");
}

async function handlePauseToggle() {
  if (runtime.isPaused()) {
    autoPauseReason = "";
    await runtime.resume("手动恢复");
    appendLog("模拟器已手动恢复。");
  } else if (runtime.isRunning()) {
    autoPauseReason = "";
    await runtime.pause("手动暂停");
    appendLog("模拟器已手动暂停。");
  }

  syncPauseButton();
}

async function refreshServerImages() {
  serverImages = await fetchJson("/api/disk-images");
  populateServerImages(serverImages);
  syncSelectedImageStatus();
  appendLog(`固定目录镜像已刷新，当前共 ${serverImages.length} 个。`);
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
    elements.autoLaunchEnabled.checked = true;
  }
}

function syncImageSource() {
  const useServerImage = elements.imageSource.value === "server";
  elements.serverImageField.classList.toggle("hidden", !useServerImage);
  elements.uploadImageField.classList.toggle("hidden", useServerImage);
  syncSelectedImageStatus();
}

function collectConfig(profile = null) {
  return {
    memoryMb: Number(elements.memorySize.value || profile?.memoryMb || 16),
    cpuProfile: elements.cpuProfile.value || profile?.cpuProfile || "486dx2",
    soundEnabled: elements.soundEnabled.checked,
    autoLaunchEnabled: elements.autoLaunchEnabled.checked
  };
}

function collectIdlePolicy() {
  return {
    isPageBlurAutoPauseEnabled: () => elements.powerSaveEnabled.checked,
    isPromptAutoPauseEnabled: () => elements.promptIdleEnabled.checked
  };
}

function populateProfiles(items) {
  const fallbackProfiles = items.length > 0 ? items : [
    { id: "dos-default", name: "MS-DOS 6.0 默认", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true },
    { id: "pal95", name: "仙剑 95 兼容预设", memoryMb: 16, cpuProfile: "486dx2", soundEnabled: true }
  ];

  elements.profileSelect.innerHTML = fallbackProfiles.map((profile) => `<option value="${profile.id}">${profile.name}</option>`).join("");
  profiles = fallbackProfiles;
  syncProfileSelection();
}

function populateServerImages(items) {
  if (items.length === 0) {
    elements.serverImageSelect.innerHTML = '<option value="">固定目录暂无镜像</option>';
    return;
  }

  elements.serverImageSelect.innerHTML = items.map((image) => `<option value="${image.name}">${image.name} · ${image.sizeLabel} · ${image.driveType}</option>`).join("");
  const preferredImage = items.find((image) => image.name.toLowerCase() === "dos6.22.img");

  if (preferredImage) {
    elements.serverImageSelect.value = preferredImage.name;
  }
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
    paused: context?.pauseReason?.startsWith("DOS 提示符空闲") ? "提示符空闲" : "节能暂停",
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
    const selectedImage = serverImages.find((image) => image.name === elements.serverImageSelect.value);

    if (!selectedImage) {
      throw new Error("服务端固定目录中未找到可启动镜像，请先把 dos6.22.img 放入 storage/images/。");
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

async function resolveSelectedAttachments() {
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
    method: "POST"
  });

  appendLog(`扩展硬盘已就绪: ${materializedPackage.name} -> ${materializedPackage.mount.preferredSlot.toUpperCase()} (${materializedPackage.mount.sizeLabel})，DOS 内可切到 C: 后运行 RUNPAL 或 PAL.EXE。`);

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
  } catch (error) {
    elements.imageStatus.textContent = error.message.replace("Error: ", "");
  }
}

async function handleVisibilityChange() {
  if (document.hidden) {
    await pauseForPowerSave(AUTO_PAUSE_REASON_PAGE_BLUR);
    return;
  }

  if (runtime.isPaused() && autoPauseReason === AUTO_PAUSE_REASON_PAGE_BLUR) {
    const resumed = await runtime.resume("页面恢复焦点");
    if (resumed) {
      autoPauseReason = "";
    }
  }
}

async function handleWindowFocus() {
  if (runtime.isPaused() && autoPauseReason === AUTO_PAUSE_REASON_PAGE_BLUR) {
    const resumed = await runtime.resume("窗口重新聚焦");
    if (resumed) {
      autoPauseReason = "";
    }
  }
}

async function pauseForPowerSave(reason) {
  if (!collectIdlePolicy().isPageBlurAutoPauseEnabled() || !runtime.isRunning()) {
    return;
  }

  const paused = await runtime.pause(reason);
  if (!paused) {
    return;
  }

  autoPauseReason = reason;
  appendLog(`已触发节能暂停: ${reason}。`);
  syncPauseButton();
}

async function handleAutoPauseRequested(reason, details = {}) {
  if (reason === AUTO_PAUSE_REASON_DOS_PROMPT && !collectIdlePolicy().isPromptAutoPauseEnabled()) {
    return false;
  }

  if (!runtime.isRunning() || runtime.isPaused()) {
    return false;
  }

  const paused = await runtime.pause(details.pauseReason || reason);
  if (!paused) {
    return false;
  }

  autoPauseReason = reason;

  if (details.logMessage) {
    appendLog(details.logMessage);
  }

  syncPauseButton();
  return true;
}

function syncPauseButton() {
  if (!runtime.currentAdapter) {
    elements.pauseButton.textContent = "暂停";
    elements.pauseButton.disabled = true;
    return;
  }

  elements.pauseButton.disabled = elements.adapterSelect.value !== "v86";
  elements.pauseButton.textContent = runtime.isPaused() ? "继续" : "暂停";
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
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
    throw new Error(`Request failed: ${response.status}`);
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
    serverImage: elements.serverImageSelect.value,
    adapter: elements.adapterSelect.value,
    profile: elements.profileSelect.value,
    gamePackage: elements.gamePackageSelect.value,
    memorySize: elements.memorySize.value,
    cpuProfile: elements.cpuProfile.value,
    soundEnabled: elements.soundEnabled.checked,
    autoLaunchEnabled: elements.autoLaunchEnabled.checked,
    powerSaveEnabled: elements.powerSaveEnabled.checked,
    promptIdleEnabled: elements.promptIdleEnabled.checked
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

  // 按顺序恢复：先设置基础选择项，再设置依赖动态数据的下拉框
  if (settings.imageSource) {
    elements.imageSource.value = settings.imageSource;
    syncImageSource();
  }

  if (settings.adapter) {
    elements.adapterSelect.value = settings.adapter;
  }

  if (settings.profile && Array.from(elements.profileSelect.options).some((opt) => opt.value === settings.profile)) {
    elements.profileSelect.value = settings.profile;
  }

  if (settings.serverImage && Array.from(elements.serverImageSelect.options).some((opt) => opt.value === settings.serverImage)) {
    elements.serverImageSelect.value = settings.serverImage;
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

  if (typeof settings.autoLaunchEnabled === "boolean") {
    elements.autoLaunchEnabled.checked = settings.autoLaunchEnabled;
  }

  if (typeof settings.powerSaveEnabled === "boolean") {
    elements.powerSaveEnabled.checked = settings.powerSaveEnabled;
  }

  if (typeof settings.promptIdleEnabled === "boolean") {
    elements.promptIdleEnabled.checked = settings.promptIdleEnabled;
  }

  syncSelectedImageStatus();
}

function resolveStartupAutomation(attachments, config) {
  if (!config.autoLaunchEnabled) {
    return null;
  }

  const autoLaunchAttachment = attachments.find((attachment) => attachment.launchCommand);

  if (!autoLaunchAttachment) {
    return null;
  }

  return {
    label: `${autoLaunchAttachment.label} 自动启动`,
    commandText: autoLaunchAttachment.launchCommand
  };
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
