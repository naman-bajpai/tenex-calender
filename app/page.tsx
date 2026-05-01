"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FloatingPathsBackground } from "@/components/ui/floating-paths";
import { supabase } from "@/lib/supabase";

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.717v2.258h2.908C16.658 14.251 17.64 11.943 17.64 9.2z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.replace("/dashboard");
      } else {
        setReady(true);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) router.replace("/dashboard");
    });

    return () => subscription.unsubscribe();
  }, [router]);

  async function signInWithGoogle() {
    if (signingIn) return;
    setSigningIn(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        // Return to the landing page first so the client can
        // establish session state before pushing to /dashboard.
        redirectTo: window.location.origin,
        scopes: "openid email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send",
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
    if (error) {
      setSigningIn(false);
    }
  }

  if (!ready) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <FloatingPathsBackground className="landing-page" position={-1}>
      <div className="landing-glow-1" aria-hidden="true" />
      <div className="landing-glow-2" aria-hidden="true" />

      <main className="landing-main">
        <h1 className="landing-headline">
          Calendar Agent
        </h1>

        <p className="landing-sub">
          Connect Google Calendar and jump straight into your dashboard.
        </p>

        <button
          className="google-signin-btn"
          onClick={signInWithGoogle}
          disabled={signingIn}
        >
          {signingIn ? <div className="spinner" style={{ borderColor: "#aaa", borderTopColor: "transparent" }} /> : <GoogleLogo />}
          <span>{signingIn ? "Redirecting to Google…" : "Continue with Google"}</span>
        </button>

        <p className="landing-fine-print">Free to use · No credit card required</p>
      </main>
    </FloatingPathsBackground>
  );
}
