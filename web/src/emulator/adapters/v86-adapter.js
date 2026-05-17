let v86ModulePromise = null;
const BOOT_ORDER_FLOPPY_FIRST = 0x321;
const DOS_PROMPT_PATTERN = /^[AC]:\\>\s*$/;
const DOS_PROMPT_WAIT_TIMEOUT_MSEC = 1500;
const DOS_PROMPT_SCAN_DEBOUNCE_MSEC = 120;
const DOS_PROMPT_RESUME_GRACE_MSEC = 3000;

export class V86Adapter {
  constructor(terminal) {
    this.terminal = terminal;
    this.capturesKeyboard = false;
    this.display = null;
    this.emulator = null;
    this.context = null;
    this.paused = false;
    this.promptMonitorGeneration = 0;
    this.promptMonitorTimer = null;
    this.promptMonitorListener = null;
    this.promptIdleSnoozedUntil = 0;
  }

  async boot(context) {
    if (!context.diskImage) {
      throw new Error("未选择可启动镜像，请先选择 dos6.22.img。");
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

    // 步骤 2：初始化 BIOS、VGA、内存与启动顺序，真正进入 DOS 引导链路。
    this.display = context.display;
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
      disable_mouse: true,
      disable_speaker: !context.config.soundEnabled,
      ...driveOptions
    });
    this.paused = false;

    // 步骤 3：注册关键事件，便于观察 DOS 引导进度和画面模式切换。
    this.emulator.add_listener("emulator-ready", () => {
      context.onLog?.(`v86 已就绪，准备从 ${context.diskImage.driveType} 设备启动 ${context.diskImage.name}`);
    });

    this.emulator.add_listener("emulator-started", () => {
      context.onLog?.("v86 已开始运行，键盘焦点已切换到模拟器画面。");
      screenContainer.focus();
    });

    this.emulator.add_listener("screen-set-size", ([width, height, bpp]) => {
      context.onLog?.(`VGA 模式切换: ${width}x${height}x${bpp}`);
    });

    // 步骤 4：结合 wait_until_vga_screen_contains 和 screen-put-char，对 DOS 文本提示符进行被动感知与自动 idle。
    this.installPromptIdleMonitor();
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
    this.snoozePromptIdleMonitor();
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
    this.teardownPromptIdleMonitor();

    if (!this.emulator) {
      this.display?.clearV86Surface?.();
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

  installPromptIdleMonitor() {
    if (!this.emulator || !this.isPromptAutoPauseEnabled()) {
      return;
    }

    this.teardownPromptIdleMonitor();
    this.promptMonitorGeneration += 1;
    const generation = this.promptMonitorGeneration;

    this.promptMonitorListener = () => {
      this.schedulePromptScreenScan(generation);
    };

    this.emulator.add_listener("screen-put-char", this.promptMonitorListener);
    this.schedulePromptScreenScan(generation);
    this.startPromptWaitLoop(generation);
  }

  teardownPromptIdleMonitor() {
    this.promptMonitorGeneration += 1;

    if (this.promptMonitorTimer) {
      clearTimeout(this.promptMonitorTimer);
      this.promptMonitorTimer = null;
    }

    if (this.emulator && this.promptMonitorListener) {
      this.emulator.remove_listener?.("screen-put-char", this.promptMonitorListener);
    }

    this.promptMonitorListener = null;
    this.promptIdleSnoozedUntil = 0;
  }

  snoozePromptIdleMonitor() {
    this.promptIdleSnoozedUntil = performance.now() + DOS_PROMPT_RESUME_GRACE_MSEC;
    this.schedulePromptScreenScan(this.promptMonitorGeneration);
  }

  schedulePromptScreenScan(generation) {
    if (!this.emulator || generation !== this.promptMonitorGeneration || this.promptMonitorTimer) {
      return;
    }

    this.promptMonitorTimer = window.setTimeout(async () => {
      this.promptMonitorTimer = null;

      if (generation !== this.promptMonitorGeneration) {
        return;
      }

      await this.tryAutoIdleFromPrompt("screen-put-char");
    }, DOS_PROMPT_SCAN_DEBOUNCE_MSEC);
  }

  async startPromptWaitLoop(generation) {
    while (this.emulator && generation === this.promptMonitorGeneration) {
      const promptFound = await this.emulator.wait_until_vga_screen_contains(DOS_PROMPT_PATTERN, {
        timeout_msec: DOS_PROMPT_WAIT_TIMEOUT_MSEC
      });

      if (generation !== this.promptMonitorGeneration || !this.emulator) {
        return;
      }

      if (promptFound) {
        await this.tryAutoIdleFromPrompt("wait_until_vga_screen_contains");
      }
    }
  }

  async tryAutoIdleFromPrompt(source) {
    if (!this.emulator || !this.isPromptAutoPauseEnabled() || this.paused || !this.emulator.is_running()) {
      return false;
    }

    if (performance.now() < this.promptIdleSnoozedUntil) {
      return false;
    }

    const matchedPrompt = this.readPromptFromScreen();
    if (!matchedPrompt) {
      return false;
    }

    return Boolean(await this.context.onAutoPauseRequested?.("dos-prompt-idle", {
      matchedPrompt,
      pauseReason: `DOS 提示符空闲 (${matchedPrompt})`,
      logMessage: `检测到 DOS 文本提示符 ${matchedPrompt}，已自动进入 idle 暂停。`,
      source
    }));
  }

  readPromptFromScreen() {
    const rows = this.emulator?.screen_adapter?.get_text_screen?.();

    if (!rows || rows.length === 0) {
      return "";
    }

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const rowText = rows[index].trimRight();

      if (DOS_PROMPT_PATTERN.test(rowText)) {
        return rowText;
      }
    }

    return "";
  }

  isPromptAutoPauseEnabled() {
    const policy = this.context?.idlePolicy?.isPromptAutoPauseEnabled;
    return typeof policy === "function" ? policy() : Boolean(policy);
  }
}

async function loadV86Module() {
  if (!v86ModulePromise) {
    v86ModulePromise = import("/vendor/v86/libv86.mjs");
  }

  return v86ModulePromise;
}
