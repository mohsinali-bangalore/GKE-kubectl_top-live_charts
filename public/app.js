/** @type {any} */
let chartNodesCpu = null;
/** @type {any} */
let chartNodesMem = null;
/** @type {any} */
let chartPodsCpu = null;
/** @type {any} */
let chartPodsMem = null;
/** @type {any} */
let chartGetPods = null;

const palette = [
  "#5b9cf5",
  "#7fd99a",
  "#e6b84d",
  "#c79ef6",
  "#f07178",
  "#5bd6d6",
  "#ffb454",
  "#7aa2f7",
  "#9ece6a",
  "#bb9af7",
  "#f7768e",
  "#7dcfff",
];

/** ISO timestamp string from chart `data.labels[index]`, for category/time ticks. */
function formatAxisTimeFromChart(chart, index) {
  const raw = chart?.data?.labels?.[index];
  if (raw == null || raw === "") return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function tooltipTitleFromItems(items) {
  const item = items[0];
  if (!item?.chart) return "";
  const idx = item.dataIndex;
  const raw = item.chart.data.labels[idx];
  if (raw == null) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleString();
}

/** Numeric y at hover for tooltip ordering (missing → sort last). */
function tooltipSortValue(item) {
  const y = item?.parsed?.y;
  if (typeof y === "number" && Number.isFinite(y)) return y;
  return Number.NEGATIVE_INFINITY;
}

function nodeBaseName(dataset) {
  let text = String(dataset?.label || "");
  return text.replace(/ CPU \(mcores\)$/i, "").replace(/ Mem \(MiB\)$/i, "");
}

/** Compact grid: truncated names; expanded zoom: full node names (tooltip always has full label). */
function nodeLegendText(dataset, chart) {
  const text = nodeBaseName(dataset);
  if (chart?.canvas?.closest("#chart-zoom-slot")) return text;
  const max = 32;
  if (text.length > max) return `${text.slice(0, max - 1)}…`;
  return text;
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        position: "bottom",
        labels: { boxWidth: 10, font: { size: 10 }, color: "#b8c5da" },
      },
      tooltip: {
        /** Primary axis (y) rows first, then y1; within each group, highest value first. */
        itemSort: (a, b) => {
          const axisA = a.dataset.yAxisID || "y";
          const axisB = b.dataset.yAxisID || "y";
          if (axisA !== axisB) return axisA === "y" ? -1 : 1;
          return tooltipSortValue(b) - tooltipSortValue(a);
        },
        callbacks: {
          title(items) {
            return tooltipTitleFromItems(items);
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          maxTicksLimit: 8,
          color: "#8b9bb5",
          /** Category scale: use `data.labels[index]`, not `ticks[index].label` (fixes "Invalid Date"). */
          callback(tickValue, index) {
            return formatAxisTimeFromChart(this.chart, index);
          },
        },
        grid: { color: "rgba(255,255,255,0.06)" },
      },
      y: {
        ticks: { color: "#8b9bb5" },
        grid: { color: "rgba(255,255,255,0.06)" },
      },
    },
  };
}

function colorize(datasets) {
  datasets.forEach((ds, i) => {
    const c = palette[i % palette.length];
    ds.borderColor = c;
    ds.backgroundColor = `${c}22`;
    ds.tension = 0.25;
    ds.pointRadius = 0;
    ds.borderWidth = 1.5;
    ds.fill = false;
    delete ds.yAxisID;
    delete ds.borderDash;
  });
  return datasets;
}

/** One line per node; % of allocatable only in the tooltip (via `pctData`). */
function nodeChartOptions(yAxisTitle) {
  const base = chartDefaults();
  return {
    ...base,
    layout: {
      padding: { bottom: 4, top: 2 },
    },
    plugins: {
      ...base.plugins,
      legend: {
        ...base.plugins.legend,
        position: "bottom",
        align: "start",
        labels: {
          ...base.plugins.legend.labels,
          padding: 10,
          generateLabels(chart) {
            const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
            return items.map((item) => {
              const ds = chart.data.datasets[item.datasetIndex];
              return { ...item, text: nodeLegendText(ds, chart) };
            });
          },
        },
      },
      tooltip: {
        ...base.plugins.tooltip,
        callbacks: {
          ...base.plugins.tooltip.callbacks,
          label(ctx) {
            const y = ctx.parsed?.y;
            const ds = ctx.dataset;
            const pct = ds.pctData?.[ctx.dataIndex];
            if (y == null || !Number.isFinite(y)) return `${ds.label || ""}: —`;
            const unit = ds.label?.includes("CPU") ? " mcores" : " MiB";
            let line = `${ds.label}: ${y.toLocaleString()}${unit}`;
            if (pct != null && Number.isFinite(pct)) line += ` (${pct}%)`;
            return line;
          },
        },
      },
    },
    scales: {
      ...base.scales,
      y: {
        ...base.scales.y,
        title: { display: true, text: yAxisTitle, color: "#8b9bb5", font: { size: 11 } },
      },
    },
  };
}

