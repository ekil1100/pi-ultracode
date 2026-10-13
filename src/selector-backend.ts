/** Model used to select child effort, independent of execution models. */
export type SelectorBackend = { type: "classifier" | "chat"; provider: string; id: string };

export const DEFAULT_SELECTOR_BACKEND: SelectorBackend = Object.freeze({
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
});

export function isSelectorBackend(value: unknown): value is SelectorBackend {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const backend = value as Record<string, unknown>;
  return (
    (backend.type === "classifier" || backend.type === "chat") &&
    typeof backend.provider === "string" &&
    // oxlint-disable-next-line no-control-regex -- Reject terminal controls in saved model identifiers.
    /^[^\s/\u0000-\u001f\u007f-\u009f]+$/.test(backend.provider) &&
    typeof backend.id === "string" &&
    // oxlint-disable-next-line no-control-regex -- Reject terminal controls in saved model identifiers.
    /^[^\s\u0000-\u001f\u007f-\u009f]+$/.test(backend.id)
  );
}

export function backendLabel(backend: SelectorBackend): string {
  return `${backend.type} ${backend.provider}/${backend.id}`;
}
