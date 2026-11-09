/* PRD-HR V8 — minimal dependency-free .xlsx writer (ZIP "stored", inline strings). Works offline; Excel/LibreOffice/openpyxl open it.
   PRDHR.xlsx.build([{name, rows:[[...]]}]) -> Uint8Array. First row of each sheet is styled bold. */
(function (g) {
  const NS = (g.PRDHR = g.PRDHR || {}), enc = new TextEncoder();
  const T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  const col = (i) => { let s = ""; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const safeName = (n, i) => (String(n || "Sheet" + (i + 1)).replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31).trim() || "Sheet" + (i + 1));
  function sheetXml(rows) {
    const widths = []; rows.forEach((r) => r.forEach((v, c) => { widths[c] = Math.min(60, Math.max(widths[c] || 8, String(v == null ? "" : v).length + 2)); }));
    const body = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, c) => { if (v == null || v === "") return ""; const ref = col(c) + (ri + 1), st = ri === 0 ? ' s="1"' : ""; return typeof v === "number" && isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`; }).join("") + "</row>").join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${body}</sheetData></worksheet>`;
  }
  function build(sheets) {
    const files = {}, n = sheets.length, X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    files["[Content_Types].xml"] = X + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
    files["_rels/.rels"] = X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    files["xl/workbook.xml"] = X + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
    files["xl/_rels/workbook.xml.rels"] = X + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    files["xl/styles.xml"] = X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
    sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows)));
    const parts = [], cen = []; let off = 0;
    for (const [name, text] of Object.entries(files)) {
      const nb = enc.encode(name), db = enc.encode(text), c = crc(db), lh = new Uint8Array(30 + nb.length), v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint32(14, c, true); v.setUint32(18, db.length, true); v.setUint32(22, db.length, true); v.setUint16(26, nb.length, true); lh.set(nb, 30);
      const ch = new Uint8Array(46 + nb.length), w = new DataView(ch.buffer); w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint32(16, c, true); w.setUint32(20, db.length, true); w.setUint32(24, db.length, true); w.setUint16(28, nb.length, true); w.setUint32(42, off, true); ch.set(nb, 46);
      parts.push(lh, db); cen.push(ch); off += lh.length + db.length;
    }
    const cl = cen.reduce((a, b) => a + b.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer); e.setUint32(0, 0x06054b50, true); e.setUint16(8, cen.length, true); e.setUint16(10, cen.length, true); e.setUint32(12, cl, true); e.setUint32(16, off, true);
    const all = [...parts, ...cen, end], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; all.forEach((b) => { out.set(b, p); p += b.length; }); return out;
  }
  NS.xlsx = { build };
})(typeof globalThis !== "undefined" ? globalThis : window);
if (typeof module !== "undefined") module.exports = globalThis.PRDHR;
