export type UploadOrganizationMode = '' | 'independent' | 'merge' | 'custom';
export function buildUploadPlan(ids: string[], mode: UploadOrganizationMode, custom: string[][]): string[][] {
  if (!ids.length) return [];
  if (ids.length === 1) return [[ids[0]]];
  if (mode === 'independent') return ids.map(id => [id]);
  if (mode === 'merge') return [[...ids]];
  if (mode !== 'custom') return [];
  const flattened = custom.flat();
  if (custom.some(group => !group.length) || flattened.length !== ids.length || new Set(flattened).size !== ids.length || flattened.some(id => !ids.includes(id))) return [];
  return custom.map(group => [...group]);
}
