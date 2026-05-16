import express from "express";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3847;
const POLL_MS = Number(process.env.POLL_MS) || 15000;
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES) || 2000;
const DEFAULT_NAMESPACE = process.env.DEFAULT_NAMESPACE || "default";

/** `kubectl logs -f --all-containers` defaults to 5 concurrent streams; raise for large pods (e.g. JFrog). */
const KUBECTL_LOGS_MAX_REQUESTS_ALL = (() => {
  const n = Number(process.env.KUBECTL_LOGS_MAX_REQUESTS_ALL);
  if (Number.isFinite(n) && n >= 6 && n <= 256) return Math.floor(n);
  return 64;
})();

/** Pod phase counts + restarts from `kubectl get pods -o json` */
const PHASE_KEYS = ["Running", "Pending", "Failed", "Succeeded", "Unknown"];

/** Latest pod rows for the namespace last polled (single snapshot). */
let latestPodsSnapshot = { namespace: "", t: /** @type {number|null} */ (null), pods: [] };

/** Latest `kubectl get secrets -n <ns>` text for the active namespace. */
let latestSecretsSnapshot = { namespace: "", t: /** @type {number|null} */ (null), output: "" };

/** Latest `kubectl get svc -n <ns>` text for the active namespace. */
let latestServicesSnapshot = { namespace: "", t: /** @type {number|null} */ (null), output: "" };

/** @type {{ nodes: Array<{ t: number, rows: Record<string, { cpuMilli: number, memKi: number }> }>, podsByNs: Map<string, Array<{ t: number, rows: Record<string, { cpuMilli: number, memKi: number }> }>>, getPodsByNs: Map<string, Array<{ t: number, summary: Record<string, number> }>> }} */
const store = {
  nodes: [],
  podsByNs: new Map(),
  getPodsByNs: new Map(),
};

let activeNamespace = DEFAULT_NAMESPACE;
let lastPollError = null;
let lastPollAt = null;

function isValidNamespace(ns) {
  if (!ns || typeof ns !== "string") return false;
  if (ns.length > 63) return false;
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns);
}

/** Kubernetes pod name (DNS subdomain, max 253). */
function isValidPodName(name) {
  if (!name || typeof name !== "string" || name.length > 253) return false;
  return /^([a-z0-9]([-a-z0-9]*[a-z0-9])?)(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/i.test(name);
}

/** Container / initContainer name (DNS label). */
function isValidContainerName(name) {
  if (!name || typeof name !== "string" || name.length > 63) return false;
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/i.test(name);
}

function runKubectl(args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const child = spawn("kubectl", args, { env: process.env });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8");
      const err = Buffer.concat(errChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(err.trim() || out.trim() || `kubectl exited ${code}`));
      } else {
        resolve(out);
      }
    });
  });
}

