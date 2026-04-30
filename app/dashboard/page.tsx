"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { Calendar } from "@/components/ui/calendar";

// ─── Types ─────────────────────────────────────────────────────

type CalendarEvent = {
  id: string;
  google_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  attendee_emails: string[] | null;
  organizer_email: string | null;
  starts_at: string;
  ends_at: string;
  status: string | null;
  html_link: string | null;
  updated_at: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type SuggestedSlot = {
  startsAt: string;
  endsAt: string;
  label: string;
};

// ─── Helpers ────────────────────────────────────────────────────

function durationMin(e: Pick<CalendarEvent, "starts_at" | "ends_at">) {
  return Math.max(0, new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000;
}

function formatEventTime(event: CalendarEvent) {
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

  const isToday = start.toDateString() === today.toDateString();
  const isTomorrow = start.toDateString() === tomorrow.toDateString();
  const dayLabel = isToday ? "Today" : isTomorrow ? "Tomorrow" :
    start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

  return `${dayLabel} · ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function formatTimeRange(event: CalendarEvent) {
  const start = new Date(event.starts_at);
  const end = new Date(event.ends_at);
  return `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function renderInline(line: string) {
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`b-${index}`}>{part.slice(2, -2)}</strong>;
    }
    return <span key={`t-${index}`}>{part}</span>;
  });
}

function extractEmailFields(content: string) {
  const lines = content.split("\n");
  const toLine = lines.find((line) => line.toLowerCase().startsWith("to:"));
  const subjectLine = lines.find((line) => line.toLowerCase().startsWith("subject:"));
  const to = toLine?.slice(3).trim() ?? "";
  const subject = subjectLine?.slice(8).trim() ?? "Scheduling follow-up";
  return { to, subject };
}

