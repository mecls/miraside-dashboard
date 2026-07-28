/**
 * One-off connectivity + schema check for the Cold Calls Google Sheet.
 * Run: npx tsx scripts/verify-sheets.ts
 *
 * Confirms the service account (GOOGLE_SERVICE_ACCOUNT_KEY) can read the
 * "Portugal Leads" workbook, lists every tab title, and prints the header
 * row + a couple of sample rows from the target tab.
 */
import "dotenv/config";
import fs from "node:fs";
import { google } from "googleapis";

const SHEET_ID = "1R21Fyy88buu1HlLISoF11FpRYWmqRXiISt5ti6zGZzY";
const TARGET_TAB = "A - Leads (nº PT)";

function loadServiceAccount(): { client_email: string; private_key: string } {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").trim();
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set in the environment");
  let jsonStr = raw;
  if (!jsonStr.startsWith("{")) {
    // Maybe a file path…
    if (fs.existsSync(jsonStr)) {
      jsonStr = fs.readFileSync(jsonStr, "utf8");
    } else {
      // …or base64-encoded JSON
      const decoded = Buffer.from(jsonStr, "base64").toString("utf8").trim();
      if (decoded.startsWith("{")) jsonStr = decoded;
    }
  }
  const obj = JSON.parse(jsonStr);
  if (obj.private_key) obj.private_key = String(obj.private_key).replace(/\\n/g, "\n");
  if (!obj.client_email || !obj.private_key) {
    throw new Error("Parsed key is missing client_email / private_key");
  }
  return obj;
}

async function main() {
  const creds = loadServiceAccount();
  console.log("Service account:", creds.client_email);

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const titles = (meta.data.sheets || []).map((s) => s.properties?.title || "");
  console.log(`\nWorkbook: ${meta.data.properties?.title}`);
  console.log(`Tabs (${titles.length}):`);
  titles.forEach((t, i) => console.log(`  ${i + 1}. ${JSON.stringify(t)}`));

  const found = titles.find((t) => t === TARGET_TAB);
  console.log(`\nTarget tab ${JSON.stringify(TARGET_TAB)}: ${found ? "FOUND ✅" : "NOT FOUND ❌"}`);
  if (!found) {
    const close = titles.filter((t) => t.toLowerCase().includes("lead"));
    if (close.length) console.log("  Tabs containing 'lead':", close.map((t) => JSON.stringify(t)).join(", "));
    return;
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TARGET_TAB}'`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = res.data.values || [];
  const header = (rows[0] || []) as string[];
  console.log(`\nRows (incl. header): ${rows.length}  →  ${rows.length - 1} data rows`);
  console.log(`Columns (${header.length}):`);
  header.forEach((h, i) => console.log(`  [${i}] ${JSON.stringify(h)}`));

  console.log("\nSample rows (first 2 data rows, non-empty cells only):");
  for (const r of rows.slice(1, 3)) {
    const obj: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const v = (r as unknown[])[i];
      if (v !== undefined && v !== "") obj[h || `col${i}`] = v;
    });
    console.log(JSON.stringify(obj, null, 2));
  }

  // Quick completeness scan on data rows
  const idx = (name: string) => header.findIndex((h) => h?.toLowerCase().trim() === name.toLowerCase());
  const data = rows.slice(1) as unknown[][];
  const nonEmpty = (i: number) => (i < 0 ? 0 : data.filter((r) => r[i] !== undefined && String(r[i]).trim() !== "").length);
  const cols = ["Email", "Phone", "Call Status", "Assigned User", "Industry", "Niche", "Country"];
  console.log(`\nCompleteness over ${data.length} data rows:`);
  for (const c of cols) {
    const i = idx(c);
    console.log(`  ${c.padEnd(14)} col=${i >= 0 ? i : "—"}  filled=${nonEmpty(i)}`);
  }
}

main().catch((e) => {
  console.error("\n❌ FAILED:", e?.message || e);
  if (e?.errors) console.error(JSON.stringify(e.errors, null, 2));
  process.exit(1);
});
