const DEFAULT_STYLE = {
  background: "#000000",
  foreground: "#33ff66",
  accent: "#9dffb0",
  fontFamily: '"IBM Plex Mono", "Courier New", monospace',
  fontSize: 18,
  lineHeight: 24,
  paddingX: 18,
  paddingY: 20
};

export class CanvasTerminal {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.lines = [];
    this.style = { ...DEFAULT_STYLE };
    this.cursorVisible = true;
    this.cursorColumn = 0;
    this.cursorRow = 0;
    this.prompt = "A:\\>";
    this.inputBuffer = "";
    this.animationTimer = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.render();
    }, 450);
  }

  dispose() {
    window.clearInterval(this.animationTimer);
  }

  reset() {
    this.lines = [];
    this.inputBuffer = "";
    this.cursorColumn = 0;
    this.cursorRow = 0;
    this.render();
  }

  boot(lines) {
    this.lines = [...lines];
    this.cursorRow = this.lines.length;
    this.inputBuffer = "";
    this.render();
  }

  writeLine(text = "", color = this.style.foreground) {
    this.lines.push({ text, color });
    this.cursorRow = this.lines.length;
    this.render();
  }

  setPrompt(prompt) {
    this.prompt = prompt;
    this.render();
  }

  setInputBuffer(value) {
    this.inputBuffer = value;
    this.cursorColumn = value.length;
    this.render();
  }

  renderStatus(title, detail) {
    this.reset();
    this.writeLine(title, this.style.accent);
    this.writeLine("");
    this.writeLine(detail);
  }

  render() {
    const { context, canvas, style } = this;

    context.fillStyle = style.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = `${style.fontSize}px ${style.fontFamily}`;
    context.textBaseline = "top";

    const maxRows = Math.floor((canvas.height - style.paddingY * 2) / style.lineHeight) - 1;
    const visibleLines = this.lines.slice(-maxRows);

    visibleLines.forEach((line, index) => {
      context.fillStyle = line.color || style.foreground;
      context.fillText(line.text, style.paddingX, style.paddingY + index * style.lineHeight);
    });

    const promptY = style.paddingY + visibleLines.length * style.lineHeight;
    const promptText = `${this.prompt}${this.inputBuffer}`;

    context.fillStyle = style.foreground;
    context.fillText(promptText, style.paddingX, promptY);

    if (this.cursorVisible) {
      const cursorText = `${this.prompt}${this.inputBuffer}`;
      const cursorX = style.paddingX + context.measureText(cursorText).width + 2;
      context.fillRect(cursorX, promptY + style.fontSize + 2, 12, 2);
    }
  }
}
