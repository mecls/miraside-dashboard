/**
 * Google Sheets client for the Cold Calls CRM.
 *
 * Auth: a service account whose JSON key lives in GOOGLE_SERVICE_ACCOUNT_KEY
 * (raw JSON, base64-encoded JSON, or a path to a key file are all accepted).
 * The sheet must be shared with the service account's client_email as Editor
 * (Editor is required for the write-back path; reads alone need only Viewer).
 *
 * Not marked "server-only" so the tsx maintenance scripts can import it too;
 * it is nonetheless only ever imported from server code / scripts.
 */
import "server-only";
import fs from "node:fs";
import { google, type sheets_v4 } from "googleapis";
import type { RawTab } from "@/lib/cold-calls";

const READ_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

type ServiceAccount = { client_email: string; private_key: string };

function loadServiceAccount(): ServiceAccount {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").trim();
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not set");
  let jsonStr = raw;
  if (!jsonStr.startsWith("{")) {
    if (fs.existsSync(jsonStr)) {
      jsonStr = fs.readFileSync(jsonStr, "utf8");
    } else {
      const decoded = Buffer.from(jsonStr, "base64").toString("utf8").trim();
      if (decoded.startsWith("{")) jsonStr = decoded;
    }
  }
  const obj = JSON.parse(jsonStr) as ServiceAccount;
  if (obj.private_key) obj.private_key = String(obj.private_key).replace(/\\n/g, "\n");
  if (!obj.client_email || !obj.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email / private_key");
  }
  return obj;
}

function makeClient(scopes: string[]): sheets_v4.Sheets {
  const creds = loadServiceAccount();
  const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes });
  return google.sheets({ version: "v4", auth });
}

let _readClient: sheets_v4.Sheets | null = null;
let _writeClient: sheets_v4.Sheets | null = null;

/** Authorized Sheets client. `write` requests the read/write scope. */
export function getSheetsClient(mode: "read" | "write" = "read"): sheets_v4.Sheets {
  if (mode === "write") return (_writeClient ??= makeClient([WRITE_SCOPE]));
  return (_readClient ??= makeClient([READ_SCOPE]));
}

/** List the service-account email (for the "share the sheet with this" instructions). */
export function serviceAccountEmail(): string {
  return loadServiceAccount().client_email;
}

/** Every tab title in a workbook. */
export async function getTabTitles(spreadsheetId: string): Promise<string[]> {
  const res = await getSheetsClient("read").spreadsheets.get({ spreadsheetId });
  return (res.data.sheets || []).map((s) => s.properties?.title || "");
}

/** Read an entire tab as { header, rows }. Rows are the data rows (header stripped). */
export async function readTab(spreadsheetId: string, tab: string): Promise<RawTab> {
  const res = await getSheetsClient("read").spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const values = (res.data.values || []) as unknown[][];
  const header = ((values[0] as unknown[]) || []).map((h) => String(h ?? "").trim());
  return { header, rows: values.slice(1) };
}
