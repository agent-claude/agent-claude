// Pure helpers. Validate destination email before any Klaviyo (or other) send.
// Phase 2 wiring must call emailSendBlockReason() on every send. If it returns
// a non-null string, the send must be aborted and the reason persisted into
// OrderEmailLog.lastEmailError via markEmailError() so the UI shows "Erreur".

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return EMAIL_RE.test(trimmed);
}

// Returns null if the email is OK to send, otherwise a short reason string
// suitable for persisting to OrderEmailLog.lastEmailError.
export function emailSendBlockReason(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "Email destinataire manquant";
  }
  if (!isValidEmail(value)) {
    return "Email destinataire invalide";
  }
  return null;
}
