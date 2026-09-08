const KEY = "nmb-saved-v1";

export function savedSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function parseSaved(raw: string): Set<string> {
  try {
    const value = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function subscribeSaved(onStoreChange: () => void): () => void {
  window.addEventListener("nmb:saved-changed", onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener("nmb:saved-changed", onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export function persistSaved(saved: Set<string>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify([...saved]));
    window.dispatchEvent(new Event("nmb:saved-changed"));
    return true;
  } catch {
    return false;
  }
}
