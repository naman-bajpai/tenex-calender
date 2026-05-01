import { getBearerToken, createUserScopedSupabase } from "@/lib/server-supabase";

function buildRawMessage(to: string, from: string, subject: string, body: string) {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function POST(request: Request) {
  const accessToken = getBearerToken(request);
  if (!accessToken) {
    return Response.json({ error: "Missing Supabase bearer token." }, { status: 401 });
  }

  const { googleAccessToken, to, subject, body } = (await request.json().catch(() => ({}))) as {
    googleAccessToken?: string;
    to?: string;
    subject?: string;
    body?: string;
  };

  if (!googleAccessToken) {
    return Response.json(
      { error: "Google token missing. Sign out and reconnect Google." },
      { status: 400 },
    );
  }
  if (!to?.trim()) {
    return Response.json({ error: "Recipient email (to) is required." }, { status: 400 });
  }
  if (!subject?.trim()) {
    return Response.json({ error: "Subject is required." }, { status: 400 });
  }
  if (!body?.trim()) {
    return Response.json({ error: "Email body is required." }, { status: 400 });
  }

  const supabase = createUserScopedSupabase(accessToken);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return Response.json({ error: "Invalid Supabase session." }, { status: 401 });
  }

  const senderEmail = user.email ?? "me";
  const raw = buildRawMessage(to.trim(), senderEmail, subject.trim(), body.trim());

  const gmailRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${googleAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!gmailRes.ok) {
    const detail = await gmailRes.text();
    if (gmailRes.status === 401 || gmailRes.status === 403) {
      return Response.json(
        {
          error: "Gmail send permission denied. Make sure the gmail.send scope is enabled and reconnect Google.",
          needsReconnect: true,
          detail,
        },
        { status: gmailRes.status },
      );
    }
    return Response.json({ error: "Gmail send failed.", detail }, { status: gmailRes.status });
  }

  const result = await gmailRes.json() as { id?: string; threadId?: string };
  return Response.json({ ok: true, messageId: result.id });
}
