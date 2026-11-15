export type ReportCombinationPreview = {
    source: {
        id: string;
        title: string;
        reportIssuedAt: string | null;
        hospitalName: string | null;
    };
    target: {
        id: string;
        title: string;
        reportIssuedAt: string | null;
        hospitalName: string | null;
    };
    fingerprint: string;
    sourceCounts: {
        pages: number;
        observations: number;
        otherRecords: number;
    };
    targetCounts: {
        pages: number;
        observations: number;
        otherRecords: number;
    };
    sameReportDate: boolean;
    repeatedPageCount: number;
};
export type ReportCombinationResult = {
    combinationId?: string;
    reportId: string;
    sourceReportId: string;
    status: 'needs_review';
    movedPages: number;
    movedObservations: number;
    movedOtherRecords: number;
};
export type ReportCombinationUndoPreview = {
    combinationId: string;
    fingerprint: string;
    source: {
        id: string;
        title: string;
        pages: number;
        observations: number;
    };
    target: {
        id: string;
        title: string;
        pages: number;
        observations: number;
    };
};
export type ReportCombinationUndoResult = {
    reportId: string;
    restoredReportId: string;
    undone: true;
};
