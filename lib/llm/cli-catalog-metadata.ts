/** Safe persisted catalog fields. Provider credentials and arbitrary provider options never enter the admin view. */
export type CliCatalogModel = Readonly<{ id: string; label: string; variants: readonly string[]; maxModelLen: number | null; vision?: boolean }>;
export type CliCatalogMetadata = Readonly<{ cliVersion: string; observedAt: string; models: readonly CliCatalogModel[] }>;

/** IDs already live in cliModels. Bind the compact variant lists to their exact order, without duplicating names or IDs in options. */
export function cliCatalogMetadataFromSnapshot(value: unknown, models: readonly string[], cliVersion: string | null, modelsHash: string): CliCatalogMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.modelsHash !== modelsHash || !Array.isArray(raw.variantLists) || raw.variantLists.length !== models.length) return null;
  const variants = raw.variantLists;
  const contextLists = raw.contextLists === undefined ? null : raw.contextLists;
  if (contextLists !== null && (!Array.isArray(contextLists) || contextLists.length !== models.length)) return null;
  const visionLists = raw.visionLists === undefined ? null : raw.visionLists;
  if (visionLists !== null && (!Array.isArray(visionLists) || visionLists.length !== models.length)) return null;
  return cliCatalogMetadata({ cliVersion, observedAt: raw.observedAt,
    models: models.map((id, index) => ({ id, label: id, variants: variants[index],
      maxModelLen: contextLists === null ? null : contextLists[index],
      ...(visionLists === null ? {} : { vision: visionLists[index] }) })) });
}

export function cliCatalogMetadata(value: unknown): CliCatalogMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.cliVersion !== "string" || !raw.cliVersion || raw.cliVersion.length > 80 || /[\p{Cc}]/u.test(raw.cliVersion)
    || typeof raw.observedAt !== "string" || !Number.isFinite(Date.parse(raw.observedAt)) || !Array.isArray(raw.models) || !raw.models.length || raw.models.length > 512) return null;
  const models: CliCatalogModel[] = [];
  for (const entry of raw.models) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model.id)
      || typeof model.label !== "string" || model.label.length > 240 || /[\p{Cc}]/u.test(model.label)
      || !Array.isArray(model.variants) || model.variants.length > 32
      || model.variants.some(variant => typeof variant !== "string" || !/^[a-z0-9_-]{1,32}$/.test(variant))) return null;
    models.push(Object.freeze({ id: model.id, label: model.label, variants: Object.freeze([...model.variants] as string[]),
      maxModelLen: typeof model.maxModelLen === "number" && Number.isSafeInteger(model.maxModelLen) && model.maxModelLen > 0 ? model.maxModelLen : null,
      ...(typeof model.vision === "boolean" ? { vision: model.vision } : {}) }));
  }
  if (new Set(models.map(model => model.id)).size !== models.length) return null;
  return Object.freeze({ cliVersion: raw.cliVersion, observedAt: raw.observedAt, models: Object.freeze(models) });
}
