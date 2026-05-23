import { CanvasTerminal } from "./core/canvas-terminal.js";
import { EmulatorRuntime } from "./emulator/emulator-runtime.js";

const elements = {
  bootButton: document.querySelector("#boot-button"),
  closeExtendDiskManagerDialogButton: document.querySelector("#close-extend-disk-manager-dialog"),
  closeStartupPreviewDialogButton: document.querySelector("#close-startup-preview-dialog"),
  closeSystemDiskManagerDialogButton: document.querySelector("#close-system-disk-manager-dialog"),
  cpuProfile: document.querySelector("#cpu-profile"),
  deleteExtendDiskButton: document.querySelector("#delete-extend-disk-button"),
  eventLog: document.querySelector("#event-log"),
  extendDiskDescription: document.querySelector("#extend-disk-description"),
  extendDiskManagerDialog: document.querySelector("#extend-disk-manager-dialog"),
  extendDiskManagerNote: document.querySelector("#extend-disk-manager-note"),
  extendDiskManagerSelect: document.querySelector("#extend-disk-manager-select"),
  extendDiskUploadFile: document.querySelector("#extend-disk-upload-file"),
  extendDiskUploadNote: document.querySelector("#extend-disk-upload-note"),
  gamePackageSelect: document.querySelector("#game-package-select"),
  heroStatus: document.querySelector("#hero-status"),
  manageExtendDisksButton: document.querySelector("#manage-extend-disks-button"),
  manageSystemDisksButton: document.querySelector("#manage-system-disks-button"),
  memorySize: document.querySelector("#memory-size"),
  pauseButton: document.querySelector("#pause-button"),
  previewStartupButton: document.querySelector("#preview-startup-button"),
  profileSelect: document.querySelector("#profile-select"),
  resetButton: document.querySelector("#reset-button"),
  runtimeMode: document.querySelector("#runtime-mode"),
  saveExtendDiskNoteButton: document.querySelector("#save-extend-disk-note-button"),
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
  systemDiskManagerNote: document.querySelector("#system-disk-manager-note"),
  systemDiskManagerSelect: document.querySelector("#system-disk-manager-select"),
  systemDiskUploadFile: document.querySelector("#system-disk-upload-file"),
  systemDiskUploadNote: document.querySelector("#system-disk-upload-note"),
  uploadExtendDiskButton: document.querySelector("#upload-extend-disk-button"),
  saveSystemDiskNoteButton: document.querySelector("#save-system-disk-note-button"),
  deleteSystemDiskButton: document.querySelector("#delete-system-disk-button"),
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
let extendDiskImages = [];
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
  const [profileItems, baseImages, extendImages, gamePackages, assets] = await Promise.all([
    fetchJson("/api/profiles"),
    fetchJson("/api/base-disk-images"),
    fetchJson("/api/extend-disk-images"),
    fetchJson("/api/game-packages"),
    fetchJson("/api/runtime-assets")
  ]);

  profiles = profileItems;
  systemDiskImages = baseImages;
  extendDiskImages = extendImages;
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
  renderExtendDiskManagerList();

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
    syncSelectedImageStatus();
    saveSettings();
  });
  elements.memorySize.addEventListener("change", saveSettings);
  elements.cpuProfile.addEventListener("change", saveSettings);
  elements.soundEnabled.addEventListener("change", saveSettings);
  elements.previewStartupButton.addEventListener("click", handlePreviewStartupScripts);
  elements.bootButton.addEventListener("click", handleBoot);
  elements.resetButton.addEventListener("click", handleReset);
  elements.manageExtendDisksButton.addEventListener("click", openExtendDiskManager);
  elements.manageSystemDisksButton.addEventListener("click", openSystemDiskManager);
  elements.closeExtendDiskManagerDialogButton.addEventListener("click", closeExtendDiskManager);
  elements.closeStartupPreviewDialogButton.addEventListener("click", () => elements.startupPreviewDialog.close());
  elements.closeSystemDiskManagerDialogButton.addEventListener("click", closeSystemDiskManager);
  elements.uploadExtendDiskButton.addEventListener("click", handleUploadExtendDisk);
  elements.uploadSystemDiskButton.addEventListener("click", handleUploadSystemDisk);
  elements.extendDiskManagerSelect.addEventListener("change", syncExtendDiskManagerSelection);
  elements.saveExtendDiskNoteButton.addEventListener("click", handleSaveSelectedExtendDiskNote);
  elements.deleteExtendDiskButton.addEventListener("click", handleDeleteSelectedExtendDisk);
  elements.systemDiskManagerSelect.addEventListener("change", syncSystemDiskManagerSelection);
  elements.saveSystemDiskNoteButton.addEventListener("click", handleSaveSelectedSystemDiskNote);
  elements.deleteSystemDiskButton.addEventListener("click", handleDeleteSelectedSystemDisk);

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
    // 步骤 3：启动前根据系统盘和脚本参数查找可复用成品盘；没有命中时再生成新的启动盘。
    const resolvedStartupDisk = await fetchJson("/api/startup-disks", {
      method: "POST",
      body: JSON.stringify(buildStartupRequestPayload())
    });

    appendLog(`${resolvedStartupDisk.reused ? "复用" : "生成"}系统启动盘: ${resolvedStartupDisk.disk.name}`);
    appendLog(`系统盘路径: ${resolvedStartupDisk.paths.baseImagePath}`);
    appendLog(`启动盘路径: ${resolvedStartupDisk.paths.bootDiskPath}`);

    const attachments = await resolveSelectedAttachments();
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
      imageMeta: resolvedStartupDisk.disk,
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
  syncSystemDiskManagerSelection();
  elements.systemDiskManagerDialog.showModal();
}

