const BOOT_LINES = [
  "Starting MS-DOS...",
  "HIMEM is testing extended memory...done.",
  "Loading COMMAND.COM",
  "MSCDEX 2.25 initialized.",
  "Sound Blaster 16 compatible driver loaded.",
  "",
  "Microsoft(R) MS-DOS(R) Version 6.00",
  "(C)Copyright Microsoft Corp 1981-1993.",
  ""
];

const COMMAND_RESPONSES = {
  VER: ["MS-DOS Version 6.00"],
  HELP: ["Supported commands: DIR, VER, CLS, MEM, PAL95, EXIT"],
  DIR: [" Volume in drive A is DOSBOOT", " Directory of A:\\", "", "COMMAND  COM      54745  04-01-1993", "CONFIG   SYS        287  04-01-1993", "AUTOEXEC BAT        193  04-01-1993", "PAL95    BAT         61  08-15-1995", "PAL      EXE    1228800  08-15-1995", "        5 file(s)"],
  MEM: ["655,360 bytes total conventional memory", "524,288 bytes available to MS-DOS", "15,728,640 bytes total contiguous extended memory"],
  PAL95: ["Launching 仙剑奇侠传 95...", "VGA mode switch requested.", "SB16 digital audio requested.", "当前为 Mock 适配器，真实游戏运行需接入 v86 / WASM 内核。"],
  EXIT: ["Session halted."]
};

export class MockDosAdapter {
  constructor(terminal, options = {}) {
    this.terminal = terminal;
    this.options = options;
    this.running = false;
  }

  async boot(context) {
    this.running = true;

    // 步骤 1：展示 DOS 引导输出，模拟 BIOS -> DOS -> Shell 的启动链路。
    this.terminal.boot([]);
    for (const line of BOOT_LINES) {
      this.terminal.writeLine(line);
      await this.delay(180);
    }

    // 步骤 2：根据载入镜像信息打印当前运行参数，便于联调镜像与会话配置。
    if (context.imageMeta) {
      this.terminal.writeLine(`Image: ${context.imageMeta.name} (${context.imageMeta.sizeLabel})`, "#9dffb0");
    }
    this.terminal.writeLine(`CPU: ${context.config.cpuProfile}  Memory: ${context.config.memoryMb}MB`, "#9dffb0");
    this.terminal.writeLine("");
    this.terminal.setPrompt("A:\\>");
    this.terminal.setInputBuffer("");
  }

  async handleCommand(command) {
    const normalizedCommand = command.trim().toUpperCase();

    if (!normalizedCommand) {
      this.terminal.writeLine("");
      return;
    }

    // 步骤 1：原样回显命令输入，保持 DOS 交互体验。
    this.terminal.writeLine(`A:\\>${command}`);

    // 步骤 2：执行内置命令并返回演示结果，模拟第一版 Shell 行为。
    if (normalizedCommand === "CLS") {
      this.terminal.boot([]);
      return;
    }

    const responseLines = COMMAND_RESPONSES[normalizedCommand] || [`Bad command or file name: ${command}`];
    for (const line of responseLines) {
      this.terminal.writeLine(line);
    }

    // 步骤 3：在 EXIT 指令下停止会话，给后续真实引擎对齐生命周期留出接口。
    if (normalizedCommand === "EXIT") {
      this.running = false;
    }
  }

  async reset() {
    this.running = false;
    this.terminal.renderStatus("MS-DOS 6.0 Simulator", "请选择镜像并点击启动。");
  }

  delay(durationMs) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, durationMs);
    });
  }
}
