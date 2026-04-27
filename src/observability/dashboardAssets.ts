export const renderDashboardHtml = (input: {
  apiPath: string;
  refreshSeconds: number;
}): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Developer Worker</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #1c2633;
      --muted: #697386;
      --line: #d9dee7;
      --ok: #0b7a53;
      --warn: #996700;
      --err: #b42318;
      --info: #225ea8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 18px; font-weight: 650; }
    main {
      display: grid;
      gap: 16px;
      padding: 16px;
      max-width: 1400px;
      margin: 0 auto;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 14px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfe;
    }
    .strip {
      display: grid;
      grid-template-columns: repeat(5, minmax(140px, 1fr));
      gap: 10px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
      min-height: 72px;
    }
    .metric strong { display: block; font-size: 24px; line-height: 1.1; }
    .metric span, .muted { color: var(--muted); font-size: 12px; }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      white-space: nowrap;
      background: #fbfcfe;
    }
    tr:last-child td { border-bottom: 0; }
    a { color: var(--info); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--line);
      background: #fff;
    }
    .ok { color: var(--ok); }
    .warning { color: var(--warn); }
    .error { color: var(--err); }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(360px, 0.8fr);
      gap: 16px;
    }
    .table-wrap { overflow-x: auto; }
    .empty { padding: 18px 14px; color: var(--muted); }
    #status { color: var(--muted); font-size: 12px; }
    @media (max-width: 900px) {
      .strip, .grid { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <h1>AI Developer Worker</h1>
    <div id="status">Loading</div>
  </header>
  <main>
    <div class="strip">
      <div class="metric"><span>Ready workers</span><strong id="readyWorkers">0</strong></div>
      <div class="metric"><span>Active tasks</span><strong id="activeTasks">0</strong></div>
      <div class="metric"><span>Failed tasks 24h</span><strong id="failedTasks">0</strong></div>
      <div class="metric"><span>Success rate</span><strong id="successRate">100%</strong></div>
      <div class="metric"><span>Total queue depth</span><strong id="queueDepth">0</strong></div>
    </div>
    <section>
      <h2>Workers</h2>
      <div class="table-wrap"><table id="workers"></table></div>
    </section>
    <section>
      <h2>Repositories</h2>
      <div class="table-wrap"><table id="repositories"></table></div>
    </section>
    <div class="grid">
      <section>
        <h2>Recent Tasks</h2>
        <div class="table-wrap"><table id="tasks"></table></div>
      </section>
      <section>
        <h2>Failures</h2>
        <div class="table-wrap"><table id="failures"></table></div>
      </section>
    </div>
  </main>
  <script>
    const apiPath = ${JSON.stringify(input.apiPath)};
    const refreshMs = ${input.refreshSeconds * 1000};
    const text = (value) => value === undefined || value === null || value === "" ? "-" : String(value);
    const age = (timestamp) => {
      const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
      if (seconds < 60) return seconds + "s";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + "m";
      return Math.floor(minutes / 60) + "h";
    };
    const escapeHtml = (value) => text(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);
    const link = (url, label) => url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + '</a>' : "-";
    const renderTable = (id, headers, rows, empty) => {
      const target = document.getElementById(id);
      if (!rows.length) {
        target.innerHTML = '<tbody><tr><td class="empty">' + escapeHtml(empty) + '</td></tr></tbody>';
        return;
      }
      target.innerHTML = '<thead><tr>' + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join("") + '</tr></thead><tbody>' + rows.join("") + '</tbody>';
    };
    const getJson = async (path) => {
      const response = await fetch(apiPath + path, { cache: "no-store" });
      if (!response.ok) throw new Error(path + " returned HTTP " + response.status);
      return response.json();
    };
    const refresh = async () => {
      const [workers, repositories, tasks, failures, summary] = await Promise.all([
        getJson("/workers"),
        getJson("/repositories"),
        getJson("/tasks/recent?limit=50"),
        getJson("/failures/recent?limit=25"),
        getJson("/metrics/summary")
      ]);
      document.getElementById("readyWorkers").textContent = workers.workers.filter((worker) => worker.state !== "starting" && worker.state !== "error").length;
      document.getElementById("activeTasks").textContent = summary.totals.activeTasks;
      document.getElementById("failedTasks").textContent = summary.totals.failedTasks24h;
      document.getElementById("successRate").textContent = summary.totals.successRatePercent + "%";
      document.getElementById("queueDepth").textContent = summary.repositories.flatMap((repo) => repo.queues).reduce((sum, queue) => sum + queue.depth, 0);
      document.getElementById("status").textContent = "Updated " + new Date(summary.generatedAt).toLocaleTimeString();
      renderTable("workers", ["State", "Worker", "Repository", "Issue", "Stage", "Heartbeat", "Last error"], workers.workers.map((worker) =>
        '<tr><td><span class="pill ' + escapeHtml(worker.state === "error" ? "error" : worker.state === "waiting" ? "warning" : "ok") + '">' + escapeHtml(worker.state) + '</span></td><td>' + escapeHtml(worker.workerId) + '</td><td>' + escapeHtml(worker.repositoryName) + '</td><td>' + escapeHtml(worker.currentIssueKey) + '</td><td>' + escapeHtml(worker.currentStage) + '</td><td>' + age(worker.lastHeartbeatAt) + '</td><td>' + escapeHtml(worker.lastErrorSummary) + '</td></tr>'
      ), "No worker snapshots yet.");
      renderTable("repositories", ["Repository", "Queue depth", "Active", "Completed 24h", "Failures 24h", "Success", "Avg duration"], repositories.repositories.map((repo) =>
        '<tr><td>' + escapeHtml(repo.repositoryName) + '</td><td>' + escapeHtml(repo.queues.map((queue) => queue.queue + ":" + queue.depth).join(", ")) + '</td><td>' + repo.activeTaskCount + '</td><td>' + repo.tasksCompleted24h + '</td><td class="' + (repo.failures24h ? "error" : "") + '">' + repo.failures24h + '</td><td>' + repo.successRatePercent + '%</td><td>' + escapeHtml(repo.averageTaskDurationSeconds ? repo.averageTaskDurationSeconds + "s" : "-") + '</td></tr>'
      ), "No repository activity yet.");
      renderTable("tasks", ["Time", "Repository", "Issue", "Stage", "Status", "MR", "Message"], tasks.tasks.map((task) =>
        '<tr><td>' + new Date(task.timestamp).toLocaleTimeString() + '</td><td>' + escapeHtml(task.repositoryName) + '</td><td>' + escapeHtml(task.issueKey) + '</td><td>' + escapeHtml(task.stage) + '</td><td class="' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</td><td>' + link(task.mergeRequestUrl, task.mergeRequestIid ? "!" + task.mergeRequestIid : "MR") + '</td><td>' + escapeHtml(task.message) + '</td></tr>'
      ), "No recent tasks.");
      renderTable("failures", ["Time", "Repository", "Issue", "Message"], failures.failures.map((failure) =>
        '<tr><td>' + new Date(failure.timestamp).toLocaleTimeString() + '</td><td>' + escapeHtml(failure.repositoryName) + '</td><td>' + escapeHtml(failure.issueKey) + '</td><td class="error">' + escapeHtml(failure.message) + '</td></tr>'
      ), "No recent failures.");
    };
    refresh().catch((error) => {
      document.getElementById("status").textContent = "Dashboard data unavailable: " + error.message;
    });
    setInterval(() => refresh().catch((error) => {
      document.getElementById("status").textContent = "Stale data: " + error.message;
    }), refreshMs);
  </script>
</body>
</html>`;
