// LEARN (guided explanations synchronised with the 3D model) and PRACTICE (scored virtual exercise).
// Content comes from the equipment library for the device currently loaded in the X-Ray view, so every asset
// class gets the same lesson and practice flow. Educational prototype only.
export function initTraining(S, ui) {
  const { esc, cites, card, toast, icon, focusPart } = ui;
  const def = () => S.kb.classes[S.xClass];
  const comp = (id) => def().components.find((c) => c.id === id);
  let lastClass = null;
  const reset = () => { if (lastClass !== S.xClass) { topic = null; step = 0; P = null; lastClass = S.xClass; } };
  const head = (eyebrow, title, tag) => `<div class="card-h" style="padding-bottom:0"><span class="eyebrow-row">${eyebrow}${tag ? `<span class="tag">${tag}</span>` : ""}</span></div><div class="card-b"><div class="h1">${title}</div>`;
  const bar = (n, i) => `<div class="progress">${Array.from({ length: n }, (_, k) => `<i class="${k < i ? "done" : k === i ? "cur" : ""}"></i>`).join("")}</div>`;

  // ---------------------------------------------------------------- LEARN
  let topic = null, step = 0;
  function learn() {
    reset();
    S.xray.setHidden([]); S.xray.setGhost(true); S.xray.setExplode(0.3);
    if (!topic) return topics();
    const st = topic.steps[step];
    S.xray.highlight(st.focus);
    if (st.focus[0]) focusPart(st.focus[0], 2.0);
    card(`${head("Lesson", esc(topic.title), "Conceptual")}
      <div class="sub">Step ${step + 1} of ${topic.steps.length}</div>${bar(topic.steps.length, step)}
      <p class="p" style="color:var(--text);font-size:14px">${cites(st.text)}</p>
      ${st.focus.map((f) => `<div class="kv"><span>${esc(comp(f).name)}</span><span class="cite" data-doc="KB-XRAY-${S.xClass}#${f}">KB-XRAY-${S.xClass}#${f}</span></div>`).join("")}
      <div class="section row" style="flex-wrap:nowrap"><button class="btn" id="lPrev" ${step === 0 ? "disabled" : ""} style="flex:1">${icon("back")}Back</button>
        <button class="btn primary" id="lNext" style="flex:1">${step === topic.steps.length - 1 ? "Finish" : "Next"}</button></div>
      <div class="section" style="text-align:center"><button class="link" id="lAll">All lessons</button></div>
      <p class="note" style="margin-top:12px">Explains why, not how. Real work needs authorisation, isolation and approved OEM or site procedures.</p></div>`);
    document.getElementById("lPrev").onclick = () => { step--; learn(); };
    document.getElementById("lNext").onclick = () => {
      if (step === topic.steps.length - 1) { toast(`Lesson complete: <b>${esc(topic.title)}</b>`); topic = null; step = 0; return learn(); }
      step++; learn();
    };
    document.getElementById("lAll").onclick = () => { topic = null; learn(); };
  }
  function topics() {
    S.xray.highlight([]);
    const issue = S.xDiag?.asset?.issue_code;
    card(`${head(`Learn · ${esc(def().label)}`, "Lessons")}
      <p class="p" style="margin-top:8px">Short lessons that highlight the relevant parts of the ${esc(def().label.toLowerCase())} as you read. Switch device in the list on the left.</p>
      ${def().learn_topics.map((t, i) => `<button class="list-row" data-topic="${t.id}"><span class="n">0${i + 1}</span><span class="nm"><b>${esc(t.title)}</b><small>${t.steps.length} steps${t.issue_code === issue ? " · matches the current fault" : ""}</small></span>${icon("chev")}</button>`).join("")}</div>`);
    document.querySelectorAll("[data-topic]").forEach((el) => (el.onclick = () => { topic = def().learn_topics.find((t) => t.id === el.dataset.topic); step = 0; learn(); }));
  }

  // ---------------------------------------------------------------- PRACTICE
  let P = null;
  function practice() {
    reset();
    S.xray.setGhost(false);
    if (!P) return intro();
    const sc = P.sc, task = sc.tasks[P.i];
    if (!task) return summary();
    S.onComponentPick = null;
    let body = "";
    if (task.type === "select_component") {
      S.xray.setExplode(0.8); S.xray.highlight([]);
      body = `<p class="p" style="color:var(--text)">${esc(task.prompt)}</p><p class="note">Click a part in the model.</p><div id="fb"></div>`;
      S.onComponentPick = (id) => {
        const ok = task.answer.includes(id);
        record(ok, comp(id).name);
        document.getElementById("fb").innerHTML = `<div class="fb ${ok ? "ok" : "bad"}">${esc(ok ? task.feedback_ok : task.feedback_bad)}</div>${ok ? '<div class="section"><button class="btn primary block" id="nx">Continue</button></div>' : ""}`;
        S.xray.highlight(ok ? task.answer : [id]);
        if (ok) { S.onComponentPick = null; document.getElementById("nx").onclick = next; }
      };
    } else if (task.type === "choice") {
      body = `<p class="p" style="color:var(--text)">${esc(task.prompt)}</p><div class="quiz">${task.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join("")}</div><div id="fb"></div>`;
    } else {
      const dis = task.type === "disassembly", done = dis ? P.removed : P.reinstalled;
      if (dis && !P.removed.length) { S.xray.setExplode(0.15); S.xray.setHidden([]); }
      body = `<p class="p" style="color:var(--text)">${esc(task.prompt)}</p><p class="note">${dis ? "Click parts in the model to remove them." : "Choose the parts to refit, in order."}</p>
        <div class="section">${task.order.map((id, k) => `<div class="kv"><span>${k + 1}. ${esc(comp(id).name)}</span><span>${done.includes(id) ? (dis ? "Removed" : "Refitted") : "–"}</span></div>`).join("")}</div>
        ${dis ? "" : `<div class="section row">${[...task.order].sort().map((id) => `<button class="btn" data-re="${id}" ${done.includes(id) ? "disabled" : ""}>${esc(comp(id).name)}</button>`).join("")}</div>`}<div id="fb"></div>`;
      const act = (id) => {
        const expected = task.order[done.length];
        if (id !== expected) {
          record(false, `${dis ? "Remove" : "Refit"} ${comp(id)?.name}`);
          document.getElementById("fb").innerHTML = `<div class="fb bad">${esc(task.feedback_bad || "Wrong order. Think about what is physically in the way.")} Next is ${esc(comp(expected).name)}.</div>`;
          return;
        }
        done.push(id); record(true, `${dis ? "Removed" : "Refitted"} ${comp(id).name}`);
        S.xray.setHidden(dis ? [...P.removed] : task.order.filter((x) => !P.reinstalled.includes(x)));
        if (done.length === task.order.length) {
          if (dis) S.xray.highlight(["bearing_inboard", "bearing_outboard"]);
          toast(dis ? esc(task.feedback_ok || "Done") : "Model reassembled");
          P.i++; setTimeout(practice, 400);
        } else practice();
      };
      if (dis) S.onComponentPick = act;
      setTimeout(() => document.querySelectorAll("[data-re]").forEach((b) => (b.onclick = () => act(b.dataset.re))));
    }
    card(`${head("Practice", esc(sc.title.replace(" (fictional training case)", "")), "Fictional case")}
      <div class="sub">Task ${P.i + 1} of ${sc.tasks.length} · ${P.score} of ${P.attempts} correct</div>${bar(sc.tasks.length, P.i)}${body}</div>`);
    if (task.type === "choice") document.querySelectorAll(".opt").forEach((b) => (b.onclick = () => {
      const ok = +b.dataset.i === task.answer;
      record(ok, task.options[+b.dataset.i]); b.classList.add(ok ? "ok" : "bad");
      document.getElementById("fb").innerHTML = ok ? '<div class="fb ok">Correct.</div><div class="section"><button class="btn primary block" id="nx">Continue</button></div>' : '<div class="fb bad">Not quite. Try again.</div>';
      if (ok) document.getElementById("nx").onclick = next;
    }));
  }
  const record = (ok, what) => { P.attempts++; if (ok) P.score++; P.log.push({ task: P.i + 1, ok, what }); };
  const next = () => { P.i++; practice(); };

  function intro() {
    const sc = def().practice_scenarios[0];
    S.xray.setHidden([]); S.xray.setExplode(0); S.xray.highlight([]);
    const spark = (v) => { const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1; return `<svg class="spark" viewBox="0 0 88 26"><polyline fill="none" stroke="var(--text-2)" stroke-width="1.25" points="${v.map((y, i) => `${(i / (v.length - 1)) * 88},${23 - ((y - lo) / r) * 20}`).join(" ")}"/></svg>`; };
    card(`${head(`Practice · ${esc(def().label)}`, esc(sc.title.replace(" (fictional training case)", "")), "Fictional case")}
      <p class="p" style="margin-top:10px">${esc(sc.brief)}</p>
      ${sc.evidence.map((e) => `<div class="sig"><div><b>${e.signal.replace(/_/g, " ")}</b><small>${e.values[0]} to ${e.values.at(-1)}</small></div>${spark(e.values)}</div>`).join("")}
      <div class="section"><div class="label">Before you start</div>
        ${["I am authorised for this task", "Isolation and lockout/tagout would be applied under site procedure", "Approved OEM or site documentation would be followed"].map((g) => `<label class="gate"><input type="checkbox" class="g"/> ${g}</label>`).join("")}</div>
      <div class="section"><button class="btn primary block" id="pStart" disabled>Start exercise</button></div>
      <p class="note" style="margin-top:10px">Educational prototype. Not certified training and not connected to any control system.</p></div>`);
    const gates = [...document.querySelectorAll(".g")];
    gates.forEach((g) => (g.onchange = () => (document.getElementById("pStart").disabled = !gates.every((x) => x.checked))));
    document.getElementById("pStart").onclick = () => { P = { sc, i: 0, score: 0, attempts: 0, log: [], removed: [], reinstalled: [], t0: Date.now() }; practice(); };
  }
  function summary() {
    const pct = Math.round((100 * P.score) / Math.max(1, P.attempts));
    S.onComponentPick = null; S.xray.setHidden([]); S.xray.setExplode(0.5);
    card(`${head("Practice", pct >= 80 ? "Exercise passed" : "Review recommended")}
      <div class="sub">${P.score} of ${P.attempts} answers correct · ${Math.round((Date.now() - P.t0) / 1000)} s</div>
      <div class="meter" style="margin-top:12px"><i style="width:${pct}%"></i></div>
      <div class="section"><div class="label">Attempts</div>${P.log.map((l) => `<div class="kv"><span>Task ${l.task} · ${esc(l.what)}</span><span style="color:${l.ok ? "var(--ok)" : "var(--bad)"}">${l.ok ? "Correct" : "Wrong"}</span></div>`).join("")}</div>
      <div class="section"><div class="label">Takeaways</div>
        <div class="step"><span class="k">1</span><span>Stable flow with rising vibration and temperature points to the bearings, not the impeller.</span></div>
        <div class="step"><span class="k">2</span><span>Check sensor mounting and signal quality before trusting a trend <span class="cite" data-doc="DOC-VIBRATION_SENSOR-CORE">DOC-VIBRATION_SENSOR-CORE</span>.</span></div>
        <div class="step"><span class="k">3</span><span>Real work needs authorisation, isolation and approved procedures <span class="cite" data-doc="DOC-FIELD-SAFETY">DOC-FIELD-SAFETY</span>.</span></div></div>
      <div class="section row" style="flex-wrap:nowrap"><button class="btn" id="pAgain" style="flex:1">Try again</button><button class="btn primary" id="pBack" style="flex:1">Back to facility</button></div></div>`);
    document.getElementById("pAgain").onclick = () => { P = null; practice(); };
    document.getElementById("pBack").onclick = () => ui.setMode("facility");
  }

  S.training = { learn, practice };
}
