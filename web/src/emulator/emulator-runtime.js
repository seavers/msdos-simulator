import { MockDosAdapter } from "./adapters/mock-dos-adapter.js";
import { V86Adapter } from "./adapters/v86-adapter.js";

const ADAPTERS = {
  mock: MockDosAdapter,
  v86: V86Adapter
};

export class EmulatorRuntime {
  constructor(terminal, hooks) {
    this.terminal = terminal;
    this.hooks = hooks;
    this.currentAdapter = null;
    this.context = null;
  }

  async boot(context) {
    if (this.currentAdapter?.destroy) {
      await this.currentAdapter.destroy();
    }

    const AdapterClass = ADAPTERS[context.adapterType] || MockDosAdapter;
    this.context = context;
    this.currentAdapter = new AdapterClass(this.terminal, context.config);

    this.hooks.onLifecycle("booting", context);

    try {
      await this.currentAdapter.boot(context);
      this.hooks.onLifecycle("running", context);
    } catch (error) {
      context.display?.showTerminal?.();
      this.hooks.onLifecycle("error", { ...context, error });
      this.terminal.writeLine(error.message, "#ff8e8e");
    }
  }

  async reset() {
    if (this.currentAdapter?.reset) {
      await this.currentAdapter.reset();
    }
    this.hooks.onLifecycle("idle", this.context);
  }

  shouldCaptureKeyboard() {
    return Boolean(this.currentAdapter?.capturesKeyboard);
  }

  async handleCommand(command) {
    if (!this.currentAdapter?.handleCommand) {
      return;
    }

    await this.currentAdapter.handleCommand(command);
  }
}
