export const reportNoteLimits = { images: 9, textLength: 10000 } as const;
export type ReportNoteAsset = {
  id: string; originalName: string; mimeType: string; fileSize: number;
  width: number | null; height: number | null; sortOrder: number;
};
export type ReportNote = {
  id: string; contentText: string; createdBy: string | null;
  createdAt: string; updatedAt: string; assets: ReportNoteAsset[];
};
export type ReportNotesResult = { notes: ReportNote[]; canManage: boolean };
export type ReportNoteInput = {
  id?: string;
  contentText: string;
  assets: Array<{ id?: string; uploadToken?: string }>;
  updatedAt?: string;
};
