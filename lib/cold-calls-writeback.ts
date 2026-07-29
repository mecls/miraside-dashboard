import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSheetsClient, readTab } from "@/lib/google-sheets";
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

/* -------------------------------------------------------------- bulk write-back */

export type BatchPatch = { callStatus?: string; assignedUser?: string };
export type BatchWriteResult = { written: number; skipped: { id: string; reason: string }[] };

/**
 * Mirror one call-state field (Call Status and/or Assigned User) to the sheet for MANY contacts at once.
 *
 * Unlike looping writeBackContact (which does several Sheets reads per contact), this reads the tab ONCE to
 * build a key→row map, resolves every selected contact against it, then issues a SINGLE values.batchUpdate.
 * Best-effort like the single-row path: it never throws — contacts that can't be matched (no key / missing /
 * duplicate rows) are returned in `skipped`, and a failed sheet read/write reports the whole set as skipped.
 * The DB is already updated by the caller and stays the source of truth.
 */
export async function batchWriteBack(
  admin: SupabaseClient,
  tenantId: string,
  ids: string[],
  patch: BatchPatch
): Promise<BatchWriteResult> {
  const skipped: { id: string; reason: string }[] = [];
  if (ids.length === 0 || (patch.callStatus === undefined && patch.assignedUser === undefined)) {
    return { written: 0, skipped };
  }

  // 1. Read the whole tab once; index the key columns and build a key → sheet-row map.
  let header: string[];
  let rows: unknown[][];
  try {
    const tab = await readTab(COLD_CALLS_SHEET_ID, COLD_CALLS_TAB);
    header = tab.header;
    rows = tab.rows;
  } catch (e) {
    console.warn("cold-calls batch write-back: sheet read failed:", e instanceof Error ? e.message : String(e));
    return { written: 0, skipped: ids.map((id) => ({ id, reason: "sheet read failed" })) };
  }

  const colIdx: ColMap = {};
  header.forEach((h, i) => (colIdx[h] = i));
  const at = (row: unknown[], name: string) => (colIdx[name] != null ? s(row[colIdx[name]]) : "");

  const keyToRow = new Map<string, number | "ambiguous">();
  rows.forEach((row, idx) => {
    const key = keyOf(at(row, "Email"), at(row, "Phone"), at(row, "Person LinkedIn"));
    if (!key) return;
    keyToRow.set(key, keyToRow.has(key) ? "ambiguous" : idx + 2); // +2: header + 1-based
  });

  // 2. Load the selected contacts' match fields from the DB (chunked to keep the request URL small).
  const contacts: { id: string; email: string; phone: string; personLinkedin: string }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await admin
      .from("cold_call_contacts")
      .select("id, email, phone, person_linkedin")
      .eq("tenant_id", tenantId)
      .in("id", chunk);
    if (error) {
      console.warn("cold-calls batch write-back: contact read failed:", error.message);
      return { written: 0, skipped: ids.map((id) => ({ id, reason: "contact read failed" })) };
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      contacts.push({ id: s(r.id), email: s(r.email), phone: s(r.phone), personLinkedin: s(r.person_linkedin) });
    }
  }

  // 3. Resolve each contact to its row and stage the changed cell(s).
  const data: { range: string; values: string[][] }[] = [];
  const writtenIds: string[] = [];
  for (const c of contacts) {
    const key = keyOf(c.email, c.phone, c.personLinkedin);
    if (!key) { skipped.push({ id: c.id, reason: "no key (email/phone/linkedin) to match on" }); continue; }
    const hit = keyToRow.get(key);
    if (hit == null) { skipped.push({ id: c.id, reason: "contact not found in the sheet" }); continue; }
    if (hit === "ambiguous") { skipped.push({ id: c.id, reason: "duplicate rows match this contact in the sheet" }); continue; }
    const put = (name: string, value: string) => {
      if (colIdx[name] == null) return;
      data.push({ range: `'${COLD_CALLS_TAB}'!${colLetter(colIdx[name])}${hit}`, values: [[value]] });
    };
    if (patch.callStatus !== undefined) put("Call Status", patch.callStatus);
    if (patch.assignedUser !== undefined) put("Assigned User", patch.assignedUser);
    writtenIds.push(c.id);
  }

  // 4. One batched write, then stamp pushed_at on the rows that landed (sheet_row self-heals on next sync).
  if (data.length > 0) {
    try {
      await getSheetsClient("write").spreadsheets.values.batchUpdate({
        spreadsheetId: COLD_CALLS_SHEET_ID,
        requestBody: { valueInputOption: "RAW", data },
      });
    } catch (e) {
      console.warn("cold-calls batch write-back: sheet write failed:", e instanceof Error ? e.message : String(e));
      return { written: 0, skipped: [...skipped, ...writtenIds.map((id) => ({ id, reason: "sheet write failed" }))] };
    }
    const now = new Date().toISOString();
    for (let i = 0; i < writtenIds.length; i += 200) {
      await admin
        .from("cold_call_contacts")
        .update({ pushed_at: now })
        .eq("tenant_id", tenantId)
        .in("id", writtenIds.slice(i, i + 200));
    }
  }

  return { written: writtenIds.length, skipped };
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
