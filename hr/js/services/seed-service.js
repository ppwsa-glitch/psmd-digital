/* PRD-HR V8 — seeding. V7's 10 hard-coded employees and the 262 synthetic demo employees. Everything seeded is origin "demo". */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});
  class SeedService {
    constructor(provider, audit) { this.p = provider; this.audit = audit; }
    /* rows = V7 `P` array: [id,nameKm,nameEn,gender,age,position,section,type,education,phone,years] */
    async seedV7(user, rows) {
      NS.policy.assert(user, "import"); const recs = rows.map((r) => ({ employee_id: r[0], name_km: r[1], name_en: r[2], gender: r[3], position: r[5], section: r[6], unit_text: r[6], v7_type: r[7], education_level: r[8], phone: r[9], years_service_imported: Number(r[10]) || null, age_imported: r[4], dob: null, origin: "demo-v7", created_at: NS.clock.nowISO(), created_by: "seed" }));
      let n = 0; for (const r of recs) if (!(await this.p.get("employees", r.employee_id))) { await this.p.put("employees", r); n++; }
      await this.audit.log({ user, action: "seed-v7", module: "seed", note: n + " V7 demo employees" }); return { created: n, skipped: recs.length - n };
    }
    async isSeeded() { return (await this.p.count("employees")) > 0; }
  }
  NS.SeedService = SeedService;
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
