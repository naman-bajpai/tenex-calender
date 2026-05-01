type Props = {
  to: string;
  subject: string;
  body: string;
  onOpenCompose: (to: string, subject: string, body: string) => void;
};

export function EmailDraftCard({ to, subject, body, onOpenCompose }: Props) {
  return (
    <div className="email-draft-card">
      <div className="email-draft-header">
        <span className="email-draft-label">Email Draft</span>
      </div>
      <div className="email-draft-meta">
        {to && (
          <div className="email-meta-row">
            <span className="email-meta-key">To</span>
            <span className="email-meta-val">{to}</span>
          </div>
        )}
        <div className="email-meta-row">
          <span className="email-meta-key">Subject</span>
          <span className="email-meta-val">{subject}</span>
        </div>
      </div>
      <pre className="email-draft-body">{body}</pre>
      <div className="email-draft-actions">
        <button
          className="btn-primary"
          type="button"
          onClick={() => onOpenCompose(to, subject, body)}
        >
          Open in Compose →
        </button>
      </div>
    </div>
  );
}
