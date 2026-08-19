export type NormalizedImageVariant = {
  data: Buffer;
  width: number;
  height: number;
  size: number;
};

export type NormalizedImageAsset = {
  hash: string;
  mimeType: "image/webp";
  web: NormalizedImageVariant;
  thumbnail: NormalizedImageVariant;
};

export type StoredImage = {
  data: Buffer;
  mimeType: string;
  size: number;
};

export type MediaVariant = "web" | "thumbnail";

export interface MediaStorage {
  put(asset: NormalizedImageAsset): Promise<void>;
  get(hash: string, variant: MediaVariant): Promise<StoredImage | null>;
  deleteIfUnreferenced(hash: string): Promise<boolean>;
}

export interface RelationshipMediaStorage extends MediaStorage {
  /** Writes while the repository already owns this asset hash's advisory lock. */
  putUnderLock(asset: NormalizedImageAsset): Promise<void>;
}
