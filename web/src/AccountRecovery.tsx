import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "./session";
import { VStack, Loading, Button, ErrorNotice } from "./ui";
import { clearAccountStorage } from "./api/outbox";

/** A lost DELETE response is recovered read-only, even after identity removal. */
export function AccountRecovery({ children }: { children: ReactNode }) {
  const { account, api, signOut } = useSession();
  const [checking, setChecking] = useState(true);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const key = `impo:deletion:${encodeURIComponent(account)}`;
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const intent = JSON.parse(raw);
        if (
          intent.confirmed !== true ||
          typeof intent.challengeId !== "string" ||
          typeof intent.token !== "string"
        )
          return;
        const response = await fetch(
          `/api/v1/account/deletions/${encodeURIComponent(intent.challengeId)}`,
          {
            headers: { Authorization: `Bearer ${intent.token}` },
            credentials: "omit",
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (response.status === 404) return;
        if (!response.ok)
          throw new Error(
            "Could not check your account deletion. Please retry before continuing.",
          );
        const receipt = await response.json();
        if (controller.signal.aborted) return;
        localStorage.setItem(
          "impo:deletion-receipt",
          JSON.stringify({ ...receipt, receiptToken: intent.token }),
        );
        localStorage.removeItem(key);
        clearAccountStorage(account, localStorage);
        api.close();
        setDeleted(true);
      } catch (e) {
        if (!controller.signal.aborted) setError(e);
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    })();
    return () => controller.abort();
  }, [account, api]);
  if (checking) return <Loading label="Checking your account…" />;
  if (error)
    return (
      <VStack padding={8}>
        <ErrorNotice error={error} retry={() => location.reload()} />
      </VStack>
    );
  if (deleted)
    return (
      <VStack padding={8} gap={4}>
        <h1>Account deletion requested.</h1>
        <p>
          Your account data is no longer available. Provider cleanup usually
          finishes within 24 hours.
        </p>
        <Button label="Sign out" onClick={() => void signOut()} />
      </VStack>
    );
  return children;
}

interface SavedReceipt {
  requestId: string;
  receiptToken: string;
  status: string;
  appleManualRevocationRequired?: boolean;
}
export function DeletionStatus() {
  const [receipt, setReceipt] = useState<SavedReceipt | null>(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem("impo:deletion-receipt") || "null",
      );
      return value &&
        typeof value.requestId === "string" &&
        typeof value.receiptToken === "string"
        ? value
        : null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<unknown>();
  if (!receipt) return null;
  return (
    <VStack className="notice" gap={3}>
      <p>
        {receipt.status === "deleted"
          ? "Your previous account deletion is complete."
          : "Your previous account deletion is processing. Provider cleanup usually finishes within 24 hours."}
      </p>
      {receipt.appleManualRevocationRequired && (
        <p>
          Remove Impo from your Apple Account’s Sign in with Apple settings if
          you used Apple to sign in.
        </p>
      )}
      {!!error && <ErrorNotice error={error} />}
      <Button
        label="Check deletion status"
        clickAction={async () => {
          setError(undefined);
          try {
            const response = await fetch(
              `/api/v1/account/deletions/${encodeURIComponent(receipt.requestId)}`,
              {
                headers: { Authorization: `Bearer ${receipt.receiptToken}` },
                credentials: "omit",
                cache: "no-store",
                signal: AbortSignal.timeout(20000),
              },
            );
            if (!response.ok)
              throw new Error(
                "The deletion receipt is unavailable. Please try again or contact support.",
              );
            const updated = { ...receipt, ...(await response.json()) };
            if (
              JSON.parse(
                localStorage.getItem("impo:deletion-receipt") || "null",
              )?.requestId === receipt.requestId
            ) {
              localStorage.setItem(
                "impo:deletion-receipt",
                JSON.stringify(updated),
              );
              setReceipt(updated);
            }
          } catch (e) {
            setError(e);
          }
        }}
      />
      <Button
        label="Dismiss receipt on this browser"
        variant="ghost"
        onClick={() => {
          localStorage.removeItem("impo:deletion-receipt");
          setReceipt(null);
        }}
      />
    </VStack>
  );
}
