import { useEffect, useRef, useState } from "react";
import { Plug, ArrowUpRight, RefreshCw } from "lucide-react";
import {
  Page,
  VStack,
  HStack,
  Button,
  Loading,
  ErrorNotice,
  TextInput,
  Confirm,
  Empty,
  humanStatus,
} from "./ui";
import { useApiQuery, useSession } from "./session";
import type { Connector } from "./api/types";
import { safeHTTPS } from "./api/client";
export default function Connections() {
  const { api } = useSession();
  const query = useApiQuery<{ connectors: Connector[] }>("/connectors");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState<string>();
  const matches =
    query.data?.connectors.filter((c) =>
      `${c.name} ${c.description}`.toLowerCase().includes(search.toLowerCase()),
    ) || [];
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const refresh = () => void query.refetch();
    window.addEventListener("focus", refresh);
    return () => {
      alive.current = false;
      clearInterval(timer.current);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  async function connect(c: Connector) {
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setPending(c.toolkit);
    setError(undefined);
    try {
      const result = await api.mutate<{
        redirectURL: string;
        expiresAt: string;
      }>(`/connectors/${c.toolkit}/connect`);
      if (!alive.current) {
        popup?.close();
        return;
      }
      const url = safeHTTPS(result.redirectURL);
      if (!url)
        throw new Error("The service returned an invalid sign-in link.");
      if (popup) popup.location.href = url;
      else {
        setError(new Error("Allow pop-up windows, then try connecting again."));
        return;
      }
      await query.refetch();
      clearInterval(timer.current);
      let tries = 0;
      timer.current = setInterval(async () => {
        if (++tries > 60) {
          clearInterval(timer.current);
          return;
        }
        try {
          const status = await api.mutate<Connector>(
            `/connectors/${c.toolkit}/refresh`,
          );
          if (!alive.current) return;
          if (status.status !== "pending") {
            clearInterval(timer.current);
            await query.refetch();
            setPending(undefined);
          }
        } catch {
          clearInterval(timer.current);
          await query.refetch();
          setPending(undefined);
        }
      }, 3000);
    } catch (e) {
      popup?.close();
      setError(e);
    } finally {
      if (alive.current) setPending(undefined);
    }
  }
  return (
    <Page
      title="Bring your world together."
      eyebrow="Connections"
      actions={
        <Button
          label="Refresh"
          icon={<RefreshCw />}
          isLoading={query.isFetching}
          onClick={() => void query.refetch()}
        />
      }
    >
      <p className="lede">
        Let your personal agent work with the apps you already use. You choose
        what to connect.
      </p>
      <TextInput
        label="Find an app"
        value={search}
        onChange={setSearch}
        hasClear
      />
      {!!error && <ErrorNotice error={error} />}
      <p className="notice">
        Phone permissions, including Health, contacts and location, are managed
        in the iOS or Android app.
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      ) : !matches.length ? (
        <Empty
          title={search ? "No matching apps." : "Your apps will appear here."}
          body={
            search
              ? "Try another name or clear your search."
              : "Refresh to check which connections are available."
          }
        />
      ) : (
        <VStack gap={0}>
          {matches.map((c) => (
            <HStack
              className="list-row connection-row"
              gap={4}
              key={c.toolkit}
              wrap="wrap"
            >
              <VStack
                className="connection-icon"
                hAlign="center"
                vAlign="center"
              >
                {safeHTTPS(c.logoURL) ? (
                  <img src={safeHTTPS(c.logoURL)} alt="" loading="lazy" />
                ) : (
                  <Plug />
                )}
              </VStack>
              <VStack className="grow" gap={2}>
                <h3>{c.name}</h3>
                <p>{c.description}</p>
                <small>
                  {humanStatus(c.status)}
                  {c.email ? ` · ${c.email}` : ""}
                </small>
              </VStack>
              {c.status === "connected" ? (
                <Confirm
                  title={`Disconnect ${c.name}?`}
                  description="Impo will no longer have access to this connection."
                  label="Disconnect"
                  action={async () => {
                    await api.mutate(`/connectors/${c.toolkit}`, {}, "DELETE");
                    await query.refetch();
                  }}
                />
              ) : (
                <Button
                  label={
                    c.status === "pending"
                      ? "Check connection"
                      : c.status === "expired"
                        ? "Reconnect"
                        : "Connect"
                  }
                  icon={<ArrowUpRight />}
                  isLoading={pending === c.toolkit}
                  onClick={() =>
                    c.status === "pending"
                      ? void api
                          .mutate(`/connectors/${c.toolkit}/refresh`)
                          .then(() => query.refetch())
                          .catch(setError)
                      : void connect(c)
                  }
                />
              )}
            </HStack>
          ))}
        </VStack>
      )}
    </Page>
  );
}
