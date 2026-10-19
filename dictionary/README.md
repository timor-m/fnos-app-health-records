# 健康档案指标字典

该目录是健康档案指标标准化的唯一文件来源。业务人员只维护
`taxonomy.json` 和 `indicators.json`，`manifest.json` 由脚本生成。

## 分层

- `core/`：随应用发布的固定核心字典，覆盖一般检查和高频检验项目。
- `remote/`：通过 GitHub Pages 发布的远程完整快照，只新增远程定义或扩展核心指标别名。
- `schemas/`：字典和发布清单的 JSON Schema。

远程更新只替换远程层，不修改核心层，也不删除设备上的原始报告指标。

## 应用运行时

- 应用启动后将随包核心字典写入 SQLite，并以核心 revision 和内容哈希识别是否需要更新。
- 远程字典只由管理员在维护工具中手动检查和安装；应用升级和启动不会自动访问网络。
- 下载文件必须通过 HTTPS、大小、SHA-256、JSON Schema 和可选 Ed25519 签名校验。
- 每次成功安装保存不可变完整快照，并在一个 SQLite 事务中物化指标、别名和分类后切换生效状态。
- 下载、校验或物化失败会记录失败原因，且不会改变当前生效快照。
- 历史快照不会被更新删除，管理员可以回滚；回滚同样经过结构校验和原子物化。
- 核心或远程 revision 变化后，后台只使用本地字典重新匹配历史指标，不重新 OCR、不调用 AI。
- 未命中字典的原始名称按观察项写入持久化问题池；同一观察项重复扫描不累计，后续命中字典或报告进入回收站时自动移出。

## 维护约束

- `canonicalKey`、分组 Key、子分组 Key 和分类 Key 发布后保持稳定。
- 每次远程发布同时提交完整的 `taxonomy.json` 和 `indicators.json`。
- `revision` 必须单调递增；同一 revision 不允许出现不同内容。
- 字典内容更新只使用 `revision` 判断版本，SHA-256 校验实际文件内容。
- 远程指标不能重新定义核心 `canonicalKey`；需要补充核心别名时写入顶层 `extensions`。
- 已发布 Key 确需合并时写入顶层 `redirects`，普通指标不维护状态和空合并字段。
- AI 不得写入该目录，也不得自动创建正式字典条目。
- 应用问题池预填指标收录申请名单，打开正常反馈弹窗并默认选择“其他反馈”，用户检查后提交并附带白名单系统环境信息；预填内容不带报告或检查结果。维护者不得要求用户附带报告、结果值或身份信息。提交后可在“反馈与进度”跟踪，服务不可用时可复制名单备用。

每个指标必须声明 `kind`：

- `quantitative`：定量指标，值类型必须为 `numeric`。
- `categorical`：定性指标，可使用阴阳性、等级或文本状态。

指标通过 `order` 声明在所属分类内的固定展示顺序。常见英文缩写和项目简称统一维护在 `aliases`，不再单独维护项目编码字段。

形态学发现、报告所见、结论和建议等内容不属于指标，不写入指标字典。

### 血脂及空腹血糖名称兼容

- `甘油三脂` 作为报告非规范写法，通过远程 `extensions` 匹配核心指标 `甘油三酯`；`空腹葡萄糖` 同样扩展到 `空腹血糖`，保留空腹条件及现有单位兼容规则。
- `小而密低密度脂蛋白胆固醇`（`sdLDL-C`）使用独立的 `lipid_sdldl_c`，不与普通 LDL-C、颗粒数、百分比或比值合并。沿用现有保留原单位的机制，`mmol/L` 与 `mg/dL` 分开观察；不设统一参考范围。
- `载脂蛋白A` 不作为 `载脂蛋白 A1` 的全局别名；项目代码或检验资料明确为 ApoA1 后再确认关联。

