/* PRD-HR V8 — Leave workflow (Employee → Department Head → HR) and Career/Promotion workflow. Rules come from settings/config, never hard-coded as "official". */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {}), { calc, dates, validators } = NS, fail = (code, msg) => ({ ok: false, errors: [{ code, msg }] });
  NS.LEAVE_TYPES = { annual: "ច្បាប់ប្រចាំឆ្នាំ", sick: "ច្បាប់ឈឺ", maternity: "ច្បាប់មាតុភាព", mission: "បេសកកម្ម/កិច្ចការផ្លូវការ", personal: "ច្បាប់ផ្ទាល់ខ្លួន" }; // V7 categories preserved
  NS.LEAVE_STATUS = { pending_head: "រង់ចាំប្រធានផ្នែក", pending_hr: "រង់ចាំ HR", approved: "អនុម័ត", rejected: "បដិសេធ" };

  class LeaveService {
    constructor(p, audit, emp, settings, cfg) { this.p = p; this.audit = audit; this.emp = emp; this.st = settings; this.cfg = cfg || NS.defaultConfig(); }
    async quotas() { return Object.assign({ annual: this.cfg.leave.annualQuotaDays, sick: null, maternity: null, mission: null, personal: null }, await this.st.get("leaveQuotas", {})); } // quota per type; null = no quota configured
    async holidays() { return (await this.st.get("publicHolidays", this.cfg.publicHolidays)) || []; }
    _clip(r, year, hol) { const a = dates.iso(new Date(Math.max(+dates.toDate(r.from), +dates.toDate(year + "-01-01")))), b = dates.iso(new Date(Math.min(+dates.toDate(r.to), +dates.toDate(year + "-12-31")))); return calc.workingDays(a, b, hol); }
    async balance(user, id, year) {
      const e = await this.p.get("employees", id); if (!e) return null; NS.policy.assert(user, "view", e);
      const reqs = (await this.p.list("leave_requests", { index: "employee_id", value: id })), hol = await this.holidays(), q = await this.quotas(), out = {};
      for (const t of Object.keys(NS.LEAVE_TYPES)) { const mine = reqs.filter((r) => r.type === t && r.status !== "rejected" && +r.from.slice(0, 4) <= year && +r.to.slice(0, 4) >= year), sum = (f) => mine.filter(f).reduce((n, r) => n + this._clip(r, year, hol), 0);
        const used = sum((r) => r.status === "approved"), pending = sum((r) => r.status !== "approved"); out[t] = { entitlement: q[t], used, pending, remaining: q[t] == null ? null : q[t] - used - pending, origin: "calculated" }; }
      return out;
    }
    async submit(user, d) {
      const e = await this.p.get("employees", d.employee_id); if (!e) return fail("NOT_FOUND", "រកមិនឃើញបុគ្គលិក"); NS.policy.assert(user, "requestLeave", e);
      if (!NS.LEAVE_TYPES[d.type]) return fail("TYPE", "ប្រភេទច្បាប់មិនត្រឹមត្រូវ"); if (!validators.dateRange(d.from, d.to)) return fail("DATE_RANGE", "ថ្ងៃបញ្ចប់ត្រូវមិនមុនថ្ងៃចាប់ផ្តើម");
      const hol = await this.holidays(), days = calc.workingDays(d.from, d.to, hol); if (days < 1) return fail("NO_WORKING_DAYS", "គ្មានថ្ងៃធ្វើការក្នុងចន្លោះនេះ");
      const mine = await this.p.list("leave_requests", { index: "employee_id", value: e.employee_id }).then((l) => l.filter((r) => r.status !== "rejected"));
      if (mine.some((r) => d.from <= r.to && d.to >= r.from)) return fail("OVERLAP", "ជាន់ថ្ងៃជាមួយសំណើដែលមានរួច");
      const q = (await this.quotas())[d.type]; if (q != null) { const y = +d.from.slice(0, 4), b = (await this.balance(user, e.employee_id, y))[d.type]; if (days > b.remaining) return fail("QUOTA_EXCEEDED", `លើស Quota: នៅសល់ ${b.remaining} ថ្ងៃ ស្នើ ${days} ថ្ងៃ`); }
      const r = { id: NS.uid(), employee_id: e.employee_id, section: e.section || null, type: d.type, from: d.from, to: d.to, working_days: days, reason: d.reason || "", status: "pending_head", created_at: NS.clock.nowISO(), created_by: user.id || user.role, history: [{ ts: NS.clock.nowISO(), by: user.id || user.role, role: user.role, action: "submit" }] };
      await this.p.put("leave_requests", r); await this.audit.log({ user, action: "leave-submit", module: "leave", employee_id: e.employee_id, next: { type: r.type, from: r.from, to: r.to, days } }); return { ok: true, id: r.id, days };
    }
    async act(user, id, action, note) {
      const r = await this.p.get("leave_requests", id); if (!r) return fail("NOT_FOUND", "រកមិនឃើញសំណើ");
      if (r.status === "pending_head") { NS.policy.assert(user, "approve", { section: r.section }); if (user.role !== "dept_head") { const e = new Error("FORBIDDEN: HEAD_ONLY_STAGE"); e.code = "FORBIDDEN"; throw e; } } else if (r.status === "pending_hr") { NS.policy.assert(user, "approve"); if (user.role !== "hr_admin") { const e = new Error("FORBIDDEN: HR_ONLY_STAGE"); e.code = "FORBIDDEN"; throw e; } } else return fail("FINAL", "សំណើបានសម្រេចរួចហើយ");
      if (action === "reject" && !(note || "").trim()) return fail("NOTE_REQUIRED", "ត្រូវមានមូលហេតុពេលបដិសេធ");
      const prev = r.status, next = action === "reject" ? "rejected" : prev === "pending_head" ? "pending_hr" : "approved";
      r.status = next; r.history.push({ ts: NS.clock.nowISO(), by: user.id || user.role, role: user.role, action, note: note || null }); await this.p.put("leave_requests", r);
      await this.audit.log({ user, action: "leave-" + action, module: "leave", employee_id: r.employee_id, previous: { status: prev }, next: { status: next }, note }); return { ok: true, status: next };
    }
    list(user) { return this.emp.relatedAll(user, "leave_requests"); }
  }

  class CareerService {
    constructor(p, audit, emp) { this.p = p; this.audit = audit; this.emp = emp; }
    async timeline(user, id) {
      const e = await this.emp.get(user, id); if (!e) return []; const ev = [];
      [["start_framework", "ចូលបម្រើការងារ (ក្របខណ្ឌ)"], ["start_probation", "ចូលសាកល្បង"], ["start_contract", "ចូលតាមកិច្ចសន្យា"], ["start_intern", "ហាត់ការ"], ["rank_grade_date", "កាំ-ថ្នាក់ (កាលបរិច្ឆេទ)"]].forEach(([k, l]) => { if (e[k]) ev.push({ date: e[k], label: l, kind: k, origin: e.origin || "imported" }); });
      (await this.emp.related(user, id, "employment_history")).forEach((h) => ev.push({ date: h.effective_date, label: `ដំឡើងតួនាទី: ${h.from.position || "—"} → ${h.to.position || "—"}${h.to.staff_class ? " (ថ្នាក់ " + h.to.staff_class + ")" : ""}`, kind: "promotion", origin: "manual", ref: h.decision_ref }));
      return ev.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    async list(user) { return this.emp.relatedAll(user, "approval_workflows").then((l) => l.filter((x) => x.kind === "promotion")); }
    async create(user, d) {
      NS.policy.assert(user, "edit"); const e = await this.p.get("employees", d.employee_id); if (!e) return fail("NOT_FOUND", "រកមិនឃើញបុគ្គលិក");
      if (!d.new_position && !d.new_staff_class) return fail("EMPTY", "ត្រូវមានតួនាទី ឬថ្នាក់ថ្មី"); if (!dates.toDate(d.effective_date)) return fail("DATE", "ថ្ងៃមានប្រសិទ្ធភាពមិនត្រឹមត្រូវ");
      const r = { id: NS.uid(), kind: "promotion", employee_id: e.employee_id, current: { position: e.position || null, staff_class: e.staff_class || null }, proposed: { position: d.new_position || e.position || null, staff_class: d.new_staff_class || e.staff_class || null }, effective_date: d.effective_date, decision_ref: d.decision_ref || null, status: "draft", created_at: NS.clock.nowISO(), created_by: user.id || user.role, history: [] };
      await this.p.put("approval_workflows", r); await this.audit.log({ user, action: "promotion-create", module: "career", employee_id: e.employee_id, next: { proposed: r.proposed, effective: r.effective_date } }); return { ok: true, id: r.id };
    }
    async act(user, id, action, note) {
      const r = await this.p.get("approval_workflows", id); if (!r) return fail("NOT_FOUND", "រកមិនឃើញសំណើ"); const from = r.status;
      if (action === "submit") { NS.policy.assert(user, "edit"); if (from !== "draft") return fail("STATE", "ដាក់ស្នើបានតែពី Draft"); r.status = "submitted"; }
      else { NS.policy.assert(user, "approve"); if (user.role !== "hr_admin") { const e = new Error("FORBIDDEN: HR_ONLY"); e.code = "FORBIDDEN"; throw e; } if (from !== "submitted") return fail("STATE", "ត្រូវដាក់ស្នើជាមុន");
        if (action === "reject") { if (!(note || "").trim()) return fail("NOTE_REQUIRED", "ត្រូវមានមូលហេតុ"); r.status = "rejected"; } else r.status = "approved"; }
      r.history.push({ ts: NS.clock.nowISO(), by: user.id || user.role, action, note: note || null }); await this.p.put("approval_workflows", r);
      if (r.status === "approved") await this.p.put("employment_history", { id: "h-" + r.id, employee_id: r.employee_id, type: "promotion", effective_date: r.effective_date, from: r.current, to: r.proposed, decision_ref: r.decision_ref, proposal_id: r.id, status: "approved", approved_by: user.id || user.role, approved_at: NS.clock.nowISO() });
      await this.audit.log({ user, action: "promotion-" + action, module: "career", employee_id: r.employee_id, previous: { status: from }, next: { status: r.status }, note }); if (r.status === "approved") await this.applyDue(user); return { ok: true, status: r.status };
    }
    /* approved promotions change the current profile only once their effective date has arrived; pending/rejected never touch it */
    async applyDue(user) {
      const today = dates.iso(NS.clock.today()); let n = 0;
      for (const h of await this.p.list("employment_history")) { if (h.type !== "promotion" || h.status !== "approved" || h.applied_at || h.effective_date > today) continue;
        const r = await this.emp.update({ role: "hr_admin", id: "system" }, h.employee_id, { position: h.to.position, staff_class: h.to.staff_class }); if (r.ok) { await this.p.put("employment_history", Object.assign({}, h, { applied_at: NS.clock.nowISO() })); n++; } }
      return n;
    }
  }
  NS.LeaveService = LeaveService; NS.CareerService = CareerService;
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
