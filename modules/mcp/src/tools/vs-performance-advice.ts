export interface VSPerformanceAdvice {
  code: string;
  graph: string;
  unitId: string;
  unitType: string;
  message: string;
  suggestion: string;
}

export const VS_PERFORMANCE_GUIDANCE = `### Advisory scope
Static hints, not validation errors or measured performance. Do not rewrite a graph automatically or claim 3x/9x/27x savings.

### Tick work
Explain why each Update, FixedUpdate, LateUpdate or OnTriggerStay/OnTriggerStay2D must repeat. Put a cheap gate before optional expensive work. FixedUpdate catch-up is bounded by [maximumDeltaTime](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/Time-maximumDeltaTime.html); do not skip required physics. For noncritical polling, 0.5s (2Hz) or 0.1s (10Hz) are profiling starting points, not universal targets. [WaitForSeconds](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/WaitForSeconds.html) uses scaled, approximate timing.

### Events and polling lifecycle
Prefer events and Enter/Exit triggers when they express the same behavior. If polling is necessary, start one coroutine from a meaningful event, wait between checks (about 0.5 seconds is a noncritical starting point), and let it end when the work ends. Prevent duplicate starts and define cancellation. Starting a yielding coroutine on every Update can overlap many flows; Update plus a cooldown still pays per-frame dispatch. Physics and responsive animation may legitimately need ticks.

### Values and caches
Uncached fetch outputs can reevaluate. Flow locals, Cache and SetVariable outputs are exceptions. [Cache](https://docs.unity3d.com/Packages/com.unity.visualscripting@1.9/manual/vs-control.html) stores a value when its control input runs, for the current flow, not across events. Stored variables need explicit updates and correct lifetime. Fanout/depth hints are unmeasured; profile actual consumers.

### Activation and wake-up
Never disable the GameObject that owns its only wake trigger. [SetActive(false)](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/GameObject.SetActive.html) disables components including colliders and stops attached coroutines. Keep a separate active wake listener; test event/coroutine behavior for the installed VS version. Disabling only ScriptMachine is not equivalent to disabling the GameObject.

Enabled ScriptMachines with a graph have event dispatch/lookup work even when that event has no graph handler in the reviewed VS 1.9.9/1.9.12 source; this does not mean every node executes. Profile idle machines before changing their lifecycle.

### Physics
Review [Rigidbody.MovePosition](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/Rigidbody.MovePosition.html) on rendered-frame paths; normally coordinate kinematic movement with FixedUpdate and interpolation. Do not infer 3D last-call semantics from Rigidbody2D. For an accumulated trajectory, advance an authoritative target at the intended cadence rather than repeatedly deriving increments from a pose that has not yet simulated. Inspect the actual motion algorithm before changing it. [ConstantForce](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/ConstantForce.html) is an option only for an appropriate continuous force on dynamic physics, not a generic movement replacement. Consider measuring expensive decisions/math at about 10Hz and applying cached results cheaply at the necessary tick rate; preserve collision response, stability and latency requirements.

### Reuse subgraphs
Reuse a subgraph for repeated logic instead of copying it. This improves maintenance, not a guaranteed speedup. Preserve inputs, outputs, variable scope, side effects and coroutine behavior; do not collapse or rewrite existing graphs automatically.`;

const PREFIX = "Unity.VisualScripting.";
const MAX_NODES = 20_000;
const MAX_CONNECTIONS = 80_000;
const CHAIN_THRESHOLD = 6;
const DEPTH_CAP = 24;
const TICKS = new Set(["Update", "FixedUpdate", "LateUpdate", "OnTriggerStay", "OnTriggerStay2D"]);
const BOUNDARIES = new Set(["Cache", "SetVariable", "GetVariable", "Literal", "This", "Self"]);
const ALIASES = new Set([...TICKS, ...BOUNDARIES, "InvokeMember"]);