/** Parse millicores like "123m" or "1" -> milli */
function parseCpu(s) {
  const t = String(s).trim();
  if (t.endsWith("n")) return Math.round(Number(t.slice(0, -1)) / 1e6);
  if (t.endsWith("u")) return Math.round(Number(t.slice(0, -1)) / 1000);
  if (t.endsWith("m")) return Math.round(Number(t.slice(0, -1)));
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

/** Memory to Ki (metrics-server uses Ki/Mi/Gi) */
function parseMemToKi(s) {
  const t = String(s).trim();
  const m = t.match(/^([\d.]+)(Ki|Mi|Gi)?$/i);
  if (!m) return 0;
  const v = Number(m[1]);
  const u = (m[2] || "Ki").toLowerCase();
  if (!Number.isFinite(v)) return 0;
  if (u === "ki") return Math.round(v);
  if (u === "mi") return Math.round(v * 1024);
  if (u === "gi") return Math.round(v * 1024 * 1024);
  return Math.round(v);
}

/** "12%" or "12" -> 12 */
function parsePercentToken(s) {
  const t = String(s).trim().replace(/%$/, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function round1(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Same formula as `kubectl top nodes`: usage (from our top parse) / allocatable * 100.
 * Fills % when kubectl omits % columns (non-TTY). Aligns % with the absolute lines on the chart.
 */
async function enrichNodeRowsWithApiPercentages(rows) {
  const rawNodes = await runKubectl(["get", "nodes", "-o", "json"]);
  const nodeList = JSON.parse(rawNodes);

  for (const n of nodeList.items || []) {
    const name = n.metadata?.name;
    if (!name || rows[name] == null) continue;
    const c = n.status?.allocatable?.cpu;
    const m = n.status?.allocatable?.memory;
    const allocCpuMilli = c ? parseCpu(String(c)) : 0;
    const allocMemKi = m ? parseMemToKi(String(m)) : 0;

    const row = rows[name];
    if (allocCpuMilli > 0) {
      const p = round1(Math.min(100, (row.cpuMilli / allocCpuMilli) * 100));
      if (p != null) row.cpuPercent = p;
    }
    if (allocMemKi > 0) {
      const p = round1(Math.min(100, (row.memKi / allocMemKi) * 100));
      if (p != null) row.memPercent = p;
    }
  }
}

/**
 * kubectl top table -> { name: { cpuMilli, memKi, cpuPercent?, memPercent? } }
 * When present (e.g. `kubectl top nodes`), parses CPU% and MEMORY% columns.
 */
function parseTopTable(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return {};

  const header = lines[0].split(/\s+/);
  const nameIdx = header.findIndex((h) => /^NAME$/i.test(h));
  const cpuIdx = header.findIndex((h) => /^CPU\(/i.test(h) || (/^CPU$/i.test(h) && !/%$/i.test(h)));
  let memIdx = header.findIndex((h) => /MEMORY\(bytes\)/i.test(h));
  if (memIdx === -1) {
    memIdx = header.findIndex((h) => /^MEMORY/i.test(h) && !/MEMORY%/i.test(h));
  }
  const cpuPctIdx = header.findIndex((h) => /CPU/i.test(h) && /%/.test(h) && !/\(cores\)/i.test(h));
  const memPctIdx = header.findIndex((h) => /MEMORY/i.test(h) && /%/.test(h));
  if (nameIdx === -1 || cpuIdx === -1 || memIdx === -1) {
    return {};
  }

  const rows = {};
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s+/);
    const name = parts[nameIdx];
    const cpu = parts[cpuIdx];
    const mem = parts[memIdx];
    if (!name || name === "NAME") continue;
    /** @type {{ cpuMilli: number, memKi: number, cpuPercent?: number|null, memPercent?: number|null }} */
    const row = { cpuMilli: parseCpu(cpu), memKi: parseMemToKi(mem) };
    if (cpuPctIdx !== -1 && parts[cpuPctIdx] != null) {
      const p = parsePercentToken(parts[cpuPctIdx]);
      if (p != null) row.cpuPercent = p;
    }
    if (memPctIdx !== -1 && parts[memPctIdx] != null) {
      const p = parsePercentToken(parts[memPctIdx]);
      if (p != null) row.memPercent = p;
    }
    rows[name] = row;
  }
  return rows;
}

function emptyPhaseSummary() {
  /** @type {Record<string, number>} */
  const s = { total: 0, restarts: 0 };
  for (const k of PHASE_KEYS) s[k] = 0;
  return s;
}

/** `kubectl get pods -n ns -o json` → counts by phase + total container/init restarts */
function summarizePodsFromJson(text) {
  const summary = emptyPhaseSummary();
  const j = JSON.parse(text);
  const items = Array.isArray(j.items) ? j.items : [];
  for (const pod of items) {
    let phase = pod?.status?.phase || "Unknown";
    if (!PHASE_KEYS.includes(phase)) phase = "Unknown";
    summary[phase]++;
    summary.total++;
    const statuses = [
      ...(pod?.status?.containerStatuses || []),
      ...(pod?.status?.initContainerStatuses || []),
    ];
    for (const c of statuses) {
      summary.restarts += Number(c?.restartCount) || 0;
    }
  }
  return summary;
}

function podRestarts(pod) {
  let n = 0;
  const statuses = [
    ...(pod?.status?.containerStatuses || []),
    ...(pod?.status?.initContainerStatuses || []),
  ];
  for (const c of statuses) n += Number(c?.restartCount) || 0;
  return n;
}

/** READY column: ready / regular containers (matches default `kubectl get pods`). */
function podReadyString(pod) {
  const cs = pod?.status?.containerStatuses;
  const specN = (pod?.spec?.containers || []).length;
  if (!cs || !cs.length) return `0/${specN || 0}`;
  let ready = 0;
  for (const c of cs) if (c.ready) ready++;
  return `${ready}/${cs.length}`;
}

/** STATUS column approximation (waiting reasons, Completed, etc.). */
function podStatusString(pod) {
  const phase = pod?.status?.phase || "Unknown";

  for (const c of pod?.status?.initContainerStatuses || []) {
    const w = c?.state?.waiting?.reason;
    if (w) return w;
    const term = c?.state?.terminated;
    if (term && term.exitCode !== 0 && term.reason) return term.reason;
  }

  if (phase === "Succeeded") return "Completed";

  if (phase === "Failed") {
    const r = pod?.status?.reason;
    if (r) return r;
    return "Failed";
  }

  for (const c of pod?.status?.containerStatuses || []) {
    const w = c?.state?.waiting?.reason;
    if (w) return w;
    const term = c?.state?.terminated;
    if (term && !c.ready) {
      if (term.reason) return term.reason;
      if (term.signal) return `Signal:${term.signal}`;
      if (term.exitCode !== 0) return "Error";
    }
  }

  if (phase === "Pending") {
    for (const cond of pod?.status?.conditions || []) {
      if (cond.type === "PodScheduled" && cond.status === "False" && cond.reason) return cond.reason;
    }
  }

  return phase;
}

/** One row per pod for the UI table. */
function listPodsFromJson(text) {
  const j = JSON.parse(text);
  const items = Array.isArray(j.items) ? j.items : [];
  const rows = items.map((pod) => {
    const name = pod?.metadata?.name || "";
    const phase = pod?.status?.phase || "Unknown";
    return {
      name,
      phase,
      ready: podReadyString(pod),
      status: podStatusString(pod),
      restarts: podRestarts(pod),
    };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function pushRing(arr, item) {
  arr.push(item);
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
}

async function pollOnce() {
  lastPollError = null;
  const t = Date.now();

  try {
    const nodesOut = await runKubectl(["top", "nodes", "--no-headers=false"]);
    const nodeRows = parseTopTable(nodesOut);
    try {
      await enrichNodeRowsWithApiPercentages(nodeRows);
    } catch {
      /* `kubectl top` without a TTY often omits % columns; we recompute from `kubectl get nodes` allocatable. */
    }
    pushRing(store.nodes, { t, rows: nodeRows });
  } catch (e) {
    lastPollError = String(e.message || e);
  }

  try {
    const ns = activeNamespace;
    const podsOut = await runKubectl(["top", "pods", "-n", ns, "--no-headers=false"]);
    const podRows = parseTopTable(podsOut);
    if (!store.podsByNs.has(ns)) store.podsByNs.set(ns, []);
    pushRing(store.podsByNs.get(ns), { t, rows: podRows });
  } catch (e) {
    lastPollError = lastPollError
      ? `${lastPollError}; ${String(e.message || e)}`
      : String(e.message || e);
  }

  try {
    const ns = activeNamespace;
    const jsonOut = await runKubectl(["get", "pods", "-n", ns, "-o", "json"]);
    const summary = summarizePodsFromJson(jsonOut);
    if (!store.getPodsByNs.has(ns)) store.getPodsByNs.set(ns, []);
    pushRing(store.getPodsByNs.get(ns), { t, summary });
    latestPodsSnapshot = { namespace: ns, t: Date.now(), pods: listPodsFromJson(jsonOut) };
  } catch (e) {
    lastPollError = lastPollError
      ? `${lastPollError}; ${String(e.message || e)}`
      : String(e.message || e);
  }

  try {
    const ns = activeNamespace;
    const secretsOut = await runKubectl(["get", "secrets", "-n", ns]);
    latestSecretsSnapshot = { namespace: ns, t: Date.now(), output: secretsOut };
  } catch (e) {
    lastPollError = lastPollError
      ? `${lastPollError}; ${String(e.message || e)}`
      : String(e.message || e);
  }

  try {
    const ns = activeNamespace;
    const svcOut = await runKubectl(["get", "svc", "-n", ns]);
    latestServicesSnapshot = { namespace: ns, t: Date.now(), output: svcOut };
  } catch (e) {
    lastPollError = lastPollError
      ? `${lastPollError}; ${String(e.message || e)}`
      : String(e.message || e);
  }

  lastPollAt = t;
}

function rangeMs(range) {
  const r = String(range || "15m").toLowerCase();
  if (r === "5m") return 5 * 60 * 1000;
  if (r === "15m") return 15 * 60 * 1000;
  if (r === "30m") return 30 * 60 * 1000;
  if (r === "1h") return 60 * 60 * 1000;
  if (r === "4h") return 4 * 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function filterSamples(samples, since) {
  return samples.filter((s) => s.t >= since);
}

/** All entity names seen in the time window. */
function collectRowNames(filtered) {
  const names = new Set();
  for (const s of filtered) {
    for (const n of Object.keys(s.rows)) names.add(n);
  }
  return [...names];
}

/** Latest non-missing metric for ranking (most recent sample wins ties toward the end). */
function lastMetricForName(filtered, name, pick) {
  for (let i = filtered.length - 1; i >= 0; i--) {
    const row = filtered[i].rows[name];
    if (row == null) continue;
    const v = pick(row);
    if (v != null && Number.isFinite(v)) return v;
  }
  return 0;
}

/** Top N names by descending last observed value for that metric. */
function rankNamesByLastMetric(filtered, topN, pick) {
  return collectRowNames(filtered)
    .sort((a, b) => lastMetricForName(filtered, b, pick) - lastMetricForName(filtered, a, pick))
    .slice(0, topN);
}

/**
 * Build Chart.js-friendly datasets: labels = timestamps, datasets per entity (limit count).
 * CPU and memory legends use separate orders: descending by latest CPU / latest memory in the window.
 */
function buildSeries(samples, mode, topN) {
  const since = Date.now() - mode; // actually caller passes window end; we use labels from samples
  const filtered = samples.filter((s) => s.t >= since);
  if (!filtered.length) {
    return { labels: [], cpu: [], mem: [], namesCpu: [], namesMem: [] };
  }

  const labels = filtered.map((s) => new Date(s.t).toISOString());

  const namesCpu = rankNamesByLastMetric(filtered, topN, (r) => r.cpuMilli);
  const namesMem = rankNamesByLastMetric(filtered, topN, (r) => r.memKi);

  const cpuDatasets = namesCpu.map((name) => ({
    label: `${name} CPU (mcores)`,
    data: filtered.map((s) => s.rows[name]?.cpuMilli ?? null),
    spanGaps: true,
    pctData: filtered.map((s) => {
      const v = s.rows[name]?.cpuPercent;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }),
  }));
  const memDatasets = namesMem.map((name) => ({
    label: `${name} Mem (MiB)`,
    data: filtered.map((s) => (s.rows[name] ? s.rows[name].memKi / 1024 : null)),
    spanGaps: true,
    pctData: filtered.map((s) => {
      const v = s.rows[name]?.memPercent;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }),
  }));

  return { labels, cpu: cpuDatasets, mem: memDatasets, namesCpu, namesMem };
}

/**
 * Stacked phase counts + total restarts line (secondary axis) for Chart.js.
 */
function buildGetPodsSeries(samples, rangeMs) {
  const since = Date.now() - rangeMs;
  const filtered = samples.filter((s) => s.t >= since);
  if (!filtered.length) {
    return { labels: [], datasets: [] };
  }
  const labels = filtered.map((s) => new Date(s.t).toISOString());
  const phaseDatasets = PHASE_KEYS.map((phase) => ({
    label: phase,
    data: filtered.map((s) => s.summary[phase] ?? 0),
    stack: "phase",
    fill: true,
    tension: 0.2,
    spanGaps: true,
  }));
  const restarts = {
    label: "Total container restarts",
    data: filtered.map((s) => s.summary.restarts ?? 0),
    yAxisID: "y1",
    fill: false,
    tension: 0.2,
    spanGaps: true,
    borderWidth: 2,
  };
  return { labels, datasets: [...phaseDatasets, restarts] };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: !lastPollError,
    lastPollAt,
    lastPollError,
    activeNamespace,
    pollMs: POLL_MS,
  });
});

/** Cluster namespace names from `kubectl get namespaces -o json`. */
app.get("/api/namespaces", async (_req, res) => {
  try {
    const out = await runKubectl(["get", "namespaces", "-o", "json"]);
    const j = JSON.parse(out);
    const namespaces = (Array.isArray(j.items) ? j.items : [])
      .map((item) => item?.metadata?.name)
      .filter((name) => typeof name === "string" && name.length > 0)
      .sort((a, b) => a.localeCompare(b));
    res.json({ namespaces, activeNamespace });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), namespaces: [], activeNamespace });
  }
});

app.post("/api/namespace", (req, res) => {
  const ns = req.body?.namespace;
  if (!isValidNamespace(ns)) {
    return res.status(400).json({ error: "Invalid namespace (RFC 1123 label, max 63 chars)" });
  }
  activeNamespace = ns;
  if (!store.podsByNs.has(ns)) store.podsByNs.set(ns, []);
  if (!store.getPodsByNs.has(ns)) store.getPodsByNs.set(ns, []);
  res.json({ namespace: activeNamespace });
});

app.get("/api/series", (req, res) => {
  const ns = String(req.query.namespace || activeNamespace);
  if (!isValidNamespace(ns)) {
    return res.status(400).json({ error: "Invalid namespace" });
  }
  const range = rangeMs(req.query.range);
  const topN = Math.min(20, Math.max(3, Number(req.query.top) || 12));
  const since = Date.now() - range;

  const nodeSamples = filterSamples(store.nodes, since);
  const podSamples = filterSamples(store.podsByNs.get(ns) || [], since);
  const getPodSamples = filterSamples(store.getPodsByNs.get(ns) || [], since);

  const podList = ns === latestPodsSnapshot.namespace ? latestPodsSnapshot.pods : [];
  const podListUpdatedAt = ns === latestPodsSnapshot.namespace ? latestPodsSnapshot.t : null;
  const secretsOutput = ns === latestSecretsSnapshot.namespace ? latestSecretsSnapshot.output : "";
  const secretsUpdatedAt = ns === latestSecretsSnapshot.namespace ? latestSecretsSnapshot.t : null;
  const servicesOutput = ns === latestServicesSnapshot.namespace ? latestServicesSnapshot.output : "";
  const servicesUpdatedAt = ns === latestServicesSnapshot.namespace ? latestServicesSnapshot.t : null;

  res.json({
    namespace: ns,
    rangeMs: range,
    nodes: buildSeries(nodeSamples, range, topN),
    pods: buildSeries(podSamples, range, topN),
    getPods: buildGetPodsSeries(getPodSamples, range),
    podList,
    podListUpdatedAt,
    secretsOutput,
    secretsUpdatedAt,
    servicesOutput,
    servicesUpdatedAt,
    note:
      "CPU/memory from periodic `kubectl top` (metrics-server). Pod phases/restarts and the table come from `kubectl get pods -o json`. Secrets and services panels show the last `kubectl get` output from poll. History exists only while this server runs.",
  });
});

/** `kubectl describe pod` — JSON body for UI. */
app.get("/api/pod/describe", async (req, res) => {
  const ns = String(req.query.namespace || "");
  const pod = String(req.query.pod || "");
  if (!isValidNamespace(ns) || !isValidPodName(pod)) {
    return res.status(400).json({ error: "Invalid namespace or pod name" });
  }
  try {
    const output = await runKubectl(["describe", "pod", pod, "-n", ns]);
    res.json({ output });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** `kubectl delete pod` */
app.delete("/api/pod", async (req, res) => {
  const ns = String(req.query.namespace || "");
  const pod = String(req.query.pod || "");
  if (!isValidNamespace(ns) || !isValidPodName(pod)) {
    return res.status(400).json({ error: "Invalid namespace or pod name" });
  }
  try {
    await runKubectl(["delete", "pod", pod, "-n", ns]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** List container names from pod spec (for log target picker). */
app.get("/api/pod/containers", async (req, res) => {
  const ns = String(req.query.namespace || "");
  const pod = String(req.query.pod || "");
  if (!isValidNamespace(ns) || !isValidPodName(pod)) {
    return res.status(400).json({ error: "Invalid namespace or pod name" });
  }
  try {
    const out = await runKubectl(["get", "pod", pod, "-n", ns, "-o", "json"]);
    const j = JSON.parse(out);
    const spec = j.spec || {};
    const containers = (spec.containers || []).map((c) => c.name).filter(Boolean);
    const initContainers = (spec.initContainers || []).map((c) => c.name).filter(Boolean);
    const ephemeralContainers = (spec.ephemeralContainers || []).map((c) => c.name).filter(Boolean);
    res.json({ containers, initContainers, ephemeralContainers });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Live `kubectl logs -f` via Server-Sent Events (one message per line, JSON-encoded).
 * Query: `container=<name>` or `all=1` for `--all-containers=true`.
 * All-containers follow uses `--max-log-requests` (see `KUBECTL_LOGS_MAX_REQUESTS_ALL`, default 64).
 * Client must close the connection to stop streaming (SIGTERM to kubectl).
 */
app.get("/api/pod/logs", (req, res) => {
  const ns = String(req.query.namespace || "");
  const pod = String(req.query.pod || "");
  if (!isValidNamespace(ns) || !isValidPodName(pod)) {
    res.status(400);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Invalid namespace or pod name");
  }

  const allContainers = req.query.all === "1" || req.query.all === "true";
  const container = String(req.query.container || "");
  if (!allContainers && container && !isValidContainerName(container)) {
    res.status(400);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("Invalid container name");
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const args = ["logs", "-f", pod, "-n", ns, "--tail=200"];
  if (allContainers) {
    args.push("--all-containers=true", `--max-log-requests=${KUBECTL_LOGS_MAX_REQUESTS_ALL}`);
  } else if (container) args.push("-c", container);

  const child = spawn("kubectl", args, { env: process.env });

  let ended = false;

  const flush = (bufRef, chunk, prefix = "") => {
    bufRef.val += chunk.toString("utf8");
    let idx;
    while ((idx = bufRef.val.indexOf("\n")) >= 0) {
      const line = bufRef.val.slice(0, idx);
      bufRef.val = bufRef.val.slice(idx + 1);
      const payload = prefix ? `${prefix}${line}` : line;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  const outRef = { val: "" };
  const errRef = { val: "" };

  child.stdout.on("data", (d) => flush(outRef, d));
  child.stderr.on("data", (d) => flush(errRef, d, "[stderr] "));

  const endSse = () => {
    if (ended) return;
    ended = true;
    if (outRef.val) res.write(`data: ${JSON.stringify(outRef.val)}\n\n`);
    if (errRef.val) res.write(`data: ${JSON.stringify(`[stderr] ${errRef.val}`)}\n\n`);
    res.write(`event: end\ndata: {}\n\n`);
    try {
      res.end();
    } catch (_) {}
  };

  child.on("close", () => endSse());
  child.on("error", (err) => {
    res.write(`data: ${JSON.stringify(`[error] ${err.message}`)}\n\n`);
    endSse();
  });

  req.on("close", () => {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
  });
});

app.listen(PORT, async () => {
  console.log(`GKE top UI → http://127.0.0.1:${PORT}`);
  console.log(`Poll every ${POLL_MS}ms, namespace: ${activeNamespace}`);
  await pollOnce().catch(() => {});
  setInterval(() => {
    pollOnce().catch((e) => {
      lastPollError = String(e.message || e);
    });
  }, POLL_MS);
});
