export type HomePulseView = {
  asOf: string;
  asOfLabel: string;
  timezone: "Asia/Seoul";
  methodVersion: string;
  launches: {
    current: number;
    previous: number;
    change: number | null;
    days: { date: string; count: number; weekday: string }[];
  };
  tools: {
    total: number;
    reported: number;
    coverage: number | null;
    rows: { name: string; count: number; percent: number | null }[];
  };
  interestReady: boolean;
  categories: {
    key: string;
    current: number;
    previous: number;
    change: number | null;
    qualified: boolean;
  }[];
  updates: { projects: number; releases: number };
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
