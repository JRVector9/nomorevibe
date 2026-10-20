import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { LOCALES } from '../lib/i18n/locales.ts';

/** An added public page must declare its message namespaces here, in the shared locale tree. */
export const PUBLIC_PAGE_NAMESPACES = {
  '/': ['browse', 'labels'],
  '/c/[category]': ['browse', 'labels', 'me'],
  '/rising': ['browse', 'labels'],
  '/talk': ['browse', 'labels'],
  '/popular': ['browse', 'labels'],
  '/rankings/[key]': ['browse', 'labels'],
  '/p/[slug]': ['detail', 'labels', 'me'],
  '/p/[slug]/github': ['detail'],
  '/feedback/[id]': ['auth', 'detail'],
  '/login': ['auth'],
  '/launch': ['launch'],
  '/policy': ['policy'],
  '/me': ['me', 'labels'],
  '/me/projects': ['me', 'labels'],
  '/me/tried': ['me', 'labels'],
  '/me/opinions': ['me', 'labels', 'detail'],
  '/me/following': ['me', 'labels'],
  '/me/alerts': ['me', 'labels'],
  '/me/account': ['me', 'labels'],
};

const sameSet = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const parameters = (message) => [...new Set([...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))];
async function publicPages(root, directory = path.join(root, 'app'), relative = []) {
  const routes = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('@')) continue; // parallel slot pages share the containing URL
    const parts = [...relative, entry.name];
    if (entry.isDirectory()) routes.push(...await publicPages(root, path.join(directory, entry.name), parts));
    else if (/^page\.(?:[jt]sx?)$/.test(entry.name)) {
      const logical = relative.filter((segment) => segment !== '[locale]' && !/^\(.*\)$/.test(segment));
      if (logical[0] === 'admin') continue;
      if (!relative.includes('(public)') || !relative.includes('[locale]')) {
        throw new Error(`Public page outside shared locale tree: ${parts.join('/')}`);
      }
      routes.push(`/${logical.join('/')}`);
    }
  }
  return routes;
}

export async function checkPublicI18n(root = process.cwd()) {
  const schemas = ts.createSourceFile('messages.ts', await readFile(path.join(root, 'lib/i18n/messages.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = schemas.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === 'MessageSchemas');
  if (!declaration) throw new Error('MessageSchemas namespace registry is missing');
  const namespaces = declaration.members.map((member) => member.name?.getText(schemas).replace(/['"]/g, ''));
  // This six-string catastrophe UI runs when the root cannot provide a dictionary.
  // It is the only standalone support catalog; arbitrary extra files still fail.
  const catalogsToCheck = namespaces.map((namespace) => ({
    file: namespace === 'globalError' ? 'global-error.ts' : `${namespace}.ts`, exportName: namespace,
  }));
  if (!namespaces.includes('globalError')) catalogsToCheck.push({ file: 'global-error.ts', exportName: 'globalError' });
  const expectedFiles = catalogsToCheck.map(({ file }) => file);
  const catalogs = new Map();
  for (const locale of LOCALES) {
    const directory = path.join(root, 'messages', locale);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.ts'));
    if (!sameSet(files, expectedFiles)) throw new Error(`${locale}: catalog files differ from registered namespaces`);
    for (const { file, exportName: namespace } of catalogsToCheck) {
      const catalogModule = await import(pathToFileURL(path.join(directory, file)).href);
      const catalog = catalogModule[namespace];
      if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error(`${locale}.${namespace}: expected message object`);
      for (const [key, message] of Object.entries(catalog)) {
        if (typeof message !== 'string' || !message.trim()) throw new Error(`${locale}.${namespace}.${key}: empty or non-string message`);
      }
      catalogs.set(`${locale}.${namespace}`, catalog);
    }
  }
  for (const { exportName: namespace } of catalogsToCheck) {
    const source = catalogs.get(`ko.${namespace}`);
    if (!Object.keys(source).length) throw new Error(`${namespace}: release namespace is empty`);
    for (const locale of LOCALES) {
      const catalog = catalogs.get(`${locale}.${namespace}`);
      if (!sameSet(Object.keys(source), Object.keys(catalog))) throw new Error(`${locale}.${namespace}: message keys differ`);
      for (const key of Object.keys(source)) {
        if (!sameSet(parameters(source[key]), parameters(catalog[key]))) throw new Error(`${locale}.${namespace}.${key}: placeholder names differ`);
      }
    }
  }
  const routes = await publicPages(root);
  if (routes.length !== new Set(routes).size || !sameSet(routes, Object.keys(PUBLIC_PAGE_NAMESPACES))) {
    throw new Error(`Public route inventory changed; declare namespaces: ${routes.filter((route) => !Object.hasOwn(PUBLIC_PAGE_NAMESPACES, route)).join(', ') || 'removed/duplicate route'}`);
  }
  for (const [route, required] of Object.entries(PUBLIC_PAGE_NAMESPACES)) {
    for (const namespace of required) if (!namespaces.includes(namespace)) throw new Error(`${route}: unregistered namespace ${namespace}`);
  }
  return { locales: LOCALES.length, namespaces: namespaces.length, publicPages: routes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log('Public i18n contract:', await checkPublicI18n()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
