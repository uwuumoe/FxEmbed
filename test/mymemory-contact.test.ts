import { afterEach, expect, it, vi } from 'vitest';
import { translateStatus } from '../src/helpers/translate';
import { Constants } from '../src/constants';

afterEach(() => vi.restoreAllMocks());

it('sends the runtime contact email to MyMemory without baking it into the bundle', async () => {
  vi.spyOn(Constants.POLYGLOT_DOMAIN_LIST, 'filter').mockReturnValue([]);
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ responseStatus: 200, responseData: { translatedText: 'Bonjour' } })
  );
  const result = await translateStatus(
    { text: 'Hello', lang: 'en' } as never,
    'fr',
    { env: { MYMEMORY_CONTACT_EMAIL: 'contact@example.com' } } as never
  );
  const url = new URL(String(fetchMock.mock.calls[0][0]));
  expect(url.searchParams.get('de')).toBe('contact@example.com');
  expect(url.searchParams.get('langpair')).toBe('en|fr');
  expect(result?.translated_text).toBe('Bonjour');
});
