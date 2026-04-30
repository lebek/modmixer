import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import type { DefEdgeKind, DefGraph, DefGraphEdge } from '../agent/def-graph';
import { cn } from '@/lib/cn';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 56;

type DefNodeData = {
  defName: string;
  defType: string;
  label: string;
  isExternal: boolean;
  abstract: boolean;
  dimmed: boolean;
};

type DefNodeType = Node<DefNodeData, 'def'>;

function DefNode({ data, selected }: NodeProps<DefNodeType>) {
  return (
    <div
      className={cn(
        'rounded-md border bg-paper px-3 py-2 text-left transition-opacity',
        'min-w-[160px] max-w-[200px]',
        data.isExternal
          ? 'border-dashed border-line bg-surface/40'
          : 'border-line',
        selected && 'ring-2 ring-accent',
        data.dimmed && 'opacity-30',
      )}
      style={{ width: NODE_WIDTH }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-none !bg-subtle"
      />
      <div className="flex items-baseline gap-1.5">
        {data.defType && (
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-subtle">
            {data.defType}
          </span>
        )}
        {data.isExternal && (
          <span className="rounded bg-raised px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-muted">
            external
          </span>
        )}
        {data.abstract && (
          <span className="rounded bg-raised px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-muted">
            abstract
          </span>
        )}
      </div>
      <div
        className={cn(
          'truncate text-sm font-medium',
          data.isExternal ? 'text-muted' : 'text-ink',
        )}
        title={data.defName}
      >
        {data.label}
      </div>
      {data.label !== data.defName && (
        <div className="truncate font-mono text-[10px] text-subtle" title={data.defName}>
          {data.defName}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-none !bg-subtle"
      />
    </div>
  );
}

const nodeTypes = { def: DefNode };

interface LayoutResult {
  nodes: DefNodeType[];
  edges: Edge[];
}

const KIND_LABELS: Record<DefEdgeKind, string> = {
  gameplay: 'gameplay',
  inherits: 'inherits',
  stat: 'stats',
  other: 'other',
};

const DEFAULT_KINDS: ReadonlySet<DefEdgeKind> = new Set<DefEdgeKind>(['gameplay']);

function layoutGraph(
  visibleNodes: DefGraph['nodes'],
  visibleEdges: DefGraphEdge[],
  selected: string | null,
  highlightedNeighbors: Set<string>,
): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'LR',
    nodesep: 56,
    ranksep: 140,
    edgesep: 24,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of visibleNodes) {
    g.setNode(n.defName, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of visibleEdges) {
    g.setEdge(e.fromDefName, e.toDefName);
  }
  dagre.layout(g);

  const dim = (id: string) =>
    selected !== null && id !== selected && !highlightedNeighbors.has(id);

  const nodes: DefNodeType[] = visibleNodes.map((n) => {
    const pos = g.node(n.defName);
    return {
      id: n.defName,
      type: 'def' as const,
      position: { x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 },
      data: {
        defName: n.defName,
        defType: n.defType,
        label: n.label,
        isExternal: n.isExternal,
        abstract: n.abstract,
        dimmed: dim(n.defName),
      },
    };
  });

  const edges: Edge[] = visibleEdges.map((e, i) => {
    const dimmed =
      selected !== null && e.fromDefName !== selected && e.toDefName !== selected;
    return {
      id: `e${i}`,
      source: e.fromDefName,
      target: e.toDefName,
      label: e.label,
      labelStyle: {
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fill: 'var(--color-muted)',
      },
      labelBgStyle: { fill: 'var(--color-paper)' },
      labelBgPadding: [4, 2],
      style: {
        stroke: dimmed ? 'var(--color-line)' : 'var(--color-muted)',
        strokeWidth: 1,
        opacity: dimmed ? 0.3 : 1,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: dimmed ? 'var(--color-line)' : 'var(--color-muted)',
        width: 14,
        height: 14,
      },
    };
  });

  return { nodes, edges };
}

interface DefGraphViewProps {
  folder: string;
}

export function DefGraphView({ folder }: DefGraphViewProps) {
  const [graph, setGraph] = useState<DefGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [hideExternal, setHideExternal] = useState(false);
  const [enabledKinds, setEnabledKinds] = useState<Set<DefEdgeKind>>(
    () => new Set(DEFAULT_KINDS),
  );
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      setLoading(true);
      try {
        const g = await window.modmixer.getDefGraph(folder);
        if (!cancelled) setGraph(g);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    const off = window.modmixer.onModChanged(({ folder: f }) => {
      if (f === folder) void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [folder]);

  // Counts per kind so the toggle row can show how much each one would add.
  const kindCounts = useMemo(() => {
    const c: Record<DefEdgeKind, number> = {
      gameplay: 0,
      inherits: 0,
      stat: 0,
      other: 0,
    };
    if (!graph) return c;
    for (const e of graph.edges) c[e.kind]++;
    return c;
  }, [graph]);

  // Edges first: kind toggle + external toggle. Nodes are derived from the
  // edges that survive (so flipping off "stats" also drops the StatDef nodes
  // that only appeared via stat edges).
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!graph) {
      return {
        visibleNodes: [] as DefGraph['nodes'],
        visibleEdges: [] as DefGraphEdge[],
      };
    }
    const nodeMap = new Map(graph.nodes.map((n) => [n.defName, n]));
    const filteredEdges = graph.edges.filter((e) => {
      if (!enabledKinds.has(e.kind)) return false;
      if (hideExternal) {
        const to = nodeMap.get(e.toDefName);
        if (to?.isExternal) return false;
      }
      return true;
    });

    const nodeNames = new Set<string>();
    for (const n of graph.nodes) {
      if (n.isExternal) continue;
      nodeNames.add(n.defName);
    }
    for (const e of filteredEdges) {
      nodeNames.add(e.fromDefName);
      nodeNames.add(e.toDefName);
    }

    const nodes = graph.nodes.filter((n) => {
      if (!nodeNames.has(n.defName)) return false;
      if (hideExternal && n.isExternal) return false;
      return true;
    });
    const visibleNodeSet = new Set(nodes.map((n) => n.defName));
    const edges = filteredEdges.filter(
      (e) =>
        visibleNodeSet.has(e.fromDefName) && visibleNodeSet.has(e.toDefName),
    );
    return { visibleNodes: nodes, visibleEdges: edges };
  }, [graph, enabledKinds, hideExternal]);

  const highlightedNeighbors = useMemo(() => {
    const out = new Set<string>();
    if (!selected) return out;
    for (const e of visibleEdges) {
      if (e.fromDefName === selected) out.add(e.toDefName);
      if (e.toDefName === selected) out.add(e.fromDefName);
    }
    return out;
  }, [selected, visibleEdges]);

  const { nodes, edges } = useMemo(
    () => layoutGraph(visibleNodes, visibleEdges, selected, highlightedNeighbors),
    [visibleNodes, visibleEdges, selected, highlightedNeighbors],
  );

  const toggleKind = useCallback((k: DefEdgeKind) => {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const onNodeClick = useCallback((_e: unknown, node: Node) => {
    setSelected((prev) => (prev === node.id ? null : node.id));
  }, []);

  const onPaneClick = useCallback(() => setSelected(null), []);

  if (loading && !graph) {
    return (
      <div className="rounded-md border border-dashed border-line bg-surface/30 px-4 py-6 text-center text-xs text-muted">
        scanning…
      </div>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-line bg-surface/30 px-4 py-3 text-xs text-muted">
        No def relationships yet. As the mod gains defs that reference each
        other (recipes, ingredients, prerequisites…), they'll show up here.
      </p>
    );
  }

  const kinds: DefEdgeKind[] = ['gameplay', 'inherits', 'stat', 'other'];

  return (
    <div className="rounded-md border border-line bg-paper">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {kinds.map((k) => {
          const on = enabledKinds.has(k);
          const count = kindCounts[k];
          const disabled = count === 0;
          return (
            <button
              key={k}
              type="button"
              disabled={disabled}
              onClick={() => toggleKind(k)}
              className={cn(
                'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]',
                on
                  ? 'border-line bg-raised text-ink'
                  : 'border-line text-subtle',
                disabled && 'opacity-40',
              )}
            >
              {KIND_LABELS[k]}
              <span className="ml-1 text-subtle">{count}</span>
            </button>
          );
        })}
        <span className="mx-1 h-3 w-px bg-line" />
        <button
          type="button"
          onClick={() => setHideExternal((v) => !v)}
          className={cn(
            'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]',
            hideExternal
              ? 'border-line text-subtle'
              : 'border-line bg-raised text-ink',
          )}
        >
          external
        </button>
        <span className="ml-auto font-mono text-[10px] text-subtle">
          {nodes.length} nodes · {edges.length} edges
        </span>
      </div>
      <div style={{ height: 480 }} className="bg-surface/20">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
        >
          <Background color="var(--color-line)" gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
