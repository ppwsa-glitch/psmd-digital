/* PRD-HR V8 — policy (RBAC), audit service, employee service.
   NOTE: this is a LOCAL DEMO enforcement layer. A browser-only app cannot be production-secure;
   the same can()/mask() contract must be re-implemented server-side (e.g. Firebase rules / backend). */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});
  const { calc, validators, text, dates } = NS;

  /* ---------------- policy ---------------- */
  const ALL = ["view", "create", "edit", "archive", "approve", "reject", "export", "import", "viewSensitive", "manageUsers", "manageSettings", "viewAudit", "requestLeave"];
  NS.ALL_PERMS = ALL; NS.BUILTIN_ROLES = ["hr_admin", "dept_head", "employee"]; NS.SCOPES = { all: "ទាំងអស់", section: "ក្នុងផ្នែកខ្លួន", self: "ខ្លួនឯងតែប៉ុណ្ណោះ" };
  NS.ROLES = { // V7 roles preserved (labels identical to V7); permissions mirror V7 flags ap (approve) / ph (phone)
    hr_admin: { label: "អ្នកគ្រប់គ្រង HR", scope: "all", perms: ALL },
    dept_head: { label: "ប្រធានផ្នែក", scope: "section", perms: ["view", "approve", "reject", "export"] },
    employee: { label: "និយោជិត", scope: "self", perms: ["view", "requestLeave"] },
  };
  const DEFAULTS = JSON.stringify(NS.ROLES); NS.resetRoles = () => { for (const k of Object.keys(NS.ROLES)) delete NS.ROLES[k]; Object.assign(NS.ROLES, JSON.parse(DEFAULTS)); };
  NS.applyRoles = (recs) => { for (const r of recs) NS.ROLES[r.code] = { label: r.label, scope: r.scope, perms: r.perms }; }; // stored role definitions override the built-in defaults
  NS.policy = {
    can(user, action, record) {
      const r = user && NS.ROLES[user.role];
      if (!r) return { allow: false, reason: "NO_ROLE" };
      if (!r.perms.includes(action)) return { allow: false, reason: "PERMISSION_DENIED:" + action };
      if (record) {
        if (r.scope === "self" && record.employee_id !== user.employee_id) return { allow: false, reason: "SCOPE_SELF_ONLY" };
        if (r.scope === "section" && record.section !== user.section) return { allow: false, reason: "SCOPE_SECTION_ONLY" };
      }
      return { allow: true };
    },
    assert(user, action, record) { const d = NS.policy.can(user, action, record); if (!d.allow) { const e = new Error("FORBIDDEN: " + d.reason); e.code = "FORBIDDEN"; throw e; } },
    mask(user, rec, cfg) {
      if (!rec) return rec; const out = Object.assign({}, rec);
      if (!NS.policy.can(user, "viewSensitive").allow) for (const k of (cfg || NS.defaultConfig()).pii) if (out[k] != null && out[k] !== "") out[k] = "••••";
      return out;
    },
  };

  /* ---------------- audit (append-only) ---------------- */
  /* Audit log: append-only at the provider AND hash-chained (seq + prev_hash + hash) so partial edits/deletions are detectable.
     Honest limit: a browser-only demo cannot stop someone who rewrites the whole chain; production needs a server-side/external anchor. */
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), ZERO = "0".repeat(64);
  const sha = async (t) => { try { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))); } catch (e) { return null; } };
  const canon = (r) => JSON.stringify(Object.keys(r).filter((k) => k !== "hash").sort().map((k) => [k, r[k]]));
  class AuditService {
    constructor(provider) { this.p = provider; this._q = Promise.resolve(); this._last = null; }
    async _tail() { if (this._last) return this._last; let best = { seq: 0, hash: ZERO }; for (const r of await this.p.list("audit_logs")) if (r.seq > best.seq) best = { seq: r.seq, hash: r.hash || ZERO }; return (this._last = best); }
    log(e) { // serialised so concurrent callers still get a contiguous chain
      if (this.p.serverAudit) return this.p.appendAudit(e); // Backend: Server ជាអ្នកកំណត់ user/seq/hash/ts (Browser មិនអាចក្លែង)
      const run = async () => { const tail = await this._tail(), rec = { id: NS.uid(), ts: NS.clock.nowISO(), user: (e.user && (e.user.id || e.user.role)) || "system", role: e.user && e.user.role, action: e.action, module: e.module, employee_id: e.employee_id || null, previous: e.previous === undefined ? null : e.previous, next: e.next === undefined ? null : e.next, result: e.result || "ok", note: e.note || null, seq: tail.seq + 1, prev_hash: tail.hash };
        rec.hash = await sha(tail.hash + canon(rec)); await this.p.append("audit_logs", rec); this._last = { seq: rec.seq, hash: rec.hash || ZERO }; return rec; };
      const r = this._q.then(run, run); this._q = r.catch(() => {}); return r;
    }
    async list(user, filter) {
      NS.policy.assert(user, "viewAudit"); filter = filter || {}; let rows = await this.p.list("audit_logs");
      for (const k of ["employee_id", "module", "action", "user", "result"]) if (filter[k]) rows = rows.filter((r) => r[k] === filter[k]);
      if (filter.from) rows = rows.filter((r) => r.ts.slice(0, 10) >= filter.from); if (filter.to) rows = rows.filter((r) => r.ts.slice(0, 10) <= filter.to);
      return rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : (b.seq || 0) - (a.seq || 0)));
    }
    async verify(user) {
      NS.policy.assert(user, "viewAudit"); if (this.p.serverAudit) return this.p.verifyAudit(); const all = await this.p.list("audit_logs"), legacy = all.filter((r) => !r.seq).length, rows = all.filter((r) => r.seq).sort((a, b) => a.seq - b.seq); let prev = ZERO, n = 0;
      if ((await sha("x")) === null) return { ok: null, checked: 0, legacy, reason: "SHA-256 មិនមានក្នុង Browser នេះ (ត្រូវការ HTTPS)" };
      for (const r of rows) { n++; if (r.seq !== n) return { ok: false, checked: n - 1, legacy, at: n, reason: `ខ្វះកំណត់ត្រាលេខ ${n} (មានការលុប?)` }; if (r.prev_hash !== prev) return { ok: false, checked: n - 1, legacy, at: r.seq, reason: "prev_hash មិនត្រូវ" }; const h = await sha(prev + canon(r)); if (h !== r.hash) return { ok: false, checked: n - 1, legacy, at: r.seq, reason: "មាតិកាត្រូវបានកែប្រែ" }; prev = r.hash; }
      return { ok: true, checked: n, legacy };
    }
  }
  NS.AuditService = AuditService;

  /* ---------------- employee service ---------------- */
  const EDITABLE_EXCLUDE = ["employee_id", "archived_at", "created_at", "created_by"];
  function redactForAudit(obj, cfg) { const o = Object.assign({}, obj); for (const k of cfg.pii) if (k in o) o[k] = "***"; return o; }

  class EmployeeService {
    constructor(provider, audit, cfg) { this.p = provider; this.audit = audit; this.cfg = cfg || NS.defaultConfig(); this.cfgFn = null; }
    async _cfg() { return this.cfgFn ? this.cfgFn() : this.cfg; } // lets HR-configured rules (e.g. retirement age) apply everywhere
    /* derived (calculated) values are attached under `calc` — never stored, never mixed with imported fields */
    _decorate(user, rec, cfg) {
      cfg = cfg || this.cfg; if (!rec) return null; const out = NS.policy.mask(user, rec, cfg);
      const age = calc.age(rec.dob), rd = calc.retirementDate(rec, cfg);
      out.calc = { age, age_group: calc.ageGroup(age), years_of_service: calc.yearsOfService(rec), employment_type: calc.employmentType(rec.employee_id, cfg), service_band: calc.serviceBand(calc.yearsOfService(rec)),
        retirement_date: dates.iso(rd), years_until_retirement: calc.yearsUntilRetirement(rec, cfg), retirement_rule: cfg.retirement.label, origin: "calculated" };
      return out;
    }
    async get(user, id) {
      const rec = await this.p.get("employees", id); if (!rec) return null; NS.policy.assert(user, "view", rec); const cfg = await this._cfg();
      this._sv = this._sv || new Set(); const key = (user.id || user.role) + "|" + id; // unmasked PII was shown: record it once per user+employee per session
      if (NS.policy.can(user, "viewSensitive").allow && user.employee_id !== id && cfg.pii.some((k) => rec[k]) && !this._sv.has(key)) { this._sv.add(key); await this.audit.log({ user, action: "view-sensitive", module: "employees", employee_id: id }); }
      return this._decorate(user, rec, cfg);
    }
    async list(user, q) {
      q = q || {}; NS.policy.assert(user, "view");
      let rows = (await this.p.list("employees")).filter((r) => NS.policy.can(user, "view", r).allow);
      if (!q.includeArchived) rows = rows.filter((r) => !r.archived_at);
      if (q.archivedOnly) rows = (await this.p.list("employees")).filter((r) => r.archived_at);
      for (const k of ["gender", "unit_text", "section", "position", "framework", "education_level", "staff_class"]) if (q[k]) rows = rows.filter((r) => (q[k] === "__none__" ? !r[k] : r[k] === q[k])); // "__none__" = the "unspecified" bucket
      if (q.search) { const s = text.key(q.search); rows = rows.filter((r) => text.key(r.name_km).includes(s) || text.key(r.name_en).includes(s) || text.key(r.employee_id).includes(s)); }
      const cfg = await this._cfg();
      if (q.type) rows = rows.filter((r) => calc.employmentType(r.employee_id, cfg) === q.type); if (q.ageGroup) rows = rows.filter((r) => calc.ageGroup(calc.age(r.dob)) === q.ageGroup); if (q.serviceBand) rows = rows.filter((r) => calc.serviceBand(calc.yearsOfService(r)) === q.serviceBand);
      if (q.retireWithin) rows = rows.filter((r) => { const y = calc.yearsUntilRetirement(r, cfg); return y != null && y >= 0 && y <= q.retireWithin; }); if (q.retireYear) rows = rows.filter((r) => { const d = calc.retirementDate(r, cfg), y = calc.yearsUntilRetirement(r, cfg); return d && y >= 0 && d.getUTCFullYear() === +q.retireYear; });
      const total = rows.length, dir = q.desc ? -1 : 1, by = q.sortBy || "employee_id";
      rows.sort((a, b) => { const x = by === "age" ? calc.age(a.dob) : a[by], y = by === "age" ? calc.age(b.dob) : b[by]; return (x == null) - (y == null) || (x > y ? 1 : x < y ? -1 : 0) * dir; });
      const ps = q.pageSize || 25, pg = q.page || 1;
      return { total, page: pg, pageSize: ps, items: rows.slice((pg - 1) * ps, pg * ps).map((r) => this._decorate(user, r, cfg)) };
    }
    /* all records of a store for the employees this user may see (scoped) */
    async relatedAll(user, store) { const ids = new Set((await this.list(user, { pageSize: 100000, includeArchived: true })).items.map((e) => e.employee_id)); return (await this.p.list(store)).filter((r) => ids.has(r.employee_id)); }
    /* records linked by employee_id (performance, awards, medals, …) — same view permission as the employee */
    async related(user, id, store) { const rec = await this.p.get("employees", id); if (!rec) return []; NS.policy.assert(user, "view", rec); return this.p.list(store, { index: "employee_id", value: id }); }
    async create(user, data) {
      NS.policy.assert(user, "create");
      const e = Object.assign({}, data, { employee_id: validators.normalizeId(data.employee_id) });
      const v = validators.employee(e); if (v.errors.length) return { ok: false, errors: v.errors, warnings: v.warnings };
      if (await this.p.get("employees", e.employee_id)) return { ok: false, errors: [{ code: "ID_EXISTS", msg: "Employee ID មានរួចហើយ: " + e.employee_id }], warnings: [] };
      e.origin = e.origin || "manual"; e.created_at = NS.clock.nowISO(); e.created_by = user.id || user.role;
      await this.p.put("employees", e);
      await this.audit.log({ user, action: "create", module: "employees", employee_id: e.employee_id, next: redactForAudit(e, await this._cfg()) });
      return { ok: true, id: e.employee_id, warnings: v.warnings };
    }
    async update(user, id, patch) {
      const cur = await this.p.get("employees", id); if (!cur) return { ok: false, errors: [{ code: "NOT_FOUND", msg: id }] };
      NS.policy.assert(user, "edit", cur);
      const next = Object.assign({}, cur); for (const k of Object.keys(patch)) if (!EDITABLE_EXCLUDE.includes(k)) next[k] = patch[k];
      const v = validators.employee(next); if (v.errors.length) return { ok: false, errors: v.errors, warnings: v.warnings };
      const diffPrev = {}, diffNext = {}; for (const k of Object.keys(next)) if (JSON.stringify(cur[k]) !== JSON.stringify(next[k])) { diffPrev[k] = cur[k]; diffNext[k] = next[k]; }
      if (!Object.keys(diffNext).length) return { ok: true, id, unchanged: true };
      next.updated_at = NS.clock.nowISO(); next.updated_by = user.id || user.role;
      await this.p.put("employees", next);
      await this.audit.log({ user, action: "update", module: "employees", employee_id: id, previous: redactForAudit(diffPrev, await this._cfg()), next: redactForAudit(diffNext, await this._cfg()) });
      return { ok: true, id };
    }
    async archive(user, id, reason) { // never a hard delete
      const cur = await this.p.get("employees", id); if (!cur) return { ok: false, errors: [{ code: "NOT_FOUND" }] };
      NS.policy.assert(user, "archive", cur); if (cur.archived_at) return { ok: true, unchanged: true };
      await this.p.put("employees", Object.assign({}, cur, { archived_at: NS.clock.nowISO(), archived_by: user.id || user.role, archive_reason: reason || null }));
      await this.audit.log({ user, action: "archive", module: "employees", employee_id: id, note: reason || null }); return { ok: true };
    }
    async restore(user, id) {
      const cur = await this.p.get("employees", id); if (!cur) return { ok: false, errors: [{ code: "NOT_FOUND" }] };
      NS.policy.assert(user, "archive", cur); const n = Object.assign({}, cur); delete n.archived_at; delete n.archived_by; delete n.archive_reason;
      await this.p.put("employees", n); await this.audit.log({ user, action: "restore", module: "employees", employee_id: id }); return { ok: true };
    }
  }
  class SettingsService { // configurable business rules (attendance codes, retirement age, …) — changes are audited
    constructor(provider, audit) { this.p = provider; this.audit = audit; }
    async get(key, dflt) { const r = await this.p.get("system_settings", key); return r ? r.value : dflt; }
    async set(user, key, value) { NS.policy.assert(user, "manageSettings"); const prev = await this.get(key, null); await this.p.put("system_settings", { key, value, updated_at: NS.clock.nowISO(), updated_by: user.id || user.role }); await this.audit.log({ user, action: "setting-change", module: "settings", note: key, previous: prev, next: value }); return { ok: true }; }
  }
  NS.SettingsService = SettingsService;
  NS.EmployeeService = EmployeeService;
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
