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

type GoogleCalendarEventsResponse = {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
};

function eventDate(value?: { dateTime?: string; date?: string }) {
  return value?.dateTime ?? (value?.date ? `${value.date}T00:00:00.000Z` : null);
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

  const googleEvents: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;

  do {
    if (pageToken) {
      calendarUrl.searchParams.set("pageToken", pageToken);
    } else {
      calendarUrl.searchParams.delete("pageToken");
    }

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

    const payload = (await googleResponse.json()) as GoogleCalendarEventsResponse;
    googleEvents.push(...(payload.items ?? []));
    pageToken = payload.nextPageToken;
  } while (pageToken);

  const activeGoogleEvents = googleEvents.filter((event) => {
    return event.status !== "cancelled" && event.id && eventDate(event.start) && eventDate(event.end);
  });

  const currentGoogleEventIds = new Set(activeGoogleEvents.map((event) => event.id));
  const events = activeGoogleEvents
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

  const syncedRows: Array<{ id: string; google_event_id: string }> = [];
  const pageSize = 1000;
  for (let fromIndex = 0; ; fromIndex += pageSize) {
    const toIndex = fromIndex + pageSize - 1;
    const { data, error } = await supabase
      .from("calendar_events")
      .select("id, google_event_id")
      .eq("user_id", user.id)
      .gte("starts_at", timeMin.toISOString())
      .lte("starts_at", timeMax.toISOString())
      .range(fromIndex, toIndex);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    syncedRows.push(...((data ?? []) as Array<{ id: string; google_event_id: string }>));

    if (!data || data.length < pageSize) {
      break;
    }
  }

  const staleRowIds = syncedRows
    .filter((row) => !currentGoogleEventIds.has(row.google_event_id))
    .map((row) => row.id);

  for (const staleIds of chunk(staleRowIds, 100)) {
    const { error } = await supabase
      .from("calendar_events")
      .delete()
      .eq("user_id", user.id)
      .in("id", staleIds);

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

  return Response.json({ synced: events.length, deleted: staleRowIds.length });
}
