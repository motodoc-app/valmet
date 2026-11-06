// LEARN (guided, component-synchronised explanations) and PRACTICE (scored virtual exercise) modes.
// Content comes from backend/xray/knowledge/pump_components.json; scoring is checked against the explicitly
// defined scenario answers. Educational prototype only.
import * as THREE from "three";

export function initTraining(S, ui) {
  const { $, esc, cites, renderRight, xCam, xControls, toast } = ui;
  const kb = S.kb;
  const comp = (id) => kb.components.find((c) => c.id === id);

  function focus(ids) {
    S.xray.highlight(ids);
    if (!ids.length) return;
    const c = new THREE.Vector3();
    ids.forEach((id) => c.add(S.xray.partCenter(id)));
    c.multiplyScalar(1 / ids.length);
    xControls.target.copy(c);
    xCam.position.copy(c.clone().add(new THREE.Vector3(1.1, 0.7, 1.4)));
  }

  // ---------------------------------------------------------------- LEARN
  let topic = null, step = 0;
  function learn() {
    S.xray.setHidden([]);
    S.xray.setGhost(true);
    S.xray.setExplode(0.35);
    if (!topic) return renderTopics();
    const st = topic.steps[step];
    focus(st.focus);
    renderRight(`<div class="ph"><h3>Learn · ${esc(topic.title)}</h3></div><div class="pb">
      <div class="progress">${topic.steps.map((_, i) => `<i class="${i < step ? "done" : i === step ? "cur" : ""}"></i>`).join("")}</div>
      <div class="note">Step ${step + 1} / ${topic.steps.length}${st.focus.length ? " · highlighted: " + st.focus.map((f) => comp(f).name).join(", ") : ""}</div>
      <div class="narr" style="margin-top:8px;font-size:14px">${cites(st.text)}</div>
      ${st.focus.map((f) => `<div class="li" style="display:block;margin-top:6px"><b>${esc(comp(f).name)}</b> — ${esc(comp(f).function)} <span class="cite" data-doc="KB-XRAY-PUMP#${f}">KB-XRAY-PUMP#${f}</span></div>`).join("")}
      <div class="actions"><button class="btn" id="lPrev" ${step === 0 ? "disabled" : ""}>← Back</button>
        <button class="btn primary" id="lNext">${step === topic.steps.length - 1 ? "Finish ✓" : "Next →"}</button>
        <button class="btn" id="lTopics">Topics</button></div>
      <div class="note" style="margin-top:10px">Conceptual training content (no operational procedure). Real work requires authorisation, isolation and approved OEM/site documentation [DOC-FIELD-SAFETY].</div>
    </div>`);
    $("#lPrev").onclick = () => { step = Math.max(0, step - 1); learn(); };
    $("#lNext").onclick = () => {
      if (step === topic.steps.length - 1) { toast(`✔ Topic complete: ${esc(topic.title)}`); topic = null; step = 0; return learn(); }
      step++; learn();
    };
    $("#lTopics").onclick = () => { topic = null; learn(); };
  }
  function renderTopics() {
    S.xray.highlight([]);
    const issue = S.diag?.asset?.issue_code;
    renderRight(`<div class="ph"><h3>Learn · choose a topic</h3></div><div class="pb">
      ${kb.learn_topics.map((t) => `<div class="doc" data-topic="${t.id}"><b>${esc(t.title)}</b>${t.issue_code === issue ? ' <span class="sus">MATCHES CURRENT FAULT</span>' : ""}<div class="note">${t.steps.length} steps · ${t.issue_code}</div></div>`).join("")}
      <div class="note">Each step highlights the relevant parts in the 3D model.</div></div>`);
    document.querySelectorAll("[data-topic]").forEach((el) => (el.onclick = () => { topic = kb.learn_topics.find((t) => t.id === el.dataset.topic); step = 0; learn(); }));
  }

  // ---------------------------------------------------------------- PRACTICE
  let P = null;
  function practice() {
    S.xray.setGhost(false);
    if (!P) return renderIntro();
    const sc = P.sc, task = sc.tasks[P.i];
    if (!task) return renderSummary();
    const bar = `<div class="progress">${sc.tasks.map((_, i) => `<i class="${i < P.i ? "done" : i === P.i ? "cur" : ""}"></i>`).join("")}</div>`;
    let body = "";
    S.onComponentPick = null;
    if (task.type === "select_component") {
      S.xray.setExplode(1);
      S.xray.highlight([]);
      body = `<div class="narr">${esc(task.prompt)}</div><div class="note" style="margin-top:6px">Click a part in the exploded 3D model.</div><div id="fb"></div>`;
      S.onComponentPick = (id) => {
        const ok = task.answer.includes(id);
        record(ok, `${comp(id).name}`);
        $("#fb").innerHTML = `<div class="fb ${ok ? "ok" : "bad"}">${esc(ok ? task.feedback_ok : task.feedback_bad)}</div>${ok ? '<div class="actions"><button class="btn primary" id="nx">Continue →</button></div>' : ""}`;
        S.xray.highlight(ok ? task.answer : [id]);
        if (ok) { S.onComponentPick = null; $("#nx").onclick = next; }
      };
    } else if (task.type === "choice") {
      body = `<div class="narr">${esc(task.prompt)}</div><div class="quiz">${task.options.map((o, i) => `<button class="opt" data-i="${i}">${esc(o)}</button>`).join("")}</div><div id="fb"></div>`;
    } else if (task.type === "disassembly" || task.type === "reassembly") {
      const dis = task.type === "disassembly";
      if (dis && P.removed.length === 0) { S.xray.setExplode(0.15); S.xray.setHidden([]); }
      const done = dis ? P.removed : P.reinstalled;
      body = `<div class="narr">${esc(task.prompt)}</div>
        <div class="note" style="margin:6px 0">${dis ? "Click parts in the 3D model to remove them." : "Click the parts below to reinstall them."}</div>
        <div class="row">${task.order.map((id) => `<span class="chip ${done.includes(id) ? "on" : ""}">${done.includes(id) ? "✓ " : ""}${esc(comp(id).name)}</span>`).join("")}</div>
        ${dis ? "" : `<div class="row" style="margin-top:8px">${[...task.order].sort().map((id) => `<button class="btn" data-re="${id}" ${done.includes(id) ? "disabled" : ""}>${esc(comp(id).name)}</button>`).join("")}</div>`}
        <div id="fb"></div>`;
      const step = (id) => {
        const expected = task.order[done.length];
        if (id !== expected) {
          record(false, `${dis ? "remove" : "reinstall"} ${comp(id)?.name}`);
          $("#fb").innerHTML = `<div class="fb bad">${esc(task.feedback_bad || "Wrong order — think about what is physically in the way.")} (expected next: ${esc(comp(expected).name)})</div>`;
          return;
        }
        done.push(id);
        record(true, `${dis ? "removed" : "reinstalled"} ${comp(id).name}`);
        S.xray.setHidden(dis ? [...P.removed] : task.order.filter((x) => !P.reinstalled.includes(x)));
        if (done.length === task.order.length) {
          if (dis) S.xray.highlight(["bearing_inboard", "bearing_outboard"]);
          P.i++; setTimeout(practice, 500);
          toast(dis ? "✔ " + (task.feedback_ok || "Done") : "✔ Model reassembled");
        } else practice();
      };
      if (dis) S.onComponentPick = step;
      setTimeout(() => document.querySelectorAll("[data-re]").forEach((b) => (b.onclick = () => step(b.dataset.re))), 0);
    }
    renderRight(`<div class="ph"><h3>Practice · ${esc(sc.title)}</h3></div><div class="pb">${bar}
      <div class="note">Task ${P.i + 1} / ${sc.tasks.length} · score ${P.score}/${P.attempts}</div><div style="margin-top:8px">${body}</div></div>`);
    if (task.type === "choice") {
      document.querySelectorAll(".opt").forEach((b) => (b.onclick = () => {
        const ok = +b.dataset.i === task.answer;
        record(ok, task.options[+b.dataset.i]);
        b.classList.add(ok ? "ok" : "bad");
        if (ok) { $("#fb").innerHTML = '<div class="fb ok">Correct.</div><div class="actions"><button class="btn primary" id="nx">Continue →</button></div>'; $("#nx").onclick = next; }
        else $("#fb").innerHTML = '<div class="fb bad">Not quite — try again.</div>';
      }));
    }
  }
  function record(ok, what) { P.attempts++; if (ok) P.score++; P.log.push({ task: P.i + 1, ok, what }); }
  function next() { P.i++; practice(); }

  function renderIntro() {
    const sc = kb.practice_scenarios[0];
    S.xray.setHidden([]); S.xray.setExplode(0); S.xray.highlight([]);
    const ev = sc.evidence.map((e) => `<div class="sig"><div><b>${e.signal}</b><small>${e.values[0]} → ${e.values.at(-1)}</small></div>${spark(e.values)}</div>`).join("");
    renderRight(`<div class="ph"><h3>Practice · virtual repair rehearsal</h3></div><div class="pb">
      <div class="li" style="display:block;border-color:rgba(250,204,21,.4);background:rgba(250,204,21,.06)"><b style="color:#fde68a">Educational prototype</b><div class="note">Fictional training case; not a substitute for certified training or a validated repair procedure. Not connected to any real control system.</div></div>
      <div class="sec"><h4>Scenario</h4><b>${esc(sc.title)}</b><div class="narr" style="margin-top:6px">${esc(sc.brief)}</div></div>
      <div class="sec"><h4>Diagnostic evidence (fictional)</h4>${ev}</div>
      <div class="sec"><h4>Safety gate — confirm before the exercise</h4>
        ${["I am authorised for this (virtual) task", "Isolation & lockout/tagout would be applied under site procedure", "Approved OEM / site documentation would be followed"].map((g, i) => `<label class="gate"><input type="checkbox" class="g" data-i="${i}"> ${g}</label>`).join("")}</div>
      <div class="actions"><button class="btn primary" id="pStart" disabled>Start exercise →</button></div></div>`);
    const gates = [...document.querySelectorAll(".g")];
    gates.forEach((g) => (g.onchange = () => ($("#pStart").disabled = !gates.every((x) => x.checked))));
    $("#pStart").onclick = () => { P = { sc, i: 0, score: 0, attempts: 0, log: [], removed: [], reinstalled: [], t0: Date.now() }; practice(); };
  }
  function renderSummary() {
    const pct = Math.round((100 * P.score) / Math.max(1, P.attempts));
    S.onComponentPick = null;
    S.xray.setHidden([]); S.xray.setExplode(0.5);
    renderRight(`<div class="ph"><h3>Practice · completion summary</h3></div><div class="pb">
      <div class="hdr st-${pct >= 80 ? "healthy" : pct >= 60 ? "watch" : "degraded"}"><div class="gauge" style="--v:${pct}"><span>${pct}</span></div>
      <div><div class="title">${pct >= 80 ? "Passed" : "Review recommended"}</div><div class="sub">${P.score} correct of ${P.attempts} attempts · ${Math.round((Date.now() - P.t0) / 1000)} s</div></div></div>
      <div class="sec"><h4>Attempt log</h4><div class="list">${P.log.map((l) => `<div class="li"><code>T${l.task}</code><span style="color:${l.ok ? "var(--ok)" : "var(--bad)"}">${l.ok ? "✓" : "✗"}</span><span>${esc(l.what)}</span></div>`).join("")}</div></div>
      <div class="sec"><h4>Key takeaways</h4>
        <div class="step"><b>1</b><div>Stable hydraulics + rising vibration and temperature → bearings, not impeller fouling.</div></div>
        <div class="step"><b>2</b><div>Verify sensor mounting and signal quality before trusting a trend <span class="cite" data-doc="DOC-VIBRATION_SENSOR-CORE">DOC-VIBRATION_SENSOR-CORE</span>.</div></div>
        <div class="step"><b>3</b><div>Real work needs authorisation, isolation/LOTO and approved procedures <span class="cite" data-doc="DOC-FIELD-SAFETY">DOC-FIELD-SAFETY</span>.</div></div></div>
      <div class="actions"><button class="btn primary" id="pAgain">Retry</button><button class="btn" id="pBack">Back to facility</button></div>
      <div class="note" style="margin-top:8px">Educational prototype — completion here is not a qualification.</div></div>`);
    $("#pAgain").onclick = () => { P = null; practice(); };
    $("#pBack").onclick = () => ui.setMode("facility");
  }
  function spark(v, w = 96, h = 28) {
    const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#f43f5e" stroke-width="1.5" points="${v.map((y, i) => `${(i / (v.length - 1)) * w},${h - 2 - ((y - lo) / r) * (h - 4)}`).join(" ")}"/></svg>`;
  }

  S.training = { learn, practice };
}
