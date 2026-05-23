let v86ModulePromise = null;
const BOOT_ORDER_FLOPPY_FIRST = 0x321;
const SCREEN_SCAN_INTERVAL_MSEC = 250;
const BOOT_INTERACTION_SETTLE_MSEC = 200;
const EMM386_READY_PATTERN = /Press any key when ready\.\.\./i;

export class V86Adapter {
  constructor(terminal) {
    this.terminal = terminal;
    this.capturesKeyboard = false;
    this.display = null;
    this.emulator = null;
    this.context = null;
    this.paused = false;
    this.bootInteractionGeneration = 0;
    this.completedBootInteractions = new Set();
    this.bootInteractionTimer = null;
    this.screenContainer = null;
    this.screenViewport = null;
    this.resizeObserver = null;
    this.lastScreenMetrics = null;
  }

  async boot(context) {
    if (!context.diskImage) {
      throw new Error("未选择可启动镜像，请先选择 msdos622_dosidle_a.img。");
    }

    if (!context.runtimeAssets?.v86?.ready) {
      throw new Error(`v86 运行时未就绪，缺失资源: ${(context.runtimeAssets?.v86?.missing || []).join(", ")}`);
    }

    const { V86 } = await loadV86Module();
    const screenContainer = context.display?.mountV86Surface();
    this.context = context;

    if (!screenContainer) {
      throw new Error("未找到 v86 屏幕容器。");
    }

    // 步骤 1：根据启动盘与附加盘位构造 v86 需要的块设备描述。
    const driveOptions = await this.createDriveOptions(context.diskImage, context.attachments || []);
    const cpuOptions = resolveCpuOptions(context.config.cpuProfile);

    // 步骤 2：初始化 BIOS、VGA、内存与启动顺序，真正进入 DOS 引导链路。
    this.display = context.display;
    this.screenContainer = screenContainer;
    this.screenViewport = screenContainer.parentElement;
    this.installScreenResizeObserver();
    this.emulator = new V86({
      wasm_path: context.runtimeAssets.v86.wasmUrl,
      memory_size: context.config.memoryMb * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
      bios: { url: context.runtimeAssets.v86.biosUrl },
      vga_bios: { url: context.runtimeAssets.v86.vgaBiosUrl },
      screen_container: screenContainer,
      screen: {
        container: screenContainer,
        use_graphical_text: true,
        scaling: 1
      },
      boot_order: BOOT_ORDER_FLOPPY_FIRST,
      autostart: true,
      fastboot: true,
      disable_mouse: true,
      disable_speaker: !context.config.soundEnabled,
      ...cpuOptions,
      ...driveOptions
    });
    this.paused = false;

    // 步骤 3：注册关键事件，便于观察 DOS 引导进度和画面模式切换。
    this.emulator.add_listener("emulator-ready", () => {
      context.onLog?.(`v86 已就绪，准备从 ${context.diskImage.driveType} 设备启动 ${context.diskImage.name}`);
      context.onLog?.(`兼容配置已生效: memory=${context.config.memoryMb}MB, cpu=${cpuOptions.label}, sound=${context.config.soundEnabled ? "on" : "off"}`);
      if (context.config.soundEnabled) {
        context.onLog?.(`[声音调试] 当前启动盘布局版本: ${context.imageMeta?.startupDiskLayoutVersion || "pal95-sound-v4"}`);
        context.onLog?.(`[声音调试] 启动参数硬件对齐: Port=220, IRQ=${context.config.soundIrq || 5}, DMA=1`);
      }
    });

    this.emulator.add_listener("emulator-started", () => {
      context.onLog?.("v86 已开始运行，键盘焦点已切换到模拟器画面。");
      screenContainer.focus();
    });

    this.emulator.add_listener("emulator-stopped", () => {
      context.onLog?.("v86 运行已停止。");
    });

    this.emulator.add_listener("screen-set-size", ([width, height, bpp]) => {
      this.lastScreenMetrics = { width, height, bpp };
      this.fitScreenViewport();
      context.onLog?.(`VGA 模式切换: ${width}x${height}x${bpp}`);
    });

    this.emulator.add_listener("download-error", (detail) => {
      context.onLog?.(`镜像资源加载失败: ${detail.file_name}`);
    });

    // 步骤 4：处理 DOS 启动过程中的交互页并安装音频中转调试。
    this.installBootInteractionAutomation();
    this.installAudioDebugBridge(context);
  }

