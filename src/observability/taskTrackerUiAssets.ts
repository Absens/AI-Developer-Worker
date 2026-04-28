export const renderTaskTrackerUiHtml = (input: { apiPath: string }): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Internal Task Tracker</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f8;
      --panel: #ffffff;
      --ink: #1f2933;
      --muted: #697386;
      --line: #d8dee8;
      --accent: #1b6ca8;
      --ok: #0b7a53;
      --warn: #9a6700;
      --err: #b42318;
      --hold: #5f4b8b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    h1 { margin: 0; font-size: 18px; font-weight: 650; }
    main {
      display: grid;
      grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
      gap: 14px;
      padding: 14px;
      max-width: 1500px;
      margin: 0 auto;
    }
    section, aside {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    h2 {
      margin: 0;
      padding: 11px 12px;
      font-size: 13px;
      background: #fafbfc;
      border-bottom: 1px solid var(--line);
    }
    .body { padding: 12px; }
    .tabs, .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .tabs {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #fafbfc;
    }
    button, select, input, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      min-height: 34px;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button.danger {
      border-color: var(--err);
      color: var(--err);
    }
    button.active {
      border-color: var(--accent);
      color: var(--accent);
      background: #eef6fb;
    }
    label {
      display: grid;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 9px;
      color: var(--ink);
      background: #fff;
    }
    textarea { min-height: 88px; resize: vertical; }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      padding: 8px 9px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      background: #fafbfc;
    }
    tr:last-child td { border-bottom: 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .stack { display: grid; gap: 10px; }
    .queue-group { display: grid; gap: 8px; }
    .task-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      cursor: pointer;
    }
    .task-row.active { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
    .title { font-weight: 650; overflow-wrap: anywhere; }
    .muted { color: var(--muted); font-size: 12px; }
    .pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 22px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 12px;
      background: #fff;
      white-space: nowrap;
    }
    .ready { color: var(--ok); }
    .awaiting_human, .review, .blocked { color: var(--warn); }
    .failed, .cancelled { color: var(--err); }
    .claimed, .analyzing, .implementing, .validating { color: var(--accent); }
    .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .hidden { display: none; }
    .empty { color: var(--muted); padding: 10px; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
      max-height: 360px;
      overflow: auto;
    }
    @media (max-width: 980px) {
      main, .grid { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Internal Task Tracker</h1>
    <div class="toolbar">
      <span class="muted" id="status">Loading</span>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="tabs">
        <button class="active" data-tab="queue">Queue</button>
        <button data-tab="proposals">Proposals</button>
        <button data-tab="create">Create</button>
        <button data-tab="ops">Operations</button>
      </div>
      <div id="queueTab" class="body stack">
        <div class="grid">
          <label>Repository<input id="filterRepo" placeholder="all"></label>
          <label>Queue<input id="filterQueue" placeholder="all"></label>
          <label>Status<select id="filterStatus"><option value="">all</option><option>ready</option><option>awaiting_human</option><option>review</option><option>failed</option><option>blocked</option></select></label>
          <label>Tag<input id="filterTag" placeholder="all"></label>
        </div>
        <div id="queue"></div>
      </div>
      <div id="proposalsTab" class="body stack hidden">
        <div id="proposals"></div>
      </div>
      <div id="createTab" class="body stack hidden">
        <div class="grid">
          <label>Template<select id="template"><option value="backend_endpoint">Backend endpoint</option><option value="frontend_ui_fix">Frontend UI fix</option><option value="tests_only">Tests only</option><option value="refactor">Refactor</option><option value="dependency_update">Dependency update</option><option value="documentation">Documentation</option></select></label>
          <label>Priority<select id="priority"><option>normal</option><option>high</option><option>critical</option><option>low</option></select></label>
          <label>Repository<input id="repositoryName"></label>
          <label>Queue<input id="queueName"></label>
          <label>Repo path key<input id="repoPathKey"></label>
          <label>Base branch<input id="baseBranch" value="main"></label>
        </div>
        <label>Title<input id="title"></label>
        <label>Description<textarea id="description"></textarea></label>
        <label>Acceptance criteria<textarea id="criteria"></textarea></label>
        <div class="toolbar">
          <button id="saveDraft">Save Draft</button>
          <button class="primary" id="createReady">Create Ready</button>
          <button id="previewDraft">Preview Context</button>
        </div>
        <pre id="draftPreview" class="hidden"></pre>
      </div>
      <div id="opsTab" class="body stack hidden">
        <div id="operations"></div>
      </div>
    </aside>
    <section>
      <h2 id="detailTitle">Task Detail</h2>
      <div class="body stack" id="detail"><div class="empty">No task selected.</div></div>
    </section>
  </main>
  <script>
    const apiPath = ${JSON.stringify(input.apiPath)};
    const groups = ["ready", "awaiting_human", "review", "failed", "blocked"];
    let tasks = [];
    let proposals = [];
    let selectedId = "";
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const lines = (value) => String(value || "").split("\\n").map((line) => line.trim()).filter(Boolean);
    const getJson = async (path, options = {}) => {
      const response = await fetch(apiPath + path, { cache: "no-store", ...options });
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(body.error || path + " returned HTTP " + response.status);
      return body;
    };
    const postJson = (path, body) => getJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const query = () => {
      const params = new URLSearchParams();
      if ($("filterRepo").value.trim()) params.set("repository", $("filterRepo").value.trim());
      if ($("filterQueue").value.trim()) params.set("queue", $("filterQueue").value.trim());
      if ($("filterStatus").value) params.set("status", $("filterStatus").value);
      if ($("filterTag").value.trim()) params.set("tag", $("filterTag").value.trim());
      params.set("limit", "200");
      return "?" + params.toString();
    };
    const renderQueue = () => {
      $("queue").innerHTML = groups.map((status) => {
        const rows = tasks.filter((task) => task.status === status);
        return '<div class="queue-group"><h2>' + esc(status) + ' <span class="muted">' + rows.length + '</span></h2>' + (rows.length ? rows.map((task) =>
          '<div class="task-row ' + (task.id === selectedId ? "active" : "") + '" data-task="' + esc(task.id) + '"><div><div class="title">' + esc(task.title) + '</div><div class="muted">' + esc([task.repositoryName, task.queue, task.priority].filter(Boolean).join(" / ")) + '</div><div class="muted">' + esc(task.blockerReason || task.latestValidationSummary || task.latestAiSummary || "") + '</div></div><span class="pill ' + esc(task.status) + '">' + esc(task.status) + '</span></div>'
        ).join("") : '<div class="empty">None</div>') + '</div>';
      }).join("");
      document.querySelectorAll("[data-task]").forEach((node) => node.onclick = () => selectTask(node.dataset.task));
    };
    const renderOperations = async () => {
      const ops = await getJson("/operations");
      $("operations").innerHTML = '<div class="stack"><div><strong>Workers</strong><div class="muted">' + esc(ops.workers.map((worker) => worker.workerId + ":" + worker.state).join(", ") || "none") + '</div></div><div><strong>Active leases</strong><div class="muted">' + esc(ops.leases.map((lease) => lease.workerId + " -> " + lease.taskId).join(", ") || "none") + '</div></div><div><strong>Queue depth</strong><pre>' + esc(JSON.stringify(ops.queueDepth, null, 2)) + '</pre></div><div><strong>Repeated failures</strong><pre>' + esc(JSON.stringify(ops.repeatedFailures, null, 2)) + '</pre></div></div>';
    };
    const renderProposals = () => {
      $("proposals").innerHTML = proposals.length ? proposals.map((task) =>
        '<div class="task-row ' + (task.id === selectedId ? "active" : "") + '" data-task="' + esc(task.id) + '"><div><div class="title">' + esc(task.title) + '</div><div class="muted">' + esc([task.repositoryName, task.proposal && task.proposal.autonomyLevel, task.proposal && task.proposal.policyDecision].filter(Boolean).join(" / ")) + '</div><div class="muted">' + esc(task.proposal ? task.proposal.policyReason : "") + '</div></div><span class="pill ' + esc(task.proposal ? task.proposal.supervisorStatus : task.status) + '">' + esc(task.proposal ? task.proposal.supervisorStatus : task.status) + '</span></div>'
      ).join("") : '<div class="empty">None</div>';
      document.querySelectorAll("[data-task]").forEach((node) => node.onclick = () => selectTask(node.dataset.task));
    };
    const renderDetail = (data) => {
      const task = data.task;
      const q = [...task.clarificationQuestions].reverse().find((item) => item.status === "open");
      const validation = data.latestValidation;
      const mr = data.latestMergeRequest;
      $("detailTitle").textContent = task.title;
      $("detail").innerHTML = '<div class="toolbar"><span class="pill ' + esc(task.status) + '">' + esc(task.status) + '</span><button id="previewContext">Context</button><button data-cmd="mark-ready">Ready</button><button data-cmd="resume">Resume</button><button data-cmd="hold">Hold</button><button data-cmd="retry">Retry</button><button data-cmd="force-reanalysis">Reanalyze</button><button class="danger" data-cmd="cancel">Cancel</button></div><pre id="contextPreview" class="hidden"></pre>' +
        '<div class="grid"><div><strong>Goal</strong><p>' + esc(task.description) + '</p></div><div><strong>MR</strong><p>' + (mr ? '<a href="' + esc(mr.mergeRequest.url) + '" target="_blank" rel="noreferrer">' + esc(mr.mergeRequest.url) + '</a><br><span class="muted">' + esc(mr.branch) + '</span>' : '<span class="muted">None</span>') + '</p></div></div>' +
        (task.proposal ? '<div><strong>Proposal</strong><pre>' + esc(JSON.stringify(task.proposal, null, 2)) + '</pre><div class="toolbar"><button class="primary" data-cmd="approve-proposal">Approve</button><button class="danger" data-cmd="reject-proposal">Reject</button></div></div>' : '') +
        '<div><strong>Acceptance criteria</strong><ul>' + task.acceptanceCriteria.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul></div>' +
        '<div><strong>Validation</strong><pre>' + esc(validation ? JSON.stringify(validation, null, 2) : "None") + '</pre></div>' +
        (q ? '<div><strong>Question</strong><p>' + esc(q.question.question) + '</p><label>Answer<textarea id="answerBody"></textarea></label><div class="toolbar"><button class="primary" id="answer">Answer</button><button id="answerResume">Answer + Resume</button></div></div>' : "") +
        '<div><strong>Decomposition</strong>' + (data.children.length ? '<table><thead><tr><th>Child</th><th>Status</th><th>Mirror</th><th></th></tr></thead><tbody>' + data.children.map((child) => '<tr><td>' + esc(child.title) + '<div class="muted">' + esc(child.dependencyReason) + '</div></td><td>' + esc(child.status) + '</td><td>' + esc(child.externalMirrorStatus) + '</td><td><button data-cmd="approve-decomposition">Approve</button></td></tr>').join("") + '</tbody></table>' : '<div class="empty">None</div>') + '</div>' +
        '<div><strong>Timeline</strong><table><tbody>' + task.events.slice(-15).reverse().map((event) => '<tr><td class="muted">' + esc(new Date(event.createdAt).toLocaleString()) + '</td><td>' + esc(event.kind) + '</td><td>' + esc(event.message || "") + '</td></tr>').join("") + '</tbody></table></div>';
      document.querySelectorAll("[data-cmd]").forEach((node) => node.onclick = async () => {
        await postJson("/tasks/" + encodeURIComponent(task.id) + "/commands/" + node.dataset.cmd, { reason: "UI action" });
        await selectTask(task.id);
        await refresh();
      });
      $("previewContext").onclick = async () => {
        const preview = await getJson("/tasks/" + encodeURIComponent(task.id) + "/agent-context-preview");
        $("contextPreview").classList.remove("hidden");
        $("contextPreview").textContent = JSON.stringify(preview.agentContext, null, 2);
      };
      if ($("answer")) $("answer").onclick = async () => {
        await postJson("/tasks/" + encodeURIComponent(task.id) + "/answers", { questionId: q.id, body: $("answerBody").value });
        await selectTask(task.id);
        await refresh();
      };
      if ($("answerResume")) $("answerResume").onclick = async () => {
        await postJson("/tasks/" + encodeURIComponent(task.id) + "/answers", { questionId: q.id, body: $("answerBody").value, command: { type: "resume", rawText: "/resume" } });
        await postJson("/tasks/" + encodeURIComponent(task.id) + "/commands/resume", { reason: "Answer supplied" });
        await selectTask(task.id);
        await refresh();
      };
    };
    const selectTask = async (id) => {
      selectedId = id;
      renderQueue();
      renderDetail(await getJson("/tasks/" + encodeURIComponent(id)));
    };
    const refresh = async () => {
      const data = await getJson("/tasks" + query());
      tasks = data.tasks;
      proposals = (await getJson("/proposals")).proposals;
      renderQueue();
      renderProposals();
      await renderOperations().catch(() => undefined);
      $("status").textContent = "Updated " + new Date().toLocaleTimeString();
    };
    const createBody = (status) => ({
      title: $("title").value,
      description: $("description").value,
      repositoryName: $("repositoryName").value || undefined,
      repoPathKey: $("repoPathKey").value || $("repositoryName").value || undefined,
      baseBranch: $("baseBranch").value || undefined,
      queue: $("queueName").value || undefined,
      priority: $("priority").value,
      taskType: $("template").value,
      acceptanceCriteria: lines($("criteria").value),
      tags: ["ai_dev"],
      ...(status ? { status } : {})
    });
    $("saveDraft").onclick = async () => { const result = await postJson("/tasks", createBody("triage")); selectedId = result.task.id; await refresh(); await selectTask(result.task.id); };
    $("createReady").onclick = async () => { const result = await postJson("/tasks", createBody("ready")); selectedId = result.task.id; await refresh(); await selectTask(result.task.id); };
    $("previewDraft").onclick = async () => { $("draftPreview").classList.remove("hidden"); $("draftPreview").textContent = JSON.stringify(createBody("ready"), null, 2); };
    $("refresh").onclick = () => refresh().catch((error) => $("status").textContent = error.message);
    ["filterRepo", "filterQueue", "filterStatus", "filterTag"].forEach((id) => $(id).onchange = () => refresh().catch((error) => $("status").textContent = error.message));
    document.querySelectorAll("[data-tab]").forEach((button) => button.onclick = () => {
      document.querySelectorAll("[data-tab]").forEach((entry) => entry.classList.toggle("active", entry === button));
      ["queue", "proposals", "create", "ops"].forEach((tab) => $(tab + "Tab").classList.toggle("hidden", button.dataset.tab !== tab));
    });
    refresh().catch((error) => $("status").textContent = error.message);
  </script>
</body>
</html>`;
