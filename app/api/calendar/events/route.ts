 import { getBearerToken, createUserScopedSupabase } from "@/lib/server-supabase";

export async function GET(request: Request) {
  const accessToken = getBearerToken(request);

  if (!accessToken) {
    return Response.json({ error: "Missing Supabase bearer token." }, { status: 401 });
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

  const { data, error } = await supabase
    .from("calendar_events")
    .select("id, google_event_id, title, description, location, attendee_emails, organizer_email, starts_at, ends_at, status, html_link, updated_at")
    .eq("user_id", user.id)
    .gte("starts_at", from.toISOString())
    .or("status.is.null,status.neq.cancelled")
    .order("starts_at", { ascending: true })
    .limit(300);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ events: data ?? [] });
}
