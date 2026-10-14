import { describe, expect, it } from 'vitest';
import { englishLang, hasEnglishEvidence } from '@/lib/i18n/content-language';
import { checkProductTranslation } from '@/lib/domain/products/translation-policy';

describe('short English product descriptions', () => {
  it('recognizes a clear English action and its object without a function word', () => {
    for (const text of ['Manage meetings', 'Schedule tasks.', 'Organize notes', 'Track projects']) {
      expect(hasEnglishEvidence(text)).toBe(true);
      expect(englishLang(text)).toBe('en');
    }
  });

  it('does not infer English from shared nouns or a foreign sentence', () => {
    for (const text of ['Code source', 'Project notes', 'Manage reuniones', 'Gestion de projets', 'Manage meetings ahora', 'Manage 회의']) {
      expect(hasEnglishEvidence(text)).toBe(false);
    }
  });

  it('accepts the same short English evidence in translation validation', () => {
    expect(checkProductTranslation('Manage meetings', { id: 1, name: 'Acme', tagline: '회의를 관리합니다' }, 'en', 'tagline'))
      .toEqual({ ok: true, text: 'Manage meetings' });
  });

  it('still requires names and unchanged quantities in a short translation', () => {
    expect(checkProductTranslation('Manage meetings', { id: 1, name: 'Acme', tagline: 'Acme로 회의를 관리합니다' }, 'en', 'tagline'))
      .toEqual({ ok: false, reason: 'name_lost' });
    expect(checkProductTranslation('Manage 5 meetings', { id: 1, name: 'Acme', tagline: '회의 3개를 관리합니다' }, 'en', 'tagline'))
      .toEqual({ ok: false, reason: 'number_changed' });
  });
});
