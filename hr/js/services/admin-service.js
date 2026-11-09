/* PRD-HR V8 — Role & user administration (Phase 6a). DEMO: there are NO passwords and no real authentication in a browser-only app; "users" define who a persona is.
   Safeguards: built-in roles can't be deleted, the HR admin role can't lose its management permissions, the last active HR admin can't be deactivated. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {}), fail = (code, msg) => ({ ok: false, errors: [{ code, msg }] }), MUST = ["view", "manageUsers", "manageSettings", "viewAudit"];
  class RoleService {
    constructor(p, audit) { this.p = p; this.audit = audit; }
    async load() { NS.applyRoles(await this.p.list("roles")); }
    list() { return Object.entries(NS.ROLES).map(([code, r]) => Object.assign({ code, builtin: NS.BUILTIN_ROLES.includes(code) }, r)); }
    async save(user, d) {
      NS.policy.assert(user, "manageUsers"); const code = (d.code || "").trim(), builtin = NS.BUILTIN_ROLES.includes(code);
      if (!/^[a-z][a-z0-9_]{2,29}$/.test(code)) return fail("CODE", "លេខកូដ Role: a-z, 0-9, _ (3–30 តួ)"); if (!(d.label || "").trim()) return fail("LABEL", "ត្រូវមានឈ្មោះ Role"); if (!NS.SCOPES[d.scope]) return fail("SCOPE", "Scope មិនត្រឹមត្រូវ");
      const bad = (d.perms || []).filter((x) => !NS.ALL_PERMS.includes(x)); if (bad.length) return fail("PERM", "សិទ្ធិមិនស្គាល់: " + bad.join(", "));
      if (code === "hr_admin" && (d.scope !== "all" || MUST.some((m) => !d.perms.includes(m)))) return fail("LOCKOUT", "HR Administrator ត្រូវរក្សាសិទ្ធិគ្រប់គ្រង (មើល, គ្រប់គ្រងអ្នកប្រើ, ការកំណត់, Audit) ដើម្បីកុំឱ្យចាក់សោខ្លួនឯង");
      if (d.scope === "self" && (d.perms || []).some((x) => ["manageUsers", "manageSettings", "approve", "archive"].includes(x))) return fail("SELF_SCOPE", "Role Scope «ខ្លួនឯង» មិនអាចមានសិទ្ធិគ្រប់គ្រង/អនុម័ត");
      const prev = NS.ROLES[code] ? JSON.parse(JSON.stringify(NS.ROLES[code])) : null, rec = { id: code, code, label: d.label.trim(), scope: d.scope, perms: [...new Set(d.perms || [])], updated_at: NS.clock.nowISO(), updated_by: user.id || user.role };
      await this.p.put("roles", rec); NS.applyRoles([rec]); await this.audit.log({ user, action: prev ? "role-update" : "role-create", module: "security", previous: prev, next: { label: rec.label, scope: rec.scope, perms: rec.perms }, note: code, result: "ok" }); return { ok: true, builtin };
    }
    async remove(user, code) {
      NS.policy.assert(user, "manageUsers"); if (NS.BUILTIN_ROLES.includes(code)) return fail("BUILTIN", "មិនអាចលុប Role មូលដ្ឋាន"); if (!NS.ROLES[code]) return fail("NOT_FOUND", "រកមិនឃើញ Role");
      if ((await this.p.list("users")).some((u) => u.role === code && u.active !== false)) return fail("IN_USE", "នៅមានអ្នកប្រើសកម្មប្រើ Role នេះ");
      await this.p.delete("roles", code); delete NS.ROLES[code]; await this.audit.log({ user, action: "role-delete", module: "security", note: code }); return { ok: true };
    }
  }
  class UserService {
    constructor(p, audit) { this.p = p; this.audit = audit; }
    async list(user) { NS.policy.assert(user, "manageUsers"); return (await this.p.list("users")).sort((a, b) => (a.username < b.username ? -1 : 1)); }
    async _check(d, all, selfId) {
      if (!/^[a-z0-9._-]{3,30}$/.test(d.username || "")) return fail("USERNAME", "Username: a-z 0-9 . _ - (3–30 តួ)"); if (all.some((u) => u.username === d.username && u.id !== selfId)) return fail("USERNAME_TAKEN", "Username មានរួចហើយ");
      if (!(d.display_name || "").trim()) return fail("NAME", "ត្រូវមានឈ្មោះបង្ហាញ"); const r = NS.ROLES[d.role]; if (!r) return fail("ROLE", "Role មិនមាន");
      if (r.scope === "self") { if (!d.employee_id || !(await this.p.get("employees", d.employee_id))) return fail("EMPLOYEE", "Role Scope «ខ្លួនឯង» ត្រូវភ្ជាប់ Employee ID ដែលមាន"); }
      if (r.scope === "section" && !(d.section || "").trim()) return fail("SECTION", "Role Scope «ផ្នែក» ត្រូវកំណត់ផ្នែក");
      if (d.hub_staff_id && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(String(d.hub_staff_id).trim())) return fail("HUB_ID", "លេខសម្គាល់ Hub: អក្សរ/លេខ . _ - (≤40 តួ)"); return null;
    }
    async create(user, d) {
      NS.policy.assert(user, "manageUsers"); const all = await this.p.list("users"), bad = await this._check(d, all); if (bad) return bad;
      const u = { id: "u-" + NS.uid().slice(0, 8), username: d.username, display_name: d.display_name.trim(), role: d.role, employee_id: d.employee_id || null, hub_staff_id: (d.hub_staff_id || "").trim().toUpperCase() || null, section: d.section || null, active: true, created_at: NS.clock.nowISO(), created_by: user.id || user.role, auth: "demo-none" };
      await this.p.put("users", u); await this.audit.log({ user, action: "user-create", module: "security", next: { username: u.username, role: u.role } }); return { ok: true, id: u.id };
    }
    async update(user, id, patch) {
      NS.policy.assert(user, "manageUsers"); const cur = await this.p.get("users", id); if (!cur) return fail("NOT_FOUND", "រកមិនឃើញអ្នកប្រើ"); const next = Object.assign({}, cur, patch, { id }); if ("hub_staff_id" in patch) next.hub_staff_id = (patch.hub_staff_id || "").trim().toUpperCase() || null; const bad = await this._check(next, await this.p.list("users"), id); if (bad) return bad;
      if (cur.role === "hr_admin" && next.role !== "hr_admin" && (await this._lastAdmin(id))) return fail("LAST_ADMIN", "មិនអាចប្តូរ Role របស់ HR Administrator សកម្មចុងក្រោយ");
      next.updated_at = NS.clock.nowISO(); await this.p.put("users", next); await this.audit.log({ user, action: "user-update", module: "security", previous: { role: cur.role, section: cur.section, employee_id: cur.employee_id }, next: { role: next.role, section: next.section, employee_id: next.employee_id }, note: cur.username }); return { ok: true };
    }
    async _lastAdmin(id) { return !(await this.p.list("users")).some((u) => u.id !== id && u.role === "hr_admin" && u.active !== false); }
    async setActive(user, id, active) {
      NS.policy.assert(user, "manageUsers"); const cur = await this.p.get("users", id); if (!cur) return fail("NOT_FOUND", "រកមិនឃើញអ្នកប្រើ"); if (!active && cur.role === "hr_admin" && (await this._lastAdmin(id))) return fail("LAST_ADMIN", "មិនអាចបិទ HR Administrator សកម្មចុងក្រោយ");
      cur.active = !!active; await this.p.put("users", cur); await this.audit.log({ user, action: active ? "user-activate" : "user-deactivate", module: "security", note: cur.username }); return { ok: true };
    }
  }
  NS.RoleService = RoleService; NS.UserService = UserService;
  /* ---------------- central approval inbox (leave + promotions) ---------------- */
  class ApprovalService {
    constructor(p, emp, leave, career, settings) { this.p = p; this.emp = emp; this.leave = leave; this.career = career; this.st = settings; }
    async escalationDays() { return (await this.st.get("approvalEscalationDays", null)) || 3; }
    async setEscalationDays(user, d) { if (!(d >= 1 && d <= 30)) return fail("RANGE", "1–30 ថ្ងៃ"); await this.st.set(user, "approvalEscalationDays", d); return { ok: true }; }
    _age(ts) { return Math.max(0, Math.round((+NS.clock.today() - +NS.dates.toDate(ts.slice(0, 10))) / 86400000)); }
    async inbox(user) {
      const by = Object.fromEntries((await this.emp.list(user, { pageSize: 100000 })).items.map((e) => [e.employee_id, e])), esc = await this.escalationDays(), out = [];
      for (const r of await this.leave.list(user)) if ((r.status === "pending_head" && user.role === "dept_head" && NS.policy.can(user, "approve", { section: r.section }).allow) || (r.status === "pending_hr" && user.role === "hr_admin"))
        out.push({ kind: "leave", id: r.id, employee_id: r.employee_id, name_km: (by[r.employee_id] || {}).name_km, title: NS.LEAVE_TYPES[r.type], detail: `${r.from} → ${r.to} (${r.working_days} ថ្ងៃ)${r.reason ? " · " + r.reason : ""}`, stage: NS.LEAVE_STATUS[r.status], submitted_at: r.created_at, age_days: this._age(r.created_at), overdue: this._age(r.created_at) >= esc });
      if (user.role === "hr_admin") for (const r of await this.career.list(user)) if (r.status === "submitted") { const t = (r.history.find((h) => h.action === "submit") || {}).ts || r.created_at; out.push({ kind: "promotion", id: r.id, employee_id: r.employee_id, name_km: (by[r.employee_id] || {}).name_km, title: "ដំឡើងតួនាទី/ថ្នាក់", detail: `${r.current.position || "—"} → ${r.proposed.position || "—"}${r.proposed.staff_class ? " (ថ្នាក់ " + r.proposed.staff_class + ")" : ""} · មានប្រសិទ្ធភាព ${r.effective_date}`, stage: "រង់ចាំ HR", submitted_at: t, age_days: this._age(t), overdue: this._age(t) >= esc }); }
      return out.sort((a, b) => b.age_days - a.age_days);
    }
    async decide(user, item, action, note) { return item.kind === "leave" ? this.leave.act(user, item.id, action, note) : this.career.act(user, item.id, action, note); }
    async history(user, limit) { // decisions taken by this user, newest first
      const me = user.id || user.role, by = Object.fromEntries((await this.emp.list(user, { pageSize: 100000 })).items.map((e) => [e.employee_id, e])), out = [];
      for (const r of await this.leave.list(user)) for (const h of r.history) if (h.by === me && h.action !== "submit") out.push({ kind: "leave", ts: h.ts, action: h.action, note: h.note, employee: (by[r.employee_id] || {}).name_km, title: NS.LEAVE_TYPES[r.type], status: NS.LEAVE_STATUS[r.status] });
      for (const r of await this.career.list(user)) for (const h of r.history) if (h.by === me && h.action !== "submit") out.push({ kind: "promotion", ts: h.ts, action: h.action, note: h.note, employee: (by[r.employee_id] || {}).name_km, title: "ដំឡើងតួនាទី", status: r.status });
      return out.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit || 50);
    }
    async mine(user) { if (!user.employee_id) return []; return (await this.leave.list(user)).filter((r) => r.employee_id === user.employee_id).map((r) => ({ id: r.id, title: NS.LEAVE_TYPES[r.type], detail: `${r.from} → ${r.to} (${r.working_days} ថ្ងៃ)`, status: NS.LEAVE_STATUS[r.status], history: r.history })).reverse(); }
  }
  NS.ApprovalService = ApprovalService;

  /* ---------------- sensitive-field configuration: HR can ADD fields to the protected set; the baseline can never be removed ---------------- */
  NS.PII_CANDIDATES = { dob: "ថ្ងៃកំណើត", place_of_birth: "ទីកន្លែងកំណើត", marital_raw: "ស្ថានភាពគ្រួសារ", name_en: "English Name", equivalent_rank: "ឋានៈស្មើ", rank_grade_date: "កាំ-ថ្នាក់ (កាលបរិច្ឆេទ)" };
  class SecurityConfigService {
    constructor(settings) { this.st = settings; }
    async pii(user) { NS.policy.assert(user, "manageSettings"); const base = NS.defaultConfig().pii, extra = await this.st.get("piiExtra", []); return { baseline: base, extra, candidates: NS.PII_CANDIDATES }; }
    async setExtra(user, list) { NS.policy.assert(user, "manageSettings"); const bad = list.filter((k) => !NS.PII_CANDIDATES[k]); if (bad.length) return fail("FIELD", "ជ្រើសរើសបានតែក្នុងបញ្ជី: " + bad.join(", ")); await this.st.set(user, "piiExtra", [...new Set(list)]); return { ok: true }; }
  }
  NS.SecurityConfigService = SecurityConfigService;

})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
