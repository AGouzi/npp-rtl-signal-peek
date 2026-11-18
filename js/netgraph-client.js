(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RTLNetgraph = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TRACE_KIND_ORDER = {
    port: 0,
    instance: 1,
    "assign-lhs": 2,
    "assign-rhs": 3,
    use: 4
  };

  function nodeKey(node) {
    return `${node.path}|${node.signal}`;
  }

  function pathDepth(pathValue) {
    return String(pathValue || "").split("/").filter(Boolean).length - 1;
  }

  function pathDistance(a, b) {
    const left = String(a || "").split("/").filter(Boolean);
    const right = String(b || "").split("/").filter(Boolean);
    let common = 0;
    while (common < left.length && common < right.length && left[common] === right[common]) {
      common += 1;
    }
    return (left.length - common) + (right.length - common);
  }

  function itemKey(item) {
    return `${item.instancePath}|${item.line}|${item.traceKind}|${item.lookupSignal}|${item.file}`;
  }

  function isSimpleNetPin(pin) {
    const refs = pin.refs || [];
    if (refs.length !== 1) return false;
    const expr = String(pin.expr || "").trim();
    const ref = refs[0];
    if (expr === ref) return true;
    return new RegExp(`^${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\[[^\\]]+\\]$`).test(expr);
  }

  function combineFlow(currentFlow, edgeFlow) {
    if (!edgeFlow || edgeFlow === "net") return currentFlow;
    if (currentFlow === "both") return edgeFlow;
    return currentFlow === edgeFlow ? currentFlow : null;
  }

  function createClient(manifest, loadModule) {
    if (!manifest || !manifest.modules || !manifest.instanceByPath) {
      throw new Error("netgraph manifest 结构无效");
    }
    const shardPromises = new Map();
    const instanceByPath = manifest.instanceByPath;

    function shard(moduleName) {
      if (!manifest.modules[moduleName]) {
        return Promise.reject(new Error(`netgraph 缺少模块分片: ${moduleName}`));
      }
      if (!shardPromises.has(moduleName)) {
        shardPromises.set(moduleName, Promise.resolve(loadModule(moduleName, manifest.modules[moduleName])));
      }
      return shardPromises.get(moduleName);
    }

    function resolvePath(moduleName, requestedPath) {
      if (requestedPath && instanceByPath[requestedPath] && instanceByPath[requestedPath].module === moduleName) {
        return requestedPath;
      }
      if (moduleName === manifest.top && instanceByPath[manifest.top]) return manifest.top;
      const candidates = (manifest.instances || []).filter((item) => item.module === moduleName);
      if (candidates.length === 1) return candidates[0].path;
      if (requestedPath) {
        const leaf = String(requestedPath).split("/").pop();
        const byLeaf = candidates.find((item) => item.cell === leaf);
        if (byLeaf) return byLeaf.path;
      }
      return candidates[0] ? candidates[0].path : null;
    }

    async function neighbors(node) {
      const moduleShard = await shard(node.module);
      const result = [];
      const instance = instanceByPath[node.path];

      for (const cell of moduleShard.cells || []) {
        const childPath = `${node.path}/${cell.name}`;
        for (const pin of cell.pins || []) {
          if (!(pin.refs || []).includes(node.signal)) continue;
          const net = isSimpleNetPin(pin);
          const flow = net
            ? "net"
            : pin.direction === "input"
              ? "down"
              : pin.direction === "output"
                ? "up"
                : "net";
          result.push({
            node: { path: childPath, module: cell.module, signal: pin.port },
            flow,
            evidence: {
              file: moduleShard.file,
              line: pin.line,
              instancePath: node.path,
              module: node.module,
              lookupSignal: node.signal,
              traceKind: "instance",
              highlightSignals: [...new Set([...(pin.refs || []), pin.port])],
              detail: `${cell.name}.${pin.port}(${pin.expr || "..."})`
            }
          });
        }
      }

      if (instance && instance.parent) {
        const parentShard = await shard(instanceByPath[instance.parent].module);
        const parentCell = (parentShard.cells || []).find((cell) => cell.name === instance.cell);
        if (parentCell) {
          for (const pin of parentCell.pins || []) {
            if (pin.port !== node.signal) continue;
            const net = isSimpleNetPin(pin);
            const flow = net
              ? "net"
              : pin.direction === "input"
                ? "up"
                : pin.direction === "output"
                  ? "down"
                  : "net";
            for (const ref of pin.refs || []) {
              result.push({
                node: { path: instance.parent, module: instanceByPath[instance.parent].module, signal: ref },
                flow,
                evidence: {
                  file: parentShard.file,
                  line: pin.line,
                  instancePath: instance.parent,
                  module: instanceByPath[instance.parent].module,
                  lookupSignal: ref,
                  traceKind: "instance",
                  highlightSignals: [...new Set([...(pin.refs || []), pin.port])],
                  detail: `${parentCell.name}.${pin.port}(${pin.expr || "..."})`
                }
              });
            }
          }
        }
      }

      for (const assignment of moduleShard.assignments || []) {
        if ((assignment.rhs || []).includes(node.signal)) {
          for (const target of assignment.lhs || []) {
            result.push({
              node: { path: node.path, module: node.module, signal: target },
              flow: "down",
              evidence: null
            });
          }
        }
        if ((assignment.lhs || []).includes(node.signal)) {
          for (const source of assignment.rhs || []) {
            result.push({
              node: { path: node.path, module: node.module, signal: source },
              flow: "up",
              evidence: null
            });
          }
        }
      }

      return result;
    }

    async function trace(options) {
      const moduleName = options.module;
      const signal = options.signal;
      const startPath = resolvePath(moduleName, options.instancePath);
      const maxDepth = Math.max(1, Math.min(12, Number(options.maxDepth) || 5));
      const maxNodes = Math.max(8, Math.min(400, Number(options.maxNodes) || 96));
      if (!startPath) throw new Error(`没有找到 ${moduleName} 的实例路径`);

      const startNode = { path: startPath, module: moduleName, signal };
      const queue = [{ node: startNode, depth: 0, flow: "both" }];
      const visited = new Set();
      const groups = new Map();
      const globalItemKeys = new Set();
      let truncated = false;

      const groupFor = (node) => {
        if (!groups.has(node.path)) {
          groups.set(node.path, {
            path: node.path,
            module: node.module,
            signals: new Set(),
            items: []
          });
        }
        return groups.get(node.path);
      };

      const addItem = (item) => {
        if (!item || !item.file || !item.line) return;
        const key = itemKey(item);
        if (globalItemKeys.has(key)) return;
        globalItemKeys.add(key);
        const group = groupFor({ path: item.instancePath, module: item.module, signal: item.lookupSignal });
        group.items.push({ ...item });
      };

      while (queue.length) {
        const current = queue.shift();
        const { node, depth, flow } = current;
        const key = `${nodeKey(node)}|${flow}`;
        if (visited.has(key)) continue;
        if (visited.size >= maxNodes) {
          truncated = true;
          break;
        }
        visited.add(key);

        const moduleShard = await shard(node.module);
        const group = groupFor(node);
        group.signals.add(node.signal);

        const port = (moduleShard.ports || []).find((item) => item.name === node.signal);
        if (port) {
          addItem({
            file: moduleShard.file,
            line: port.line,
            instancePath: node.path,
            module: node.module,
            lookupSignal: node.signal,
            traceKind: "port",
            highlightSignals: [node.signal],
            detail: `${port.direction || "port"} ${port.name}`
          });
        }

        for (const use of (moduleShard.uses && moduleShard.uses[node.signal]) || []) {
          addItem({
            file: moduleShard.file,
            line: use.line,
            instancePath: node.path,
            module: node.module,
            lookupSignal: node.signal,
            traceKind: use.role,
            highlightSignals: [node.signal],
            detail: use.kind || ""
          });
        }

        if (depth >= maxDepth) {
          if (queue.length) truncated = true;
          continue;
        }

        const next = await neighbors(node);
        for (const edge of next) {
          if (edge.evidence) addItem(edge.evidence);
          const nextFlow = combineFlow(flow, edge.flow);
          if (nextFlow && !visited.has(`${nodeKey(edge.node)}|${nextFlow}`)) {
            queue.push({ node: edge.node, depth: depth + 1, flow: nextFlow });
          }
        }
      }

      const startDepth = pathDepth(startPath);
      const sortedGroups = [...groups.values()].map((group) => {
        const groupDepth = pathDepth(group.path);
        let score = 100 + groupDepth * 4;
        if (group.path === startPath) {
          score = 0;
        } else if (group.path.startsWith(`${startPath}/`) || startPath.startsWith(`${group.path}/`)) {
          score = 10 + pathDistance(group.path, startPath);
        } else if (groupDepth === startDepth) {
          score = 60 + pathDistance(group.path, startPath);
        }
        const items = group.items
          .sort((a, b) => {
            const kind = (TRACE_KIND_ORDER[a.traceKind] ?? 9) - (TRACE_KIND_ORDER[b.traceKind] ?? 9);
            return a.line - b.line || kind;
          });
        return {
          ...group,
          signals: [...group.signals].sort(),
          items,
          score
        };
      }).sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));

      return {
        startNode,
        groups: sortedGroups,
        stats: {
          nodes: visited.size,
          groups: sortedGroups.length,
          truncated,
          maxDepth,
          maxNodes
        }
      };
    }

    return {
      manifest,
      shard,
      resolvePath,
      trace
    };
  }

  async function load(baseUrl, options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw new Error("当前环境不支持 fetch");
    const prefix = String(baseUrl || "netgraph/").replace(/\/?$/, "/");
    const manifestResponse = await fetchImpl(`${prefix}manifest.json`, { cache: "no-cache" });
    if (!manifestResponse.ok) {
      throw new Error(`netgraph manifest 加载失败: HTTP ${manifestResponse.status}`);
    }
    const manifest = await manifestResponse.json();
    const cache = new Map();
    const loadModule = async (moduleName, moduleInfo) => {
      if (!cache.has(moduleName)) {
        cache.set(moduleName, (async () => {
          const response = await fetchImpl(`${prefix}${moduleInfo.shard}`, { cache: "no-cache" });
          if (!response.ok) {
            throw new Error(`${moduleName} 分片加载失败: HTTP ${response.status}`);
          }
          return response.json();
        })());
      }
      return cache.get(moduleName);
    };
    return createClient(manifest, loadModule);
  }

  return {
    createClient,
    load
  };
}));
