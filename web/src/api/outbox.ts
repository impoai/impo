export interface PendingCommand {
  path: string;
  body: Record<string, unknown>;
  createdAt: string;
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
/** Persist before POST; an uncertain receipt must reuse the exact command. */
export class Outbox {
  readonly key: string;
  constructor(
    account: string,
    conversation: string,
    private storage: StorageLike,
  ) {
    this.key = `impo:outbox:${encodeURIComponent(account)}:${encodeURIComponent(conversation)}`;
  }
  read(): PendingCommand | null {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value.path !== "string" ||
      !value.body ||
      typeof value.body.clientMessageId !== "string"
    )
      throw new Error("The saved message could not be recovered.");
    return value;
  }
  save(command: PendingCommand) {
    if (this.read())
      throw new Error(
        "Retry or dismiss the previous message before sending another.",
      );
    this.storage.setItem(this.key, JSON.stringify(command));
  }
  clear() {
    this.storage.removeItem(this.key);
  }
}
export function clearAccountStorage(account: string, storage: Storage) {
  const prefixes = [
    `impo:outbox:${encodeURIComponent(account)}:`,
    `impo:draft:${encodeURIComponent(account)}:`,
  ];
  for (const key of Object.keys(storage))
    if (prefixes.some((prefix) => key.startsWith(prefix)))
      storage.removeItem(key);
}
