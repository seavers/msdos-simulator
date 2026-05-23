import { CanvasTerminal } from "./core/canvas-terminal.js";
import { EmulatorRuntime } from "./emulator/emulator-runtime.js";

const elements = {
  bootButton: document.querySelector("#boot-button"),
  closeStartupPreviewDialogButton: document.querySelector("#close-startup-preview-dialog"),
  closeSystemDiskManagerDialogButton: document.querySelector("#close-system-disk-manager-dialog"),
  cpuProfile: document.querySelector("#cpu-profile"),
  eventLog: document.querySelector("#event-log"),
  gamePackageSelect: document.querySelector("#game-package-select"),
  heroStatus: document.querySelector("#hero-status"),
  manageSystemDisksButton: document.querySelector("#manage-system-disks-button"),
  manageSystemDisksButtonInline: document.querySelector("#manage-system-disks-button-inline"),
  memorySize: document.querySelector("#memory-size"),
  pauseButton: document.querySelector("#pause-button"),
  previewStartupButton: document.querySelector("#preview-startup-button"),
  profileSelect: document.querySelector("#profile-select"),
  resetButton: document.querySelector("#reset-button"),
  runtimeMode: document.querySelector("#runtime-mode"),
  screen: document.querySelector("#dos-screen"),
  serverImageSelect: document.querySelector("#server-image-select"),
  soundEnabled: document.querySelector("#sound-enabled"),
  startupDiskAutoRun: document.querySelector("#startup-disk-auto-run"),
  startupDiskCdrom: document.querySelector("#startup-disk-cdrom"),
  startupDiskDosIdle: document.querySelector("#startup-disk-dosidle"),
  startupDiskMscdex: document.querySelector("#startup-disk-mscdex"),
  startupDiskOptimizeMemory: document.querySelector("#startup-disk-optimize-memory"),
  startupDiskSound: document.querySelector("#startup-disk-sound"),
  startupPreviewAutoexec: document.querySelector("#startup-preview-autoexec"),
  startupPreviewConfig: document.querySelector("#startup-preview-config"),
  startupPreviewDialog: document.querySelector("#startup-preview-dialog"),
  startupPreviewSummary: document.querySelector("#startup-preview-summary"),
  systemDiskDescription: document.querySelector("#system-disk-description"),
  systemDiskManagerDialog: document.querySelector("#system-disk-manager-dialog"),
  systemDiskManagerList: document.querySelector("#system-disk-manager-list"),
  systemDiskUploadFile: document.querySelector("#system-disk-upload-file"),
  systemDiskUploadNote: document.querySelector("#system-disk-upload-note"),
  uploadSystemDiskButton: document.querySelector("#upload-system-disk-button"),
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
  elements.runtimeMode.textContent = "适配器: v86";

  loadSettings();
  syncStartupOptionStates();
  syncSelectedImageStatus();
  renderSystemDiskManagerList();

  terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择系统盘并确认脚本参数后启动。");
  appendLog("系统已就绪，当前流程为：选择系统盘 -> 调整 CONFIG/AUTOEXEC 参数 -> 预览或直接启动。");
}

