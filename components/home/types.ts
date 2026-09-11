export type HomePulseView = {
  asOf: string;
  asOfLabel: string;
  timezone: "Asia/Seoul";
  methodVersion: string;
  born: { current: number; previous: number; change: number | null };
  updates: { projects: number; releases: number };
  active: { slug: string; name: string; category: string; releases: number; stars: number | null }[];
  categories: { key: string; total: number; born: number }[];
  tools: { scanned: number; withTool: number; rows: { label: string; count: number }[] } | null;
  total: number;
};

export type HomeCardProduct = {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  builder: string | null;
  builderClaim: "reported" | "guessed";
  ogImage: string | null;
  makerName: string | null;
  repoUrl: string | null;
  unclaimed: boolean;
  health?: { down: boolean };
  metrics?: { clicks: number };
  validClicks?: number;
};
