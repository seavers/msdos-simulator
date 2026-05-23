# PAL95 启动盘与扩展盘说明

## 1. 当前方案

现在的链路已经调整为“两张盘各司其职”：

1. `storage/images/` 里的系统盘镜像只负责 DOS 启动。
2. `storage/startupDisk/` 里的生成盘只负责覆盖 `CONFIG.SYS`、`AUTOEXEC.BAT`，并注入辅助 BAT。
3. `storage/extendDisk/` 里的原始扩展盘镜像会直接挂载给 `v86`，不再复制、不再重打 FAT16，也不再写入 `storage/generated/`。

对《仙剑奇侠传 95》来说，这意味着：

1. 原始 PAL95 镜像本身保持不变。
2. `RUNSAFE.BAT`、`RUNPAL.BAT`、`PALDIAG.BAT`、`PALREAD.TXT` 都放在 `A:` 的启动盘里。
3. 如果需要切到 `C:`、设置环境变量、执行 `PAL.EXE`，全部通过启动盘脚本完成。

## 2. `storage/extendDisk/` 应该放什么

这里现在要求放“可直接挂载的原始镜像文件”，而不是解压目录。

支持的后缀：

- `.img`
- `.ima`
- `.vfd`
- `.flp`
- `.bin`
- `.iso`

推荐做法：

1. 直接把准备好的 PAL95 DOS 镜像放到 `storage/extendDisk/` 根目录。
2. 不要再放到 `storage/extendDisk/pal95/` 这类子目录里。
3. 页面里的“扩展硬盘”会直接扫描这个根目录下的镜像文件。

## 3. PAL95 原始镜像需要满足什么

因为当前方案不再改写原始 PAL95 镜像，所以它本身需要满足下面这些前提：

1. 镜像挂载后，DOS 里能够以 `C:` 访问。
2. `C:` 根目录或你预期的启动目录里，必须能找到 `PAL.EXE` 以及对应资源文件。
3. 如果你依赖特定的 `SETUP.DAT`、`RUNPAL.BAT`、`RUNSAFE.BAT`、目录结构或安装结果，这些内容需要你在线下先写进原始镜像。
4. 如果游戏必须从某个非根目录启动，也需要你在线下整理好目录布局。

当前启动盘只会做这些事情：

1. 配置 `HIMEM.SYS`、`EMM386.EXE`、`DOS=HIGH,UMB`、`MSCDEX`、`DOSIDLE`。
2. 在 `A:` 注入 `RUNSAFE.BAT`、`RUNPAL.BAT` 等辅助脚本。
3. 在需要时从 `A:` 切到 `C:` 再执行 `PAL.EXE`。

当前启动盘不会做这些事情：

1. 不会解析你的原始 PAL95 镜像内容。
2. 不会自动修改原始镜像里的 `SETUP.DAT`。
3. 不会把 `storage/extendDisk/` 下的文件重新打包成新的游戏盘。

## 4. 如果你的 PAL95 原始镜像不兼容

优先按下面方向在线下调整原始镜像：

1. 确认 `C:` 可以直接进入游戏目录，或者把 `PAL.EXE` 和资源整理到根目录。
2. 提前把你想要的 `SETUP.DAT` 写进镜像。
3. 如果你希望 `RUNSAFE` / `RUNPAL` 做更多事情，可以把对应 BAT 逻辑直接写进原始镜像，或者告诉我们需要补哪些启动盘侧脚本。

最小建议形态：

1. DOS 挂载后可见 `C:`
2. `C:\PAL.EXE` 可直接运行
3. 所需 `.MKF`、`.RPG`、字体和数据文件齐全
4. `SETUP.DAT` 已经是你期望的那份

## 5. 当前调试方式

页面里建议这样用：

1. 选择系统盘镜像。
2. 选择 `storage/extendDisk/` 里的 PAL95 原始镜像。
3. 勾选要写进 `CONFIG.SYS` / `AUTOEXEC.BAT` 的参数。
4. 先点“预览脚本”确认生成内容。
5. 再点“启动”。

如果勾选了“自动执行游戏启动命令”，PAL95 会从 `A:` 上的 `RUNSAFE` 或 `RUNPAL` 进入，再由脚本自行切到 `C:`。