  async handleCommand() {
    return undefined;
  }

  async reset() {
    await this.destroy();
    this.display?.showTerminal();
    this.terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择镜像并点击启动。");
  }

  async pause() {
    if (!this.emulator || this.paused || !this.emulator.is_running()) {
      return false;
    }

    await this.emulator.stop();
    this.paused = true;
    return true;
  }

  async resume() {
    if (!this.emulator || !this.paused) {
      return false;
    }

    await this.emulator.run();
    this.paused = false;
    this.display?.focusV86Surface?.();
    return true;
  }

  isRunning() {
    return Boolean(this.emulator && this.emulator.is_running());
  }

  isPaused() {
    return this.paused;
  }

  async destroy() {
    this.teardownBootInteractionAutomation();
    this.teardownScreenResizeObserver();

    if (!this.emulator) {
      this.display?.clearV86Surface?.();
      this.screenContainer = null;
      this.screenViewport = null;
      this.lastScreenMetrics = null;
      this.context = null;
      return;
    }

    if (this.emulator.is_running()) {
      await this.emulator.stop().catch(() => undefined);
    }

    await this.emulator.destroy().catch(() => undefined);
    this.emulator = null;
    this.context = null;
    this.paused = false;
    this.completedBootInteractions.clear();
    this.screenContainer = null;
    this.screenViewport = null;
    this.lastScreenMetrics = null;
    this.display?.clearV86Surface?.();
  }

  async createDriveOptions(diskImage, attachments = []) {
    const driveOptions = {};
    const usedSlots = new Set();

    await this.assignDiskImage(driveOptions, usedSlots, diskImage, null);

    for (const attachment of attachments) {
      await this.assignDiskImage(driveOptions, usedSlots, attachment.diskImage, attachment.preferredSlot);
    }

    return driveOptions;
  }

  async assignDiskImage(driveOptions, usedSlots, diskImage, preferredSlot) {
    const targetSlot = preferredSlot || this.pickDefaultSlot(diskImage.driveType, usedSlots);

    if (usedSlots.has(targetSlot)) {
      throw new Error(`磁盘槽位冲突: ${targetSlot}`);
    }

    driveOptions[targetSlot] = await this.createImageDescriptor(diskImage);
    usedSlots.add(targetSlot);
  }

  pickDefaultSlot(driveType, usedSlots) {
    if (driveType === "cdrom") {
      return "cdrom";
    }

    if (driveType === "hardDisk") {
      return usedSlots.has("hda") ? "hdb" : "hda";
    }

    return usedSlots.has("fda") ? "fdb" : "fda";
  }

  async createImageDescriptor(diskImage) {
    return diskImage.source === "upload" ? { buffer: await diskImage.file.arrayBuffer() } : { url: diskImage.url };
  }

  installBootInteractionAutomation() {
    this.teardownBootInteractionAutomation();

    if (!this.emulator) {
      return;
    }

    this.bootInteractionGeneration += 1;
    const generation = this.bootInteractionGeneration;
    this.scheduleBootInteractionScan(generation);
  }

  teardownBootInteractionAutomation() {
    this.bootInteractionGeneration += 1;

    if (this.bootInteractionTimer) {
      clearTimeout(this.bootInteractionTimer);
      this.bootInteractionTimer = null;
    }

    this.completedBootInteractions.clear();
  }

  scheduleBootInteractionScan(generation) {
    if (!this.emulator || generation !== this.bootInteractionGeneration || this.bootInteractionTimer) {
      return;
    }

    this.bootInteractionTimer = window.setTimeout(async () => {
      this.bootInteractionTimer = null;

      if (generation !== this.bootInteractionGeneration || !this.emulator) {
        return;
      }

      await this.tryHandleBootInteraction("emm386-ready", {
        pattern: EMM386_READY_PATTERN,
        logMessage: "检测到 EMM386 等待按键提示，已自动发送回车继续 DOS 启动。",
        keyText: "\r"
      });

      this.scheduleBootInteractionScan(generation);
    }, SCREEN_SCAN_INTERVAL_MSEC);
  }

