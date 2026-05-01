"use client";

import Image from "next/image";
import { LogOut, Mail } from "lucide-react";

type TimeRange = "today" | "week" | "month";

type DashboardNavbarProps = {
  firstName: string;
  todayLabel: string;
  displayName: string;
  avatarUrl?: string;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  onCompose: () => void;
  onSignOut: () => void;
};

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

export function DashboardNavbar({
  firstName,
  todayLabel,
  displayName,
  avatarUrl,
  timeRange,
  onTimeRangeChange,
  onCompose,
  onSignOut,
}: DashboardNavbarProps) {
  return (
    <header className="dashboard-topbar">
      <div className="dashboard-topbar-left">
        <div className="dash-logo-mark" aria-hidden="true">CA</div>
        <div className="dash-brand-copy">
          <strong>Welcome {firstName}</strong>
          <span>Today&apos;s date is {todayLabel}</span>
        </div>
      </div>

      <div className="dashboard-range-tabs" role="tablist" aria-label="Schedule range">
        {[
          { key: "today", label: "Today" },
          { key: "week", label: "This Week" },
          { key: "month", label: "This Month" },
        ].map((range) => (
          <button
            key={range.key}
            type="button"
            role="tab"
            aria-selected={timeRange === range.key}
            className={`range-tab${timeRange === range.key ? " active" : ""}`}
            onClick={() => onTimeRangeChange(range.key as TimeRange)}
          >
            {range.label}
          </button>
        ))}
      </div>

      <div className="dashboard-topbar-actions">
        <button
          className="btn-ghost topbar-action-btn"
          type="button"
          onClick={onCompose}
          title="Compose email"
          aria-label="Compose email"
        >
          <Mail size={15} aria-hidden="true" />
          <span>Compose</span>
        </button>

        <button className="btn-ghost topbar-action-btn" type="button" onClick={onSignOut} title="Log out" aria-label="Sign out">
          <LogOut size={15} aria-hidden="true" />
          <span>Sign out</span>
        </button>
        <div className="user-pill" title={displayName}>
          <div className="user-avatar">
            {avatarUrl ? <Image src={avatarUrl} alt={displayName} width={28} height={28} style={{ borderRadius: "50%", display: "block" }} /> : initials(displayName)}
          </div>
          <span className="user-name">{displayName}</span>
        </div>
      </div>
    </header>
  );
}
