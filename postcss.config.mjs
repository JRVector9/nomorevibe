import { resolve } from "node:path";

const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    [resolve(process.cwd(), "scripts/styles/site-density.cjs")]: {},
  },
};

export default config;