  async tryHandleBootInteraction(interactionId, interaction) {
    if (!this.emulator || this.paused || !this.emulator.is_running() || this.completedBootInteractions.has(interactionId)) {
      return false;
    }

    const matchedText = this.readScreenLine(interaction.pattern);
    if (!matchedText) {
      return false;
    }

    this.completedBootInteractions.add(interactionId);
    this.display?.focusV86Surface?.();
    this.context?.onLog?.(interaction.logMessage);
    await sleep(BOOT_INTERACTION_SETTLE_MSEC);

    if (!this.emulator || this.paused || !this.emulator.is_running()) {
      return false;
    }

    this.emulator.keyboard_send_text(interaction.keyText);
    return true;
  }

  readScreenLine(pattern) {
    const rows = this.emulator?.screen_adapter?.get_text_screen?.();

    if (!rows || rows.length === 0) {
      return "";
    }

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const rowText = rows[index].trimRight();

      if (pattern.test(rowText)) {
        return rowText;
      }
    }

    return "";
  }

  installScreenResizeObserver() {
    this.teardownScreenResizeObserver();

    if (!this.screenViewport || typeof ResizeObserver === "undefined") {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.fitScreenViewport();
    });
    this.resizeObserver.observe(this.screenViewport);
  }

  teardownScreenResizeObserver() {
    if (!this.resizeObserver) {
      return;
    }

    this.resizeObserver.disconnect();
    this.resizeObserver = null;
  }

  fitScreenViewport() {
    if (!this.screenContainer || !this.screenViewport) {
      return;
    }

    const canvas = this.screenContainer.querySelector("canvas");

    if (!canvas) {
      window.requestAnimationFrame(() => this.fitScreenViewport());
      return;
    }

    // 步骤 5：优先使用画布真实像素尺寸做等比缩放，避免单纯 width:100% 导致 320x200 画面被裁掉一半。
    const sourceWidth = canvas.width || this.lastScreenMetrics?.width || 640;
    const sourceHeight = canvas.height || this.lastScreenMetrics?.height || 400;
    const availableWidth = Math.max(1, this.screenViewport.clientWidth - 16);
    const availableHeight = Math.max(1, this.screenViewport.clientHeight - 16);
    const rawScale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
    const scale = rawScale >= 1 ? Math.max(1, Math.floor(rawScale)) : rawScale;
    const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.floor(sourceHeight * scale));

    this.screenContainer.style.width = `${targetWidth}px`;
    this.screenContainer.style.height = `${targetHeight}px`;
    canvas.style.width = `${targetWidth}px`;
    canvas.style.height = `${targetHeight}px`;
  }

  installAudioDebugBridge(context) {
    if (!this.emulator || !context.config.soundEnabled) {
      return;
    }

    const bus = this.emulator.bus;

    bus.register("pcspeaker-enable", () => {
      context.onLog?.("[声音中转] PC Speaker 发声通道已打开。");
    });

    bus.register("pcspeaker-disable", () => {
      context.onLog?.("[声音中转] PC Speaker 发声通道已关闭。");
    });

    bus.register("dac-enable", () => {
      context.onLog?.("[声音中转] Sound Blaster 16 (SB16) 核心音频 DMA 渲染就绪。");
    });

    bus.register("dac-tell-sampling-rate", (rate) => {
      context.onLog?.(`[声音中转] SB16 采样率已对齐并设置为: ${rate}Hz`);
    });

    bus.register("mixer-volume", ([sourceId, channel, volumeDecibel]) => {
      if (sourceId === 0) {
        context.onLog?.(`[声音中转] SB16 主控音量调节: 通道=${channel}, 音量=${volumeDecibel}dB`);
      }
    });
  }
}

function resolveCpuOptions(cpuProfile) {
  if (cpuProfile === "386sx") {
    return { label: "386SX / CPUID-3", cpuid_level: 3 };
  }

  if (cpuProfile === "pentium") {
    return { label: "Pentium / CPUID-5", cpuid_level: 5 };
  }

  return { label: "486DX2 / CPUID-4", cpuid_level: 4 };
}

function sleep(timeoutMsec) {
  return new Promise((resolve) => window.setTimeout(resolve, timeoutMsec));
}

async function loadV86Module() {
  if (!v86ModulePromise) {
    v86ModulePromise = import("/vendor/v86/libv86.mjs");
  }

  return v86ModulePromise;
}