function closeSystemDiskManager() {
  elements.systemDiskManagerDialog.close();
}

async function openExtendDiskManager() {
  await refreshExtendDiskImages({ preserveSelection: true });
  renderExtendDiskManagerList();
  syncExtendDiskManagerSelection();
  elements.extendDiskManagerDialog.showModal();
}

function closeExtendDiskManager() {
  elements.extendDiskManagerDialog.close();
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
    syncSystemDiskManagerSelection(result.image?.name);
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

async function handleUploadExtendDisk() {
  const [file] = elements.extendDiskUploadFile.files || [];

  if (!file) {
    appendLog("请先选择要上传的扩展硬盘镜像。");
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentBase64 = bytesToBase64(bytes);
    const result = await fetchJson("/api/extend-disk-images", {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        note: elements.extendDiskUploadNote.value.trim(),
        contentBase64
      })
    });

    await refreshExtendDiskImages({ preserveSelection: true });
    renderExtendDiskManagerList();
    syncExtendDiskManagerSelection(result.image?.name);
    if (result.image?.name) {
      elements.gamePackageSelect.value = result.image.name;
    }
    elements.extendDiskUploadFile.value = "";
    elements.extendDiskUploadNote.value = "";
    syncSelectedImageStatus();
    saveSettings();
    appendLog(`已上传扩展硬盘: ${file.name}`);
  } catch (error) {
    appendLog(`上传扩展硬盘失败: ${error.message}`);
  }
}

async function handleSaveSelectedSystemDiskNote() {
  const imageName = elements.systemDiskManagerSelect.value;

  if (!imageName) {
    appendLog("请先在系统盘列表中选择一个镜像。");
    return;
  }

  try {
    await fetchJson(`/api/base-disk-images/${encodeURIComponent(imageName)}`, {
      method: "PATCH",
      body: JSON.stringify({ note: elements.systemDiskManagerNote.value.trim() })
    });
    await refreshSystemDiskImages({ preserveSelection: true });
    renderSystemDiskManagerList();
    syncSystemDiskManagerSelection(imageName);
    syncSelectedImageStatus();
    appendLog(`已更新系统盘备注: ${imageName}`);
  } catch (error) {
    appendLog(`保存系统盘备注失败: ${error.message}`);
  }
}

async function handleDeleteSelectedSystemDisk() {
  const imageName = elements.systemDiskManagerSelect.value;

  if (!imageName) {
    appendLog("请先在系统盘列表中选择一个镜像。");
    return;
  }

  try {
    await fetchJson(`/api/base-disk-images/${encodeURIComponent(imageName)}`, {
      method: "DELETE"
    });
    await refreshSystemDiskImages({ preserveSelection: false });
    renderSystemDiskManagerList();
    syncSystemDiskManagerSelection();
    syncSelectedImageStatus();
    saveSettings();
    appendLog(`已删除系统盘: ${imageName}`);
  } catch (error) {
    appendLog(`删除系统盘失败: ${error.message}`);
  }
}

async function handleSaveSelectedExtendDiskNote() {
  const imageName = elements.extendDiskManagerSelect.value;

  if (!imageName) {
    appendLog("请先在扩展硬盘列表中选择一个镜像。");
    return;
  }

  try {
    await fetchJson(`/api/extend-disk-images/${encodeURIComponent(imageName)}`, {
      method: "PATCH",
      body: JSON.stringify({ note: elements.extendDiskManagerNote.value.trim() })
    });
    await refreshExtendDiskImages({ preserveSelection: true });
    renderExtendDiskManagerList();
    syncExtendDiskManagerSelection(imageName);
    syncSelectedImageStatus();
    appendLog(`已更新扩展硬盘备注: ${imageName}`);
  } catch (error) {
    appendLog(`保存扩展硬盘备注失败: ${error.message}`);
  }
}

