# MS-DOS 6.0 Web 模拟器架构设计

## 1. 目标边界

本项目的目标不是做一个“类 DOS 界面”，而是搭建一个可以真正承载 `MS-DOS 6.0` 镜像启动的 Web 模拟器框架，并以“最终能启动《仙剑奇侠传 95》第一代版本”为兼容性目标。

当前仓库已经落地以下基础能力：

- 前端主流程在浏览器中运行，显示层使用 `Canvas` 渲染。
- 后端提供配置、会话、镜像元信息记录能力。
- 模拟器内核通过适配层抽象，当前包含 `MockDosAdapter` 与 `V86Adapter` 接入边界。
- 支持本地镜像文件选择、镜像头部 Boot Signature 检查、启动参数管理、运行日志展示。

## 2. 分层架构

```text
+--------------------------- Browser UI ----------------------------+
| Control Panel | Canvas Terminal | Runtime Status | Event Log     |
+---------------------------+--------------------------------------+
                            |
                            v
+---------------------- Emulator Runtime ---------------------------+
| Session Orchestrator | Input Dispatch | Adapter Lifecycle        |
+----------------------+-------------------------------------------+
                       |
          +------------+------------+
          |                         |
          v                         v
+-------------------+    +-------------------------------+
| MockDosAdapter    |    | V86Adapter / Future WASM Core |
| 演示流程、脚手架     |    | 真实 x86 + BIOS + VGA + I/O    |
+-------------------+    +-------------------------------+
                       |
                       v
+---------------------- Backend API -------------------------------+
| Profiles | Sessions | Image Metadata | Future Save-State/Store  |
+--------------------------------------------------------------- --+
```

## 3. 前端职责

### 3.1 Canvas 显示层

- 统一承担 DOS 文本模式与未来 VGA 图形模式显示。
- 当前版本先实现文本模式终端抽象 `CanvasTerminal`。
- 后续如果接入真实内核，需要补充：
  - 像素缓冲区刷新。
  - 调色板同步。
  - 320x200 / 640x480 VGA 模式映射。
  - 帧率控制与页面失焦降频。

### 3.2 Emulator Runtime

`EmulatorRuntime` 是业务层总控，负责：

- 接收 UI 启动参数。
- 选择并创建适配器实例。
- 管理 `idle -> booting -> running -> error` 生命周期。
- 分发键盘输入。
- 未来承接存档、暂停、快照恢复、软重启。

### 3.3 适配器层

当前设计成可插拔接口，是为了避免以后从 `mock` 切到 `v86` 或自研内核时大面积重写 UI 和后端。

建议统一接口如下：

```ts
interface DosAdapter {
  boot(context: BootContext): Promise<void>;
  reset(): Promise<void>;
  handleCommand?(command: string): Promise<void>;
  mountDisk?(disk: ArrayBuffer): Promise<void>;
  saveState?(): Promise<ArrayBuffer>;
  restoreState?(snapshot: ArrayBuffer): Promise<void>;
}
```

## 4. 后端职责

当前后端使用 Node 内置 `http`，主要为了在零依赖条件下先把能力边界跑通。

已实现：

- `GET /api/health`: 健康检查。
- `GET /api/profiles`: 启动配置预设。
- `POST /api/sessions`: 记录镜像元信息与启动参数。

后续建议扩展：

- `POST /api/images`: 镜像上传与对象存储。
- `GET /api/images/:id`: 镜像详情与校验值。
- `POST /api/save-states`: 存档快照保存。
- `GET /api/save-states/:sessionId`: 会话恢复。
- `POST /api/game-profiles`: 游戏兼容参数模板，例如仙剑 95 专用配置。

## 5. 真实 MS-DOS 6.0 启动方案

### 5.1 推荐方案：接入 v86

对于“浏览器里启动 DOS 镜像”的目标，最现实的第一阶段方案是接入 `v86`：

- 优势：
  - 已经具备 x86、BIOS、VGA、磁盘、键盘等关键能力。
  - 更适合作为 Web 端 DOS 启动底座。
  - 可以显著降低从零实现 CPU/芯片组的工作量。

- 接入步骤：
  1. 把 `v86` 运行时资源放到 `web/vendor/v86/`。
  2. 在 `V86Adapter` 中初始化 BIOS、VGA、PS/2 键盘、FDD/HDD 控制器。
  3. 把用户选择的镜像文件映射为软盘或硬盘设备。
  4. 把屏幕输出桥接到 Canvas。
  5. 把键盘事件直通给内核，而不是走 Mock Shell 命令解释。

### 5.2 自研 WASM 内核方案

如果后续要做更强控制力或更细粒度调试，可以考虑：

- Rust/C++ 实现 x86 解释器或 JIT。
- 设备层实现 PIC、PIT、DMA、VGA、键盘控制器、FDC/IDE。
- 编译到 WASM，前端主线程只负责 UI，CPU 循环放到 Worker。

这条路更重，但适合长期演进。

## 6. 仙剑 95 兼容性路线

要实现《仙剑奇侠传 95》可运行，建议按下面顺序推进：

1. 先完成 MS-DOS 6.0 软盘/硬盘镜像稳定启动。
2. 补齐 `CONFIG.SYS` / `AUTOEXEC.BAT` 对 XMS/EMS 的配置兼容。
3. 实现或验证以下设备能力：
   - VGA 256 色模式。
   - PS/2 键盘输入。
   - PIT 定时器。
   - Sound Blaster 16 / AdLib 基础音频。
   - FAT12 / FAT16 镜像读写。
4. 加入游戏专用预设：
   - 16MB 内存。
   - 486DX2 或接近档位。
   - 声卡默认开启。
   - 帧率限制与音频缓冲参数。
5. 再做 save state、全屏、输入映射、性能分析。

## 7. 目录规划

```text
server/
  index.mjs                # 配置、会话、静态资源服务
storage/
  profiles.json            # 启动预设
  sessions.json            # 最近会话
web/
  index.html               # 主界面
  assets/app.css           # 页面样式
  src/main.js              # 前端总控
  src/core/canvas-terminal.js
  src/emulator/emulator-runtime.js
  src/emulator/adapters/mock-dos-adapter.js
  src/emulator/adapters/v86-adapter.js
docs/
  architecture.md          # 架构设计与演进路线
```

## 8. 当前实现结论

当前仓库已经具备“工程骨架 + 页面主流程 + Canvas 呈现 + 后端配置/会话管理 + 模拟器适配层”的第一版基础。

要让“真实 MS-DOS 6.0 镜像启动并进一步跑仙剑 95”真正达成，下一阶段核心工作是：

1. 接入真实 DOS 模拟内核，优先推荐 `v86`。
2. 把镜像文件从“元信息记录”升级为“真实块设备挂载”。
3. 补齐 VGA / 键盘 / 声卡 / 内存扩展等兼容层。
4. 为仙剑 95 做专项启动与性能调优。