type Node = { ref: string; id: string; type: string; raw: Record<string, unknown> };
type Connection = { conn: Record<string, unknown>; type: "control" | "value" };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 1024 && value.trim() ? value.trim() : undefined;
const typeName = (value: unknown): string => (text(value) || "").split(",", 1)[0].trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Read-only, bounded graph-shape hints. Runtime paths, cost and cache ordering are not proven here. */
export function getVSPerformanceAdvice(
  graphName: string,
  nodes: Array<Record<string, unknown>>,
  connections: Array<Connection>
): VSPerformanceAdvice[] {
  const graph = text(graphName) || "(unnamed graph)";
  const result: VSPerformanceAdvice[] = [];
  const add = (node: Node | undefined, code: string, message: string, suggestion: string) => {
    result.push({ code, graph, unitId: node?.id || "(graph)", unitType: node?.type || "(graph)", message, suggestion });
  };
  const sourceNodes = Array.isArray(nodes) ? nodes : [];
  const sourceConnections = Array.isArray(connections) ? connections : [];
  if (sourceNodes.length > MAX_NODES || sourceConnections.length > MAX_CONNECTIONS) {
    add(undefined, "VS_PERF_ANALYSIS_LIMIT", "Static advice is incomplete: the bounded node/connection scan limit was reached.",
      "Review the remaining graph separately; omitted advice does not prove absence of expensive work.");
  }
  const infos: Node[] = [];
  const byRef = new Map<string, Node>();
  for (let i = 0; i < Math.min(sourceNodes.length, MAX_NODES); i++) {
    const raw = sourceNodes[i];
    if (!record(raw)) continue;
    const rawType = typeName(raw.$type ?? raw.type);
    const type = ALIASES.has(rawType) ? PREFIX + rawType : rawType;
    const ref = text(raw.$id) || text(raw.id) || text(raw.guid) || `(node ${i})`;
    const node = { ref, id: text(raw.guid) || ref, type: type || "(unknown unit)", raw };
    infos.push(node);
    if (!byRef.has(ref)) byRef.set(ref, node);
    const short = type.startsWith(PREFIX) ? type.slice(PREFIX.length) : "";
    if (!TICKS.has(short)) continue;
    const coroutineAdvice = raw.coroutine === true
      ? " If this coroutine event yields, prevent overlapping starts and define when outstanding work stops."
      : "";
    if (short === "FixedUpdate") {
      add(node, "VS_PERF_FIXED_UPDATE", "Why must this work run every physics step? Catch-up can run multiple steps per rendered frame, bounded by maximumDeltaTime/fixedDeltaTime.",
        "Profile it and put a cheap gate before optional costly work. Preserve required physics updates; do not change global timestep settings automatically." + coroutineAdvice);
    } else if (short.startsWith("OnTriggerStay")) {
      add(node, "VS_PERF_TRIGGER_STAY", "Why must this work repeat while each collider overlaps? Callback count and cost are unmeasured.",
        "Consider Enter/Exit for state changes when equivalent. Keep the wake listener and its collider active; do not disable the GameObject that must detect waking." + coroutineAdvice);
    } else {
      add(node, "VS_PERF_FRAME_EVENT", `Why must ${short} work run every rendered frame? This is an advisory even when the path has a gate or cache.`,
        "Profile the active path. Consider change-driven work or a measured timer only if response latency and behavior permit; keep required frame-aligned work." + coroutineAdvice);
    }
  }

  const control = new Map<string, Set<string>>();
  const values = new Map<string, Set<string>>();
  const fanout = new Map<string, Map<string, Set<string>>>();
  const indegree = new Map<string, number>();
  const boundary = (node: Node) => node.type.startsWith(PREFIX) && BOUNDARIES.has(node.type.slice(PREFIX.length));
  const edge = (map: Map<string, Set<string>>, from: string, to: string): boolean => {
    let set = map.get(from);
    if (!set) map.set(from, set = new Set());
    if (set.has(to)) return false;
    set.add(to); return true;
  };
  for (let i = 0; i < Math.min(sourceConnections.length, MAX_CONNECTIONS); i++) {
    const item = sourceConnections[i];
    if (!record(item) || !record(item.conn)) continue;
    const c = item.conn;
    const from = text(record(c.sourceUnit) ? c.sourceUnit.$ref : c.from);
    const to = text(record(c.destinationUnit) ? c.destinationUnit.$ref : c.to);
    if (!from || !to) continue;
    const src = byRef.get(from), dst = byRef.get(to);
    if (!src || !dst) continue;
    if (item.type === "control") { edge(control, from, to); continue; }
    if (item.type !== "value") continue;
    const sourceKey = c.sourceKey ?? c.fromPort;
    const destinationKey = c.destinationKey ?? c.toPort;
    if (typeof sourceKey !== "string" || typeof destinationKey !== "string" || sourceKey.length > 1024 || destinationKey.length > 1024) continue;
    if (!boundary(src)) {
      let ports = fanout.get(from);
      if (!ports) fanout.set(from, ports = new Map());
      let consumers = ports.get(sourceKey);
      if (!consumers) ports.set(sourceKey, consumers = new Set());
      consumers.add(JSON.stringify([to, destinationKey]));
    }
    if (!boundary(src) && !boundary(dst) && edge(values, from, to)) indegree.set(to, (indegree.get(to) || 0) + 1);
  }
  for (const [ref, ports] of fanout) {
    let count = 0;
    for (const consumers of ports.values()) count = Math.max(count, consumers.size);
    if (count >= 2) add(byRef.get(ref), "VS_PERF_VALUE_FANOUT", `One value output has ${count} distinct consumer inputs. Repeated fetch work is possible but unmeasured; this does not prove any cost multiplier.`,
      "Profile which consumers actually execute. Where valid, cache once in the current flow or assign a variable with an explicit refresh/lifetime; preserve side effects and evaluation order.");
  }

  // One multi-source control traversal, not a separate DFS for every tick/unit.
  const frameReachable = new Set(infos.filter(n => n.type === PREFIX + "Update" || n.type === PREFIX + "LateUpdate").map(n => n.ref));
  const frameQueue = [...frameReachable];
  for (let i = 0; i < frameQueue.length; i++) {
    for (const target of control.get(frameQueue[i]) || []) {
      if (!frameReachable.has(target)) { frameReachable.add(target); frameQueue.push(target); }
    }
  }
  for (const node of infos) {
    if (node.type !== PREFIX + "InvokeMember" || !frameReachable.has(node.ref)) continue;
    const properties = record(node.raw.properties) ? node.raw.properties : undefined;
    const member = record(node.raw.member) ? node.raw.member : properties?.member;
    if (!record(member) || member.name !== "MovePosition") continue;
    const targets = [member.targetType, member.targetTypeName].filter(v => v !== undefined).map(typeName);
    if (!targets.length || !targets.every(t => t === "UnityEngine.Rigidbody")) continue;
    add(node, "VS_PERF_MOVEPOSITION_FRAME_PATH", "Rigidbody.MovePosition is statically reachable from Update/LateUpdate. Branches, waits and actual call frequency are unmeasured.",
      "Review kinematic motion with FixedUpdate and interpolation. Do not assume Rigidbody2D last-call semantics apply to 3D, or replace dynamic physics with position writes automatically.");
  }

  // Linear topological depth analysis. Caches/stored-value boundaries stop propagation.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const ref of byRef.keys()) if (!indegree.get(ref)) { queue.push(ref); depth.set(ref, 1); }
  for (let i = 0; i < queue.length; i++) {
    const ref = queue[i];
    for (const next of values.get(ref) || []) {
      depth.set(next, Math.min(DEPTH_CAP, Math.max(depth.get(next) || 1, (depth.get(ref) || 1) + 1)));
      const remaining = (indegree.get(next) || 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
    if ((depth.get(ref) || 0) >= CHAIN_THRESHOLD && !values.get(ref)?.size) {
      add(byRef.get(ref), "VS_PERF_VALUE_CHAIN", "A long value-dependency chain reaches this unit without a recognized cache/variable boundary. Cost and repeated evaluation are unmeasured.",
        "Profile the active fetch chain. Cache or store only when ordering, side effects and value lifetime remain correct; node depth alone is not a timing measurement.");
    }
  }
  if (queue.length < byRef.size) add(undefined, "VS_PERF_ANALYSIS_INCOMPLETE", "Cyclic value dependencies prevent complete static depth analysis.",
    "Review the cycle separately. This advisory neither rejects the graph nor estimates runtime cost.");

  return result.sort((a, b) => compare(a.unitId, b.unitId) || compare(a.code, b.code) || compare(a.unitType, b.unitType) || compare(a.message, b.message));
}
