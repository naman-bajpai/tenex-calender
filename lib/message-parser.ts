export type MessagePart =
  | { kind: "text"; content: string }
  | { kind: "email"; to: string; subject: string; body: string };

export function parseMessageParts(content: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const re = /\[EMAIL_DRAFT\]([\s\S]*?)\[\/EMAIL_DRAFT\]/g;
  let lastIndex = 0;
  let match;

  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) parts.push({ kind: "text", content: text });
    }
    const block = match[1];
    const toMatch = block.match(/^To:\s*(.+)$/m);
    const subjectMatch = block.match(/^Subject:\s*(.+)$/m);
    const sepIdx = block.indexOf("---");
    const body =
      sepIdx !== -1
        ? block.slice(sepIdx + 3).trim()
        : block.replace(/^(To|Subject):.+$/gm, "").trim();
    parts.push({
      kind: "email",
      to: toMatch?.[1]?.trim() ?? "",
      subject: subjectMatch?.[1]?.trim() ?? "",
      body,
    });
    lastIndex = re.lastIndex;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) parts.push({ kind: "text", content: text });
  }

  return parts.length > 0 ? parts : [{ kind: "text", content }];
}
