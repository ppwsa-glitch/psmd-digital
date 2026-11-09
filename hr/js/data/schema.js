/* PRD-HR V8 — data schema: 25 entities from the spec. Employee ID (employee_id) is the foreign key everywhere. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {});
  const fk = { name: "employee_id", keyPath: "employee_id" };
  const S = (name, keyPath, indexes, extra) => Object.assign({ name, keyPath, indexes: indexes || [] }, extra || {});
  NS.SCHEMA_VERSION = 1;
  NS.DB_NAME = "prdhr-v8";
  NS.schema = [
    S("employees", "employee_id", [{ name: "unit_text", keyPath: "unit_text" }, { name: "section", keyPath: "section" }, { name: "position", keyPath: "position" }, { name: "gender", keyPath: "gender" }]),
    S("departments", "id"), S("offices", "id", [{ name: "department_id", keyPath: "department_id" }]), S("positions", "id"),
    S("employment_history", "id", [fk]), S("education_records", "id", [fk]), S("qualifications", "id", [fk]),
    S("attendance_records", "id", [fk, { name: "date", keyPath: "date" }]),                 // id = employee_id|date
    S("leave_requests", "id", [fk]), S("leave_balances", "id", [fk]),
    S("performance_records", "id", [fk, { name: "year", keyPath: "year" }]),               // id = employee_id|year|period|variant
    S("performance_criteria", "id"),
    S("awards", "id", [fk, { name: "year", keyPath: "year" }]), S("medals", "id", [fk, { name: "year", keyPath: "year" }]),
    S("training_courses", "id"), S("training_participants", "id", [fk]),
    S("documents", "id", [fk]), S("notifications", "id", [fk]),
    S("users", "id"), S("roles", "id"), S("permissions", "id"), S("approval_workflows", "id"),
    S("audit_logs", "id", [{ name: "ts", keyPath: "ts" }, fk], { appendOnly: true }),
    S("import_jobs", "id"), S("system_settings", "key"),
  ];
  NS.schemaByName = Object.fromEntries(NS.schema.map((s) => [s.name, s]));
  NS.uid = () => (g.crypto && g.crypto.randomUUID ? g.crypto.randomUUID() : "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