名称与边界依据：[国家卫健委血脂知识要点](https://www.nhc.gov.cn/jkj/s10033/200706/ee3b3ad6fd0e4b44980a76d206ce182f.shtml)、[济南市精神卫生中心检验项目目录](https://qsy.jinan.gov.cn/colqsy11762/art/2023/art_qsy11762_qsy54228.html)、[艾迪康 sdLDL-C 项目说明](https://www.adicon.com.cn/project/9126.html)、[台大医院检验医学部说明](https://epaper.ntuh.gov.tw/health/202012/health_5.html)。单位依据：[sdLDL-C 试剂说明书](https://www.upingbio.com/uploads/20241206110917/YPD1109.pdf)。这些资料用于确认项目名称、含义和单位，不作为所有机构通用的参考范围。

字段按功能保守保留：

- `canonicalKey`、`displayName`：稳定标识与用户可见名称。
- `categoryKey`、`order`：体检目录归类与分类内固定顺序。
- `kind`、`valueType`：区分定量/定性业务类型及具体值表达方式。
- `specimen`：区分血液、尿液、血清等同名或相近项目。
- `defaultUnit`、`allowedUnits`、`unitDimension`：标准单位、输入单位兼容和量纲校验。
- `aliases`、`sectionHints`：名称归一化及报告章节上下文消歧。
- `explanation`：趋势页面向普通用户的指标说明。

不为压缩体积缩短上述字段名；生产发布由 `dictionary:build` 统一生成紧凑 JSON。

## 命令

```bash
npm run dictionary:validate
npm run dictionary:compare -- --from=dictionary/remote-previous --to=dictionary/remote
npm run dictionary:manifest
npm run dictionary:build
npm run dictionary:release
```

推荐发布链路：

1. 从“其他反馈”中标题为“指标字典收录申请”的工单汇总未命中名称，逐项确认医学含义、已有别名及单位边界后修改远程 `taxonomy.json` 或 `indicators.json`；历史 GitHub Issue 仍可作为来源。同一申请可部分收录，回复说明各项结论和发布的字典 revision，不将应用版本当作字典版本。
2. 运行 `npm run dictionary:release`。命令会拒绝无内容变更的空发布，自动递增两个 JSON 的 revision，完成校验并生成本地 manifest。
3. 提交远程字典源码并创建 PR；`Dictionary Validate` 工作流只针对字典相关变更执行轻量 Schema 和跨文件一致性校验，通用 CI 继续执行完整发布校验。
4. 合并并推送 `main`；`Dictionary Pages` 工作流会重新校验，将三个运行时 JSON 同步到 Gitee 国内镜像，然后发布相同快照到 GitHub Pages。
5. 应用管理员检查更新，确认新增、变更、移除指标和别名数量后安装；安装成功会立即在本地回填历史指标，问题池中已命中的名称自动消失。
6. 如出现误归一化，管理员从应用内回滚到上一个远程快照。

需要指定 revision 时可运行 `npm run dictionary:release -- --revision=<整数>`，指定值必须大于当前 manifest revision。

`dictionary:manifest` 默认生成 `dictionary/remote/manifest.json`。设置
`DICTIONARY_SIGNING_PRIVATE_KEY` 和 `DICTIONARY_SIGNING_KEY_ID` 后会使用
Ed25519 对清单载荷签名。

`dictionary:build` 将可读的远程字典源码构建到 `.dictionary-pages/`。
发布目录中的字典、Schema 和 manifest 均为紧凑 JSON，manifest 的 SHA-256
和字节数以紧凑产物为准。

## Gitee 国内镜像

国内镜像仓库固定为：

```text
https://gitee.com/timor-m/health-records-dictionary
```

Workflow 只同步以下三个运行时文件，不同步应用源码：

```text
manifest.json
taxonomy.json
indicators.json
```

为 GitHub 仓库配置 Actions Secret `GITEE_DICTIONARY_SSH_KEY`。其内容必须是
专门为自动同步创建的 Ed25519 私钥；对应公钥添加到具备上述 Gitee 仓库写权限的
账号。建议使用独立机器人账号，不要上传开发者日常使用的个人 SSH 私钥。

国内镜像基础地址为：

```text
https://gitee.com/timor-m/health-records-dictionary/raw/main/
```

应用未配置自定义地址时按以下顺序下载：

1. Gitee Raw 国内镜像。
2. Gitee Contents API 备用镜像（Raw 被网络策略拦截时使用）。
3. GitHub Pages 备用源。

GitHub Pages 备用基础地址为：

```text
https://timor-m.github.io/fnos-app-health-records/
```

当前来源发生网络错误、超时、HTTP 错误或完整性校验失败时，才会尝试下一来源。
默认的 Gitee Raw、Gitee Contents API 和 GitHub Pages 均不可用时，应用会明确显示公网失败原因，并退回到
随当前应用版本发布的远程字典离线快照。离线快照可以安装，但只能代表当前应用已
内置的 revision，不能用于判断公网是否已经发布更高版本。配置自定义来源时不会
启用此回退，避免把私有字典静默替换为公共内置快照。
`INDICATOR_DICTIONARY_URL` 可覆盖为单一私有来源；
`INDICATOR_DICTIONARY_URLS` 可使用换行、逗号或分号配置自定义多源顺序。

同步步骤在密钥缺失或推送失败时会让发布工作流失败，避免 GitHub Pages 与国内镜像
静默产生不同 revision。

`Dictionary Pages` Workflow 在首次运行时会请求自动启用 GitHub Pages，并将构建来源
设置为 GitHub Actions。如果组织策略或仓库权限禁止自动启用，需要由仓库管理员进入
`Settings → Pages → Build and deployment`，将 `Source` 手动设置为 `GitHub Actions`，
然后重新运行 Workflow。
