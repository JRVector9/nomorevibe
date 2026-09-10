import { expect, it } from 'vitest';
import { judge, factsFromRepoMeta } from '@/lib/crawl/rules';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';

const repo = (over = {}) => factsFromRepoMeta('acme/app', {
  stargazers_count: 5, pushed_at: new Date().toISOString(), owner: { type: 'User' }, description: '배포한 서비스', ...over,
});

/**
 * 발행되면 규칙이 다시 닿지 않는다. 재검수는 보관한 원본에 지금 기준을 태우는 것이므로,
 * 기준이 잡아야 할 것을 실제로 잡는지가 전부다.
 */
it('차단 목록에 빠져 있던 등록처를 이제 거른다', () => {
  for (const url of [
    'https://rubygems.org/gems/stir_fry',
    'https://packagist.org/packages/acme/app',
    'https://hub.docker.com/r/acme/app',
    'https://marketplace.visualstudio.com/items?itemName=acme.app',
    'https://pub.dev/packages/acme',
  ]) {
    const v = judge(repo(), { productUrl: url, status: 200 }, DEFAULT_CRAWL_SETTINGS);
    expect(v, url).toMatchObject({ state: 'rejected', reason: 'not_a_product' });
  }
});

it('등록처가 아닌 배포물은 그대로 통과한다', () => {
  for (const url of ['https://diffusion.studio', 'https://lantunnel.app', 'https://getkado.app']) {
    expect(judge(repo(), { productUrl: url, status: 200 }, DEFAULT_CRAWL_SETTINGS).state, url).toBe('approved');
  }
});

it('보류는 재검수 대상이 아니다 — 규칙이 못 가른 것으로 올라간 제품을 내릴 수는 없다', () => {
  const v = judge(repo(), { productUrl: 'https://acme.github.io/app', status: 200 }, DEFAULT_CRAWL_SETTINGS);
  expect(v.state).toBe('needs_review');
});
