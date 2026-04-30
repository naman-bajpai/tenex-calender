import { getBearerToken, createUserScopedSupabase } from "@/lib/server-supabase";

type CreateBody = {
  googleAccessToken?: string;
  title?: string;
  description?: string;
  location?: string;
  startsAt?: string;
  endsAt?: string;
  attendeeEmails?: string[];
  createMeetLink?: boolean;
  sendUpdates?: boolean;
};

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

  const body = (await request.json().catch(() => ({}))) as CreateBody;
  if (!body.googleAccessToken) {
    return Response.json({ error: "Google calendar token is missing." }, { status: 400 });
  }
  if (!isValidIso(body.startsAt) || !isValidIso(body.endsAt)) {
    return Response.json({ error: "Invalid start/end time." }, { status: 400 });
  }

  const supabase = createUserScopedSupabase(accessToken);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "Invalid Supabase session." }, { status: 401 });
  }

  const payload = {
    summary: body.title?.trim() || "Meeting",
    description: body.description ?? "",
    location: body.location ?? "",
    start: { dateTime: body.startsAt },
    end: { dateTime: body.endsAt },
    attendees: (body.attendeeEmails ?? [])
      .filter(Boolean)
      .map((email) => ({ email })),
    ...(body.createMeetLink
      ? {
          conferenceData: {
            createRequest: {
              requestId: `sched-${user.id}-${Date.now()}`,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {}),
  };

  const calendarUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  if (body.createMeetLink) calendarUrl.searchParams.set("conferenceDataVersion", "1");
  if (body.sendUpdates) calendarUrl.searchParams.set("sendUpdates", "all");

  const googleResponse = await fetch(calendarUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${body.googleAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!googleResponse.ok) {
    const detail = await googleResponse.text();
    const parsed = parseGoogleError(detail);
    const needsReconnect =
      googleResponse.status === 403 &&
      (parsed.reason === "insufficientPermissions" || parsed.message?.toLowerCase().includes("insufficient"));

    return Response.json(
      {
        error: needsReconnect
          ? "Google Calendar write access is missing. Sign out and reconnect Google to grant calendar write permissions."
          : "Google Calendar create event failed.",
        detail,
        needsReconnect,
      },
      { status: googleResponse.status },
    );
  }

  const created = (await googleResponse.json()) as {
    id: string;
    summary?: string;
    description?: string;
    location?: string;
    htmlLink?: string;
    hangoutLink?: string;
    status?: string;
    organizer?: { email?: string };
    attendees?: Array<{ email?: string }>;
    conferenceData?: {
      entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    };
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  };

  const startsAt = created.start?.dateTime ?? created.start?.date;
  const endsAt = created.end?.dateTime ?? created.end?.date;
  if (created.id && startsAt && endsAt) {
    await supabase.from("calendar_events").upsert(
      {
        user_id: user.id,
        google_event_id: created.id,
        title: created.summary ?? payload.summary,
        description: created.description ?? null,
        location: created.location ?? null,
        attendee_emails: created.attendees?.map((attendee) => attendee.email).filter(Boolean) ?? [],
        organizer_email: created.organizer?.email ?? null,
        starts_at: startsAt,
        ends_at: endsAt,
        status: created.status ?? null,
        html_link: created.htmlLink ?? null,
        raw: created,
      },
      { onConflict: "user_id,google_event_id" },
    );
  }

  const meetLink =
    created.hangoutLink ??
    created.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri ??
    null;

  return Response.json({
    ok: true,
    eventId: created.id,
    htmlLink: created.htmlLink ?? null,
    meetLink,
  });
}
