export function parseGoogleError(detail: string): { message: string | null; reason: string | null } {
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

export function isInsufficientPermissions(status: number, parsed: { reason: string | null; message: string | null }) {
  return (
    status === 403 &&
    (parsed.reason === "insufficientPermissions" ||
      parsed.message?.toLowerCase().includes("insufficient") === true)
  );
}