function ensureNodeChart(ctx, prev, labels, datasets, yAxisTitle) {
  const hadDual =
    Boolean(prev?.options?.scales?.y1) || Boolean(prev?.data?.datasets?.some((d) => d.yAxisID === "y1"));
  if (prev && hadDual) {
    prev.destroy();
    prev = null;
  }

  colorize(datasets);
  const options = nodeChartOptions(yAxisTitle);

  if (prev) {
    prev.data.labels = labels;
    prev.data.datasets = datasets;
    prev.options = options;
    prev.update("none");
    return prev;
  }
  return new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options,
  });
}

function ensureChart(ctx, prev, labels, datasets) {
  colorize(datasets);
  if (prev) {
    prev.data.labels = labels;
    prev.data.datasets = datasets;
    prev.update("none");
    return prev;
  }
  return new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: chartDefaults(),
  });
}

/** Stacked pod phases (left axis) + restarts line (right axis). */
function ensureGetPodsChart(ctx, prev, labels, datasets) {
  if (!datasets.length) {
    if (prev) {
      prev.data.labels = [];
      prev.data.datasets = [];
      prev.update("none");
    }
    return prev;
  }
  const phaseSets = datasets.filter((d) => d.yAxisID !== "y1");
  const restartSet = datasets.find((d) => d.yAxisID === "y1");
  colorize(phaseSets);
  if (restartSet) {
    restartSet.borderColor = "#f07178";
    restartSet.backgroundColor = "rgba(240, 113, 120, 0.06)";
    restartSet.pointRadius = 0;
    restartSet.borderWidth = 2;
    restartSet.fill = false;
  }
  const base = chartDefaults();
  const options = {
    ...base,
    scales: {
      ...base.scales,
      y: {
        ...base.scales.y,
        stacked: true,
        title: { display: true, text: "Pods by phase", color: "#8b9bb5", font: { size: 11 } },
      },
      y1: {
        position: "right",
        stacked: false,
        grid: { drawOnChartArea: false },
        ticks: { color: "#8b9bb5" },
        title: { display: true, text: "Restarts", color: "#8b9bb5", font: { size: 11 } },
      },
    },
  };
  if (prev) {
    prev.data.labels = labels;
    prev.data.datasets = datasets;
    prev.update("none");
    return prev;
  }
  return new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options,
  });
}

let currentRange = "15m";
let currentNamespace = "default";

function setStatus(el, health) {
  el.classList.remove("ok", "err");
  if (!health) {
    el.textContent = "No health data yet.";
    return;
  }
  const age = health.lastPollAt ? `${Math.round((Date.now() - health.lastPollAt) / 1000)}s ago` : "never";
  if (health.ok) {
    el.classList.add("ok");
    el.textContent = `Polling OK · last sample ${age} · ns ${health.activeNamespace} · every ${health.pollMs}ms`;
  } else {
    el.classList.add("err");
    el.textContent = `Poll error (${age}): ${health.lastPollError || "unknown"}`;
  }
}

