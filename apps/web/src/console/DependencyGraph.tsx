import {useMemo} from 'react';
import ReactFlow, {Background, Controls, MarkerType, MiniMap, type Edge, type Node} from 'reactflow';
import 'reactflow/dist/style.css';
import type {Workflow} from '../api';

const BORDER: Record<string, string> = {deletable: '#ff6b5e', anonymize: '#f5c451', retain: '#6fa8ff'};
const nodeStyle = (border: string, background = '#121836') => ({background, color: '#e8eaf6', border: `1.5px solid ${border}`, borderRadius: 10, fontSize: 12, lineHeight: 1.35, padding: '8px 10px', width: 156});
const COLUMN = 196, ROW = 74;

/** Layered layout: the customer on the left, each table one column right of what it references. */
export default function DependencyGraph({workflow}: {workflow: Workflow}) {
  const {nodes, edges} = useMemo(() => {
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
    const nodes: Node[] = [{id: 'root', position: {x: 0, y: Math.max(0, ((columns.get(1)?.length ?? 1) - 1) * ROW / 2)}, data: {label: workflow.customerId}, style: {...nodeStyle('#9b7bff', '#1f1650'), width: 104, fontWeight: 700}, sourcePosition: 'right' as never, targetPosition: 'left' as never}];
    for (const [column, members] of columns) members.forEach((id, row) => {
      const asset = assets.find(item => item.id === id)!;
      nodes.push({id, position: {x: 150 + (column - 1) * COLUMN, y: row * ROW}, data: {label: `${asset.label} · ${asset.count}\n${asset.system} / ${asset.table}`}, style: {...nodeStyle(BORDER[asset.classification]), whiteSpace: 'pre-line'}, sourcePosition: 'right' as never, targetPosition: 'left' as never});
    });
    const edges: Edge[] = [];
    for (const id of columns.get(1) ?? []) edges.push({id: `root-${id}`, source: 'root', target: id, style: {stroke: '#36407a'}});
    for (const asset of assets) for (const parent of asset.dependencyIds.filter(item => ids.has(item))) edges.push({id: `${parent}->${asset.id}`, source: parent, target: asset.id, style: {stroke: '#4a5590'}, markerEnd: {type: MarkerType.ArrowClosed, color: '#4a5590'}});
    let external = 0;
    for (const dependency of workflow.dependencies ?? []) {
      if (dependency.constraintType === 'foreign_key') continue;
      const nodeId = dependency.constraintType === 'business' ? dependency.source : dependency.target;
      if (!nodes.some(node => node.id === nodeId)) {
        const business = dependency.constraintType === 'business';
        nodes.push({id: nodeId, position: {x: 150 + deepest * COLUMN + 30, y: external++ * ROW}, data: {label: business ? `${nodeId.split(':').at(-1)}\n${nodeId.split(':')[1]}` : `Retention hold\n${nodeId.replace('policy:', '')}`}, style: {...nodeStyle(business ? '#ff6b5e' : '#6fa8ff', business ? 'rgba(255,107,94,0.12)' : 'rgba(111,168,255,0.08)'), whiteSpace: 'pre-line', borderStyle: business ? 'solid' : 'dashed'}, targetPosition: 'left' as never, sourcePosition: 'left' as never});
      }
      // Drawn from this customer's row toward the other customer that depends on it.
      if (dependency.constraintType === 'business') edges.push({id: `${dependency.target}->${dependency.source}`, source: dependency.target, target: dependency.source, animated: true, label: 'referenced by', style: {stroke: '#ff6b5e', strokeWidth: 2}, labelStyle: {fill: '#ff6b5e', fontSize: 10}, labelBgStyle: {fill: '#0c1024'}, markerEnd: {type: MarkerType.ArrowClosed, color: '#ff6b5e'}});
      else edges.push({id: `${dependency.source}->${dependency.target}`, source: dependency.source, target: dependency.target, style: {stroke: '#6fa8ff', strokeDasharray: '4 4'}});
    }
    return {nodes, edges};
  }, [workflow]);

  return <div className="graph"><ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{padding: 0.08, maxZoom: 1.1}} nodesConnectable={false} proOptions={{hideAttribution: true}} minZoom={0.3}>
    <Background color="#242c56" gap={22} />
    <Controls showInteractive={false} />
    <MiniMap pannable zoomable nodeColor={node => String((node.style as {borderColor?: string; border?: string})?.border ?? '#36407a').split(' ').at(-1) ?? '#36407a'} maskColor="rgba(7,10,24,0.7)" />
  </ReactFlow></div>;
}
