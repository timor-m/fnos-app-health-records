# 受控身份映射与历史权限修复

本工具用于 Issues #38/#42 的待确认处理。它不按姓名合并、不删除健康数据、不批量授权管理员。需要 Node 24。维护材料包含身份与授权信息，限制文件权限并保存在可信设备，不上传公开 Issue。

## 跨实例待映射

1. 在目标部署登录或建立实际目标账号；源身份不允许直接登录。
2. 使用明确数据库路径只读列出待映射内部账号和成员数量：

```bash
node scripts/maintenance/identity-recovery.mjs pending --database /copy/db/health-records.sqlite
node scripts/maintenance/identity-recovery.mjs map-plan --database /copy/db/health-records.sqlite --source source-user-id --target verified-target-user-id --out /private/map-plan.json
```

核实实际持有人与每个成员 ID 的范围。源标识可在受控本地数据库 `identity_recovery_pending.source_json` 核查，包含源 provider/subject、原登录名及停用状态，不包含报告正文。随机内部 ID 或同名不能作为身份证明。目标已有相同成员授权时工具拒绝自动覆盖，先由现有档案管理者核实。

映射将源授权逐项复制给确认的目标，标记源身份已映射；原创建者及健康数据不变，源登录身份仍隔离。一个源身份只能映射一次，再向其他人共享使用正常共享流程。原本人和隐藏偏好保留在源记录，目标自行确认，不覆盖目标已有偏好。

## 历史恢复问题预览

以可信恢复前安全备份中提取的 SQLite 为只读基线，只选择需核实的账号和成员：

```bash
node scripts/maintenance/identity-recovery.mjs repair-plan --database /copy/db/health-records.sqlite --baseline /private/pre-restore.sqlite --user affected-user-id --members member-id-1,member-id-2 --out /private/repair-plan.json
```

预览区分新增授权与原有角色/授权变化。仅在存在旧恢复事件、授权时间与事件相符且没有记录到后续授权变更时生成候选；否则列为待确认。时间和差异也不构成最终授权证明，执行者必须逐项核实。需要比较停用状态时显式添加 `--include-account-status`，不会默认启用全部账号。缺少基线时返回待确认说明，不生成猜测授权。

## 确认执行与撤销

停止应用，保留原始完整备份。核对计划后，使用预览返回的完整确认摘要，显式指定当前有效系统管理员：

```bash
node scripts/maintenance/identity-recovery.mjs apply --database /copy/db/health-records.sqlite --plan /private/repair-plan.json --confirm PREVIEW_DIGEST --actor current-admin-id --receipt /private/applied.json --backup /private/before-apply.sqlite --service-stopped
```

执行前生成完整 SQLite 安全快照；同一事务逐条对比当前记录与预览前值，任何变化都拒绝执行，要求重新预览。仅修改计划列出的权限、待映射标记或明确选择的停用状态，保存前后像和审计。普通修复不能移除最后可用管理者，先完成合法的管理权转移；没有可靠接管者时保持待确认，不给管理员自动补权。新生成的安全快照和回执都不能覆盖已有文件。

撤销采用执行回执与返回的 `undoConfirmation`，仍需停止服务、再次备份和记录冲突检查：

```bash
node scripts/maintenance/identity-recovery.mjs undo --database /copy/db/health-records.sqlite --plan /private/applied.json --confirm UNDO_DIGEST --actor current-admin-id --receipt /private/undone.json --backup /private/before-undo.sqlite --service-stopped
```

后续合法修改不会被旧计划或旧回执覆盖。工具属于持有服务器文件权限的显式维护流程，不提供隐藏的 HTTP 管理员档案读取入口。不要在应用运行中或未经数据所有者核实的真实数据库上试运行写操作。

## 历史孤立档案的显式应急认领

历史创建者已停用或共享能力无法可靠回填时，不会自动授予管理员。若已核实真实持有人，但档案没有任何当前可用的共享管理者，可针对明确列出的成员生成应急授权计划：

```bash
node scripts/maintenance/identity-recovery.mjs claim-plan --database /copy/db/health-records.sqlite --members verified-member-id --target verified-target-user-id --actor current-admin-id --reason verification-reference --out /private/claim-plan.json
```

此操作不是猜测历史身份，而是维护者明确授予指定账号 manager 与共享管理能力。理由只写核验编号，不填健康正文。存在有效共享管理者时拒绝此流程；计划生成后仍使用上述 `apply` 的停止服务、备份、摘要确认和记录冲突检查，支持回执撤销。无法核实归属时不要执行，继续保留待确认和原始数据。
