export type TrendGroupNode = {
  key: string;
  name: string;
  indicatorCount: number;
  configuredIndicatorCount: number;
  indicatorKeys: string[];
  searchText: string;
  children: TrendGroupNode[];
};

export function flattenTrendGroups(nodes: TrendGroupNode[]): TrendGroupNode[] {
  return nodes.flatMap(node => [node, ...flattenTrendGroups(node.children)]);
}

export function resolveTrendGroupKeys(nodes: TrendGroupNode[], selected: string[]) {
  const selection = new Set(selected);
  return new Set(flattenTrendGroups(nodes).filter(node => selection.has(node.key)).flatMap(node => node.indicatorKeys));
}
