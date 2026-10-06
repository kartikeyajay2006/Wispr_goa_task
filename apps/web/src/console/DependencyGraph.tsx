import {useMemo} from 'react';
import ReactFlow, {Background, Controls, MarkerType, MiniMap, type Edge, type Node} from 'reactflow';
import 'reactflow/dist/style.css';
import type {Workflow} from '../api';
import {themeColor, useTheme} from '../theme';

/** Concrete colours for the current theme: React Flow writes some of them as SVG attributes, where var() does not work. */
const palette = () => {
  const c = (name: string) => themeColor(name);
  return {delete: c('delete'), redact: c('redact'), retain: c('retain'), accent: c('accent'), text: c('text'), surface: c('surface-2'), surface0: c('surface-0'), line: c('line'), lineStrong: c('line-strong'), muted: c('muted')};
};
type Palette = ReturnType<typeof palette>;
const nodeStyle = (colors: Palette, border: string, background = colors.surface) => ({background, color: colors.text, border: `1.5px solid ${border}`, borderRadius: 10, fontSize: 12, lineHeight: 1.35, padding: '8px 10px', width: 156});
const COLUMN = 196, ROW = 74;

/** Layered layout: the customer on the left, each table one column right of what it references. */
export default function DependencyGraph({workflow}: {workflow: Workflow}) {
  const theme = useTheme(state => state.theme);
  const colors = useMemo(() => palette(), [theme]);
  const {nodes, edges} = useMemo(() => {
    const BORDER: Record<string, string> = {deletable: colors.delete, anonymize: colors.redact, retain: colors.retain};
    const assets = workflow.assets;
    const ids = new Set(assets.map(asset => asset.id));
    const depth = new Map<string, number>();
    const depthOf = (id: string, trail: string[] = []): number => {
      if (depth.has(id)) return depth.get(id)!;
      const asset = assets.find(item => item.id === id);
      const parents = (asset?.dependencyIds ?? []).filter(parent => ids.has(parent) && !trail.includes(parent));
      const value = parents.length ? 1 + Math.max(...parents.map(parent => depthOf(parent, [...trail, id]))) : 1;
      depth.set(id, value);
      return value;
    };
    assets.forEach(asset => depthOf(asset.id));
    const columns = new Map<number, string[]>();
    for (const asset of assets) columns.set(depth.get(asset.id)!, [...(columns.get(depth.get(asset.id)!) ?? []), asset.id]);
    const deepest = Math.max(1, ...depth.values());
    const nodes: Node[] = [{id: 'root', position: {x: 0, y: Math.max(0, ((columns.get(1)?.length ?? 1) - 1) * ROW / 2)}, data: {label: workflow.customerId}, style: {...nodeStyle(colors, colors.accent, `color-mix(in srgb, ${colors.accent} 22%, ${colors.surface})`), width: 104, fontWeight: 700}, sourcePosition: 'right' as never, targetPosition: 'left' as never}];
    for (const [column, members] of columns) members.forEach((id, row) => {
      const asset = assets.find(item => item.id === id)!;
      nodes.push({id, position: {x: 150 + (column - 1) * COLUMN, y: row * ROW}, data: {label: `${asset.label} · ${asset.count}\n${asset.system} / ${asset.table}`}, style: {...nodeStyle(colors, BORDER[asset.classification]), whiteSpace: 'pre-line'}, sourcePosition: 'right' as never, targetPosition: 'left' as never});
    });
    const edges: Edge[] = [];
    for (const id of columns.get(1) ?? []) edges.push({id: `root-${id}`, source: 'root', target: id, style: {stroke: colors.lineStrong}});
    for (const asset of assets) for (const parent of asset.dependencyIds.filter(item => ids.has(item))) edges.push({id: `${parent}->${asset.id}`, source: parent, target: asset.id, style: {stroke: colors.muted}, markerEnd: {type: MarkerType.ArrowClosed, color: colors.muted}});
    let external = 0;
    for (const dependency of workflow.dependencies ?? []) {
      if (dependency.constraintType === 'foreign_key') continue;
      const nodeId = dependency.constraintType === 'business' ? dependency.source : dependency.target;
      if (!nodes.some(node => node.id === nodeId)) {
        const business = dependency.constraintType === 'business';
        nodes.push({id: nodeId, position: {x: 150 + deepest * COLUMN + 30, y: external++ * ROW}, data: {label: business ? `${nodeId.split(':').at(-1)}\n${nodeId.split(':')[1]}` : `Retention hold\n${nodeId.replace('policy:', '')}`}, style: {...nodeStyle(colors, business ? colors.delete : colors.retain, `color-mix(in srgb, ${business ? colors.delete : colors.retain} 12%, ${colors.surface})`), whiteSpace: 'pre-line', borderStyle: business ? 'solid' : 'dashed'}, targetPosition: 'left' as never, sourcePosition: 'left' as never});
      }
      // Drawn from this customer's row toward the other customer that depends on it.
      if (dependency.constraintType === 'business') edges.push({id: `${dependency.target}->${dependency.source}`, source: dependency.target, target: dependency.source, animated: true, label: 'referenced by', style: {stroke: colors.delete, strokeWidth: 2}, labelStyle: {fill: colors.delete, fontSize: 10}, labelBgStyle: {fill: colors.surface0}, markerEnd: {type: MarkerType.ArrowClosed, color: colors.delete}});
      else edges.push({id: `${dependency.source}->${dependency.target}`, source: dependency.source, target: dependency.target, style: {stroke: colors.retain, strokeDasharray: '4 4'}});
    }
    return {nodes, edges};
  }, [workflow, colors]);

  return <div className="graph"><ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{padding: 0.08, maxZoom: 1.1}} nodesConnectable={false} proOptions={{hideAttribution: true}} minZoom={0.3}>
    <Background color={colors.line} gap={22} />
    <Controls showInteractive={false} />
    <MiniMap pannable zoomable nodeColor={node => String((node.style as {border?: string})?.border ?? colors.lineStrong).split(' ').at(-1) ?? colors.lineStrong} maskColor={`color-mix(in srgb, ${colors.surface0} 70%, transparent)`} />
  </ReactFlow></div>;
}
