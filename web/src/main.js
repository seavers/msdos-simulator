import { CanvasTerminal } from "./core/canvas-terminal.js";
import { EmulatorRuntime } from "./emulator/emulator-runtime.js";

const elements = {
  adapterSelect: document.querySelector("#adapter-select"),
  bootButton: document.querySelector("#boot-button"),
  cpuProfile: document.querySelector("#cpu-profile"),
  eventLog: document.querySelector("#event-log"),
  fileInput: document.querySelector("#image-file"),
  heroStatus: document.querySelector("#hero-status"),
  memorySize: document.querySelector("#memory-size"),
  profileSelect: document.querySelector("#profile-select"),
  resetButton: document.querySelector("#reset-button"),
  runtimeMode: document.querySelector("#runtime-mode"),
  screen: document.querySelector("#dos-screen"),
  soundEnabled: document.querySelector("#sound-enabled")
};

const terminal = new CanvasTerminal(elements.screen);
const runtime = new EmulatorRuntime(terminal, {
  onLifecycle: updateLifecycle
});

let profiles = [];
let activeImageMeta = null;
let inputBuffer = "";

bootstrap().catch((error) => {
  appendLog(`初始化失败: ${error.message}`);
});

async function bootstrap() {
  // 步骤 1：加载后端配置档案，提供一套可复用的启动预设。
  profiles = await fetchJson("/api/profiles");
  populateProfiles(profiles);

  // 步骤 2：建立键盘与按钮事件，串联控制面板和 Canvas 终端。
  bindEvents();

  // 步骤 3：渲染默认待机画面，给用户明确的下一步操作提示。
  terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择镜像并点击启动。");
  appendLog("系统已就绪，默认使用 Mock DOS 适配器。");
}

function bindEvents() {
  elements.fileInput.addEventListener("change", handleFileSelected);
  elements.profileSelect.addEventListener("change", syncProfileSelection);
  elements.adapterSelect.addEventListener("change", () => {
    elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;
  });
  elements.bootButton.addEventListener("click", handleBoot);
  elements.resetButton.addEventListener("click", handleReset);

  window.addEventListener("keydown", async (event) => {
    if (!["Backspace", "Enter"].includes(event.key) && event.key.length !== 1) {
      return;
    }

    if (!runtime.currentAdapter) {
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
    activeImageMeta = null;
    return;
  }

  // 步骤 1：在浏览器端读取镜像头部，快速判断是否具备标准引导扇区签名。
  const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const hasBootSignature = header[510] === 0x55 && header[511] === 0xaa;

  activeImageMeta = {
    name: file.name,
    size: file.size,
    sizeLabel: formatBytes(file.size),
    hasBootSignature
  };

  // 步骤 2：把镜像元信息和当前参数持久化到后端，为后续存储与多配置切换做准备。
  await fetchJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      imageMeta: activeImageMeta,
      config: collectConfig()
    })
  });

  appendLog(`已载入镜像: ${file.name} (${activeImageMeta.sizeLabel})，Boot Signature: ${hasBootSignature ? "0x55AA" : "缺失"}`);
}

async function handleBoot() {
  const selectedProfile = profiles.find((profile) => profile.id === elements.profileSelect.value) || profiles[0];
  const config = collectConfig(selectedProfile);

  inputBuffer = "";
  terminal.setInputBuffer("");
  elements.runtimeMode.textContent = `适配器: ${elements.adapterSelect.value}`;

  appendLog(`准备启动: adapter=${elements.adapterSelect.value}, profile=${selectedProfile?.name || "custom"}`);

  await runtime.boot({
    adapterType: elements.adapterSelect.value,
    config,
    imageMeta: activeImageMeta,
    profile: selectedProfile
  });
}

async function handleReset() {
  inputBuffer = "";
  terminal.setInputBuffer("");
  await runtime.reset();
  appendLog("会话已重置。");
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
