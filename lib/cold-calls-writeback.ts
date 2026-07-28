import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSheetsClient } from "@/lib/google-sheets";
import { COLD_CALLS_SHEET_ID, COLD_CALLS_TAB } from "@/lib/cold-calls";

/**
 * Mirror the dashboard-owned call state back to the sheet's row: Call Status, Notes, Assigned User.
 * The sheet has no stable row id (user declined one), so we locate the row by the same key precedence
 * used for dedupe (email → phone → LinkedIn). The stored sheet_row is tried first (fast path); if it no
 * longer matches — or the key is ambiguous/absent — the write is SKIPPED and reported, never guessed.
 */

const emailNorm = (e: string) => e.trim().toLowerCase();
const phoneNorm = (p: string) => p.replace(/[^\d+]/g, "");
const keyOf = (email: string, phone: string, li: string) =>
  emailNorm(email) || phoneNorm(phone) || li.trim().toLowerCase() || "";

function colLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type ColMap = Record<string, number>;
let _cols: ColMap | null = null;

async function columns(): Promise<ColMap> {
  if (_cols) return _cols;
  const res = await getSheetsClient("read").spreadsheets.values.get({
    spreadsheetId: COLD_CALLS_SHEET_ID,
    range: `'${COLD_CALLS_TAB}'!1:1`,
  });
  const header = ((res.data.values?.[0] as unknown[]) || []).map((h) => String(h ?? "").trim());
  const map: ColMap = {};
  header.forEach((h, i) => (map[h] = i));
  _cols = map;
  return map;
}

const s = (v: unknown) => (v == null ? "" : String(v));

async function rowMatchesKey(cols: ColMap, row: number, targetKey: string): Promise<boolean> {
  const res = await getSheetsClient("read").spreadsheets.values.get({
    spreadsheetId: COLD_CALLS_SHEET_ID,
    range: `'${COLD_CALLS_TAB}'!${row}:${row}`,
  });
  const r = (res.data.values?.[0] as unknown[]) || [];
  const at = (name: string) => (cols[name] != null ? s(r[cols[name]]) : "");
  return keyOf(at("Email"), at("Phone"), at("Person LinkedIn")) === targetKey && targetKey !== "";
}

async function findRowByScan(cols: ColMap, targetKey: string): Promise<number | "ambiguous" | null> {
  const grab = async (name: string): Promise<string[]> => {
    if (cols[name] == null) return [];
    const L = colLetter(cols[name]);
    const res = await getSheetsClient("read").spreadsheets.values.get({
      spreadsheetId: COLD_CALLS_SHEET_ID,
      range: `'${COLD_CALLS_TAB}'!${L}2:${L}`,
    });
    return ((res.data.values as unknown[][]) || []).map((r) => s(r?.[0]));
  };
  const [emails, phones, lis] = await Promise.all([grab("Email"), grab("Phone"), grab("Person LinkedIn")]);
  const n = Math.max(emails.length, phones.length, lis.length);
  const hits: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keyOf(emails[i] || "", phones[i] || "", lis[i] || "") === targetKey) hits.push(i + 2); // +2: header + 1-based
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return "ambiguous";
  return null;
}

export type WriteBackInput = {
  email: string;
  phone: string;
  personLinkedin: string;
  sheetRow: number | null;
  callStatus: string;
  assignedUser: string;
  notes: string;
};
export type WriteBackResult = { ok: true; row: number } | { ok: false; skipped: string };

export async function writeBackContact(c: WriteBackInput): Promise<WriteBackResult> {
  const cols = await columns();
  const targetKey = keyOf(c.email, c.phone, c.personLinkedin);
  if (!targetKey) return { ok: false, skipped: "no key (email/phone/linkedin) to match on" };

  let row: number | null = null;
  if (c.sheetRow && (await rowMatchesKey(cols, c.sheetRow, targetKey))) {
    row = c.sheetRow;
  } else {
    const scan = await findRowByScan(cols, targetKey);
    if (scan === "ambiguous") return { ok: false, skipped: "duplicate rows match this contact in the sheet" };
    if (scan === null) return { ok: false, skipped: "contact not found in the sheet" };
    row = scan;
  }

  const data: { range: string; values: string[][] }[] = [];
  const put = (name: string, value: string) => {
    if (cols[name] == null) return;
    data.push({ range: `'${COLD_CALLS_TAB}'!${colLetter(cols[name])}${row}`, values: [[value]] });
  };
  put("Call Status", c.callStatus);
  put("Assigned User", c.assignedUser);
  put("Notes", c.notes);
  if (!data.length) return { ok: false, skipped: "no writable columns found in the sheet" };

  await getSheetsClient("write").spreadsheets.values.batchUpdate({
    spreadsheetId: COLD_CALLS_SHEET_ID,
    requestBody: { valueInputOption: "RAW", data },
  });
  return { ok: true, row };
}

/**
 * Write-back + bookkeeping wrapper shared by the PATCH and log routes. The DB is the source of truth, so
 * this NEVER throws: on success it stamps pushed_at (and corrects sheet_row if the row moved); on failure
 * it returns a note the UI can surface. The edit self-heals on the next change or scheduled sync.
 */
export async function mirrorCallState(
  admin: SupabaseClient,
  tenantId: string,
  id: string,
  input: WriteBackInput
): Promise<{ ok: boolean; note?: string }> {
  try {
    const r = await writeBackContact(input);
    if (r.ok) {
      await admin
        .from("cold_call_contacts")
        .update({ pushed_at: new Date().toISOString(), sheet_row: r.row })
        .eq("tenant_id", tenantId)
        .eq("id", id);
      return { ok: true };
    }
    return { ok: false, note: r.skipped };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("cold-calls write-back failed (saved in dashboard, sheet not updated):", msg);
    return { ok: false, note: "sheet write-back failed" };
  }
}
