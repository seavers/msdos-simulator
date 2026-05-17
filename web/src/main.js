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
  memorySize: document.querySelector("#memory-size"),
  profileSelect: document.querySelector("#profile-select"),
  refreshImagesButton: document.querySelector("#refresh-images-button"),
  resetButton: document.querySelector("#reset-button"),
  runtimeAssetsStatus: document.querySelector("#runtime-assets-status"),
  runtimeMode: document.querySelector("#runtime-mode"),
  screen: document.querySelector("#dos-screen"),
  serverImageField: document.querySelector("#server-image-field"),
  serverImageSelect: document.querySelector("#server-image-select"),
  soundEnabled: document.querySelector("#sound-enabled"),
  uploadImageField: document.querySelector("#upload-image-field"),
  v86Screen: document.querySelector("#v86-screen")
};

const terminal = new CanvasTerminal(elements.screen);
const display = createDisplayManager(elements.screen, elements.v86Screen);
const runtime = new EmulatorRuntime(terminal, {
  onLifecycle: updateLifecycle
});

let profiles = [];
let serverImages = [];
let runtimeAssets = null;
let activeLocalImage = null;
let inputBuffer = "";

bootstrap().catch((error) => {
  appendLog(`初始化失败: ${error.message}`);
});

async function bootstrap() {
  // 步骤 1：先建立事件和默认待机画面，让页面可以在异步资源返回前就绪。
  bindEvents();
  terminal.renderStatus("MS-DOS 6.0 Simulator", "正在检测 v86 运行时与固定目录镜像...");

  // 步骤 2：并行加载配置、固定镜像列表和 v86 运行时状态。
  const [profileItems, diskImages, assets] = await Promise.all([
    fetchJson("/api/profiles"),
    fetchJson("/api/disk-images"),
    fetchJson("/api/runtime-assets")
  ]);

  profiles = profileItems;
  serverImages = diskImages;
  runtimeAssets = assets;

  populateProfiles(profiles);
  populateServerImages(serverImages);
  applyRuntimeAssets(runtimeAssets);
  syncImageSource();
  syncSelectedImageStatus();

  // 步骤 3：如果真实内核资源已经就绪，就默认切到 v86 作为首要启动路径。
  if (runtimeAssets?.v86?.ready) {
    elements.adapterSelect.value = "v86";
  }
  elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;

  terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择 dos6.22.img 并点击启动。");
  appendLog("系统已就绪，当前首要目标是通过 v86 启动 dos6.22.img。");
}

function bindEvents() {
  elements.fileInput.addEventListener("change", handleFileSelected);
  elements.imageSource.addEventListener("change", syncImageSource);
  elements.profileSelect.addEventListener("change", syncProfileSelection);
  elements.serverImageSelect.addEventListener("change", syncSelectedImageStatus);
  elements.adapterSelect.addEventListener("change", () => {
    elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;
  });
  elements.refreshImagesButton.addEventListener("click", refreshServerImages);
  elements.bootButton.addEventListener("click", handleBoot);
  elements.resetButton.addEventListener("click", handleReset);

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

  inputBuffer = "";
  terminal.setInputBuffer("");
  elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;

  appendLog(`准备启动: adapter=${elements.adapterSelect.value}, image=${selectedImage.imageMeta.name}, profile=${selectedProfile?.name || "custom"}`);

  await runtime.boot({
    adapterType: elements.adapterSelect.value,
    config,
    display,
    diskImage: selectedImage.diskImage,
    imageMeta: selectedImage.imageMeta,
    onLog: appendLog,
    profile: selectedProfile,
    runtimeAssets
  });
}

async function handleReset() {
  inputBuffer = "";
  terminal.setInputBuffer("");
  await runtime.reset();
  appendLog("会话已重置。");
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
    soundEnabled: elements.soundEnabled.checked
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
    error: "启动失败"
  };

  elements.heroStatus.textContent = labels[status] || status;

  if (status === "error" && context?.error) {
    appendLog(`启动失败: ${context.error.message}`);
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

function syncSelectedImageStatus() {
  try {
    const selectedImage = resolveSelectedImage();
    elements.imageStatus.textContent = `${selectedImage.imageMeta.name} · ${selectedImage.imageMeta.sizeLabel || formatBytes(selectedImage.imageMeta.size)} · ${selectedImage.imageMeta.driveType}`;
  } catch (error) {
    elements.imageStatus.textContent = error.message.replace("Error: ", "");
  }
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
    }
  };
}
