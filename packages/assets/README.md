`packages/assets/` 目录存放 fnOS 打包模板资源。

这些文件不会直接参与源码开发，而是在 `npm run prepare:package` 时被渲染到 `.fnos-build/package/`。

- 包根图标 `ICON.PNG` 为 64 x 64，`ICON_256.PNG` 提供应用中心大图
- 包图标 `ICON_256.PNG` 必须为 256 x 256
- 桌面入口固定使用 `generated/icon_256.png`，避免小尺寸图标被放大
- 图标矢量源文件为 `icons/logo-source.svg`
- 修改图标后运行 `npm run generate:icons` 重新生成 PNG
- `npm run validate:package` 会检查关键图标尺寸
