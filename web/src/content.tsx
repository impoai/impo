import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Download, ArrowUpRight, Copy, Check } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  VStack,
  HStack,
  Dialog,
  DialogHeader,
  ErrorNotice,
  Loading,
} from "./ui";
import { useSession } from "./session";
import {
  record,
  type Message,
  type DeliveredFile,
  type Product,
  type ProductSelection,
} from "./api/types";
import { safeHTTPS } from "./api/client";
import { normalizeMath } from "./markdown";

export function Markdown({ text }: { text: string }) {
  return (
    <VStack className="markdown" gap={0}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
        components={{
          a: ({ href, children }) =>
            safeHTTPS(href) ? (
              <a
                href={safeHTTPS(href)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ) : (
              <>{children}</>
            ),
          img: ({ alt }) => <em>{alt || "Image"}</em>,
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </VStack>
  );
}
export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <Button
      label={copied ? "Copied" : error ? "Select text to copy" : "Copy"}
      variant="ghost"
      size="sm"
      icon={copied ? <Check /> : <Copy />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setError(true);
        }
      }}
    />
  );
}
function FileLink({ file }: { file: DeliveredFile }) {
  const { api } = useSession();
  const [error, setError] = useState<unknown>();
  return (
    <VStack gap={2}>
      <Button
        label={file.name}
        icon={<Download />}
        clickAction={async () => {
          setError(undefined);
          try {
            const blob = await (
              await api.response(`/files/${encodeURIComponent(file.fileId)}`)
            ).blob();
            if (api.controller.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = file.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
          } catch (e) {
            setError(e);
          }
        }}
      />
      {!!error && <ErrorNotice error={error} />}
    </VStack>
  );
}
function ProductImage({ product }: { product: Product }) {
  const [failedURL, setFailedURL] = useState<string>();
  const url = safeHTTPS(product.imageURL);
  if (!url || new URL(url).hostname !== "cdn.shopify.com" || failedURL === url)
    return <p className="product-placeholder">{product.merchant}</p>;
  return (
    <img
      src={url}
      alt={product.title}
      loading="lazy"
      onError={() => setFailedURL(url)}
    />
  );
}
function Products({
  messageId,
  selection,
}: {
  messageId: string;
  selection: ProductSelection;
}) {
  const { api } = useSession();
  const [selected, setSelected] = useState<Product | null>(null);
  const query = useQuery({
    queryKey: ["products", messageId, selection.selectionId],
    queryFn: ({ signal }) =>
      api.get<{ products: Product[] }>(
        `/messages/${encodeURIComponent(messageId)}/products?selectionId=${encodeURIComponent(selection.selectionId)}`,
        signal,
      ),
    staleTime: 60000,
  });
  const detail = useQuery({
    queryKey: ["product", messageId, selection.selectionId, selected?.id],
    enabled: !!selected,
    queryFn: ({ signal }) =>
      api.get<{ products: Product[] }>(
        `/messages/${encodeURIComponent(messageId)}/products?selectionId=${encodeURIComponent(selection.selectionId)}&productId=${encodeURIComponent(selected!.id)}`,
        signal,
      ),
    staleTime: 0,
  });
  const product =
    detail.data?.products.find((p) => p.id === selected?.id) || selected;
  if (query.isPending)
    return <Loading label="Finding the latest product details…" />;
  if (query.error)
    return (
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
    );
  return (
    <>
      <HStack className="products" gap={3}>
        {query.data?.products.map((p) => (
          <button className="product" key={p.id} onClick={() => setSelected(p)}>
            <ProductImage product={p} />
            <small>{p.merchant}</small>
            <strong>{p.title}</strong>
            <p>{p.price?.formatted || "See store for price"}</p>
          </button>
        ))}
      </HStack>
      <Dialog
        isOpen={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        width={600}
        maxHeight="90dvh"
      >
        <DialogHeader
          title="Product details"
          onOpenChange={(v) => !v && setSelected(null)}
        />
        {product && (
          <>
            <VStack padding={4} gap={4} className="product-detail">
              <ProductImage product={product} />
              <p className="eyebrow">{product.merchant}</p>
              <h2>{product.title}</h2>
              <h3>{product.price?.formatted || "See store for price"}</h3>
              {product.available === false && <p>Currently unavailable</p>}
              {detail.error && (
                <ErrorNotice
                  error={detail.error}
                  retry={() => void detail.refetch()}
                />
              )}
              <p className="product-description">{product.description}</p>
              {product.options?.map((o) => (
                <p key={o.name}>
                  <b>{o.name}</b> · {o.values.join(", ")}
                </p>
              ))}
            </VStack>
            <VStack className="product-footer" padding={4} gap={2}>
              {safeHTTPS(product.url) && (
                <Button
                  label={`Visit ${product.merchant || "store"}`}
                  variant="primary"
                  href={safeHTTPS(product.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  icon={<ArrowUpRight />}
                />
              )}
              <small>
                Final price, availability and purchase options are shown by the
                store.
              </small>
            </VStack>
          </>
        )}
      </Dialog>
    </>
  );
}
export function MessageParts({ message }: { message: Message }) {
  return (
    <VStack gap={3}>
      {message.parts?.map((part, index) => {
        const data = record(part.data);
        if (
          part.type === "data-instant-file" &&
          data?.schemaVersion === 1 &&
          typeof data.fileId === "string" &&
          typeof data.name === "string"
        )
          return (
            <FileLink key={index} file={data as unknown as DeliveredFile} />
          );
        if (
          part.type === "data-impo-products" &&
          data?.schemaVersion === 1 &&
          typeof data.selectionId === "string"
        )
          return (
            <Products
              key={index}
              messageId={message.id}
              selection={data as unknown as ProductSelection}
            />
          );
        if (part.type === "data-instant-step" && data?.title)
          return (
            <p className="step" key={index}>
              {String(data.title)}
              {data.status === "running" ? "…" : ""}
            </p>
          );
        if (part.type === "data-instant-device-request")
          return (
            <p className="step" key={index}>
              Waiting for your connected phone.
            </p>
          );
        const output = record(part.output);
        const parameters = record(output?.parameters);
        if (
          part.type === "dynamic-tool" &&
          part.state === "output-available" &&
          output?.kind === "client_action" &&
          output.schemaVersion === 1 &&
          output.capability === part.toolName &&
          output.execution === "device" &&
          output.interaction === "tap" &&
          output.status === "ready" &&
          parameters
        ) {
          if (
            part.toolName === "impo_open_link" &&
            Object.keys(parameters).length === 1 &&
            safeHTTPS(parameters.url)
          )
            return (
              <Button
                key={index}
                label="Open link"
                href={safeHTTPS(parameters.url)}
                target="_blank"
                rel="noopener noreferrer"
                icon={<ArrowUpRight />}
              />
            );
          if (
            part.toolName === "impo_navigate" &&
            Object.keys(parameters).length === 2 &&
            typeof parameters.destination === "string" &&
            parameters.destination.length <= 300 &&
            !/[\x00-\x1f]/.test(parameters.destination) &&
            ["driving", "walking", "transit"].includes(String(parameters.mode))
          )
            return (
              <Button
                key={index}
                label={`Directions to ${parameters.destination}`}
                href={`https://maps.apple.com/?daddr=${encodeURIComponent(parameters.destination)}&dirflg=${({ driving: "d", walking: "w", transit: "r" } as Record<string, string>)[String(parameters.mode)]}`}
                target="_blank"
                rel="noopener noreferrer"
              />
            );
        }
        return null;
      })}
    </VStack>
  );
}
