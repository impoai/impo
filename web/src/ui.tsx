import { useState, type ReactNode, type ComponentProps } from "react";
import { Button } from "@astryxdesign/core/Button";
import {
  Dialog as AstryxDialog,
  DialogHeader,
} from "@astryxdesign/core/Dialog";
import { VStack, HStack } from "@astryxdesign/core/Layout";
export { Button, DialogHeader, VStack, HStack };
export function Dialog(props: ComponentProps<typeof AstryxDialog>) {
  return <AstryxDialog maxHeight="90dvh" {...props} />;
}
export function DialogFooter(props: ComponentProps<typeof HStack>) {
  return (
    <HStack
      padding={4}
      gap={2}
      hAlign="end"
      wrap="wrap"
      {...props}
      className="dialog-footer"
    />
  );
}
export function DialogBody({
  className = "",
  ...props
}: ComponentProps<typeof VStack>) {
  return (
    <VStack
      padding={4}
      gap={4}
      {...props}
      className={`dialog-body ${className}`}
    />
  );
}
export { TextInput } from "@astryxdesign/core/TextInput";
export { DateInput, type DateInputProps } from "@astryxdesign/core/DateInput";
export { TextArea } from "@astryxdesign/core/TextArea";
export { Switch } from "@astryxdesign/core/Switch";
export { Text, Heading } from "@astryxdesign/core/Text";
export {
  Layout,
  LayoutContent,
  LayoutPanel,
  StackItem,
} from "@astryxdesign/core/Layout";
export function ErrorNotice({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <HStack className="notice error" gap={3} role="alert" wrap="wrap">
      <p>{error instanceof Error ? error.message : String(error)}</p>
      {retry && <Button label="Try again" onClick={retry} />}
    </HStack>
  );
}
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <VStack padding={6} role="status" className="loading">
      <i className="pulse" />
      <p>{label}</p>
    </VStack>
  );
}
export function Empty({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <VStack className="empty" gap={4} hAlign="center">
      <img src="/app/assets/robin.webp" alt="" />
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </VStack>
  );
}
export function Page({
  title,
  eyebrow,
  description,
  children,
  actions,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <VStack className="page" gap={6} padding={4}>
      <HStack
        className="page-heading"
        hAlign="between"
        vAlign="end"
        gap={4}
        wrap="wrap"
      >
        <VStack gap={2}>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {description && <p className="lede">{description}</p>}
        </VStack>
        {actions}
      </HStack>
      {children}
    </VStack>
  );
}
export function Confirm({
  title,
  description,
  label = "Delete",
  icon,
  action,
  children,
}: {
  title: string;
  description: string;
  label?: string;
  icon?: ComponentProps<typeof Button>["icon"];
  action: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        label={label}
        icon={icon}
        isIconOnly={!!icon}
        tooltip={icon ? label : undefined}
        variant="ghost"
        onClick={() => {
          setError(undefined);
          setOpen(true);
        }}
      />
      <Dialog
        isOpen={open}
        onOpenChange={(v) => !busy && setOpen(v)}
        purpose="form"
      >
        <DialogHeader title={title} onOpenChange={(v) => !busy && setOpen(v)} />
        <DialogBody>
          <p>{description}</p>
          {children}
          {!!error && <ErrorNotice error={error} />}
          <HStack hAlign="end" gap={2}>
            <Button
              label="Cancel"
              isDisabled={busy}
              onClick={() => setOpen(false)}
            />
            <Button
              label={label}
              variant="destructive"
              isLoading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await action();
                  setOpen(false);
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </HStack>
        </DialogBody>
      </Dialog>
    </>
  );
}
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <VStack as="label" gap={2} className="field">
      <b>{label}</b>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </VStack>
  );
}
export const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
export const humanStatus = (value: string) => value.replaceAll("_", " ");
