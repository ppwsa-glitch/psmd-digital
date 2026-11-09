/* PRD-HR V8 — Retirement forecast, succession planning, performance analytics (Phase 4a). Everything is computed from stored records; no fixed numbers. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {}), { calc, dates } = NS, fail = (code, msg) => ({ ok: false, errors: [{ code, msg }] });
  const bump = (o, k) => { k = k || "មិនបានបញ្ជាក់"; o[k] = (o[k] || 0) + 1; };

  class AnalyticsService {
    constructor(p, audit, emp, settings) { this.p = p; this.audit = audit; this.emp = emp; this.st = settings; }
    async cfg() { const c = NS.defaultConfig(), age = await this.st.get("retirementAge", null); c.pii = [...new Set(c.pii.concat(await this.st.get("piiExtra", [])))]; /* HR may ADD sensitive fields, never remove the baseline */ if (age) { c.retirement.ageYears = age; c.retirement.label = `កំណត់ដោយ HR: ${age} ឆ្នាំ (មិនបញ្ជាក់ថាជាច្បាប់ផ្លូវការ)`; } return c; }
    async setRetirementAge(user, age) { if (!(age >= 40 && age <= 75)) return fail("AGE_RANGE", "អាយុត្រូវនៅចន្លោះ 40–75"); await this.st.set(user, "retirementAge", age); return { ok: true }; }

    async retirement(user, horizon) {
      horizon = horizon || 5; const cfg = await this.cfg(), today = NS.clock.today(), emps = (await this.emp.list(user, { pageSize: 100000 })).items, rows = [], noData = [];
      for (const e of emps) { const d = calc.retirementDate(e, cfg); if (!d) { noData.push(e.employee_id); continue; } rows.push({ employee_id: e.employee_id, name_km: e.name_km, dob: e.dob, age: calc.age(e.dob), office: e.unit_text, section: e.section, position: e.position, date: dates.iso(d), years_left: calc.yearsUntilRetirement(e, cfg) }); }
      rows.sort((a, b) => (a.date < b.date ? -1 : 1));
      const windows = {}; for (const n of cfg.retirementWindowsYears) windows[n] = rows.filter((r) => r.years_left >= 0 && r.years_left <= n).length;
      const upcoming = rows.filter((r) => r.years_left >= 0 && r.years_left <= horizon), byYear = {}, byOffice = {}, byPosition = {};
      upcoming.forEach((r) => { bump(byYear, r.date.slice(0, 4)); bump(byOffice, r.office); bump(byPosition, r.position); });
      return { rows, windows, overdue: rows.filter((r) => r.years_left < 0).length, noData: noData.length, byYear, byOffice, byPosition, horizon, rule: cfg.retirement.label, ageYears: cfg.retirement.ageYears, official: false };
    }

    /* succession planning: positions that need a replacement, candidates, required qualifications, status */
    async succession(user) { return (await this.emp.relatedAll(user, "approval_workflows")).filter((x) => x.kind === "succession"); }
    async createSuccession(user, d) {
      NS.policy.assert(user, "edit"); const inc = await this.p.get("employees", d.incumbent_id); if (!inc) return fail("NOT_FOUND", "រកមិនឃើញបុគ្គលិកកំពុងកាន់តំណែង");
      const cands = (d.candidates || []).map(NS.validators.normalizeId).filter(Boolean); for (const c of cands) if (!(await this.p.get("employees", c))) return fail("CANDIDATE_NOT_FOUND", "រកមិនឃើញបេក្ខជន " + c); if (cands.includes(inc.employee_id)) return fail("SELF", "បេក្ខជនមិនអាចជាអ្នកកាន់តំណែងដដែល");
      const r = { id: NS.uid(), kind: "succession", employee_id: inc.employee_id, position: d.position || inc.position || null, candidates: cands, required_qualifications: d.required_qualifications || "", status: cands.length ? "candidate_identified" : "open", created_at: NS.clock.nowISO(), created_by: user.id || user.role };
      await this.p.put("approval_workflows", r); await this.audit.log({ user, action: "succession-create", module: "retirement", employee_id: inc.employee_id, next: { position: r.position, candidates: cands } }); return { ok: true, id: r.id };
    }
    async setSuccessionStatus(user, id, status) {
      NS.policy.assert(user, "edit"); if (!["open", "candidate_identified", "filled"].includes(status)) return fail("STATUS", "ស្ថានភាពមិនត្រឹមត្រូវ"); const r = await this.p.get("approval_workflows", id); if (!r || r.kind !== "succession") return fail("NOT_FOUND", "រកមិនឃើញ");
      const prev = r.status; r.status = status; await this.p.put("approval_workflows", r); await this.audit.log({ user, action: "succession-status", module: "retirement", employee_id: r.employee_id, previous: { status: prev }, next: { status } }); return { ok: true };
    }

    /* performance: quarterly scores (primary block). 'Total' imported by Excel is kept but the average here is CALCULATED from the quarters; maternity-status quarters are excluded. */
    async performance(user) {
      const emps = (await this.emp.list(user, { pageSize: 100000 })).items, by = Object.fromEntries(emps.map((e) => [e.employee_id, e])), recs = (await this.emp.relatedAll(user, "performance_records")).filter((r) => r.variant === "primary" && /^Q[1-4]$/.test(r.period) && typeof r.score === "number");
      const per = {}; recs.forEach((r) => { ((per[r.year] = per[r.year] || {})[r.employee_id] = per[r.year][r.employee_id] || []).push(r.score); });
      const avgOf = (y) => Object.fromEntries(Object.entries(per[y] || {}).map(([id, s]) => [id, calc.avg(s)])), years = Object.keys(per).map(Number).sort();
      const awards = await this.emp.relatedAll(user, "awards"), self = this;
      return { years, by,
        summary(y) { const m = avgOf(y), v = Object.values(m); return { evaluated: v.length, avg: calc.avg(v) }; },
        ranking(y, n) { const m = avgOf(y); return Object.entries(m).map(([id, a]) => ({ employee_id: id, name_km: (by[id] || {}).name_km, office: (by[id] || {}).unit_text, avg: a })).sort((a, b) => b.avg - a.avg || (a.employee_id < b.employee_id ? -1 : 1)).slice(0, n || 10); },
        byOffice(y) { const m = avgOf(y), g2 = {}; Object.entries(m).forEach(([id, a]) => (g2[(by[id] || {}).unit_text || "មិនបានបញ្ជាក់"] = g2[(by[id] || {}).unit_text || "មិនបានបញ្ជាក់"] || []).push(a)); return Object.entries(g2).map(([o, v]) => ({ office: o, n: v.length, avg: calc.avg(v) })).sort((a, b) => b.avg - a.avg); },
        compare(a, b) { const A = avgOf(a), B = avgOf(b), ids = Object.keys(A).filter((i) => i in B), d = ids.map((i) => +(B[i] - A[i]).toFixed(2)); return { n: ids.length, improved: d.filter((x) => x > 0).length, declined: d.filter((x) => x < 0).length, same: d.filter((x) => x === 0).length, avgDelta: d.length ? calc.avg(d) : null }; },
        outstanding: { employees: new Set(awards.filter((x) => x.award_type === "outstanding").map((x) => x.employee_id)).size, byYear: awards.filter((x) => x.award_type === "outstanding").reduce((o, x) => (bump(o, String(x.year)), o), {}) },
        maternityQuarters: (await self.emp.relatedAll(user, "performance_records")).filter((r) => r.status === "maternity_leave").length };
    }
  }
  NS.AnalyticsService = AnalyticsService;

  /* ---------------- executive dashboard: every number is computed from stored records; filters drive all cards/charts ---------------- */
  NS.EMP_TYPE_LABEL = { permanent: "ពេញសិទ្ធិ", contract: "កិច្ចសន្យា", trial: "សាកល្បង" };
  class DashboardService {
    constructor(p, emp, an, settings) { this.p = p; this.emp = emp; this.an = an; this.st = settings; }
    async build(user, f) {
      f = f || {}; const cfg = await this.an.cfg(), th = (await this.st.get("notifRetirementYears", 1)) || 1, base = { pageSize: 100000, includeArchived: true };
      const all = (await this.emp.list(user, base)).items; let rows = all;
      if (f.unit_text) rows = rows.filter((e) => e.unit_text === f.unit_text); if (f.section) rows = rows.filter((e) => e.section === f.section); if (f.gender) rows = rows.filter((e) => e.gender === f.gender); if (f.type) rows = rows.filter((e) => e.calc.employment_type === f.type);
      const status = f.status || "active"; if (status === "active") rows = rows.filter((e) => !e.archived_at); else if (status === "archived") rows = rows.filter((e) => e.archived_at);
      const ids = new Set(rows.map((e) => e.employee_id)), count = (fn, label, filt, order) => { const m = {}; rows.forEach((e) => { const k = fn(e); if (k != null && k !== "") m[k] = (m[k] || 0) + 1; }); const out = Object.entries(m).map(([k, n]) => ({ key: k, label: label ? label(k) : k, n, filter: filt(k) })); return order ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : out.sort((a, b) => b.n - a.n); };
      const ages = rows.map((e) => e.calc.age).filter((x) => x != null), svc = rows.map((e) => e.calc.years_of_service).filter((x) => x != null), retiring = rows.filter((e) => e.calc.years_until_retirement != null && e.calc.years_until_retirement >= 0 && e.calc.years_until_retirement <= th);
      const years = [...new Set((await this.p.list("performance_records")).map((r) => r.year))].sort(), year = f.year || NS.clock.today().getUTCFullYear(), perfRecs = (await this.emp.relatedAll(user, "performance_records")).filter((r) => ids.has(r.employee_id) && r.variant === "primary" && /^Q[1-4]$/.test(r.period) && typeof r.score === "number" && r.year === year), pe = {};
      perfRecs.forEach((r) => (pe[r.employee_id] = pe[r.employee_id] || []).push(r.score)); const pv = Object.values(pe).map((s2) => calc.avg(s2));
      const awards = (await this.emp.relatedAll(user, "awards")).filter((a) => ids.has(a.employee_id) && a.award_type === "outstanding");
      /* attendance: latest month of the selected year that has marks; rate only when HR has mapped codes to present/absent */
      const codes = Object.assign({}, cfg.attendanceCodes, await this.st.get("attendanceCodes", {})), att = (await this.emp.relatedAll(user, "attendance_records")).filter((r) => ids.has(r.employee_id) && r.date.startsWith(String(year))), month = att.map((r) => r.date.slice(0, 7)).sort().pop(), am = att.filter((r) => r.date.startsWith(month || "x")), cat = (r) => (codes[r.code_raw] || {}).category || "unspecified", pr = am.filter((r) => cat(r) === "present").length, ab = am.filter((r) => cat(r) === "absent").length;
      const retYear = {}; rows.forEach((e) => { const y = e.calc.years_until_retirement; if (y != null && y >= 0 && y <= 5) { const k = e.calc.retirement_date.slice(0, 4); retYear[k] = (retYear[k] || 0) + 1; } });
      const T = NS.EMP_TYPE_LABEL; return { year, years, filters: f, status, retirementRule: cfg.retirement.label, threshold: th, total: rows.length, ids,
        kpi: { total: rows.length, active: rows.filter((e) => !e.archived_at).length, male: rows.filter((e) => e.gender === "ប្រុស").length, female: rows.filter((e) => e.gender === "ស្រី").length, avgAge: calc.avg(ages), avgService: calc.avg(svc), contract: rows.filter((e) => e.calc.employment_type === "contract").length, retiring: retiring.length,
          attendanceRate: pr + ab ? Math.round((pr / (pr + ab)) * 1000) / 10 : null, attendanceMonth: month || null, attendanceMarked: am.length, outstandingEver: new Set(awards.map((a) => a.employee_id)).size, outstandingYear: new Set(awards.filter((a) => a.year === year).map((a) => a.employee_id)).size },
        dist: { office: count((e) => e.unit_text || "មិនបានបញ្ជាក់", null, (k) => ({ unit_text: k === "មិនបានបញ្ជាក់" ? "__none__" : k })), gender: count((e) => e.gender, null, (k) => ({ gender: k })), age: count((e) => e.calc.age_group, null, (k) => ({ ageGroup: k }), ["<25", "25–34", "35–44", "45–54", "55+"]), education: count((e) => e.education_level, null, (k) => ({ education_level: k })),
          type: count((e) => e.calc.employment_type, (k) => T[k] || k, (k) => ({ type: k })), staffClass: count((e) => e.staff_class, (k) => "ថ្នាក់ " + k, (k) => ({ staff_class: k })), framework: count((e) => e.framework, null, (k) => ({ framework: k })), service: count((e) => e.calc.service_band, null, (k) => ({ serviceBand: k }), ["<5", "5–9", "10–19", "20–29", "30+"]),
          retirement: Object.entries(retYear).sort().map(([k, n]) => ({ key: k, label: k, n, filter: { retireYear: k, retireWithin: 5 } })) },
        unspecified: { education: rows.filter((e) => !e.education_level).length, staffClass: rows.filter((e) => !e.staff_class).length },
        perf: { avg: calc.avg(pv), evaluated: pv.length, year }, options: { unit_text: [...new Set(all.map((e) => e.unit_text).filter(Boolean))].sort(), section: [...new Set(all.map((e) => e.section).filter(Boolean))].sort() } };
    }
  }
  NS.DashboardService = DashboardService;

  /* ---------------- awards & medals ---------------- */
  NS.AWARD_CATEGORIES = { outstanding: "ជនឆ្នើម", medal: "មេដាយ", other: "ពានរង្វាន់/ប្រកាសនីយបត្រផ្សេងៗ" };
  class AwardsService {
    constructor(p, audit, emp) { this.p = p; this.audit = audit; this.emp = emp; }
    async list(user) {
      const by = Object.fromEntries((await this.emp.list(user, { pageSize: 100000 })).items.map((e) => [e.employee_id, e])), aw = await this.emp.relatedAll(user, "awards"), md = await this.emp.relatedAll(user, "medals");
      const row = (r, kind) => ({ id: r.id, kind, employee_id: r.employee_id, name_km: (by[r.employee_id] || {}).name_km, office: (by[r.employee_id] || {}).unit_text, year: r.year, category: kind === "medal" ? "medal" : r.award_type, count: kind === "medal" ? r.count || 1 : 1, medal_type: r.medal_type || null, ref: r.ref || null, date: r.date || null, origin: r.origin || "manual" });
      return aw.map((r) => row(r, "award")).concat(md.map((r) => row(r, "medal"))).sort((a, b) => b.year - a.year || (a.employee_id < b.employee_id ? -1 : 1));
    }
    async add(user, d) {
      NS.policy.assert(user, "edit"); const e = await this.p.get("employees", d.employee_id); if (!e) return fail("NOT_FOUND", "រកមិនឃើញបុគ្គលិក"); if (!NS.AWARD_CATEGORIES[d.category]) return fail("CATEGORY", "ប្រភេទមិនត្រឹមត្រូវ");
      const y = Number(d.year), now = NS.clock.today().getUTCFullYear(); if (!Number.isInteger(y) || y < 1970 || y > now) return fail("YEAR", `ឆ្នាំត្រូវនៅចន្លោះ 1970–${now}`); if (d.date && (!dates.toDate(d.date) || +d.date.slice(0, 4) !== y)) return fail("DATE", "កាលបរិច្ឆេទមិនត្រឹមត្រូវ ឬមិនស្របនឹងឆ្នាំ");
      const all = await this.list({ role: "hr_admin" }), dup = all.some((r) => r.employee_id === e.employee_id && r.year === y && r.category === d.category && (d.category === "outstanding" || (d.ref && r.ref === d.ref))); if (dup) return fail("DUPLICATE", "មានកំណត់ត្រាដូចគ្នារួចហើយ");
      const rec = { id: NS.uid(), employee_id: e.employee_id, year: y, date: d.date || null, ref: d.ref || null, note: d.note || null, origin: "manual", created_at: NS.clock.nowISO(), created_by: user.id || user.role };
      if (d.category === "medal") await this.p.put("medals", Object.assign(rec, { count: 1, medal_type: d.medal_type || null })); else await this.p.put("awards", Object.assign(rec, { award_type: d.category }));
      await this.audit.log({ user, action: "award-add", module: "awards", employee_id: e.employee_id, next: { category: d.category, year: y, ref: d.ref || null } }); return { ok: true, id: rec.id };
    }
    async analytics(user) {
      const rows = await this.list(user), sum = (f) => rows.reduce((o, r) => { const k = f(r) || "មិនបានបញ្ជាក់"; o[k] = (o[k] || 0) + r.count; return o; }, {});
      const byEmp = Object.entries(sum((r) => r.employee_id)).map(([id, n]) => ({ employee_id: id, name_km: (rows.find((r) => r.employee_id === id) || {}).name_km, n })).sort((a, b) => b.n - a.n || (a.employee_id < b.employee_id ? -1 : 1)).slice(0, 10);
      return { total: rows.reduce((n, r) => n + r.count, 0), byYear: sum((r) => String(r.year)), byOffice: sum((r) => r.office), byCategory: sum((r) => NS.AWARD_CATEGORIES[r.category]), medalByYear: rows.filter((r) => r.kind === "medal").reduce((o, r) => ((o[r.year] = (o[r.year] || 0) + r.count), o), {}), topEmployees: byEmp, medalTypesKnown: rows.some((r) => r.kind === "medal" && r.medal_type) };
    }
  }
  NS.AwardsService = AwardsService;

  /* ---------------- notifications (derived from live data; only read-state is stored) ---------------- */
  NS.NOTIF_CATEGORIES = { retirement: "ជិតចូលនិវត្តន៍", leave: "សំណើច្បាប់រង់ចាំ", promotion: "សំណើដំឡើងតួនាទីរង់ចាំ", import: "កំហុស Import", training: "វិញ្ញាបនបត្របណ្តុះបណ្តាលជិតផុតកំណត់", document: "ឯកសារ" };
  class NotificationService {
    constructor(p, audit, emp, leave, career, an, settings) { Object.assign(this, { p, audit, emp, leave, career, an, st: settings }); }
    async threshold() { return (await this.st.get("notifRetirementYears", 1)) || 1; }
    async setThreshold(user, years) { if (![1, 2, 3, 5].includes(years)) return fail("RANGE", "ជ្រើស 1, 2, 3 ឬ 5 ឆ្នាំ"); await this.st.set(user, "notifRetirementYears", years); return { ok: true }; }
    async generate(user) {
      const out = [], today = dates.iso(NS.clock.today()), by = Object.fromEntries((await this.emp.list(user, { pageSize: 100000 })).items.map((e) => [e.employee_id, e]));
      if (user.role === "hr_admin" || user.role === "dept_head") { const th = await this.threshold(), R = await this.an.retirement(user), n = R.rows.filter((r) => r.years_left >= 0 && r.years_left <= th).length;
        if (n) out.push({ id: `retirement|${th}|${n}`, category: "retirement", priority: R.rows.some((r) => r.years_left >= 0 && r.years_left <= 0.5) ? "high" : "medium", title: `${n} នាក់ជិតចូលនិវត្តន៍ក្នុង ${th} ឆ្នាំ`, detail: R.rule, link: "#retire", date: today }); }
      for (const r of await this.leave.list(user)) if ((r.status === "pending_head" && user.role === "dept_head") || (r.status === "pending_hr" && user.role === "hr_admin")) out.push({ id: "leave|" + r.id + "|" + r.status, category: "leave", priority: "medium", title: `សំណើច្បាប់ ${(by[r.employee_id] || {}).name_km || r.employee_id}`, detail: `${NS.LEAVE_TYPES[r.type]} ${r.from} → ${r.to} (${r.working_days} ថ្ងៃ)`, employee_id: r.employee_id, link: "#leave", date: r.created_at.slice(0, 10) });
      if (user.role === "hr_admin") { for (const r of await this.career.list(user)) if (r.status === "submitted") out.push({ id: "promotion|" + r.id, category: "promotion", priority: "medium", title: `សំណើដំឡើងតួនាទី ${(by[r.employee_id] || {}).name_km || r.employee_id}`, detail: `${r.current.position || "—"} → ${r.proposed.position || "—"} (មានប្រសិទ្ធភាព ${r.effective_date})`, employee_id: r.employee_id, link: "#career", date: r.created_at.slice(0, 10) });
        const jobs = (await this.p.list("import_jobs")).filter((j) => j.status === "committed").sort((a, b) => (a.committed_at < b.committed_at ? 1 : -1)); if (jobs[0]) { const er = (jobs[0].issues || []).filter((i) => i.severity === "error").length; if (er) out.push({ id: "import|" + jobs[0].id, category: "import", priority: "high", title: `Import ចុងក្រោយមាន ${er} កំហុស`, detail: jobs[0].file_name || "", link: "phase2-harness.html", date: jobs[0].committed_at.slice(0, 10) }); } }
      if (this.training && (user.role === "hr_admin" || user.role === "dept_head")) { const ex = await this.training.expiring(user, 90); if (ex.length) out.push({ id: `training|90|${ex.length}`, category: "training", priority: "medium", title: `${ex.length} វិញ្ញាបនបត្រជិតផុតកំណត់ក្នុង 90 ថ្ងៃ`, detail: "", link: "#training", date: today }); }
      if (this.docs && (user.role === "hr_admin" || user.role === "dept_head")) { const S = await this.docs.summary(user);
        if (S.expired) out.push({ id: `document|expired|${S.expired}`, category: "document", priority: "high", title: `${S.expired} ឯកសារផុតកំណត់`, detail: "", link: "#docs", date: today }); if (S.expiring) out.push({ id: `document|expiring|${S.expiring}`, category: "document", priority: "medium", title: `${S.expiring} ឯកសារជិតផុតកំណត់`, detail: "", link: "#docs", date: today });
        if (S.employeesMissing) out.push({ id: `document|missing|${S.employeesMissing}`, category: "document", priority: "low", title: `${S.employeesMissing} នាក់ខ្វះឯកសារចាំបាច់`, detail: "", link: "#docs", date: today }); }
      const pr = { high: 0, medium: 1, low: 2 }; return out.sort((a, b) => pr[a.priority] - pr[b.priority] || (a.date < b.date ? 1 : -1));
    }
    _key(u) { return "notifRead:" + (u.id || u.role); }
    async readSet(u) { const r = await this.p.get("system_settings", this._key(u)); return new Set(r ? r.value : []); }
    async markRead(u, ids) { const s = await this.readSet(u); ids.forEach((i) => s.add(i)); await this.p.put("system_settings", { key: this._key(u), value: [...s], updated_at: NS.clock.nowISO() }); }
    async list(u) { const n = await this.generate(u), rd = await this.readSet(u); return n.map((x) => Object.assign({ read: rd.has(x.id) }, x)); }
    async unreadCount(u) { return (await this.list(u)).filter((x) => !x.read).length; }
  }
  NS.NotificationService = NotificationService;

})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
