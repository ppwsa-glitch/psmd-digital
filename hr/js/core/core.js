/* PRD-HR V8 — core: namespace, clock, config, calc, khmer text, validators.
   Classic script (no ES modules) so it also works from file://. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});

  /* ---------- clock: the ONLY source of "today" (no hard-coded dates) ---------- */
  let fixed = null;
  NS.clock = {
    today() { const d = fixed ? new Date(fixed) : new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); },
    nowISO() { return (fixed ? new Date(fixed) : new Date()).toISOString(); },
    freeze(isoDate) { fixed = isoDate ? new Date(isoDate + "T00:00:00") : null; },
  };

  /* ---------- config: every business rule is configurable; nothing official is assumed ---------- */
  NS.defaultConfig = () => ({
    retirement: { ageYears: 60, label: "តម្លៃលំនាំដើម (Default) — មិនមែនច្បាប់ផ្លូវការ", official: false },
    retirementWindowsYears: [1, 2, 3, 5],
    training: { annualTargetHours: 40, official: false },
    leave: { annualQuotaDays: 18, official: false },
    contractExpiryWarnDays: [30, 90],
    attendanceCodes: { // meaning NOT confirmed by HR yet -> 'unspecified'
      "ü": { category: "unspecified", label: "ü = ✓ (សញ្ញា Wingdings; អត្ថន័យមិនទាន់បញ្ជាក់)" },
      "N": { category: "unspecified", label: "N (មិនទាន់កំណត់)" },
    },
    idPrefixTypes: { "": "permanent", C: "contract", T: "trial" }, // confirmed by user
    publicHolidays: [],
    pii: ["address", "blood_type", "national_id_no", "phone", "email", "id_card_expiry"],
  });

  /* ---------- date helpers (UTC, date-only) ---------- */
  function toDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return isNaN(v) ? null : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
    if (typeof v === "number") { const d = new Date(Math.round((v - 25569) * 86400000)); return isNaN(d) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
    if (m) { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCMonth() === +m[2] - 1 ? d : null; }
    return null;
  }
  const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
  const addYears = (d, n) => { const r = new Date(d); r.setUTCFullYear(r.getUTCFullYear() + n); if (r.getUTCMonth() !== d.getUTCMonth()) r.setUTCDate(0); return r; };
  const yearsBetween = (a, b) => { let y = b.getUTCFullYear() - a.getUTCFullYear(); const m = b.getUTCMonth() - a.getUTCMonth(); if (m < 0 || (m === 0 && b.getUTCDate() < a.getUTCDate())) y--; return y; };

  /* ---------- calc: single place for derived values (origin: calculated) ---------- */
  NS.calc = {
    age(dob, ref) { const d = toDate(dob); return d ? yearsBetween(d, ref || NS.clock.today()) : null; },
    ageGroup(age) { if (age == null) return null; return age < 25 ? "<25" : age < 35 ? "25–34" : age < 45 ? "35–44" : age < 55 ? "45–54" : "55+"; },
    firstServiceDate(e) { const ds = [e.start_framework, e.start_probation, e.start_contract, e.start_intern].map(toDate).filter(Boolean); return ds.length ? new Date(Math.min(...ds)) : null; },
    yearsOfService(e, ref) { const f = NS.calc.firstServiceDate(e); return f ? yearsBetween(f, ref || NS.clock.today()) : null; },
    retirementDate(e, cfg) { const d = toDate(e.dob); return d ? addYears(d, (cfg || NS.defaultConfig()).retirement.ageYears) : null; },
    yearsUntilRetirement(e, cfg, ref) { const r = NS.calc.retirementDate(e, cfg); if (!r) return null; return +((r - (ref || NS.clock.today())) / 31557600000).toFixed(2); },
    employmentType(employeeId, cfg) { const m = /^PPWSA-(?:([A-Z])-)?\d+$/.exec(employeeId || ""); if (!m) return null; return (cfg || NS.defaultConfig()).idPrefixTypes[m[1] || ""] || "unknown"; },
    serviceBand(y) { return y == null ? null : y < 5 ? "<5" : y < 10 ? "5–9" : y < 20 ? "10–19" : y < 30 ? "20–29" : "30+"; },
    avg(nums) { const v = nums.filter((x) => typeof x === "number"); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; },
    workingDays(from, to, holidays) { const a = toDate(from), b = toDate(to); if (!a || !b || b < a) return 0; let n = 0; const h = new Set(holidays || []); for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w && w < 6 && !h.has(iso(d))) n++; } return n; },
  };
  NS.dates = { toDate, iso, addYears, yearsBetween };

  /* ---------- khmer text normalisation ---------- */
  const ZW = /[\u200b\u200c\u200d\u2060\ufeff]/g;
  NS.text = {
    clean(s) { return s == null ? s : String(s).replace(ZW, "").replace(/\s+/g, " ").trim(); },
    key(s) { return s == null ? "" : String(s).replace(ZW, "").replace(/\u17d0/g, "").replace(/\s+/g, " ").trim().toLowerCase(); },
    province(s) { s = NS.text.clean(s); if (!s) return s; s = s.replace("កណ្ដាល", "កណ្តាល"); return s === "ភ្នំពេញ" ? "រាជធានីភ្នំពេញ" : s; },
  };

  /* ---------- validators (centralised) ---------- */
  const ID_RE = /^PPWSA-(?:[CT]-)?\d{3,4}$/;
  NS.validators = {
    ID_RE,
    normalizeId(v) { return v == null ? "" : String(v).replace(ZW, "").replace(/\s+/g, "").toUpperCase(); },
    isValidId(v) { return ID_RE.test(v); },
    employee(e, ctx) {
      const errors = [], warnings = [], today = (ctx && ctx.today) || NS.clock.today();
      const id = e.employee_id || "";
      if (!id) errors.push({ code: "ID_MISSING", msg: "គ្មាន Employee ID" });
      else if (!ID_RE.test(id)) errors.push({ code: "ID_FORMAT", msg: "ទម្រង់ ID មិនត្រឹមត្រូវ: " + id });
      if (!e.name_km) errors.push({ code: "NAME_MISSING", msg: "គ្មានឈ្មោះខ្មែរ" });
      if (e.gender && !["ប្រុស", "ស្រី"].includes(e.gender)) errors.push({ code: "GENDER", msg: "ភេទមិនស្គាល់: " + e.gender });
      if (!e.gender) warnings.push({ code: "GENDER_EMPTY", msg: "គ្មានភេទ" });
      const dob = toDate(e.dob);
      if (e.dob && !dob) errors.push({ code: "DOB_INVALID", msg: "ថ្ងៃកំណើតមិនត្រឹមត្រូវ" });
      else if (dob && dob > today) errors.push({ code: "DOB_FUTURE", msg: "ថ្ងៃកំណើតនៅអនាគត" });
      else if (!dob) warnings.push({ code: "DOB_EMPTY", msg: "គ្មានថ្ងៃកំណើត" });
      for (const k of ["start_framework", "start_probation", "start_contract", "start_intern", "id_card_expiry"])
        if (e[k] != null && e[k] !== "" && !toDate(e[k])) errors.push({ code: "DATE_INVALID", msg: k + " មិនត្រឹមត្រូវ" });
      if (!e.education_level) warnings.push({ code: "EDU_EMPTY", msg: "គ្មានកម្រិតវប្បធម៌" });
      return { errors, warnings };
    },
    score(v) { return typeof v === "number" && v >= 0 && v <= 100; },
    dateRange(from, to) { const a = toDate(from), b = toDate(to); return !!a && !!b && b >= a; },
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
