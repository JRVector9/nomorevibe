import { parseCommitAttributions } from './commit-attribution';
import type { AgentObservation } from './types';

/** Explicit file types are a change classification, never a claim about who wrote code. */
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|kts|swift|c|h|cc|cpp|cs|fs|php|vue|svelte|html|css|scss|sass|sql|sh|bash|zsh|ex|exs|erl|hrl|clj|cljs|dart|lua|r|jl|zig|sol)$/i;
const EXCLUDED_DIRECTORY = /^(?:docs?|examples?|fixtures?|__fixtures__|vendor|templates?|node_modules|testdata|tests?|spec|dist|build|\.github|\.claude|\.codex|\.cursor)$/i;
export function isDevelopmentPath(path: string): boolean {
  return SOURCE_EXTENSION.test(path) && !path.split('/').some(part => EXCLUDED_DIRECTORY.test(part))
    && !/(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path) && !/\.d\.[cm]?ts$/i.test(path);
}
export type CommitChangePayload = {
  message: string;
  authorName?: string;
  committerName?: string;
  files: Array<{ filename: string; changes: number }>;
};
/** Only extract bounded public metadata; never persist email addresses or commit message bodies. */
export function commitChangeObservations(input: CommitChangePayload, context: {
  repositoryKey: string; commitSha: string; headSha: string; scope: string;
}): AgentObservation[] {
  const paths = [...new Set(input.files.filter(file => Number.isSafeInteger(file.changes) && file.changes > 0)
    .map(file => file.filename).filter(path => path.length <= 1000 && !/[\x00-\x1f\\]/.test(path)
      && !path.split('/').some(part => !part || part === '.' || part === '..')
      && (!context.scope || path.startsWith(context.scope + '/'))))];
  if (!paths.length) return [];
  // Prioritize source paths so a bounded excerpt cannot silently hide the qualifying change.
  const changedPaths = [...paths.filter(isDevelopmentPath), ...paths.filter(path => !isDevelopmentPath(path))].slice(0, 20);
  const changeKind = changedPaths.some(isDevelopmentPath) ? 'development' as const : 'other' as const;
  const bases: Array<{client: string; basis: 'coauthor'|'author'|'committer'}> = parseCommitAttributions(input.message)
    .flatMap(a => a.client ? [{client:a.client,basis:'coauthor' as const}] : []);
  if (/ \(aider\)$/i.test(input.authorName ?? '')) bases.push({client:'aider',basis:'author'});
  else if (/ \(aider\)$/i.test(input.committerName ?? '')) bases.push({client:'aider',basis:'committer'});
  // Aider committer-only metadata does not upgrade another authorship claim for the same client.
  const unique = [...new Map(bases.map(item => [item.client + ':' + item.basis, item])).values()];
  return unique.map(({client,basis}) => ({
    kind:'commit_attribution', client, compatibleClients:[], modelDeveloper:null, declaredModelId:null,
    gateway:null, routing:'unknown', role:basis, scope:context.scope, keyPath:null,
    ruleId:`commit.${basis}.v2`, sourcePath:null, commitSha:context.commitSha, blobSha:null,
    sourceUrl:`https://github.com/${context.repositoryKey}/commit/${context.commitSha}`,
    commitEvidence:{basis,changedPaths,changeKind,headSha:context.headSha},
  }));
}
