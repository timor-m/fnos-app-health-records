import { createError } from "h3";
import { getDatabase } from "../database/client";
import { assertMemberManage } from "./member.service";
import type { RequestUser } from "../domain/request-user";

export function assertNoPageAppend(reportId: string) {
  const db = getDatabase();
  const batch = db
    .prepare(
      `SELECT b.id,b.actor_id,b.provider,b.published,b.job_id,r.member_id
    FROM report_page_appends b JOIN reports r ON r.id=b.report_id
    WHERE b.report_id=? AND b.state NOT IN ('complete','ocr_only','noop','cancelled')`,
    )
    .get(reportId) as
    | {
        id: string;
        actor_id: string;
        provider: RequestUser["provider"];
        published: number;
        job_id: string | null;
        member_id: string;
      }
    | undefined;
  if (!batch) return;
  // Revocation must not leave an unfinishable draft locking the other managers out.
  try {
    assertMemberManage(
      {
        id: batch.actor_id,
        provider: batch.provider,
        authenticated: true,
        displayName: "",
        isGatewayAdmin: false,
      },
      batch.member_id,
    );
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 403) throw error;
    db.prepare(
      "UPDATE processing_jobs SET status='cancelled',finished_at=CURRENT_TIMESTAMP,lease_expires_at=NULL WHERE id=? AND status IN ('queued','processing')",
    ).run(batch.job_id);
    db.prepare(
      "UPDATE report_page_appends SET state=?,error_message='原操作账号授权已撤销，处理已停止' WHERE id=?",
    ).run(batch.published ? "ocr_only" : "cancelled", batch.id);
    return;
  }
  throw createError({
    statusCode: 409,
    data: { code: "UPLOAD_CONFLICT" },
    statusMessage: "补充报告页尚未结束，请先完成或放弃该批次",
  });
}
