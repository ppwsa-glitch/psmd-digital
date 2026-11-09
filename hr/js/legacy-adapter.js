/* PRD-HR V8 — V7 adapter. Lets the unchanged V7 views read from the new data layer in the SAME shape as V7's `P` array,
   so each view can be switched over one at a time (strangler migration). Employee ID replaces V7's array index. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});
  NS.legacy = {
    // V7 P-row: [id, nameKm, nameEn, gender, age, position, section, type, education, phone, years]
    toV7Row(e) { const c = NS.calc, kind = c.employmentType(e.employee_id); return [e.employee_id, e.name_km, e.name_en, e.gender, c.age(e.dob) != null ? c.age(e.dob) : e.age_imported != null ? e.age_imported : "", e.position, e.section || e.unit_text, e.v7_type || (kind === "contract" ? "កិច្ចសន្យា" : "ក្របខណ្ឌ"), e.education_level, e.phone, String(c.yearsOfService(e) != null ? c.yearsOfService(e) : e.years_service_imported != null ? e.years_service_imported : "")]; },
    async rows(provider, ids) { const all = await provider.list("employees"); const pick = ids ? ids.map((i) => all.find((e) => e.employee_id === i)).filter(Boolean) : all; return pick.map(NS.legacy.toV7Row); },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
