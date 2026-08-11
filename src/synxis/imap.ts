import { ImapFlow } from "imapflow";

const CODE_RE = /The code is (\d+)<br>/i;
const CODE_RE_ALT = /The code is (\d+)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLatestVerificationCode(
  gmailAddress: string,
  gmailAppPassword: string,
): Promise<string | null> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: gmailAddress,
      pass: gmailAppPassword.replace(/\s+/g, ""),
    },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date();
      since.setDate(since.getDate() - 1);

      const messages: Array<{ date: Date; html: string }> = [];
      for await (const msg of client.fetch(
        { from: "noreply@synxis.com", subject: "Security Code", since },
        { source: true, internalDate: true },
      )) {
        const raw = msg.source?.toString("utf8") ?? "";
        messages.push({
          date: msg.internalDate instanceof Date ? msg.internalDate : new Date(msg.internalDate ?? 0),
          html: raw,
        });
      }

      messages.sort((a, b) => b.date.getTime() - a.date.getTime());
      for (const m of messages) {
        const match = m.html.match(CODE_RE) ?? m.html.match(CODE_RE_ALT);
        if (match?.[1]) return match[1];
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function clearGmailInbox(
  gmailAddress: string,
  gmailAppPassword: string,
): Promise<void> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: gmailAddress,
      pass: gmailAppPassword.replace(/\s+/g, ""),
    },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ all: true });
      if (uids && uids.length > 0) {
        await client.messageMove(uids, "[Gmail]/Trash");
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function waitForSynxisVerificationCode(
  gmailAddress: string,
  gmailAppPassword: string,
  options?: {
    attempts?: number;
    delayMs?: number;
    sleepBeforeEachAttempt?: boolean;
  },
): Promise<string> {
  const attempts = options?.attempts ?? 6;
  const delayMs = options?.delayMs ?? 5000;

  for (let i = 0; i < attempts; i++) {
    if (options?.sleepBeforeEachAttempt || i > 0) await sleep(delayMs);
    const code = await fetchLatestVerificationCode(gmailAddress, gmailAppPassword);
    if (code) return code;
  }

  throw new Error("Could not fetch SynXis MFA code from Gmail inbox");
}
