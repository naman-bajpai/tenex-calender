import { getBearerToken, createUserScopedSupabase } from "@/lib/server-supabase";

type CalendarEvent = {
  title: string;
  starts_at: string;
  ends_at: string;
  attendee_emails: string[] | null;
  organizer_email: string | null;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

function formatEvents(events: CalendarEvent[]) {
  return events
    .map((event) => {
      const start = new Date(event.starts_at);
      const end = new Date(event.ends_at);
      const attendees = event.attendee_emails?.length
        ? ` Attendees: ${event.attendee_emails.join(", ")}.`
        : "";
      const organizer = event.organizer_email ? ` Organizer: ${event.organizer_email}.` : "";
      return `- ${event.title}: ${start.toLocaleString("en-US")} to ${end.toLocaleString("en-US")}.${organizer}${attendees}`;
    })
    .join("\n");
}

function summarizeMeetings(events: CalendarEvent[]) {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const weekEvents = events.filter((event) => {
    const start = new Date(event.starts_at);
    return start >= weekStart && start < weekEnd;
  });

  const minutes = weekEvents.reduce((total, event) => {
    return total + Math.max(0, new Date(event.ends_at).getTime() - new Date(event.starts_at).getTime()) / 60000;
  }, 0);

  return {
    eventCount: weekEvents.length,
    meetingHours: Math.round((minutes / 60) * 10) / 10,
    meetingShareOfWorkWeek: Math.round((minutes / (40 * 60)) * 100),
  };
}

async function callOpenAI(messages: ChatMessage[], events: CalendarEvent[]) {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.NEXT_PUBLIC_AI_API_KEY;
  const genericEndpoint = process.env.NEXT_PUBLIC_AI_API_ENDPOINT;
  const endpoint =
    process.env.OPENAI_API_ENDPOINT ??
    (genericEndpoint?.includes("openai.com") ? genericEndpoint : undefined) ??
    "https://api.openai.com/v1/chat/completions";
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY or NEXT_PUBLIC_AI_API_KEY.");
  }

  const meetingSummary = summarizeMeetings(events);
  const systemPrompt = `You are a practical calendar agent. Use the user's synced Google Calendar data to answer questions, draft scheduling emails, and recommend calendar changes. Be specific, concise, and honest when the calendar data is insufficient.
Use plain text formatting only. Do not use markdown headings (#) or list markers (*, -). If emphasis is needed, wrap the exact phrase in double asterisks.

Current meeting load summary:
- Meetings this week: ${meetingSummary.eventCount}
- Meeting hours this week: ${meetingSummary.meetingHours}
- Approximate share of a 40 hour work week: ${meetingSummary.meetingShareOfWorkWeek}%

Synced calendar events:
${formatEvents(events) || "No synced events."}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed: ${detail}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? "I could not produce a response.";
}

export async function POST(request: Request) {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return Response.json({ error: "Missing Supabase bearer token." }, { status: 401 });
  }

  const { messages } = (await request.json().catch(() => ({}))) as {
    messages?: ChatMessage[];
  };

  if (!messages?.length) {
    return Response.json({ error: "Send at least one chat message." }, { status: 400 });
  }

  const supabase = createUserScopedSupabase(accessToken);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: "Invalid Supabase session." }, { status: 401 });
  }

  const from = new Date();
  from.setDate(from.getDate() - 30);
  const to = new Date();
  to.setDate(to.getDate() + 90);

  const { data: events, error } = await supabase
    .from("calendar_events")
    .select("title, starts_at, ends_at, attendee_emails, organizer_email")
    .eq("user_id", user.id)
    .gte("starts_at", from.toISOString())
    .lte("starts_at", to.toISOString())
    .order("starts_at", { ascending: true })
    .limit(300);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  try {
    const reply = await callOpenAI(messages.slice(-10), (events ?? []) as CalendarEvent[]);
    return Response.json({ reply });
  } catch (chatError) {
    const message = chatError instanceof Error ? chatError.message : "Chat request failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
