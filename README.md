# GKE kubectl top — live charts

A lightweight web dashboard for **Google Kubernetes Engine (GKE)** and any cluster reachable via `kubectl`. It polls the API server on a schedule, keeps recent samples **in memory**, and renders live **CPU / memory** charts plus namespace-scoped **kubectl** views—without installing Prometheus or a metrics stack beyond what you already use for `kubectl top`.

**Repository:** [mohsinali-bangalore/GKE-kubectl_top-live_charts](https://github.com/mohsinali-bangalore/GKE-kubectl_top-live_charts)

---

## What it does

| Area | Data source | UI |
|------|-------------|-----|
| **Nodes** | `kubectl top nodes` (+ allocatable % from `kubectl get nodes` when `%` columns are missing) | CPU & memory line charts |
| **Pods** | `kubectl top pods -n <ns>` | CPU & memory line charts |
| **Pod health** | `kubectl get pods -n <ns> -o json` | Phase stacked chart + total restarts; sortable table |
| **Secrets** | `kubectl get secrets -n <ns>` | Side panel (next to phase chart) |
| **Services** | `kubectl get svc -n <ns>` | Copyable table above pod list |
| **Namespaces** | `kubectl get namespaces` | Dropdown selector |
| **Pod actions** | `kubectl describe`, `logs`, `delete` | Row menu (describe / logs / delete) |

Charts use [Chart.js](https://www.chartjs.org/) (loaded from CDN). History exists **only while the Node.js server is running**—restarts clear in-memory series.

---

## Prerequisites

1. **Node.js** 18 or newer  
2. **`kubectl`** installed and on your `PATH`  
3. A valid **kubeconfig** pointing at your cluster (same context you use for day-to-day work)  
4. **Metrics Server** (or equivalent) so these commands work:

   ```bash
   kubectl top nodes
   kubectl top pods -n <namespace>
   ```

5. **RBAC**: your user/service account needs read access for top/get/describe/logs, and **delete** if you use “Delete pod” in the UI.

Verify locally:

```bash
kubectl cluster-info
kubectl top nodes
kubectl get namespaces
```

---

## Quick start

```bash
git clone https://github.com/mohsinali-bangalore/GKE-kubectl_top-live_charts.git
cd GKE-kubectl_top-live_charts

npm install
npm start
```

Open **http://127.0.0.1:3847** (default port).

Development with auto-restart on file changes:

```bash
npm run dev
```

---

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3847` | HTTP listen port |
| `POLL_MS` | `15000` | Interval between background `kubectl` polls (ms) |
| `MAX_SAMPLES` | `2000` | Max time-series points kept per series in memory |
| `DEFAULT_NAMESPACE` | `default` | Namespace used until you pick another in the UI |
| `KUBECTL_LOGS_MAX_REQUESTS_ALL` | `64` | When streaming **all** container logs, passed to `kubectl logs --max-log-requests` (valid range: 6–256) |

Example:

```bash
export DEFAULT_NAMESPACE=my-app
export POLL_MS=10000
export PORT=8080
npm start
```

The server uses your current **`KUBECONFIG`** / default context—the same as running `kubectl` in your shell.

---

## Using the dashboard

### Namespace

1. Open the **Namespace** dropdown (populated from `kubectl get namespaces`).
2. Choose a namespace and click **Apply**.
3. Pod charts, phase chart, secrets, services, and the pod table switch to that namespace.

The list refreshes when you focus the dropdown and every 60 seconds.

### Time range

Use **5m / 15m / 30m / 1h / 4h** to control the chart window. Legends for node/pod CPU and memory are ordered by **highest latest value** in that window.

### Charts

- **Nodes — CPU / memory**: One line per node. Tooltips show millicores or MiB and **% of allocatable** when available.
- **Pods — CPU / memory**: Top pods in the namespace (by latest usage in the window).
- **Pods — phase counts**: Stacked phases plus a **total restarts** line on a secondary axis.

Click the **expand** icon on any panel for a larger view. Node chart legends show **truncated** names in the grid and **full** names when expanded.

### Secrets & services

- **Secrets**: Raw output of `kubectl get secrets -n <ns>` beside the phase chart.
- **Services**: Full-width, **selectable** text (drag to copy) plus **Copy all** for the whole block.

### Pod table actions

Click a pod row to open the menu:

| Action | Command | Notes |
|--------|---------|--------|
| **Describe pod** | `kubectl describe pod` | Modal with full describe output |
| **View logs** | `kubectl logs -f` | Pick a container, or **All containers**; click **Stream logs** |
| **Delete pod** | `kubectl delete pod` | Confirmation (**YES** / **NO**); shows “Pod delete request sent” and closes the dialog |

For logs:

- Choose one container from the dropdown (grouped: main / init / ephemeral), or check **All containers**.
- Large pods (e.g. JFrog) may need a higher `KUBECTL_LOGS_MAX_REQUESTS_ALL` when following all containers.

### Status bar

The header shows poll health, last sample age, active namespace, and poll interval. Errors from `kubectl` appear here and in the browser console.

---

## Architecture

```
Browser (Chart.js + vanilla JS)
    │  HTTP / SSE
    ▼
Express (server.js)
    │  spawn("kubectl", …)
    ▼
Kubernetes API (via your kubeconfig)
```

- **Polling loop** (`POLL_MS`): `top nodes`, `top pods`, `get pods`, `get secrets`, `get svc` for the active namespace.
- **On demand**: describe, delete, container list, log stream (SSE).
- **Storage**: in-process arrays/maps only—no database.

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Poll status, active namespace |
| `GET` | `/api/namespaces` | List namespace names |
| `POST` | `/api/namespace` | Set active namespace (`{ "namespace": "…" }`) |
| `GET` | `/api/series?namespace=&range=&top=` | Chart series + pod table + secrets/services snapshots |
| `GET` | `/api/pod/describe?namespace=&pod=` | Describe output |
| `DELETE` | `/api/pod?namespace=&pod=` | Delete pod |
| `GET` | `/api/pod/containers?namespace=&pod=` | Container names for log picker |
| `GET` | `/api/pod/logs?namespace=&pod=&container=` or `&all=1` | SSE log stream |

Static assets are served from `public/`.

---

## Project layout

```
.
├── server.js          # Express API + kubectl polling
├── package.json
├── public/
│   ├── index.html     # Dashboard markup
│   ├── app.js         # Charts, modals, API client
│   └── styles.css     # Dark theme UI
└── README.md
```

---

## Security considerations

> **This tool runs `kubectl` with the permissions of whoever started the server.** Anyone who can reach the web UI can trigger the same operations (including **pod delete** and **log stream**) as that identity.

- Run on **localhost** or bind behind a VPN / SSO reverse proxy for team use.
- Do **not** expose port `3847` to the public internet without authentication.
- Treat the UI like direct `kubectl` access from a shared workstation.

---

## Troubleshooting

| Problem | What to check |
|---------|----------------|
| `Poll error` / empty charts | `kubectl top nodes` and `metrics-server` in `kube-system` |
| Namespace dropdown empty | `kubectl get namespaces` and RBAC `list namespaces` |
| No pod rows | Wrong namespace; wait for next poll after **Apply** |
| `kubectl top` without `%` columns | Normal in non-TTY; server computes % from `kubectl get nodes` allocatable |
| Log stream: “maximum allowed concurrency is 5” | Use single container or raise `KUBECTL_LOGS_MAX_REQUESTS_ALL` for **All containers** |
| Charts empty after restart | Expected—history is in-memory only |
| Wrong cluster | `kubectl config current-context` before starting the server |

---

## Development

```bash
npm run dev    # node --watch server.js
```

Frontend dependencies: **Chart.js 4** via jsDelivr CDN (no bundler). Backend: **Express 4** only.

To change default top-N pods/nodes per chart, the server uses query `top` on `/api/series` (default **12**, max **20**); the UI currently sends `top=12`.

---

## License

This project is provided as-is for learning and operations use. Add a `LICENSE` file in the repository if you need a specific open-source license.

---

## Author / maintenance

Maintained under [mohsinali-bangalore](https://github.com/mohsinali-bangalore). Issues and pull requests welcome on the GitHub repository.
