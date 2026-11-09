/* PRD-HR V8 — Excel import engine.
   Pipeline: workbook -> detect sheets -> map columns (by header text, never by fixed position) -> parse -> validate
             -> preview (nothing written) -> commit (explicit confirmation, audit, import job) -> error CSV.
   Input is a plain "workbook" {fileName, sheets:[{name, rows:[[cell,…]], rowOffset}]} so the engine is testable
   without SheetJS; fromSheetJS() adapts a SheetJS workbook. The original file is never modified (only a SHA-256 is kept). */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});
  const { text, dates, validators, calc } = NS;
  const K = (s) => text.key(s);
  const isInt = (v) => typeof v === "number" && Number.isInteger(v);
  const str = (v) => (typeof v === "string" ? text.clean(v) : v == null ? null : typeof v === "number" ? String(v) : v instanceof Date ? v : String(v));
  const cellText = (v) => (v == null ? "" : v instanceof Date ? "" : String(v));
  const MONTHS = ["មករា", "កុម្ភៈ", "មីនា", "មេសា", "ឧសភា", "មិថុនា", "កក្កដា", "សីហា", "កញ្ញា", "តុលា", "វិច្ឆិកា", "ធ្នូ"];
  const KH_DIGITS = "០១២៣៤៥៦៧៨៩";
  const khNum = (s) => Number([...String(s)].map((c) => (KH_DIGITS.includes(c) ? KH_DIGITS.indexOf(c) : c)).join(""));
  const WEEKDAY = { sun: 0, su: 0, m: 1, mo: 1, tu: 2, w: 3, we: 3, th: 4, f: 5, fr: 5, s: 6, sa: 6 };

  /* ---- registry column spec: ordered, most specific first; each column is claimed by at most one field ---- */
  const REG = [
    ["row_no", { exact: "ល.រ" }], ["seq_in_unit", { has: ["លរ", "លំដាប់"] }], ["employee_id", { has: ["លេខ", "កូដ"] }],
    ["id_card_expiry", { has: ["ផុតកំណត់"] }], ["id_photo_ref", { has: ["រូបថត", "id"] }], ["photo_ref", { has: ["រូបថត"] }],
    ["staff_class", { has: ["ប្រភេទនៃបុគ្គលិក"] }], ["retirement_date_imported", { has: ["និវត្តន៍"] }],
    ["years_service_imported", { has: ["រយៈពេលបម្រើការងារ"] }],
    ["start_framework", { has: ["ថ្ងៃចូលបម្រើ", "ក្របខណ្ឌ"] }], ["start_probation", { has: ["ថ្ងៃចូលបម្រើ", "សាកល្បង"] }],
    ["start_contract", { has: ["ថ្ងៃចូលបម្រើ", "កិច្ចសន្យា"] }], ["start_intern", { has: ["ថ្ងៃចូលបម្រើ", "ហាត់ការ"] }],
    ["equivalent_rank", { has: ["ឋានៈស្មើ"] }], ["framework", { exact: "ក្របខណ្ឌ" }], ["rank_grade_date", { has: ["កាំ"] }],
    ["unit_text", { has: ["នាយកដ្ឋាន/អង្គភាព"] }], ["national_id_no", { has: ["អត្តសញ្ញាណប័ណ្ណ"] }], ["phone", { has: ["ទូរស័ព្ទ"] }], ["email", { has: ["email"] }],
    ["blood_type", { has: ["ប្រភេទឈាម"] }], ["address", { has: ["ទីលំនៅ"] }], ["place_of_birth", { has: ["ទីកន្លែងកំណើត"] }], ["dob", { has: ["ថ្ងៃខែឆ្នាំកំណើត"] }],
    ["age_imported", { has: ["អាយុ"] }], ["marital_raw", { has: ["marital"] }], ["gender", { exact: "ភេទ" }], ["name_km", { has: ["គោត្តនាម"] }],
    ["name_en", { has: ["english name"] }], ["col_j_unlabeled", { has: ["col_j"] }], ["education_level", { has: ["កំរិតវប្បធម៌"] }],
    ["major_text", { exact: "ជំនាញ" }], ["position", { exact: "តួនាទី" }], ["section", { exact: "ផ្នែក" }], ["remarks", { exact: "ផ្សេងៗ" }],
  ];
  const DATE_F = ["dob", "id_card_expiry", "start_framework", "start_probation", "start_contract", "start_intern", "rank_grade_date", "retirement_date_imported"];
  const matches = (label, m) => (m.exact ? label === K(m.exact) : m.has.every((h) => label.includes(K(h))));

  function mapLabels(labels) { // labels: array (index-aligned). returns {fieldToCol, unmapped:[{col,label}]}
    const f2c = {}, used = new Set();
    labels.forEach((lab, i) => { const k = K(lab); if (!k) return; for (const [f, m] of REG) if (!(f in f2c) && matches(k, m)) { f2c[f] = i; used.add(i); break; } });
    if ("name_km" in f2c && !("name_en" in f2c) && !K(labels[f2c.name_km + 1])) { f2c.name_en = f2c.name_km + 1; used.add(f2c.name_en); }
    if ("age_imported" in f2c && !("col_j_unlabeled" in f2c) && !K(labels[f2c.age_imported + 1])) { f2c.col_j_unlabeled = f2c.age_imported + 1; used.add(f2c.col_j_unlabeled); }
    const unmapped = []; labels.forEach((lab, i) => { if (K(lab) && !used.has(i) && K(lab) !== "data_origin") unmapped.push({ col: i, label: text.clean(lab) }); });
    return { fieldToCol: f2c, unmapped };
  }
  const colLetter = (i) => { let s = ""; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

  /* two-row header -> combined labels (group label inherited only where the sub-row has its own label) */
  function combinedLabels(rows, h, twoRow, width) {
    const out = []; let group = "";
    for (let c = 0; c < width; c++) {
      const top = text.clean(cellText(rows[h][c])), sub = twoRow ? text.clean(cellText(rows[h + 1][c])) : "";
      if (top) group = top; else if (!sub) group = group && "";
      out.push(top && sub ? top + " " + sub : top || (sub ? (group ? group + " " + sub : sub) : ""));
    }
    return out;
  }

  /* ---------------- sheet detection ---------------- */
  function detectSheet(sh) {
    const rows = sh.rows, lim = Math.min(rows.length, 25);
    for (let r = 0; r < lim; r++) {
      const cells = (rows[r] || []).map((c) => K(cellText(c)));
      const joined = cells.join("|");
      if (cells.some((c) => /^20\d\d_q1$/.test(c)) && joined.includes("employee id")) return { kind: "flat-performance", headerRow: r };
      if (cells.includes("d01") && cells.includes("d31")) return { kind: "flat-attendance", headerRow: r };
      if (joined.includes(K("ព្រឹត្តិប័ត្រពិន្ទុ"))) return { kind: "performance", headerRow: r };
      const wd = cells.filter((c) => c in WEEKDAY).length; if (wd >= 14) return { kind: "attendance", headerRow: r + 1, weekdayRow: r };
      if (joined.includes(K("គោត្តនាម")) && joined.includes(K("ថ្ងៃខែឆ្នាំកំណើត"))) {
        const nxt = (rows[r + 1] || []).map((c) => K(cellText(c))).join("|");
        return { kind: "registry", headerRow: r, twoRow: /សាកល្បង|កិច្ចសន្យា|ហាត់ការ/.test(nxt) };
      }
    }
    return { kind: "unknown" };
  }
  const detect = (wb) => wb.sheets.map((s) => Object.assign({ sheet: s.name }, detectSheet(s)));

  /* ---------------- parsers ---------------- */
  const mkIssue = (sheet, row, id, severity, code, msg) => ({ sheet, row, employee_id: id || "", severity, code, msg });

  function recordFromCells(get, f2c, isDemo) {
    const e = {};
    for (const [f, c] of Object.entries(f2c)) {
      if (["row_no", "seq_in_unit", "age_imported", "employee_id", "photo_ref", "id_photo_ref"].includes(f) && f !== "employee_id") continue;
      const v = get(c);
      if (DATE_F.includes(f)) { const d = dates.toDate(v); e[f] = dates.iso(d); if (v != null && v !== "" && !d) e[f + "__raw"] = String(v); }
      else if (f === "years_service_imported") e[f] = typeof v === "number" ? v : null;
      else if (f === "col_j_unlabeled") e[f] = typeof v === "number" ? v : null;
      else if (f === "employee_id") e.employee_id = validators.normalizeId(v);
      else if (f === "place_of_birth") e[f] = text.province(v);
      else if (f === "national_id_no" || f === "phone") e[f] = v == null || v === "" ? null : String(v);
      else if (typeof v === "string") e[f] = text.clean(v) || null; else e[f] = v == null || v === "" ? null : v;
    }
    return e;
  }

  function parseRegistry(sh, d) {
    const rows = sh.rows, issues = [], recs = [], off = sh.rowOffset || 0;
    const width = Math.max(...rows.slice(d.headerRow, d.headerRow + 2).map((r) => (r || []).length));
    const labels = combinedLabels(rows, d.headerRow, d.twoRow, width), { fieldToCol: f2c, unmapped } = mapLabels(labels);
    for (const need of ["employee_id", "name_km"]) if (!(need in f2c)) issues.push(mkIssue(sh.name, d.headerRow + 1 + off, "", "error", "COLUMN_MISSING", "រកមិនឃើញ Column: " + need));
    let group = null; const start = d.headerRow + (d.twoRow ? 2 : 1);
    for (let r = start; r < rows.length; r++) {
      const row = rows[r] || [], get = (c) => row[c];
      const rn = get(f2c.row_no !== undefined ? f2c.row_no : 0), nm = f2c.name_km !== undefined ? get(f2c.name_km) : null;
      if (typeof rn === "string" && text.clean(rn) && !(typeof nm === "string" && text.clean(nm))) { const t = text.clean(rn); if (!/^-?មន្ត្រី|សរុប/.test(t)) group = t; continue; }
      if (!isInt(rn) || typeof nm !== "string" || !text.clean(nm)) continue;
      const e = recordFromCells(get, f2c); e.unit_group = group; e.source = { sheet: sh.name, row: r + 1 + off, raw_id: cellText(get(f2c.employee_id)) };
      e.origin = K(cellText(get(labels.findIndex((l) => K(l) === "data_origin")))) === "demo" ? "demo" : "imported";
      recs.push(e);
    }
    return { kind: "registry", mapping: { fields: Object.fromEntries(Object.entries(f2c).map(([f, c]) => [f, colLetter(c) + " «" + labels[c] + "»"])), unmapped: unmapped.map((u) => ({ column: colLetter(u.col), label: u.label })) }, records: recs, issues };
  }

  function blockColumns(rows, h, width) { // performance sheet: group (row h) + sub (row h+1)
    const cols = []; let group = "", gStart = 0; const seen = {}, occAt = {};
    for (let c = 0; c < width; c++) {
      const top = text.clean(cellText(rows[h][c])), sub = rows[h + 1][c], subS = text.clean(cellText(sub));
      if (top) { group = top; gStart = c; const m = /ព្រឹត្តិប័ត្រពិន្ទុ\s*(\d{4})/.exec(top.replace(/\s/g, "")); if (m) { seen[m[1]] = (seen[m[1]] || 0) + 1; occAt[c] = seen[m[1]]; } }
      const gm = /ព្រឹត្តិប័ត្រពិន្ទុ\s*(\d{4})/.exec(group.replace(/\s/g, ""));
      const occ = occAt[gStart] || 1;
      if (gm) { const p = /^q([1-4])$/i.exec(subS); if (p) cols[c] = { type: "score", year: +gm[1], period: "Q" + p[1], variant: occ > 1 ? "alt" : "primary" }; else if (K(subS).startsWith(K("សរុប"))) cols[c] = { type: "score", year: +gm[1], period: "Total", variant: occ > 1 ? "alt" : "primary" }; else if (K(subS).startsWith(K("ចំនាត់ថ្នាក់")) || K(subS).startsWith(K("ចំណាត់ថ្នាក់"))) cols[c] = { type: "grade", year: +gm[1], period: "Rank", variant: occ > 1 ? "alt" : "primary" }; else cols[c] = null; continue; }
      if (group.includes("ជនឆ្នើម")) { cols[c] = isInt(sub) ? { type: "outstanding", year: sub } : null; continue; }
      if (group.includes("មេដាយ")) { cols[c] = isInt(sub) ? { type: "medal", year: sub } : null; continue; }
      const ly = /ច្បាប់ឆ្នាំ\s*([០-៩]{4})/.exec(group.replace(/\s/g, ""));
      if (ly) { const mi = MONTHS.findIndex((m) => K(subS).startsWith(K(m).slice(0, 3))); cols[c] = mi >= 0 ? { type: "leave", year: khNum(ly[1]), month: mi + 1 } : null; continue; }
      cols[c] = null;
    }
    return cols;
  }

  function parsePerformance(sh, d) {
    const rows = sh.rows, off = sh.rowOffset || 0, issues = [], out = { scores: [], awards: [], medals: [], leaves: [] };
    const width = Math.max(...rows.slice(d.headerRow, d.headerRow + 2).map((r) => (r || []).length));
    const cols = blockColumns(rows, d.headerRow, width);
    const labels = (rows[d.headerRow] || []).map(cellText); const idC = labels.findIndex((l) => K(l).includes(K("លេខ")) && K(l).includes(K("កូដ"))), nmC = labels.findIndex((l) => K(l).includes(K("គោត្តនាម")));
    if (idC < 0) issues.push(mkIssue(sh.name, d.headerRow + 1 + off, "", "error", "COLUMN_MISSING", "រកមិនឃើញ Column Employee ID"));
    const seenId = {}; out.idNames = {};
    for (let r = d.headerRow + 2; r < rows.length; r++) {
      const row = rows[r] || [], rn = row[0], nm = row[nmC];
      if (!isInt(rn) || typeof nm !== "string") continue;
      const raw = cellText(row[idC]), id = validators.normalizeId(raw), at = r + 1 + off;
      if (!id || !validators.isValidId(id)) { issues.push(mkIssue(sh.name, at, id, "error", id ? "ID_FORMAT" : "ID_MISSING", "ID មិនត្រឹមត្រូវ/ទទេ: «" + raw + "» (" + text.clean(nm) + ")")); continue; }
      if (seenId[id]) { issues.push(mkIssue(sh.name, at, id, "error", "ID_DUPLICATE", "ID ស្ទួនក្នុង Sheet (ជួរ " + seenId[id] + ")")); continue; } seenId[id] = at; out.idNames[id] = { name: text.clean(nm), sheet: sh.name, row: at };
      const byKey = {};
      cols.forEach((cd, c) => {
        if (!cd) return; const v = row[c];
        if (cd.type === "score" || cd.type === "grade") { if (v == null || v === "") return;
          if (cd.type === "score" && typeof v === "string" && /មាតុភាព/.test(v)) { out.scores.push({ id: [id, cd.year, cd.period, cd.variant].join("|"), employee_id: id, year: cd.year, period: cd.period, variant: cd.variant, score: null, grade: null, status: "maternity_leave", status_raw: text.clean(v), origin: "imported", source: { sheet: sh.name, row: at } }); return; }
          if (cd.type === "score" && !validators.score(v)) { issues.push(mkIssue(sh.name, at, id, "error", "SCORE_INVALID", `ពិន្ទុមិនត្រឹមត្រូវ (${colLetter(c)}): ${v}`)); return; }
          out.scores.push({ id: [id, cd.year, cd.period, cd.variant].join("|"), employee_id: id, year: cd.year, period: cd.period, variant: cd.variant, score: cd.type === "score" ? v : null, grade: cd.type === "grade" ? String(v) : null, origin: "imported", source: { sheet: sh.name, row: at } }); (byKey[cd.year + cd.variant] = byKey[cd.year + cd.variant] || {})[cd.period] = v; }
        else if (cd.type === "outstanding" && v != null && v !== "") out.awards.push({ id: [id, "outstanding", cd.year].join("|"), employee_id: id, award_type: "outstanding", year: cd.year, origin: "imported", source: { sheet: sh.name, row: at } });
        else if (cd.type === "medal" && typeof v === "number" && v > 0) out.medals.push({ id: [id, cd.year].join("|"), employee_id: id, year: cd.year, count: v, medal_type: null, origin: "imported", source: { sheet: sh.name, row: at } });
        else if (cd.type === "leave" && typeof v === "number") out.leaves.push({ id: [id, "leave", cd.year, cd.month].join("|"), employee_id: id, kind: "imported_monthly_summary", year: cd.year, month: cd.month, days: v, leave_type: "unspecified", origin: "imported", source: { sheet: sh.name, row: at } });
      });
      for (const [k, q] of Object.entries(byKey)) { const qs = ["Q1", "Q2", "Q3", "Q4"].map((p) => q[p]).filter((x) => typeof x === "number"); if (q.Total != null && qs.length && Math.abs(calc.avg(qs) - q.Total) > 0.011) issues.push(mkIssue(sh.name, at, id, "warning", "TOTAL_MISMATCH", `សរុប ${k} (${q.Total}) ≠ មធ្យម Q (${calc.avg(qs)})`)); }
    }
    return { kind: "performance", records: out, issues, mapping: { blocks: [...new Set(cols.filter((c) => c && c.type === "score").map((c) => c.year + "/" + c.variant))] } };
  }

  function inferPeriod(sheetName, override) {
    if (override && override.year && override.month) return Object.assign({ source: "user" }, override);
    const n = text.clean(sheetName), mi = MONTHS.findIndex((m) => n.includes(m.slice(0, 3))), y = /-(\d{2})\s*$/.exec(n);
    return mi >= 0 && y ? { year: 2000 + +y[1], month: mi + 1, source: "sheet-name" } : null;
  }
  function attendanceRecords(sh, rowsIter, period, issues, cfg) {
    const recs = []; let employees = 0, marks = 0;
    for (const { id, at, marksByDay } of rowsIter) {
      let any = false;
      for (const [day, v] of Object.entries(marksByDay)) {
        if (v == null || v === "") continue; const date = dates.iso(new Date(Date.UTC(period.year, period.month - 1, +day)));
        const code = String(v).trim(), meta = cfg.attendanceCodes[code] || { category: "unspecified" };
        recs.push({ id: id + "|" + date, employee_id: id, date, code_raw: code, category: meta.category, origin: "imported", source: { sheet: sh.name, row: at } }); marks++; any = true;
      }
      if (any) employees++;
    }
    return { recs, employees, marks };
  }
  function parseAttendance(sh, d, opts) {
    const rows = sh.rows, off = sh.rowOffset || 0, issues = [], cfg = (opts && opts.config) || NS.defaultConfig();
    const wdRow = rows[d.weekdayRow], numRow = rows[d.headerRow]; const dayCols = {};
    (numRow || []).forEach((v, c) => { if (isInt(v) && v >= 1 && v <= 31) dayCols[v] = c; });
    const period = inferPeriod(sh.name, opts && opts.attendancePeriod);
    if (!period) { issues.push(mkIssue(sh.name, d.headerRow + 1 + off, "", "error", "PERIOD_UNKNOWN", "មិនអាចកំណត់ខែ/ឆ្នាំ — សូមបញ្ជាក់ attendancePeriod")); return { kind: "attendance", records: [], issues, mapping: {} }; }
    const lab = (c) => K(cellText(wdRow[c])), wd1 = WEEKDAY[lab(dayCols[1])], real = new Date(Date.UTC(period.year, period.month - 1, 1)).getUTCDay();
    if (wd1 !== undefined && wd1 !== real) { issues.push(mkIssue(sh.name, d.weekdayRow + 1 + off, "", "error", "PERIOD_MISMATCH", `ថ្ងៃទី 1 ក្នុង Sheet ជា «${cellText(wdRow[dayCols[1]])}» មិនត្រូវនឹង ${period.month}/${period.year}`)); return { kind: "attendance", records: [], issues, mapping: {} }; }
    const idC = (numRow || []).findIndex((l) => K(cellText(l)).includes(K("កូដ")));
    const it = [], seen = {}, idNames = {};
    for (let r = d.headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || []; if (!isInt(row[0]) || typeof row[3] !== "string") continue;
      const raw = cellText(row[idC]), id = validators.normalizeId(raw), at = r + 1 + off;
      if (!validators.isValidId(id)) { issues.push(mkIssue(sh.name, at, id, "error", id ? "ID_FORMAT" : "ID_MISSING", "ID មិនត្រឹមត្រូវ/ទទេ: «" + raw + "»")); continue; }
      if (seen[id]) { issues.push(mkIssue(sh.name, at, id, "error", "ID_DUPLICATE", "ID ស្ទួនក្នុង Sheet")); continue; } seen[id] = 1; idNames[id] = { name: text.clean(row[3]), sheet: sh.name, row: at };
      const m = {}; for (const [day, c] of Object.entries(dayCols)) m[day] = row[c]; it.push({ id, at, marksByDay: m });
    }
    const r = attendanceRecords(sh, it, period, issues, cfg);
    return { kind: "attendance", records: r.recs, idNames, issues, period, stats: { employeeRows: it.length, employeesWithMarks: r.employees, cells: r.marks }, mapping: { period, dayColumns: Object.keys(dayCols).length } };
  }

  function parseFlatPerformance(sh, d) {
    const rows = sh.rows, off = sh.rowOffset || 0, issues = [], hdr = rows[d.headerRow].map((c) => text.clean(cellText(c))), out = { scores: [], awards: [], medals: [], leaves: [] };
    const idC = hdr.findIndex((h) => K(h) === "employee id"), oC = hdr.findIndex((h) => h.startsWith("ជនឆ្នើម")), mC = hdr.findIndex((h) => h.startsWith("មេដាយ"));
    for (let r = d.headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || []; if (!row[idC]) continue; const id = validators.normalizeId(row[idC]), at = r + 1 + off;
      if (!validators.isValidId(id)) { issues.push(mkIssue(sh.name, at, id, "error", "ID_FORMAT", "ID មិនត្រឹមត្រូវ")); continue; }
      const src = { sheet: sh.name, row: at }, origin = "demo";
      hdr.forEach((h, c) => { const v = row[c]; if (v == null || v === "") return; let m;
        if ((m = /^(\d{4})_(Q[1-4]|Total)/i.exec(h))) { if (!validators.score(v)) { issues.push(mkIssue(sh.name, at, id, "error", "SCORE_INVALID", h + ": " + v)); return; } const p = /total/i.test(m[2]) ? "Total" : m[2].toUpperCase(); out.scores.push({ id: [id, m[1], p, "primary"].join("|"), employee_id: id, year: +m[1], period: p, variant: "primary", score: v, grade: null, origin, source: src }); }
        else if ((m = /^(\d{4})_Grade/i.exec(h))) out.scores.push({ id: [id, m[1], "Rank", "primary"].join("|"), employee_id: id, year: +m[1], period: "Rank", variant: "primary", score: null, grade: String(v), origin, source: src });
        else if ((m = /^ច្បាប់(\d{4})_សរុប/.exec(h)) && typeof v === "number") out.leaves.push({ id: [id, "leave", m[1], "total"].join("|"), employee_id: id, kind: "imported_year_total", year: +m[1], month: null, days: v, leave_type: "unspecified", origin, source: src }); });
      if (oC >= 0 && row[oC]) String(row[oC]).split(";").forEach((y) => out.awards.push({ id: [id, "outstanding", y].join("|"), employee_id: id, award_type: "outstanding", year: +y, origin, source: src }));
      if (mC >= 0 && row[mC]) String(row[mC]).split(";").forEach((y) => out.medals.push({ id: [id, y].join("|"), employee_id: id, year: +y, count: 1, medal_type: null, origin, source: src }));
    }
    return { kind: "performance", records: out, issues, mapping: { flat: true } };
  }
  function parseFlatAttendance(sh, d, opts) {
    const rows = sh.rows, off = sh.rowOffset || 0, issues = [], cfg = (opts && opts.config) || NS.defaultConfig(), hdr = rows[d.headerRow].map((c) => K(cellText(c)));
    const period = inferPeriod(sh.name, opts && opts.attendancePeriod);
    if (!period) { issues.push(mkIssue(sh.name, d.headerRow + 1 + off, "", "error", "PERIOD_UNKNOWN", "មិនអាចកំណត់ខែ/ឆ្នាំ")); return { kind: "attendance", records: [], issues, mapping: {} }; }
    const idC = hdr.indexOf("employee id"), dayCols = {}; hdr.forEach((h, c) => { const m = /^d(\d\d)$/.exec(h); if (m) dayCols[+m[1]] = c; });
    const it = [], seen = {};
    for (let r = d.headerRow + 1; r < rows.length; r++) { const row = rows[r] || []; if (!row[idC]) continue; const id = validators.normalizeId(row[idC]), at = r + 1 + off;
      if (!validators.isValidId(id)) { issues.push(mkIssue(sh.name, at, id, "error", "ID_FORMAT", "ID មិនត្រឹមត្រូវ")); continue; } if (seen[id]) { issues.push(mkIssue(sh.name, at, id, "error", "ID_DUPLICATE", "ID ស្ទួន")); continue; } seen[id] = 1;
      const m = {}; for (const [day, c] of Object.entries(dayCols)) m[day] = row[c]; it.push({ id, at, marksByDay: m }); }
    const r = attendanceRecords(sh, it, period, issues, cfg);
    return { kind: "attendance", records: r.recs, issues, period, stats: { employeeRows: it.length, employeesWithMarks: r.employees, cells: r.marks }, mapping: { flat: true, period } };
  }

  /* ---------------- preview ---------------- */
  async function sha256(buf) { try { const h = await crypto.subtle.digest("SHA-256", buf); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join(""); } catch (e) { return null; } }
  const maskedSample = (recs, n) => recs.slice(0, n).map((r) => NS.policy.mask({ role: "employee" }, r));

  class ImportService {
    constructor(provider, audit, cfg) { this.p = provider; this.audit = audit; this.cfg = cfg || NS.defaultConfig(); }
    detect(wb) { return detect(wb); }
    async preview(wb, opts) {
      opts = Object.assign({ config: this.cfg }, opts || {}); const det = detect(wb), sheets = [], issues = [];
      const parsed = { registry: [], performance: [], attendance: [] };
      for (const d of det) {
        const sh = wb.sheets.find((s) => s.name === d.sheet); if (d.kind === "unknown") { sheets.push({ sheet: d.sheet, kind: "unknown", note: "មិនស្គាល់ — មិននាំចូល" }); continue; }
        const res = d.kind === "registry" ? parseRegistry(sh, d) : d.kind === "performance" ? parsePerformance(sh, d) : d.kind === "attendance" ? parseAttendance(sh, d, opts) : d.kind === "flat-performance" ? parseFlatPerformance(sh, d) : parseFlatAttendance(sh, d, opts);
        parsed[res.kind].push(res); issues.push(...res.issues);
        sheets.push({ sheet: d.sheet, kind: d.kind, mapping: res.mapping, stats: res.stats || null, rows: Array.isArray(res.records) ? res.records.length : undefined });
      }
      /* registry validation */
      const reg = parsed.registry.flatMap((r) => r.records), idCount = {}, res = opts.resolutions || {}, valid = [], blocked = [], active = [];
      for (const e of reg) { // 1) apply HR resolutions first, 2) then count duplicates on the resolved IDs
        const rz = res[e.source.sheet + "|" + e.source.row];
        if (rz && rz.skip) { issues.push(mkIssue(e.source.sheet, e.source.row, e.employee_id, "warning", "SKIPPED_BY_HR", "HR សម្រេចរំលង")); continue; }
        if (rz && rz.employee_id) e.employee_id = validators.normalizeId(rz.employee_id);
        active.push(e); if (e.employee_id) idCount[e.employee_id] = (idCount[e.employee_id] || 0) + 1;
      }
      for (const e of active) {
        const v = validators.employee(e), errs = v.errors.slice();
        if (e.employee_id && idCount[e.employee_id] > 1) errs.push({ code: "ID_DUPLICATE", msg: "ID ស្ទួនក្នុង File (" + idCount[e.employee_id] + " ជួរ) — HR ត្រូវសម្រេច" });
        errs.forEach((x) => issues.push(mkIssue(e.source.sheet, e.source.row, e.employee_id || e.source.raw_id, "error", x.code, x.msg + " — " + (e.name_km || ""))));
        v.warnings.forEach((x) => issues.push(mkIssue(e.source.sheet, e.source.row, e.employee_id, "warning", x.code, x.msg)));
        (errs.length ? blocked : valid).push(e);
      }
      /* ID set for foreign-key checks: valid registry in file + already in DB */
      const dbIds = new Set((await this.p.list("employees")).map((e) => e.employee_id)), known = new Set([...valid.map((e) => e.employee_id), ...dbIds]);
      const dupIds = new Set(Object.keys(idCount).filter((k) => idCount[k] > 1 && !valid.some((v) => v.employee_id === k)));
      const orphans = {}, keep = { scores: [], awards: [], medals: [], leaves: [], attendance: [] };
      const fk = (rec, kind) => { if (known.has(rec.employee_id) || opts.allowOrphans) return keep[kind].push(rec); (orphans[rec.employee_id] = orphans[rec.employee_id] || { rec, kinds: new Set() }).kinds.add(kind); };
      parsed.performance.forEach((p) => { p.records.scores.forEach((r) => fk(r, "scores")); p.records.awards.forEach((r) => fk(r, "awards")); p.records.medals.forEach((r) => fk(r, "medals")); p.records.leaves.forEach((r) => fk(r, "leaves")); });
      parsed.attendance.forEach((p) => p.records.forEach((r) => fk(r, "attendance")));
      for (const [id, o] of Object.entries(orphans)) issues.push(mkIssue(o.rec.source.sheet, o.rec.source.row, id, "error", dupIds.has(id) ? "ID_AMBIGUOUS" : "ORPHAN_ID", (dupIds.has(id) ? "ID ស្ទួនក្នុង Registry — មិនដឹងថាជាបុគ្គលណា មិននាំចូល (" : "Employee ID មិនមានក្នុង Registry — មិននាំចូល (") + [...o.kinds].join(",") + ")"));
      const regName = new Map(valid.map((v) => [v.employee_id, K(v.name_km)]));
      const names = Object.assign({}, ...parsed.performance.map((p) => p.records.idNames || {}), ...parsed.attendance.map((p) => p.idNames || {}));
      for (const [id, n] of Object.entries(names)) if (regName.has(id) && regName.get(id) !== K(n.name)) issues.push(mkIssue(n.sheet, n.row, id, "warning", "NAME_MISMATCH", "ឈ្មោះក្នុង Sheet នេះ ≠ ឈ្មោះក្នុង Registry សម្រាប់ ID ដូចគ្នា — សូមផ្ទៀងផ្ទាត់"));
      for (const p of parsed.attendance) if (p.stats && p.stats.employeeRows) { const f = p.stats.employeesWithMarks / p.stats.employeeRows; if (f < 0.5) issues.push(mkIssue(p.period ? "attendance" : "", 0, "", "warning", "ATTENDANCE_SPARSE", `ទិន្នន័យវត្តមានតិច: ${p.stats.employeesWithMarks}/${p.stats.employeeRows} នាក់ មានសញ្ញា (${p.stats.cells} ក្រឡា). ក្រឡាទទេ មិនរាប់ជាអវត្តមាន។`)); }
      const summary = { registryRows: reg.length, registryValid: valid.length, registryBlocked: blocked.length, orphanIds: Object.keys(orphans).length, performance: keep.scores.length, awards: keep.awards.length, medals: keep.medals.length, leaves: keep.leaves.length, attendance: keep.attendance.length,
        errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length };
      const pv = { jobId: NS.uid(), createdAt: NS.clock.nowISO(), fileName: wb.fileName || null, fileHash: wb.fileHash || null, fileSize: wb.fileSize || null, sheets, issues, summary, sample: maskedSample(valid, 5) };
      Object.defineProperty(pv, "_payload", { value: { valid, keep }, enumerable: false });
      return pv;
    }
    /* commit: needs explicit options. Existing records are NEVER overwritten unless opts.confirmOverwrite === true. */
    async commit(user, pv, opts) {
      NS.policy.assert(user, "import"); opts = Object.assign({ mode: "full", confirmOverwrite: false }, opts || {});
      if (!pv._payload) throw new Error("PREVIEW_PAYLOAD_MISSING — run preview() first");
      const { valid, keep } = pv._payload, S = { employees: { created: 0, updated: 0, skippedExisting: 0, skippedNotInDb: 0 }, other: {} };
      await this.p.put("import_jobs", { id: pv.jobId, file_name: pv.fileName, file_hash: pv.fileHash, created_by: user.id || user.role, created_at: pv.createdAt, status: "in_progress", original_file_modified: false }); // a crash mid-commit stays detectable
      const existing = new Map((await this.p.list("employees")).map((e) => [e.employee_id, e]));
      const toWrite = [];
      for (const e of valid) {
        const cur = existing.get(e.employee_id), rec = Object.assign({}, e); delete rec.source; rec.import_source = e.source; rec.import_job = pv.jobId;
        if (!cur) { if (opts.mode === "update-only") { S.employees.skippedNotInDb++; continue; } rec.created_at = NS.clock.nowISO(); rec.created_by = user.id || user.role; toWrite.push({ rec, create: true }); }
        else if (!opts.confirmOverwrite) S.employees.skippedExisting++;
        else { const merged = Object.assign({}, cur); const prev = {}, nxt = {}; for (const [k, v] of Object.entries(rec)) if (v != null && JSON.stringify(cur[k]) !== JSON.stringify(v) && !["import_job", "import_source", "origin"].includes(k)) { prev[k] = cur[k]; nxt[k] = v; merged[k] = v; } if (!Object.keys(nxt).length) continue; merged.updated_at = NS.clock.nowISO(); merged.updated_by = user.id || user.role; merged.import_job = pv.jobId; toWrite.push({ rec: merged, prev, nxt }); }
      }
      await this.p.putMany("employees", toWrite.map((w) => w.rec));
      for (const w of toWrite) { const redact = (o) => { const c = Object.assign({}, o); for (const k of this.cfg.pii) if (k in c) c[k] = "***"; return c; };
        if (w.create) { S.employees.created++; await this.audit.log({ user, action: "import-create", module: "import", employee_id: w.rec.employee_id, note: "job " + pv.jobId }); }
        else { S.employees.updated++; await this.audit.log({ user, action: "import-update", module: "import", employee_id: w.rec.employee_id, previous: redact(w.prev), next: redact(w.nxt), note: "job " + pv.jobId }); } }
      const stores = { scores: "performance_records", awards: "awards", medals: "medals", leaves: "leave_balances", attendance: "attendance_records" };
      for (const [kind, store] of Object.entries(stores)) {
        const have = new Set((await this.p.list(store)).map((r) => r.id)); const add = [], skip = []; for (const r of keep[kind]) (have.has(r.id) && !opts.confirmOverwrite ? skip : add).push(r);
        await this.p.putMany(store, add.map((r) => Object.assign({ import_job: pv.jobId }, r))); S.other[kind] = { written: add.length, skippedExisting: skip.length };
        if (add.length) await this.audit.log({ user, action: "import-bulk", module: "import:" + kind, note: `${add.length} records, job ${pv.jobId}` });
      }
      const job = { id: pv.jobId, file_name: pv.fileName, file_hash: pv.fileHash, file_size: pv.fileSize, mode: opts.mode, confirm_overwrite: !!opts.confirmOverwrite, created_by: user.id || user.role, created_at: pv.createdAt, committed_at: NS.clock.nowISO(), status: "committed", preview_summary: pv.summary, result: S, issues: pv.issues, original_file_modified: false };
      await this.p.put("import_jobs", job); await this.audit.log({ user, action: "import-commit", module: "import", note: JSON.stringify(S) });
      return { ok: true, jobId: pv.jobId, result: S };
    }
    errorsToCSV(pvOrJob) {
      const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
      return "\ufeff" + ["Sheet,Row,EmployeeID,Severity,Code,Message"].concat(pvOrJob.issues.map((i) => [i.sheet, i.row, i.employee_id, i.severity, i.code, i.msg].map(q).join(","))).join("\r\n");
    }
    /* SheetJS adapter: XLSX = global SheetJS, data = ArrayBuffer */
    static async fromSheetJS(XLSX, data, fileName) {
      const wb = XLSX.read(data, { type: "array", cellDates: true }), sheets = wb.SheetNames.map((n) => { const ws = wb.Sheets[n], rng = XLSX.utils.decode_range(ws["!ref"] || "A1"); return { name: n, rowOffset: rng.s.r, rows: XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true }) }; });
      return { fileName, fileSize: data.byteLength, fileHash: await sha256(data), sheets };
    }
  }
  NS.ImportService = ImportService; NS.importInternals = { mapLabels, detectSheet, REG };
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
