/**
 * Pipeline board data — a faithful mirror of a GoHighLevel sales pipeline, enriched with the dashboard's
 * own call data so each card answers "what happened on the call" better than GHL's board does.
 *
 * The cards ARE GHL opportunities (one per contact-deal), read LIVE from GHL each render so the board can
 * never drift from what Miguel sees inside GHL. Each opportunity is joined to its dashboard lead by GHL
 * contact id to layer on the appointment / attendance / rebook / call-attempt state. The dashboard NEVER
 * creates opportunities (a GHL workflow does) — the board only moves them between stages.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { listPipelines, listOpportunitiesInPipeline, type GhlPipeline } from "./ghl-write";
import { ghlConfigured } from "./ghl";
import { fetchLeadViews } from "./leads-data";
import type { LeadView } from "./leads";

/**
 * The "Sales" pipeline that mirrors Miguel's two-call close process (Discovery → Follow-up) — the one
 * whose stages carry the discovery-vs-follow-up split ("No Show" for the discovery call, "No Show." for
 * the follow-up call). There are two pipelines named "Sales"; this is the one he described. Default board;
 * a picker switches to any other.
 */
export const PIPELINE_DEFAULT_ID = "UYYRNtEMq25Zxh4nbdIb";

export interface PipelineStage {
  id: string;
  name: string;
  position: number;
}

export interface PipelineDeal {
  oppId: string;
  contactId: string | null;
  stageId: string | null;
  name: string;
  company: string | null;
  value: number | null;
  status: string; // open | won | lost | abandoned
  updatedAt: string | null;
  // Enrichment from the linked lead (null when no dashboard lead matches the contact).
  leadId: string | null;
  phone: string | null;
  appointmentAt: string | null;
  appointmentStatus: string | null;
  callState: LeadView["callState"] | null;
  callAttempts: number | null;
  meetingCount: number | null;
  needsRebook: boolean;
  awaitingOutcome: boolean;
  apptAttendance: LeadView["apptAttendance"];
  latestAttendance: LeadView["latestAttendance"];
  latestOutcome: LeadView["latestOutcome"];
  latestConfirmedAt: string | null;
  ghlContactUrl: string | null;
}

export interface PipelineBoard {
  configured: boolean;
  pipelines: { id: string; name: string; stageCount: number }[]; // for the picker (two are both "Sales")
  pipeline: { id: string; name: string; stages: PipelineStage[] } | null;
  deals: PipelineDeal[];
}

/** Choose the board's pipeline: an explicit request, else the described default, else one with a Won stage. */
function pickPipeline(pipelines: GhlPipeline[], wanted?: string | null): GhlPipeline | null {
  if (!pipelines.length) return null;
  if (wanted) {
    const hit = pipelines.find((p) => p.id === wanted);
    if (hit) return hit;
  }
  const byDefault = pipelines.find((p) => p.id === PIPELINE_DEFAULT_ID);
  if (byDefault) return byDefault;
  const withWon = pipelines.find((p) => p.stages.some((s) => s.name.trim().toLowerCase() === "won"));
  return withWon ?? pipelines[0];
}

export async function getPipelineBoard(
  admin: SupabaseClient,
  tenantId: string,
  pipelineId?: string | null
): Promise<PipelineBoard> {
  if (!ghlConfigured()) return { configured: false, pipelines: [], pipeline: null, deals: [] };

  const pipelines = await listPipelines();
  const chosen = pickPipeline(pipelines, pipelineId);
  if (!chosen) return { configured: true, pipelines: [], pipeline: null, deals: [] };

  // Opportunities live from GHL (the mirror); leads for enrichment. Run together — independent reads.
  const [opps, leads] = await Promise.all([listOpportunitiesInPipeline(chosen.id), fetchLeadViews(admin, tenantId)]);

  const leadByContact = new Map<string, LeadView>();
  for (const l of leads) {
    if (l.ghlContactId && !leadByContact.has(l.ghlContactId)) leadByContact.set(l.ghlContactId, l);
  }

  const deals: PipelineDeal[] = opps.map((o) => {
    const lead = o.contactId ? leadByContact.get(o.contactId) ?? null : null;
    return {
      oppId: o.id,
      contactId: o.contactId,
      stageId: o.pipelineStageId,
      name: lead?.fullName ?? o.contactName ?? o.name ?? "Unknown",
      company: lead?.company ?? null,
      value: o.monetaryValue,
      status: o.status,
      updatedAt: o.updatedAt,
      leadId: lead?.id ?? null,
      phone: lead?.phone ?? null,
      appointmentAt: lead?.appointmentAt ?? null,
      appointmentStatus: lead?.appointmentStatus ?? null,
      callState: lead?.callState ?? null,
      callAttempts: lead?.callAttempts ?? null,
      meetingCount: lead?.meetingCount ?? null,
      needsRebook: lead?.needsRebook ?? false,
      awaitingOutcome: lead?.awaitingOutcome ?? false,
      apptAttendance: lead?.apptAttendance ?? null,
      latestAttendance: lead?.latestAttendance ?? null,
      latestOutcome: lead?.latestOutcome ?? null,
      latestConfirmedAt: lead?.latestConfirmedAt ?? null,
      ghlContactUrl: lead?.ghlContactUrl ?? null,
    };
  });

  return {
    configured: true,
    pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, stageCount: p.stages.length })),
    pipeline: { id: chosen.id, name: chosen.name, stages: chosen.stages },
    deals,
  };
}
