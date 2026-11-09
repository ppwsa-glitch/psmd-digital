/* PRD-HR V8 — Report center UI (Phase 5b): choose report → filters → columns → preview → Excel / CSV / Print (Save as PDF in the browser, which renders Khmer correctly). */
(function () {
  const N = PRDHR, $ = (s) => document.querySelector(s), U = () => N.ui, esc = (s) => U().esc(s);
  let st = { id: "master", params: { year: 0, month: "", horizon: 5, unit_text: "", employee_id: "" }, cols: null };
  const run = async (fn) => { try { return await fn(); } catch (e) { alert(e.message); } };
  const save = (name, mime, data) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };
  const clean = (p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== "" && v !== 0 && v != null));

  U().views.reports = async function () {
    const { A, user, can } = U(), u = user(); $("#ttl").textContent = "មជ្ឈមណ្ឌលរបាយការណ៍ HR"; $("#crumb").textContent = "វិភាគ & របាយការណ៍ › របាយការណ៍";
    if (!(await A.p.count("employees"))) { $("#v").innerHTML = '<div class="glass pan"><b>No Data</b><div class="k">មិនទាន់មានទិន្នន័យ — ផ្ទុក Demo ឬ Import Excel ជាមុន។</div></div>'; return; }
    const def = N.reportsById[st.id], thisYear = N.clock.today().getUTCFullYear(); if (!st.params.year) st.params.year = thisYear; if (!st.cols || st.cols.report !== st.id) st.cols = { report: st.id, keys: def.cols.map((c) => c.k) };
    const R = await A.rs.run(u, st.id, clean(st.params), st.cols.keys), offices = [...new Set((await A.emp.list(u, { pageSize: 100000 })).items.map((e) => e.unit_text).filter(Boolean))].sort(), has = (k) => R.params.includes(k);
    $("#v").innerHTML = `<div class="glass pan"><div class="fm"><label>របាយការណ៍<select id="rid">${N.REPORTS.map((r, i) => `<option value="${r.id}" ${r.id === st.id ? "selected" : ""}>${i + 1}. ${esc(r.label)}</option>`).join("")}</select></label>
      ${has("year") ? `<label>ឆ្នាំ<input id="ry" type="number" value="${st.params.year}"></label>` : ""}${has("month") ? `<label>ខែ (YYYY-MM)<input id="rm" placeholder="2024-12" value="${esc(st.params.month)}"></label>` : ""}${has("horizon") ? `<label>ក្នុង (ឆ្នាំ)<select id="rh">${[1, 2, 3, 5].map((y) => `<option ${y === +st.params.horizon ? "selected" : ""}>${y}</option>`).join("")}</select></label>` : ""}
      <label>នាយកដ្ឋាន/អង្គភាព<select id="ru"><option value="">ទាំងអស់</option>${offices.map((o) => `<option ${o === st.params.unit_text ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label><label>បុគ្គលិក (ID)<input id="re" placeholder="PPWSA-0000" value="${esc(st.params.employee_id)}"></label></div>
      <div class="tools" style="margin-top:8px">${R.available.map((c) => `<label class="k"><input type="checkbox" class="rc" value="${c.k}" ${st.cols.keys.includes(c.k) ? "checked" : ""}> ${esc(c.l)}</label>`).join(" ")}</div>
      <div class="tools"><button class="btn" id="rx" ${can("export") ? "" : "disabled"}>⬇ Excel (.xlsx)</button><button class="btn alt" id="rcsv" ${can("export") ? "" : "disabled"}>⬇ CSV</button><button class="btn alt" id="rp" ${can("export") ? "" : "disabled"}>🖨 Print / PDF</button>${can("export") ? "" : '<span class="k">គ្មានសិទ្ធិ Export</span>'}</div></div>
     <div class="glass tw" style="margin-top:12px"><div class="k" style="padding:8px"><b>${esc(R.title)}</b> · ${R.total} ជួរ${R.total > 100 ? " (បង្ហាញ 100 ដំបូង)" : ""} · ${esc(R.generated_at.slice(0, 16).replace("T", " "))}${R.note ? "<br>" + esc(R.note) : ""}</div><table><thead><tr>${R.columns.map((c) => `<th>${esc(c.l)}</th>`).join("")}</tr></thead><tbody>${R.rows.slice(0, 100).map((r) => `<tr>${R.columns.map((c) => `<td>${r[c.k] == null || r[c.k] === "" ? '<span class="k">—</span>' : esc(r[c.k])}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${R.columns.length}" class="k" style="padding:16px">No Data</td></tr>`}</tbody></table></div>`;
    const re = () => U().views.reports(), set = (id, k, num) => { const el = $("#" + id); if (el) el.onchange = () => { st.params[k] = num ? +el.value : el.value.trim(); re(); }; };
    $("#rid").onchange = () => { st.id = $("#rid").value; re(); }; set("ry", "year", true); set("rm", "month"); set("rh", "horizon", true); set("ru", "unit_text"); set("re", "employee_id");
    $("#v").querySelectorAll(".rc").forEach((c) => (c.onchange = () => { const k = [...document.querySelectorAll(".rc:checked")].map((x) => x.value); if (!k.length) { c.checked = true; return; } st.cols.keys = k; re(); }));
    const ex = (fmt) => run(async () => { const o = await A.rs.export(u, st.id, clean(st.params), st.cols.keys, fmt); save(o.filename, o.mime, o.bytes || o.text); });
    $("#rx").onclick = () => ex("xlsx"); $("#rcsv").onclick = () => ex("csv");
    $("#rp").onclick = () => run(async () => { await A.audit.log({ user: u, action: "report-print", module: "reports", note: `${st.id} · ${R.total} rows` }); const f = JSON.stringify(clean(st.params));
      $("#pa").innerHTML = `<h2>PRD-HR · ${esc(R.title)}</h2><div>បង្កើតនៅ ${esc(R.generated_at.slice(0, 16).replace("T", " "))} · ដោយ ${esc(R.generated_by)} · Filter ${esc(f)} · ${R.total} ជួរ</div>${R.note ? `<div><i>${esc(R.note)}</i></div>` : ""}<table><thead><tr>${R.columns.map((c) => `<th>${esc(c.l)}</th>`).join("")}</tr></thead><tbody>${R.rows.map((r) => `<tr>${R.columns.map((c) => `<td>${r[c.k] == null ? "" : esc(r[c.k])}</td>`).join("")}</tr>`).join("")}</tbody></table><div style="margin-top:8px">ទិន្នន័យ Demo/Imported/Calculated តាមសម្គាល់ក្នុងឈ្មោះ Column · មិនមែនឯកសារផ្លូវការ</div>`; window.print(); });
  };
})();