function fillNamespaceSelect(namespaces, selected) {
  const sel = document.getElementById("namespace");
  if (!sel) return;

  const prev = sel.dataset.touched === "1" ? sel.value : selected || currentNamespace;
  sel.replaceChildren();

  if (!namespaces?.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No namespaces found";
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  const set = new Set(namespaces);
  if (prev && !set.has(prev)) {
    const extra = document.createElement("option");
    extra.value = prev;
    extra.textContent = `${prev} (current)`;
    sel.appendChild(extra);
  }
  for (const ns of namespaces) {
    const o = document.createElement("option");
    o.value = ns;
    o.textContent = ns;
    sel.appendChild(o);
  }
  if (prev) sel.value = prev;
}

async function loadNamespaces() {
  const r = await fetch("/api/namespaces");
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  const selected = j.activeNamespace || currentNamespace;
  if (j.activeNamespace) currentNamespace = j.activeNamespace;
  fillNamespaceSelect(j.namespaces || [], selected);
  return j;
}

async function refreshHealth() {
  const el = document.getElementById("status");
  try {
    const r = await fetch("/api/health");
    const h = await r.json();
    setStatus(el, h);
    const sel = document.getElementById("namespace");
    if (h.activeNamespace) currentNamespace = h.activeNamespace;
    if (sel && !sel.dataset.touched && h.activeNamespace) sel.value = h.activeNamespace;
    return h;
  } catch (e) {
    el.classList.add("err");
    el.textContent = `Cannot reach server: ${e}`;
    return null;
  }
}

async function applyNamespace(ns) {
  const r = await fetch("/api/namespace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespace: ns }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || r.statusText);
  }
  const j = await r.json();
  currentNamespace = j.namespace;
}

async function loadSeries() {
  const q = new URLSearchParams({ range: currentRange, namespace: currentNamespace, top: "12" });
  const r = await fetch(`/api/series?${q}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || r.statusText);
  }
  return r.json();
}

/** @type {EventSource | null} */
let podLogEventSource = null;
/** @type {string | null} */
let logsModalPodName = null;
/** Bumped on each logs modal open/close so stale container fetches are ignored. */
let logsModalFetchGen = 0;
/** Whether the logs modal loaded at least one streamable container (or “all” is allowed). */
let logsModalHasStreamableContainers = false;
/** @type {string | null} */
let podMenuPod = null;

function hidePodActionMenu() {
  const menu = document.getElementById("pod-action-menu");
  if (!menu) return;
  menu.hidden = true;
  menu.innerHTML = "";
  menu.dataset.pod = "";
  podMenuPod = null;
}

function positionPodMenu(menu, clientX, clientY) {
  menu.hidden = false;
  const pad = 8;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let x = clientX;
  let y = clientY;
  if (x + w + pad > window.innerWidth) x = Math.max(pad, window.innerWidth - w - pad);
  if (y + h + pad > window.innerHeight) y = Math.max(pad, window.innerHeight - h - pad);
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
}

function showPodActionMenu(clientX, clientY, podName) {
  const menu = document.getElementById("pod-action-menu");
  if (!menu) return;
  if (podMenuPod === podName && !menu.hidden) {
    hidePodActionMenu();
    return;
  }
  menu.innerHTML = `
    <button type="button" class="pod-menu-item" role="menuitem" data-action="describe">Describe pod</button>
    <button type="button" class="pod-menu-item" role="menuitem" data-action="logs">View logs</button>
    <button type="button" class="pod-menu-item pod-menu-danger" role="menuitem" data-action="delete">Delete pod</button>
  `;
  menu.dataset.pod = podName;
  podMenuPod = podName;
  positionPodMenu(menu, clientX, clientY);
}

function closeModalById(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

function openDescribeModal(podName) {
  const backdrop = document.getElementById("modal-describe-backdrop");
  const out = document.getElementById("describe-output");
  const err = document.getElementById("describe-error");
  const title = document.getElementById("describe-modal-title");
  if (!backdrop || !out || !err || !title) return;
  title.textContent = `Describe pod — ${podName}`;
  out.textContent = "Loading…";
  err.hidden = true;
  err.textContent = "";
  backdrop.hidden = false;

  const q = new URLSearchParams({ namespace: currentNamespace, pod: podName });
  fetch(`/api/pod/describe?${q}`)
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (!ok) {
        out.textContent = "";
        err.textContent = j.error || "Request failed";
        err.hidden = false;
        return;
      }
      out.textContent = j.output || "(empty)";
    })
    .catch((e) => {
      out.textContent = "";
      err.textContent = String(e.message || e);
      err.hidden = false;
    });
}

function syncLogsFormDisabled() {
  const sel = document.getElementById("logs-container-select");
  const allChk = document.getElementById("logs-all-containers");
  const start = document.getElementById("logs-start-btn");
  if (!sel || !allChk || !start) return;
  const streaming = Boolean(podLogEventSource);
  const all = allChk.checked;
  allChk.disabled = streaming || !logsModalHasStreamableContainers;
  sel.disabled = streaming || all || !logsModalHasStreamableContainers;
  const canPickOne = Boolean(sel.value);
  start.disabled =
    streaming ||
    !logsModalHasStreamableContainers ||
    (!all && !canPickOne);
}

function stopPodLogs() {
  if (podLogEventSource) {
    podLogEventSource.close();
    podLogEventSource = null;
  }
  syncLogsFormDisabled();
}

function attachPodLogStreamHandlers(out, err) {
  if (!podLogEventSource) return;
  podLogEventSource.onmessage = (ev) => {
    try {
      const line = JSON.parse(ev.data);
      out.textContent += (out.textContent ? "\n" : "") + line;
      out.scrollTop = out.scrollHeight;
    } catch {
      out.textContent += (out.textContent ? "\n" : "") + ev.data;
      out.scrollTop = out.scrollHeight;
    }
  };

  podLogEventSource.addEventListener("end", () => {
    stopPodLogs();
  });

  podLogEventSource.onerror = () => {
    err.textContent = "Log stream ended or failed. Stop and try again.";
    err.hidden = false;
    stopPodLogs();
  };
}

function startPodLogStreamFromForm() {
  if (!logsModalPodName) return;
  const allChk = document.getElementById("logs-all-containers");
  const sel = document.getElementById("logs-container-select");
  const out = document.getElementById("logs-output");
  const err = document.getElementById("logs-error");
  if (!allChk || !sel || !out || !err) return;

  const all = allChk.checked;
  const container = sel.value;
  if (!all && !container) {
    err.textContent = "Pick a container, or enable “All containers”.";
    err.hidden = false;
    return;
  }

  err.hidden = true;
  err.textContent = "";
  out.textContent = "";
  stopPodLogs();

  const q = new URLSearchParams({
    namespace: currentNamespace,
    pod: logsModalPodName,
  });
  if (all) q.set("all", "1");
  else q.set("container", container);

  const url = `/api/pod/logs?${q}`;
  podLogEventSource = new EventSource(url);
  syncLogsFormDisabled();
  attachPodLogStreamHandlers(out, err);
}

function closeLogsModal() {
  logsModalFetchGen += 1;
  stopPodLogs();
  closeModalById("modal-logs-backdrop");
}

function openLogsModal(podName) {
  logsModalHasStreamableContainers = false;
  stopPodLogs();
  logsModalFetchGen += 1;
  const fetchTicket = logsModalFetchGen;
  logsModalPodName = podName;

  const backdrop = document.getElementById("modal-logs-backdrop");
  const out = document.getElementById("logs-output");
  const err = document.getElementById("logs-error");
  const title = document.getElementById("logs-modal-title");
  const sel = document.getElementById("logs-container-select");
  const allChk = document.getElementById("logs-all-containers");
  const startBtn = document.getElementById("logs-start-btn");
  if (!backdrop || !out || !err || !title || !sel || !allChk || !startBtn) return;

  title.textContent = `Logs — ${podName} (${currentNamespace})`;
  out.textContent = "";
  err.hidden = true;
  err.textContent = "";
  allChk.checked = false;
  sel.innerHTML = "";
  const loadingOpt = document.createElement("option");
  loadingOpt.value = "";
  loadingOpt.textContent = "Loading…";
  sel.appendChild(loadingOpt);
  backdrop.hidden = false;
  syncLogsFormDisabled();

  const q = new URLSearchParams({ namespace: currentNamespace, pod: podName });
  fetch(`/api/pod/containers?${q}`)
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (fetchTicket !== logsModalFetchGen || backdrop.hidden) return;
      if (logsModalPodName !== podName || backdrop.hidden) return;
      sel.innerHTML = "";
      if (!ok) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = j.error || "Failed to load";
        sel.appendChild(o);
        err.textContent = j.error || "Failed to load containers";
        err.hidden = false;
        logsModalHasStreamableContainers = false;
        syncLogsFormDisabled();
        return;
      }
      const containers = j.containers || [];
      const initContainers = j.initContainers || [];
      const ephemeralContainers = j.ephemeralContainers || [];
      const total = containers.length + initContainers.length + ephemeralContainers.length;
      if (total === 0) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "No containers";
        sel.appendChild(o);
        err.textContent = "No containers in pod spec.";
        err.hidden = false;
        logsModalHasStreamableContainers = false;
        syncLogsFormDisabled();
        return;
      }

      function addGroup(label, names) {
        if (!names.length) return;
        const og = document.createElement("optgroup");
        og.label = label;
        for (const n of names) {
          const o = document.createElement("option");
          o.value = n;
          o.textContent = n;
          og.appendChild(o);
        }
        sel.appendChild(og);
      }
      addGroup("Containers", containers);
      addGroup("Init containers", initContainers);
      addGroup("Ephemeral containers", ephemeralContainers);

      logsModalHasStreamableContainers = true;
      sel.selectedIndex = 0;
      syncLogsFormDisabled();
    })
    .catch((e) => {
      if (fetchTicket !== logsModalFetchGen || backdrop.hidden) return;
      if (logsModalPodName !== podName || backdrop.hidden) return;
      sel.innerHTML = "";
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "Error";
      sel.appendChild(o);
      err.textContent = String(e.message || e);
      err.hidden = false;
      logsModalHasStreamableContainers = false;
      syncLogsFormDisabled();
    });
}

function openDeleteConfirmModal(podName) {
  const backdrop = document.getElementById("modal-delete-backdrop");
  const nEl = document.getElementById("delete-pod-name");
  const nsEl = document.getElementById("delete-pod-ns");
  if (!backdrop || !nEl || !nsEl) return;
  nEl.textContent = podName;
  nsEl.textContent = currentNamespace;
  backdrop.dataset.pod = podName;
  backdrop.hidden = false;
}

async function confirmDeletePod() {
  const backdrop = document.getElementById("modal-delete-backdrop");
  const podName = backdrop?.dataset?.pod;
  if (!podName) return;

  closeModalById("modal-delete-backdrop");

  const status = document.getElementById("status");
  if (status) {
    status.classList.remove("err");
    status.classList.add("ok");
    status.textContent = "Pod delete request sent";
  }

  const q = new URLSearchParams({ namespace: currentNamespace, pod: podName });
  try {
    const r = await fetch(`/api/pod?${q}`, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    if (status) {
      status.textContent = `Deleted pod ${podName}. Refreshing…`;
    }
    await redraw();
    await refreshHealth();
  } catch (e) {
    if (status) {
      status.classList.remove("ok");
      status.classList.add("err");
      status.textContent = String(e.message || e);
    }
  }
}

function wirePodKubectlUi() {
  const tbody = document.getElementById("pod-table-body");
  const menu = document.getElementById("pod-action-menu");

  tbody?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr.pod-row-interactive");
    if (!tr || !tr.dataset.podName) return;
    e.stopPropagation();
    showPodActionMenu(e.clientX, e.clientY, tr.dataset.podName);
  });

  tbody?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr.pod-row-interactive");
    if (!tr || !tr.dataset.podName) return;
    e.preventDefault();
    const r = tr.getBoundingClientRect();
    showPodActionMenu(r.left + 8, r.bottom + 4, tr.dataset.podName);
  });

  menu?.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = e.target.closest("[data-action]");
    if (!btn || !menu.dataset.pod) return;
    const action = btn.dataset.action;
    const pod = menu.dataset.pod;
    hidePodActionMenu();
    if (action === "describe") openDescribeModal(pod);
    else if (action === "logs") openLogsModal(pod);
    else if (action === "delete") openDeleteConfirmModal(pod);
  });

  document.addEventListener("click", () => hidePodActionMenu());

  document.querySelectorAll("[data-modal-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.getAttribute("data-modal-close");
      if (which === "describe") closeModalById("modal-describe-backdrop");
      if (which === "logs") closeLogsModal();
    });
  });

  document.getElementById("logs-stop-btn")?.addEventListener("click", () => {
    stopPodLogs();
  });

  document.getElementById("logs-all-containers")?.addEventListener("change", () => {
    syncLogsFormDisabled();
  });

  document.getElementById("logs-container-select")?.addEventListener("change", () => {
    syncLogsFormDisabled();
  });

  document.getElementById("logs-start-btn")?.addEventListener("click", () => {
    startPodLogStreamFromForm();
  });

  document.getElementById("modal-describe-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-describe-backdrop") closeModalById("modal-describe-backdrop");
  });
  document.getElementById("modal-logs-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-logs-backdrop") {
      closeLogsModal();
    }
  });
  document.getElementById("modal-delete-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-delete-backdrop") closeModalById("modal-delete-backdrop");
  });

  document.getElementById("delete-no-btn")?.addEventListener("click", () => closeModalById("modal-delete-backdrop"));
  document.getElementById("delete-yes-btn")?.addEventListener("click", () => confirmDeletePod());

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    hidePodActionMenu();
    if (!document.getElementById("modal-logs-backdrop")?.hidden) {
      closeLogsModal();
    }
    closeModalById("modal-describe-backdrop");
    closeModalById("modal-delete-backdrop");
  });
}

/** @type {string} */
let servicesOutputForCopy = "";

function renderKubectlSnapshotOutput(preId, metaId, output, updatedAt) {
  const pre = document.getElementById(preId);
  const meta = metaId ? document.getElementById(metaId) : null;
  if (!pre) return "";

  if (meta) {
    if (updatedAt) meta.textContent = `Last updated: ${new Date(updatedAt).toLocaleString()}`;
    else meta.textContent = "";
  }

  if (updatedAt == null) {
    const msg =
      "No snapshot for this namespace yet. Apply the namespace above and wait for the next poll.";
    pre.textContent = msg;
    return "";
  }

  const text = typeof output === "string" ? output.trimEnd() : "";
  const display = text || "(empty)";
  pre.textContent = display;
  return text;
}

function renderSecretsOutput(output, updatedAt) {
  renderKubectlSnapshotOutput("secrets-output", "secrets-meta", output, updatedAt);
}

function renderServicesOutput(output, updatedAt) {
  servicesOutputForCopy = renderKubectlSnapshotOutput(
    "services-output",
    "services-meta",
    output,
    updatedAt
  );
}

function renderPodTable(pods, updatedAt) {
  hidePodActionMenu();
  const tbody = document.getElementById("pod-table-body");
  const meta = document.getElementById("pod-table-meta");
  if (!tbody) return;

  if (meta) {
    if (updatedAt) meta.textContent = `Last updated: ${new Date(updatedAt).toLocaleString()}`;
    else meta.textContent = "";
  }

  tbody.replaceChildren();

  if (updatedAt == null) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted";
    td.textContent =
      "No snapshot for this namespace yet. Apply the namespace above and wait for the next poll.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  if (!pods.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "muted";
    td.textContent = "No pods in this namespace.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const p of pods) {
    const tr = document.createElement("tr");
    tr.className = "pod-row-interactive";
    tr.dataset.podName = p.name ?? "";
    tr.setAttribute("tabindex", "0");
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-haspopup", "menu");
    tr.setAttribute("aria-label", `Pod ${p.name ?? ""}, open actions menu`);
    const name = document.createElement("td");
    name.className = "pod-name";
    name.textContent = p.name ?? "";
    const phase = document.createElement("td");
    phase.textContent = p.phase ?? "";
    const ready = document.createElement("td");
    ready.textContent = p.ready ?? "";
    const status = document.createElement("td");
    status.className = "pod-status";
    status.textContent = p.status ?? "";
    const restarts = document.createElement("td");
    restarts.className = "num";
    restarts.textContent = String(p.restarts ?? "");
    tr.append(name, phase, ready, status, restarts);
    tbody.appendChild(tr);
  }
}

async function redraw() {
  const data = await loadSeries();
  const nodes = data.nodes || {};
  const { labels, cpu: nCpu, mem: nMem } = nodes;
  const { cpu: pCpu, mem: pMem } = data.pods;
  const gp = data.getPods || { labels: [], datasets: [] };

  chartNodesCpu = ensureNodeChart(
    document.getElementById("chart-nodes-cpu"),
    chartNodesCpu,
    labels,
    nCpu || [],
    "CPU (millicores)"
  );
  chartNodesMem = ensureNodeChart(
    document.getElementById("chart-nodes-mem"),
    chartNodesMem,
    labels,
    nMem || [],
    "Memory (MiB)"
  );
  chartPodsCpu = ensureChart(document.getElementById("chart-pods-cpu"), chartPodsCpu, labels, pCpu);
  chartPodsMem = ensureChart(document.getElementById("chart-pods-mem"), chartPodsMem, labels, pMem);
  chartGetPods = ensureGetPodsChart(
    document.getElementById("chart-get-pods"),
    chartGetPods,
    gp.labels,
    gp.datasets
  );
  renderSecretsOutput(data.secretsOutput ?? "", data.secretsUpdatedAt ?? null);
  renderServicesOutput(data.servicesOutput ?? "", data.servicesUpdatedAt ?? null);
  renderPodTable(data.podList || [], data.podListUpdatedAt ?? null);
}

function wireRange() {
  document.getElementById("range-group").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    currentRange = btn.dataset.range;
    document.querySelectorAll("#range-group button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    redraw().catch((err) => console.error(err));
  });
}

function wireForm() {
  const form = document.getElementById("ns-form");
  const sel = document.getElementById("namespace");
  sel?.addEventListener("change", () => {
    if (sel) sel.dataset.touched = "1";
  });
  sel?.addEventListener("focus", () => {
    loadNamespaces().catch(() => {});
  });
  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const ns = sel?.value?.trim();
    if (!ns) return;
    try {
      await applyNamespace(ns);
      currentNamespace = ns;
      if (sel) sel.dataset.touched = "";
      await redraw();
      await refreshHealth();
    } catch (e) {
      const el = document.getElementById("status");
      el.classList.add("err");
      el.textContent = String(e.message || e);
    }
  });
}

/** After moving a panel with canvases, Chart.js needs resize + legend refresh (zoom vs compact labels). */
function refreshChartsInPanel(panel) {
  if (typeof Chart === "undefined") return;
  for (const canvas of panel.querySelectorAll("canvas")) {
    const inst = Chart.getChart(canvas);
    if (!inst) continue;
    requestAnimationFrame(() => {
      inst.resize();
      inst.update("none");
    });
  }
}

/** @type {{ card: Element; body: HTMLElement } | null} */
let chartZoomState = null;

function openChartZoom(card) {
  if (chartZoomState) return;
  const body = card.querySelector(".panel-body");
  if (!body) return;

  const backdrop = document.getElementById("chart-zoom-backdrop");
  const slot = document.getElementById("chart-zoom-slot");
  const titleEl = document.getElementById("chart-zoom-title");
  const h = card.querySelector(".panel-head h2");
  titleEl.textContent = h?.textContent?.trim() || "Panel";

  chartZoomState = { card, body };
  slot.appendChild(body);
  backdrop.hidden = false;
  document.body.classList.add("chart-zoom-active");
  document.getElementById("chart-zoom-close")?.focus({ preventScroll: true });

  requestAnimationFrame(() => refreshChartsInPanel(body));
}

function closeChartZoom() {
  if (!chartZoomState) return;
  const { card, body } = chartZoomState;
  card.appendChild(body);

  const backdrop = document.getElementById("chart-zoom-backdrop");
  backdrop.hidden = true;
  document.body.classList.remove("chart-zoom-active");
  chartZoomState = null;

  requestAnimationFrame(() => refreshChartsInPanel(body));
}

function wireServicesCopy() {
  const btn = document.getElementById("services-copy-btn");
  const pre = document.getElementById("services-output");
  if (!btn || !pre) return;

  btn.addEventListener("click", async () => {
    const text = servicesOutputForCopy || pre.textContent || "";
    if (!text || text.startsWith("No snapshot")) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1500);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });
}

function wireChartZoom() {
  const main = document.querySelector("main.grid");
  const backdrop = document.getElementById("chart-zoom-backdrop");
  const closeBtn = document.getElementById("chart-zoom-close");

  main?.addEventListener("click", (e) => {
    const btn = e.target.closest(".panel-enlarge");
    if (!btn) return;
    const card = btn.closest(".zoomable-card");
    if (card) openChartZoom(card);
  });

  closeBtn?.addEventListener("click", () => closeChartZoom());

  backdrop?.addEventListener("click", (e) => {
    if (e.target === backdrop) closeChartZoom();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && chartZoomState) {
      e.preventDefault();
      closeChartZoom();
    }
  });
}

async function boot() {
  wireRange();
  wireForm();
  wireChartZoom();
  wireServicesCopy();
  wirePodKubectlUi();
  try {
    await loadNamespaces();
  } catch (e) {
    const sel = document.getElementById("namespace");
    if (sel) {
      sel.replaceChildren();
      const o = document.createElement("option");
      o.value = currentNamespace;
      o.textContent = `${currentNamespace} (list unavailable)`;
      sel.appendChild(o);
    }
    console.error("loadNamespaces:", e);
  }
  await refreshHealth();
  try {
    await redraw();
  } catch (e) {
    const el = document.getElementById("status");
    el.classList.add("err");
    el.textContent = String(e.message || e);
  }
  setInterval(() => {
    refreshHealth().catch(() => {});
    redraw().catch(() => {});
  }, 5000);
  setInterval(() => {
    loadNamespaces().catch(() => {});
  }, 60000);
}

boot();
