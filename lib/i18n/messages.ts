import type { common } from "@/messages/ko/common";
import type { labels } from "@/messages/ko/labels";
import type { browse } from "@/messages/ko/browse";
import type { detail } from "@/messages/ko/detail";
import type { auth } from "@/messages/ko/auth";
import type { launch } from "@/messages/ko/launch";
import type { policy } from "@/messages/ko/policy";

/** Korean declares semantic keys and interpolation contracts, not translated values. */
export interface MessageSchemas {
  common: typeof common;
  labels: typeof labels;
  browse: typeof browse;
  detail: typeof detail;
  auth: typeof auth;
  launch: typeof launch;
  policy: typeof policy;
}
export type Namespace = keyof MessageSchemas;
export type MessageCatalog<Schema> = { readonly [Key in keyof Schema]: string };
export type Dictionary = { [N in Namespace]: MessageCatalog<MessageSchemas[N]> };
export type ClientDictionaries = Partial<Dictionary>;

type ParametersIn<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | ParametersIn<Rest> : never;
type SameParameters<Source extends string, Target extends string> =
  [ParametersIn<Source>] extends [ParametersIn<Target>]
    ? [ParametersIn<Target>] extends [ParametersIn<Source>] ? true : false
    : false;

/** Check every translation's keys and named arguments at compile time. */
export function defineCatalog<Schema extends Record<string, string>>() {
  return <const Catalog extends MessageCatalog<Schema>>(catalog: Catalog & {
    [Key in keyof Schema]: SameParameters<Schema[Key], Catalog[Key]> extends true ? Catalog[Key] : never;
  } & Record<Exclude<keyof Catalog, keyof Schema>, never>): Catalog => catalog;
}

export type MessageKey<N extends Namespace> = keyof MessageSchemas[N] & string;
type MessageParameters<N extends Namespace, Key extends MessageKey<N>> =
  ParametersIn<MessageSchemas[N][Key] & string>;
export type Translator<N extends Namespace> = <Key extends MessageKey<N>>(
  key: Key,
  ...args: [MessageParameters<N, Key>] extends [never]
    ? [] : [params: Record<MessageParameters<N, Key>, string | number>]
) => string;

/** Small named-value interpolation; plural variants remain explicit catalog keys. */
export function createTranslator<N extends Namespace>(namespace: N, catalog: Dictionary[N]): Translator<N> {
  return ((key: MessageKey<N>, params?: Record<string, string | number>) => {
    const message = catalog[key];
    if (typeof message !== "string") throw new Error(`Missing message: ${namespace}.${key}`);
    return message.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      if (!params || !Object.hasOwn(params, name)) throw new Error(`Missing message argument: ${namespace}.${key}.${name}`);
      return String(params[name]);
    });
  }) as Translator<N>;
}