function isDayToday(day: Date) {
  return day.toDateString() === new Date().toDateString();
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getWeekStats(events: CalendarEvent[]) {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const active = events.filter(e => {
    const s = new Date(e.starts_at);
    return s >= weekStart && s < weekEnd && e.status !== "cancelled";
  });
  const minutes = active.reduce((t, e) => t + durationMin(e), 0);
  const collabMin = active
    .filter(e => (e.attendee_emails?.length ?? 0) > 1)
    .reduce((t, e) => t + durationMin(e), 0);

  return {
    count: active.length,
    hours: Math.round((minutes / 60) * 10) / 10,
    collabHours: Math.round((collabMin / 60) * 10) / 10,
    pct: Math.round((minutes / (40 * 60)) * 100),
  };
}

function initials(name: string) {
  return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

// ─── Mini Calendar ──────────────────────────────────────────────

function MiniCalendar({
  events,
  selectedDate,
  onSelectDate,
}: {
  events: CalendarEvent[];
  selectedDate: Date;
  onSelectDate: (date: Date) => void;
}) {
  const eventDayKeys = useMemo(
    () =>
      new Set(
        events
          .filter((event) => event.status !== "cancelled")
          .map((event) => dayKey(new Date(event.starts_at))),
      ),
    [events],
  );

  return (
    <div className="mini-calendar">
      <Calendar
        mode="single"
        selected={selectedDate}
        onSelect={(date) => {
          if (date) onSelectDate(startOfDay(date));
        }}
        modifiers={{
          hasEvent: (date) => eventDayKeys.has(dayKey(date)),
        }}
        modifiersClassNames={{
          hasEvent: "calendar-has-event",
        }}
        className="dashboard-date-picker"
      />
    </div>
  );
}

// ─── Dashboard ──────────────────────────────────────────────────

const STARTER_PROMPTS = [
  "What does my week look like?",
  "How much time am I in meetings?",
  "Draft a scheduling email to the team.",
];

export default function Dashboard() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: "Hi! Sync your Google Calendar and then ask me anything about your schedule — meeting load, drafts, week planning, you name it.",
    },
  ]);
  const [input, setInput] = useState("");
  const [, setStatus] = useState("Checking session…");
  const [isChatting, setIsChatting] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [meetingTitle, setMeetingTitle] = useState("Team sync");
  const [meetingDurationMin, setMeetingDurationMin] = useState(30);
  const [meetingAttendees, setMeetingAttendees] = useState("");
  const [slotSuggestions, setSlotSuggestions] = useState<SuggestedSlot[]>([]);
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [creatingSlot, setCreatingSlot] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(() => startOfDay(new Date()));
  const syncInFlightRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const stats = useMemo(() => getWeekStats(events), [events]);
  const calendarDays = useMemo(() => {
    const base = startOfDay(selectedDate);
    return Array.from({ length: 3 }, (_, offset) => {
      const day = new Date(base);
      day.setDate(base.getDate() + offset);
      return day;
    });
  }, [selectedDate]);
  const dayEvents = useMemo(() => {
    return calendarDays.map(day => {
      const dayStart = startOfDay(day);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      return events
        .filter(event => {
          if (event.status === "cancelled") return false;
          const start = new Date(event.starts_at);
          return start >= dayStart && start < dayEnd;
        })
        .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
    });
  }, [calendarDays, events]);
  const HOUR_START = 6;
  const HOUR_END = 22;
  const HOUR_HEIGHT = 48;
  const hours = useMemo(
    () => Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => HOUR_START + i),
    []
  );

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace("/");
      } else {
        setSession(data.session);
        setStatus("Connected to Google.");
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!next) {
        router.replace("/");
      } else {
        setSession(next);
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  // Load events on session
  useEffect(() => {
    if (session?.access_token) void loadEvents(session.access_token);
  }, [session?.access_token]);

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function loadEvents(token: string) {
    const res = await fetch("/api/calendar/events", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (res.ok) setEvents(data.events ?? []);
    else setStatus(data.error ?? "Could not load events.");
  }

  const syncCalendar = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (syncInFlightRef.current) return;
    if (!session?.access_token) return;
    if (!session.provider_token) {
      setStatus("Calendar token missing — sign out and reconnect.");
      return;
    }
    syncInFlightRef.current = true;
    try {
      const res = await fetch("/api/calendar/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ googleAccessToken: session.provider_token }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadEvents(session.access_token);
        if (!silent) {
          setStatus(`Synced ${data.synced} events.`);
        }
      } else {
        setStatus(data.error ?? "Sync failed.");
      }
    } catch {
      setStatus("Sync failed.");
    } finally {
      syncInFlightRef.current = false;
    }
  }, [session?.access_token, session?.provider_token]);

  useEffect(() => {
    if (!session?.access_token || !session.provider_token) return;

    let mounted = true;
    const runSync = async () => {
      if (!mounted) return;
      await syncCalendar({ silent: true });
    };

    void runSync();
    const intervalId = setInterval(() => {
      void runSync();
    }, 15_000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [syncCalendar, session?.access_token, session?.provider_token]);

  async function signOut() {
    await supabase.auth.signOut();
    setEvents([]);
    router.replace("/");
  }

  async function sendMessage(content = input) {
    const trimmed = content.trim();
    if (!trimmed || !session?.access_token || isChatting) return;

    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setIsChatting(true);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        messages: next.filter(m => m.role !== "assistant" || m.content.length < 1200),
      }),
    });
    const data = await res.json();
    setMessages(cur => [
      ...cur,
      { role: "assistant", content: res.ok ? data.reply : (data.error ?? "The agent couldn't respond.") },
    ]);
    setIsChatting(false);
  }

  function suggestMeetingSlots() {
    const duration = Math.max(15, Number.isFinite(meetingDurationMin) ? meetingDurationMin : 30);
    const now = new Date();
    const startWindow = new Date(now);
    startWindow.setMinutes(0, 0, 0);
    if (startWindow.getHours() < 8) startWindow.setHours(8);
    const endWindow = new Date(now);
    endWindow.setDate(endWindow.getDate() + 14);

    const busy = events
      .filter(event => event.status !== "cancelled")
      .map(event => ({
        start: new Date(event.starts_at).getTime(),
        end: new Date(event.ends_at).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    const next: SuggestedSlot[] = [];
    let pointer = new Date(startWindow);
    while (pointer < endWindow && next.length < 3) {
      const day = pointer.getDay();
      const isWeekend = day === 0 || day === 6;
      if (isWeekend) {
        pointer.setDate(pointer.getDate() + 1);
        pointer.setHours(9, 0, 0, 0);
        continue;
      }

      if (pointer.getHours() < 9) pointer.setHours(9, 0, 0, 0);
      if (pointer.getHours() >= 17) {
        pointer.setDate(pointer.getDate() + 1);
        pointer.setHours(9, 0, 0, 0);
        continue;
      }

      const slotStart = pointer.getTime();
      const slotEnd = slotStart + duration * 60 * 1000;
      const overlaps = busy.some(block => slotStart < block.end && slotEnd > block.start);
      if (!overlaps) {
        const start = new Date(slotStart);
        const end = new Date(slotEnd);
        next.push({
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          label: `${start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} - ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        });
      }
      pointer = new Date(pointer.getTime() + 30 * 60 * 1000);
    }

    setSlotSuggestions(next);
  }

  async function createInvite(slot: SuggestedSlot) {
    if (!session?.access_token || !session.provider_token || isCreatingInvite) return;
    setIsCreatingInvite(true);
    setCreatingSlot(slot.startsAt);
    const attendees = meetingAttendees
      .split(",")
      .map(email => email.trim())
      .filter(Boolean);

    const res = await fetch("/api/calendar/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        googleAccessToken: session.provider_token,
        title: meetingTitle.trim() || "Meeting",
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        attendeeEmails: attendees,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setStatus("Invite created and synced.");
      await loadEvents(session.access_token);
    } else {
      if (data.needsReconnect) {
        setStatus("Google write scope is missing — sign out and reconnect Google.");
      } else {
        setStatus(data.error ?? "Could not create invite.");
      }
    }
    setIsCreatingInvite(false);
    setCreatingSlot(null);
  }

  async function copyMessage(text: string) {
    await navigator.clipboard.writeText(text);
    setStatus("Copied message to clipboard.");
  }

  function sendAsEmail(text: string) {
    const { to, subject } = extractEmailFields(text);
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    window.location.href = url;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  if (loading) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <div className="spinner" />
      </div>
    );
  }

  const userMeta = session?.user;
  const avatarUrl = userMeta?.user_metadata?.avatar_url as string | undefined;
  const displayName = (userMeta?.user_metadata?.full_name as string | undefined) ?? userMeta?.email ?? "User";

  return (
    <div className="dashboard-root">
      {/* ── Top Bar ── */}
      <header className="dashboard-topbar">
        <button className="user-pill user-pill-logout" onClick={signOut} title="Log out">
          <div className="user-avatar">
            {avatarUrl ? <img src={avatarUrl} alt={displayName} /> : initials(displayName)}
          </div>
          <span className="user-name">{displayName}</span>
        </button>
      </header>

      {/* ── Body ── */}
      <div className="dashboard-body dashboard-body-calendar">
        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div className="calendar-toolbar-left">
              <h2 className="calendar-title">Schedule</h2>
              <span className="panel-badge">{events.length} events synced</span>
            </div>
            <div className="calendar-summary">
              <span>{stats.count} meetings this week</span>
              <span>{stats.hours}h booked</span>
            </div>
          </div>

          <div className="dashboard-tools">
            <div className="dashboard-tools-left">
              <MiniCalendar events={events} selectedDate={selectedDate} onSelectDate={setSelectedDate} />
              <div className="stat-grid">
                <div className="stat-card">
                  <span className="stat-label">Meetings</span>
                  <strong className="stat-value">{stats.count}</strong>
                  <small className="stat-foot">This week</small>
                </div>
                <div className="stat-card">
                  <span className="stat-label">Load</span>
                  <strong className="stat-value">{stats.hours}h</strong>
                  <small className="stat-foot">{stats.pct}% of 40h</small>
                </div>
              </div>
            </div>

            <div className="meeting-planner">
              <h3>Meeting planner</h3>
              <div className="planner-fields">
                <div className="planner-field-group">
                  <label className="planner-label">Title</label>
                  <input className="planner-input" value={meetingTitle} onChange={e => setMeetingTitle(e.target.value)} placeholder="Team sync" />
                </div>
                <div className="planner-field-group">
                  <label className="planner-label">Attendees</label>
                  <input className="planner-input" value={meetingAttendees} onChange={e => setMeetingAttendees(e.target.value)} placeholder="alice@co.com, bob@co.com" />
                </div>
                <div className="planner-field-group">
                  <label className="planner-label">Duration</label>
                  <div className="planner-row">
                    <div className="duration-picker">
                      {[15, 30, 45, 60].map(d => (
                        <button
                          key={d}
                          type="button"
                          className={`duration-option${meetingDurationMin === d ? " active" : ""}`}
                          onClick={() => setMeetingDurationMin(d)}
                        >{d}m</button>
                      ))}
                    </div>
                    <button className="btn-primary" type="button" onClick={suggestMeetingSlots}>
                      Find a time
                    </button>
                  </div>
                </div>
              </div>
              <div className="suggested-slots">
                {slotSuggestions.length === 0 ? (
                  <span className="slots-empty">No suggestions yet.</span>
                ) : (
                  slotSuggestions.map(slot => (
                    <div className="slot-item" key={slot.startsAt}>
                      <div className="slot-item-meta">
                        <div className="slot-badge">No conflicts</div>
                        <div className="slot-time">{slot.label}</div>
                      </div>
                      <button
                        className="slot-book-btn"
                        type="button"
                        onClick={() => createInvite(slot)}
                        disabled={isCreatingInvite}
                      >
                        {creatingSlot === slot.startsAt ? "Booking…" : "Book →"}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="calendar-board">
            <div className="calendar-header">
              <div className="calendar-time-head" />
              {calendarDays.map(day => (
                <div className={`calendar-day-head${isDayToday(day) ? " is-today" : ""}`} key={day.toISOString()}>
                  <small>{day.toLocaleDateString([], { weekday: "short" })}</small>
                  <strong>{day.getDate()}</strong>
                </div>
              ))}
            </div>

            <div className="calendar-grid-shell">
              <div className="calendar-time-rail">
                {hours.map(hour => (
                  <div className="time-label" key={hour}>
                    {new Date(0, 0, 0, hour).toLocaleTimeString([], { hour: "numeric" })}
                  </div>
                ))}
              </div>

              {calendarDays.map((day, dayIndex) => (
                <div className={`calendar-day-col${isDayToday(day) ? " is-today" : ""}`} key={day.toISOString()}>
                  {hours.map(hour => (
                    <div className="hour-slot" key={`${day.toISOString()}-${hour}`} />
                  ))}

                  {dayEvents[dayIndex].map(event => {
                    const start = new Date(event.starts_at);
                    const minutesFromStart = (start.getHours() - HOUR_START) * 60 + start.getMinutes();
                    const top = (minutesFromStart / 60) * HOUR_HEIGHT;
                    const height = Math.max((durationMin(event) / 60) * HOUR_HEIGHT, 24);

                    return (
                      <a
                        key={event.id}
                        href={event.html_link ?? undefined}
                        target={event.html_link ? "_blank" : undefined}
                        rel={event.html_link ? "noreferrer" : undefined}
                        className="calendar-event-block"
                        style={{ top: `${Math.max(top, 0)}px`, height: `${height}px` }}
                        title={formatEventTime(event)}
                      >
                        <div className="calendar-event-title">{event.title}</div>
                        <div className="calendar-event-meta">{formatTimeRange(event)}</div>
                      </a>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <button
        className={`chat-search-launch${isChatOpen ? " open" : ""}`}
        type="button"
        onClick={() => setIsChatOpen(true)}
        aria-label="Open Ask AI"
      >
        <span className="chat-search-icon" aria-hidden="true">✦</span>
        <span>{isChatting ? "Thinking..." : "Want to know more about your schedule?"}</span>
      </button>

      <button
        className={`chat-float-backdrop${isChatOpen ? " open" : ""}`}
        type="button"
        aria-label="Close Ask AI"
        onClick={() => setIsChatOpen(false)}
      />

      <section className={`chat-float-panel${isChatOpen ? " open" : ""}`} aria-hidden={!isChatOpen}>
        <div className="panel-head">
          <h2 className="panel-title">Ask AI</h2>
          <div className="chat-head-actions">
            <button
              className="btn-ghost chat-close-btn"
              type="button"
              onClick={() => setIsChatOpen(false)}
              aria-label="Close Ask AI"
            >
              ×
            </button>
          </div>
        </div>

        <div className="chat-body">
          {messages.map((msg, i) => (
            <div className={`chat-bubble ${msg.role}`} key={i}>
              {msg.role === "assistant" && (
                <div style={{ marginBottom: "0.375rem" }}>
                  <span className="chat-assistant-icon">CA</span>
                </div>
              )}
              <div className="chat-rich-text">
                {msg.content.split("\n").map((line, idx) => {
                  const trimmed = line.trim();
                  if (!trimmed) return <div className="chat-line-gap" key={`g-${idx}`} />;
                  if (trimmed.startsWith("#")) {
                    return <p className="chat-headline" key={`h-${idx}`}>{renderInline(trimmed.replace(/^#+\s*/, ""))}</p>;
                  }
                  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
                    return <p className="chat-list-item" key={`l-${idx}`}>• {renderInline(trimmed.slice(2))}</p>;
                  }
                  return <p className="chat-paragraph" key={`p-${idx}`}>{renderInline(line)}</p>;
                })}
              </div>
              {msg.role === "assistant" && (
                <div className="chat-msg-actions">
                  <button className="btn-ghost" type="button" onClick={() => copyMessage(msg.content)}>Copy</button>
                  <button className="btn-ghost" type="button" onClick={() => sendAsEmail(msg.content)}>Send email</button>
                </div>
              )}
            </div>
          ))}
          {isChatting && (
            <div className="chat-bubble assistant chat-thinking">
              <div className="thinking-dots">
                <span /><span /><span />
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="chat-footer">
          <div className="prompt-chips">
            {STARTER_PROMPTS.map(p => (
              <button
                key={p}
                className="prompt-chip"
                onClick={() => sendMessage(p)}
                disabled={!session || isChatting}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="chat-input-row">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your schedule... (Enter to send, Shift+Enter for newline)"
              rows={1}
              disabled={!session || isChatting}
            />
            <button
              className="btn-primary"
              onClick={() => sendMessage()}
              disabled={!session || isChatting || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