function bindEvents() {
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
  elements.previewStartupButton.addEventListener("click", handlePreviewStartupScripts);
  elements.bootButton.addEventListener("click", handleBoot);
  elements.resetButton.addEventListener("click", handleReset);
  elements.manageSystemDisksButton.addEventListener("click", openSystemDiskManager);
  elements.manageSystemDisksButtonInline.addEventListener("click", openSystemDiskManager);
  elements.closeStartupPreviewDialogButton.addEventListener("click", () => elements.startupPreviewDialog.close());
  elements.closeSystemDiskManagerDialogButton.addEventListener("click", closeSystemDiskManager);
  elements.uploadSystemDiskButton.addEventListener("click", handleUploadSystemDisk);

  for (const element of [
    elements.startupDiskOptimizeMemory,
    elements.startupDiskAutoRun,
    elements.startupDiskSound,
    elements.startupDiskDosIdle,
    elements.startupDiskCdrom,
    elements.startupDiskMscdex
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

async function handlePreviewStartupScripts() {
  try {
    const preview = await fetchStartupPreview();
    elements.startupPreviewSummary.textContent = `${preview.description} | 复用键: ${preview.configKey}`;
    elements.startupPreviewConfig.value = preview.configSys;
    elements.startupPreviewAutoexec.value = preview.autoexecBat;
    elements.startupPreviewDialog.showModal();
    appendLog(`已预览系统盘脚本: ${preview.systemDiskName}`);
  } catch (error) {
    appendLog(`预览脚本失败: ${error.message}`);
  }
}

async function handleBoot() {
  try {
    const selectedProfile = profiles.find((profile) => profile.id === elements.profileSelect.value) || profiles[0];
    const config = collectConfig(selectedProfile);
    const selectedImage = resolveSelectedImage();

    // 步骤 3：启动前根据系统盘和脚本参数查找可复用成品盘；没有命中时再生成新的启动盘。
    const resolvedStartupDisk = await fetchJson("/api/startup-disks", {
      method: "POST",
      body: JSON.stringify(buildStartupRequestPayload())
    });

    appendLog(`${resolvedStartupDisk.reused ? "复用" : "生成"}系统启动盘: ${resolvedStartupDisk.disk.name}`);
    appendLog(`系统盘路径: ${resolvedStartupDisk.paths.baseImagePath}`);
    appendLog(`启动盘路径: ${resolvedStartupDisk.paths.bootDiskPath}`);

    const attachments = await resolveSelectedAttachments(config);
    inputBuffer = "";
    terminal.setInputBuffer("");
    elements.runtimeMode.textContent = "适配器: v86";

    appendLog(`准备启动: adapter=v86, image=${resolvedStartupDisk.disk.name}, profile=${selectedProfile?.name || "custom"}, attachments=${attachments.length}`);
    appendCompatibilityLogs(attachments);

    await runtime.boot({
      adapterType: "v86",
      attachments,
      config,
      display,
      diskImage: {
        source: "server",
        name: resolvedStartupDisk.disk.name,
        size: resolvedStartupDisk.disk.size,
        url: resolvedStartupDisk.disk.url,
        driveType: resolvedStartupDisk.disk.driveType
      },
      imageMeta: {
        ...resolvedStartupDisk.disk,
        baseDiskName: selectedImage.imageMeta.name
      },
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

async function openSystemDiskManager() {
  await refreshSystemDiskImages({ preserveSelection: true });
  renderSystemDiskManagerList();
  elements.systemDiskManagerDialog.showModal();
}

function closeSystemDiskManager() {
  elements.systemDiskManagerDialog.close();
}

async function handleUploadSystemDisk() {
  const [file] = elements.systemDiskUploadFile.files || [];

  if (!file) {
    appendLog("请先选择要上传的系统盘镜像。");
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentBase64 = bytesToBase64(bytes);
    const result = await fetchJson("/api/base-disk-images", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        note: elements.systemDiskUploadNote.value.trim(),
        contentBase64
      })
    });

    await refreshSystemDiskImages({ preserveSelection: true });
    renderSystemDiskManagerList();
    if (result.image?.name) {
      elements.serverImageSelect.value = result.image.name;
    }
    elements.systemDiskUploadFile.value = "";
    elements.systemDiskUploadNote.value = "";
    syncSelectedImageStatus();
    saveSettings();
    appendLog(`已上传系统盘: ${file.name}`);
  } catch (error) {
    appendLog(`上传系统盘失败: ${error.message}`);
  }
}

async function handleSaveSystemDiskNote(imageName, note) {
  try {
    await fetchJson(`/api/base-disk-images/${encodeURIComponent(imageName)}`, {
      method: "PATCH",
      body: JSON.stringify({ note })
    });
    await refreshSystemDiskImages({ preserveSelection: true });
    renderSystemDiskManagerList();
    syncSelectedImageStatus();
    appendLog(`已更新系统盘备注: ${imageName}`);
  } catch (error) {
    appendLog(`保存系统盘备注失败: ${error.message}`);
  }
}

async function handleDeleteSystemDisk(imageName) {
  try {
    await fetchJson(`/api/base-disk-images/${encodeURIComponent(imageName)}`, {
      method: "DELETE"
    });
    await refreshSystemDiskImages({ preserveSelection: false });
    renderSystemDiskManagerList();
    syncSelectedImageStatus();
    saveSettings();
    appendLog(`已删除系统盘: ${imageName}`);
  } catch (error) {
    appendLog(`删除系统盘失败: ${error.message}`);
  }
}

async function refreshSystemDiskImages({ preserveSelection } = { preserveSelection: true }) {
  const previousSelection = elements.serverImageSelect.value;
  systemDiskImages = await fetchJson("/api/base-disk-images");
  populateSystemDiskImages(systemDiskImages);

  if (preserveSelection && previousSelection && systemDiskImages.some((image) => image.name === previousSelection)) {
    elements.serverImageSelect.value = previousSelection;
  }

  syncSelectedImageStatus();
}

function renderSystemDiskManagerList() {
  if (systemDiskImages.length === 0) {
    elements.systemDiskManagerList.innerHTML = "<p class=\"field-note\">当前没有系统盘镜像。</p>";
    return;
  }

  elements.systemDiskManagerList.innerHTML = systemDiskImages.map((image) => `
    <section class="manager-item" data-image-name="${escapeHtml(image.name)}">
      <p class="manager-item-title">${escapeHtml(image.name)}</p>
      <p class="manager-item-meta">${escapeHtml(image.sizeLabel)} · ${escapeHtml(image.driveType)}</p>
      <label class="field">
        <span>备注</span>
        <input data-role="note-input" type="text" maxlength="120" value="${escapeHtml(image.note || "")}" placeholder="给这个系统盘加一个备注" />
      </label>
      <div class="manager-item-actions">
        <button data-role="save-note" type="button" class="secondary manage-button">保存备注</button>
        <button data-role="delete-image" type="button" class="secondary manage-button">删除</button>
      </div>
    </section>
  `).join("");

  for (const section of elements.systemDiskManagerList.querySelectorAll(".manager-item")) {
    const imageName = section.dataset.imageName;
    const noteInput = section.querySelector('[data-role="note-input"]');
    section.querySelector('[data-role="save-note"]').addEventListener("click", () => handleSaveSystemDiskNote(imageName, noteInput.value.trim()));
    section.querySelector('[data-role="delete-image"]').addEventListener("click", () => handleDeleteSystemDisk(imageName));
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
    autoRunGame: elements.startupDiskAutoRun.checked
  };
}

async function fetchStartupPreview() {
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
    elements.serverImageSelect.innerHTML = "<option value=\"\">系统盘目录暂无镜像</option>";
    return;
  }

  elements.serverImageSelect.innerHTML = items.map((image) => `<option value="${escapeHtml(image.name)}">${escapeHtml(image.name)} · ${escapeHtml(image.sizeLabel)} · ${escapeHtml(image.driveType)}</option>`).join("");
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
  const selectedImage = systemDiskImages.find((image) => image.name === elements.serverImageSelect.value);

  if (!selectedImage) {
    throw new Error("服务端系统盘目录中未找到可启动镜像，请先在管理里上传系统盘。");
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

async function resolveSelectedAttachments(config) {
  const selectedPackageId = elements.gamePackageSelect.value;

  if (!selectedPackageId) {
    return [];
  }

  const selectedPackage = availableGamePackages.find((item) => item.id === selectedPackageId && item.available);

  if (!selectedPackage) {
    throw new Error("所选扩展硬盘不可用，请先确认 pal95 游戏目录存在。");
  }

  // 步骤 4：启动前先在服务端把游戏目录固化为 FAT16 数据盘，避免前端直接处理大量原始文件。
  appendLog(`正在准备扩展硬盘: ${selectedPackage.name}`);
  const materializedPackage = await fetchJson(`/api/game-packages/${encodeURIComponent(selectedPackage.id)}/materialize`, {
    method: "POST",
    body: JSON.stringify({
      soundEnabled: Boolean(config?.soundEnabled)
    })
  });

  appendLog(`扩展硬盘已就绪: ${materializedPackage.name} -> ${materializedPackage.mount.preferredSlot.toUpperCase()} (${materializedPackage.mount.sizeLabel})，当前推荐命令为 ${materializedPackage.launchCommand.includes("RUNSAFE") ? "RUNSAFE" : "RUNPAL"}。`);
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
    syncSystemDiskDescription(selectedImage.imageMeta);
  } catch (error) {
    elements.systemDiskDescription.textContent = error.message.replace("Error: ", "");
  }
}

function syncSystemDiskDescription(systemDisk) {
  if (!systemDisk) {
    elements.systemDiskDescription.textContent = "系统盘: 未选择";
    return;
  }

  const segments = [`系统盘: ${systemDisk.name}`];

  if (systemDisk.note) {
    segments.push(`备注: ${systemDisk.note}`);
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
      // 响应体不是 JSON 时回退到默认提示
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

function saveSettings() {
  const settings = {
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
    startupDiskMscdex: elements.startupDiskMscdex.checked
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
    startupDiskMscdex: elements.startupDiskMscdex
  })) {
    if (typeof settings[key] === "boolean") {
      element.checked = settings[key];
    }
  }

  if (elements.profileSelect.value === "pal95") {
    elements.soundEnabled.checked = false;
  }
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

function bytesToBase64(bytes) {
  let binary = "";

  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }

  return btoa(binary);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
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
