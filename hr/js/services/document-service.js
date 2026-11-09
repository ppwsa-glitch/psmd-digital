/* PRD-HR V8 — Document management (Phase 4c). DEMO storage: files live as base64 inside the browser's IndexedDB (never behind a public URL);
   production must use secure server-side storage with signed, expiring access. Access rules are enforced here, not only in the UI. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {}), { dates } = NS, fail = (code, msg) => ({ ok: false, errors: [{ code, msg }] });
  NS.DOC_CATEGORIES = { identification: "អត្តសញ្ញាណប័ណ្ណ", cv: "ប្រវត្តិរូប (CV)", education: "វិញ្ញាបនបត្រការសិក្សា", appointment: "សេចក្តីសម្រេចតែងតាំង", contract: "កិច្ចសន្យាការងារ", professional: "វិញ្ញាបនបត្រវិជ្ជាជីវៈ", safety: "វិញ្ញាបនបត្រសុវត្ថិភាព", award: "រង្វាន់ & មេដាយ", other: "ផ្សេងៗ" };
  NS.DOC_STATUS = { valid: "មានសុពលភាព", expiring: "ជិតផុតកំណត់", expired: "ផុតកំណត់", missing: "បាត់" };
  NS.DOC_LIMITS = { maxBytes: 1.5 * 1024 * 1024, types: ["application/pdf", "image/png", "image/jpeg"] };
  const SENSITIVE = ["identification", "contract"]; // need the viewSensitive permission (or being the owner) to open the file itself

  class DocumentService {
    constructor(p, audit, emp, settings) { this.p = p; this.audit = audit; this.emp = emp; this.st = settings; }
    async required() { return (await this.st.get("requiredDocCategories", null)) || ["identification", "cv", "education", "appointment"]; }
    async warnDays() { return (await this.st.get("docExpiryWarnDays", null)) || 90; }
    status(d, today, warn) { if (!d.expiry_date) return "valid"; if (d.expiry_date < today) return "expired"; return d.expiry_date <= dates.iso(new Date(+dates.toDate(today) + warn * 86400000)) ? "expiring" : "valid"; }
    _meta(d, today, warn) { const m = Object.assign({}, d, { status: this.status(d, today, warn), sensitive: SENSITIVE.includes(d.category) }); if (m.file) m.file = { name: d.file.name, type: d.file.type, size: d.file.size }; return m; } // never leaks file bytes in listings
    async _validate(d) {
      if (!NS.DOC_CATEGORIES[d.category]) return fail("CATEGORY", "ប្រភេទឯកសារមិនត្រឹមត្រូវ"); if (!(d.title || "").trim()) return fail("TITLE", "ត្រូវមានចំណងជើង");
      for (const k of ["issue_date", "expiry_date"]) if (d[k] && !dates.toDate(d[k])) return fail("DATE", k + " មិនត្រឹមត្រូវ"); if (d.issue_date && d.expiry_date && d.expiry_date < d.issue_date) return fail("EXPIRY", "ថ្ងៃផុតកំណត់ត្រូវមិនមុនថ្ងៃចេញ");
      const f = d.file; if (!f || !f.data) return fail("FILE", "ត្រូវភ្ជាប់ឯកសារ"); if (!NS.DOC_LIMITS.types.includes(f.type)) return fail("TYPE", "អនុញ្ញាតតែ PDF, PNG, JPEG"); if (!(f.size > 0) || f.size > NS.DOC_LIMITS.maxBytes) return fail("SIZE", "ទំហំឯកសារត្រូវតូចជាង 1.5MB (Demo)"); return null;
    }
    async upload(user, d, _supersedes) {
      NS.policy.assert(user, "create"); const e = await this.p.get("employees", d.employee_id); if (!e) return fail("NOT_FOUND", "រកមិនឃើញបុគ្គលិក"); const bad = await this._validate(d); if (bad) return bad;
      const rec = { id: NS.uid(), employee_id: e.employee_id, category: d.category, title: d.title.trim(), issue_date: d.issue_date || null, expiry_date: d.expiry_date || null, file: { name: d.file.name, type: d.file.type, size: d.file.size, data: d.file.data }, version: _supersedes ? _supersedes.version + 1 : 1, supersedes: _supersedes ? _supersedes.id : null, origin: "manual", created_at: NS.clock.nowISO(), created_by: user.id || user.role };
      await this.p.put("documents", rec); await this.audit.log({ user, action: _supersedes ? "document-replace" : "document-upload", module: "documents", employee_id: e.employee_id, next: { category: d.category, title: rec.title, version: rec.version, file: rec.file.name } }); return { ok: true, id: rec.id };
    }
    async replace(user, id, d) { // the old version is kept (archived), never overwritten or deleted
      NS.policy.assert(user, "edit"); const old = await this.p.get("documents", id); if (!old || old.archived_at) return fail("NOT_FOUND", "រកមិនឃើញឯកសារបច្ចុប្បន្ន");
      const r = await this.upload(user, Object.assign({ employee_id: old.employee_id, category: old.category }, d), old); if (!r.ok) return r; old.archived_at = NS.clock.nowISO(); old.replaced_by = r.id; await this.p.put("documents", old); return r;
    }
    async list(user, f) {
      f = f || {}; const today = dates.iso(NS.clock.today()), warn = await this.warnDays(), by = Object.fromEntries((await this.emp.list(user, { pageSize: 100000, includeArchived: true })).items.map((e) => [e.employee_id, e]));
      let rows = (await this.emp.relatedAll(user, "documents")).filter((d) => f.history || !d.archived_at).map((d) => Object.assign(this._meta(d, today, warn), { name_km: (by[d.employee_id] || {}).name_km }));
      if (f.employee_id) rows = rows.filter((r) => r.employee_id === f.employee_id); if (f.category) rows = rows.filter((r) => r.category === f.category); if (f.status) rows = rows.filter((r) => r.status === f.status);
      if (f.q) { const q = NS.text.key(f.q); rows = rows.filter((r) => NS.text.key(r.name_km).includes(q) || NS.text.key(r.employee_id).includes(q) || NS.text.key(r.title).includes(q)); } return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    }
    async getFile(user, id) { // the only way to obtain file bytes — permission-checked and audited
      const d = await this.p.get("documents", id); if (!d) return fail("NOT_FOUND", "រកមិនឃើញឯកសារ"); const e = await this.p.get("employees", d.employee_id); NS.policy.assert(user, "view", e);
      if (this.p.getFile) return { ok: true, file: await this.p.getFile(id), title: d.title }; // Backend: Server ពិនិត្យសិទ្ធិ + កត់ Audit ខ្លួនឯង
      if (SENSITIVE.includes(d.category) && !NS.policy.can(user, "viewSensitive").allow && user.employee_id !== d.employee_id) { await this.audit.log({ user, action: "document-denied", module: "documents", employee_id: d.employee_id, result: "denied", note: d.category }); const x = new Error("FORBIDDEN: SENSITIVE_DOCUMENT"); x.code = "FORBIDDEN"; throw x; }
      await this.audit.log({ user, action: "document-access", module: "documents", employee_id: d.employee_id, note: d.title }); return { ok: true, file: d.file, title: d.title };
    }
    async missing(user) { const req = await this.required(), emps = (await this.emp.list(user, { pageSize: 100000 })).items, have = {}; (await this.emp.relatedAll(user, "documents")).filter((d) => !d.archived_at).forEach((d) => ((have[d.employee_id] = have[d.employee_id] || new Set()).add(d.category)));
      const rows = emps.map((e) => ({ employee_id: e.employee_id, name_km: e.name_km, office: e.unit_text, missing: req.filter((c) => !(have[e.employee_id] || new Set()).has(c)) })).filter((r) => r.missing.length); return { required: req, rows, employees: emps.length }; }
    async summary(user) { const rows = await this.list(user), s = { valid: 0, expiring: 0, expired: 0 }; rows.forEach((r) => s[r.status]++); const m = await this.missing(user); return Object.assign(s, { total: rows.length, employeesMissing: m.rows.length, employees: m.employees }); }
  }
  NS.DocumentService = DocumentService;
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
