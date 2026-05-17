export class V86Adapter {
  constructor(terminal) {
    this.terminal = terminal;
  }

  async boot(context) {
    // 步骤 1：优先检查浏览器端是否已经放置可用的 v86 运行时资源。
    const runtimeUrl = "/vendor/v86/libv86.js";
    const response = await fetch(runtimeUrl, { method: "HEAD" });

    if (!response.ok) {
      throw new Error("未检测到 /vendor/v86/libv86.js，请先放入 v86 运行时资源后再切换到真实内核模式。");
    }

    // 步骤 2：当前仓库仅提供接入边界与配置通道，真实设备初始化留在后续阶段实现。
    this.terminal.renderStatus("V86 Adapter Ready", `镜像: ${context.imageMeta?.name || "未提供"}\n下一步需要在此处接入 BIOS、磁盘、VGA 与键盘设备映射。`);
  }

  async handleCommand() {
    throw new Error("V86 适配器启用后，键盘输入应直接交给真实 DOS 内核处理。");
  }

  async reset() {
    this.terminal.renderStatus("V86 Adapter", "真实内核尚未初始化，请重新启动。");
  }
}
