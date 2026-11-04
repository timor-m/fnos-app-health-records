# 旧浏览器兼容检查

## iOS 15.1 的修复范围

- 记录类型和状态筛选使用 `Object.prototype.hasOwnProperty.call`，不依赖 Safari 15.4 才支持的 `Object.hasOwn`，保留对继承属性的排除。
- 趋势、体温图、来源排序及各弹窗的末项读取使用数组索引；临时表达式使用 `slice(-1)[0]`，不依赖 `Array.prototype.at`。空数组仍返回 `undefined`。
- 页面与弹窗高度先声明 `vh`，再声明 `dvh`；旧内核忽略后者，现代内核继续使用动态视口。自定义属性的默认高度使用有效的 `vh`，避免变量在计算阶段失效。
- UUID 沿用现有安全随机数回退，不增加全局 polyfill；Vite 的旧语法编译目标不等于运行时 API 已被补齐。
- `:has()` 的额外布局和 `color-mix()` 的配色属于渐进增强，本次不把它们改造成全局兼容框架。旧浏览器下仍须核对接种编辑、加载反馈及外观。

## 验证

运行 `npm run test:ui`、`npm run typecheck`、`npm run build` 及 `git diff --check`。`browser-compatibility.test.ts` 覆盖 API 缺失时的类型/筛选校验，扫描前端不支持的直接调用，并检查动态视口声明的回退顺序。

实机验收：iOS 15.1.1 中点击概览资料处理及最近上传卡片，确认详情出现、关闭后返回列表；检查资料筛选、趋势、体温曲线、日期选择和其他弹窗。横竖屏切换后确认内容可滚动、操作按钮可见。模拟缺失 API 和桌面测试不能替代指定系统真机验收。
