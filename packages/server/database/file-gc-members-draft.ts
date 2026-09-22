// Unnumbered draft; released migrations remain immutable.
export const fileGcMembersSchemaSql = `
CREATE TABLE IF NOT EXISTS file_gc_members (
 gc_id TEXT NOT NULL REFERENCES file_gc_queue(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES health_members(id) ON DELETE CASCADE,
 PRIMARY KEY(gc_id, member_id)
);
CREATE INDEX IF NOT EXISTS file_gc_members_member_idx ON file_gc_members(member_id, gc_id);
`;
