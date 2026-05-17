let v86ModulePromise = null;
const BOOT_ORDER_FLOPPY_FIRST = 0x321;

export class V86Adapter {
  constructor(terminal) {
    this.terminal = terminal;
    this.capturesKeyboard = false;
    this.display = null;
    this.emulator = null;
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

    if (!screenContainer) {
      throw new Error("未找到 v86 屏幕容器。");
    }

    // 步骤 1：根据镜像来源和驱动类型构造 v86 所需的块设备描述。
    const driveOptions = await this.createDriveOptions(context.diskImage);

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
  }

  async handleCommand() {
    return undefined;
  }

  async reset() {
    await this.destroy();
    this.display?.showTerminal();
    this.terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择镜像并点击启动。");
  }

  async destroy() {
    if (!this.emulator) {
      this.display?.clearV86Surface?.();
      return;
    }

    if (this.emulator.is_running()) {
      await this.emulator.stop().catch(() => undefined);
    }

    await this.emulator.destroy().catch(() => undefined);
    this.emulator = null;
    this.display?.clearV86Surface?.();
  }

  async createDriveOptions(diskImage) {
    const image = diskImage.source === "upload" ? { buffer: await diskImage.file.arrayBuffer() } : { url: diskImage.url };

    if (diskImage.driveType === "cdrom") {
      return { cdrom: image };
    }

    if (diskImage.driveType === "hardDisk") {
      return { hda: image };
    }

    return { fda: image };
  }
}

async function loadV86Module() {
  if (!v86ModulePromise) {
    v86ModulePromise = import("/vendor/v86/libv86.mjs");
  }

  return v86ModulePromise;
}
