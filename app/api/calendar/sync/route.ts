import { getBearerToken, createUserScopedSupabase } from "@/lib/server-supabase";

type GoogleCalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  updated?: string;
  organizer?: { email?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
};

function eventDate(value?: { dateTime?: string; date?: string }) {
  return value?.dateTime ?? (value?.date ? `${value.date}T00:00:00.000Z` : null);
}

export async function POST(request: Request) {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return Response.json({ error: "Missing Supabase bearer token." }, { status: 401 });
  }

  const { googleAccessToken } = (await request.json().catch(() => ({}))) as {
    googleAccessToken?: string;
  };

  if (!googleAccessToken) {
    return Response.json(
      { error: "Google calendar token is missing. Reconnect Google and try again." },
      { status: 400 },
    );
  }

  const supabase = createUserScopedSupabase(accessToken);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: "Invalid Supabase session." }, { status: 401 });
  }

  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 90);

  const calendarUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  calendarUrl.searchParams.set("singleEvents", "true");
  calendarUrl.searchParams.set("orderBy", "startTime");
  calendarUrl.searchParams.set("maxResults", "250");
  calendarUrl.searchParams.set("timeMin", timeMin.toISOString());
  calendarUrl.searchParams.set("timeMax", timeMax.toISOString());

  const googleResponse = await fetch(calendarUrl, {
    headers: {
      Authorization: `Bearer ${googleAccessToken}`,
      Accept: "application/json",
    },
  });

  if (!googleResponse.ok) {
    const detail = await googleResponse.text();
    return Response.json(
      { error: "Google Calendar sync failed.", detail },
      { status: googleResponse.status },
    );
  }

  const payload = (await googleResponse.json()) as { items?: GoogleCalendarEvent[] };
  const events = (payload.items ?? [])
    .filter((event) => event.id && eventDate(event.start) && eventDate(event.end))
    .map((event) => ({
      user_id: user.id,
      google_event_id: event.id,
      title: event.summary || "Untitled event",
      description: event.description ?? null,
      location: event.location ?? null,
      attendee_emails:
        event.attendees?.map((attendee) => attendee.email).filter(Boolean) ?? [],
      organizer_email: event.organizer?.email ?? null,
      starts_at: eventDate(event.start),
      ends_at: eventDate(event.end),
      status: event.status ?? null,
      html_link: event.htmlLink ?? null,
      raw: event,
    }));

  if (events.length > 0) {
    const { error } = await supabase.from("calendar_events").upsert(events, {
      onConflict: "user_id,google_event_id",
    });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  await supabase.from("calendar_syncs").upsert(
    {
      user_id: user.id,
      synced_at: new Date().toISOString(),
      event_count: events.length,
    },
    { onConflict: "user_id" },
  );

  return Response.json({ synced: events.length });
}

