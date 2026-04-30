import { getBearerToken, createUserScopedSupabase } from "@/lib/server-supabase";

type CancelAllBody = {
  googleAccessToken?: string;
  confirm?: string;
  scope?: "today" | "all";
  startsAt?: string;
  endsAt?: string;
};

type CalendarEventRow = {
  id: string;
  google_event_id: string;
  title: string;
  starts_at: string;
};

const CONFIRMATION_PHRASE = "CONFIRM CANCEL ALL MEETINGS";
const TODAY_CONFIRMATION_PHRASE = "CONFIRM CANCEL TODAY'S MEETINGS";

function isValidIso(value?: string) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function parseGoogleError(detail: string) {
  try {
    const parsed = JSON.parse(detail) as {
      error?: { message?: string; errors?: Array<{ reason?: string }> };
    };
    return {
      message: parsed.error?.message ?? null,
      reason: parsed.error?.errors?.[0]?.reason ?? null,
    };
  } catch {
    return { message: null, reason: null };
  }
}

export async function POST(request: Request) {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: "Missing Supabase bearer token." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as CancelAllBody;
  if (!body.googleAccessToken) {
    return Response.json({ error: "Google calendar token is missing." }, { status: 400 });
  }
  const scope = body.scope ?? "all";
  if (scope !== "today" && scope !== "all") {
    return Response.json({ error: "Invalid cancellation scope." }, { status: 400 });
  }

  const requiredConfirmation = scope === "today" ? TODAY_CONFIRMATION_PHRASE : CONFIRMATION_PHRASE;
  if (body.confirm !== requiredConfirmation) {
    return Response.json(
      { error: `Type ${requiredConfirmation} to cancel ${scope === "today" ? "today's" : "all upcoming"} synced meetings.` },
      { status: 400 },
    );
  }

  if (scope === "today" && (!isValidIso(body.startsAt) || !isValidIso(body.endsAt))) {
    return Response.json({ error: "Today cancellation requires a valid start and end time." }, { status: 400 });
  }

  const supabase = createUserScopedSupabase(accessToken);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "Invalid Supabase session." }, { status: 401 });
  }

  const rangeStart = scope === "today" ? body.startsAt! : new Date().toISOString();
  const rangeEnd = scope === "today" ? body.endsAt! : null;
  let query = supabase
    .from("calendar_events")
    .select("id, google_event_id, title, starts_at")
    .eq("user_id", user.id)
    .or("status.is.null,status.neq.cancelled")
    .gte("starts_at", rangeStart);

  if (rangeEnd) {
    query = query.lt("starts_at", rangeEnd);
  }

  const { data: events, error } = await query.order("starts_at", { ascending: true }).limit(300);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = (events ?? []) as CalendarEventRow[];
  if (rows.length === 0) {
    return Response.json({ ok: true, cancelled: 0, failed: 0, failures: [] });
  }

  const cancelledIds: string[] = [];
  const failures: Array<{ eventId: string; title: string; detail: string }> = [];

  for (const event of rows) {
    const eventUrl = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event.google_event_id)}`,
    );
    eventUrl.searchParams.set("sendUpdates", "all");

    const googleResponse = await fetch(eventUrl, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${body.googleAccessToken}`,
        Accept: "application/json",
      },
    });

    if (googleResponse.ok || googleResponse.status === 404 || googleResponse.status === 410) {
      cancelledIds.push(event.id);
      continue;
    }

    const detail = await googleResponse.text();
    const parsed = parseGoogleError(detail);
    const needsReconnect =
      googleResponse.status === 403 &&
      (parsed.reason === "insufficientPermissions" || parsed.message?.toLowerCase().includes("insufficient"));

    if (needsReconnect) {
      return Response.json(
        {
          error: "Google Calendar write access is missing. Sign out and reconnect Google to grant calendar write permissions.",
          detail,
          needsReconnect,
          cancelled: cancelledIds.length,
          failed: rows.length - cancelledIds.length,
        },
        { status: 403 },
      );
    }

    failures.push({
      eventId: event.google_event_id,
      title: event.title,
      detail: parsed.message ?? (detail || "Google Calendar delete failed."),
    });
  }

  if (cancelledIds.length > 0) {
    const { error: updateError } = await supabase
      .from("calendar_events")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .in("id", cancelledIds);

    if (updateError) {
      return Response.json({ error: updateError.message }, { status: 500 });
    }
  }

  return Response.json({
    ok: failures.length === 0,
    cancelled: cancelledIds.length,
    failed: failures.length,
    failures,
  });
}
