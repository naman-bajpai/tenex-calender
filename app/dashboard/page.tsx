"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { Calendar } from "@/components/ui/calendar";
import { parseMessageParts } from "@/lib/message-parser";
import { EmailDraftCard } from "@/components/dashboard/EmailDraftCard";
import { DashboardNavbar } from "@/components/dashboard/DashboardNavbar";

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

type TimeRange = "today" | "week" | "month";

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

function isDayToday(day: Date) {
  return day.toDateString() === new Date().toDateString();
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(date: Date) {
  const next = startOfDay(date);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function firstNameFromDisplayName(name: string) {
  const trimmed = name.trim();
  const base = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
  return base.split(/\s+/)[0] || "there";
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
  "I need to schedule meetings with Joe, Dan, and Sally — draft me an email for each.",
  "How much of my time am I spending in meetings? How should I reduce it?",
  "What does my week look like and where can I block focus time?",
];
type CancelScope = "today" | "all";
const CANCEL_ALL_CONFIRMATION = "CONFIRM CANCEL ALL MEETINGS";
const CANCEL_TODAY_CONFIRMATION = "CONFIRM CANCEL TODAY'S MEETINGS";

function isCancelMeetingsRequest(content: string) {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("cancel") &&
    (normalized.includes("meeting") || normalized.includes("meetings") || normalized.includes("events"))
  );
}

function getCancelScope(content: string): CancelScope | null {
  if (!isCancelMeetingsRequest(content)) return null;
  const normalized = content.toLowerCase();
  if (
    normalized.includes("today") ||
    normalized.includes("tonight") ||
    normalized.includes("this morning") ||
    normalized.includes("this afternoon") ||
    normalized.includes("this evening")
  ) {
    return "today";
  }
  if (normalized.includes("all")) return "all";
  return null;
}

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
  const [isCancellingAllMeetings, setIsCancellingAllMeetings] = useState(false);
  const [cancelPendingScope, setCancelPendingScope] = useState<CancelScope | null>(null);
  const isOverlayMounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [meetingTitle, setMeetingTitle] = useState("Team sync");
  const [meetingDurationMin, setMeetingDurationMin] = useState(30);
  const [meetingAttendees, setMeetingAttendees] = useState("");
  const [meetingDate, setMeetingDate] = useState(() => toDateInputValue(new Date()));
  const [meetingAfterTime, setMeetingAfterTime] = useState("09:00");
  const [slotSuggestions, setSlotSuggestions] = useState<SuggestedSlot[]>([]);
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const [creatingSlot, setCreatingSlot] = useState<string | null>(null);
  const [slotFeedback, setSlotFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [bookingSlot, setBookingSlot] = useState<SuggestedSlot | null>(null);
  const [bookingNote, setBookingNote] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date>(() => startOfDay(new Date()));
  const [timeRange, setTimeRange] = useState<TimeRange>("week");
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailFeedback, setEmailFeedback] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const syncInFlightRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const calendarHeaderScrollRef = useRef<HTMLDivElement>(null);
  const calendarGridScrollRef = useRef<HTMLDivElement>(null);

  const stats = useMemo(() => getWeekStats(events), [events]);
  const calendarDays = useMemo(() => {
    const base = timeRange === "today"
      ? startOfDay(selectedDate)
      : timeRange === "week"
        ? startOfWeek(selectedDate)
        : startOfMonth(selectedDate);
    const dayCount = timeRange === "today"
      ? 1
      : timeRange === "week"
        ? 7
        : new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    return Array.from({ length: dayCount }, (_, offset) => {
      const day = new Date(base);
      day.setDate(base.getDate() + offset);
      return day;
    });
  }, [selectedDate, timeRange]);
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
  const rangeEventCount = useMemo(
    () => dayEvents.reduce((total, day) => total + day.length, 0),
    [dayEvents]
  );
  const rangeMeetingHours = useMemo(
    () => Math.round((dayEvents.flat().reduce((total, event) => total + durationMin(event), 0) / 60) * 10) / 10,
    [dayEvents]
  );
  const rangeLabel = useMemo(() => {
    if (timeRange === "today") return "Today";
    if (timeRange === "week") return "This Week";
    return "This Month";
  }, [timeRange]);
  const calendarGridStyle = useMemo(
    () => ({
      gridTemplateColumns: `64px repeat(${calendarDays.length}, minmax(${timeRange === "month" ? "120px" : "0px"}, 1fr))`,
    }),
    [calendarDays.length, timeRange]
  );
  const calendarWindow = useMemo(() => ({ start: 0, end: 23 }), []);
  const HOUR_START = calendarWindow.start;
  const HOUR_END = calendarWindow.end;
  const HOUR_HEIGHT = 52;
  const hours = useMemo(
    () => Array.from({ length: HOUR_END - HOUR_START + 1 }, (_, i) => HOUR_START + i),
    [HOUR_END, HOUR_START]
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

  useEffect(() => {
    if (!calendarHeaderScrollRef.current || !calendarGridScrollRef.current) return;
    calendarHeaderScrollRef.current.scrollLeft = calendarGridScrollRef.current.scrollLeft;
  }, [timeRange, calendarDays.length]);

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function selectCalendarDate(date: Date) {
    setSelectedDate(date);
    setMeetingDate(toDateInputValue(date));
  }

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
          const deleted = Number(data.deleted ?? 0);
          setStatus(deleted > 0 ? `Synced ${data.synced} events and removed ${deleted}.` : `Synced ${data.synced} events.`);
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
    }, 10_000);

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

    if (trimmed === CANCEL_ALL_CONFIRMATION && cancelPendingScope === "all") {
      await cancelMeetings(next, "all");
      return;
    }

    if (trimmed === CANCEL_TODAY_CONFIRMATION && cancelPendingScope === "today") {
      await cancelMeetings(next, "today");
      return;
    }

    const cancelScope = getCancelScope(trimmed);
    if (cancelScope) {
      setCancelPendingScope(cancelScope);
      const confirmation = cancelScope === "today" ? CANCEL_TODAY_CONFIRMATION : CANCEL_ALL_CONFIRMATION;
      const scopeText = cancelScope === "today"
        ? "every synced meeting scheduled for today only"
        : "every upcoming synced meeting";
      setMessages(cur => [
        ...cur,
        {
          role: "assistant",
          content: `I can cancel ${scopeText} in Google Calendar. This will send cancellation updates to attendees where Google allows it.\n\nTo continue, type exactly: **${confirmation}**`,
        },
      ]);
      return;
    }

    setIsChatting(true);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        messages: next.filter(m => m.role !== "assistant" || m.content.length < 1200),
        userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });

    if (!res.ok || !res.body) {
      const errData = await res.json().catch(() => ({})) as { error?: string };
      setMessages(cur => [...cur, { role: "assistant", content: errData.error ?? "The agent couldn't respond." }]);
      setIsChatting(false);
      return;
    }

    setMessages(cur => [...cur, { role: "assistant", content: "" }]);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setMessages(cur => {
          const last = cur[cur.length - 1];
          return [...cur.slice(0, -1), { ...last, content: last.content + chunk }];
        });
      }
    } catch {
      setMessages(cur => {
        const last = cur[cur.length - 1];
        if (!last.content) {
          return [...cur.slice(0, -1), { role: "assistant", content: "The agent couldn't respond." }];
        }
        return cur;
      });
    } finally {
      setIsChatting(false);
    }
  }

  async function cancelMeetings(nextMessages: ChatMessage[], scope: CancelScope) {
    if (!session?.access_token || !session.provider_token || isCancellingAllMeetings) return;

    setIsCancellingAllMeetings(true);
    setIsChatting(true);

    try {
      const todayStart = startOfDay(new Date());
      const tomorrowStart = new Date(todayStart);
      tomorrowStart.setDate(tomorrowStart.getDate() + 1);

      const res = await fetch("/api/calendar/cancel-all", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          googleAccessToken: session.provider_token,
          confirm: scope === "today" ? CANCEL_TODAY_CONFIRMATION : CANCEL_ALL_CONFIRMATION,
          scope,
          startsAt: scope === "today" ? todayStart.toISOString() : undefined,
          endsAt: scope === "today" ? tomorrowStart.toISOString() : undefined,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        await loadEvents(session.access_token);
        setCancelPendingScope(null);
        const failedLine = data.failed
          ? ` ${data.failed} could not be cancelled.`
          : "";
        const scopeLabel = scope === "today" ? "today's synced meeting" : "upcoming synced meeting";
        setMessages([
          ...nextMessages,
          {
            role: "assistant",
            content: `Cancelled ${data.cancelled} ${scopeLabel}${data.cancelled === 1 ? "" : "s"}.${failedLine}`,
          },
        ]);
      } else {
        setMessages([
          ...nextMessages,
          {
            role: "assistant",
            content: data.error ?? "Could not cancel the meetings.",
          },
        ]);
        if (data.needsReconnect) {
          setStatus("Google write scope is missing — sign out and reconnect Google.");
        }
      }
    } catch {
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: "Could not reach the calendar cancellation service. Please try again.",
        },
      ]);
    } finally {
      setIsChatting(false);
      setIsCancellingAllMeetings(false);
    }
  }

  async function sendEmail() {
    if (!session?.access_token || isSendingEmail) return;
    if (!session.provider_token) {
      setEmailFeedback({ type: "err", text: "Google token missing — sign out and reconnect." });
      return;
    }
    setIsSendingEmail(true);
    setEmailFeedback(null);
    try {
      const res = await fetch("/api/gmail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          googleAccessToken: session.provider_token,
          to: emailTo,
          subject: emailSubject,
          body: emailBody,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setEmailFeedback({ type: "ok", text: "Email sent successfully." });
        setEmailTo("");
        setEmailSubject("");
        setEmailBody("");
      } else {
        setEmailFeedback({ type: "err", text: data.error ?? "Failed to send email." });
        if (data.needsReconnect) {
          setStatus("Gmail scope missing — sign out and reconnect Google.");
        }
      }
    } catch {
      setEmailFeedback({ type: "err", text: "Could not reach email service. Please try again." });
    } finally {
      setIsSendingEmail(false);
    }
  }

  function generateSuggestedSlots(durationMinutes: number, dateInput: string, afterTime: string) {
    const duration = Math.max(15, Number.isFinite(durationMinutes) ? durationMinutes : 30);
    if (!dateInput) return [];
    const [year, month, day] = dateInput.split("-").map(Number);
    if (!year || !month || !day) return [];

    const selectedDayStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    const selectedDayEnd = new Date(year, month - 1, day, 23, 59, 59, 999);

    const [afterHour, afterMinute] = afterTime.split(":").map(Number);
    const now = new Date();
    const startWindow = new Date(year, month - 1, day, afterHour ?? 9, afterMinute ?? 0, 0, 0);
    const endWindow = new Date(year, month - 1, day, 23, 0, 0, 0);
    const isToday = selectedDayStart.toDateString() === now.toDateString();
    if (isToday && now > startWindow) {
      const rounded = new Date(now);
      const roundedMinutes = Math.ceil(rounded.getMinutes() / 30) * 30;
      rounded.setMinutes(roundedMinutes, 0, 0);
      startWindow.setTime(rounded.getTime());
    }
    if (startWindow >= endWindow) return [];

    const busy = events
      .filter(event => {
        if (event.status === "cancelled") return false;
        const start = new Date(event.starts_at).getTime();
        const end = new Date(event.ends_at).getTime();
        return start < selectedDayEnd.getTime() && end > selectedDayStart.getTime();
      })
      .map(event => ({
        start: new Date(event.starts_at).getTime(),
        end: new Date(event.ends_at).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    const next: SuggestedSlot[] = [];
    let pointer = new Date(startWindow);
    while (pointer < endWindow && next.length < 3) {
      const slotStart = pointer.getTime();
      const slotEnd = slotStart + duration * 60 * 1000;
      if (slotEnd > endWindow.getTime()) break;
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

    return next;
  }

  function suggestMeetingSlots() {
    const next = generateSuggestedSlots(meetingDurationMin, meetingDate, meetingAfterTime);
    setSlotSuggestions(next);
    if (next.length === 0) {
      setStatus("No open slots found on that date. Try another date or shorter duration.");
    }
  }

  async function createInvite(slot: SuggestedSlot, note: string) {
    if (!session?.access_token || isCreatingInvite) return;
    if (!session.provider_token) {
      setSlotFeedback({ type: "err", text: "Google Calendar access expired — sign out and reconnect Google." });
      return;
    }
    setSlotFeedback(null);
    setIsCreatingInvite(true);
    setCreatingSlot(slot.startsAt);
    const attendees = meetingAttendees
      .split(",")
      .map(email => email.trim())
      .filter(Boolean);

    try {
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
          createMeetLink: true,
          sendUpdates: true,
        }),
      });
      const data = await res.json() as { ok?: boolean; meetLink?: string; needsReconnect?: boolean; error?: string };
      if (res.ok) {
        setSlotSuggestions([]);
        setBookingSlot(null);
        setBookingNote("");
        await loadEvents(session.access_token);

        // Send email to each attendee if there's a note or meet link
        const trimmedNote = note.trim();
        if (attendees.length > 0 && (trimmedNote || data.meetLink)) {
          const title = meetingTitle.trim() || "Meeting";
          const emailResults = await Promise.allSettled(
            attendees.map(to => {
              const bodyLines = [
                trimmedNote,
                trimmedNote ? "" : "",
                `Meeting: ${title}`,
                `When: ${slot.label}`,
                data.meetLink ? `Google Meet: ${data.meetLink}` : "",
              ].filter((line, i) => !(i === 1 && !trimmedNote) && line !== "");

              return fetch("/api/gmail/send", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({
                  googleAccessToken: session.provider_token,
                  to,
                  subject: `You're invited: ${title}`,
                  body: bodyLines.join("\n"),
                }),
              });
            })
          );

          const allSent = emailResults.every(r => r.status === "fulfilled");
          setSlotFeedback({
            type: "ok",
            text: allSent
              ? `Meeting booked and ${attendees.length === 1 ? "email" : `${attendees.length} emails`} sent.`
              : "Meeting booked. Some emails could not be sent.",
          });
        } else {
          setSlotFeedback({ type: "ok", text: "Meeting booked and synced to your calendar." });
        }
      } else if (data.needsReconnect) {
        setSlotFeedback({ type: "err", text: "Google write access is missing — sign out and reconnect Google." });
      } else {
        setSlotFeedback({ type: "err", text: data.error ?? "Could not create invite." });
      }
    } catch {
      setSlotFeedback({ type: "err", text: "Could not reach calendar service. Please try again." });
    } finally {
      setIsCreatingInvite(false);
      setCreatingSlot(null);
    }
  }

  async function copyMessage(text: string) {
    await navigator.clipboard.writeText(text);
    setStatus("Copied message to clipboard.");
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
  const firstName = firstNameFromDisplayName(displayName);
  const todayLabel = new Date().toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="dashboard-root">
      {/* ── Top Bar ── */}
      <DashboardNavbar
        firstName={firstName}
        todayLabel={todayLabel}
        displayName={displayName}
        avatarUrl={avatarUrl}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        onCompose={() => { setIsComposeOpen(true); setEmailFeedback(null); }}
        onSignOut={signOut}
      />

      {/* ── Body ── */}
      <div className="dashboard-body dashboard-body-calendar">
        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div className="calendar-toolbar-left">
              <h2 className="calendar-title">Your schedule</h2>
              <span className="panel-badge">{rangeEventCount} events in {rangeLabel.toLowerCase()}</span>
            </div>
            <div className="calendar-summary">
              <span>{rangeEventCount} meetings in {rangeLabel.toLowerCase()}</span>
              <span>{rangeMeetingHours}h booked</span>
            </div>
          </div>

          <div className="dashboard-tools">
            <div className="dashboard-tools-left">
              <MiniCalendar events={events} selectedDate={selectedDate} onSelectDate={selectCalendarDate} />
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
              <div className="planner-header">
                <h3 className="planner-title">Meeting Planner</h3>
                <p className="planner-subtitle">Find open slots on your calendar</p>
              </div>
              <div className="planner-fields">
                <div className="planner-field-group">
                  <label className="planner-label">Title</label>
                  <input className="planner-input" value={meetingTitle} onChange={e => setMeetingTitle(e.target.value)} placeholder="Team sync" />
                </div>
                <div className="planner-field-group">
                  <label className="planner-label">Attendees</label>
                  <input className="planner-input" value={meetingAttendees} onChange={e => setMeetingAttendees(e.target.value)} placeholder="alice@co.com, bob@co.com" />
                </div>
                <div className="planner-section-divider" />
                <div className="planner-field-group">
                  <label className="planner-label">Date &amp; after</label>
                  <div style={{ display: "flex", gap: "0.45rem" }}>
                    <input
                      className="planner-input"
                      type="date"
                      value={meetingDate}
                      style={{ flex: 1, width: 0 }}
                      onChange={e => {
                        const nextDate = e.target.value;
                        setMeetingDate(nextDate);
                        if (nextDate) {
                          selectCalendarDate(startOfDay(new Date(`${nextDate}T00:00:00`)));
                        }
                      }}
                    />
                    <input
                      className="planner-input"
                      type="time"
                      value={meetingAfterTime}
                      onChange={e => setMeetingAfterTime(e.target.value)}
                      title="Find slots starting from this time"
                      style={{ width: "130px" }}
                    />
                  </div>
                </div>
                <div className="planner-field-group">
                  <label className="planner-label">Duration</label>
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
                </div>
              </div>
              <button className="btn-find-time" type="button" onClick={suggestMeetingSlots}>
                Find a time
              </button>
              <div className="suggested-slots">
                {slotSuggestions.length === 0 ? (
                  <span className="slots-empty">No suggestions yet.</span>
                ) : (
                  slotSuggestions.map(slot => {
                    const isExpanded = bookingSlot?.startsAt === slot.startsAt;
                    return (
                      <div className={`slot-item${isExpanded ? " slot-item-expanded" : ""}`} key={slot.startsAt}>
                        <div className="slot-item-top">
                          <div className="slot-item-meta">
                            <div className="slot-badge">No conflicts</div>
                            <div className="slot-time">{slot.label}</div>
                          </div>
                          {!isExpanded && (
                            <button
                              className="slot-book-btn"
                              type="button"
                              onClick={() => { setBookingSlot(slot); setBookingNote(""); setSlotFeedback(null); }}
                              disabled={isCreatingInvite}
                            >
                              Book →
                            </button>
                          )}
                        </div>
                        {isExpanded && (
                          <div className="slot-note-expanded">
                            <textarea
                              className="slot-note-input"
                              placeholder="Add a note to attendees… (optional)"
                              value={bookingNote}
                              onChange={e => setBookingNote(e.target.value)}
                              rows={2}
                              disabled={isCreatingInvite}
                              autoFocus
                            />
                            <div className="slot-confirm-actions">
                              <button
                                className="btn-ghost"
                                type="button"
                                onClick={() => { setBookingSlot(null); setBookingNote(""); }}
                                disabled={isCreatingInvite}
                              >
                                Cancel
                              </button>
                              <button
                                className="slot-book-btn"
                                type="button"
                                onClick={() => createInvite(slot, bookingNote)}
                                disabled={isCreatingInvite}
                              >
                                {creatingSlot === slot.startsAt ? "Booking…" : "Send & Book →"}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
                {slotFeedback && (
                  <p className={`slot-feedback slot-feedback-${slotFeedback.type}`}>
                    {slotFeedback.text}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div className="calendar-board">
            <div className="calendar-header-scroll" ref={calendarHeaderScrollRef}>
              <div className="calendar-header" style={calendarGridStyle}>
                <div className="calendar-time-head" />
                {calendarDays.map(day => (
                  <div className={`calendar-day-head${isDayToday(day) ? " is-today" : ""}`} key={day.toISOString()}>
                    <small>{day.toLocaleDateString([], { weekday: "short" })}</small>
                    <strong>{day.getDate()}</strong>
                  </div>
                ))}
              </div>
            </div>

            <div
              className="calendar-grid-shell"
              style={calendarGridStyle}
              ref={calendarGridScrollRef}
              onScroll={(event) => {
                if (!calendarHeaderScrollRef.current) return;
                calendarHeaderScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }}
            >
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

      {isOverlayMounted && isComposeOpen ? createPortal(
        <>
          <button
            className="chat-float-backdrop open"
            type="button"
            aria-label="Close compose"
            onClick={() => setIsComposeOpen(false)}
          />
          <div className="compose-panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">Compose Email</h2>
                <p className="panel-kicker">Sent from your Google account</p>
              </div>
              <button
                className="btn-ghost chat-close-btn"
                type="button"
                onClick={() => setIsComposeOpen(false)}
                aria-label="Close compose"
              >
                ×
              </button>
            </div>
            <div className="compose-fields">
              <div className="planner-field-group">
                <label className="planner-label">To</label>
                <input
                  className="planner-input"
                  type="email"
                  value={emailTo}
                  onChange={e => setEmailTo(e.target.value)}
                  placeholder="recipient@example.com"
                  disabled={isSendingEmail}
                />
              </div>
              <div className="planner-field-group">
                <label className="planner-label">Subject</label>
                <input
                  className="planner-input"
                  value={emailSubject}
                  onChange={e => setEmailSubject(e.target.value)}
                  placeholder="Email subject"
                  disabled={isSendingEmail}
                />
              </div>
              <div className="planner-field-group">
                <label className="planner-label">Message</label>
                <textarea
                  className="compose-body"
                  value={emailBody}
                  onChange={e => setEmailBody(e.target.value)}
                  placeholder="Write your email here..."
                  rows={10}
                  disabled={isSendingEmail}
                />
              </div>
            </div>
            {emailFeedback && (
              <p className={`slot-feedback slot-feedback-${emailFeedback.type}`}>
                {emailFeedback.text}
              </p>
            )}
            <div className="compose-actions">
              <button
                className="btn-ghost"
                type="button"
                onClick={() => setIsComposeOpen(false)}
              >
                Discard
              </button>
              <button
                className="btn-primary"
                type="button"
                onClick={sendEmail}
                disabled={isSendingEmail || !emailTo.trim() || !emailSubject.trim() || !emailBody.trim()}
              >
                {isSendingEmail ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </>,
        document.body,
      ) : null}

      {isOverlayMounted ? createPortal(
        <>
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
          <div>
            <h2 className="panel-title">Ask AI</h2>
            <p className="panel-kicker">Grounded in your synced calendar</p>
          </div>
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
          {messages.map((msg, i) => {
            const isStreaming = isChatting && i === messages.length - 1 && msg.role === "assistant" && msg.content === "";
            return (
            <div className={`chat-bubble ${msg.role}`} key={i}>
              {isStreaming ? (
                <div className="thinking-dots"><span /><span /><span /></div>
              ) : (
              <>
              {msg.role === "assistant" && (
                <div style={{ marginBottom: "0.375rem" }}>
                  <span className="chat-assistant-icon">CA</span>
                </div>
              )}
              <div className="chat-rich-text">
                {parseMessageParts(msg.content).map((part, partIdx) =>
                  part.kind === "text" ? (
                    <div key={partIdx}>
                      {part.content.split("\n").map((line, idx) => {
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
                  ) : (
                    <EmailDraftCard
                      key={partIdx}
                      to={part.to}
                      subject={part.subject}
                      body={part.body}
                      onOpenCompose={(to, subject, body) => {
                        setEmailTo(to);
                        setEmailSubject(subject);
                        setEmailBody(body);
                        setEmailFeedback(null);
                        setIsComposeOpen(true);
                      }}
                    />
                  )
                )}
              </div>
              {msg.role === "assistant" && msg.content && (
                <div className="chat-msg-actions">
                  <button className="btn-ghost" type="button" onClick={() => copyMessage(msg.content)}>Copy</button>
                </div>
              )}
              </>
              )}
            </div>
            );
          })}
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
        </>,
        document.body,
      ) : null}
    </div>
  );
}