async function handleDeleteSelectedExtendDisk() {
  const imageName = elements.extendDiskManagerSelect.value;

  if (!imageName) {
    appendLog("请先在扩展硬盘列表中选择一个镜像。");
    return;
  }

  try {
    await fetchJson(`/api/extend-disk-images/${encodeURIComponent(imageName)}`, {
      method: "DELETE"
    });
    await refreshExtendDiskImages({ preserveSelection: false });
    renderExtendDiskManagerList();
    syncExtendDiskManagerSelection();
    syncSelectedImageStatus();
    saveSettings();
    appendLog(`已删除扩展硬盘: ${imageName}`);
  } catch (error) {
    appendLog(`删除扩展硬盘失败: ${error.message}`);
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

async function refreshExtendDiskImages({ preserveSelection } = { preserveSelection: true }) {
  const previousSelection = elements.gamePackageSelect.value;
  const [extendImages, gamePackages] = await Promise.all([fetchJson("/api/extend-disk-images"), fetchJson("/api/game-packages")]);
  extendDiskImages = extendImages;
  availableGamePackages = gamePackages;
  populateGamePackages(availableGamePackages);

  if (preserveSelection && previousSelection && availableGamePackages.some((item) => item.id === previousSelection)) {
    elements.gamePackageSelect.value = previousSelection;
  }

  syncStartupOptionStates();
  syncSelectedImageStatus();
}

function renderSystemDiskManagerList() {
  if (systemDiskImages.length === 0) {
    elements.systemDiskManagerSelect.innerHTML = "<option value=\"\">当前没有系统盘镜像</option>";
    elements.systemDiskManagerNote.value = "";
    elements.systemDiskManagerNote.disabled = true;
    elements.saveSystemDiskNoteButton.disabled = true;
    elements.deleteSystemDiskButton.disabled = true;
    return;
  }

  elements.systemDiskManagerSelect.innerHTML = systemDiskImages.map((image) => `<option value="${escapeHtml(image.name)}">${escapeHtml(image.name)} · ${escapeHtml(image.sizeLabel)}</option>`).join("");
}

function renderExtendDiskManagerList() {
  if (extendDiskImages.length === 0) {
    elements.extendDiskManagerSelect.innerHTML = "<option value=\"\">当前没有扩展硬盘镜像</option>";
    elements.extendDiskManagerNote.value = "";
    elements.extendDiskManagerNote.disabled = true;
    elements.saveExtendDiskNoteButton.disabled = true;
    elements.deleteExtendDiskButton.disabled = true;
    return;
  }

  elements.extendDiskManagerSelect.innerHTML = extendDiskImages
    .map((image) => `<option value="${escapeHtml(image.name)}">${escapeHtml(image.name)} · ${escapeHtml(image.sizeLabel)} · ${escapeHtml(image.driveType)}</option>`)
    .join("");
}

function syncSystemDiskManagerSelection(preferredImageName = "") {
  if (preferredImageName && systemDiskImages.some((image) => image.name === preferredImageName)) {
    elements.systemDiskManagerSelect.value = preferredImageName;
  }

  const selectedImage = systemDiskImages.find((image) => image.name === elements.systemDiskManagerSelect.value) || systemDiskImages[0];

  if (!selectedImage) {
    elements.systemDiskManagerNote.value = "";
    elements.systemDiskManagerNote.disabled = true;
    elements.saveSystemDiskNoteButton.disabled = true;
    elements.deleteSystemDiskButton.disabled = true;
    return;
  }

  if (!elements.systemDiskManagerSelect.value) {
    elements.systemDiskManagerSelect.value = selectedImage.name;
  }

  elements.systemDiskManagerNote.value = selectedImage.note || "";
  elements.systemDiskManagerNote.disabled = false;
  elements.saveSystemDiskNoteButton.disabled = false;
  elements.deleteSystemDiskButton.disabled = false;
}

function syncExtendDiskManagerSelection(preferredImageName = "") {
  if (preferredImageName && extendDiskImages.some((image) => image.name === preferredImageName)) {
    elements.extendDiskManagerSelect.value = preferredImageName;
  }

  const selectedImage = extendDiskImages.find((image) => image.name === elements.extendDiskManagerSelect.value) || extendDiskImages[0];

  if (!selectedImage) {
    elements.extendDiskManagerNote.value = "";
    elements.extendDiskManagerNote.disabled = true;
    elements.saveExtendDiskNoteButton.disabled = true;
    elements.deleteExtendDiskButton.disabled = true;
    return;
  }

  if (!elements.extendDiskManagerSelect.value) {
    elements.extendDiskManagerSelect.value = selectedImage.name;
  }

  elements.extendDiskManagerNote.value = selectedImage.note || "";
  elements.extendDiskManagerNote.disabled = false;
  elements.saveExtendDiskNoteButton.disabled = false;
  elements.deleteExtendDiskButton.disabled = false;
}

function syncProfileSelection() {
  const profile = profiles.find((item) => item.id === elements.profileSelect.value);

  if (!profile) {
    return;
  }

  elements.memorySize.value = String(profile.memoryMb);
  elements.cpuProfile.value = profile.cpuProfile;
  elements.soundEnabled.checked = Boolean(profile.soundEnabled);

  const preferredPal95Package = availableGamePackages.find((item) => item.familyId === "pal95" && item.available);

  if (profile.id === "pal95" && preferredPal95Package) {
    elements.gamePackageSelect.value = preferredPal95Package.id;
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
  const selectedPackage = getSelectedGamePackage();
  const hasPackage = Boolean(selectedPackage);
  elements.startupDiskAutoRun.disabled = !hasPackage;
  elements.startupDiskSound.disabled = selectedPackage?.familyId !== "pal95";

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
  elements.gamePackageSelect.innerHTML = [
    '<option value="">不挂载扩展硬盘</option>',
    ...availableItems.map((item) => `<option value="${item.id}">${item.name} · ${item.mount.sizeLabel} · ${item.preferredSlot.toUpperCase()}</option>`)
  ].join("");
  elements.gamePackageSelect.disabled = availableItems.length === 0;

  const preferredGamePackage = availableItems.find((item) => item.familyId === "pal95");
  if (preferredGamePackage) {
    elements.gamePackageSelect.value = preferredGamePackage.id;
    applyPal95StartupDefaults();
  }
}

function getSelectedGamePackage() {
  return availableGamePackages.find((item) => item.id === elements.gamePackageSelect.value && item.available) || null;
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

async function resolveSelectedAttachments() {
  const selectedPackage = getSelectedGamePackage();

  if (!selectedPackage) {
    return [];
  }

  // 步骤 4：若原始扩展盘不是 HDD，则先让服务端自动转换并缓存，再把结果挂载给 v86。
  const resolvedPackage = await fetchJson(`/api/game-packages/${encodeURIComponent(selectedPackage.id)}/resolve-mount`, {
    method: "POST",
    body: JSON.stringify({})
  });

  if (resolvedPackage.converted) {
    appendLog(`${resolvedPackage.cached ? "复用" : "生成"}扩展 HDD: ${resolvedPackage.package.mount.name}`);
    appendLog(`扩展盘源路径: ${resolvedPackage.paths.sourceImagePath}`);
    appendLog(`扩展盘 HDD 路径: ${resolvedPackage.paths.hddImagePath}`);
  }

  appendLog(`扩展硬盘已就绪: ${resolvedPackage.package.mount.name} -> ${resolvedPackage.package.preferredSlot.toUpperCase()} (${resolvedPackage.package.mount.sizeLabel})`);
  return [
    {
      id: resolvedPackage.package.id,
      label: resolvedPackage.package.name,
      launchCommand: resolvedPackage.package.familyId === "pal95" ? (elements.startupDiskSound.checked ? "RUNPAL" : "RUNSAFE") : "",
      compatibility: resolvedPackage.package.compatibility,
      preferredSlot: resolvedPackage.package.preferredSlot,
      diskImage: {
        source: "server",
        name: resolvedPackage.package.mount.name,
        size: resolvedPackage.package.mount.size,
        url: resolvedPackage.package.mount.url,
        driveType: resolvedPackage.package.mount.driveType
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

  syncExtendDiskDescription();
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

function syncExtendDiskDescription() {
  const selectedPackage = getSelectedGamePackage();

  if (!selectedPackage) {
    elements.extendDiskDescription.textContent = "扩展硬盘: 未选择";
    return;
  }

  const segments = [`扩展硬盘: ${selectedPackage.mount.name}`, `格式: ${selectedPackage.sourceDriveType}`];

  if (selectedPackage.conversionRequired) {
    segments.push("启动时会自动转换为 HDD");
  } else {
    segments.push("当前已是 HDD，将直接挂载");
  }

  if (selectedPackage.note) {
    segments.push(`备注: ${selectedPackage.note}`);
  }

  elements.extendDiskDescription.textContent = segments.join(" | ");
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
